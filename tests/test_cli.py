"""Black-box contracts for the local coordination command line."""

from __future__ import annotations

import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from fastapi import FastAPI, Request

from sharednet.coordination.models import CoordinationResult, TerminalStatus
from sharednet.room.client import RoomSessionFile

from tests.room.test_client import LiveServer, room_server


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
EXAMPLE_REQUEST = REPOSITORY_ROOT / "examples" / "four-agent-task.json"


def run_cli(
    *arguments: str,
    cwd: Path | None = None,
    extra_environment: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    for name in ("SHAREDNET_ROOM_URL", "SHAREDNET_RUNTIME_TOKEN", "SHAREDNET_ROOM_SESSION"):
        environment.pop(name, None)
    if extra_environment:
        environment.update(extra_environment)
    source_directory = str(REPOSITORY_ROOT / "src")
    environment["PYTHONPATH"] = os.pathsep.join(
        path for path in (source_directory, environment.get("PYTHONPATH")) if path
    )
    return subprocess.run(
        [sys.executable, "-m", "sharednet.cli", *arguments],
        cwd=REPOSITORY_ROOT if cwd is None else cwd,
        text=True,
        capture_output=True,
        check=False,
        env=environment,
        timeout=60,
    )


class CliTests(unittest.TestCase):
    def test_list_outputs_canonical_backends_and_aliases_without_runtime(self) -> None:
        completed = run_cli("coord", "list")

        self.assertEqual(completed.returncode, 0, completed.stderr)
        payload = json.loads(completed.stdout)
        self.assertEqual(
            [item["id"] for item in payload["mechanisms"]],
            ["discovery-and-use", "rac-rge", "rac-adaptive", "peer-forum"],
        )
        self.assertEqual(payload["aliases"], {"rac-adpt": "rac-adaptive"})

    def test_plan_example_selects_four_participants_without_constructing_runtime(self) -> None:
        from sharednet import cli

        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = cli.main(
                [
                    "coord",
                    "plan",
                    "--mechanism",
                    "rac-rge",
                    "--request",
                    str(EXAMPLE_REQUEST),
                ]
            )

        self.assertEqual(code, 0, stderr.getvalue())
        payload = json.loads(stdout.getvalue())
        self.assertEqual(
            [participant["candidate_id"] for participant in payload["participants"]],
            ["self", "research-agent", "architecture-agent", "risk-agent"],
        )

    def test_run_returns_one_for_terminal_runtime_failure_and_uses_requested_model(self) -> None:
        from sharednet import cli

        observed_models: list[str] = []

        class FailingRuntime:
            def __init__(self, *, model: str) -> None:
                observed_models.append(model)

            def execute(self, plan):
                return CoordinationResult(status=TerminalStatus.FAILED, plan=plan, error="codex_unavailable")

        stdout = io.StringIO()
        stderr = io.StringIO()
        with patch("sharednet.runtime.codex.CodexRuntime", FailingRuntime):
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = cli.main(
                    [
                        "coord",
                        "run",
                        "--mechanism",
                        "rac-rge",
                        "--request",
                        str(EXAMPLE_REQUEST),
                        "--model",
                        "gpt-5.6-luna",
                    ]
                )

        self.assertEqual(code, 1, stderr.getvalue())
        self.assertEqual(observed_models, ["gpt-5.6-luna"])
        self.assertEqual(json.loads(stdout.getvalue())["status"], "failed")

    def test_invalid_request_returns_structured_caller_error(self) -> None:
        from sharednet import cli

        with tempfile.TemporaryDirectory() as directory:
            request_path = Path(directory) / "invalid.json"
            request_path.write_text('{"mechanism": "rac-rge"}', encoding="utf-8")
            stdout = io.StringIO()
            stderr = io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = cli.main(["coord", "plan", "--mechanism", "rac-rge", "--request", str(request_path)])

        self.assertEqual(code, 2)
        self.assertEqual(stdout.getvalue(), "")
        payload = json.loads(stderr.getvalue())
        self.assertEqual(payload["type"], "ValueError")
        self.assertTrue(payload["error"])

    def test_unknown_mechanism_returns_structured_caller_error(self) -> None:
        completed = run_cli("coord", "plan", "--mechanism", "missing", "--request", "examples/four-agent-task.json")

        self.assertEqual(completed.returncode, 2)
        self.assertEqual(completed.stdout, "")
        payload = json.loads(completed.stderr)
        self.assertEqual(payload["type"], "UnknownMechanism")
        self.assertIn("unknown coordination mechanism", payload["error"])


class RoomCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.server = room_server(self.root / "server").start()

    def tearDown(self) -> None:
        self.server.stop()
        self.temporary_directory.cleanup()

    def room_cli(
        self,
        command: str,
        *arguments: str,
        extra_environment: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        return run_cli(
            "room",
            command,
            *arguments,
            cwd=self.root,
            extra_environment=extra_environment,
        )

    def register(
        self,
        principal_id: str = "principal_alice",
        agent_id: str = "agent_alpha",
        runtime_id: str = "runtime_alpha",
        *,
        session: Path | None = None,
    ) -> tuple[dict[str, object], Path]:
        session_path = self.root / ".sharednet" / "room-session.json" if session is None else session
        arguments = [
            "--principal-id",
            principal_id,
            "--agent-id",
            agent_id,
            "--runtime-id",
            runtime_id,
            "--url",
            self.server.url,
        ]
        if session is not None:
            arguments.extend(("--session", str(session)))
        completed = self.room_cli("register", *arguments)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout), session_path

    def test_registration_saves_session_and_only_registration_prints_token(self) -> None:
        registration, session_path = self.register()
        token = registration["runtime_token"]
        self.assertTrue(token)
        session = RoomSessionFile(session_path).load()
        self.assertEqual(session.runtime_token, token)
        self.assertEqual(session.identity["runtime_id"], "runtime_alpha")

        built = self.room_cli("build", "--name", "CLI Room")
        self.assertEqual(built.returncode, 0, built.stderr)
        listed = self.room_cli("list")
        self.assertEqual(listed.returncode, 0, listed.stderr)
        for completed in (built, listed):
            self.assertNotIn(token, completed.stdout)
            self.assertNotIn(token, completed.stderr)
        self.assertEqual(json.loads(listed.stdout)["rooms"][0]["name"], "CLI Room")

    def test_cli_posts_repeated_tags_and_attachments_in_argument_order(self) -> None:
        self.register()
        room = json.loads(self.room_cli("build", "--name", "Order").stdout)
        room_id = room["room_id"]
        artifacts: list[str] = []
        for index, content in enumerate((b"first", b"second"), start=1):
            source = self.root / f"source-{index}.bin"
            source.write_bytes(content)
            uploaded = self.room_cli(
                "upload",
                room_id,
                str(source),
                "--filename",
                f"file-{index}.bin",
                "--media-type",
                "application/x-test",
            )
            self.assertEqual(uploaded.returncode, 0, uploaded.stderr)
            artifacts.append(json.loads(uploaded.stdout)["artifact_id"])

        posted = self.room_cli(
            "post",
            room_id,
            "--content",
            "ordered clauses",
            "--tag",
            "verification-required",
            "--tag",
            "delegate-to:agent_alpha",
            "--attachment",
            artifacts[0],
            "--attachment",
            artifacts[1],
        )
        self.assertEqual(posted.returncode, 0, posted.stderr)
        payload = json.loads(posted.stdout)
        self.assertEqual(
            [item["raw"] for item in payload["tags"]],
            ["verification-required", "delegate-to:agent_alpha"],
        )
        self.assertEqual(payload["attachment_ids"], artifacts)

    def test_cli_download_is_atomic_and_requires_force_to_replace(self) -> None:
        self.register()
        room_id = json.loads(self.room_cli("build", "--name", "Files").stdout)["room_id"]
        source = self.root / "source.bin"
        source.write_bytes(b"download through CLI")
        uploaded = self.room_cli("upload", room_id, str(source))
        artifact_id = json.loads(uploaded.stdout)["artifact_id"]
        destination = self.root / "destination.bin"

        downloaded = self.room_cli("download", room_id, artifact_id, str(destination))
        self.assertEqual(downloaded.returncode, 0, downloaded.stderr)
        self.assertEqual(destination.read_bytes(), b"download through CLI")
        refused = self.room_cli("download", room_id, artifact_id, str(destination))
        self.assertEqual(refused.returncode, 2)
        self.assertEqual(json.loads(refused.stderr)["error"]["code"], "destination_exists")
        replaced = self.room_cli(
            "download", room_id, artifact_id, str(destination), "--force"
        )
        self.assertEqual(replaced.returncode, 0, replaced.stderr)

    def test_room_api_error_has_stable_stderr_shape_and_exit_two(self) -> None:
        self.register()
        completed = self.room_cli("get", "room_missing")

        self.assertEqual(completed.returncode, 2)
        self.assertEqual(completed.stdout, "")
        self.assertEqual(
            json.loads(completed.stderr),
            {
                "error": {
                    "code": "room_not_found",
                    "message": "room does not exist",
                    "status_code": 404,
                }
            },
        )

    def test_url_override_suppresses_saved_token_unless_env_token_is_explicit(self) -> None:
        _, session_path = self.register()
        same_origin = self.room_cli("list", "--url", self.server.url)
        self.assertEqual(same_origin.returncode, 0, same_origin.stderr)
        observed_authorization: list[str | None] = []
        other_app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)

        @other_app.get("/v1/rooms")
        def list_rooms(request: Request):
            observed_authorization.append(request.headers.get("authorization"))
            return {"rooms": []}

        with LiveServer(other_app) as other:
            overridden = self.room_cli("list", "--url", other.url)
            self.assertEqual(overridden.returncode, 0, overridden.stderr)
            explicit = self.room_cli(
                "list",
                "--url",
                other.url,
                extra_environment={"SHAREDNET_RUNTIME_TOKEN": "explicit-token"},
            )
            self.assertEqual(explicit.returncode, 0, explicit.stderr)

        self.assertEqual(observed_authorization, [None, "Bearer explicit-token"])
        self.assertEqual(RoomSessionFile(session_path).load().base_url, self.server.url)

    def test_token_argument_is_rejected_without_echoing_secret(self) -> None:
        secret = "argv-secret-must-not-leak"
        completed = self.room_cli("list", "--token", secret)

        self.assertEqual(completed.returncode, 2)
        self.assertNotIn(secret, completed.stdout)
        self.assertNotIn(secret, completed.stderr)
        self.assertIn("SHAREDNET_RUNTIME_TOKEN", completed.stderr)

    def test_non_loopback_serve_requires_explicit_unsafe_override(self) -> None:
        completed = self.room_cli("serve", "--host", "0.0.0.0")

        self.assertEqual(completed.returncode, 2)
        self.assertEqual(completed.stdout, "")
        self.assertEqual(
            json.loads(completed.stderr)["error"]["code"],
            "remote_without_tls",
        )

    def test_coord_and_nonserve_room_commands_do_not_import_fastapi_or_uvicorn(self) -> None:
        _, session_path = self.register()
        blocker = self.root / "import-blocker"
        blocker.mkdir()
        (blocker / "sitecustomize.py").write_text(
            """
import builtins
_real_import = builtins.__import__
def _blocked(name, *args, **kwargs):
    if name == 'fastapi' or name.startswith('fastapi.') or name == 'uvicorn' or name.startswith('uvicorn.'):
        raise ImportError(f'blocked optional server dependency: {name}')
    return _real_import(name, *args, **kwargs)
builtins.__import__ = _blocked
""".strip(),
            encoding="utf-8",
        )
        environment = {"PYTHONPATH": str(blocker)}

        coordination = run_cli(
            "coord",
            "list",
            cwd=self.root,
            extra_environment=environment,
        )
        room = self.room_cli(
            "list",
            "--session",
            str(session_path),
            extra_environment=environment,
        )

        self.assertEqual(coordination.returncode, 0, coordination.stderr)
        self.assertEqual(room.returncode, 0, room.stderr)


class RoomCliParserTests(unittest.TestCase):
    def test_namespace_dispatch_does_not_confuse_same_named_commands(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            completed = run_cli("room", "list", cwd=root)
        self.assertEqual(completed.returncode, 2)
        self.assertEqual(json.loads(completed.stderr)["error"]["code"], "missing_runtime_token")


if __name__ == "__main__":
    unittest.main()
