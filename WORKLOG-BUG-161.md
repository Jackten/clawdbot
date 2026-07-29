# BUG-161 native-hook relay recovery worklog

## Scope

Jack authorized a bounded overlay fix for the Codex native-hook relay memory/death spiral:

- establish the mechanical failure chain without overstating the historical evidence;
- bound the proven relay-process memory amplifier;
- recover live relay registration/bridge damage and return a typed retryable gap;
- add focused regressions and a deterministic live proof;
- build, activate once through the guarded restart wrapper, commit, and push the overlay.

No Claw app files, QA fleets, emulators, channel delivery, or metered model APIs were used.

## Root cause

### 1. The exact 9.6 GB allocator is not proven

The retained July 20 sampler recorded only `PID:RSS`. It did not preserve the sampled command,
parent PID, process tree, `vmmap`, or a heap snapshot. It proves that PID 21846 grew from about
277 MB to 9,578 MB within one ten-second interval and then disappeared; it does **not** prove the
process identity or whether the bytes were V8 heap, external buffers, or another native allocation.
The older BUG-161 statement that PID 21846 was mechanically identified as a Codex native child is
therefore stronger than the surviving evidence.

The matching Codex build has one high-confidence candidate: Code Mode uses a process-wide,
lazy-spawned `codex-code-mode-host`, and each cell creates a V8 isolate with default
`CreateParams` and no explicit heap cap. The event timing places the spike after a Code Mode cell
and before the next raw Playwright call. That makes the uncapped Code Mode host/V8 cell the leading
candidate, but not a proven allocator. No speculative V8 limit was added in OpenClaw; that source
belongs to Codex and the missing process/heap evidence prevents choosing a safe cap here.

Dependency contract checked directly in the sibling Codex source:

- `../codex/codex-rs/code-mode/src/remote_session.rs`: one lazy host, respawned on later use after
  process failure.
- `../codex/codex-rs/code-mode/src/runtime/mod.rs`: default V8 isolate parameters, no heap cap.
- `../codex/codex-rs/hooks/src/engine/command_runner.rs`: hooks run through `$SHELL -lc`;
  `kill_on_drop(true)` and timeout cancellation own only that direct shell child, not a detached
  descendant/process group.

### 2. A separate relay-process memory amplifier is proven

The generated POSIX hook command previously put the real Node relay behind a shell. OpenClaw's
launcher, startup respawn, and compile-cache respawn paths could add further handoffs. When Codex
timed out a hook it killed only the direct shell child. The real `hooks relay` Node process could
survive detached. Repeated hooks accumulated 200–490 MB processes; incident evidence found 49
relay-family processes using about 6.4 GB in aggregate.

This is the root cause documented and fixed upstream by OpenClaw issue #109421, PR #109446, and
commit `51b31fc131a`. This overlay was missing that fix. The exact upstream ownership change was
ported: generated POSIX relay commands now start with `exec`, and all general/startup/compile-cache
respawn layers bypass `hooks relay`. Codex's timeout now owns the final Node PID, so a timeout
cannot leave an OpenClaw relay descendant consuming memory.

### 3. “Relay died” combined three different lifecycles

There is no persistent native-hook relay daemon. Each hook launches a one-shot
`openclaw hooks relay` client. The actual registration is an in-memory, run-owned callback in the
Gateway, with a loopback HTTP bridge record used as the fast path.

- Killing a one-shot relay client does not remove the registration; the next hook launches a new
  client.
- Accidental loss of the registration map entry or bridge listener while the same run owner is
  alive previously had no recovery owner. Calls fell through to permanent `INVALID_REQUEST`.
- Complete Gateway/run-owner death destroys the callback closure. An old relay ID cannot safely
  reconstruct it; stale/unknown IDs must remain invalid and a new run must register a new
  generation.

The fresh July 29 `native hook relay not found` lines at 06:09:50 and 06:10:02 came from task
`6c2d1439-cfe9-477b-a139-ea299fe5cd1e`. That failure matches BUG-194: parent cleanup removed the
run-owned registration before a detached descendant finished. The overlay already contained the
BUG-194 owner-lifetime fix (`bc37eae2fce`, `2d2cd737c28`, `d4684bc2057`, `dcd33aac41e`) before
this work. This change adds the missing live-owner supervisor and retry protocol; it does not
pretend that a destroyed owner closure can be resurrected.

## Fix

Commit `5ceda3cf241` (`fix(codex): recover native hook relay failures`) changes:

- `src/agents/harness/native-hook-relay.ts`
  - makes POSIX hook commands timeout-owned with `exec`;
  - adds an owner-fenced supervisor independent of the live registration/bridge maps;
  - repairs a missing registration or unexpectedly closed bridge after 100 ms;
  - backs off failed repairs to two seconds;
  - stops recovery on abort, expiry, explicit unregister, or replacement;
  - rereads the bridge locator on every retry so a rebind to a new port/token is usable.
