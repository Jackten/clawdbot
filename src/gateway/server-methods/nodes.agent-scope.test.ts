// Agent node-scope tests cover discovery filtering and authenticated turn-origin resolution.
import { describe, expect, it, vi } from "vitest";
import { resolveRequesterNodeId } from "../requester-node.js";

const mocks = vi.hoisted(() => ({
  listDevicePairing: vi.fn(),
  listNodePairing: vi.fn(),
}));

vi.mock("../../infra/device-pairing.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/device-pairing.js")>(
    "../../infra/device-pairing.js",
  );
  return { ...actual, listDevicePairing: mocks.listDevicePairing };
});

vi.mock("../../infra/node-pairing.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/node-pairing.js")>(
    "../../infra/node-pairing.js",
  );
  return { ...actual, listNodePairing: mocks.listNodePairing };
});

import { nodeHandlers } from "./nodes.js";

function connectedNode(nodeId: string, displayName: string) {
  return {
    nodeId,
    connId: `conn-${nodeId}`,
    displayName,
    declaredCaps: ["app"],
    caps: ["app"],
    declaredCommands: ["app.open"],
    commands: ["app.open"],
    connectedAtMs: 1,
  };
}

function agentClient(params: { allowedNodeId?: string; senderIsOwner?: boolean }) {
  return {
    connect: {
      role: "operator" as const,
      scopes: ["operator.read"],
      client: { id: "agent", mode: "backend" as const },
    },
    internal: {
      agentRuntimeIdentity: {
        kind: "agentRuntime" as const,
        agentId: "main",
        sessionKey: "agent:main:main",
        ...params,
      },
    },
  };
}

async function listNodes(client: ReturnType<typeof agentClient>) {
  mocks.listDevicePairing.mockResolvedValue({ paired: [], pending: [] });
  mocks.listNodePairing.mockResolvedValue({ paired: [], pending: [] });
  const respond = vi.fn();
  await nodeHandlers["node.list"]({
    params: {},
    respond,
    client: client as never,
    context: {
      nodeRegistry: {
        listConnected: () => [
          connectedNode("owner-phone-node", "Claw"),
          connectedNode("qa-node-5554", "Claw-QA-5554"),
        ],
      },
    } as never,
    req: { type: "req", id: "list", method: "node.list" },
    isWebchatConnect: () => false,
  });
  return respond.mock.calls[0]?.[1] as { nodes: Array<{ nodeId: string }> };
}

describe("agent node discovery scope", () => {
  it("shows a pinned QA turn only its emulator node", async () => {
    const payload = await listNodes(
      agentClient({ allowedNodeId: "qa-node-5554", senderIsOwner: true }),
    );

    expect(payload.nodes.map((node) => node.nodeId)).toEqual(["qa-node-5554"]);
  });

  it("shows an unbound non-owner turn no nodes", async () => {
    const payload = await listNodes(agentClient({ senderIsOwner: false }));

    expect(payload.nodes).toEqual([]);
  });

  it("denies node pairing control to a pinned non-owner turn", async () => {
    mocks.listNodePairing.mockClear();
    const respond = vi.fn();

    await nodeHandlers["node.pair.list"]({
      params: {},
      respond,
      client: agentClient({
        allowedNodeId: "qa-node-5554",
        senderIsOwner: false,
      }) as never,
      context: {} as never,
      req: { type: "req", id: "pair-list", method: "node.pair.list" },
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        details: { code: "NODE_CONTROL_PLANE_FORBIDDEN" },
      }),
    );
    expect(mocks.listNodePairing).not.toHaveBeenCalled();
  });
});

describe("requester node resolution", () => {
  it("accepts only the active node websocket connection", () => {
    const registry = {
      get: () => ({ connId: "node-connection" }),
    };

    expect(
      resolveRequesterNodeId(
        {
          connId: "node-connection",
          connect: { device: { id: "qa-node-5554" } },
        } as never,
        registry as never,
      ),
    ).toBe("qa-node-5554");
    expect(
      resolveRequesterNodeId(
        {
          connId: "operator-connection",
          connect: { device: { id: "qa-node-5554" } },
        } as never,
        registry as never,
      ),
    ).toBeUndefined();
  });

  it("uses the legacy client id when the node has no device identity", () => {
    expect(
      resolveRequesterNodeId(
        {
          connId: "legacy-node-connection",
          connect: { client: { id: "legacy-node" } },
        } as never,
        {
          get: () => ({ connId: "legacy-node-connection" }),
        } as never,
      ),
    ).toBe("legacy-node");
  });
});
