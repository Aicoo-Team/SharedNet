"""Run the four-agent WeChat-like refactoring demo with the real local Codex runtime."""

from __future__ import annotations

import json
from pathlib import Path

from sharednet.coordination.models import CoordinationRequest, TerminalStatus
from sharednet.coordination.service import CoordinationService
from sharednet.runtime import CodexRuntime


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
REQUEST_PATH = REPOSITORY_ROOT / "examples" / "wechat-refactor-demo.json"
ARTIFACT_DIR = REPOSITORY_ROOT / ".codex-live-artifacts" / "wechat-refactor-demo"
CODEX_BINARY = "/Applications/ChatGPT.app/Contents/Resources/codex"


request = CoordinationRequest.from_dict(json.loads(REQUEST_PATH.read_text(encoding="utf-8")))
runtime = CodexRuntime(
    binary=CODEX_BINARY,
    model="gpt-5.6-luna",
    artifact_dir=ARTIFACT_DIR,
)
result = CoordinationService().execute(request, runtime)
print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2, sort_keys=True))
raise SystemExit(0 if result.status is TerminalStatus.ACCEPTED else 1)
