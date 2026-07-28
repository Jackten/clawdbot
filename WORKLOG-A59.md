# A59 — Multitasking Stage 1 worklog

Date: 2026-07-26

## Result

A chat or voice caller's interactive wait is now separate from the accepted agent run's lifetime.
When the wait expires, the caller receives a durable running-job receipt and the run continues.
Explicit cancellation and the run's configured timeout still terminate the run.

This is Stage 1 only. The change does not add concurrency, worker pools, subagent fan-out, resource
locks, remote ownership, retries, or additional model calls.

The checkout already contained Jack-authorized BUG-180/realtime voice and image-input work. A59
changes were layered onto that dirty checkout without reverting or rewriting the inherited changes.

## Wait versus abort

- `src/gateway/chat-abort.ts` remains unchanged. Its explicit-abort and configured run-timeout
  behavior is still the authoritative way to terminate a chat run.
- `src/talk/agent-consult-runtime.ts` now uses a brief, independent interactive wait timer
  (2 seconds by default). That timer participates only in a `Promise.race`; it is never merged into
  the run's abort signal.
- The embedded run still receives its own `timeoutMs`, defaulting to the configured agent timeout.
  Session-lifecycle interruption and a specific job cancellation still feed the run's abort signal.
- Browser and iOS chat-backed voice waits no longer call `chat.abort` when their interactive wait
  expires. An explicit signal/Task cancellation still calls `chat.abort`, and terminal configured
  run timeouts remain failures rather than running receipts.
- The existing fast paths are preserved: a consult completing inside the interactive window returns
  its result directly, and a chat-backed consult completing inside the client wait returns the
  existing final chat result.

## Receipt

The structured receipt is:

```json
{
  "text": "That work is still running. I’ll deliver the result when it finishes.",
  "status": "accepted",
  "jobId": "<durable task UUID>",
  "runId": "<runtime correlation id>",
  "title": "<short title derived from the request>",
  "state": "running"
}
```

The task row is persisted before the run is exposed as accepted. If that persistence fails, the
consult fails closed instead of returning a non-durable receipt.

## Delivery and deduplication

- Embedded `openclaw_agent_consult` work is recorded in the existing SQLite-backed task registry.
  Its delivery is initially disarmed so a fast result is returned only once. On interactive wait
  expiry, delivery becomes `pending`; terminal runtime evidence then uses the existing task
  terminal/session delivery path.
- That path already persists delivery state and uses the stable idempotency key
  `task-terminal:<taskId>:<status>:<outcome>`. The persisted delivered/session-queued marker prevents
  duplicate delivery across reconnects and gateway restarts.
- Chat-backed Talk consults keep the existing `chat.send` agent-event/session result path as the
  single publisher. Their task rows are `silent`/`not_applicable`, so the ledger cannot emit a
  second copy.
- Ordinary lifecycle events terminalize chat-backed task rows. A canonical gateway terminal-dedupe
  snapshot is also read when the active chat entry is removed, covering valid no-lifecycle terminal
  paths without guessing from assistant text.
- Success, failure, timeout, and cancellation are finalized from runtime evidence. Failure delivery
  includes the reason and run correlation id. Assistant text never sets terminal state.
- Wait expiry never retries or resends the underlying request, so it introduces no repeated external
  side effect.

## Status and cancellation

- Existing `tasks.list`, `tasks.get`, and `tasks.cancel` gateway methods now include and can cancel
  these consult jobs by durable task id.
- The realtime voice agent-control tool accepts `jobId`. It can report one job, list the active
  consult jobs visible to the originating session, or cancel the exact job.
- Forked voice consult sessions have narrowly scoped access to their own `agent_consult` task. Other
  task kinds and unrelated sessions remain excluded.
- Embedded consult cancellation aborts its dedicated controller. Chat-backed consult cancellation
  calls the existing `chat.abort` handler with the owning connection/session and exact run id.

## Per-file A59 changes

- `apps/ios/Sources/Voice/TalkRealtimeClientSession.swift` — decodes the structured job receipt.
- `apps/ios/Sources/Voice/TalkRealtimeWebRTCSession.swift` — distinguishes interactive wait expiry
  from terminal timeout/abort, returns receipts on wait expiry, preserves explicit abort, and
  forwards job ids for status/cancel.
- `extensions/discord/src/voice/realtime.ts` — forwards an optional job id to voice agent control.
- `extensions/voice-call/src/runtime.test.ts` — proves the configured agent-run timeout is still
  passed through independently of the brief wait.
