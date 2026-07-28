# WORKLOG-BUG-189

## Outcome

Implemented source-level node containment for agent turns, hardened the QA fleet runner, deployed
the fix to the live Mac-primary gateway, and proved it with one isolated pinned emulator canary.

## Root cause

The affected agent paths shared session keys and carried sender ownership, but not the authenticated
node connection that originated a turn. The `nodes` tool then opened a local gateway client with
operator credentials, and `node.invoke` trusted its requested `nodeId` without comparing it with the
turn origin. Display-name collisions made accidental targeting easier but were not the authorization
failure.

## OpenClaw changes

- Resolve a requester node only when ingress came from that node's currently registered websocket.
- Carry `requesterNodeId` through chat, `agent.request`, node voice/agent events, queue collection,
  follow-ups, CLI runs, and embedded runs.
- Bind the allowed node and owner bit into the signed local agent-runtime identity.
- Bind CLI/MCP execution to its session and node with a process-scoped HMAC bearer; no caller header
  can choose the node scope.
- Filter agent-runtime `node.list` to the allowed node.
- Reject mismatched `node.describe` and `node.invoke` before wake, policy hooks, node lookup, or
  dispatch.
- Fail closed for unbound non-owner node access while preserving unbound owner/operator behavior.
- Allow a node-origin non-owner turn to receive `nodes`, but not `cron` or `gateway`.
- Deny node pairing list/approve/reject to non-owner agent-runtime callers.
- Apply `node.rename` changes to the live registry as well as persisted pairing state.

## QA fleet runner changes

`/Users/clawdmac/clawd/bin/qa-fleet.mjs` now:

- snapshots every pre-existing paired node as protected before fleet pairing;
- renames newly paired emulator nodes to `Claw-QA-<emulator-port>`;
- records an exact `allowedNodeId` for every paired QA worker and refuses duplicate, missing, or
  protected-node bindings;
- removes gateway credentials and uses an isolated OpenClaw state/config directory for each worker;
- refuses to launch any worker if that isolated worker environment can query the global node
  catalog;
- writes `NODE-CONTAINMENT.json` before worker launch.

## Regression proof

The touched regression set passed with 1,108 tests:

```text
node scripts/run-vitest.mjs <14 touched test files>
gateway:   460 passed
auto-reply: 467 passed
agents:    181 passed
```

The required type gate passed:

```text
pnpm tsgo --noEmit -p tsconfig.json
```

Additional checks:

```text
node --check /Users/clawdmac/clawd/bin/qa-fleet.mjs
autoreview --mode local: clean, no accepted/actionable findings
```

## Live deployment and isolated canary

Deployment evidence, 2026-07-28:

```text
commit=d4a980f20f2
generation_before=2026-07-28T17-03-48-259Z-77595
generation_after=2026-07-28T20-50-15-835Z-7455
build_status=0
HTTP during build: 491/491 = 200
gateway PID before restart=6846
safe restart=OK: gateway restarted, HTTP 200, WhatsApp reconnected
gateway PID after restart=10004
final gateway PID after independent auth-repair kickstart=12157
SM-S938U1 f26d45bc037b… paired=true connected=true
post-restart ERR_MODULE_NOT_FOUND=0
```

The build used `pnpm build`, which routed through `scripts/live-safe-build.mjs`. The running gateway
was never stopped or disturbed by the build. Before restart, the explicit last-three-minute gateway
log check found no inbound/run start and the session-state check found zero fresh running sessions.
Restart used only `/Users/clawdmac/clawd/bin/openclaw-safe-restart.sh`.

At 17:03:15, the pre-existing `ai.openclaw.auth-repair` LaunchAgent independently issued its legacy
raw kickstart after `models.authLogout`. It runs every 900 seconds and was not invoked by this
deployment. The immutable generation remained unchanged. Launchd recovered on PID 12157; five HTTP
probes and three node-list probes passed, Jack's phone reconnected, and the Talk proof below was
repeated on the final process. Migrating that separate auth-repair automation to the safe wrapper is
left to its supervising lane.

Post-restart Talk proof:

```text
talk.client.registerExternalSession => {"ok":true}
2026-07-28T17:04:44.118-04:00 talk gateway tool control_home failed
```

The tool probe supplied an empty string. The configured executable rejected it at its local usage
guard before reading a Home Assistant token or contacting Home Assistant; this exercised the
name-only success/failure logging path without a model/API call or device effect.

Canary:

```text
serial=emulator-5590
avd=claw-qa19
node=513689417b9d…
displayName=Claw-QA-5590
app=0.69.0-a70
```

The worker identity was a signed agent-runtime identity with:

```text
sessionKey=agent:main:bug-189-isolated-canary
allowedNodeId=513689417b9d…
senderIsOwner=false
```

Evidence:

- `node.list` exposed exactly the bound QA node.
- `node.describe` exposed the QA node as connected Android
  `sdk_gphone64_arm64`.
- `node.invoke(device.info)` on the QA node succeeded and returned Android 15 / SDK 35 and app
  `0.69.0-a70`, matching the emulator.
- `node.describe` and `node.invoke(device.info)` against Jack's `f26d45bc037b…` node both failed
  with `NODE_SCOPE_VIOLATION` / `agent turn is not authorized for this node`.
- The isolated fleet-worker environment could not query the global node catalog, so the exact
  binding preflight passed.
- A globally authenticated negative control produced the runner's exact refusal:
  `QA containment preflight: agent 1 can query the global node catalog; refusing to start any QA agents`.
- No model turn, chat, channel send, or phone action was performed.

Cleanup proof:

- Removed canary node pairing.
- Removed the canary's residual operator device pairing.
- Stopped `emulator-5590`.
- Final node registry exactly matched the two-phone protected baseline.

Evidence directory:

```text
.artifacts/bug-189-deploy-20260728T165015/
```

## Operational boundary

The containment fix is deployed and canary-proven. The single canary was destroyed; no QA fleet run
was performed.

OUTCOME: DONE
