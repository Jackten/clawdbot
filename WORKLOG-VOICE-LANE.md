# Voice-lane durability worklog

## Outcome

Voice-initiated agent consults now persist a durable task before releasing the realtime provider tool call. The provider receives a final background-work acknowledgement immediately after durable admission registration, so queued chat admission and long-running work cannot retain the voice response lane. The durable task—not the provider call—owns the eventual success, failure, unknown-outcome state, artifact references, and terminal delivery.

Delegated runs that finish without visible text or a structured artifact now fail with the stable `completed_without_reply` code. Structured artifact references survive empty assistant turns and are scoped to the current delegated task. Startup delivery recovery now defers without consuming a retry until the target channel/account is ready, then retries readiness checks in a bounded, shutdown-aware loop.

## Design and invariants

- The realtime provider call and the background chat run have separate IDs. A `talk-task-*` ID owns durable task state; the `talk-*` idempotency key owns chat admission and execution.
- A native realtime consult call is finalized only after its durable task and admission override exist. Its acknowledgement explicitly tells the provider to keep talking while OpenClaw delivers the final result separately.
- Queue/admission progress is recorded against the durable task ID.
- The durable task starts with terminal delivery disarmed, is armed after chat acceptance, and owns the one later terminal publication.
- If an already-acknowledged consult fails before chat startup, the failed task is armed and terminally delivered rather than suppressed.
- A successful consult requires captured visible assistant text or a structured artifact reference. No visible result is `FAILED: completed_without_reply`.
- A missing in-process run controller without terminal runtime evidence is `lost` with `unknown_outcome`; it is not converted to a clean failure or success.
- No automatic side-effect retry was added. The effect-ledger/idempotency path remains authoritative, and unknown side-effect outcomes remain unknown. Read-only empty-result retry is permitted by policy but intentionally not introduced here.
- Startup replay does not call a disconnected channel and does not increment the queued delivery retry counter while waiting for readiness.

## Per-file changes

### Voice and Talk

- `src/gateway/talk-agent-consult.ts`
  - Persists a delivery-capable durable task before chat admission.
  - Separates durable task and chat execution IDs.
  - Releases the relay voice lane before queued admission resolves.
  - Records admission progress on the durable task.
  - Captures terminal reply/artifact evidence before success.
  - Delivers acknowledged startup failures and maps missing runtime ownership to `unknown_outcome`.
- `src/gateway/talk-realtime-relay.ts`
  - Finalizes background-work acknowledgements instead of using `willContinue`.
  - Keeps late task results from reopening an already-completed provider tool call.
  - Separates provider-call acknowledgement from later chat-run tracking.
- `src/talk/agent-consult-runtime.ts`
  - Requires visible text or artifact evidence for success.
  - Converts artifact-only payloads into a visible result.
  - Rejects empty terminal output with `completed_without_reply` instead of a confident fallback.
- `src/talk/agent-consult-tool.ts`
  - Defines the non-blocking background acknowledgement.
  - Extracts `mediaUrl`/`mediaUrls` artifact references from consult payloads.
- `src/gateway/server-methods/talk-shared.ts`
  - Aligns provider instructions with separately delivered terminal results.
- `src/tasks/task-completion-contract.ts`
  - Adds the stable `completed_without_reply` error code and formatter.

### Delegation result integrity

- `src/agents/subagent-announce-output.ts`
  - Preserves trusted structured `details.media` references from tool results.
  - Returns artifact-only completions when assistant text is empty.
  - Resets completion evidence at a new user-task boundary so stale artifacts cannot leak.
- `src/agents/subagent-registry-completion.ts`
  - Converts mandatory missing/progress-only completion output from succeeded/blocked to failed with `completed_without_reply`.

### Startup recovery ordering

- `src/infra/outbound/delivery-queue-recovery.ts`
  - Adds a readiness predicate and a `deferredReadiness` summary count.
  - Defers before delivery/retry accounting when a channel is not ready.
