# Multitasking Ship-Blocker Fixes

Date: 2026-07-27  
Scope: independent `SHIP WITH FIXES` findings H1-H4 plus the three flagged follow-ups.  
Safety: no build and no gateway restart were run.

> **Round 2 correction:** This worklog previously made two false claims. The
> prompt-derived food/purchase gate was neither complete nor safe, and the
> checkpoint search cited below actually returned 10 matches when this document
> was written. Round 2 removed that prompt gate and the remaining checkpoint
> table/index/type/bootstrap artifacts. `WORKLOG-MS-FIXES2.md` is the
> authoritative follow-up and preserves the real before/after proof.

## H1 — Duplicate external side effects

Status: closed for message sends; food logging and purchases fail closed until they have durable adapters.

- Message sends now derive the mutation slot from the normalized logical effect fingerprint (recipient/thread/content/action), not `toolCallId`, at `src/agents/tools/message-tool.ts:1617`. The pre-existing failed-send fingerprint guard is active with or without mutation context at `src/agents/tools/message-tool.ts:1688`.
- A same-run invented slot is rejected while a prior effect on the resource is `prepared`, `submitting`, or `unknown` at `src/agents/agent-mutation-coordinator.ts:604`.
- An in-process submission is tracked until it returns, so a concurrent model attempt cannot reconcile or replay an effect that is still crossing the provider boundary at `src/agents/agent-mutation-coordinator.ts:515` and `src/agents/agent-mutation-coordinator.ts:557`.
- Completion is monotonic: a late timeout/failure cannot overwrite a terminal `applied` or `failed` reconciliation at `src/agents/agent-mutation-coordinator.ts:677`.
- The message tool wires durable reconciliation at `src/agents/tools/message-tool.ts:1633`. Provider failures are classified as permanent `failed` or ambiguous `unknown`; unknown is surfaced through `AgentExternalEffectUnknownError` and cannot silently drive another send.
- The ledger idempotency key is also the durable outbound queue ID. Ledger-linked deliveries retain a non-replayable `sent` projection and normalized transport results at `src/infra/outbound/deliver.ts:1380`, `src/infra/outbound/delivery-queue-storage.ts:153`, and `src/infra/outbound/delivery-queue-recovery.ts:233`. This closes the crash window between provider success, queue acknowledgement, and ledger completion.
- **Corrected in Round 2:** prompt-derived food/purchase scopes are admission
  hints only and no longer authorize or refuse execution. This checkout has no
  food-log or purchase effect adapter, so durable safety for those families is
  **not delivered**; it must be enforced by a real owner adapter, not prompt text.
- **Corrected in Round 2:** `runCheckpointedBatch` was gone, but the unused
  checkpoint schema/type/bootstrap artifacts remained when this worklog first
  claimed removal. Round 2 removed the table, index, generated SQL/type, and
  boot assertion. Checkpoint resume remains **not delivered**.

Regression tests:

- Same-run new-slot rejection: `src/agents/agent-mutation-coordinator.test.ts:156`.
- Stale submitter cannot downgrade reconciliation: `src/agents/agent-mutation-coordinator.test.ts:235`.
- Same-run retry with a different tool-call ID sends once: `src/agents/tools/message-tool.test.ts:893`.
- Queue reconciliation does not replay: `src/infra/outbound/delivery-queue.recovery.test.ts:547`.
- Completed queue receipt remains reconcilable: `src/infra/outbound/delivery-queue.recovery.test.ts:593`.
- External-effect queue IDs request receipt retention: `src/infra/outbound/deliver.test.ts:821`.

## H2 — Reserved foreground slot

Status: closed.

- Resource conflicts are evaluated by the declared resource scope. A read-only scope (`keys: []`) never conflicts with a background exclusive mutation at `src/agents/agent-run-admission.ts:218`.
- Exclusive mutation scopes still conflict with non-empty mutation resources, preserving serialization for work that actually mutates state.
- Required voice regression: `src/agents/agent-run-admission.test.ts:195` proves a background exclusive job does not block a foreground voice/read query.

## H3 — Parent/child admission deadlock

Status: closed by admission inheritance.

- Admission lineage is captured with `AsyncLocalStorage` at `src/agents/agent-run-admission.ts:378` and inherited by nested work at `src/agents/agent-run-admission.ts:476`.
- Conflict checks skip only resources held by an ancestor synchronously awaiting the child; unrelated holders still conflict at `src/agents/agent-run-admission.ts:235`.
- Required regression: `src/agents/agent-run-admission.test.ts:223` proves an exclusive parent can await a nested child without deadlock.

## H4 — Provider-slot throttle policy

Status: explicit policy retained and documented.

