"""Frozen, JSON-ready control-plane contracts for SharedNet V1."""

from __future__ import annotations

from dataclasses import dataclass, fields
from datetime import datetime
from enum import Enum
import re
from typing import Any

from ..identity import is_typed_id


_IDENTIFIER = re.compile(r"^[A-Za-z][A-Za-z0-9_.:-]{0,127}$")


@dataclass(frozen=True)
class ControlError(Exception):
    """A client-safe control-plane error with a stable machine code."""

    code: str
    message: str
    status_code: int = 400

    def __post_init__(self) -> None:
        Exception.__init__(self, self.code, self.message, self.status_code)

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"


class PairingStatus(str, Enum):
    PENDING = "pending"
    CLAIMED = "claimed"
    APPROVED = "approved"
    DENIED = "denied"
    EXCHANGED = "exchanged"
    EXPIRED = "expired"


class CredentialStatus(str, Enum):
    ACTIVE = "active"
    REVOKED = "revoked"


class InstanceStatus(str, Enum):
    ONLINE = "online"
    ENDED = "ended"


class DecisionMode(str, Enum):
    APPROVAL = "approval"
    TEXT = "text"


class DecisionStatus(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    DENIED = "denied"
    ANSWERED = "answered"


def _error(field_name: str, message: str) -> ControlError:
    return ControlError("invalid_control_value", f"{field_name} {message}", 400)


def _typed_id(value: object, prefix: str, field_name: str) -> str:
    if not is_typed_id(value, prefix):
        raise _error(field_name, f"must be a typed {prefix}_ identifier")
    return value


def _identifier(value: object, field_name: str) -> str:
    if not isinstance(value, str) or _IDENTIFIER.fullmatch(value) is None:
        raise _error(field_name, "must be a valid identifier")
    return value


def _text(value: object, field_name: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        raise _error(field_name, "must be a non-empty string")
    return value


def _timestamp(value: object, field_name: str) -> datetime:
    if not isinstance(value, datetime):
        raise _error(field_name, "must be a datetime")
    return value


def _optional_timestamp(value: object, field_name: str) -> datetime | None:
    if value is None:
        return None
    return _timestamp(value, field_name)


def _enum(value: object, enum_type: type[Enum], field_name: str) -> Enum:
    if isinstance(value, enum_type):
        return value
    try:
        return enum_type(value)
    except (TypeError, ValueError) as error:
        raise _error(field_name, "is invalid") from error


def _capabilities(value: object) -> tuple[str, ...]:
    if not isinstance(value, (tuple, list)):
        raise _error("capabilities", "must be a list")
    result: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise _error("capabilities", "must contain non-empty strings")
        if item in result:
            raise _error("capabilities", "must be unique")
        result.append(item)
    return tuple(result)


def _json_value(value: object) -> Any:
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, datetime):
        return value.isoformat()
    if hasattr(value, "to_dict"):
        return value.to_dict()
    if isinstance(value, tuple):
        return [_json_value(item) for item in value]
    return value


class _JsonContract:
    def to_dict(self) -> dict[str, Any]:
        return {field.name: _json_value(getattr(self, field.name)) for field in fields(self)}


@dataclass(frozen=True)
class ActorIdentity(_JsonContract):
    principal_id: str
    agent_id: str
    runtime_id: str
    instance_id: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "principal_id", _typed_id(self.principal_id, "p", "principal_id"))
        object.__setattr__(self, "agent_id", _typed_id(self.agent_id, "a", "agent_id"))
        object.__setattr__(self, "runtime_id", _typed_id(self.runtime_id, "r", "runtime_id"))
        object.__setattr__(self, "instance_id", _typed_id(self.instance_id, "i", "instance_id"))


