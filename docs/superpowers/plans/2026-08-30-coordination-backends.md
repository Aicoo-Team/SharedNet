# SharedNet Coordination Backends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build four RAC-derived coordination backends behind one Python interface and prove a four-participant plan through the real local Codex multi-agent runtime.

**Architecture:** Pure Python backends convert an immutable admitted Candidate Snapshot into an inspectable `CoordinationPlan`. `CoordinationService` executes and boundedly replans through a replaceable runtime; `CodexRuntime` is a read-only, ephemeral subprocess adapter that parses Codex JSONL evidence. Selected RAC primitives are vendored with provenance, while evaluation fixtures and provider-specific research code stay out of SharedNet.

**Tech Stack:** Python 3.11+ standard library, `unittest`, local Codex CLI JSONL protocol

**Spec:** `docs/superpowers/specs/2026-08-30-coordination-backends-design.md`

## Global Constraints

- SharedNet owns the request, immutable Candidate Snapshot, retry loop, and trace; a backend never mutates durable product state.
- Canonical mechanisms are ordered `discovery-and-use`, `rac-rge`, `rac-adaptive`, `peer-forum`; `rac-adpt` is an alias only.
- Admission happens before scoring and experience never admits a candidate.
- Candidate modes are exactly `SELF`, `RECRUIT`, and `SPAWN`; `ParticipantPlan` copies the selected Candidate Snapshot mode unchanged. `RECRUIT`/`SPAWN` are organization authority, while a native Codex child thread is execution transport and never escalates a participant's mode.
- Every run enforces wall-time, turn, depth, retry, participant, disclosure, and provider-neutral predicted-cost limits. Each runtime invocation conservatively reserves its plan's total predicted cost, even after an attributable failed attempt; replans receive only the request-wide remainder.
- Predicted-cost comparisons use shared exact decimal helpers: exact bounds pass and every positive overage fails without tolerance. A cost-rejected empty eligible set reports `cost_budget_exhausted`, and policy rejection traces preserve the snapshot's `admission_reason`.
- Runtime execution defaults to `read-only`, `approval=never`, `ephemeral`, and no user config.
- Production Codex runs from a fresh empty temporary working directory and accepts only exact root-authored successful spawns, completed waits for the same children, and marker-bound child contributions; disallowed data-only tool activity fails closed.
- Offline tests make no provider calls. The live test is gated by `RUN_CODEX_E2E=1`.
- Borrowed RAC logic retains the upstream MIT notice and source provenance.

---

### Task 1: Package, immutable contracts, and RAC primitives

**Files:**
- Create: `pyproject.toml`
- Create: `src/sharednet/__init__.py`
- Create: `src/sharednet/coordination/__init__.py`
- Create: `src/sharednet/coordination/models.py`
- Create: `src/sharednet/coordination/interface.py`
- Create: `src/sharednet/coordination/primitives.py`
- Create: `tests/__init__.py`
- Create: `tests/test_models.py`
- Create: `tests/test_primitives.py`

**Interfaces:**
- Produces: `CandidateMode`, `TerminalStatus`, `TaskSpec`, `CoordinationBudget`, `Candidate`, `CoordinationRequest`, `ParticipantPlan`, `GraphEdge`, `CoordinationPlan`, `AgentOutput`, `AttemptSummary`, `CoordinationResult`, plus exact predicted-cost helpers `to_decimal`, `sum_costs`, `fits_cost_budget`, and `remaining_cost`.
- Produces: `CoordinationBackend.plan(request, *, excluded=frozenset())` and `CoordinationRuntime.execute(plan)` protocols.
- Produces: `verified_experience`, `candidate_utility`, `LocalBudget`, `BudgetExceeded`, `attenuation_failure`, and `AppendOnlyForum`.

- [ ] **Step 1: Write model tests before production code**

```python
class ModelTests(unittest.TestCase):
    def test_request_rejects_duplicate_candidate_ids(self):
        with self.assertRaisesRegex(ValueError, "duplicate candidate id"):
            CoordinationRequest(
                task=TaskSpec("task-1", "goal", ("analysis",), ("correct",), {}),
                candidates=(candidate("same"), candidate("same")),
                budget=CoordinationBudget(),
                mechanism="rac-rge",
                trace_id="trace-1",
            )

    def test_plan_rejects_dependency_outside_selected_participants(self):
        with self.assertRaisesRegex(ValueError, "unknown dependency"):
            plan_with(ParticipantPlan("self", "root", "work", ("missing",), "best root"))

    def test_request_snapshot_does_not_change_when_source_list_changes(self):
        source = [candidate("self")]
        request = request_with(tuple(source))
        source.append(candidate("late"))
        self.assertEqual([item.candidate_id for item in request.candidates], ["self"])
```

