"""Loopback HTTP transport for the SharedNet Room service."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import BinaryIO
from urllib.parse import quote

from fastapi import Depends, FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict

from .blobs import LocalBlobStore
from .errors import RoomError
from .models import RuntimeIdentity
from .service import RoomService
from .store import RoomStore


_DOWNLOAD_CHUNK_BYTES = 64 * 1024
_INVALID_REQUEST_BODY = {
    "error": {"code": "invalid_request", "message": "request validation failed"}
}
_INVALID_TOKEN = RoomError(
    "invalid_runtime_token",
    "runtime token is invalid",
    status.HTTP_401_UNAUTHORIZED,
)


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


def _error_response(error: RoomError) -> JSONResponse:
    headers = {"WWW-Authenticate": "Bearer"} if error.status_code == 401 else None
    return JSONResponse(
        status_code=error.status_code,
        content={"error": {"code": error.code, "message": error.message}},
        headers=headers,
    )


def _authenticate(request: Request) -> RuntimeIdentity:
    authorization = request.headers.get("authorization")
    if authorization is None:
        raise _INVALID_TOKEN
    parts = authorization.split(" ")
    if len(parts) != 2 or parts[0] != "Bearer" or not parts[1]:
        raise _INVALID_TOKEN
    return request.app.state.store.authenticate_runtime(parts[1])


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
) -> FastAPI:
    """Create an isolated Room API application backed by local persistence."""

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        store = RoomStore(database_path)
        store.initialize()
        blob_store = LocalBlobStore(blob_path, max_upload_bytes)
        app.state.store = store
        app.state.blob_store = blob_store
        app.state.service = RoomService(store, blob_store)
        yield

    app = FastAPI(lifespan=lifespan)

    @app.exception_handler(RoomError)
    def room_error_handler(request: Request, error: RoomError) -> JSONResponse:
        return _error_response(error)

    @app.exception_handler(RequestValidationError)
    def validation_error_handler(
        request: Request,
        error: RequestValidationError,
    ) -> JSONResponse:
        return JSONResponse(status_code=400, content=_INVALID_REQUEST_BODY)

    @app.get("/healthz")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/v1/runtimes/register", status_code=status.HTTP_201_CREATED)
    def register_runtime(payload: _RegisterRuntimeRequest, request: Request) -> dict[str, object]:
        registration, runtime_token = request.app.state.store.register_runtime(
            payload.principal_id,
            payload.agent_id,
            payload.requested_runtime_id,
        )
        return {"registration": registration.to_dict(), "runtime_token": runtime_token}

    @app.post("/v1/rooms", status_code=status.HTTP_201_CREATED)
    def create_room(
        payload: _CreateRoomRequest,
        request: Request,
        identity: RuntimeIdentity = Depends(_authenticate),
    ) -> dict[str, object]:
        return request.app.state.store.create_room(
            identity,
            payload.name,
            payload.description,
            payload.access_policy,
        ).to_dict()

    @app.post("/v1/rooms/{room_id}/memberships")
    def join_room(
        room_id: str,
        request: Request,
        identity: RuntimeIdentity = Depends(_authenticate),
    ) -> dict[str, object]:
        return request.app.state.store.join_room(identity, room_id).to_dict()

    @app.get("/v1/rooms")
    def list_rooms(
        request: Request,
        identity: RuntimeIdentity = Depends(_authenticate),
    ) -> dict[str, object]:
        rooms = request.app.state.store.list_rooms(identity)
        return {"rooms": [room.to_dict() for room in rooms]}

    @app.get("/v1/rooms/{room_id}")
    def get_room(
        room_id: str,
        request: Request,
        identity: RuntimeIdentity = Depends(_authenticate),
    ) -> dict[str, object]:
        room, memberships = request.app.state.store.get_room(identity, room_id)
        return {
            "room": room.to_dict(),
            "memberships": [membership.to_dict() for membership in memberships],
        }

    @app.delete("/v1/rooms/{room_id}/membership")
    def leave_room(
        room_id: str,
        request: Request,
        identity: RuntimeIdentity = Depends(_authenticate),
    ) -> dict[str, object]:
        return request.app.state.store.leave_room(identity, room_id).to_dict()

    @app.post("/v1/rooms/{room_id}/close")
    def close_room(
        room_id: str,
        request: Request,
        identity: RuntimeIdentity = Depends(_authenticate),
    ) -> dict[str, object]:
        return request.app.state.store.close_room(identity, room_id).to_dict()

    @app.post(
        "/v1/rooms/{room_id}/messages",
        status_code=status.HTTP_201_CREATED,
    )
    def post_message(
        room_id: str,
        payload: _PostMessageRequest,
        request: Request,
        identity: RuntimeIdentity = Depends(_authenticate),
    ) -> dict[str, object]:
        return request.app.state.service.post_message(
            identity,
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
        identity: RuntimeIdentity = Depends(_authenticate),
    ) -> dict[str, object]:
        return request.app.state.service.retrieve_messages(
            identity,
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
        identity: RuntimeIdentity = Depends(_authenticate),
    ) -> dict[str, object]:
        return request.app.state.service.resolve_message(
            identity,
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
        identity: RuntimeIdentity = Depends(_authenticate),
    ) -> dict[str, object]:
        content_type = request.headers.get("content-type")
        media_type = (
            "application/octet-stream"
            if content_type is None
            else content_type.split(";", 1)[0].strip()
        )
        artifact = await request.app.state.service.upload_artifact(
            identity,
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
        identity: RuntimeIdentity = Depends(_authenticate),
    ) -> StreamingResponse:
        artifact, stream = request.app.state.service.open_artifact(
            identity,
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
