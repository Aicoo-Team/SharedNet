"""Local JSON command line for SharedNet coordination and Rooms."""

from __future__ import annotations

import argparse
from dataclasses import replace
import ipaddress
import json
import os
from pathlib import Path
import sys
from typing import Sequence


DEFAULT_MODEL = "gpt-5.6-luna"
DEFAULT_ROOM_URL = "http://127.0.0.1:8765"


class _ArgumentParser(argparse.ArgumentParser):
    """Convert parser diagnostics into the CLI's structured caller errors."""

    def error(self, message: str) -> None:
        raise ValueError(message)


def _positive_float(value: str) -> float:
    parsed = float(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return parsed


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return parsed


def _add_connection_arguments(command: argparse.ArgumentParser) -> None:
    command.add_argument("--url")
    command.add_argument("--session")
    command.add_argument("--timeout", type=_positive_float, default=30.0)


def _parser() -> argparse.ArgumentParser:
    parser = _ArgumentParser(prog="sharednet")
    namespaces = parser.add_subparsers(dest="namespace", required=True)

    coord = namespaces.add_parser("coord")
    coord_commands = coord.add_subparsers(dest="command", required=True)
    coord_commands.add_parser("list")
    for command_name in ("plan", "run"):
        command = coord_commands.add_parser(command_name)
        command.add_argument("--mechanism", required=True)
        command.add_argument("--request", required=True)
        if command_name == "run":
            command.add_argument("--model", default=DEFAULT_MODEL)

    room = namespaces.add_parser("room")
    room_commands = room.add_subparsers(dest="command", required=True)

    serve = room_commands.add_parser("serve")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8765)
    serve.add_argument("--database", default=".sharednet/sharednet.db")
    serve.add_argument("--blobs", default=".sharednet/blobs")
    serve.add_argument("--max-upload-bytes", type=_positive_int, default=268_435_456)
    serve.add_argument("--allow-remote-without-tls", action="store_true")

    register = room_commands.add_parser("register")
    register.add_argument("--principal-id", required=True)
    register.add_argument("--agent-id", required=True)
    register.add_argument("--runtime-id")
    _add_connection_arguments(register)

    build = room_commands.add_parser("build")
    build.add_argument("--name", required=True)
    build.add_argument("--description")
    build.add_argument(
        "--access-policy",
        choices=("anyone_with_id", "principal_only"),
        default="anyone_with_id",
    )
    _add_connection_arguments(build)

    join = room_commands.add_parser("join")
    join.add_argument("room_id")
    _add_connection_arguments(join)

    list_command = room_commands.add_parser("list")
    _add_connection_arguments(list_command)

    get = room_commands.add_parser("get")
    get.add_argument("room_id")
    _add_connection_arguments(get)

    post = room_commands.add_parser("post")
    post.add_argument("room_id")
    post.add_argument("--content", required=True)
    post.add_argument("--reply-to")
    post.add_argument("--tag", action="append", default=[])
    post.add_argument("--attachment", action="append", default=[])
    _add_connection_arguments(post)

    retrieve = room_commands.add_parser("retrieve")
    retrieve.add_argument("room_id")
    retrieve.add_argument("--after-cursor")
    retrieve.add_argument("--limit", type=int, default=50)
    _add_connection_arguments(retrieve)

    resolve = room_commands.add_parser("resolve")
    resolve.add_argument("room_id")
    resolve.add_argument("message_id")
    resolve.add_argument("--outcome", choices=("fulfilled", "rejected"), required=True)
    resolve.add_argument("--evidence")
    _add_connection_arguments(resolve)

    upload = room_commands.add_parser("upload")
    upload.add_argument("room_id")
    upload.add_argument("path")
    upload.add_argument("--filename")
    upload.add_argument("--media-type")
    _add_connection_arguments(upload)

    download = room_commands.add_parser("download")
    download.add_argument("room_id")
    download.add_argument("artifact_id")
    download.add_argument("output")
    download.add_argument("--force", action="store_true")
    _add_connection_arguments(download)

    leave = room_commands.add_parser("leave")
    leave.add_argument("room_id")
    _add_connection_arguments(leave)

    close = room_commands.add_parser("close")
    close.add_argument("room_id")
    _add_connection_arguments(close)
    return parser