- [ ] **Step 2: Run model tests and verify RED**

Run: `PYTHONPATH=src python3 -m unittest tests.test_models -v`

Expected: import failure for `sharednet.coordination.models`.

- [ ] **Step 3: Implement frozen JSON-safe contracts and protocols**

Use frozen dataclasses and enums. `CoordinationBudget` defaults are `max_wall_seconds=300`, `max_turns=16`, `max_depth=2`, `max_participants=4`, `max_retries=1`, `max_disclosure_bytes=65536`, and `max_cost=1.0`. `max_cost` is a positive finite provider-neutral ceiling on summed selected `predicted_cost`; actual provider tokens remain evidence and are never converted to a price. Copy each selected candidate's nonnegative finite `predicted_cost` to `ParticipantPlan` (default `0` for compatibility) and copy its `mode` unchanged (default `RECRUIT` for compatible construction), expose the plan's total predicted cost, and reject a plan over the ceiling. Validate positive numeric bounds, nonempty IDs/goals/capabilities, unique candidates/participants, participant count, edge endpoints, dependencies, and exact decimal cumulative selected cost. Every public value implements `to_dict()` with stable camel-free snake_case keys.

```python
class CoordinationBackend(Protocol):
    mechanism_id: str
    def plan(
        self,
        request: CoordinationRequest,
        *,
        excluded: frozenset[str] = frozenset(),
    ) -> CoordinationPlan: ...

class CoordinationRuntime(Protocol):
    def execute(self, plan: CoordinationPlan) -> CoordinationResult: ...
```

- [ ] **Step 4: Write primitive tests before primitive code**

```python
class PrimitiveTests(unittest.TestCase):
    def test_unseen_candidate_has_no_experience_bonus(self):
        self.assertEqual(verified_experience(candidate("new", successes=0, failures=0)), 0.0)

    def test_failed_candidate_has_negative_experience(self):
        self.assertLess(verified_experience(candidate("bad", successes=0, failures=3)), 0.0)

    def test_child_budget_cannot_exceed_reserved_parent_remainder(self):
        budget = LocalBudget(cost_limit=5.0)
        budget.reserve("a", 4.0)
        with self.assertRaisesRegex(BudgetExceeded, "insufficient_unreserved_cost"):
            budget.reserve("b", 2.0)

    def test_forum_is_append_only_and_excludes_reader_own_posts(self):
        forum = AppendOnlyForum(max_posts=4, max_note_bytes=40)
        forum.post("a", "alpha")
        forum.post("b", "beta")
        self.assertEqual([post.note for post in forum.read("a")], ["beta"])
        self.assertEqual([post.sequence for post in forum.posts], [0, 1])
```

- [ ] **Step 5: Run primitive tests and verify RED**

Run: `PYTHONPATH=src python3 -m unittest tests.test_primitives -v`

Expected: import failure for `sharednet.coordination.primitives`.

- [ ] **Step 6: Implement RAC-derived primitives**

Implement centered Beta experience as `(successes + 1) / (successes + failures + 2) - 0.5`. Candidate utility is predicted quality plus experience minus cost, latency, risk, and coordination overhead with deterministic ID tie-breaking supplied by callers. Adapt `LocalBudget` and `AppendOnlyForum` from `Aicoo-Team/runtime-agent-coordination` and add source comments naming the upstream files and MIT license. `attenuation_failure(parent, child)` returns a typed reason for wider cost, deadline, disclosure, effects, or depth.

- [ ] **Step 7: Run Task 1 tests and verify GREEN**

Run: `PYTHONPATH=src python3 -m unittest tests.test_models tests.test_primitives -v`

Expected: all tests pass.

### Task 2: Four default backends and registry

**Files:**
- Create: `src/sharednet/coordination/backends/__init__.py`
- Create: `src/sharednet/coordination/backends/common.py`
- Create: `src/sharednet/coordination/backends/discovery_and_use.py`
- Create: `src/sharednet/coordination/backends/rac_rge.py`
- Create: `src/sharednet/coordination/backends/rac_adaptive.py`
- Create: `src/sharednet/coordination/backends/peer_forum.py`
- Create: `src/sharednet/coordination/registry.py`
- Create: `tests/fixtures.py`
- Create: `tests/test_backends.py`
- Create: `tests/test_registry.py`

