"""Local JSON command line for SharedNet coordination and Rooms."""

from __future__ import annotations

import argparse
from dataclasses import replace
import ipaddress
import json
import os
from pathlib import Path
import shutil
import sys
import time
from typing import Sequence


DEFAULT_MODEL = "gpt-5.6-luna"
DEFAULT_ROOM_URL = "http://127.0.0.1:8765"
DEFAULT_WEB_URL = "http://127.0.0.1:3001"


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

    login = namespaces.add_parser("login")
    login.add_argument("--api", default=DEFAULT_ROOM_URL)
    login.add_argument("--web", default=DEFAULT_WEB_URL)
    login.add_argument("--account-session", default=".sharednet/account-session.json")
    login.add_argument("--timeout", type=_positive_float, default=30.0)
    login.add_argument("--wait-seconds", type=_positive_float, default=600.0)
    login.add_argument("--poll-interval", type=_positive_float, default=0.5)

    agent = namespaces.add_parser("agent")
    agent_commands = agent.add_subparsers(dest="command", required=True)
    connect = agent_commands.add_parser("connect")
    connect.add_argument(
        "--runtime-kind",
        choices=("codex", "claude-code", "custom"),
        required=True,
    )
    connect.add_argument("--workspace", required=True)
    connect.add_argument("--label")
    connect.add_argument("--provider-session-id")
    connect.add_argument("--account-session", default=".sharednet/account-session.json")
    connect.add_argument("--agent-state", default=".sharednet/agent-state.json")
    connect.add_argument("--instance-session", default=".sharednet/instance-session.json")
    connect.add_argument("--lease-seconds", type=_positive_int, default=90)
    connect.add_argument("--timeout", type=_positive_float, default=30.0)

    instance = namespaces.add_parser("instance")
    instance_commands = instance.add_subparsers(dest="command", required=True)
    heartbeat = instance_commands.add_parser("heartbeat")
    heartbeat.add_argument("--session", default=".sharednet/instance-session.json")
    heartbeat.add_argument("--lease-seconds", type=_positive_int, default=90)
    heartbeat.add_argument("--timeout", type=_positive_float, default=30.0)
    end = instance_commands.add_parser("end")
    end.add_argument("--session", default=".sharednet/instance-session.json")
    end.add_argument("--timeout", type=_positive_float, default=30.0)

    decision = namespaces.add_parser("decision")
    decision_commands = decision.add_subparsers(dest="command", required=True)
    request_decision = decision_commands.add_parser("request")
    request_decision.add_argument("--mode", choices=("approval", "text"), required=True)
    request_decision.add_argument("--title", required=True)
    request_decision.add_argument("--description", required=True)
    request_decision.add_argument("--consequence")
    request_decision.add_argument("--room-id")
    request_decision.add_argument("--session", default=".sharednet/instance-session.json")
    request_decision.add_argument("--timeout", type=_positive_float, default=30.0)
    get_decision = decision_commands.add_parser("get")
    get_decision.add_argument("decision_id")
    get_decision.add_argument("--session", default=".sharednet/instance-session.json")
    get_decision.add_argument("--timeout", type=_positive_float, default=30.0)

    local = namespaces.add_parser("local")
    local_commands = local.add_subparsers(dest="command", required=True)
    run_local = local_commands.add_parser("run")
    run_local.add_argument("--config", default=".sharednet/local.json")
    install_service = local_commands.add_parser("install-service")
    install_service.add_argument("--config", default=".sharednet/local.json")
    install_service.add_argument("--executable")
    install_service.add_argument("--plist")
    for command_name in ("start-service", "stop-service", "status"):
        command = local_commands.add_parser(command_name)
        command.add_argument("--plist")

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

    register = room_commands.add_parser(
        "register",
        help="legacy compatibility only; requires server opt-in",
        description=(
            "Legacy compatibility only. This is not SharedNet V1 onboarding "
            "and requires a server with legacy registration explicitly enabled."
        ),
    )
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
    print(
        json.dumps(payload, sort_keys=True),
        file=sys.stdout if stream is None else stream,
        flush=True,
    )


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

    environment_instance_token = os.environ.get("SHAREDNET_INSTANCE_TOKEN")
    environment_runtime_token = os.environ.get("SHAREDNET_RUNTIME_TOKEN")
    token: str | None = None
    auth_scheme = "Bearer"
    if not registration:
        if environment_instance_token is not None:
            token = environment_instance_token
            auth_scheme = "Instance"
        elif environment_runtime_token is not None:
            token = environment_runtime_token
        elif session is not None and session.base_url == base_url:
            token = session.runtime_token
            auth_scheme = session.auth_scheme
        if token is None and not has_url_override:
            raise RoomError(
                "missing_runtime_token",
                "connect an Instance session or set SHAREDNET_INSTANCE_TOKEN",
                401,
            )
    return (
        RoomClient(
            base_url,
            token,
            arguments.timeout,
            auth_scheme=auth_scheme,
        ),
        session_path,
    )


