# Multitasking Stage 4 — Controlled Subagents

Date: 2026-07-27

## Outcome

Stage 4 adds governed child-task execution on top of the Stage 2 admission controller and Stage 3 mutation coordinator. Child runs now have atomic fan-out admission, durable scheduler identity, strict parent capability bounds, runtime-owned deliverable validation, exact parent-run cancellation propagation, and visible failure aggregation.

No gateway build or restart was performed.

## Design

### Scheduler-mediated child tasks

- `sessions_spawn` creates a durable queued `subagent` task before dispatching the child agent run.
- The child idempotency key receives a Stage 2 admission override with:
  - `priority: "background"`;
  - the queued task's stable `taskId` as the Stage 3 `jobId`;
  - the same resource-scope derivation used by other admitted jobs.
- The dispatched run still uses the canonical `subagent` lane, which resolves through the shared background worker and provider semaphores. It does not receive a private lane or provider budget.
- Registration starts the pre-created task instead of creating a second task record. The stable task-run identity survives gateway attempt-ID changes.
- Steer/restart attempts look up the existing detached task and bind the replacement idempotency key to the same durable `jobId`, preserving Stage 3 effect-ledger ownership across attempts.

### Max fan-out and max depth

- Existing configured depth validation remains the hard nesting gate and returns the current and maximum depth in its rejection.
- Fan-out now uses a synchronous per-requester reservation immediately before child dispatch.
- The gate counts active registered children plus in-flight reservations, closing the prior check/dispatch/register race.
- The N+1th concurrent spawn returns a deterministic `forbidden` result with the current and maximum child counts.
- Reservations release idempotently on dispatch failure, registration failure, or successful registration.

### Child capability subsets

- Every child receives the parent's final effective tool surface as its inherited allowlist, including parents governed only by deny policies.
- The inherited allowlist is an upper bound; target-agent configuration cannot restore a tool absent from the parent.
- Existing inherited deny policy and ACP compatibility checks remain in force.

### Independent deliverable validation

- Terminal ownership remains in the runtime. A child model cannot declare its own job status.
- The existing runtime completion contract validates captured child output before projecting task completion.
- Empty or progress-only completion text is projected as a blocked terminal outcome rather than accepted as a final deliverable.
- Error and timeout outcomes are projected from runtime evidence as failed or timed-out tasks.

### Parent aggregation, failure visibility, and cancellation

- Registry records persist the exact `parentRunId` in addition to session ownership.
- Aborted, cancelled, restarted, or timed-out parent lifecycle events trigger child cancellation by exact parent attempt.
- Exact run matching prevents an old parent attempt from killing children created by a newer run in the same long-lived session.
- Each direct child cancellation uses the existing admin kill path, which cascades through that child's descendants and finalizes runtime task state.
- `sessions_yield` remains a pause boundary: lifecycle events marked `yielded` never cancel children.
- Existing ordered child findings remain the aggregation surface. Failed children remain visible even when their completion text would otherwise suppress announcement.

## Per-file changes

### Runtime

- `src/agents/agent-tools.ts`
  - Always captures the final effective parent tool surface as the child allowlist upper bound.
- `src/agents/openclaw-tools.ts`
  - Threads the current agent `runId` into the spawn tool as the exact parent owner.
- `src/agents/tools/sessions-spawn-tool.ts`
  - Passes parent-run identity into native subagent and ACP registry records.
- `src/agents/subagent-spawn.ts`
  - Adds atomic child reservations, durable queued child task creation, Stage 2 admission overrides, stable Stage 3 job identity, and failure finalization.
- `src/agents/subagent-spawn.runtime.ts`
  - Exposes the narrow admission and detached-task runtime seams used by spawn and its tests.
- `src/agents/subagent-registry.types.ts`
  - Adds persisted `parentRunId`.
- `src/agents/subagent-registry-run-manager.ts`
  - Accepts stable `taskRunId` and `parentRunId`; starts a pre-created queued task instead of duplicating it.
- `src/agents/subagent-registry.ts`
  - Propagates abort/timeout lifecycle events to exact parent-owned children while preserving interactive yield behavior.
- `src/agents/subagent-control.ts`
  - Adds exact-parent cancellation with descendant cascade and preserves the stable Stage 3 job ID across steer/restart attempts.

