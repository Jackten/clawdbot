# Multitasking Round 2 Blocker Fixes

Date: 2026-07-27  
Repo: `/Users/clawdmac/src/openclaw-live`  
Safety: no build and no gateway restart were run.

## B1 — prompt-derived food/purchase gate

Status: the false pre-model gate is removed; the requested adapter-boundary
guarantee is blocked because this checkout has no food-log or purchase effect
adapter.

- `runWithAgentMutationJob` now only installs mutation context at
  `src/agents/agent-mutation-coordinator.ts:975`. It no longer interprets
  `resourceScope` keys as effect authorization or refusal.
- Exact prompt regressions are driven through `deriveAgentRunResourceScope` at
  `src/agents/agent-mutation-coordinator.test.ts:486`:
  - `log 200g of chicken to my diary`
  - `add 3 eggs and toast to cronometer`
  - `reorder my supplements`
  - `get me a new coffee filter from amazon`
  - `what did I log for breakfast today`
  - `did the amazon order ship yet`
  - `remind me to buy milk tomorrow`
    All seven reach the model task; none is authorized or refused by the prompt
    classifier.
- The only production caller of the durable external-effect broker is the
  message tool. There is no food-log or purchase adapter in `src/`,
  `extensions/`, or `packages/` to patch at its execution boundary.
- I did not add another tool-name, URL, browser-action, or prompt regex. Those
  would still be semantic guesses and would not prove that a final Cronometer
  write or checkout click is fenced.

Actual adapter search:

