# Multitasking Stage 2 — bounded parallelism worklog

Date: 2026-07-27

## Result

Stage 2 adds one reserved foreground worker and one independent main-lane background worker.
Realtime Talk consults snapshot-fork the originating session into a fresh worker session, so an
accepted background job can run beside interactive voice work without contending on the same
session lane.

Admission is bounded again at the provider boundary: each normalized provider has a two-call
semaphore, and non-foreground work can consume only one of those calls. The second provider slot is
therefore always available to foreground work. This does not create extra model calls, retries, or
metered API traffic.

The existing cron, subagent, and nested command lanes retain their configured command-lane
ceilings. Only main-lane background work moves to the new capacity-one `agent-background` lane.
Effective same-provider execution can be lower: all non-foreground lanes deliberately share one
provider-attempt slot so one second slot stays reserved for foreground work. All lanes also share
the load/voice circuit breakers, priority queue, and resource serialization.

## Admission and priority design

- Priorities are `foreground > background > cron`, FIFO within a priority.
- Main-lane foreground work has one reserved scheduler slot.
- Main-lane background work has one scheduler slot and one dedicated command lane.
- Existing cron/subagent/nested lanes keep their existing concurrency owners; those configuration
  values remain fan-out ceilings rather than guarantees of simultaneous same-provider execution.
- Provider keys are normalized independently. Legacy `openai-codex` input shares the canonical
  `openai` semaphore.
- Each provider permits at most two active model attempts. Background and cron attempts jointly use
  at most one, reserving one provider slot for foreground.
- Provider admission deliberately wraps the complete harness attempt, including tool time. This
  conservative subscription policy prevents background fan-out from occupying the foreground
  provider reserve; it does mean long-running tools hold the one non-foreground provider slot.
- Queued callers receive a closed queue-reason code and truthful detail:
  `worker_slot_full`, `provider_saturated`, `load_guard`, `voice_unhealthy`, or `resource_busy`.
  Durable Talk task progress records each reason and clears it when admitted.
- Queue callbacks are observability only. They cannot admit, cancel, or terminalize a run.

## Durable-before-concurrent-mutation guard

Worker admission owns a resource scope for the complete run. Conflicting scopes never overlap,
including work admitted through existing cron/subagent/nested lanes.

Known side-effect families derive stable, hashed keys from the request and delivery metadata:

- memory page or file;
- food-log date;
- message recipient or thread;
- smart-home entity.

Purchases are always exclusive before Stage 3. Any mutation whose resource cannot be determined is
also exclusive. Clearly read-only requests receive an empty non-conflicting key set. The queue
reserves conflicting resources for earlier priority/FIFO entries, so same-resource jobs run
sequentially. The guard covers the whole model/tool run, preventing two concurrent runs from
issuing the same external side effect. Stage 2 does not add retries, dual writes, or duplicate
delivery.

This is deliberately conservative and process-local. Stage 3 still owns durable resource locks and
the external-effect ledger.

## Load and voice circuit breakers

- Gateway startup connects admission to the existing Node event-loop health monitor. That monitor
  samples `monitorEventLoopDelay`, event-loop utilization, and CPU pressure.
- A degraded event-loop snapshot pauses background and cron admission. Foreground remains
  admissible.
- Realtime browser and gateway-relay voice paths publish expiring health records. An active,
  unhealthy voice source pauses background and cron admission.
- Load and voice trips hold their circuits open for 2 seconds and retry health-blocked work every
  250 milliseconds. Health recovery also wakes the scheduler immediately.
- Browser expiry values accept relative seconds, epoch seconds, or epoch milliseconds through the
  shared normalization contract.

## Session and client safety

- A realtime Talk consult executes in `agent:<agentId>:talk-job:<uuid>`, not the originating main
  session.
- Before admission, the worker session snapshot-forks the originating transcript. A failed fork
  fails closed; a missing parent proceeds as a deliberately isolated worker.
