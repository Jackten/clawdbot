# Multitasking Stage 3 — safe mutation and recovery

Date: 2026-07-27

## Scope and safety

This change builds on `WORKLOG-A59.md` and `WORKLOG-MS2.md`. The active Mac runtime was verified
before editing. No build, gateway restart, LaunchAgent change, live configuration write, or live
state migration was performed.

The pre-existing Stage 1/2 and realtime voice changes remain in the dirty working tree. This work
does not revert or rewrite them.

## Oracle architecture consultation

Oracle was run through the required latest-Pro browser wrapper with the prior architecture report,
both earlier worklogs, the Stage 2 admission implementation, and the shared SQLite schema attached.
Its most important correction was incorporated:

- an effect must have a stable controller-owned logical slot that survives replacement attempts;
- provider idempotency keys must exclude attempt/run identity;
- reusing one logical slot with a different request hash is an invariant failure;
- dynamic model tool calls must fail closed if a replacement attempt invents a new effect slot;
- exact resource identity belongs at the validated tool/broker boundary, not in prompt regexes;
- ambiguous provider outcomes are `UNKNOWN`, not success, failure, or permission to retry.

The implemented guarantee is therefore: one durable logical effect is dispatched once where the
sink honors the supplied key or can reconcile it. If application cannot be established, OpenClaw
records and surfaces `UNKNOWN` and does not automatically resend.

## Persistence design

All Stage 3 control state is in the existing shared `state/openclaw.sqlite` database. Runtime DML
uses the repository Kysely compile/execute helpers and `BEGIN IMMEDIATE` write transactions. No
JSON, JSONL, text, or sidecar state store was added.