```text
$ rg -n 'executeExternalEffect\(|effectKind: `?(food|purchase)|food-log\.(upsert|create)|purchase\.(create|submit)' src extensions packages --glob '*.ts' --glob '!**/*.test.ts'
src/agents/tools/message-tool.ts:1615:              mutation.coordinator.executeExternalEffect({
```

Deferred blocker: food logging and purchases need typed owner adapters whose
final write/checkout methods call the durable broker and provide both
idempotency and reconciliation. Until those adapters exist, the global claim
that these effects cannot execute unledgered is not proven. This is why the
overall outcome is `BLOCKED`, despite removal of the user-visible prompt
regression.

## B2 — checkpoint artifacts and falsified proof

Status: removed, and the prior worklog is explicitly corrected.

- Removed `agent_job_checkpoints` table and index from
  `src/state/openclaw-state-schema.sql` and
  `src/state/openclaw-state-schema.generated.ts`; the schema now proceeds from
  external-effect events at `src/state/openclaw-state-schema.sql:170` directly
  to freshness state at `src/state/openclaw-state-schema.sql:186`.
- Removed `AgentJobCheckpoints` and the DB property from
  `src/state/openclaw-state-db.generated.d.ts`.
- Removed the boot query and expected table from
  `src/infra/gateway-boot-lifecycle.test.ts:66`.
- Added an explicit correction banner and corrected claims to
  `WORKLOG-MS-FIXES.md:7`, `:24`, `:28`, and `:115`.

The exact search really returned these 10 matches before this Round 2 edit:

```text
src/state/openclaw-state-db.generated.d.ts:89:export interface AgentJobCheckpoints {
src/state/openclaw-state-db.generated.d.ts:1115:  agent_job_checkpoints: AgentJobCheckpoints;
src/state/openclaw-state-schema.generated.ts:191:CREATE TABLE IF NOT EXISTS agent_job_checkpoints (
src/state/openclaw-state-schema.generated.ts:200:CREATE INDEX IF NOT EXISTS idx_agent_job_checkpoints_job
src/state/openclaw-state-schema.generated.ts:201:  ON agent_job_checkpoints(job_id, checkpoint_key, completed_at);
src/state/openclaw-state-schema.sql:186:CREATE TABLE IF NOT EXISTS agent_job_checkpoints (
src/state/openclaw-state-schema.sql:195:CREATE INDEX IF NOT EXISTS idx_agent_job_checkpoints_job
src/state/openclaw-state-schema.sql:196:  ON agent_job_checkpoints(job_id, checkpoint_key, completed_at);
src/infra/gateway-boot-lifecycle.test.ts:81:             'agent_job_checkpoints',
src/infra/gateway-boot-lifecycle.test.ts:94:      "agent_job_checkpoints",
```

Post-removal proof:

```text
$ rg -n 'runCheckpointedBatch|agent_job_checkpoints|AgentJobCheckpoints' src --glob '*.ts' --glob '*.sql'; proof_rc=$?; echo "EXIT: $proof_rc"
EXIT: 1
```

`rg` exit 1 here means no matches. Checkpoint resume is **not delivered**.

## B3 — foreground starvation

Status: fixed.

- `resolveWorkerQueueReason` bypasses both coarse resource checks for every
  foreground entry at `src/agents/agent-run-admission.ts:330-349`.
- The comment records the ownership rule: foreground admission is an
  availability boundary, admission does not authorize an effect, and actual
  adapters must refuse or acquire exact durable locks.
- Parameterized regressions at
  `src/agents/agent-run-admission.test.ts:201` use the exact foreground strings
  `hey`, `yes`, `thanks`, `tell me a joke`, and `call Mom` while a background
  exclusive job is active. Each starts immediately on the idle foreground
  worker.

## B4 — queued-sibling parent/child deadlock

Status: fixed, including the command-lane context boundary found by autoreview.

- `hasEarlierQueuedResourceReservation` now skips an earlier queued entry when
  that entry is itself blocked by the child's active awaiting ancestor at
  `src/agents/agent-run-admission.ts:250-267`.
- `bindAgentRunAdmissionContext` captures admission lineage for delayed lane
  callbacks at `src/agents/agent-run-admission.ts:516`.
- The embedded runner binds the admitted mutation task before placing it on the
  global command lane at `src/agents/embedded-agent-runner/run.ts:835`.
- The exact three-actor regression at
  `src/agents/agent-run-admission.test.ts:262` uses an exclusive parent, an
  earlier queued exclusive sibling, and an awaited exclusive child. The test
  pauses a real command lane, resumes it from outside the parent's
  `AsyncLocalStorage` context, and proves the child completes before the parent
  releases the sibling.

## B5 — message-effect residuals

Status: fixed for the two reported residuals without converting opaque outcomes
into unsafe retries.

- Same-job dynamic-slot lookup no longer filters by raw `resource_key`; it
  checks all effects of the same `job_id` and `effect_kind` at
  `src/agents/agent-mutation-coordinator.ts:589-605`.
- Regression `src/agents/agent-mutation-coordinator.test.ts:186` proves a model
  cannot evade an earlier unknown send by changing the resource identity.
- Missing queue reconciliation is bounded only when the adapter contract
  required a write-ahead row: `action === "send"` and `bestEffort === false` at
  `src/agents/tools/message-tool.ts:1647`. That case terminalizes as definitely
  not sent and tells the operator to start a new job.
- Regression `src/agents/tools/message-tool.test.ts:894` proves the original job
  does not dispatch twice and a new operator retry job can dispatch once.
- For best-effort, gateway, plugin, and other opaque paths where a queue row was
  not required, `missing` remains durable `UNKNOWN` with an explicit instruction
  to verify the external platform manually. Regression:
  `src/agents/tools/message-tool.test.ts:952`. This avoids the duplicate-send
  regression autoreview found in the first implementation.

## B6 — declared but unproven guarantees

Status: the two `it.todo`s were removed and the missing guarantees are stated
plainly here.

- Durable-attempt fencing for checkpoint, terminal, and delivery writes after
  takeover is **UNPROVEN** because a durable attempt controller is not
  implemented.
- Operating-system process-death injection at socket-write boundaries is
  **UNPROVEN** because a multiprocess crash harness is not implemented.
- No checkpoint table or checkpoint-resume API remains to imply otherwise.

Actual todo search:

```text
$ rg -n 'it\.todo' src/agents/agent-mutation-coordinator.test.ts; proof_rc=$?; echo "EXIT: $proof_rc"
EXIT: 1
```

## Final proof

All Vitest commands were single-file invocations, as required.

```text
$ node scripts/run-vitest.mjs src/agents/agent-mutation-coordinator.test.ts
[test] starting test/vitest/vitest.agents.config.ts
The `envFile` option is deprecated, please use `envDir: false` instead.

 RUN  v4.1.9 /Users/clawdmac/src/openclaw-live

 Test Files  1 passed (1)
      Tests  21 passed (21)
   Start at  16:47:18
   Duration  865ms (transform 86ms, setup 69ms, import 65ms, tests 675ms, environment 0ms)

[test] passed 1 Vitest shard in 3.52s
```

```text
$ node scripts/run-vitest.mjs src/agents/agent-run-admission.test.ts
[test] starting test/vitest/vitest.agents.config.ts
The `envFile` option is deprecated, please use `envDir: false` instead.

 RUN  v4.1.9 /Users/clawdmac/src/openclaw-live

 Test Files  1 passed (1)
      Tests  19 passed (19)
   Start at  16:47:24
   Duration  1.14s (transform 63ms, setup 66ms, import 7ms, tests 1.02s, environment 0ms)

[test] passed 1 Vitest shard in 3.79s
```

```text
$ node scripts/run-vitest.mjs src/agents/tools/message-tool.test.ts
[test] starting test/vitest/vitest.agents.config.ts
The `envFile` option is deprecated, please use `envDir: false` instead.

 RUN  v4.1.9 /Users/clawdmac/src/openclaw-live

 Test Files  1 passed (1)
      Tests  127 passed (127)
   Start at  16:47:29
   Duration  1.95s (transform 623ms, setup 70ms, import 825ms, tests 1.00s, environment 0ms)

[test] passed 1 Vitest shard in 4.60s
```

```text
$ node scripts/run-vitest.mjs src/infra/gateway-boot-lifecycle.test.ts
[test] starting test/vitest/vitest.infra.config.ts
The `envFile` option is deprecated, please use `envDir: false` instead.

 RUN  v4.1.9 /Users/clawdmac/src/openclaw-live

 Test Files  1 passed (1)
      Tests  7 passed (7)
   Start at  16:47:37
   Duration  446ms (transform 70ms, setup 84ms, import 45ms, tests 262ms, environment 0ms)

[test] passed 1 Vitest shard in 3.07s
```

Required typecheck:

```text
$ pnpm tsgo --noEmit -p tsconfig.json
$ pnpm tsgo:core --noEmit -p tsconfig.json
$ node scripts/run-tsgo.mjs -p tsconfig.core.json --incremental --tsBuildInfoFile .artifacts/tsgo-cache/core.tsbuildinfo --noEmit -p tsconfig.json
```

Exit 0, zero diagnostics.

Generated schema/type verification:

```text
$ node scripts/generate-kysely-types.mjs --verify
(node:32317) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
```

Exit 0.

Whitespace proof:

```text
$ git diff --check; proof_rc=$?; echo "EXIT: $proof_rc"
EXIT: 0
```

## Review

Final command used:

```text
.agents/skills/autoreview/scripts/autoreview --mode local --prompt 'Review only the Round 2 blocker repair delta in these files: src/agents/agent-mutation-coordinator.ts, src/agents/agent-mutation-coordinator.test.ts, src/agents/agent-run-admission.ts, src/agents/agent-run-admission.test.ts, src/agents/embedded-agent-runner/run.ts, src/agents/tools/message-tool.ts, src/agents/tools/message-tool.test.ts, src/state/openclaw-state-schema.sql, src/state/openclaw-state-schema.generated.ts, src/state/openclaw-state-db.generated.d.ts, src/infra/gateway-boot-lifecycle.test.ts, and WORKLOG-MS-FIXES.md. Explicit product contract from B3: every foreground request must be admitted regardless of prompt-derived scope; admission is not effect authorization, and prompt classification must not be restored as a safety gate. Review actual effect-boundary safety separately. Focus on command-lane lineage, same-run slots across resource keys, queue-missing reconciliation only when a write-ahead row was required, and checkpoint removal. Treat unrelated inherited dirty-tree changes as out of scope.' --stream-engine-output
```

Final output:

```text
autoreview clean: no accepted/actionable findings reported
overall: patch is correct (0.81)
I found no actionable blocker in the scoped Round 2 repair delta. Foreground admission no longer depends on prompt-derived mutation scope, lineage is preserved across queued nested work, same-job dynamic message slots fail closed while unresolved, queue-missing reconciliation is limited to the required send path, commitFile lock waits are cancellable, and the checkpoint schema/type/bootstrap artifacts are absent from the scoped runtime/schema files.
```

The first review found lost admission lineage across the command-lane callback;
accepted and fixed. The second found unsafe `missing` reconciliation for paths
that never required a queue row; accepted and fixed. Its request to restore
foreground prompt-scope serialization was rejected because it directly
contradicts B3 and would again make prompt classification the safety boundary.
The final review was clean.

OUTCOME: BLOCKED: food/purchase effects have no typed durable adapter boundary in this checkout