- Policy: per normalized provider, allow two total harness attempts but at most one non-foreground attempt. Background and cron therefore share one same-provider subscription slot across the entire harness attempt, including tool time, while one provider slot remains admissible for interactive work.
- Rationale: subscription-only billing and foreground responsiveness take precedence over realizing `cron.maxConcurrentRuns` or `subagents.maxConcurrent` against one provider. Those settings remain lane fan-out ceilings; they are not promises of same-provider model concurrency.
- Implementation and policy comment: `src/agents/agent-run-admission.ts:99` and `src/agents/agent-run-admission.ts:408`.
- `WORKLOG-MS2.md` was corrected so it no longer claims configured lane concurrency is fully realized or that the slot covers backend I/O only.
- No metered model/API path was added.
- Dependency check: sibling Codex source at commit `fbe65995bbcd4da249cfdafe0300ac3cb2cb3b3c` was inspected directly. Thread operations serialize by thread key in `../codex/codex-rs/app-server-protocol/src/protocol/common.rs:497` and `:831`; different request-serialization keys run concurrently in `../codex/codex-rs/app-server/src/request_serialization.rs:299`.

## Other flagged items

### Cancellable `commitFile` lock wait

Closed. `commitFile` combines the caller abort signal with a bounded 30-second lock-wait timeout at `src/agents/agent-mutation-coordinator.ts:755`. The memory-flush tool forwards its run signal at `src/agents/agent-tools.read.ts:676`. Regression: `src/agents/agent-mutation-coordinator.test.ts:433`.

### Ghost `running` rows

Closed for newly accepted consults that lose their in-process owner. A production context with a controller map but no controller immediately terminalizes the task as `failed` at `src/gateway/talk-agent-consult.ts:402`. Regression: `src/gateway/server-methods/talk.test.ts:2408`.

Actual model/tool continuation after a full process restart is deliberately deferred. Existing maintenance can reconcile durable cron results or mark orphaned work `lost`, but a generic running agent attempt has no serializable continuation state from which execution can safely resume. Claiming automatic resume would be false and could repeat tools or external effects.

### Unbounded ledger growth

Closed with bounded retention. External-effect events and projections, retained sent receipts, released mutation locks, and freshness rows are pruned after the configured retention window (30 days by default) at `src/agents/agent-mutation-coordinator.ts:825`. Regression: `src/agents/agent-mutation-coordinator.test.ts:480`.

## Deliberate deferrals

- Checkpointed batch resume is not delivered. The unused API, table, generated type, and bootstrap expectation were removed instead of implying support.
- Food logging and purchases do not have complete durable
  idempotency/reconciliation adapters. The unsafe prompt gate was removed;
  enabling these mutations requires owner-specific effect adapters and
  reconciliation proof.
- Generic in-flight agent continuation after gateway restart is not delivered. Durable task rows remain diagnosable and become terminal rather than ghost-running, but execution is not replayed.

## Proof

All test invocations used one explicit test file:

| Command                                                                                   | Final result                          |
| ----------------------------------------------------------------------------------------- | ------------------------------------- |
| `node scripts/run-vitest.mjs src/agents/agent-mutation-coordinator.test.ts`               | 1 file passed; 14 passed, 2 todo      |
| `node scripts/run-vitest.mjs src/agents/agent-run-admission.test.ts`                      | 1 file passed; 13 passed              |
| `node scripts/run-vitest.mjs src/agents/tools/message-tool.test.ts`                       | 1 file passed; 125 passed             |
| `node scripts/run-vitest.mjs src/infra/outbound/delivery-queue.recovery.test.ts`          | 1 file passed; 38 passed              |
| `node scripts/run-vitest.mjs src/infra/outbound/deliver.test.ts`                          | 1 file passed; 137 passed             |
| `node scripts/run-vitest.mjs src/agents/agent-tools.create-openclaw-coding-tools.test.ts` | 1 file passed; 70 passed              |
| `node scripts/run-vitest.mjs src/gateway/server-methods/talk.test.ts`                     | 2 configured files passed; 102 passed |
| `node scripts/run-vitest.mjs src/infra/gateway-boot-lifecycle.test.ts`                    | 1 file passed; 7 passed               |

Additional proof:

- `pnpm tsgo --noEmit -p tsconfig.json`: exit 0, zero diagnostics.
- `node scripts/generate-kysely-types.mjs --verify`: exit 0.
- `pnpm config:docs:check`: exit 0 (`OK docs/.generated/config-baseline.sha256`).
- `git diff --check`: exit 0.
- **Correction:** the cited `rg` command returned 10 matches when this worklog
  was written, not zero. The Round 2 worklog records both that falsified
  before-state and the verified no-match result after removing the artifacts.
- No build and no gateway restart were run.

## Review

Command:

` .agents/skills/autoreview/scripts/autoreview --mode local ... --stream-engine-output`

- First review returned two accepted P1 findings: stale terminal-result downgrade and deletion of the only successful-send evidence. Both were fixed with monotonic completion and retained sent receipts.
- Second review was clean: `autoreview clean: no accepted/actionable findings reported`.
- The post-schema-removal review returned one config-baseline P2, which was rejected after checking the repository contract: the JSON files are explicitly gitignored/local-only, `pnpm config:docs:check` passes, and regenerating them produced hashes matching the tracked checksum exactly. No accepted/actionable finding remains.

OUTCOME: DONE