**Interfaces:**
- Consumes: Task 1 models, `candidate_utility`, `verified_experience`.
- Produces: `DiscoveryAndUseBackend`, `RacRgeBackend`, `RacAdaptiveBackend`, `PeerForumBackend`.
- Produces: `DEFAULT_MECHANISMS`, `MECHANISM_ALIASES`, `list_mechanisms()`, and `get_backend(name)`.

- [ ] **Step 1: Write failing backend behavior tests**

```python
class BackendTests(unittest.TestCase):
    def test_discovery_filters_denied_candidate_before_ranking(self):
        request = four_agent_request(mechanism="discovery-and-use", include_denied_superstar=True)
        plan = DiscoveryAndUseBackend().plan(request)
        self.assertNotIn("denied-superstar", plan.participant_ids)
        self.assertEqual(plan.participant_ids, ("self", "generalist"))

    def test_rge_builds_four_node_graph_for_complementary_capabilities(self):
        plan = RacRgeBackend().plan(four_agent_request(mechanism="rac-rge"))
        self.assertEqual(len(plan.participants), 4)
        self.assertEqual(len(plan.edges), 3)
        self.assertEqual(set(plan.covered_capabilities), {"research", "architecture", "risk", "synthesis"})

    def test_adaptive_keeps_short_linear_task_with_self(self):
        plan = RacAdaptiveBackend().plan(linear_request())
        self.assertEqual(plan.participant_ids, ("self",))
        self.assertIn("no_positive_marginal_utility", plan.stop_reason)

    def test_adaptive_excludes_failed_candidate_on_replan(self):
        request = specialist_request()
        plan = RacAdaptiveBackend().plan(request, excluded=frozenset({"specialist-a"}))
        self.assertIn("specialist-b", plan.participant_ids)
        self.assertNotIn("specialist-a", plan.participant_ids)

    def test_peer_forum_selects_complementary_peers_and_integrator(self):
        plan = PeerForumBackend().plan(four_agent_request(mechanism="peer-forum"))
        self.assertEqual(len(plan.participants), 4)
        self.assertEqual(plan.runtime_instructions["coordination"], "append-only-forum")
        self.assertEqual(plan.participants[-1].role, "integrator")
```

- [ ] **Step 2: Run backend tests and verify RED**

Run: `PYTHONPATH=src python3 -m unittest tests.test_backends -v`

Expected: imports for backend modules fail.

- [ ] **Step 3: Implement shared selection helpers and the four planners**

`eligible_candidates()` removes non-admitted, individually unaffordable, and attempt-excluded candidates before any score is computed. Its trace retains the actual policy `admission_reason`, and cost-caused emptiness reports `cost_budget_exhausted`. `discovery-and-use` chooses the best complete-coverage specialist. `rac-rge` rejects roots without positive required-capability contribution, then greedily expands uncovered capabilities and assigns each new node to the selected node with greatest overlap, subject to depth and participant limits. `rac-adaptive` adds only candidates whose utility minus `0.10` coordination overhead is positive and reports `coverage_complete` before a participant cap when `SELF` already covers the task. `peer-forum` greedily maximizes complementary coverage and places the designated admitted `SELF` integrator at participant zero, or the best selected generalist if no `SELF` candidate is admitted; peers follow and contribute through peer-to-integrator edges.

Every plan trace includes `candidate_considered`, `candidate_rejected`, `candidate_selected`, `edge_added`, and `planning_stopped` records as applicable. An empty admitted set returns a plan with `terminal_status="abstained"`, no participants, and an explicit reason rather than raising.

- [ ] **Step 4: Write failing registry tests**

```python
class RegistryTests(unittest.TestCase):
    def test_default_mechanisms_are_stable_and_ordered(self):
        self.assertEqual(
            [item["id"] for item in list_mechanisms()],
            ["discovery-and-use", "rac-rge", "rac-adaptive", "peer-forum"],
        )

    def test_adpt_alias_resolves_to_canonical_adaptive_backend(self):
        self.assertEqual(get_backend("rac-adpt").mechanism_id, "rac-adaptive")

    def test_unknown_mechanism_is_explicit(self):
        with self.assertRaisesRegex(UnknownMechanism, "unknown coordination mechanism"):
            get_backend("mystery")
```

- [ ] **Step 5: Run registry tests and verify RED**