- `src/gateway/server-runtime-services.ts`
  - Binds startup recovery to live channel/account readiness.
  - Rechecks deferred entries for up to 60 seconds without consuming delivery retries.
  - Stops readiness rechecks during gateway shutdown.
- `src/gateway/server.impl.ts`
  - Supplies the live channel snapshot and shutdown state to scheduled recovery.

### Regression coverage

- `src/talk/agent-consult-runtime.test.ts`
- `src/gateway/talk-realtime-relay.test.ts`
- `src/gateway/server-methods/talk.test.ts`
- `src/agents/subagent-announce-output.test.ts`
- `src/agents/subagent-registry-completion.test.ts`
- `src/agents/subagent-registry-lifecycle.test.ts`
- `src/infra/outbound/delivery-queue.recovery.test.ts`
- `src/gateway/server-runtime-services.test.ts`

The new regressions were first run against the previous production behavior and observed failing for:

- voice-lane continuation/locking during background work;
- relay acknowledgement delayed behind queued chat admission;
- empty terminal reply treated as success;
- delegated PDF/artifact reference dropped;
- stale artifact reuse across later delegated tasks;
- acknowledged startup failure suppressed after promising a later result;
- startup recovery attempting delivery before channel readiness.

## Test and review evidence

- `pnpm tsgo --noEmit -p tsconfig.json` — passed.
- `node scripts/run-vitest.mjs src/talk/agent-consult-runtime.test.ts src/gateway/talk-realtime-relay.test.ts src/gateway/server-methods/talk.test.ts src/agents/subagent-announce-output.test.ts src/agents/subagent-registry-completion.test.ts src/agents/subagent-registry-lifecycle.test.ts src/infra/outbound/delivery-queue.recovery.test.ts src/gateway/server-runtime-services.test.ts` — passed, 438 tests across four Vitest shards.
- `.agents/skills/autoreview/scripts/autoreview --mode local` — final fresh review clean; no accepted/actionable findings.
- `git diff --check` — passed before commit packaging.
- Blacksmith Testbox pre-warm was unavailable before allocation because the selected Crabbox binary failed its basic version/help sanity checks. Jack explicitly required the local test commands above, so the recorded proof is local.

## Commits

- `4029d59ae63` — `fix(talk): detach voice consults into durable tasks`
- `0824e21d0d2` — `fix(agents): preserve delegation results`
- `f3bbe08c003` — `fix(gateway): defer recovery until channel readiness`

## Report closure mapping

| Report | User-visible failure | Closing change |
| --- | --- | --- |
| `report-20260728T210656-ea021f0a` | Unfinished background lookup leaves voice locked | The relay consult acknowledgement is final and occurs immediately after durable task/admission persistence; queued or unfinished work remains owned by the background task and cannot retain the provider lane. |
| `report-20260728T100036-c4a4d753` | Background WhatsApp work still locks voice | Voice acknowledgement is separated from chat admission/execution, while the durable task retains requester origin and queued terminal delivery to WhatsApp when ready. |
| `report-20260729T060808-245c15fc` | Delegation completes empty and loses requested PDF | Mandatory empty output is failed with `completed_without_reply`; trusted structured media/file URLs are appended to the current completion and delivered even when the assistant text is empty. |
| `report-20260728T211130-fa64ea9f` | Lookup completes with a confident empty reply | The fallback-success path is removed: success requires visible text or artifact evidence, otherwise the task fails visibly with `completed_without_reply`. |
| `BUG-192` | Boot recovery runs before channel/provider readiness | Startup replay consults the live channel/account snapshot, defers without retry consumption, and rechecks readiness with shutdown cancellation. |

## Deployment state

The changes are committed on `overlay/mac-custom-v2026.7.1-update-20260716T035951-reviewed` and are ship-dark. No live build, gateway restart, channel message, or app-side change was performed. The running gateway remains on its prior build; activation should happen at the next coordinated safe-restart window using `/Users/clawdmac/clawd/bin/openclaw-safe-restart.sh` after the normal in-flight conversation check.

OUTCOME: DONE
