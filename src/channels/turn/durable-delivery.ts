// Durable final-reply delivery for inbound channel turns.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  finalizeConversationTurnDelivery,
  findConversationTurnForDelivery,
  markConversationTurnDeliveryDispatched,
  prepareConversationTurnDelivery,
  recordConversationTurnDeliveryEvidence,
  resolveConversationTurnDeliveryQueueId,
} from "../../agents/conversation-turn-durability.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeDeliverableOutboundChannel } from "../../infra/outbound/channel-resolution.js";
import {
  type DeliverOutboundPayloadsParams,
  type DurableFinalDeliveryRequirement,
  type DurableFinalDeliveryRequirements,
  type OutboundDeliveryIntent,
  resolveOutboundDurableFinalDeliverySupport,
} from "../../infra/outbound/deliver.js";
import { buildOutboundSessionContext } from "../../infra/outbound/session-context.js";
import { deriveDurableFinalDeliveryRequirements } from "../message/capabilities.js";
import { sendDurableMessageBatch, type DurableMessageBatchSendResult } from "../message/send.js";
import { createChannelDeliveryResultFromReceipt } from "./delivery-result.js";
import type { ChannelDeliveryInfo, ChannelDeliveryResult } from "./types.js";

/** Options controlling durable final delivery for inbound channel replies. */
export type DurableInboundReplyDeliveryOptions = Pick<
  DeliverOutboundPayloadsParams,
  "deps" | "formatting" | "identity" | "mediaAccess" | "replyToMode" | "silent" | "threadId"
> & {
  to?: string | null;
  replyToId?: string | null;
  requiredCapabilities?: DurableFinalDeliveryRequirements;
};

/** Full context required to deliver one inbound final reply through durable message sending. */
export type DurableInboundReplyDeliveryParams = DurableInboundReplyDeliveryOptions & {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  agentId: string;
  ctxPayload: FinalizedMsgContext;
  payload: ReplyPayload;
  info: ChannelDeliveryInfo;
};

type DurableInboundReplyNoSendReason = Extract<
  DurableMessageBatchSendResult,
  { status: "suppressed" }
>["reason"];

/** Outcome of attempting durable final delivery for an inbound reply payload. */
export type DurableInboundReplyDeliveryResult =
  | { status: "not_applicable"; reason: "non_final" }
  | {
      status: "unsupported";
      reason:
        | "missing_channel"
        | "missing_target"
        | "missing_outbound_handler"
        | "capability_mismatch";
      capability?: DurableFinalDeliveryRequirement;
    }
  | { status: "handled_visible"; delivery: ChannelDeliveryResult }
  | {
      status: "handled_no_send";
      reason: DurableInboundReplyNoSendReason;
      delivery: ChannelDeliveryResult;
    }
  | { status: "failed"; error: unknown; sentBeforeError?: true };

function resolveDeliveryTarget(params: DurableInboundReplyDeliveryParams): string | undefined {
  return (
    normalizeOptionalString(params.to) ??
    normalizeOptionalString(params.ctxPayload.OriginatingTo) ??
    normalizeOptionalString(params.ctxPayload.To)
  );
}

export function resolveDurableInboundReplyToId(
  params: Pick<DurableInboundReplyDeliveryParams, "ctxPayload" | "payload" | "replyToId">,
): string | null | undefined {
  // Explicit null means "do not reply to a source message"; do not fall back to context ids.
  if (params.replyToId === null || params.payload.replyToId === null) {
    return null;
  }
  return (
    normalizeOptionalString(params.replyToId) ??
    normalizeOptionalString(params.payload.replyToId) ??
    normalizeOptionalString(params.ctxPayload.ReplyToIdFull) ??
    normalizeOptionalString(params.ctxPayload.ReplyToId)
  );
}

function resolveDurableInboundReplyThreadId(
  params: DurableInboundReplyDeliveryParams,
): string | number | null | undefined {
  if ("threadId" in params) {
    return params.threadId;
  }
  return params.ctxPayload.MessageThreadId;
}

function stringifyThreadId(value: string | number | null | undefined): string | undefined {
  return value == null ? undefined : String(value);
}

function resolveConversationTurnSessionKey(ctxPayload: FinalizedMsgContext): string | undefined {
  return (
    normalizeOptionalString(ctxPayload.CommandTargetSessionKey) ??
    normalizeOptionalString(ctxPayload.SessionKey)
  );
}