| Table                          | Purpose                                                                                                                                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_mutation_locks`         | One durable row per canonical resource. The row is retained on release so `fencing_token` increases monotonically. Holder, run, acquisition time, and lease expiry are projections.                                           |
| `agent_external_effects`       | Canonical effect projection keyed by the client-generated provider idempotency key. Stores stable `(job_id, logical_slot)`, attempt run, adapter/effect kind, resource, request hash, outcome, receipt/error, and timestamps. |
| `agent_external_effect_events` | Append-only effect history for `prepared`, `submitting`, `applied`, `failed`, and `unknown` transitions.                                                                                                                      |
| `agent_job_checkpoints`        | Reserved durable checkpoint shape already present in the live DB. It is created at gateway boot for schema consistency, but no production batch-resume writer/controller is claimed yet.                                      |
| `agent_freshness_results`      | Trusted result freshness decisions: `fresh`, `revalidated`, or `stale`.                                                                                                                                                       |

`(job_id, logical_slot)` is unique. The provider key is
`SHA-256(job_id, logical_slot, effect_kind)` and never contains a run/attempt ID, timestamp, or
model wording. The normalized request hash is stored separately; payload drift under an existing
slot hard-fails.

## Protocols

### Resource locks and fencing

- Resource sets are normalized, deduplicated, sorted, and acquired all-or-none in one immediate
  transaction.
- A live conflicting holder blocks only that resource set.
- Expiry/takeover increments the retained fencing token.
- Renew and release are conditional on both owner and token. A stale release cannot clear a newer
  lease.
- Message resources are derived from validated channel/account/recipient/thread arguments at the
  message broker boundary.
- The memory/file broker derives its key from the resolved target file path.
- Known families without a converted exact adapter retain Stage 2's process-local same-key
  serialization. Food logging and purchases additionally fail closed before model/tool execution.
- The final memory rename is performed inside the same short SQLite write transaction that checks
  owner, token, expiry, and the file base hash. A replacement cannot take the durable fence between
  the final check and rename.

### Effect ledger and idempotency

1. Insert effect intent and append `prepared`.
2. Atomically claim `prepared -> submitting`; only one worker can win.
3. Call the adapter with the persisted client-generated key.
4. Append/project `applied`, `failed`, or `unknown`.
5. A retry of `applied` returns the persisted receipt without dispatch.
6. A `submitting`/`unknown` retry reconciles when the adapter supplies reconciliation. Without
   conclusive reconciliation it returns/surfaces `UNKNOWN` and does not dispatch.

The message tool is connected to this protocol. Its logical slot is derived from normalized
recipient/thread/content identity rather than tool-call identity. The ledger key is also the
durable outbound queue id, so a retry can reconcile the pending transport intent without replaying
it. Read-only message actions are unchanged.

Dynamic message calls reuse the same content-derived slot across same-run model retries and
replacement attempts. A different slot is rejected while an earlier same-resource effect is
unresolved, and replacement runs cannot invent a second slot. Food logging and purchases currently
fail closed because no complete durable adapter exists for either family.

### Checkpoint and resume

Checkpointed batch resume is not delivered. The unused `runCheckpointedBatch` API remains removed
so the tree does not imply production coverage that has no caller. The `agent_job_checkpoints`
table is retained in the canonical schema because it already exists in the live shared database and
the independent verification explicitly requires fresh installs and gateway boot to materialize the
same Stage 3 schema. There is still no production checkpoint writer or attempt-fenced resume
controller.

### Memory/wiki commit broker

Host memory-flush appends now use the broker. It:

- reads the current canonical content and base hash;
- computes the update while holding a renewable short lease;
- rejects a changed base rather than overwriting it;
- writes a sibling temporary artifact;
- rechecks the fencing token, expiry, and base hash at the final commit boundary;
- atomically renames the artifact.

Concurrent jobs therefore observe the latest committed page and neither append is silently lost.
Sandbox-backed memory writes retain their existing sandbox bridge; their run remains conservatively
classified until that bridge has a native Stage 3 commit adapter.

### Freshness

Admission can carry `freshnessDeadlineAtMs`. Realtime voice consults persist a freshness decision
before terminal publication. A late answer is replaced with an explicit stale notice; the original
text is not spoken or returned as current. The coordinator also supports adapter-supplied
revalidation, recorded as `revalidated`.

### Runtime authority

The mutation context is established around the function the global command lane actually executes,
not around enqueueing. Job ID, attempt run ID, resource hint, and freshness deadline therefore
survive queue delay without leaking between runs. The model never writes lock, effect, freshness,
task, or terminal state. No runtime checkpoint write surface is currently exposed.

## Oracle addendum verification

The independent Oracle review was read in full before closeout. Its schema concern was valid for the
artifact it received, but the live shared database was newer than that snapshot. A read-only query
against `/Users/clawdmac/.openclaw/state/openclaw.sqlite` found all five Stage 3 tables:

- `agent_mutation_locks`;
- `agent_external_effects`;
- `agent_external_effect_events`;
- `agent_job_checkpoints`;
- `agent_freshness_results`.

The checkpoint table had drifted out of `src/state/openclaw-state-schema.sql`, so a fresh install
would not have matched the live database. It is now restored to the canonical SQL, embedded schema,
and generated Kysely types. Gateway CLI startup calls `recordGatewayBootStart` before
`startGatewayServer`; that opens the shared DB, and `openOpenClawStateDatabase` executes the embedded
schema in `ensureSchema`. `src/infra/gateway-boot-lifecycle.test.ts` now proves the five tables exist
after the boot record and before server startup. They are not created lazily by the mutation
coordinator.

Oracle's minimum acceptance matrix is represented honestly:

- accepted-client disconnect, completion, task-registry restart, reconnect/delivery replay:
  executable and proves exactly one terminal send;
- completion at the exact wait deadline with the direct result unavailable: executable and now
  routes through durable terminal delivery, exactly once;
- lease takeover: executable for stale mutation, renewal, and release; the stale attempt cannot
  clear the replacement's higher fence;
- stale checkpoint, terminal, and delivery writes: explicit `it.todo` because there is no durable
  attempt-generation/controller write surface to fence yet;
- effect death before/after `prepared` and after `submitting`: executable against persisted SQLite
  states and never blind-resends;
- death after sink write before receipt: executable through restart reconciliation and one submit;
- real two-process kill/socket-write injection: explicit `it.todo`; the repository does not yet have
  the required multiprocess deterministic sink harness.

## How Stage 2 serialization is superseded

Stage 2's process-local resource comparison no longer conflicts for message keys, because every
mutating message-tool action now takes its exact durable recipient/thread lock. Unknown scopes and
known families without complete broker coverage still use the conservative process-local guard.

Converted correctness paths use durable locks:

- exact message recipient/thread lock around effect preparation and dispatch;
- exact memory file lock around read/CAS/rename;

Prompt-derived keys remain scheduling/context hints only. Unknown or unconverted mutations retain
Stage 2's conservative exclusive or same-key admission. They are not claimed as safely resumable
effects and are not granted the finer concurrency of a converted broker.

## Per-file changes

- `src/agents/agent-mutation-coordinator.ts` — durable resource leases/fencing, append-only effect
  ledger, stable logical slots/idempotency, reconciliation, bounded retention, fenced file commits,
  freshness decisions, and execution-scoped mutation context.
- `src/agents/agent-mutation-coordinator.test.ts` — SQLite-backed failure tests for response loss,
  restart reconciliation, one-winner dispatch, same-run/replacement replanning, payload mismatch,
  retention, cancellable lock waits, fail-closed families, lease takeover, stale file commit,
  concurrent page edits, and stale/revalidated results.
- `src/state/openclaw-state-schema.sql` — Stage 3 tables, checks, foreign key, uniqueness, and
  indexes.
- `src/state/openclaw-state-schema.generated.ts` — regenerated embedded schema.
- `src/state/openclaw-state-db.generated.d.ts` — regenerated Kysely table types.
- `src/infra/gateway-boot-lifecycle.test.ts` — proves gateway boot creates every Stage 3 table before
  server startup.
- `src/agents/agent-run-admission.ts` — durable job/freshness metadata, removal of brokered message
  whole-run conflicts, retained same-key/exclusive guards for unconverted families, and read-only
  food-log/purchase disambiguation.
- `src/agents/agent-run-admission.test.ts` — proves known keys no longer serialize at admission and
  exclusive priority behavior still holds without classifying read-only history queries as
  mutations.
- `src/agents/embedded-agent-runner/run.ts` — establishes Stage 3 context inside the queued command
  lane execution using durable job identity.
- `src/agents/tools/message-tool.ts` — exact message resource locking, effect-ledger dispatch,
  provider key propagation, persisted replay, explicit `UNKNOWN` surfacing, and typed
  pre-dispatch failure classification.
- `src/agents/tools/message-tool.test.ts` — restart replay integration proves the message adapter
  returns the ledger receipt without a second outbound call; required-delivery preflight rejection
  is recorded as failed rather than an ambiguous send.
- `src/infra/outbound/deliver-types.ts` and `src/infra/outbound/message.ts` — identify durability
  capability rejection as a preflight error that occurs before enqueue or platform I/O.
- `src/agents/agent-tools.read.ts` — routes host memory-flush appends through the fenced commit
  broker.
- `src/talk/agent-consult-runtime.ts` — durable consult job identity and late-result freshness
  adjudication, including deterministic wait-deadline ownership.
- `src/talk/agent-consult-runtime.test.ts` — proves a late voice result is not returned as current,
  client-disconnect/restart delivery is exactly once, and exact-boundary completion uses durable
  delivery.
- `src/talk/agent-run-control.ts` and its test — no-job steering/cancellation resolves the active
  consult worker session and durable task rather than the parent Talk session.
- `apps/ios/Sources/Voice/TalkRealtimeWebRTCSession.swift` and its focused test — preserve
  non-terminal `agent.wait` retry-grace timeouts by decoding `pendingError`.
- `src/gateway/talk-agent-consult.ts` — carries the persisted task ID into queued embedded execution.

## Failure-mode proof

`node scripts/run-vitest.mjs src/agents/agent-mutation-coordinator.test.ts`

- PASS: 1 file, 14 tests; 2 explicit TODO scenarios.
- Provider applies an effect while the first worker never observes a receipt; a reopened
  coordinator reconciles it and submission count stays one.
- Before-`prepared`, after-`prepared`, after-`submitting`, and after-send/before-receipt states are
  covered without blind resend. Concurrent claim, same-run/replacement replans, payload mismatch,
  retention, cancellable lock waits, fail-closed food/purchase families, fencing, file CAS,
  lost-update, and freshness pass.
- TODOs name the missing durable attempt-controller fencing test and the missing deterministic
  multi-process process-death/socket-write harness.

`node scripts/run-vitest.mjs src/agents/tools/message-tool.test.ts`

- PASS: 1 file, 126 tests.
- Includes persisted restart replay through the real message-tool integration; outbound mock count
  stays one and the adapter receives an `effect:<sha256>` key. A same-run retry with a different
  tool-call id also keeps the outbound call count at one. A preflight durability failure is not
  stranded as `UNKNOWN`, and a new job can retry.

`node scripts/run-vitest.mjs src/infra/outbound/message.test.ts`

- PASS: 1 file, 13 tests.
- Proves unsupported required durability throws the typed preflight error before outbound delivery.

`node scripts/run-vitest.mjs src/agents/agent-run-admission.test.ts`

- PASS: 1 file, 14 tests.

`node scripts/run-vitest.mjs src/talk/agent-run-control.test.ts`

- PASS: 1 file, 15 tests.

`node scripts/run-vitest.mjs src/agents/agent-tools.create-openclaw-coding-tools.test.ts`

- PASS: 1 file, 70 tests.

`node scripts/run-vitest.mjs src/talk/agent-consult-runtime.test.ts`

- PASS: 1 file, 14 tests.

`node scripts/run-vitest.mjs src/infra/gateway-boot-lifecycle.test.ts`

- PASS: 1 file, 7 tests.
- Proves the five Stage 3 tables exist after the gateway boot record opens the shared database and
  before server startup.

`node scripts/run-vitest.mjs src/gateway/server-methods/talk.test.ts`

- PASS: 2 files, 102 tests.

`node scripts/run-vitest.mjs src/infra/outbound/delivery-queue.recovery.test.ts`

- PASS: 1 file, 38 tests.

`node scripts/run-vitest.mjs src/agents/embedded-agent-runner/run.lane-timeout.test.ts`

- PASS: 1 file, 2 tests.

`node scripts/generate-kysely-types.mjs --verify`

- PASS. Generated schema and Kysely types match the SQL source.

`git diff --check`

- PASS.

`pnpm tsgo --noEmit -p tsconfig.json`

- PASS: exit 0 with zero diagnostics after the accumulated Stage 4 test-double repairs.

The locally bundled Node SQLite reports 3.51.3. The attempted Blacksmith Testbox prewarm failed
before allocation because the selected Crabbox binary failed its basic `--version`/`--help` probe.
The user explicitly requested the local targeted test runner, so all proof above used that path.
The host does not have `swiftformat`. No iOS build/test was run; the mandated closeout proof was the
targeted Vitest/`tsgo` matrix and no gateway build or restart. The focused Swift tests are present
but unexecuted in this closeout.

## Review

Mandatory autoreview found one P1: the first implementation created AsyncLocalStorage context around
enqueueing rather than around later lane execution. That finding was accepted and fixed by moving
`runWithAgentMutationJob` inside the enqueued function. The queue/lane tests passed after the fix.

The fresh review found a second P1: removing Stage 2 key intersections exposed food-log and
smart-home families before their exact tool adapters were converted. That was accepted and fixed by
retaining Stage 2 same-key serialization for every unconverted family; only fully brokered message
keys bypass it. Admission, message, and coordinator suites passed after the fix.

Addendum closeout reviews found and fixed four further in-scope defects:

- no-job Talk steering/cancellation targeted the parent Talk session instead of the consult worker;
- read-only food-log and purchase-history requests were classified as mutations;
- iOS treated retry-grace `agent.wait` snapshots as terminal because it dropped `pendingError`;
- required-delivery preflight failures were recorded as ambiguous external effects.

After those fixes, the final frozen-scope autoreview reported no accepted/actionable findings and
judged the complete patch correct.

No build or live gateway restart was run, per request.

OUTCOME: BLOCKER-FIX SCOPE DONE; STAGE 3 PRODUCTION VERIFICATION REMAINS NO-GO
