# Third-party notices

SharedNet adapts small coordination concepts from the two MIT-licensed repositories below. No repository internals, evaluation fixtures, or provider clients are vendored.

## network-of-agents

- Repository: https://github.com/Aicoo-Team/network-of-agents
- Inspected immutable commit: `d73cdb92e49f900acfd891e99baefaf5d3f06d8b`
- Copied/adapted material: no source files were copied. SharedNet adapts the capability/trust discovery, verify-before-credit, attributable failure exclusion, and bounded rerouting concepts from upstream `src/discovery.py`, `src/trust.py`, `src/network.py`, and `src/agent.py` in `src/sharednet/coordination/backends/`, `src/sharednet/coordination/service.py`, and the public request/plan contracts.

Copyright (c) 2026 Xisen Wang

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## runtime-agent-coordination

- Repository: https://github.com/Aicoo-Team/runtime-agent-coordination
- Inspected immutable commit: `1ecab6b5471f82337cbd574d61d606606a56737a`
- Copied/adapted material: `src/sharednet/coordination/primitives.py` adapts the concepts and behavior of upstream `utils/guards/budget.py`, `utils/guards/attenuation.py`, and `utils/forum.py` (per-child budget reservations, contract attenuation, and append-only attributable forum records). `src/sharednet/coordination/backends/`, `src/sharednet/coordination/service.py`, and `src/sharednet/runtime/codex.py` adapt the narrow mechanism boundary, admission-before-ranking, RGE topology, verification-backed experience, retry ordering, and Codex JSONL runtime seam from upstream `baselines/algorithms/rac.py`, `baselines/algorithms/rge.py`, and `utils/runtime/codex.py`. Files were adapted into SharedNet-owned contracts rather than copied verbatim.

Copyright (c) 2026 Xisen Wang

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