Run: `PYTHONPATH=src python3 -m unittest tests.test_registry -v`

Expected: import failure for `sharednet.coordination.registry`.

- [ ] **Step 6: Implement registry and run Task 2 tests GREEN**

Run: `PYTHONPATH=src python3 -m unittest tests.test_backends tests.test_registry -v`

Expected: all tests pass.

### Task 3: Bounded execution service and recovery

**Files:**
- Create: `src/sharednet/coordination/service.py`
- Create: `tests/test_service.py`

**Interfaces:**
- Consumes: `get_backend`, `CoordinationRuntime`, request/plan/result models.
- Produces: `CoordinationService.plan(request)` and `CoordinationService.execute(request, runtime)`.

- [ ] **Step 1: Write failing service tests**

```python
class ServiceTests(unittest.TestCase):
    def test_execute_returns_first_accepted_attempt(self):
        runtime = ScriptedRuntime([accepted_result()])
        result = CoordinationService().execute(four_agent_request(), runtime)
        self.assertEqual(result.status, TerminalStatus.ACCEPTED)
        self.assertEqual(runtime.calls, 1)

    def test_execute_replans_after_attributable_failure(self):
        runtime = ScriptedRuntime([
            failed_result(("risk-agent",)),
            accepted_result(),
        ])
        result = CoordinationService().execute(adaptive_request(max_retries=1), runtime)
        self.assertEqual(result.status, TerminalStatus.ACCEPTED)
        self.assertEqual(runtime.calls, 2)
        self.assertNotIn("risk-agent", runtime.plans[1].participant_ids)
        self.assertEqual(len(result.attempts), 2)

    def test_execute_stops_when_retry_budget_is_exhausted(self):
        runtime = ScriptedRuntime([failed_result(("a",)), failed_result(("b",))])
        result = CoordinationService().execute(adaptive_request(max_retries=1), runtime)
        self.assertEqual(result.status, TerminalStatus.EXHAUSTED)
        self.assertEqual(runtime.calls, 2)
```

- [ ] **Step 2: Run service tests and verify RED**

Run: `PYTHONPATH=src python3 -m unittest tests.test_service -v`

Expected: import failure for `sharednet.coordination.service`.

- [ ] **Step 3: Implement bounded service loop**

The service resolves the requested backend once, plans with an immutable `excluded` set, executes at most `max_retries + 1` attempts, aggregates usage numerically, records one `AttemptSummary` per call, and excludes only IDs the runtime attributes as failed. Every runtime call conservatively reserves that plan's `total_predicted_cost`; retries receive the remaining request-wide `max_cost`, and no remaining cost returns `status=EXHAUSTED` with `error="cost_budget_exhausted"`. If a replan abstains for that same cost reason, the service returns the prior completed plan, attempt evidence, and usage as `EXHAUSTED` instead of discarding it; an initial abstention remains `ABSTAINED`. A non-accepted result without attributable failures returns immediately; it is not retried blindly. Other retry exhaustion returns the last evidence with `status=EXHAUSTED` and `error="retry_budget_exhausted"`.

- [ ] **Step 4: Run service tests and verify GREEN**

Run: `PYTHONPATH=src python3 -m unittest tests.test_service -v`

Expected: all tests pass.

### Task 4: Codex JSONL runtime adapter

**Files:**
- Create: `src/sharednet/runtime/__init__.py`
- Create: `src/sharednet/runtime/codex.py`
- Create: `tests/test_codex_runtime.py`

**Interfaces:**
- Consumes: `CoordinationPlan`, `CoordinationResult`, `AgentOutput`.
- Produces: `CodexRuntime`, `ProcessOutcome`, `CodexUnavailable`, `parse_codex_events`, and `build_codex_prompt`.

- [ ] **Step 1: Write failing command and parser tests**