- `src/gateway/server-methods/native-hook-relay.ts`
  - returns `UNAVAILABLE`, `retryable: true`, `retryAfterMs: 100`, and reason
    `native-hook-relay-recovering` only for a live supervised recovery gap;
  - keeps unknown, expired, stale-generation, and dead-owner IDs as `INVALID_REQUEST`.
- `src/cli/native-hook-relay-cli.ts`
  - retries only the typed retryable `UNAVAILABLE` response within the existing hook deadline.
- `src/cli/respawn-policy.ts`, `src/entry.respawn.ts`, `src/entry.compile-cache.ts`,
  and `openclaw.mjs`
  - keep POSIX `hooks relay` on one timeout-owned PID.

The best-fix judgment is to combine the exact upstream process-ownership fix with an
owner-fenced, event-driven in-process supervisor. Reconstructing callbacks from a stale ID would
cross the run ownership/security boundary; polling or a permanent daemon would add lifecycle and
memory surface without recovering the missing closure.

## Regression coverage

The new focused tests fail on the pre-fix behavior and cover:

- registration loss -> retryable Gateway response -> restored invocation;
- unexpected bridge close -> new locator/token -> successful invocation;
- abort/unregister/replacement fencing so a pending recovery cannot resurrect dead state;
- CLI retry classification and deadline bounding;
- unknown/stale registrations remaining fail-closed;
- POSIX timeout-owned PID identity and no surviving Node descendant;
- launcher, startup-respawn, and compile-cache bypass for `hooks relay`;
- Windows launcher behavior remaining unchanged.

## Validation

- `node scripts/run-vitest.mjs src/agents/harness/native-hook-relay.test.ts src/gateway/server-methods/native-hook-relay.test.ts src/cli/native-hook-relay-cli.test.ts src/cli/cli-utils.test.ts src/entry.respawn.test.ts src/entry.compile-cache.test.ts`
  - PASS: 200 focused assertions/tests across the reported groups.
- `node scripts/run-vitest.mjs src/cli/hooks-cli.process.test.ts test/openclaw-launcher.e2e.test.ts`
  - PASS: 41 focused process/launcher checks; one unrelated platform case skipped.
- `node scripts/run-vitest.mjs src/cli/native-hook-relay-cli.test.ts src/agents/harness/native-hook-relay.test.ts src/gateway/server-methods/native-hook-relay.test.ts`
  - PASS: 116 focused assertions/tests after final retry-classification coverage.
- `node scripts/run-vitest.mjs src/agents/harness/native-hook-relay.test.ts src/gateway/server-methods/native-hook-relay.test.ts src/cli/native-hook-relay-cli.test.ts src/cli/cli-utils.test.ts src/entry.respawn.test.ts src/entry.compile-cache.test.ts src/cli/hooks-cli.process.test.ts test/openclaw-launcher.e2e.test.ts`
  - PASS: 244 targeted tests in one final run; one unrelated platform case skipped.
- `pnpm tsgo --noEmit -p tsconfig.json`
  - PASS.
- `git diff --check`
  - PASS.
- `.agents/skills/autoreview/scripts/autoreview --mode local --stream-engine-output`
  - PASS with no accepted/actionable findings.
- `pnpm build`
  - PASS; immutable build `2026-07-29T14-04-05-946Z-93767`, commit
    `5ceda3cf24131606901bf2426b9feebddd3f9712`.
- `/Users/clawdmac/clawd/tasks/proofs/bug161-relay-recovery.sh`
  - PASS in 17.54 seconds.
  - Killed timeout-owned relay PID 12484, observed zero surviving descendants, and executed the
    replacement hook.
  - Killed live relay client PID 12738, then completed both a direct Gateway
    `nativeHook.invoke` and a replacement production `hooks relay` invocation against Gateway
    PID 4910.

## Activation and live proof

The immutable build was activated once at 10:20 AST through
`/Users/clawdmac/clawd/bin/openclaw-safe-restart.sh`, after the update-window, peer-build,
recent-traffic, and fresh-running-session guards were clear. The wrapper returned:

`OK: gateway restarted, HTTP 200, WhatsApp reconnected`

The Gateway moved from PID 49442 to PID 4910. `gateway call health` returned `ok: true`, all
loaded plugins reported no errors, and the activated `dist/build-info.json` names commit
`5ceda3cf24131606901bf2426b9feebddd3f9712`.

The proof uses only a no-delivery, message-tool-disabled, subscription-authenticated isolated
session. Supported production controls cannot selectively delete the Gateway's co-resident
registration map entry while preserving its owner callback. Therefore the live leg proves the
supported client-death path, while the focused regression tests deterministically prove the
supervised missing-registration/closed-bridge recovery gap and its typed retryable response.

OUTCOME: DONE
