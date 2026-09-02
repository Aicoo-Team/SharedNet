"""Small restart-safe heartbeat loop for explicitly configured local Instances."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
import tempfile
import time

from ..control.client import ControlClient
from ..control.models import ControlError
from ..control.session import InstanceSessionFile
from ..room.errors import RoomError


@dataclass(frozen=True)
class InstanceTarget:
    session_path: Path
    active: bool = True

    def __init__(self, session_path: str | os.PathLike[str], active: bool = True) -> None:
        object.__setattr__(self, "session_path", Path(session_path))
        object.__setattr__(self, "active", bool(active))


@dataclass(frozen=True)
class LocalConfig:
    instances: tuple[InstanceTarget, ...]
    lease_seconds: int = 90
    request_timeout: float = 10.0

    def __post_init__(self) -> None:
        if (
            isinstance(self.lease_seconds, bool)
            or not isinstance(self.lease_seconds, int)
            or not 3 <= self.lease_seconds <= 3600
        ):
            raise ControlError(
                "invalid_local_config",
                "lease_seconds must be between 3 and 3600",
                400,
            )
        if (
            isinstance(self.request_timeout, bool)
            or not isinstance(self.request_timeout, (int, float))
            or not math.isfinite(self.request_timeout)
            or self.request_timeout <= 0
        ):
            raise ControlError(
                "invalid_local_config",
                "request_timeout must be a positive number",
                400,
            )
        normalized = tuple(self.instances)
        if any(not isinstance(item, InstanceTarget) for item in normalized):
            raise ControlError("invalid_local_config", "instances are invalid", 400)
        paths = [str(item.session_path) for item in normalized]
        if len(paths) != len(set(paths)):
            raise ControlError(
                "invalid_local_config",
                "Instance session paths must be unique",
                400,
            )
        object.__setattr__(self, "instances", normalized)
        object.__setattr__(self, "request_timeout", float(self.request_timeout))

    @classmethod
    def load(cls, path: str | os.PathLike[str]) -> "LocalConfig":
        config_path = Path(path)
        try:
            raw = config_path.read_bytes()
        except OSError as error:
            raise ControlError(
                "local_config_read_error",
                "Local connector config could not be read",
                400,
            ) from error
        if len(raw) > 256 * 1024:
            raise ControlError("invalid_local_config", "Local connector config is too large", 400)
        try:
            payload = json.loads(raw.decode("utf-8"))
            if not isinstance(payload, dict) or set(payload) != {
                "version",
                "lease_seconds",
                "request_timeout",
                "instances",
            }:
                raise ValueError("invalid shape")
            if payload["version"] != 1 or isinstance(payload["version"], bool):
                raise ValueError("invalid version")
            if not isinstance(payload["instances"], list):
                raise ValueError("invalid instances")
            targets: list[InstanceTarget] = []
            for item in payload["instances"]:
                if not isinstance(item, dict) or set(item) != {"session_path", "active"}:
                    raise ValueError("invalid target")
                if not isinstance(item["session_path"], str) or not item["session_path"]:
                    raise ValueError("invalid target path")
                if not isinstance(item["active"], bool):
                    raise ValueError("invalid target status")
                targets.append(InstanceTarget(item["session_path"], item["active"]))
            return cls(
                tuple(targets),
                payload["lease_seconds"],
                payload["request_timeout"],
            )
        except (KeyError, TypeError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            raise ControlError(
                "invalid_local_config",
                "Local connector config is invalid",
                400,
            ) from error

    def save(self, path: str | os.PathLike[str]) -> None:
        config_path = Path(path)
        config_path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        payload = {
            "version": 1,
            "lease_seconds": self.lease_seconds,
            "request_timeout": self.request_timeout,
            "instances": [
                {"session_path": str(item.session_path), "active": item.active}
                for item in self.instances
            ],
        }
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{config_path.name}.",
            suffix=".tmp",
            dir=config_path.parent,
        )
        temporary_path = Path(temporary_name)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                json.dump(payload, output, sort_keys=True, separators=(",", ":"))
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary_path, config_path)
            temporary_path = None
        finally:
            if temporary_path is not None:
                try:
                    temporary_path.unlink()
                except FileNotFoundError:
                    pass

    def with_instance(self, session_path: str | os.PathLike[str]) -> "LocalConfig":
        resolved = Path(session_path).expanduser().resolve()
        targets = list(self.instances)
        for index, target in enumerate(targets):
            if target.session_path.expanduser().resolve() == resolved:
                targets[index] = InstanceTarget(resolved, True)
                break
        else:
            targets.append(InstanceTarget(resolved, True))
        return LocalConfig(tuple(targets), self.lease_seconds, self.request_timeout)


class LocalConnector:
    """Refresh presence leases without owning task or Instance lifecycle."""

    def __init__(
        self,
        client_or_factory: object,
        config: LocalConfig,
        *,
        clock: Callable[[], float] = time.monotonic,
        config_path: str | os.PathLike[str] | None = None,
    ) -> None:
        self.client_or_factory = client_or_factory
        self.config = config
        self.clock = clock
        self.config_path = None if config_path is None else Path(config_path)
        self._next_attempt: dict[str, float] = {}
        self._failures: dict[str, int] = {}

    def _client(self, api_url: str):
        if hasattr(self.client_or_factory, "heartbeat_instance"):
            return self.client_or_factory
        if callable(self.client_or_factory):
            return self.client_or_factory(api_url, self.config.request_timeout)
        raise ControlError("invalid_local_client", "Local connector client is invalid", 500)

    def tick(self) -> list[dict[str, object]]:
        if self.config_path is not None:
            try:
                self.config = LocalConfig.load(self.config_path)
            except ControlError as error:
                return [{"status": "retrying", "error_code": error.code}]
        now = self.clock()
        receipts: list[dict[str, object]] = []
        success_interval = self.config.lease_seconds / 3
        for target in self.config.instances:
            if not target.active:
                continue
            key = str(target.session_path)
            if now < self._next_attempt.get(key, 0.0):
                continue
            try:
                session = InstanceSessionFile(target.session_path).load()
                self._client(session.api_url).heartbeat_instance(
                    session.instance_token,
                    self.config.lease_seconds,
                )
            except (ControlError, RoomError) as error:
                failures = self._failures.get(key, 0) + 1
                self._failures[key] = failures
                retry_seconds = min(success_interval, float(2 ** min(failures - 1, 10)))
                self._next_attempt[key] = now + retry_seconds
                receipts.append(
                    {
                        "session_path": key,
                        "status": "retrying",
                        "error_code": error.code,
                        "retry_seconds": retry_seconds,
                    }
                )
                continue
            self._failures[key] = 0
            self._next_attempt[key] = now + success_interval
            receipts.append(
                {
                    "session_path": key,
                    "instance_id": session.instance_id,
                    "status": "online",
                    "next_heartbeat_seconds": success_interval,
                }
            )
        return receipts

    def run_forever(self, sleep: Callable[[float], None] = time.sleep) -> None:
        while True:
            self.tick()
            sleep(1.0)


def control_client_factory(api_url: str, timeout: float) -> ControlClient:
    return ControlClient(api_url, timeout)


__all__ = [
    "InstanceTarget",
    "LocalConfig",
    "LocalConnector",
    "control_client_factory",
]
