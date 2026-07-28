# Smart-home outage fix worklog

Date: 2026-07-27 America/Puerto_Rico (2026-07-28 UTC)

## Result

The Mac-primary OpenClaw gateway is rebuilt, restarted, healthy, and serving the fixed
`talk.client.toolCall` path. The exact requested live `control_home` probe succeeded after a real
gateway restart:

```json
{
  "result": {
    "response": "Confirmed from Home Assistant: 1 of 10 fixture lights are on."
  }
}
```

Stages 1–4 and the existing blocker fixes were left in place. The stale-dist module error was not
re-investigated; the final full build and direct LaunchAgent restart replaced the stale output.

## Root cause 1: gateway-tool execution was removed

The client-owned WebRTC gateway-tool dispatcher previously existed in exact worktree snapshot
`8b4b476f552` (`openclaw-live exact worktree snapshot 20260726T201425-0400`). That snapshot imported
and called `runTalkRealtimeGatewayTool`, found tools in `buildTalkRealtimeConfig(...).gatewayTools`,
and returned the synchronous result.

Stage 2 then intentionally reversed that behavior. `WORKLOG-MS2.md:91-92` says configured host
executables were to remain relay-owned and that `talk.client.toolCall` could not invoke them;
`WORKLOG-MS2.md:122-124` says `talk-client.ts` kept configured executables off the client-owned RPC.
The overwrite was therefore a Stage 2 security-policy change, not an accidental uncommitted-file
loss. It removed the already-working WebRTC fast path and forced smart-home requests away from the
configured `control_home` tool.

## Root cause 2: ownership was connection-bound and process-local

The new Stage 2 registry keyed browser Talk ownership only by WebSocket `connId` in an in-memory
`Map`. `talk.client.create` recorded the connection that obtained the provider session, while
`talk.client.toolCall` required that exact connection ID. A phone reconnect received a new
connection ID; a gateway restart erased the entire map. The still-active provider WebRTC session
therefore became permanently unclaimable until another browser session was created in the same
gateway process.

The production log proves the connection churn:

- 2026-07-27T05:06:56Z: success on `conn=955ec0c9…fc5d`.
- 2026-07-27T14:13:28Z and 14:13:34Z: success on `conn=56ca32fa…593a`.
- 2026-07-27T15:26:30Z: ownership rejection on `conn=227497fc…2a62`.
- 2026-07-27T21:15:20Z: ownership rejection on `conn=d880295e…922f`.
- 2026-07-28T02:48:23Z, 02:48:33Z, and 02:49:13Z: repeated ownership rejections on
  `conn=a9cfef68…3950`.

The connection ID changed even though the active user/device and session key had not. The gateway
restart also necessarily destroyed the process-local ownership record.

## Fix

### Client-owned configured gateway tools

- `src/gateway/server-methods/talk-client.ts:231-270` restores configured gateway-tool dispatch
  after the ownership check.
- It reads from `buildTalkRealtimeConfig(...).gatewayTools`, rejects unknown tools, uses
  `tool.argKey ?? "command"`, and invokes the relay-owned runner with the same
  `GATEWAY_TOOL_TIMEOUT_MS`, `GATEWAY_TOOL_MAX_BUFFER_BYTES`, `shell: false`, UTF-8 encoding, and
  error formatter (`talk-client.ts:246-267`).
- It responds synchronously with `{ result: { response } }` or `{ result: { error } }`; the Android
  contract was not changed.
- `packages/gateway-protocol/src/schema/channels.ts:242-265` now publishes the existing asynchronous
  consult result or the synchronous gateway-tool result. Validator coverage is at
  `packages/gateway-protocol/src/index.test.ts:645-650`.

### Reconnect-safe ownership without deleting the gate

- `src/gateway/talk-client-session-registry.ts:44-65` derives a stable authenticated owner:
  the signed installation/device ID for the phone, or a narrowly-scoped local-admin identity for
  the one-shot CLI only when shared gateway auth, the gateway's trusted local-connection decision,
  canonical client ID `cli`, and mode `cli` all match.
- `src/gateway/server/ws-connection/message-handler.ts:1996-2005` carries the already-computed
  `isLocalClient` decision into authenticated request metadata. This is safer than reconstructing
  locality from `clientIp`, because local addresses are intentionally redacted from that field.