- The durable task remains owned by the originating session and records the worker as its child.
- `talk.client.toolCall` returns the worker session key additively. Browser and iOS clients use it
  for result filtering, history fallback, and explicit `chat.abort`.
- Client-owned Talk RPCs now require an active browser-session record tied to the same gateway
  connection and OpenClaw session. Prefetched sessions bind once to their first concrete session
  key, never transfer between connections, and expire after 30 idle minutes.
- Durable job status/cancel can outlive the chat run, but it must pass both browser connection
  ownership and durable task owner-key authorization.
- Configured host executables remain gateway-relay-owned. The externally callable
  `talk.client.toolCall` RPC cannot invoke them directly.

Interactive wait expiry remains separate from run lifetime. It does not call `chat.abort`, and no
model output has authority over task/run terminal state.

## Per-file Stage 2 changes

- `src/agents/agent-run-admission.ts` — canonical worker/resource scheduler, provider semaphores,
  priorities, queue reasons, load/voice circuits, and conservative resource-key derivation.
- `src/agents/agent-run-admission.test.ts` — independent concurrency, same-resource serialization,
  foreground reservation, load and voice shedding, cron priority, resource derivation, provider
  reservation, and preservation of existing bounded lanes.
- `src/agents/embedded-agent-runner/run.ts` — holds worker/resource admission around the run, routes
  main-lane background work to `agent-background`, and holds provider admission around each complete
  harness attempt.
- `src/agents/embedded-agent-runner/run/params.ts` — narrow explicit admission override for callers
  that already own durable job metadata.
- `src/process/lanes.ts` — names the dedicated background command lane.
- `src/gateway/server-lanes.ts` and `src/gateway/server-lanes.test.ts` — configure one background
  command worker and prove it can run beside a capacity-one foreground lane while serializing a
  second background task.
- `src/gateway/server.impl.ts` — wires admission to the existing event-loop monitor and realtime
  voice-health snapshot.
- `src/talk/voice-health.ts` and `src/talk/voice-health.test.ts` — process-wide expiring voice
  health aggregation and scheduler wakeups.
- `src/gateway/talk-realtime-relay.ts` and `src/gateway/talk-realtime-relay.test.ts` — publish relay
  ready/error/close health without changing relay tool or channel behavior.
- `src/gateway/talk-client-session-registry.ts` and
  `src/gateway/talk-client-session-registry.test.ts` — bind client-owned Talk sessions to their
  gateway connection and session key, including prefetched-session binding and idle expiry.
- `src/gateway/server-methods/talk-client.ts` — publishes browser voice health, enforces
  connection/session ownership, returns the worker session key, forwards job control safely, and
  keeps configured executables off the client-owned RPC.
- `src/gateway/talk-agent-consult.ts` — snapshot-forks a fresh worker session, persists the queued
  state before `chat.send`, registers background/resource admission, records queue reasons, and
  keeps cancellation/finalization on the exact worker run.
- `src/gateway/server-methods/talk.test.ts` — proves worker-session routing, transcript forking,
  durable queue progress, exact cancellation, browser connection ownership, and the direct
  executable rejection.
- `src/talk/agent-consult-runtime.ts` and `src/talk/agent-consult-runtime.test.ts` — explicitly mark
  detached consults as background, derive their resource scope, and persist admission state without
  coupling interactive wait expiry to cancellation.
- `src/cron/service/ops.ts` — demotes manually queued cron service work to background command-queue
  priority; embedded cron attempts also resolve to the scheduler's lowest `cron` priority.
- `packages/gateway-protocol/src/schema/channels.ts` and
  `packages/gateway-protocol/src/index.test.ts` — add the optional worker `sessionKey` to the Talk
  tool-call result and validate the additive contract.
- `ui/src/pages/chat/realtime-talk-shared.ts` and
  `ui/src/pages/chat/realtime-talk-consult.test.ts` — use the returned worker session for explicit
  cancellation while continuing to correlate streamed results by run id.