def _required_string(payload: object, field: str) -> str:
    if not isinstance(payload, dict) or not isinstance(payload.get(field), str) or not payload[field]:
        from .room.errors import RoomError

        raise RoomError("invalid_response", f"response {field} is invalid", 502)
    return payload[field]


def _required_identity(payload: object) -> dict[str, str]:
    if not isinstance(payload, dict) or not isinstance(payload.get("identity"), dict):
        from .room.errors import RoomError

        raise RoomError("invalid_response", "response identity is invalid", 502)
    identity = payload["identity"]
    result: dict[str, str] = {}
    for field in ("principal_id", "agent_id", "runtime_id", "instance_id"):
        value = identity.get(field)
        if not isinstance(value, str) or not value:
            from .room.errors import RoomError

            raise RoomError("invalid_response", f"response identity {field} is invalid", 502)
        result[field] = value
    return result


def _run_login(arguments: argparse.Namespace) -> int:
    from .control.client import ControlClient
    from .control.models import ControlError
    from .control.session import AccountSessionFile
    from .room.errors import RoomError

    client = ControlClient(arguments.api, arguments.timeout)
    account_path = Path(arguments.account_session)
    account_file = AccountSessionFile(account_path)
    if os.path.lexists(account_path):
        account = account_file.load()
        if account.api_url != client.base_url:
            raise ControlError(
                "account_session_api_mismatch",
                "Account session belongs to another SharedNet API; choose a different session path or remove it explicitly before pairing again",
                409,
            )
        _emit(
            {
                "status": "connected",
                "principal_id": account.principal_id,
                "account_session": str(account_path),
                "reused": True,
            }
        )
        return 0

    pairing = client.create_pairing(arguments.web)
    pairing_id = _required_string(pairing, "pairing_id")
    pairing_secret = _required_string(pairing, "pairing_secret")
    verification_url = _required_string(pairing, "verification_url")
    _emit(
        {
            "status": "authorization_required",
            "pairing_id": pairing_id,
            "verification_url": verification_url,
        }
    )

    deadline = time.monotonic() + arguments.wait_seconds
    while True:
        try:
            connected = client.exchange_pairing(pairing_id, pairing_secret)
            break
        except RoomError as error:
            if error.code != "pairing_not_approved":
                raise
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RoomError(
                    "pairing_timeout",
                    "pairing was not approved before the local wait expired",
                    408,
                ) from error
            time.sleep(min(arguments.poll_interval, remaining))

    principal_id = _required_string(connected, "principal_id")
    connector_token = _required_string(connected, "connector_token")
    account_file.save(client.base_url, principal_id, connector_token)
    _emit(
        {
            "status": "connected",
            "principal_id": principal_id,
            "account_session": str(account_path),
            "reused": False,
        }
    )
    return 0