```python
class CodexRuntimeTests(unittest.TestCase):
    def test_command_places_global_safety_flags_before_exec(self):
        runner = RecordingRunner(success_jsonl(markers_for("nonce-1")))
        CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())
        self.assertEqual(runner.command[:7], [
            "/real/codex", "--enable", "multi_agent", "-a", "never", "-s", "read-only",
        ])
        self.assertEqual(runner.command[7], "exec")
        self.assertIn("--ephemeral", runner.command)
        self.assertIn("--ignore-user-config", runner.command)

    def test_parser_collects_thread_usage_final_message_and_subagents(self):
        evidence = parse_codex_events(success_jsonl(markers_for("nonce-1")))
        self.assertEqual(evidence.thread_id, "thread-root")
        self.assertEqual(evidence.spawned_agent_ids, ("child-1", "child-2", "child-3"))
        self.assertEqual(evidence.usage["input_tokens"], 100)
        self.assertIn("nonce-1", evidence.final_message)

    def test_missing_participant_marker_fails_closed(self):
        runner = RecordingRunner(success_jsonl(markers_for("nonce-1")[:-1]))
        result = CodexRuntime(binary="/real/codex", runner=runner, nonce_factory=lambda: "nonce-1").execute(plan())
        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "missing_participant_markers")

    def test_nonzero_exit_preserves_stderr_and_usage(self):
        runner = RecordingRunner(ProcessOutcome(7, usage_only_jsonl(), "provider unavailable", False))
        result = CodexRuntime(binary="/real/codex", runner=runner).execute(plan())
        self.assertEqual(result.status, TerminalStatus.FAILED)
        self.assertEqual(result.error, "codex_exec_nonzero_exit")
        self.assertIn("provider unavailable", result.runtime_evidence["stderr"])
```

- [ ] **Step 2: Run runtime tests and verify RED**

Run: `PYTHONPATH=src python3 -m unittest tests.test_codex_runtime -v`

Expected: import failure for `sharednet.runtime.codex`.

- [ ] **Step 3: Implement the safe process adapter**

Resolve the binary from constructor, `SHAREDNET_CODEX_BINARY`, the ChatGPT app bundle, then `shutil.which("codex")`; run `--version` only in `availability()`, not before every task. `_default_runner` uses `subprocess.Popen`, `communicate(timeout=...)`, `terminate()`, a 10-second grace, then `kill()`. Parse stdout line-by-line and ignore only non-JSON diagnostic lines. Preserve raw event count, collaboration event records, spawned agent thread IDs, root thread ID, final agent message, usage, exit code, and the last 4,000 stderr characters.

The prompt embeds JSON for the plan and exact markers. For `N` participants, it tells the root to represent participant zero, issue exactly `N-1` parallel `spawn_agent` calls, wait for every child, and return a JSON object containing all markers and contributions. Production launches in a fresh empty temporary working directory. Acceptance requires exactly `N-1` successful root-authored spawn events, completed root-authored waits covering those same children, and marker-bound child contributions. It forbids file/shell/web tools for the data-only smoke, and any such disallowed tool evidence fails closed.

- [ ] **Step 4: Run runtime tests and verify GREEN**

Run: `PYTHONPATH=src python3 -m unittest tests.test_codex_runtime -v`

Expected: all tests pass.

### Task 5: CLI, example request, attribution, and offline integration