/** Marks an inbound turn terminal only after its complete reply dispatch has settled. */
export function finalizeInboundConversationTurnDelivery(
  ctxPayload: FinalizedMsgContext,
  deliveryTarget?: string,
  channel?: string,
  accountId?: string,
): void {
  finalizeConversationTurnDelivery({
    channel:
      normalizeOptionalString(channel) ??
      normalizeOptionalString(ctxPayload.OriginatingChannel) ??
      normalizeOptionalString(ctxPayload.Surface) ??
      normalizeOptionalString(ctxPayload.Provider),
    accountId:
      normalizeOptionalString(accountId) ?? normalizeOptionalString(ctxPayload.AccountId) ?? "",
    sessionKey: resolveConversationTurnSessionKey(ctxPayload),
    deliveryTarget:
      normalizeOptionalString(deliveryTarget) ??
      normalizeOptionalString(ctxPayload.OriginatingTo) ??
      normalizeOptionalString(ctxPayload.To),
    messageId:
      normalizeOptionalString(ctxPayload.MessageSidFull) ??
      normalizeOptionalString(ctxPayload.MessageSidLast) ??
      normalizeOptionalString(ctxPayload.MessageSid),
  });
}

function toDeliveryIntent(intent: OutboundDeliveryIntent): ChannelDeliveryResult["deliveryIntent"] {
  return {
    id: intent.id,
    kind: "outbound_queue",
    queuePolicy: intent.queuePolicy,
  };
}

/** Narrows durable delivery results that handled the payload without caller fallback. */
export function isDurableInboundReplyDeliveryHandled(
  result: DurableInboundReplyDeliveryResult,
): result is Extract<
  DurableInboundReplyDeliveryResult,
  { status: "handled_visible" | "handled_no_send" }
> {
  return result.status === "handled_visible" || result.status === "handled_no_send";
}

/** Throws failed durable delivery results, preserving visible-send metadata when applicable. */
export function throwIfDurableInboundReplyDeliveryFailed(
  result: DurableInboundReplyDeliveryResult,
): void {
  if (result.status === "failed") {
    throw result.sentBeforeError === true
      ? markDurableInboundReplyDeliveryErrorVisible(result.error)
      : result.error;
  }
}

function markDurableInboundReplyDeliveryErrorVisible(error: unknown): unknown {
  // Partial durable sends must suppress duplicate fallback delivery while still surfacing failure.
  if (typeof error === "object" && error !== null && Object.isExtensible(error)) {
    Object.assign(error, { sentBeforeError: true, visibleReplySent: true });
    return error;
  }

  const visibleError = new Error("visible durable reply delivery failed", { cause: error });
  Object.assign(visibleError, { sentBeforeError: true, visibleReplySent: true });
  return visibleError;
}

