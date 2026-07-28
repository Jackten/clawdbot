// Runtime delivery seam for task terminal/state-change notifications.
import {
  AgentExternalEffectUnknownError,
  AgentMutationCoordinator,
  createAgentMutationResourceKey,
} from "../agents/agent-mutation-coordinator.js";
import { loadConfig } from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import { OutboundDeliveryPreflightError } from "../infra/outbound/deliver-types.js";
import {
  isPermanentDeliveryError,
  reconcilePendingDeliveryOutcome,
} from "../infra/outbound/delivery-queue.js";
import {
  sendMessage as sendOutboundMessage,
  type MessageSendResult,
} from "../infra/outbound/message.js";

/** Non-task callers keep the ordinary durable outbound transport contract. */
export const sendMessage = sendOutboundMessage;

type TaskDeliveryMutation = {
  jobId: string;
  runId: string;
  logicalSlot: string;
};

type TaskDeliveryMessageParams = Parameters<typeof sendOutboundMessage>[0] & {
  mutation: TaskDeliveryMutation;
};

const taskDeliveryMutationCoordinator = new AgentMutationCoordinator();

export function isPendingTaskDeliveryEffect(error: unknown): boolean {
  return error instanceof AgentExternalEffectUnknownError;
}

/**
 * Task completion is an agent-owned external effect, not an untracked direct
 * send. The queue id and effect slot stay stable across retries and restarts.
 */
export async function sendTaskMessage(
  params: TaskDeliveryMessageParams,
): Promise<MessageSendResult> {
  const { mutation, ...outbound } = params;
  const resourceKey = createAgentMutationResourceKey("message", {
    accountId: outbound.accountId,
    channel: outbound.channel,
    target: outbound.to,
    threadId: outbound.threadId,
  });
  const effect = await taskDeliveryMutationCoordinator.runWithResourceLocks(
    {
      resourceKeys: [resourceKey],
      runId: mutation.runId,
      signal: outbound.abortSignal,
    },
    () =>
      taskDeliveryMutationCoordinator.executeExternalEffect({
        jobId: mutation.jobId,
        runId: mutation.runId,
        logicalSlot: mutation.logicalSlot,
        effectKind: "message.task-notification",
        resourceKey,
        payload: {
          accountId: outbound.accountId,
          asVoice: outbound.asVoice,
          buffer: outbound.buffer,
          channel: outbound.channel,
          content: outbound.content,
          contentType: outbound.contentType,
          filename: outbound.filename,
          forceDocument: outbound.forceDocument,
          gifPlayback: outbound.gifPlayback,
          mediaUrl: outbound.mediaUrl,
          mediaUrls: outbound.mediaUrls,
          parseMode: outbound.parseMode,
          payloads: outbound.payloads,
          replyToId: outbound.replyToId,
          silent: outbound.silent,
          target: outbound.to,
          threadId: outbound.threadId,
        },
        // The ledger identity is private agent state. Preserve the caller's
        // shipped transport key so queue/mirror dedupe survives an upgrade.
        submit: () => sendOutboundMessage(outbound),
        classifySubmitError: (error) => {
          const detail = formatErrorMessage(error);
          return {
            status:
              error instanceof OutboundDeliveryPreflightError || isPermanentDeliveryError(detail)
                ? "failed"
                : "unknown",
            error: detail,
          };
        },
        reconcile: async () => {
          const transportId = outbound.idempotencyKey?.trim();
          if (!transportId) {
            return {
              status: "unknown",
              error: "Task delivery has no durable transport identity to reconcile.",
            };
          }
          const outcome = await reconcilePendingDeliveryOutcome({
            id: transportId,
            cfg: outbound.cfg ?? loadConfig(),
          });
          if (outcome.status === "sent") {
            return {
              status: "applied",
              value: {
                channel: outcome.entry.channel,
                to: outcome.entry.to,
                via: "direct",
                mediaUrl: null,
                result: outcome.results?.[0],
                deliveryStatus: "sent",
              } satisfies MessageSendResult,
            };
          }
          if (outcome.status === "not_sent") {
            return {
              status: "failed",
              error:
                outcome.error ??
                "The durable delivery queue proves the task notification did not start.",
            };
          }
          if (outcome.status === "missing") {
            // Gateway-mode sends have no local queue row, but the gateway uses
            // this same transport key for persistent/in-flight dedupe. Direct
            // sends also safely recreate or replay the same durable queue id.
            return {
              status: "applied",
              value: await sendOutboundMessage(outbound),
            };
          }
          return {
            status: "unknown",
            error: outcome.error,
          };
        },
      }),
  );
  if (effect.status === "applied") {
    return effect.value;
  }
  if (effect.status === "unknown") {
    throw new AgentExternalEffectUnknownError(effect.idempotencyKey, effect.error);
  }
  throw new Error(effect.error ?? `Task delivery ${effect.idempotencyKey} failed before send.`);
}
