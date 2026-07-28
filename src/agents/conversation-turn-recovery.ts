import path from "node:path";
import { sendDurableMessageBatch } from "../channels/message/send.js";
/** Startup reconciliation for accepted conversation turns interrupted by a gateway restart. */
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadPendingDelivery,
  loadSentDelivery,
  moveToFailed,
} from "../infra/outbound/delivery-queue.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  listRecoverableConversationTurns,
  markConversationTurnRecoveryQueued,
  markConversationTurnRecoverySent,
  markConversationTurnUnknown,
  recordConversationTurnDeliveryEvidence,
  recordConversationTurnRecoveryError,
  type ConversationTurnRecord,
} from "./conversation-turn-durability.js";

const log = createSubsystemLogger("agents/conversation-turn-recovery");

type DeliveryEvidence = { kind: "pending" | "sent"; receipt?: unknown } | undefined;
type RecoverySendResult =
  | { status: "queued" }
  | { status: "sent"; receipt: unknown }
  | { status: "failed"; error: unknown };

export type ConversationTurnRecoveryDeps = {
  loadDeliveryEvidence: (queueId: string, stateDir?: string) => Promise<DeliveryEvidence>;
  abandonPendingDelivery?: (queueId: string, stateDir?: string) => Promise<void>;
  sendRecovery: (
    turn: ConversationTurnRecord,
    message: string,
    cfg: OpenClawConfig,
    stateDir?: string,
  ) => Promise<RecoverySendResult>;
};

function interruptedAtText(acceptedAt: number): string {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(acceptedAt));
}

function recoveryMessage(turn: ConversationTurnRecord): string {
  return `Your message at ${interruptedAtText(turn.acceptedAt)} was interrupted by a restart — resend or say "retry".`;
}

const productionDeps: ConversationTurnRecoveryDeps = {
  loadDeliveryEvidence: async (queueId, stateDir) => {
    const sent = await loadSentDelivery(queueId, stateDir);
    if (sent) {
      return { kind: "sent", receipt: sent.sentResults };
    }
    return (await loadPendingDelivery(queueId, stateDir)) ? { kind: "pending" } : undefined;
  },
  abandonPendingDelivery: async (queueId, stateDir) => {
    await moveToFailed(queueId, stateDir);
  },
  sendRecovery: async (turn, message, cfg, stateDir) => {
    let queued = false;
    const send = await sendDurableMessageBatch({
      cfg,
      channel: turn.channel,
      to: turn.deliveryTarget,
      accountId: turn.accountId,
      payloads: [{ text: message }],
      threadId: turn.threadId,
      durability: "required",
      deliveryQueueId: turn.recoveryDeliveryQueueId,
      onDeliveryIntent: () => {
        queued = true;
        markConversationTurnRecoveryQueued(turn.turnId, stateDir);
      },
    });
    if (send.status === "sent") {
      return { status: "sent", receipt: send.receipt };
    }
    if (queued || ("deliveryIntent" in send && send.deliveryIntent)) {
      return { status: "queued" };
    }
    if (send.status === "failed" || send.status === "partial_failed") {
      return { status: "failed", error: send.error };
    }
    return { status: "failed", error: new Error(`Recovery delivery was ${send.status}`) };
  },
};

export async function recoverAcceptedConversationTurns(params: {
  cfg: OpenClawConfig;
  stateDir?: string;
  acceptedBeforeMs?: number;
  deps?: ConversationTurnRecoveryDeps;
}): Promise<{ recovered: number; delivered: number; skipped: number; failed: number }> {
  if (
    !params.deps &&
    params.stateDir &&
    path.resolve(params.stateDir) !== path.resolve(resolveStateDir(process.env))
  ) {
    throw new Error(
      "Production conversation-turn recovery must use the process state directory; inject recovery dependencies for an isolated state directory.",
    );
  }
  const deps = params.deps ?? productionDeps;
  const result = { recovered: 0, delivered: 0, skipped: 0, failed: 0 };
  for (const turn of listRecoverableConversationTurns(params.stateDir, params.acceptedBeforeMs)) {
    const originalEvidence = await deps.loadDeliveryEvidence(
      turn.originalDeliveryQueueId,
      params.stateDir,
    );
    if (originalEvidence?.kind === "sent") {
      recordConversationTurnDeliveryEvidence(
        turn.turnId,
        {
          kind: "sent",
          receipt: originalEvidence.receipt ?? { queueId: turn.originalDeliveryQueueId },
        },
        params.stateDir,
      );
      // One retained queue receipt proves only one final payload, not that the
      // complete dispatcher settled. Without its terminal ledger write the
      // whole turn remains UNKNOWN; never infer success from a partial reply.
    }
    if (originalEvidence?.kind === "pending") {
      // One queued payload cannot prove the complete final reply survived.
      // Quarantine it before emitting UNKNOWN so queue replay cannot race the
      // visible recovery notice with a partial or duplicate response.
      await deps.abandonPendingDelivery?.(turn.originalDeliveryQueueId, params.stateDir);
    }

    const recoveryEvidence = await deps.loadDeliveryEvidence(
      turn.recoveryDeliveryQueueId,
      params.stateDir,
    );
    if (recoveryEvidence?.kind === "sent") {
      markConversationTurnRecoverySent(
        turn.turnId,
        recoveryEvidence.receipt ?? { queueId: turn.recoveryDeliveryQueueId },
        params.stateDir,
      );
      result.recovered++;
      continue;
    }
    if (recoveryEvidence?.kind === "pending") {
      markConversationTurnRecoveryQueued(turn.turnId, params.stateDir);
      result.skipped++;
      continue;
    }

    // Once model work may have started, absence of a delivery receipt is UNKNOWN.
    // Never re-run the turn blindly; queue one visible, idempotent recovery notice.
    markConversationTurnUnknown(turn.turnId, params.stateDir);
    const send = await deps.sendRecovery(turn, recoveryMessage(turn), params.cfg, params.stateDir);
    if (send.status === "sent") {
      markConversationTurnRecoverySent(turn.turnId, send.receipt, params.stateDir);
      result.recovered++;
    } else if (send.status === "queued") {
      markConversationTurnRecoveryQueued(turn.turnId, params.stateDir);
      result.recovered++;
    } else {
      recordConversationTurnRecoveryError(turn.turnId, send.error, params.stateDir);
      result.failed++;
    }
  }
  return result;
}

export function scheduleAcceptedConversationTurnRecovery(params: {
  cfg: OpenClawConfig;
  delayMs?: number;
  stateDir?: string;
}): void {
  const startupRecoveryCutoffMs = Date.now();
  const timer = setTimeout(() => {
    void recoverAcceptedConversationTurns({
      ...params,
      acceptedBeforeMs: startupRecoveryCutoffMs,
    })
      .then((result) => {
        if (result.recovered > 0 || result.delivered > 0 || result.failed > 0) {
          log.info(
            `conversation turn recovery complete: recovered=${result.recovered} delivered=${result.delivered} skipped=${result.skipped} failed=${result.failed}`,
          );
        }
      })
      .catch((error: unknown) => {
        log.warn(`conversation turn recovery failed: ${String(error)}`);
      });
  }, params.delayMs ?? 0);
  timer.unref?.();
}