### Stage 4 tests and test seams

- `src/agents/subagent-spawn.depth-limits.test.ts`
  - Proves depth rejection, atomic N+1 fan-out rejection, and shared admission override identity.
- `src/agents/subagent-spawn.test-helpers.ts`
  - Adds deterministic queued-task and admission test seams.
- `src/agents/agent-tools.create-openclaw-coding-tools.test.ts`
  - Proves a deny-only parent cannot grant denied tools to a child.
- `src/agents/agent-run-admission.test.ts`
  - Proves the `subagent` lane resolves to shared background admission.
- `src/agents/subagent-registry-completion.test.ts`
  - Proves runtime rejection of progress-only deliverables and failed child task projection.
- `src/agents/subagent-registry.test.ts`
  - Proves parent timeout/cancel propagation and the interactive-yield exception.
- `src/agents/subagent-control.test.ts`
  - Proves exact-parent cancellation does not terminate children owned by a newer parent run.

### Accumulated Stage 1–3 typecheck repairs

The required repository-wide `tsgo` proof exposed stale test-double typings in earlier accumulated work. These changes are type-only test maintenance; they do not alter runtime behavior.

- `extensions/memory-core/src/dreaming.test.ts`
  - Completes the subagent mock contract and narrows the wait status literal.
- `src/agents/embedded-agent-runner/run/assistant-failover.test.ts`
  - Updates successful profile-advance mocks to the current closed return code.
- `src/agents/model-selection-manifest-workspace.test.ts`
  - Types the provider-normalization mock from the runtime function contract.
- `src/gateway/talk-realtime-relay.test.ts`
  - Types the gateway tool runner from the relay-session constructor contract.

## Proof

All commands ran from `/Users/clawdmac/src/openclaw-live`.

### Required typecheck

Command:

```text
pnpm tsgo --noEmit -p tsconfig.json
```

Final output:

```text
$ pnpm tsgo:core --noEmit -p tsconfig.json
$ node scripts/run-tsgo.mjs -p tsconfig.core.json --incremental --tsBuildInfoFile .artifacts/tsgo-cache/core.tsbuildinfo --noEmit -p tsconfig.json
```

Exit code: 0.

### Targeted Stage 4 tests

```text
node scripts/run-vitest.mjs src/agents/subagent-spawn.depth-limits.test.ts
Test Files  1 passed (1)
Tests       8 passed (8)

node scripts/run-vitest.mjs src/agents/agent-tools.create-openclaw-coding-tools.test.ts
Test Files  1 passed (1)
Tests       70 passed (70)

node scripts/run-vitest.mjs src/agents/agent-run-admission.test.ts
Test Files  1 passed (1)
Tests       11 passed (11)

node scripts/run-vitest.mjs src/agents/subagent-registry-completion.test.ts
Test Files  1 passed (1)
Tests       10 passed (10)

node scripts/run-vitest.mjs src/agents/subagent-registry.test.ts
Test Files  1 passed (1)
Tests       98 passed (98)

node scripts/run-vitest.mjs src/agents/subagent-control.test.ts
Test Files  1 passed (1)
Tests       35 passed (35)

node scripts/run-vitest.mjs src/agents/subagent-announce-output.test.ts
Test Files  1 passed (1)
Tests       19 passed (19)
```

### Accumulated-worktree regression tests

```text
node scripts/run-vitest.mjs extensions/memory-core/src/dreaming.test.ts
Test Files  1 passed (1)
Tests       53 passed (53)

node scripts/run-vitest.mjs src/agents/embedded-agent-runner/run/assistant-failover.test.ts
Test Files  1 passed (1)
Tests       26 passed (26)

node scripts/run-vitest.mjs src/agents/model-selection-manifest-workspace.test.ts
Test Files  1 passed (1)
Tests       18 passed (18)

node scripts/run-vitest.mjs src/gateway/talk-realtime-relay.test.ts
Test Files  4 passed (4)
Tests       132 passed (132)
```

### Formatting and review

```text
git diff --check
```

Exit code: 0.

Structured autoreview:

```text
autoreview clean: no accepted/actionable findings reported
overall: patch is correct (0.76)
```

No build or gateway restart was run, as requested.

OUTCOME: DONE
