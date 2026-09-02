from __future__ import annotations

from pathlib import Path
import tempfile
from unittest import TestCase

from fastapi import FastAPI, Request

from sharednet.control.client import ControlClient
from tests.room.test_client import LiveServer


class ControlClientTests(TestCase):
    def test_client_uses_exact_credential_scope_for_each_lifecycle(self) -> None:
        observed: list[tuple[str, str | None]] = []
        app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)

        def remember(request: Request) -> None:
            observed.append((request.url.path, request.headers.get("authorization")))

        @app.post("/v1/pairings", status_code=201)
        def pair(request: Request):
            remember(request)
            return {
                "pairing_id": "pairing_demo",
                "pairing_secret": "pairing-secret",
                "verification_url": "http://127.0.0.1:3001/decisions?pairing=pairing_demo",
                "expires_at": "2026-09-03T00:00:00+00:00",
            }

        @app.post("/v1/pairings/{pairing_id}/exchange")
        def exchange(pairing_id: str, request: Request):
            remember(request)
            return {"principal_id": "p_15COsXY9aK", "connector_token": "connector-secret"}

        @app.post("/v1/local/agents", status_code=201)
        def agent(request: Request):
            remember(request)
            return {"principal_id": "p_15COsXY9aK", "agent_id": "a_7Qm2Zx8WpL"}

        @app.post("/v1/local/runtimes", status_code=201)
        def runtime(request: Request):
            remember(request)
            return {
                "principal_id": "p_15COsXY9aK",
                "agent_id": "a_7Qm2Zx8WpL",
                "runtime_id": "r_4Nk8Vm2QaT",
                "runtime_token": "runtime-secret",
            }

        @app.post("/v1/local/instances", status_code=201)
        def instance(request: Request):
            remember(request)
            return {
                "identity": {
                    "principal_id": "p_15COsXY9aK",
                    "agent_id": "a_7Qm2Zx8WpL",
                    "runtime_id": "r_4Nk8Vm2QaT",
                    "instance_id": "i_8pQ2Km7XaN",
                },
                "instance_token": "instance-secret",
            }

        @app.post("/v1/local/instances/current/heartbeat")
        def heartbeat(request: Request):
            remember(request)
            return {"presence": "online"}

        with LiveServer(app) as server:
            client = ControlClient(server.url)
            pairing = client.create_pairing("http://127.0.0.1:3001")
            client.exchange_pairing(pairing["pairing_id"], pairing["pairing_secret"])
            client.create_agent("connector-secret", "Codex", ["rooms"])
            client.register_runtime(
                "connector-secret", "a_7Qm2Zx8WpL", "codex", "/workspace"
            )
            client.start_instance("runtime-secret", "provider-session", 90)
            client.heartbeat_instance("instance-secret", 90)

        self.assertEqual(
            observed,
            [
                ("/v1/pairings", None),
                ("/v1/pairings/pairing_demo/exchange", None),
                ("/v1/local/agents", "Connector connector-secret"),
                ("/v1/local/runtimes", "Connector connector-secret"),
                ("/v1/local/instances", "Runtime runtime-secret"),
                ("/v1/local/instances/current/heartbeat", "Instance instance-secret"),
            ],
        )


if __name__ == "__main__":
    import unittest

    unittest.main()
