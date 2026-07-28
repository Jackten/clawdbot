# Gateway fixes worklog

Date: 2026-07-28
Live repo: `/Users/clawdmac/src/openclaw-live`
Live state DB: `/Users/clawdmac/.openclaw/state/openclaw.sqlite` (`user_version=6`)

This work was performed against the Mac-primary live runtime. Model-backed proof used the configured OpenAI/Codex auth profile (`requestShaping.authMode=auth-profile`); no metered API credential was introduced or used.

## Part 1 — activate durable multitasking

### Design

The change activates the smallest complete real path:

1. A channel-originated `exec` call yields after one second.
2. If it is still running and has a source delivery route, it becomes a durable CLI task and immediately returns a task acknowledgement to the agent.
3. The background command writes a running checkpoint, then overwrites it with the terminal checkpoint.
4. Terminal task delivery acquires a per-destination mutation lock and submits through the external-effect ledger with a stable task/slot idempotency key.
5. Task maintenance restores pending terminal deliveries after restart. Delivered tasks are not resent.
6. The Codex harness exposes that path as the channel-only dynamic tool `async_exec` and tells the model to prefer it over native `bash` for source-conversation shell work expected to exceed one second.

This preserves native Codex shell behavior for ordinary coding turns and preserves the existing message/channel delivery path. It does not add whole-session locking.

### Files

- `extensions/codex/src/app-server/dynamic-tool-build.ts`
  - Adds `async_exec` only when the turn has a real source channel and target.
  - The tool delegates to the canonical OpenClaw `exec` implementation.
- `extensions/codex/src/app-server/thread-lifecycle.ts`
  - Adds scoped model guidance to use `async_exec` for long source-conversation work.
- `extensions/codex/src/app-server/dynamic-tool-build.test.ts`
  - Proves channel-only exposure and delegation to `exec`.
- `extensions/codex/src/app-server/run-attempt.test.ts`
  - Proves the guidance appears only when `async_exec` is available.
- `src/agents/bash-tools.exec-types.ts`
  - Adds the returned durable task identity.
- `src/agents/bash-tools.exec.ts`
  - Uses a one-second implicit yield for channel turns.
  - Creates/cancels/finalizes durable CLI tasks and writes checkpoints.
  - Suppresses the legacy exit notifier once the durable task owns delivery.
- `src/agents/agent-job-checkpoints.ts`
  - Adds the Kysely-backed checkpoint writer.
- `src/state/openclaw-state-schema.sql`
- `src/state/openclaw-state-schema.generated.ts`
- `src/state/openclaw-state-db.generated.d.ts`
  - Restore the `agent_job_checkpoints` table to the shared state schema/types.
- `src/tasks/cli-task-cancel.ts`
  - Registers active CLI task cancellation handles.
- `src/tasks/task-registry.ts`
- `src/tasks/task-registry.maintenance.ts`
  - Persists the original source route and restores pending terminal delivery.
- `src/tasks/task-registry-delivery-runtime.ts`
  - Wraps task notification sends in the mutation lock and external-effect ledger.
  - Reconciles unknown results through the existing durable delivery queue.
- Corresponding focused tests:
  - `src/agents/agent-job-checkpoints.test.ts`
  - `src/agents/bash-tools.test.ts`
  - `src/tasks/cli-task-cancel.test.ts`
  - `src/tasks/task-registry-delivery-runtime.test.ts`
  - `src/tasks/task-registry.test.ts`

### Original proof-run failure and root cause

The first two proof runs at 12:42–12:43 did not call OpenClaw `exec`; Codex chose its native `bash` tool. Their transcript rows were synthesized failures with:

`reason=missing_tool_result`

The visible gateway label “Bash failed” therefore described a missing native projection result, not a durable-exec failure. This happened while the live checkout had mixed old/new lazy artifacts from the earlier in-place build state. After restoring a complete immutable generation and restarting through the safe wrapper:

- Immediate native Bash diagnostic: `NATIVE_BASH_OK`, exit 0.
- Five-second native Bash diagnostic: `NATIVE_BASH_LONG_OK`, exit 0.
- Both used `auth-profile`; `toolSummary.failures=0`.

The durable proof was then rerun explicitly through the new channel-owned `async_exec` surface.

### Genuine live runs

Two gateway agent turns were launched concurrently with distinct session keys and the same existing WhatsApp destination. Each invoked `async_exec` once with a six-second command.

Sanitized agent results:

```json
{"status":"ok","summary":"completed","text":"You can keep talking while it finishes.","durationMs":13078,"authMode":"auth-profile","toolSummary":{"calls":1,"tools":["async_exec"],"failures":0}}
{"status":"ok","summary":"completed","text":"You can keep talking while it finishes.","durationMs":13618,"authMode":"auth-profile","toolSummary":{"calls":1,"tools":["async_exec"],"failures":0}}
```

Terminal task rows:

```json
[
  {
    "task_id": "b82e4024-19dc-4fb0-91e6-5e5e3be200c6",
    "runtime": "cli",
    "task_kind": "exec",
    "source_id": "vivid-basil",
    "requester_session_key": "agent:main:gateway-proof-final-a",
    "status": "succeeded",
    "notify_policy": "done_only",
    "delivery_status": "delivered",
    "started_at": 1785258595377,
    "ended_at": 1785258601463,
    "terminal_summary": "ASYNC_PROOF_A_OK"
  },
  {
    "task_id": "66aeb0c1-94ec-48a9-b7b3-d34deee22e8d",
    "runtime": "cli",
    "task_kind": "exec",
    "source_id": "gentle-prairie",
    "requester_session_key": "agent:main:gateway-proof-final-b",
    "status": "succeeded",
    "notify_policy": "done_only",
    "delivery_status": "delivered",
    "started_at": 1785258608729,
    "ended_at": 1785258614751,
    "terminal_summary": "ASYNC_PROOF_B_OK"
  }
]
```

### Non-zero counters

Before genuine runs:

```json
[
  { "table_name": "agent_mutation_locks", "row_count": 0 },
  { "table_name": "agent_external_effects", "row_count": 0 },
  { "table_name": "agent_external_effect_events", "row_count": 0 },
  { "table_name": "agent_job_checkpoints", "row_count": 0 }
]
```

After genuine runs:

```json
[
  { "table_name": "agent_mutation_locks", "row_count": 1 },
  { "table_name": "agent_external_effects", "row_count": 2 },
  { "table_name": "agent_external_effect_events", "row_count": 6 },
  { "table_name": "agent_job_checkpoints", "row_count": 2 }
]
```

`agent_freshness_results` remains 0 because freshness evaluation was not one of the three selected call sites. The requested async job, effect, and lock paths are all non-zero.

### Actual lock, effect, event, and checkpoint rows

The private destination is deliberately not reproduced. The exact hashed resource identity is retained.

Lock row:

```json
{
  "resource_key": "message:794597def43cdc46a9bae200",
  "fencing_token": 2,
  "owner_id": null,
  "owner_run_id": null,
  "lease_expires_at": null,
  "acquired_at": null,
  "updated_at": 1785258615338
}
```

The single same-resource row and fencing token 2 prove that both terminal deliveries acquired the destination lock rather than serializing the entire sessions.

Effect rows:

```json
[
  {
    "idempotency_key": "effect:6fda511bb5a4c249f9c379a7aae5e5cd1dc3b078d372dbd4197b0da1549e448c",
    "job_id": "b82e4024-19dc-4fb0-91e6-5e5e3be200c6",
    "run_id": "exec:vivid-basil",
    "logical_slot": "task-terminal:b82e4024-19dc-4fb0-91e6-5e5e3be200c6:succeeded:default",
    "effect_kind": "message.task-notification",
    "resource_key": "message:794597def43cdc46a9bae200",
    "payload_hash": "8faf40cd7830e2f3bfe40e706ca94fc9835dcf9d4342bea184392da079756d60",
    "status": "applied",
    "error": null,
    "created_at": 1785258601483,
    "updated_at": 1785258602065
  },
  {
    "idempotency_key": "effect:753e9fdf7d1cec19ef5fdfc931b8cae7dd3a5adc111f6c9d655c116b54cbc4e3",
    "job_id": "66aeb0c1-94ec-48a9-b7b3-d34deee22e8d",
    "run_id": "exec:gentle-prairie",
    "logical_slot": "task-terminal:66aeb0c1-94ec-48a9-b7b3-d34deee22e8d:succeeded:default",
    "effect_kind": "message.task-notification",
    "resource_key": "message:794597def43cdc46a9bae200",
    "payload_hash": "1432ebba3f1bc3842b81e5f8826e14b23136f77b110a976cec1bac0ee4d1bac8",
    "status": "applied",
    "error": null,
    "created_at": 1785258614753,
    "updated_at": 1785258615337
  }
]
```

Event rows:

```json
[
  {
    "sequence": 1,
    "idempotency_key": "effect:6fda511bb5a4c249f9c379a7aae5e5cd1dc3b078d372dbd4197b0da1549e448c",
    "status": "prepared",
    "created_at": 1785258601483
  },
  {
    "sequence": 2,
    "idempotency_key": "effect:6fda511bb5a4c249f9c379a7aae5e5cd1dc3b078d372dbd4197b0da1549e448c",
    "status": "submitting",
    "created_at": 1785258601484
  },
  {
    "sequence": 3,
    "idempotency_key": "effect:6fda511bb5a4c249f9c379a7aae5e5cd1dc3b078d372dbd4197b0da1549e448c",
    "status": "applied",
    "created_at": 1785258602065
  },
  {
    "sequence": 4,
    "idempotency_key": "effect:753e9fdf7d1cec19ef5fdfc931b8cae7dd3a5adc111f6c9d655c116b54cbc4e3",
    "status": "prepared",
    "created_at": 1785258614753
  },
  {
    "sequence": 5,
    "idempotency_key": "effect:753e9fdf7d1cec19ef5fdfc931b8cae7dd3a5adc111f6c9d655c116b54cbc4e3",
    "status": "submitting",
    "created_at": 1785258614753
  },
  {
    "sequence": 6,
    "idempotency_key": "effect:753e9fdf7d1cec19ef5fdfc931b8cae7dd3a5adc111f6c9d655c116b54cbc4e3",
    "status": "applied",
    "created_at": 1785258615337
  }
]
```

Checkpoint rows:

```json
[
  {
    "job_id": "b82e4024-19dc-4fb0-91e6-5e5e3be200c6",
    "checkpoint_key": "exec.background",
    "item_key": "vivid-basil",
    "result_json": "{\"status\":\"succeeded\",\"runId\":\"exec:vivid-basil\",\"exitCode\":0}",
    "completed_at": 1785258601463
  },
  {
    "job_id": "66aeb0c1-94ec-48a9-b7b3-d34deee22e8d",
    "checkpoint_key": "exec.background",
    "item_key": "gentle-prairie",
    "result_json": "{\"status\":\"succeeded\",\"runId\":\"exec:gentle-prairie\",\"exitCode\":0}",
    "completed_at": 1785258614751
  }
]
```

Restart idempotency proof:

```text
before effects/events/checkpoints: 2/6/2
safe restart: HTTP 200, WhatsApp reconnected
after effects/events/checkpoints:  2/6/2
```

No extra effect or event appeared after restart, so delivered task notifications were not resent.

## Part 2 — make live builds outage-safe

### Design

`pnpm build` now builds in an isolated staging workspace. A completed version is moved into `.openclaw-builds/versions/<build-id>`, and public output paths point through `.openclaw-builds/current`. Activation replaces only symlinks, atomically.

Each immutable version owns:

- `dist`
- `dist-runtime`
- built package outputs
- a pinned `node_modules/openclaw` self-reference
- dependency links required by lazy imports

The version root deliberately has no `package.json`; this keeps source-checkout plugin discovery and templates anchored at the real repo root. The nested self package provides package exports to versioned chunks.

The current and immediately previous output histories seed the next version before fresh artifacts overlay them. This keeps lazily requested hashed chunks available to a process whose loader retained a prior generation name.

### Files

- `package.json`
  - Routes `pnpm build` through `scripts/live-safe-build.mjs`.
- `scripts/live-safe-build.mjs`
  - Isolated staging build.
  - Completeness validation.
  - Immutable version storage.
  - Atomic symlink activation and rollback.
  - Pinned self/dependency package layout.
  - Current/previous lazy-chunk carry-forward.
- `test/scripts/live-safe-build.test.ts`
  - Covers atomic activation, self-resolution, dependency resolution, package boundary, explicit enable/disable, and lazy history carry-forward.
- `/Users/clawdmac/clawd/bin/openclaw-safe-restart.sh`
  - Refuses restart while a build is active.
  - If a staged version is pending: stops the gateway, activates, and bootstraps with retry.
  - Otherwise uses `launchctl kickstart`.
  - Requires HTTP 200 and a fresh WhatsApp reconnect before success.

### Live-build proof

Final proof artifact directory: `/tmp/openclaw-live-build-proof-final.4r21SK`

```text
build_status=0
gateway PID before=75350
gateway PID after=75350
HTTP samples=1092
HTTP 200=1092
all other HTTP results=0
new ERR_MODULE_NOT_FOUND=0
activated generation=2026-07-28T17-03-48-259Z-77595
```

Generation validation:

```text
version-root package.json: absent
node_modules/openclaw/package.json: present
node_modules/openclaw/dist/index.js: present
top-level versioned JS chunks: 7775
previous-generation chunks missing from current: 0
```

The gateway then restarted only through `/Users/clawdmac/clawd/bin/openclaw-safe-restart.sh`:

```text
OK: gateway restarted, HTTP 200, WhatsApp reconnected
```

Post-activation lazy/runtime proof:

- `import('./dist/index.js')`: succeeded.
- Immediate native Bash agent turn: succeeded.
- Five-second native Bash agent turn: succeeded.
- Two `async_exec` agent turns: succeeded and delivered.
- `ERR_MODULE_NOT_FOUND` after the final build/activation: 0.

## Validation

Required type gate:

```text
pnpm tsgo --noEmit -p tsconfig.json
exit 0
```

Focused Part 1 core tests:

```text
node scripts/run-vitest.mjs \
  src/tasks/cli-task-cancel.test.ts \
  src/tasks/task-registry.maintenance.issue-60299.test.ts \
  src/tasks/task-registry.test.ts \
  src/tasks/task-registry-delivery-runtime.test.ts \
  src/agents/agent-job-checkpoints.test.ts \
  src/agents/bash-tools.test.ts \
  src/agents/tools/media-generate-background-shared.test.ts

7 files passed; 190 tests passed
```

Focused Codex activation tests:

```text
node scripts/run-vitest.mjs \
  extensions/codex/src/app-server/dynamic-tool-build.test.ts \
  extensions/codex/src/app-server/run-attempt.test.ts

2 files passed; 171 tests passed
```

Focused Part 2 tests:

```text
node scripts/run-vitest.mjs test/scripts/live-safe-build.test.ts

1 file passed; 5 tests passed
```

Additional checks:

```text
git diff --check
bash -n /Users/clawdmac/clawd/bin/openclaw-safe-restart.sh
pnpm exec oxfmt --check <touched code/test/build files>
```

All passed.

## Commits

- Part 1 commit title: `feat(gateway): activate durable multitasking paths`.
- Part 2 commit title: `fix(build): atomically activate live gateway artifacts`.

OUTCOME: DONE