- `packages/gateway-protocol/src/schema/channels.ts` — adds the receipt schema and job-id/task control
  fields. This file also contains inherited non-A59 image-input changes.
- `packages/gateway-protocol/src/index.test.ts` — validates the receipt and job control fields. This
  file also contains inherited non-A59 image-input tests.
- `src/gateway/server-methods/talk-client.ts` — returns the consult receipt and forwards job-id
  control. This file also contains inherited BUG-180 gateway-tool work.
- `src/gateway/server-methods/talk-session.ts` — forwards job-id control on relay and direct Talk
  sessions. This file also contains inherited non-A59 image-input work.
- `src/gateway/server-methods/talk.test.ts` — proves durable receipt creation, continued work after
  acknowledgment, exact job cancellation through `chat.abort`, and no-lifecycle terminal fallback.
- `src/gateway/talk-agent-consult.ts` — creates the durable task before `chat.send`, returns the
  receipt, registers exact-run cancellation, and terminalizes the ledger from canonical evidence.
- `src/gateway/talk-realtime-relay.ts` — forwards job-id control. The other diffs in this file are
  inherited BUG-180/image-input work.
- `src/talk/agent-consult-runtime.ts` — separates the brief wait from run abort/lifetime, owns the
  embedded durable task, arms delivery after wait expiry, and finalizes only from runtime evidence.
- `src/talk/agent-consult-runtime.test.ts` — proves wait expiry returns a receipt while the run keeps
  going, completion is delivered exactly once, and explicit task cancellation aborts the run.
- `src/talk/agent-run-control-shared.ts` — adds optional job-id input and task-target output.
- `src/talk/agent-run-control.ts` — reports active consult jobs and supports exact job status/cancel.
- `src/talk/agent-run-control.test.ts` — proves owner and fork-child visibility plus exact cancellation.
- `src/tasks/cli-task-cancel.ts` — adds process-local cancellation handles for active CLI-owned
  consult runs; durable identity/state remains in SQLite.
- `src/tasks/runtime-internal.ts` — exposes related-session task lookup to the internal control path.
- `src/tasks/task-registry.ts` — routes `agent_consult` task cancellation to its live handle and
  clears handles in test reset.
- `ui/src/pages/chat/realtime-talk-shared.ts` — turns only interactive wait expiry into the receipt,
  while preserving explicit `chat.abort`.
- `ui/src/pages/chat/realtime-talk-consult.test.ts` — proves timeout does not abort and explicit abort
  still does.

## Proof

Final focused test command:

```text
node scripts/run-vitest.mjs src/talk/agent-consult-runtime.test.ts src/talk/agent-run-control.test.ts src/gateway/server-methods/talk.test.ts ui/src/pages/chat/realtime-talk-consult.test.ts packages/gateway-protocol/src/index.test.ts src/tasks/task-registry.test.ts extensions/voice-call/src/runtime.test.ts src/gateway/talk-realtime-relay.test.ts extensions/discord/src/voice/agent-control.test.ts extensions/discord/src/voice/realtime.wake-name-followup.test.ts
```

Result: 7 Vitest shards passed, 10 test files passed, 448 tests passed, 166.30 seconds.

Exact requested typecheck:

```text
pnpm tsgo --noEmit -p tsconfig.json
```

Result: the command exited 1 only on inherited errors in
`extensions/memory-core/src/dreaming.test.ts`,
`src/agents/embedded-agent-runner/run/assistant-failover.test.ts`,
`src/agents/model-selection-manifest-workspace.test.ts`, and the pre-existing BUG-180 mock typing in
`src/gateway/talk-realtime-relay.test.ts`. It reported no errors in A59 implementation or A59 test
files.

Additional checks:

- `git diff --check` — clean.
- Fresh `autoreview --mode local` — clean, no accepted/actionable findings; overall correctness
  `patch is correct` with confidence 0.78.
- Testbox pre-warm was attempted before local work but the installed Crabbox binary failed its
  basic `--version`/`--help` sanity check before allocation. The user-required local
  `scripts/run-vitest.mjs` proof was run instead.

## Not proved in this turn

- Per instruction, the gateway was not built or restarted.
- The Swift client changes were source-reviewed but not compiled because this task explicitly
  prohibited building. The TypeScript/browser/gateway/runtime paths have focused automated proof.
- The repo-wide typecheck is not globally green due to the inherited unrelated errors listed above;
  the touched A59 scope adds no typecheck errors.

OUTCOME: DONE