- `src/gateway/talk-client-session-registry.ts:67-121` persists signed/stable owner leases in the
  shared state database for 30 minutes.
- `src/gateway/talk-client-session-registry.ts:127-186` verifies the same owner and session key,
  rotates the current connection ID, and refreshes the lease. A different signed device has no row
  and is rejected. Clients without a stable authenticated owner retain the original strict
  connection-only behavior.
- `src/state/openclaw-state-schema.sql:358-367` defines `talk_client_sessions` and its expiry index;
  generated Kysely schema/type files were refreshed and verified.
- `src/gateway/server-methods/talk-client.ts:155-159`, `:214-230`, and the steer path all use the
  same stable-owner resolver.

The deployment seeded one 30-minute lease for Jack's already-active signed phone installation
because the pre-fix gateway process could not have persisted its earlier `talk.client.create`.
The row intentionally had no session key; the first legitimate phone call binds its actual session
key. This is a one-time deployment handoff, not a wildcard: only that signed device can claim it.
The normal create path writes future leases itself.

## Regression tests

The requested focused test commands were run one file at a time with the repository wrapper.

### Handler behavior

Command:

```text
node scripts/run-vitest.mjs src/gateway/server-methods/talk.test.ts
```

Final real output:

```text
[test] starting test/vitest/vitest.gateway.config.ts
The `envFile` option is deprecated, please use `envDir: false` instead.
The `envFile` option is deprecated, please use `envDir: false` instead.
The `envFile` option is deprecated, please use `envDir: false` instead.
The `envFile` option is deprecated, please use `envDir: false` instead.
The `envFile` option is deprecated, please use `envDir: false` instead.

 RUN  v4.1.9 /Users/clawdmac/src/openclaw-live

 Test Files  2 passed (2)
      Tests  110 passed (110)
   Start at  23:25:59
   Duration  3.36s (transform 1.18s, setup 185ms, import 1.86s, tests 1.21s, environment 0ms)

[test] passed 1 Vitest shard in 10.26s
```

The gateway Vitest project routes this input through two configured files. Relevant cases are:

- configured gateway tool executes with the relay runner limits and returns output:
  `src/gateway/server-methods/talk.test.ts:2722-2769`;
- unknown tool remains rejected: `talk.test.ts:2771-2808`;
- reconnect by the owning signed device succeeds: `talk.test.ts:2810-2854`;
- authenticated one-shot local CLI connections retain the same owner across connections:
  `talk.test.ts:2856-2911`;
- foreign signed device is rejected: `talk.test.ts:2913-2955`.

### Ownership registry, including database reopen

Command:

```text
node scripts/run-vitest.mjs src/gateway/talk-client-session-registry.test.ts
```

Final real output:

```text
[test] queued behind the local heavy-check lock held by tsgo, pid 7374, cwd /Users/clawdmac/src/openclaw-live...
[test] starting test/vitest/vitest.gateway.config.ts
The `envFile` option is deprecated, please use `envDir: false` instead.
The `envFile` option is deprecated, please use `envDir: false` instead.
The `envFile` option is deprecated, please use `envDir: false` instead.
The `envFile` option is deprecated, please use `envDir: false` instead.
The `envFile` option is deprecated, please use `envDir: false` instead.

 RUN  v4.1.9 /Users/clawdmac/src/openclaw-live

 Test Files  3 passed (3)
      Tests  15 passed (15)
   Start at  23:26:25
   Duration  1.17s (transform 227ms, setup 222ms, import 166ms, tests 623ms, environment 0ms)

[test] passed 1 Vitest shard in 18.03s
```

The gateway project routes this input through three configured files. The database-close/reopen
reconnect proof is `src/gateway/talk-client-session-registry.test.ts:50-67`; foreign-device denial
is `:69-85`.

### Published protocol result

Command:

```text
node scripts/run-vitest.mjs packages/gateway-protocol/src/index.test.ts
```

Real output:

```text
[test] starting test/vitest/vitest.unit.config.ts
The `envFile` option is deprecated, please use `envDir: false` instead.

 RUN  v4.1.9 /Users/clawdmac/src/openclaw-live

 Test Files  1 passed (1)
      Tests  51 passed (51)
   Start at  23:31:14
   Duration  352ms (transform 142ms, setup 96ms, import 116ms, tests 79ms, environment 0ms)

[test] passed 1 Vitest shard in 3.07s
```

