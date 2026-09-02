from __future__ import annotations

import re
import secrets


BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
BODY_LENGTH = 10
_TYPED_ID = re.compile(r"^(?P<prefix>[pari])_[0-9A-Za-z]{10}$")


def _new_typed_id(prefix: str) -> str:
    if prefix not in {"p", "a", "r", "i"}:
        raise ValueError("unsupported SharedNet identity prefix")
    return f"{prefix}_{''.join(secrets.choice(BASE62) for _ in range(BODY_LENGTH))}"


def new_principal_id() -> str:
    return _new_typed_id("p")


def new_agent_id() -> str:
    return _new_typed_id("a")


def new_runtime_id() -> str:
    return _new_typed_id("r")


def new_instance_id() -> str:
    return _new_typed_id("i")


def is_typed_id(value: object, prefix: str) -> bool:
    match = _TYPED_ID.fullmatch(value) if isinstance(value, str) else None
    return match is not None and match.group("prefix") == prefix