def _run_agent(arguments: argparse.Namespace) -> int:
    from .control.client import ControlClient
    from .control.models import ControlError
    from .control.session import AccountSessionFile, AgentStateFile, InstanceSessionFile
    from .local.service import LocalConfig

    account = AccountSessionFile(arguments.account_session).load()
    client = ControlClient(account.api_url, arguments.timeout)
    agent_file = AgentStateFile(arguments.agent_state)
    instance_file = InstanceSessionFile(arguments.instance_session)
    local_config_path = instance_file.path.parent / "local.json"
    if os.path.lexists(local_config_path):
        local_config = LocalConfig.load(local_config_path)
    else:
        local_config = LocalConfig(instances=())
    if os.path.lexists(instance_file.path):
        raise ControlError(
            "session_exists",
            "Instance session file already exists; choose a new path for a new conversation",
            409,
        )

    if os.path.lexists(agent_file.path):
        state = agent_file.load()
        if state.principal_id != account.principal_id or state.api_url != account.api_url:
            raise ControlError(
                "agent_state_mismatch",
                "Agent state belongs to another SharedNet Principal or API",
                409,
            )
    else:
        workspace = Path(arguments.workspace).expanduser().resolve()
        if not workspace.is_dir():
            raise ControlError("invalid_workspace", "workspace must be an existing directory", 400)
        labels = {"codex": "Codex", "claude-code": "Claude Code", "custom": "Custom Agent"}
        agent = client.create_agent(
            account.connector_token,
            arguments.label or labels[arguments.runtime_kind],
            ("rooms", "decisions"),
        )
        agent_id = _required_string(agent, "agent_id")
        agent_principal_id = _required_string(agent, "principal_id")
        if agent_principal_id != account.principal_id:
            raise ControlError("invalid_response", "Agent Principal does not match account", 502)
        runtime = client.register_runtime(
            account.connector_token,
            agent_id,
            arguments.runtime_kind,
            str(workspace),
        )
        runtime_principal_id = _required_string(runtime, "principal_id")
        runtime_agent_id = _required_string(runtime, "agent_id")
        runtime_id = _required_string(runtime, "runtime_id")
        runtime_token = _required_string(runtime, "runtime_token")
        if runtime_principal_id != account.principal_id or runtime_agent_id != agent_id:
            raise ControlError("invalid_response", "Runtime identity does not match Agent", 502)
        agent_file.save(
            account.api_url,
            account.principal_id,
            agent_id,
            runtime_id,
            runtime_token,
        )
        state = agent_file.load()

    instance = client.start_instance(
        state.runtime_token,
        arguments.provider_session_id,
        arguments.lease_seconds,
    )
    identity = _required_identity(instance)
    if (
        identity["principal_id"] != state.principal_id
        or identity["agent_id"] != state.agent_id
        or identity["runtime_id"] != state.runtime_id
    ):
        raise ControlError("invalid_response", "Instance identity does not match Runtime", 502)
    instance_token = _required_string(instance, "instance_token")
    try:
        instance_file.save(
            state.api_url,
            identity["principal_id"],
            identity["agent_id"],
            identity["runtime_id"],
            identity["instance_id"],
            instance_token,
        )
    except Exception:
        try:
            client.end_instance(instance_token)
        except Exception:
            pass
        raise
    local_config.with_instance(instance_file.path).save(local_config_path)
    _emit(
        {
            "status": "connected",
            "identity": identity,
            "instance_session": str(instance_file.path),
            "local_config": str(local_config_path),
            "expires_at": instance.get("expires_at"),
        }
    )
    return 0


def _run_instance(arguments: argparse.Namespace) -> int:
    from .control.client import ControlClient
    from .control.session import InstanceSessionFile

    session = InstanceSessionFile(arguments.session).load()
    client = ControlClient(session.api_url, arguments.timeout)
    if arguments.command == "heartbeat":
        payload = client.heartbeat_instance(session.instance_token, arguments.lease_seconds)
    elif arguments.command == "end":
        payload = client.end_instance(session.instance_token)
    else:
        raise ValueError("unknown Instance command")
    _emit(payload)
    return 0