## Static validation and review

The first literal unguarded typecheck attempt was run and failed before TypeScript started because
the repository's patched pnpm dependency guard tried to replace `node_modules` non-interactively:

```text
Scope: all 162 workspace projects
[ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY] Aborted removal of modules directory due to no TTY
[ERROR] Command failed with exit code 1: pnpm install
```

No dependency mutation was allowed. The supported guard override was then used; the actual
`pnpm tsgo --noEmit -p tsconfig.json` command completed with exit 0 and zero diagnostics after the
final code change:

```text
$ pnpm tsgo:core --noEmit -p tsconfig.json
$ node scripts/run-tsgo.mjs -p tsconfig.core.json --incremental --tsBuildInfoFile .artifacts/tsgo-cache/core.tsbuildinfo --noEmit -p tsconfig.json
```

Exact shell invocation:

```text
pnpm_config_verify_deps_before_run=false pnpm tsgo --noEmit -p tsconfig.json
```

Additional real checks:

```text
node scripts/generate-kysely-types.mjs --verify
(node:97751) ExperimentalWarning: SQLite is an experimental feature and might change at any time
```

`git diff --check` on every hotfix file exited 0 with no output.

The mandatory final `autoreview` completed with no findings:

```text
autoreview clean: no accepted/actionable findings reported
overall: patch is correct (0.91)
No actionable defect was found in the scoped correction. The WebSocket handler now carries the
precomputed local-client decision into authenticated client metadata, and the shared-auth CLI owner
path remains gated on shared gateway auth, local connection status, and the canonical CLI id/mode
predicate. Signed-device ownership and foreign-device rejection are not broadened by this change.
```

An earlier review found one real protocol-schema omission; it was fixed and covered by the protocol
test above. Other earlier review findings were isolated-bundle artifacts involving unrelated
Stage files; the real full-tree typecheck and production build resolved those modules.

## Build, restart, and live proof

Final build command:

```text
pnpm_config_verify_deps_before_run=false pnpm build
```

Selected real final output:

```text
[build-all] tsdown done in 119.5s
CLI bootstrap import guard passed.
[build-all] runtime-postbuild done in 891ms
OK: All 4 required plugin-sdk exports verified.
✓ 1012 modules transformed.
✓ built in 435ms
[build-all] phase timings: total 123.4s; slowest tsdown 119.5s; ui:build 941ms; runtime-postbuild 891ms
```

The gateway was restarted directly as authorized:

```text
launchctl kickstart -k gui/501/ai.openclaw.gateway
```

`openclaw-safe-restart.sh` was deliberately not used because its
`pgrep -f "tsdown|pnpm.*build"` check false-positives on agent prompt command lines containing
`build`.

After creating both legitimate owner leases, a second direct restart produced:

```text
Runtime: running (pid 8586, state active)
Connectivity probe: ok
Capability: admin-capable
Listening: 127.0.0.1:18789, [::1]:18789
```

A read-only post-restart database check showed both leases active: Jack's signed phone owner
(redacted to `6aa4ee00...`) and `shared-gateway-auth:local-cli` with
`sessionKey="agent:main:main"`. The gateway log then recorded:

```text
⇄ res ✓ talk.client.toolCall 195ms conn=e8a72e50…ddd1
```

There were two honest failed deployment probes before the final success. The first proved that an
unsigned CLI connection remained connection-bound across restart. The second revealed that local
addresses are intentionally absent from `clientIp`; this led to carrying the gateway's trusted
`isLocalClient` decision instead of guessing locality. Both issues were fixed, retested, reviewed,
rebuilt, and redeployed before the successful proof below.

Exact required command:

```text
openclaw gateway call talk.client.toolCall --params '{"sessionKey":"agent:main:main","callId":"probe","name":"control_home","args":{"command":"which lights are on"}}' --json
```

Exit code: `0`

Real response:

```json
{
  "result": {
    "response": "Confirmed from Home Assistant: 1 of 10 fixture lights are on."
  }
}
```

OUTCOME: DONE
