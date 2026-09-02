"""macOS LaunchAgent rendering and lifecycle for SharedNet Local."""

from __future__ import annotations

import os
from pathlib import Path
import plistlib
import subprocess
import tempfile

from ..control.models import ControlError


LABEL = "ai.sharednet.local"


def render_launchd_plist(executable: Path, config_path: Path) -> str:
    executable = executable.expanduser().resolve()
    config_path = config_path.expanduser().resolve()
    payload = {
        "Label": LABEL,
        "ProgramArguments": [
            str(executable),
            "local",
            "run",
            "--config",
            str(config_path),
        ],
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},
        "ProcessType": "Background",
    }
    return plistlib.dumps(payload, sort_keys=True).decode("utf-8")


def default_plist_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"


def install_launch_agent(
    executable: Path,
    config_path: Path,
    destination: Path | None = None,
) -> Path:
    target = default_plist_path() if destination is None else destination
    if os.path.lexists(target):
        raise ControlError("launch_agent_exists", "SharedNet LaunchAgent already exists", 409)
    target.parent.mkdir(parents=True, exist_ok=True)
    encoded = render_launchd_plist(executable, config_path).encode("utf-8")
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.", suffix=".tmp", dir=target.parent
    )
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(encoded)
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary_path, target)
    except FileExistsError as error:
        raise ControlError("launch_agent_exists", "SharedNet LaunchAgent already exists", 409) from error
    finally:
        try:
            temporary_path.unlink()
        except FileNotFoundError:
            pass
    return target


def launchctl(command: str, plist_path: Path | None = None) -> subprocess.CompletedProcess[str]:
    if command not in {"start", "stop", "status"}:
        raise ControlError("invalid_launchctl_command", "LaunchAgent command is invalid", 400)
    domain = f"gui/{os.getuid()}"
    path = default_plist_path() if plist_path is None else plist_path
    if command == "start":
        arguments = ["/bin/launchctl", "bootstrap", domain, str(path)]
    elif command == "stop":
        arguments = ["/bin/launchctl", "bootout", domain, str(path)]
    else:
        arguments = ["/bin/launchctl", "print", f"{domain}/{LABEL}"]
    return subprocess.run(arguments, text=True, capture_output=True, check=False)


__all__ = [
    "LABEL",
    "default_plist_path",
    "install_launch_agent",
    "launchctl",
    "render_launchd_plist",
]
