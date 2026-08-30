"""Local JSON command line for bounded SharedNet coordination."""

from __future__ import annotations

import argparse
from dataclasses import replace
import json
from pathlib import Path
import sys
from typing import Sequence

from .coordination.models import CoordinationRequest, TerminalStatus
from .coordination.registry import MECHANISM_ALIASES, list_mechanisms
from .coordination.service import CoordinationService
from .runtime.codex import CodexRuntime


DEFAULT_MODEL = "gpt-5.6-luna"


class _ArgumentParser(argparse.ArgumentParser):
    """Convert parser diagnostics into the CLI's structured caller errors."""

    def error(self, message: str) -> None:
        raise ValueError(message)


def _parser() -> argparse.ArgumentParser:
    parser = _ArgumentParser(prog="sharednet")
    namespaces = parser.add_subparsers(dest="namespace", required=True)
    coord = namespaces.add_parser("coord")
    commands = coord.add_subparsers(dest="command", required=True)
    commands.add_parser("list")
    for command_name in ("plan", "run"):
        command = commands.add_parser(command_name)
        command.add_argument("--mechanism", required=True)
        command.add_argument("--request", required=True)
        if command_name == "run":
            command.add_argument("--model", default=DEFAULT_MODEL)
    return parser


def _request_for(arguments: argparse.Namespace) -> CoordinationRequest:
    with Path(arguments.request).open(encoding="utf-8") as request_file:
        payload = json.load(request_file)
    request = CoordinationRequest.from_dict(payload)
    return replace(request, mechanism=arguments.mechanism)


def _emit(payload: object, stream: object | None = None) -> None:
    print(json.dumps(payload, sort_keys=True), file=sys.stdout if stream is None else stream)


def main(argv: Sequence[str] | None = None) -> int:
    """Run the command and return a conventional process exit code."""
    try:
        arguments = _parser().parse_args(argv)
        if arguments.command == "list":
            _emit({"mechanisms": list_mechanisms(), "aliases": MECHANISM_ALIASES})
            return 0

        request = _request_for(arguments)
        service = CoordinationService()
        if arguments.command == "plan":
            _emit(service.plan(request).to_dict())
            return 0

        result = service.execute(request, CodexRuntime(model=arguments.model))
        _emit(result.to_dict())
        return 0 if result.status is TerminalStatus.ACCEPTED else 1
    except (OSError, ValueError, json.JSONDecodeError) as error:
        _emit({"error": str(error), "type": type(error).__name__}, sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