@dataclass(frozen=True)
class PairingChallenge(_JsonContract):
    pairing_id: str
    status: PairingStatus
    claimed_principal_id: str | None
    expires_at: datetime
    created_at: datetime
    resolved_at: datetime | None

    def __post_init__(self) -> None:
        object.__setattr__(self, "pairing_id", _identifier(self.pairing_id, "pairing_id"))
        object.__setattr__(self, "status", _enum(self.status, PairingStatus, "status"))
        if self.claimed_principal_id is not None:
            object.__setattr__(
                self,
                "claimed_principal_id",
                _typed_id(self.claimed_principal_id, "p", "claimed_principal_id"),
            )
        object.__setattr__(self, "expires_at", _timestamp(self.expires_at, "expires_at"))
        object.__setattr__(self, "created_at", _timestamp(self.created_at, "created_at"))
        object.__setattr__(self, "resolved_at", _optional_timestamp(self.resolved_at, "resolved_at"))


@dataclass(frozen=True)
class PairingStart(_JsonContract):
    pairing_id: str
    pairing_secret: str
    verification_url: str
    expires_at: datetime

    def __post_init__(self) -> None:
        object.__setattr__(self, "pairing_id", _identifier(self.pairing_id, "pairing_id"))
        object.__setattr__(self, "pairing_secret", _text(self.pairing_secret, "pairing_secret"))
        object.__setattr__(self, "verification_url", _text(self.verification_url, "verification_url"))
        object.__setattr__(self, "expires_at", _timestamp(self.expires_at, "expires_at"))


@dataclass(frozen=True)
class ConnectorSession(_JsonContract):
    principal_id: str
    credential_id: str
    connector_token: str
    created_at: datetime

    def __post_init__(self) -> None:
        object.__setattr__(self, "principal_id", _typed_id(self.principal_id, "p", "principal_id"))
        object.__setattr__(self, "credential_id", _identifier(self.credential_id, "credential_id"))
        object.__setattr__(self, "connector_token", _text(self.connector_token, "connector_token"))
        object.__setattr__(self, "created_at", _timestamp(self.created_at, "created_at"))

    @property
    def token(self) -> str:
        return self.connector_token


@dataclass(frozen=True)
class AgentBinding(_JsonContract):
    principal_id: str
    agent_id: str
    diagnostic_label: str
    capabilities: tuple[str, ...]
    created_at: datetime

    def __post_init__(self) -> None:
        object.__setattr__(self, "principal_id", _typed_id(self.principal_id, "p", "principal_id"))
        object.__setattr__(self, "agent_id", _typed_id(self.agent_id, "a", "agent_id"))
        object.__setattr__(self, "diagnostic_label", _text(self.diagnostic_label, "diagnostic_label"))
        object.__setattr__(self, "capabilities", _capabilities(self.capabilities))
        object.__setattr__(self, "created_at", _timestamp(self.created_at, "created_at"))


@dataclass(frozen=True)
class RuntimeBinding(_JsonContract):
    principal_id: str
    agent_id: str
    runtime_id: str
    runtime_kind: str
    workspace_label: str | None
    created_at: datetime

    def __post_init__(self) -> None:
        object.__setattr__(self, "principal_id", _typed_id(self.principal_id, "p", "principal_id"))
        object.__setattr__(self, "agent_id", _typed_id(self.agent_id, "a", "agent_id"))
        object.__setattr__(self, "runtime_id", _typed_id(self.runtime_id, "r", "runtime_id"))
        object.__setattr__(self, "runtime_kind", _text(self.runtime_kind, "runtime_kind"))
        if self.workspace_label is not None:
            object.__setattr__(self, "workspace_label", _text(self.workspace_label, "workspace_label"))
        object.__setattr__(self, "created_at", _timestamp(self.created_at, "created_at"))


@dataclass(frozen=True)
class RuntimeSession(RuntimeBinding):
    runtime_token: str

    def __post_init__(self) -> None:
        super().__post_init__()
        object.__setattr__(self, "runtime_token", _text(self.runtime_token, "runtime_token"))


