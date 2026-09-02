"""Loopback HTTP transport for the SharedNet Room service."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
import hmac
import os
from pathlib import Path
from typing import BinaryIO
from urllib.parse import quote

from fastapi import Depends, FastAPI, Request, status
from fastapi.exception_handlers import http_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.exceptions import HTTPException

from ..control.models import ActorIdentity, ControlError
from ..control.projections import DashboardProjectionService
from ..control.service import ControlService
from ..control.store import ControlStore
from .blobs import LocalBlobStore
from .errors import RoomError
from .models import RuntimeIdentity
from .service import RoomService
from .store import RoomStore


_DOWNLOAD_CHUNK_BYTES = 64 * 1024
_INVALID_REQUEST_BODY = {
    "error": {"code": "invalid_request", "message": "request validation failed"}
}
class _RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _RegisterRuntimeRequest(_RequestModel):
    principal_id: str
    agent_id: str
    requested_runtime_id: str | None = None


class _CreateRoomRequest(_RequestModel):
    name: str
    description: str | None = None
    access_policy: str = "anyone_with_id"


class _PostMessageRequest(_RequestModel):
    content: str
    reply_to: str | None = None
    tags: object = ()
    attachment_ids: object = ()


class _ResolveMessageRequest(_RequestModel):
    outcome: str
    evidence: str | None = None


class _CreatePairingRequest(_RequestModel):
    web_base_url: str | None = None
    ttl_seconds: int = 600


class _ExchangePairingRequest(_RequestModel):
    pairing_secret: str


class _CreateAgentRequest(_RequestModel):
    diagnostic_label: str
    capabilities: list[str] = Field(default_factory=list)


class _RegisterLocalRuntimeRequest(_RequestModel):
    agent_id: str
    runtime_kind: str
    workspace_label: str | None = None


class _StartInstanceRequest(_RequestModel):
    provider_session_id: str | None = None
    lease_seconds: int = 90


class _HeartbeatInstanceRequest(_RequestModel):
    lease_seconds: int = 90


class _RequestDecisionRequest(_RequestModel):
    mode: str
    title: str
    description: str
    consequence: str | None = None
    room_id: str | None = None


class _ResolveDecisionRequest(_RequestModel):
    outcome: str
    response_text: str | None = None


@dataclass(frozen=True)
class _InstanceAuth:
    identity: RuntimeIdentity | ActorIdentity
    raw_token: str
    scheme: str


def _error_response(error: RoomError | ControlError) -> JSONResponse:
    headers = {"WWW-Authenticate": "Bearer"} if error.status_code == 401 else None
    return JSONResponse(
        status_code=error.status_code,
        content={"error": {"code": error.code, "message": error.message}},
        headers=headers,
    )


def _authorization_parts(request: Request) -> tuple[str, str]:
    authorization = request.headers.get("authorization")
    if authorization is None:
        raise ControlError("invalid_instance_token", "Instance credential is required", 401)
    parts = authorization.split(" ")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        raise ControlError("invalid_instance_token", "Instance credential is invalid", 401)
    return parts[0], parts[1]


def _require_connector(request: Request) -> str:
    scheme, token = _authorization_parts(request)
    if scheme != "Connector":
        raise ControlError("invalid_connector_token", "Connector credential is required", 401)
    request.app.state.control_store.authenticate_connector(token)
    return token


def _require_runtime(request: Request) -> str:
    scheme, token = _authorization_parts(request)
    if scheme != "Runtime":
        raise ControlError("invalid_runtime_token", "Runtime credential is required", 401)
    request.app.state.control_store.authenticate_runtime(token)
    return token


def _require_instance(request: Request) -> _InstanceAuth:
    authenticated = getattr(request.state, "instance_auth", None)
    if isinstance(authenticated, _InstanceAuth):
        return authenticated
    scheme, token = _authorization_parts(request)
    if scheme == "Instance":
        identity = request.app.state.control_store.authenticate_instance(token)
    elif scheme == "Bearer":
        identity = request.app.state.control_store.authenticate_legacy_instance(token)
    else:
        raise ControlError("invalid_instance_token", "Instance credential is required", 401)
    return _InstanceAuth(identity, token, scheme)


def _require_console(request: Request) -> None:
    expected = request.app.state.console_token
    supplied = request.headers.get("x-sharednet-console-token")
    if (
        not isinstance(expected, str)
        or not expected
        or not isinstance(supplied, str)
        or not hmac.compare_digest(expected, supplied)
    ):
        raise ControlError("invalid_console_token", "Console credential is invalid", 401)


def _read_chunks(stream: BinaryIO) -> Iterator[bytes]:
    while chunk := stream.read(_DOWNLOAD_CHUNK_BYTES):
        yield chunk


class _ClosingStreamingResponse(StreamingResponse):
    """A streaming response that owns and always closes its binary input."""

    def __init__(self, stream: BinaryIO, **kwargs: object) -> None:
        self._stream = stream
        super().__init__(_read_chunks(stream), **kwargs)

    async def __call__(self, scope, receive, send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            self._stream.close()


def create_room_app(
    database_path: Path,
    blob_path: Path,
    max_upload_bytes: int = 268_435_456,
    *,
    console_token: str | None = None,
    web_base_url: str | None = None,
    enable_legacy_registration: bool | None = None,
) -> FastAPI:
    """Create an isolated Room API application backed by local persistence."""

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        store = RoomStore(database_path)
        store.initialize()
        control_store = ControlStore(database_path)
        control_store.initialize()
        blob_store = LocalBlobStore(blob_path, max_upload_bytes)
        app.state.store = store
        app.state.blob_store = blob_store
        app.state.service = RoomService(store, blob_store)
        app.state.control_store = control_store
        app.state.control_service = ControlService(control_store)
        app.state.projections = DashboardProjectionService(database_path, control_store)
        yield

    configured_console_token = (
        console_token if console_token is not None else os.environ.get("SHAREDNET_CONSOLE_TOKEN")
    )
    configured_web_base_url = (
        web_base_url
        if web_base_url is not None
        else os.environ.get("SHAREDNET_WEB_URL", "http://127.0.0.1:3001")
    )
    legacy_enabled = (
        enable_legacy_registration
        if enable_legacy_registration is not None
        else os.environ.get("SHAREDNET_ENABLE_LEGACY_REGISTRATION", "").lower()
        in {"1", "true", "yes"}
    )

    app = FastAPI(
        lifespan=lifespan,
        openapi_url=None,
        docs_url=None,
        redoc_url=None,
    )
    app.state.console_token = configured_console_token
    app.state.web_base_url = configured_web_base_url

    @app.middleware("http")
    async def authenticate_instance_routes_before_body_parsing(request: Request, call_next):
        path = request.url.path
        requires_instance = (
            path == "/v1/rooms"
            or path.startswith("/v1/rooms/")
            or path == "/v1/decisions"
            or path.startswith("/v1/decisions/")
            or path.startswith("/v1/local/instances/current/")
        )
        if requires_instance:
            try:
                request.state.instance_auth = _require_instance(request)
            except (RoomError, ControlError) as error:
                return _error_response(error)
        return await call_next(request)

    @app.exception_handler(RoomError)
    def room_error_handler(request: Request, error: RoomError) -> JSONResponse:
        return _error_response(error)

    @app.exception_handler(ControlError)
    def control_error_handler(request: Request, error: ControlError) -> JSONResponse:
        return _error_response(error)

    @app.exception_handler(RequestValidationError)
    def validation_error_handler(
        request: Request,
        error: RequestValidationError,
    ) -> JSONResponse:
        return JSONResponse(status_code=400, content=_INVALID_REQUEST_BODY)

    @app.exception_handler(HTTPException)
    async def framework_http_error_handler(
        request: Request,
        error: HTTPException,
    ):
        if error.status_code == 400:
            return JSONResponse(status_code=400, content=_INVALID_REQUEST_BODY)
        return await http_exception_handler(request, error)

    @app.get("/healthz")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/v1/pairings", status_code=status.HTTP_201_CREATED)
    def create_pairing(
        payload: _CreatePairingRequest,
        request: Request,
    ) -> dict[str, object]:
        return request.app.state.control_service.create_pairing(
            payload.web_base_url or request.app.state.web_base_url,
            ttl_seconds=payload.ttl_seconds,
        ).to_dict()

    @app.post("/v1/pairings/{pairing_id}/exchange")
    def exchange_pairing(
        pairing_id: str,
        payload: _ExchangePairingRequest,
        request: Request,
    ) -> dict[str, object]:
        return request.app.state.control_service.exchange_pairing(
            pairing_id,
            payload.pairing_secret,
        ).to_dict()

    @app.post("/v1/local/agents", status_code=status.HTTP_201_CREATED)
    def create_local_agent(
        payload: _CreateAgentRequest,
        request: Request,
        connector_token: str = Depends(_require_connector),
    ) -> dict[str, object]:
        return request.app.state.control_service.create_agent(
            connector_token,
            payload.diagnostic_label,
            payload.capabilities,
        ).to_dict()

    @app.post("/v1/local/runtimes", status_code=status.HTTP_201_CREATED)
    def register_local_runtime(
        payload: _RegisterLocalRuntimeRequest,
        request: Request,
        connector_token: str = Depends(_require_connector),
    ) -> dict[str, object]:
        return request.app.state.control_service.register_runtime(
            connector_token,
            payload.agent_id,
            payload.runtime_kind,
            payload.workspace_label,
        ).to_dict()

    @app.post("/v1/local/instances", status_code=status.HTTP_201_CREATED)
    def start_local_instance(
        payload: _StartInstanceRequest,
        request: Request,
        runtime_token: str = Depends(_require_runtime),
    ) -> dict[str, object]:
        return request.app.state.control_service.start_instance(
            runtime_token,
            payload.provider_session_id,
            lease_seconds=payload.lease_seconds,
        ).to_dict()

    @app.post("/v1/local/instances/current/heartbeat")
    def heartbeat_local_instance(
        payload: _HeartbeatInstanceRequest,
        request: Request,
        instance: _InstanceAuth = Depends(_require_instance),
    ) -> dict[str, object]:
        if instance.scheme == "Bearer":
            return {"identity": instance.identity.to_dict(), "presence": "online"}
        return request.app.state.control_service.heartbeat_instance(
            instance.raw_token,
            lease_seconds=payload.lease_seconds,
        ).to_dict()

    @app.post("/v1/local/instances/current/end")
    def end_local_instance(
        request: Request,
        instance: _InstanceAuth = Depends(_require_instance),
    ) -> dict[str, object]:
        if instance.scheme == "Bearer":
            raise ControlError(
                "legacy_instance_end_not_supported",
                "legacy compatibility Instances cannot be ended through this endpoint",
                409,
            )
        ended = request.app.state.control_store.end_instance(instance.raw_token)
        return ended.to_dict()

    @app.post("/v1/decisions", status_code=status.HTTP_201_CREATED)
    def request_decision(
        payload: _RequestDecisionRequest,
        request: Request,
        instance: _InstanceAuth = Depends(_require_instance),
    ) -> dict[str, object]:
        if not isinstance(instance.identity, ActorIdentity):
            raise ControlError(
                "legacy_decision_not_supported",
                "legacy compatibility Instances cannot request Decisions",
                409,
            )
        return request.app.state.control_service.request_decision(
            instance.identity,
            payload.mode,
            payload.title,
            payload.description,
            payload.consequence,
            payload.room_id,
        ).to_dict()

    @app.get("/v1/decisions/{decision_id}")
    def get_decision(
        decision_id: str,
        request: Request,
        instance: _InstanceAuth = Depends(_require_instance),
    ) -> dict[str, object]:
        if not isinstance(instance.identity, ActorIdentity):
            raise ControlError("decision_not_found", "Decision was not found", 404)
        return request.app.state.control_service.get_decision_for_instance(
            instance.identity,
            decision_id,
        ).to_dict()

    @app.post("/v1/console/accounts/{auth_user_id}/provision")
    def provision_account(
        auth_user_id: str,
        request: Request,
        _: None = Depends(_require_console),
    ) -> dict[str, str]:
        return {
            "principal_id": request.app.state.control_store.provision_principal(
                auth_user_id
            )
        }

    @app.post("/v1/console/accounts/{auth_user_id}/demo-seed")
    def seed_demo_account(
        auth_user_id: str,
        request: Request,
        _: None = Depends(_require_console),
    ) -> dict[str, object]:
        return request.app.state.control_store.seed_demo_account(auth_user_id)

    @app.post("/v1/console/accounts/{auth_user_id}/pairings/{pairing_id}/claim")
    def claim_pairing(
        auth_user_id: str,
        pairing_id: str,
        request: Request,
        _: None = Depends(_require_console),
    ) -> dict[str, object]:
        return request.app.state.control_service.claim_pairing(
            pairing_id,
            auth_user_id,
        ).to_dict()

    @app.get("/v1/console/accounts/{auth_user_id}/rooms")
    def console_rooms(
        auth_user_id: str,
        request: Request,
        _: None = Depends(_require_console),
    ) -> dict[str, object]:
        return request.app.state.projections.list_rooms(auth_user_id)

    @app.get("/v1/console/accounts/{auth_user_id}/rooms/{room_id}")
    def console_room(
        auth_user_id: str,
        room_id: str,
        request: Request,
        _: None = Depends(_require_console),
    ) -> dict[str, object]:
        return request.app.state.projections.get_room(auth_user_id, room_id)

    @app.get("/v1/console/accounts/{auth_user_id}/network")
    def console_network(
        auth_user_id: str,
        request: Request,
        _: None = Depends(_require_console),
    ) -> dict[str, object]:
        return request.app.state.projections.get_network(auth_user_id)

    @app.get("/v1/console/accounts/{auth_user_id}/decisions")
    def console_decisions(
        auth_user_id: str,
        request: Request,
        decision_status: str | None = None,
        _: None = Depends(_require_console),
    ) -> dict[str, object]:
        return request.app.state.projections.list_decisions(
            auth_user_id,
            decision_status,
        )

    @app.post("/v1/console/accounts/{auth_user_id}/decisions/{decision_id}/resolve")
    def resolve_console_decision(
        auth_user_id: str,
        decision_id: str,
        payload: _ResolveDecisionRequest,
        request: Request,
        _: None = Depends(_require_console),
    ) -> dict[str, object]:
        return request.app.state.control_service.resolve_decision_for_account(
            auth_user_id,
            decision_id,
            payload.outcome,
            payload.response_text,
        ).to_dict()

    if legacy_enabled:

        @app.post("/v1/runtimes/register", status_code=status.HTTP_201_CREATED)
        def register_runtime(
            payload: _RegisterRuntimeRequest,
            request: Request,
        ) -> dict[str, object]:
            registration, runtime_token = request.app.state.store.register_runtime(
                payload.principal_id,
                payload.agent_id,
                payload.requested_runtime_id,
            )
            return {
                "registration": registration.to_dict(),
                "runtime_token": runtime_token,
            }

    @app.post("/v1/rooms", status_code=status.HTTP_201_CREATED)
    def create_room(
        payload: _CreateRoomRequest,
        request: Request,
        instance: _InstanceAuth = Depends(_require_instance),
    ) -> dict[str, object]:
        return request.app.state.store.create_room(
            instance.identity,
            payload.name,
            payload.description,
            payload.access_policy,
        ).to_dict()

    @app.post("/v1/rooms/{room_id}/memberships")
    def join_room(
        room_id: str,
        request: Request,
        instance: _InstanceAuth = Depends(_require_instance),
    ) -> dict[str, object]:
        return request.app.state.store.join_room(instance.identity, room_id).to_dict()

    @app.get("/v1/rooms")
    def list_rooms(
        request: Request,
        instance: _InstanceAuth = Depends(_require_instance),
    ) -> dict[str, object]:
        rooms = request.app.state.store.list_rooms(instance.identity)
        return {"rooms": [room.to_dict() for room in rooms]}

    @app.get("/v1/rooms/{room_id}")
    def get_room(
        room_id: str,
        request: Request,
        instance: _InstanceAuth = Depends(_require_instance),
    ) -> dict[str, object]:
        room, memberships = request.app.state.store.get_room(instance.identity, room_id)
        return {
            "room": room.to_dict(),
            "memberships": [membership.to_dict() for membership in memberships],
        }

    @app.delete("/v1/rooms/{room_id}/membership")
    def leave_room(
        room_id: str,
        request: Request,
        instance: _InstanceAuth = Depends(_require_instance),
    ) -> dict[str, object]:
        return request.app.state.store.leave_room(instance.identity, room_id).to_dict()

    @app.post("/v1/rooms/{room_id}/close")
    def close_room(
        room_id: str,
        request: Request,
        instance: _InstanceAuth = Depends(_require_instance),
    ) -> dict[str, object]:
        return request.app.state.store.close_room(instance.identity, room_id).to_dict()

    @app.post(
        "/v1/rooms/{room_id}/messages",
        status_code=status.HTTP_201_CREATED,
    )
    def post_message(
        room_id: str,
        payload: _PostMessageRequest,
        request: Request,
        instance: _InstanceAuth = Depends(_require_instance),
    ) -> dict[str, object]:
        return request.app.state.service.post_message(
            instance.identity,
            room_id,
            payload.content,
            payload.reply_to,
            payload.tags,
            payload.attachment_ids,
        ).to_dict()

    @app.get("/v1/rooms/{room_id}/messages")
    def retrieve_messages(
        room_id: str,
        request: Request,
        after_cursor: str | None = None,
        limit: int = 50,
        instance: _InstanceAuth = Depends(_require_instance),
    ) -> dict[str, object]:
        return request.app.state.service.retrieve_messages(
            instance.identity,
            room_id,
            after_cursor,
            limit,
        ).to_dict()

    @app.post("/v1/rooms/{room_id}/messages/{message_id}/resolve")
    def resolve_message(
        room_id: str,
        message_id: str,
        payload: _ResolveMessageRequest,
        request: Request,
        instance: _InstanceAuth = Depends(_require_instance),
    ) -> dict[str, object]:
        return request.app.state.service.resolve_message(
            instance.identity,
            room_id,
            message_id,
            payload.outcome,
            payload.evidence,
        ).to_dict()

    @app.post(
        "/v1/rooms/{room_id}/artifacts",
        status_code=status.HTTP_201_CREATED,
    )
    async def upload_artifact(
        room_id: str,
        filename: str,
        request: Request,
        instance: _InstanceAuth = Depends(_require_instance),
    ) -> dict[str, object]:
        content_type = request.headers.get("content-type")
        media_type = (
            "application/octet-stream"
            if content_type is None
            else content_type.split(";", 1)[0].strip()
        )
        artifact = await request.app.state.service.upload_artifact(
            instance.identity,
            room_id,
            filename,
            media_type,
            request.stream(),
        )
        return artifact.to_dict()

    @app.get("/v1/rooms/{room_id}/artifacts/{artifact_id}")
    def download_artifact(
        room_id: str,
        artifact_id: str,
        request: Request,
        instance: _InstanceAuth = Depends(_require_instance),
    ) -> StreamingResponse:
        artifact, stream = request.app.state.service.open_artifact(
            instance.identity,
            room_id,
            artifact_id,
        )
        encoded_filename = quote(artifact.filename, safe="")
        return _ClosingStreamingResponse(
            stream,
            headers={
                "Content-Type": artifact.media_type,
                "Content-Length": str(artifact.size_bytes),
                "X-Content-SHA256": artifact.sha256,
                "Content-Disposition": (
                    f"attachment; filename*=utf-8''{encoded_filename}"
                ),
            },
        )

    return app