- `apps/ios/Sources/Voice/TalkRealtimeClientSession.swift` and
  `apps/ios/Sources/Voice/TalkRealtimeWebRTCSession.swift` — decode and retain the worker session,
  then use it for chat events, history fallback, and explicit abort.
- `docs/gateway/protocol.md` and `docs/nodes/talk.md` — document worker-session result/history/cancel
  behavior.

The production LOC increase is intentional: one canonical admission scheduler replaces scattered
concurrency decisions, and the small health and browser-session registries each own a distinct
process-lifecycle invariant. No compatibility fallback or parallel runtime path was added.

## Dependency contract audit

The required sibling Codex source was cloned and inspected at
`fbe65995bbcd4da249cfdafe0300ac3cb2cb3b3c`.

- `../codex/codex-rs/app-server-protocol/src/protocol/common.rs:491` — `thread/start` is not globally
  serialized.
- `../codex/codex-rs/app-server-protocol/src/protocol/common.rs:831` — `turn/start`, steer, and
  interrupt serialize by thread id.
- `../codex/codex-rs/app-server/src/request_serialization.rs:164` — same-key requests enter one
  ordered queue.
- `../codex/codex-rs/app-server/src/request_serialization.rs:299` — different keys are explicitly
  tested to run concurrently.

That contract supports Stage 2's fresh worker sessions while preserving same-session
serialization.

## Proof

Final focused test command:

```text
node scripts/run-vitest.mjs src/agents/agent-run-admission.test.ts src/talk/voice-health.test.ts src/talk/agent-consult-runtime.test.ts src/gateway/talk-client-session-registry.test.ts src/gateway/server-lanes.test.ts src/gateway/server-methods/talk.test.ts src/gateway/talk-realtime-relay.test.ts src/cron/service/ops.regression.test.ts packages/gateway-protocol/src/index.test.ts ui/src/pages/chat/realtime-talk-consult.test.ts
```

Result: 6 Vitest shards passed, 17 test-file executions passed, 349 tests passed, 24.65 seconds.

The required behaviors are covered directly:

- two independent foreground/background jobs overlap;
- two same-resource jobs serialize;
- background saturation cannot consume the foreground worker or provider slot;
- simulated event-loop lag sheds background admission;
- unhealthy active voice sheds background admission;
- foreground priority runs before queued cron work;
- the background command lane remains independent when foreground concurrency is one.

Exact requested typecheck:

```text
pnpm tsgo --noEmit -p tsconfig.json
```

Result: the command exits 1 only on the inherited errors already present before Stage 2:

- `extensions/memory-core/src/dreaming.test.ts:2630`;
- `src/agents/embedded-agent-runner/run/assistant-failover.test.ts`;
- `src/agents/model-selection-manifest-workspace.test.ts:482`;
- the pre-existing mock typing at `src/gateway/talk-realtime-relay.test.ts:261` (the line is blamed to
  commit `396fa46b22b3`, predating this stage).

No Stage 2 production file or new Stage 2 test file appears in the typecheck errors.

Additional checks:

- `git diff --check` — clean.
- `pnpm exec oxfmt --check <26 touched Stage 2 TypeScript/docs files>` — clean.
- Fresh structured `autoreview --mode local` — clean, no accepted/actionable findings; overall
  `patch is correct` with confidence 0.78.
- Blacksmith Testbox pre-warm was attempted first, but the installed Crabbox binary failed its
  `--version`/`--help` sanity check before allocation. The user-required local
  `scripts/run-vitest.mjs` proof was run instead.

## Not performed

- Per instruction, the live gateway was not built or restarted.
- The Swift client changes were source-reviewed but not compiled because the task prohibited a
  build.
- The repo-wide typecheck is not globally green because of the inherited test-only errors listed
  above; Stage 2 adds none.

OUTCOME: DONE