def _request_for(arguments: argparse.Namespace):
    from .coordination.models import CoordinationRequest

    with Path(arguments.request).open(encoding="utf-8") as request_file:
        payload = json.load(request_file)
    request = CoordinationRequest.from_dict(payload)
    return replace(request, mechanism=arguments.mechanism)


def _emit(payload: object, stream: object | None = None) -> None:
    print(json.dumps(payload, sort_keys=True), file=sys.stdout if stream is None else stream)


def _run_coord(arguments: argparse.Namespace) -> int:
    from .coordination.models import TerminalStatus
    from .coordination.registry import MECHANISM_ALIASES, list_mechanisms
    from .coordination.service import CoordinationService

    if arguments.command == "list":
        _emit({"mechanisms": list_mechanisms(), "aliases": MECHANISM_ALIASES})
        return 0

    request = _request_for(arguments)
    service = CoordinationService()
    if arguments.command == "plan":
        _emit(service.plan(request).to_dict())
        return 0

    from .runtime.codex import CodexRuntime

    result = service.execute(request, CodexRuntime(model=arguments.model))
    _emit(result.to_dict())
    return 0 if result.status is TerminalStatus.ACCEPTED else 1


def _session_path(arguments: argparse.Namespace) -> Path:
    explicit = getattr(arguments, "session", None)
    if explicit is not None:
        return Path(explicit)
    configured = os.environ.get("SHAREDNET_ROOM_SESSION")
    if configured:
        return Path(configured)
    return Path.cwd() / ".sharednet" / "room-session.json"


def _load_optional_session(path: Path):
    from .room.client import RoomSessionFile

    if os.path.lexists(path):
        return RoomSessionFile(path).load()
    return None


def _room_client(arguments: argparse.Namespace, *, registration: bool = False):
    from .room.client import RoomClient, normalize_base_url
    from .room.errors import RoomError

    session_path = _session_path(arguments)
    session = _load_optional_session(session_path)
    flag_url = getattr(arguments, "url", None)
    environment_url = os.environ.get("SHAREDNET_ROOM_URL")
    has_url_override = flag_url is not None or environment_url is not None
    if flag_url is not None:
        base_url = flag_url
    elif environment_url is not None:
        base_url = environment_url
    else:
        base_url = session.base_url if session is not None else DEFAULT_ROOM_URL
    base_url = normalize_base_url(base_url)

    environment_token = os.environ.get("SHAREDNET_RUNTIME_TOKEN")
    token: str | None = None
    if not registration:
        if environment_token is not None:
            token = environment_token
        elif session is not None and session.base_url == base_url:
            token = session.runtime_token
        if token is None and not has_url_override:
            raise RoomError(
                "missing_runtime_token",
                "set SHAREDNET_RUNTIME_TOKEN or register a Room session for this URL",
                401,
            )
    return RoomClient(base_url, token, arguments.timeout), session_path