@dataclass(frozen=True)
class AgentInstance(_JsonContract):
    identity: ActorIdentity
    provider_session_id: str | None
    runtime_type: str
    workspace_label: str | None
    capabilities: tuple[str, ...]
    status: InstanceStatus
    presence: str
    started_at: datetime
    last_seen_at: datetime
    expires_at: datetime
    ended_at: datetime | None

    def __post_init__(self) -> None:
        if not isinstance(self.identity, ActorIdentity):
            raise _error("identity", "must be an ActorIdentity")
        if self.provider_session_id is not None:
            object.__setattr__(
                self,
                "provider_session_id",
                _text(self.provider_session_id, "provider_session_id"),
            )
        object.__setattr__(self, "runtime_type", _text(self.runtime_type, "runtime_type"))
        if self.workspace_label is not None:
            object.__setattr__(self, "workspace_label", _text(self.workspace_label, "workspace_label"))
        object.__setattr__(self, "capabilities", _capabilities(self.capabilities))
        object.__setattr__(self, "status", _enum(self.status, InstanceStatus, "status"))
        if self.presence not in {"online", "offline"}:
            raise _error("presence", "must be online or offline")
        object.__setattr__(self, "started_at", _timestamp(self.started_at, "started_at"))
        object.__setattr__(self, "last_seen_at", _timestamp(self.last_seen_at, "last_seen_at"))
        object.__setattr__(self, "expires_at", _timestamp(self.expires_at, "expires_at"))
        object.__setattr__(self, "ended_at", _optional_timestamp(self.ended_at, "ended_at"))


@dataclass(frozen=True)
class InstanceSession(_JsonContract):
    identity: ActorIdentity
    instance_token: str
    started_at: datetime
    expires_at: datetime

    def __post_init__(self) -> None:
        if not isinstance(self.identity, ActorIdentity):
            raise _error("identity", "must be an ActorIdentity")
        object.__setattr__(self, "instance_token", _text(self.instance_token, "instance_token"))
        object.__setattr__(self, "started_at", _timestamp(self.started_at, "started_at"))
        object.__setattr__(self, "expires_at", _timestamp(self.expires_at, "expires_at"))

    @property
    def token(self) -> str:
        return self.instance_token


@dataclass(frozen=True)
class HumanDecision(_JsonContract):
    decision_id: str
    room_id: str | None
    target_principal_id: str
    requester: ActorIdentity | None
    response_mode: DecisionMode
    title: str
    description: str
    consequence: str | None
    status: DecisionStatus
    response_text: str | None
    created_at: datetime
    resolved_at: datetime | None

    def __post_init__(self) -> None:
        object.__setattr__(self, "decision_id", _identifier(self.decision_id, "decision_id"))
        if self.room_id is not None:
            object.__setattr__(self, "room_id", _identifier(self.room_id, "room_id"))
        object.__setattr__(
            self,
            "target_principal_id",
            _typed_id(self.target_principal_id, "p", "target_principal_id"),
        )
        if self.requester is not None and not isinstance(self.requester, ActorIdentity):
            raise _error("requester", "must be an ActorIdentity")
        object.__setattr__(self, "response_mode", _enum(self.response_mode, DecisionMode, "response_mode"))
        object.__setattr__(self, "title", _text(self.title, "title"))
        object.__setattr__(self, "description", _text(self.description, "description"))
        if self.consequence is not None:
            object.__setattr__(self, "consequence", _text(self.consequence, "consequence"))
        object.__setattr__(self, "status", _enum(self.status, DecisionStatus, "status"))
        if self.response_text is not None:
            object.__setattr__(self, "response_text", _text(self.response_text, "response_text"))
        object.__setattr__(self, "created_at", _timestamp(self.created_at, "created_at"))
        object.__setattr__(self, "resolved_at", _optional_timestamp(self.resolved_at, "resolved_at"))
