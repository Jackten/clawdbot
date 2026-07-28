# WORKLOG-BUG-189

## Outcome

Implemented source-level node containment for agent turns and hardened the QA fleet runner. No live
gateway restart, fleet run, or emulator run was performed.

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

## Operational boundary

The live gateway was deliberately not restarted. It continues running the pre-fix build until a
separately scheduled safe restart/deployment. Fleet runs remain suspended until that deployment and
an isolated canary confirm the running gateway has the containment code.

OUTCOME: DONE
