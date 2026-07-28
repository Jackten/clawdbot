// Ambient trusted caller context for model-mediated Gateway tool calls.
import { AsyncLocalStorage } from "node:async_hooks";
import { copyPluginToolMeta } from "../../plugins/tools.js";
import { copyBeforeToolCallHookMarker } from "../before-tool-call-metadata.js";
import { copyChannelAgentToolMeta } from "../channel-tools.js";
import { copyToolTerminalPresentation } from "../tool-terminal-presentation.js";
import type { AnyAgentTool } from "./common.js";

export type GatewayToolCallerIdentity = {
  agentId: string;
  sessionKey: string;
  /** Node that originated this turn, when the ingress was an authenticated node connection. */
  allowedNodeId?: string;
  /** Trusted sender ownership decided at ingress, never from model-supplied tool arguments. */
  senderIsOwner?: boolean;
};

const gatewayToolCallerStorage = new AsyncLocalStorage<GatewayToolCallerIdentity>();

export function getGatewayToolCallerIdentity(): GatewayToolCallerIdentity | undefined {
  return gatewayToolCallerStorage.getStore();
}

export async function withGatewayToolCallerIdentity<T>(
  identity: GatewayToolCallerIdentity | undefined,
  run: () => Promise<T> | T,
): Promise<T> {
  if (!identity?.agentId?.trim() || !identity.sessionKey?.trim()) {
    return await run();
  }
  return await gatewayToolCallerStorage.run(
    {
      agentId: identity.agentId.trim(),
      sessionKey: identity.sessionKey.trim(),
      ...(identity.allowedNodeId?.trim() ? { allowedNodeId: identity.allowedNodeId.trim() } : {}),
      ...(identity.senderIsOwner !== undefined
        ? { senderIsOwner: identity.senderIsOwner === true }
        : {}),
    },
    run,
  );
}

export function wrapToolWithGatewayCallerIdentity(
  tool: AnyAgentTool,
  identity: GatewayToolCallerIdentity | undefined,
): AnyAgentTool {
  if (!identity?.agentId?.trim() || !identity.sessionKey?.trim() || !tool.execute) {
    return tool;
  }
  const wrapped: AnyAgentTool = {
    ...tool,
    execute: async (...args) =>
      await withGatewayToolCallerIdentity(identity, async () => await tool.execute?.(...args)),
  };
  copyPluginToolMeta(tool, wrapped);
  copyChannelAgentToolMeta(tool as never, wrapped as never);
  copyBeforeToolCallHookMarker(tool, wrapped);
  copyToolTerminalPresentation(tool, wrapped);
  return wrapped;
}
