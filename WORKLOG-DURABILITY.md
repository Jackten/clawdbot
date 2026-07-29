# Gateway durability stage worklog

Date: 2026-07-28 (America/Puerto_Rico)
Starting revision: `d4a980f20f2`
Branch: `overlay/mac-custom-v2026.7.1-update-20260716T035951-reviewed`

## Outcome summary

All three requested parts are implemented and verified. Conversation-turn recovery and the
BUG-190 fix are live in build `2026-07-28T23-36-15-519Z-46910`. The external auth-repair
automation now invokes the safe restart wrapper. No proof command used `--deliver`, and no
message was sent to Jack's channels.

## Part 1 — Conversation-run durability

Commit: `0326b31ed1d` (`Durably recover interrupted conversation turns`)

### Design

- Accepted inbound turns are stored transactionally in the shared state SQLite database before
  model/tool work starts. The durable record includes channel, account, sender, delivery target,
  thread, session key, provider message ID, a SHA-256 content reference, accepted time, stable
  original/recovery queue IDs, lifecycle status, delivery evidence, and recovery error state.
- A turn is not treated as accepted unless its SQLite row can be read back from the completed
  write transaction. Repeated provider delivery of the same identity resolves to the same turn.
- Model prose never marks a turn successful. `succeeded` is written only after the final reply
  dispatcher settles and durable delivery evidence exists. Explicit no-send and untracked
  terminal outcomes have separate states.
- The outbound effect ledger and stable per-turn queue IDs are the idempotency boundary. Startup
  recovery checks sent and pending delivery evidence before acting.
- If dispatch may have happened but the terminal ledger write is missing, startup recovery marks
  the turn `unknown`; it never blindly reruns model work. A pending partial reply is quarantined,
  and exactly one durable notice is queued to the original route:
  `Your message at HH:MM was interrupted by a restart — resend or say "retry".`
- A sent original reply suppresses recovery when the terminal dispatcher evidence proves the turn
  completed. A queued or sent recovery notice survives the app/channel being offline and prevents
  a later startup from sending a duplicate.

### Repo files

- `src/agents/conversation-turn-durability.ts`
- `src/agents/conversation-turn-recovery.ts`
- `src/agents/conversation-turn-recovery.test.ts`
- `src/agents/main-session-restart-recovery.ts`
- `src/auto-reply/reply/agent-runner.ts`
- `src/channels/turn/durable-delivery.ts`
- `src/channels/turn/kernel.ts`
- `src/plugin-sdk/channel-outbound.ts`
- `src/state/openclaw-state-schema.sql` and generated state DB types/schema
- `extensions/whatsapp/src/auto-reply/monitor/inbound-dispatch.ts`

### Proof

- `node scripts/run-vitest.mjs src/agents/conversation-turn-recovery.test.ts
extensions/whatsapp/src/auto-reply/monitor/inbound-dispatch.test.ts
src/channels/turn/durable-delivery.test.ts`
  - 67 tests passed: 6 recovery, 54 WhatsApp inbound, 7 durable channel delivery.
  - The restart-shaped test closes the state DB at the simulated restart boundary and proves one
    recovery action across repeated startup recovery.
  - Delivered-reply evidence produces zero recovery actions.
- `pnpm tsgo --noEmit -p tsconfig.json` — clean.
- Fresh structured autoreview — no accepted/actionable findings.

### Deployment state

The commit was initially left dark while Part 2 was still under diagnosis. It became live with
the final required BUG-190 activation at 19:38 AST. Startup found no recoverable accepted turn, so
no recovery message was emitted.

## Part 2 — BUG-190 compaction timeout

Commit: `690b37ed2fc` (`Use native Codex compaction for CLI turns`)

### Root cause

BUG-190 had two linked causes:

1. CLI pre-turn compaction labeled an operator-requested compaction as `budget`. The Codex harness
   intentionally skips non-manual requests because Codex owns automatic context-pressure
   compaction. The CLI then fell through to OpenClaw's context-engine compactor.
2. The oversized main transcript made that fallback expensive: the failing live probe presented
   733 messages, 451,657 history characters, 353,994 tool-result characters, and an estimated
   125,132 tokens. The fallback exhausted its 180,000 ms budget.
3. Changing the trigger to `manual` exposed the underlying lifecycle difference from auto-reply.
   The standalone CLI compactor leased a fresh/one-shot Codex app-server process and called
   `thread/compact/start` for a persisted binding before loading the thread. Codex returned
   `thread not found`. Auto-reply succeeds because normal run startup resumes the thread in the
   same app-server lifecycle before automatic compaction.

The large transcript aggravated the fallback but was not the native compactor's contract error.
It was archived by the existing session reset; this work did not truncate or destroy transcript
data.

### Dependency contract checked directly

- `../codex/codex-rs/app-server/src/request_processors/thread_processor.rs`:
  `thread/compact/start` requires the thread to be loaded in the app-server process and returns
  `thread not found` otherwise.
- `../codex/codex-rs/app-server-protocol/src/protocol/v2/thread.rs`:
  `thread/resume` is the persisted-thread loading operation and supports resuming by thread ID.