def _is_loopback_host(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _serve_room(arguments: argparse.Namespace) -> int:
    from .room.errors import RoomError

    if not 0 <= arguments.port <= 65535:
        raise RoomError("invalid_port", "serve port must be from 0 through 65535", 400)
    if not _is_loopback_host(arguments.host) and not arguments.allow_remote_without_tls:
        raise RoomError(
            "remote_without_tls",
            "non-loopback serving requires --allow-remote-without-tls",
            400,
        )

    from .room.api import create_room_app
    import uvicorn

    app = create_room_app(
        Path(arguments.database),
        Path(arguments.blobs),
        arguments.max_upload_bytes,
    )
    uvicorn.run(app, host=arguments.host, port=arguments.port)
    return 0


def _run_room(arguments: argparse.Namespace) -> int:
    if arguments.command == "serve":
        return _serve_room(arguments)

    from .room.client import RoomSessionFile
    from .room.errors import RoomError

    registration = arguments.command == "register"
    client, session_path = _room_client(arguments, registration=registration)

    if registration:
        payload = client.register_runtime(
            arguments.principal_id,
            arguments.agent_id,
            arguments.runtime_id,
        )
        registration_payload = payload.get("registration")
        runtime_token = payload.get("runtime_token")
        if not isinstance(registration_payload, dict) or not isinstance(runtime_token, str):
            raise RoomError("invalid_response", "registration response is invalid", 502)
        identity = registration_payload.get("identity")
        if not isinstance(identity, dict):
            raise RoomError("invalid_response", "registration identity is invalid", 502)
        RoomSessionFile(session_path).save(client.base_url, runtime_token, identity)
        _emit(payload)
        return 0

    if arguments.command == "build":
        payload = client.build_room(arguments.name, arguments.description, arguments.access_policy)
    elif arguments.command == "join":
        payload = client.join_room(arguments.room_id)
    elif arguments.command == "list":
        payload = client.list_rooms()
    elif arguments.command == "get":
        payload = client.get_room(arguments.room_id)
    elif arguments.command == "post":
        payload = client.post_message(
            arguments.room_id,
            arguments.content,
            arguments.reply_to,
            arguments.tag,
            arguments.attachment,
        )
    elif arguments.command == "retrieve":
        payload = client.retrieve_messages(
            arguments.room_id,
            arguments.after_cursor,
            arguments.limit,
        )
    elif arguments.command == "resolve":
        payload = client.resolve_message(
            arguments.room_id,
            arguments.message_id,
            arguments.outcome,
            arguments.evidence,
        )
    elif arguments.command == "upload":
        payload = client.upload_artifact(
            arguments.room_id,
            arguments.path,
            arguments.filename,
            arguments.media_type,
        )
    elif arguments.command == "download":
        payload = client.download_artifact(
            arguments.room_id,
            arguments.artifact_id,
            arguments.output,
            force=arguments.force,
        )
    elif arguments.command == "leave":
        payload = client.leave_room(arguments.room_id)
    elif arguments.command == "close":
        payload = client.close_room(arguments.room_id)
    else:
        raise RoomError("invalid_command", "Room command is invalid", 400)
    _emit(payload)
    return 0


def _reject_token_arguments(arguments: Sequence[str]) -> None:
    if arguments and arguments[0] == "room" and any(
        item == "--token" or item.startswith("--token=") for item in arguments
    ):
        from .room.errors import RoomError

        raise RoomError(
            "token_argument_forbidden",
            "bearer tokens must be provided through SHAREDNET_RUNTIME_TOKEN",
            400,
        )


def main(argv: Sequence[str] | None = None) -> int:
    """Run the selected namespace and return a conventional process exit code."""
    raw_arguments = list(sys.argv[1:] if argv is None else argv)
    is_room = bool(raw_arguments and raw_arguments[0] == "room")
    try:
        _reject_token_arguments(raw_arguments)
        arguments = _parser().parse_args(raw_arguments)
        if arguments.namespace == "coord":
            return _run_coord(arguments)
        if arguments.namespace == "room":
            return _run_room(arguments)
        raise ValueError("unknown namespace")
    except Exception as error:
        if is_room:
            from .room.errors import RoomError

            if isinstance(error, RoomError):
                room_error = error
            elif isinstance(error, (OSError, ValueError, json.JSONDecodeError)):
                room_error = RoomError("invalid_arguments", str(error), 400)
            else:
                raise
            _emit(
                {
                    "error": {
                        "code": room_error.code,
                        "message": room_error.message,
                        "status_code": room_error.status_code,
                    }
                },
                sys.stderr,
            )
            return 2
        if isinstance(error, (OSError, ValueError, json.JSONDecodeError)):
            _emit({"error": str(error), "type": type(error).__name__}, sys.stderr)
            return 2
        raise


if __name__ == "__main__":
    raise SystemExit(main())