def _run_decision(arguments: argparse.Namespace) -> int:
    from .control.client import ControlClient
    from .control.session import InstanceSessionFile

    session = InstanceSessionFile(arguments.session).load()
    client = ControlClient(session.api_url, arguments.timeout)
    if arguments.command == "request":
        payload = client.request_decision(
            session.instance_token,
            arguments.mode,
            arguments.title,
            arguments.description,
            arguments.consequence,
            arguments.room_id,
        )
    elif arguments.command == "get":
        payload = client.get_decision(session.instance_token, arguments.decision_id)
    else:
        raise ValueError("unknown Decision command")
    _emit(payload)
    return 0


def _run_local(arguments: argparse.Namespace) -> int:
    from .control.models import ControlError
    from .local.launchd import install_launch_agent, launchctl
    from .local.service import LocalConfig, LocalConnector, control_client_factory

    if arguments.command == "run":
        config = LocalConfig.load(arguments.config)
        connector = LocalConnector(
            control_client_factory,
            config,
            config_path=arguments.config,
        )
        _emit({"status": "running", "configured_instances": len(config.instances)})
        try:
            connector.run_forever()
        except KeyboardInterrupt:
            pass
        _emit({"status": "stopped"})
        return 0

    plist_path = Path(arguments.plist).expanduser() if arguments.plist else None
    if arguments.command == "install-service":
        executable_value = arguments.executable or shutil.which("sharednet")
        if executable_value is None:
            raise ControlError(
                "sharednet_executable_not_found",
                "SharedNet executable was not found; pass --executable",
                400,
            )
        installed = install_launch_agent(
            Path(executable_value),
            Path(arguments.config),
            plist_path,
        )
        _emit({"status": "installed", "plist": str(installed)})
        return 0

    command = {
        "start-service": "start",
        "stop-service": "stop",
        "status": "status",
    }.get(arguments.command)
    if command is None:
        raise ControlError("invalid_local_command", "Local command is invalid", 400)
    completed = launchctl(command, plist_path)
    if completed.returncode != 0:
        raise ControlError(
            "launchctl_failed",
            f"SharedNet Local {command} failed",
            409,
        )
    _emit({"status": "ok", "command": command})
    return 0


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
        _emit(
            {
                "compatibility": "legacy",
                "registration": registration_payload,
                "session_path": str(session_path),
            }
        )
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
    if arguments and arguments[0] in {"room", "login", "agent", "instance", "decision", "local"} and any(
        item == "--token" or item.startswith("--token=") for item in arguments
    ):
        from .room.errors import RoomError

        raise RoomError(
            "token_argument_forbidden",
            "credentials must use an owner-only session file; legacy clients may use SHAREDNET_RUNTIME_TOKEN",
            400,
        )


def main(argv: Sequence[str] | None = None) -> int:
    """Run the selected namespace and return a conventional process exit code."""
    raw_arguments = list(sys.argv[1:] if argv is None else argv)
    is_local_protocol = bool(
        raw_arguments
        and raw_arguments[0] in {"room", "login", "agent", "instance", "decision", "local"}
    )
    try:
        _reject_token_arguments(raw_arguments)
        arguments = _parser().parse_args(raw_arguments)
        if arguments.namespace == "login":
            return _run_login(arguments)
        if arguments.namespace == "agent":
            return _run_agent(arguments)
        if arguments.namespace == "instance":
            return _run_instance(arguments)
        if arguments.namespace == "decision":
            return _run_decision(arguments)
        if arguments.namespace == "local":
            return _run_local(arguments)
        if arguments.namespace == "coord":
            return _run_coord(arguments)
        if arguments.namespace == "room":
            return _run_room(arguments)
        raise ValueError("unknown namespace")
    except Exception as error:
        if is_local_protocol:
            from .control.models import ControlError
            from .room.errors import RoomError

            if isinstance(error, (RoomError, ControlError)):
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