### Fix

- CLI pre-turn native compaction now uses the manual trigger.
- After a structured `thread not found` rejection, the Codex plugin resumes the durable thread
  binding with `excludeTurns: true`, installs a new completion watcher, and retries native
  compaction once.
- Manual and automatic native starts now share the binding lease and clear stale context-engine
  projection metadata before a successful start.
- Start RPCs are bounded by the configured app-server request timeout. Long-lived completion timers
  are armed after the binding lease is released so timeout cleanup cannot inherit stale lease
  ownership.
- Structured RPC rejection, ambiguous transport failure, changed binding, abort, and stale binding
  states remain distinct; there is no blind retry after an ambiguous dispatch.

### Repo files

- `src/agents/command/cli-compaction.ts`
- `src/agents/command/cli-compaction.test.ts`
- `extensions/codex/src/app-server/compact.ts`
- `extensions/codex/src/app-server/compact.test.ts`

### Proof

- `node scripts/run-vitest.mjs src/agents/command/cli-compaction.test.ts
extensions/codex/src/app-server/compact.test.ts`
  - 59 tests passed: 20 CLI-compaction and 39 Codex native-compaction tests.
- `pnpm tsgo --noEmit -p tsconfig.json` — clean.
- Fresh structured autoreview after two accepted fixes — no accepted/actionable findings.
- Isolated live-safe build completed and activated
  `2026-07-28T23-36-15-519Z-46910`.
- Exact live proof, with no delivery:
  `openclaw agent --agent main -m "Reply with exactly CLI_COMPACTION_PROBE_OK. Do not use tools."
--json`
  - run `260e8903-26c8-467a-b858-cfb79efd1b31`
  - status `ok`, stop reason `stop`, output `CLI_COMPACTION_PROBE_OK`
  - completed in 4.0 seconds with no compaction timeout
  - no `--deliver`; no channel message
- `/Users/clawdmac/clawd/memory/bugs/open/BUG-190.md` now records the root cause, fix,
  dependency proof, and live evidence.

## Part 3 — auth-repair restart hygiene

This part is intentionally outside the repository and has no repo commit.

### Files inspected or changed

- Inspected LaunchAgent:
  `/Users/clawdmac/Library/LaunchAgents/ai.openclaw.auth-repair.plist`
- Changed its invoked script:
  `/Users/clawdmac/.openclaw/bin/openclaw-repair-openai-auth-from-codex.sh`
- Safe wrapper used:
  `/Users/clawdmac/clawd/bin/openclaw-safe-restart.sh`

The plist already invokes the auth-repair script every 900 seconds, so no plist mutation was
required. The script's raw `launchctl kickstart` restart was replaced with the safe wrapper. Auth
logout/order repair, session cleanup, and optional smoke behavior are unchanged. The script also
supports `OPENCLAW_AUTH_REPAIR_DRY_RUN=1` and `--dry-run-restart` for non-mutating proof.

### Proof

- `/bin/zsh -n /Users/clawdmac/.openclaw/bin/openclaw-repair-openai-auth-from-codex.sh`
  — clean.
- `plutil -lint /Users/clawdmac/Library/LaunchAgents/ai.openclaw.auth-repair.plist`
  — `OK`.
- Isolated dry run printed
  `DRY RUN: /Users/clawdmac/clawd/bin/openclaw-safe-restart.sh` and logged that the safe wrapper
  would be invoked.
- The dry-run proof did not restart the gateway.
- Subsequent scheduled LaunchAgent activity independently confirmed the installed path: at 19:21
  it logged `idle + safe — restarting gateway`; at 19:37 the same wrapper refused a restart with
  `REFUSED: a build is running in the live repo`. These were timer-driven auth-repair runs, not
  proof restarts initiated by this test.

## Activation and operational notes

- A final restart was genuinely required to prove BUG-190 against the live gateway. At 19:38 AST,
  before the prohibited 21:44–22:14 window, preflight found gateway `HTTP 200`, no active build,
  and no recent conversation-run marker.
- `/Users/clawdmac/clawd/bin/openclaw-safe-restart.sh` reported
  `idle + safe — restarting gateway`; no raw restart or force option was used.
- The wrapper exited 2 because its combined `HTTP 200 + WhatsApp reconnect` condition was not seen
  within 60 seconds. Direct post-check showed LaunchAgent state `running`, a new gateway PID,
  `HTTP 200`, and the final build's bundle loaded. WhatsApp had already been in an independent
  reconnect loop before the restart.
- An earlier 19:14 safe activation of the trigger-only build produced the decisive
  `thread not found` evidence and a failed live probe; it led to the complete resume-on-miss fix.
- The remote Testbox pre-warm was unavailable because the installed Crabbox binary failed its
  version/help sanity check. The user-required focused Vitest and `tsgo` gates therefore ran
  locally through the repository wrappers.
- Existing user change `WORKLOG-BUG-189.md` was preserved and excluded from all commits.

OUTCOME: DONE
