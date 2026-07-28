// Resolves whether a Gateway request came from the active connection for a node.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { NodeRegistry } from "./node-registry.js";
import type { GatewayClient } from "./server-methods/shared-types.js";

/**
 * Return the node id only when the authenticated client is the node's live socket.
 * A device id on an operator connection alone must never create a node authorization scope.
 */
export function resolveRequesterNodeId(
  client: GatewayClient | null,
  nodeRegistry: Pick<NodeRegistry, "get">,
): string | undefined {
  const nodeId =
    normalizeOptionalString(client?.connect?.device?.id) ??
    normalizeOptionalString(client?.connect?.client?.id);
  const connId = normalizeOptionalString(client?.connId);
  if (!nodeId || !connId) {
    return undefined;
  }
  return nodeRegistry.get(nodeId)?.connId === connId ? nodeId : undefined;
}