/** Delivers final inbound replies through the durable message-send context when supported. */
export async function deliverInboundReplyWithMessageSendContext(
  params: DurableInboundReplyDeliveryParams,
): Promise<DurableInboundReplyDeliveryResult> {
  if (params.info.kind !== "final") {
    return { status: "not_applicable", reason: "non_final" };
  }

  const channel = normalizeDeliverableOutboundChannel(params.channel);
  const to = resolveDeliveryTarget(params);
  if (!channel) {
    return { status: "unsupported", reason: "missing_channel" };
  }
  if (!to) {
    return { status: "unsupported", reason: "missing_target" };
  }

  const replyToId = resolveDurableInboundReplyToId(params);
  const threadId = resolveDurableInboundReplyThreadId(params);
  const requiredCapabilities =
    params.requiredCapabilities ??
    deriveDurableFinalDeliveryRequirements({
      payload: params.payload,
      replyToId,
      threadId,
      silent: params.silent,
    });
  const durability =
    requiredCapabilities.reconcileUnknownSend === true ? "required" : "best_effort";

  let support: Awaited<ReturnType<typeof resolveOutboundDurableFinalDeliverySupport>>;
  try {
    support = await resolveOutboundDurableFinalDeliverySupport({
      cfg: params.cfg,
      channel,
      requirements: requiredCapabilities,
    });
  } catch (err: unknown) {
    return { status: "failed", error: err };
  }
  if (!support.ok) {
    return {
      status: "unsupported",
      reason: support.reason,
      ...(support.capability ? { capability: support.capability } : {}),
    };
  }

  const session = buildOutboundSessionContext({
    cfg: params.cfg,
    sessionKey: params.ctxPayload.SessionKey,
    policySessionKey: params.ctxPayload.RuntimePolicySessionKey,
    conversationType: params.ctxPayload.ChatType,
    agentId: params.agentId,
    requesterAccountId: params.accountId ?? params.ctxPayload.AccountId,
    requesterSenderId: params.ctxPayload.SenderId ?? params.ctxPayload.From,
    requesterSenderName: params.ctxPayload.SenderName,
    requesterSenderUsername: params.ctxPayload.SenderUsername,
    requesterSenderE164: params.ctxPayload.SenderE164,
  });
  const sourceMessageId =
    normalizeOptionalString(params.ctxPayload.MessageSidFull) ??
    normalizeOptionalString(params.ctxPayload.MessageSidLast) ??
    normalizeOptionalString(params.ctxPayload.MessageSid);
  const conversationTurn = findConversationTurnForDelivery({
    channel,
    accountId: params.accountId ?? "",
    sessionKey: resolveConversationTurnSessionKey(params.ctxPayload),
    messageId: sourceMessageId,
    deliveryTarget: to,
  });
  const deliveryQueueId = conversationTurn
    ? resolveConversationTurnDeliveryQueueId(conversationTurn.turnId, params.payload)
    : undefined;
  if (conversationTurn && deliveryQueueId) {
    // Link the accepted turn to the exact queue id before enqueueing. A crash
    // after the queue commit but before its callback must still reconcile the
    // original pending/sent delivery instead of emitting a second notice.
    prepareConversationTurnDelivery(conversationTurn.turnId, deliveryQueueId);
  }

  const send = await sendDurableMessageBatch({
    cfg: params.cfg,
    channel,
    to,
    accountId: params.accountId,
    payloads: [params.payload],
    threadId,
    replyToId,
    replyToMode: params.replyToMode,
    formatting: params.formatting,
    identity: params.identity,
    deps: params.deps,
    mediaAccess: params.mediaAccess,
    silent: params.silent,
    durability,
    ...(durability === "required" ? { requireUnknownSendReconciliation: true } : {}),
    session,
    gatewayClientScopes: params.ctxPayload.GatewayClientScopes ?? [],
    ...(conversationTurn
      ? {
          deliveryQueueId,
          onDeliveryIntent: () => {
            markConversationTurnDeliveryDispatched(conversationTurn.turnId, deliveryQueueId!);
          },
        }
      : {}),
  });
  if (send.status === "failed") {
    return { status: "failed" as const, error: send.error };
  }
  if (send.status === "partial_failed") {
    return {
      status: "failed" as const,
      error: markDurableInboundReplyDeliveryErrorVisible(send.error),
      sentBeforeError: true,
    };
  }

  const delivery = createChannelDeliveryResultFromReceipt({
    receipt: send.receipt,
    threadId: stringifyThreadId(threadId),
    ...(replyToId ? { replyToId } : {}),
    visibleReplySent: send.status === "sent",
    ...(send.deliveryIntent ? { deliveryIntent: toDeliveryIntent(send.deliveryIntent) } : {}),
  });
  if (send.status === "suppressed") {
    if (conversationTurn && send.reason !== "no_visible_result") {
      // `no_visible_result` can be an intermediate durable attempt followed by
      // a channel-owned fallback send (WhatsApp). Do not terminalize that gap.
      recordConversationTurnDeliveryEvidence(conversationTurn.turnId, {
        kind: "suppressed",
        reason: send.reason,
      });
    }
    return { status: "handled_no_send", reason: send.reason, delivery };
  }
  if (conversationTurn) {
    // This function rejects non-final lifecycle kinds above, so only terminal
    // final-reply receipts can satisfy the accepted conversation turn.
    recordConversationTurnDeliveryEvidence(conversationTurn.turnId, {
      kind: "sent",
      receipt: send.receipt,
    });
  }
  return { status: "handled_visible", delivery };
}

/** @deprecated Use `deliverInboundReplyWithMessageSendContext`. */
export const deliverDurableInboundReplyPayload = deliverInboundReplyWithMessageSendContext;