**Files:**
- Create: `src/sharednet/cli.py`
- Create: `examples/four-agent-task.json`
- Create: `tests/test_cli.py`
- Create: `THIRD_PARTY_NOTICES.md`
- Modify: `README.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: registry, models, service, Codex runtime.
- Produces: `sharednet coord list|plan|run` console command.

- [ ] **Step 1: Write failing CLI tests**

```python
class CliTests(unittest.TestCase):
    def test_list_outputs_canonical_backends_without_runtime(self):
        completed = run_cli("coord", "list")
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(
            [item["id"] for item in json.loads(completed.stdout)["mechanisms"]],
            ["discovery-and-use", "rac-rge", "rac-adaptive", "peer-forum"],
        )

    def test_plan_example_selects_four_participants_without_codex(self):
        completed = run_cli(
            "coord", "plan", "--mechanism", "rac-rge",
            "--request", "examples/four-agent-task.json",
        )
        payload = json.loads(completed.stdout)
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(len(payload["participants"]), 4)
```

- [ ] **Step 2: Run CLI tests and verify RED**

Run: `PYTHONPATH=src python3 -m unittest tests.test_cli -v`

Expected: import failure for `sharednet.cli` or missing console entry point.

- [ ] **Step 3: Implement CLI and documented example**

`CoordinationRequest.from_dict()` parses the example. `coord list` returns mechanisms and aliases. `coord plan` overrides only the mechanism field and prints the pure plan. `coord run` creates `CodexRuntime(model=args.model)` and prints the result. Caller-contract errors print `{"error": ..., "type": ...}` on stderr and return 2; terminal run failure returns 1.

The example has four admitted candidates (`self`, `research-agent`, `architecture-agent`, `risk-agent`) whose complementary capabilities are `synthesis`, `research`, `architecture`, and `risk`. The mocked task supplies four incident records and asks for a prioritized remediation brief. Budget limits four participants, depth two, one retry, and a fixture-specific 600-second hard wall so the root-plus-three provider proof can tolerate transient transport variability. This does not change the product `CoordinationBudget` default of 300 seconds.

Add `.codex-live-artifacts/`, `__pycache__/`, `*.pyc`, and `.coverage` to `.gitignore`. `THIRD_PARTY_NOTICES.md` includes both upstream repository URLs, immutable inspected commits, MIT copyright, and copied/adapted file names.

- [ ] **Step 4: Run full offline suite and CLI smoke**

Run: `PYTHONPATH=src python3 -m unittest discover -s tests -v`

Run: `PYTHONPATH=src python3 -m sharednet.cli coord plan --mechanism rac-rge --request examples/four-agent-task.json`

Expected: tests pass; CLI returns a four-participant plan without invoking Codex.

- [ ] **Step 5: Run compile and packaging checks**

Run: `python3 -m compileall -q src tests`

Run: `python3 -m pip install --no-deps -e .`

Run: `sharednet coord list`

Expected: every command exits 0.

### Task 6: Real four-agent Codex end-to-end test

**Files:**
- Create: `tests/test_codex_live_e2e.py`
- Create at runtime only: `.codex-live-artifacts/<trace-id>.jsonl`

**Interfaces:**
- Consumes: `examples/four-agent-task.json`, `CoordinationService`, `CodexRuntime`.
- Produces: reproducible opt-in live proof with retained, gitignored evidence.

- [ ] **Step 1: Write the gated live test before running Codex**

```python
@unittest.skipUnless(os.environ.get("RUN_CODEX_E2E") == "1", "real Codex E2E is opt-in")
class CodexLiveE2E(unittest.TestCase):
    def test_rge_executes_one_root_and_three_native_subagents(self):
        request = load_example("rac-rge")
        plan = CoordinationService().plan(request)
        self.assertEqual(len(plan.participants), 4)

        result = CoordinationService().execute(
            request,
            CodexRuntime(model="gpt-5.6-luna", artifact_dir=Path(".codex-live-artifacts")),
        )

        self.assertEqual(result.status, TerminalStatus.ACCEPTED, result.error)
        self.assertEqual(len(result.outputs), 4)
        self.assertEqual(len(result.runtime_evidence["spawned_agent_ids"]), 3)
        self.assertEqual(len(result.runtime_evidence["completed_child_ids"]), 3)
        self.assertEqual(len(result.runtime_evidence["contributing_child_ids"]), 3)
        self.assertTrue(result.runtime_evidence["native_proof_complete"])
        self.assertTrue(result.runtime_evidence["thread_id"])
        self.assertGreater(result.usage["input_tokens"] + result.usage["output_tokens"], 0)
        for output in result.outputs:
            self.assertIn(output.marker, result.synthesis)
```

- [ ] **Step 2: Confirm normal suite skips the live test**

Run: `PYTHONPATH=src python3 -m unittest discover -s tests -v`

Expected: all offline tests pass and exactly one live test is skipped.

- [ ] **Step 3: Run the real local Codex E2E**

Run: `RUN_CODEX_E2E=1 SHAREDNET_CODEX_BINARY=/Applications/ChatGPT.app/Contents/Resources/codex PYTHONPATH=src python3 -m unittest tests.test_codex_live_e2e -v`

Expected: exit 0; `accepted`; four outputs; three native subagent IDs; positive usage; every marker in the synthesis.

- [ ] **Step 4: Inspect retained evidence and close any protocol gap with TDD**

Run: `find .codex-live-artifacts -maxdepth 1 -type f -name '*.jsonl' -print -exec sed -n '1,80p' {} \;`

If the real event names differ from recorded fixtures, add one failing parser test containing the observed minimal event shape, verify RED, update only the parser, and rerun both unit and live tests.

- [ ] **Step 5: Final verification**

Run: `PYTHONPATH=src python3 -m unittest discover -s tests -v`

Run: `python3 -m compileall -q src tests`

Run: `git diff --check`

Run: `RUN_CODEX_E2E=1 SHAREDNET_CODEX_BINARY=/Applications/ChatGPT.app/Contents/Resources/codex PYTHONPATH=src python3 -m unittest tests.test_codex_live_e2e -v`

Expected: all offline tests pass with only the gated live test skipped in the offline run; compile and diff checks exit 0; the fresh live run passes.
