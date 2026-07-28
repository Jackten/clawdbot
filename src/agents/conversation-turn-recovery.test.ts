import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  acceptConversationTurn,
  finalizeConversationTurnDelivery,
  findConversationTurnForDelivery,
  markConversationTurnDeliveryDispatched,
  markConversationTurnRunning,
  recordConversationTurnDeliveryEvidence,
  readConversationTurn,
  resolveConversationTurnId,
} from "./conversation-turn-durability.js";
import {
  recoverAcceptedConversationTurns,
  type ConversationTurnRecoveryDeps,
} from "./conversation-turn-recovery.js";

let stateDir: string;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-conversation-turn-recovery-"));
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await fs.rm(stateDir, { recursive: true, force: true });
});

function acceptTestTurn(turnId: string) {
  return acceptConversationTurn({
    turnId,
    channel: "whatsapp",
    accountId: "default",
    senderId: "sender-1",
    deliveryTarget: "chat-1",
    sessionKey: "agent:main:main",
    messageId: `message-${turnId}`,
    content: "please continue",
    acceptedAt: Date.parse("2026-07-28T13:12:00-04:00"),
    stateDir,
  });
}

describe("accepted conversation turn startup recovery", () => {
  it("scopes provider-local message ids and delivery lookup by target and account", () => {
    const first = resolveConversationTurnId({
      channel: "telegram",
      accountId: "default",
      sessionKey: "agent:main:main",
      deliveryTarget: "chat-1",
      messageId: "42",
    });
    const second = resolveConversationTurnId({
      channel: "telegram",
      accountId: "default",
      sessionKey: "agent:main:main",
      deliveryTarget: "chat-2",
      messageId: "42",
    });

    expect(first).not.toBe(second);

    const accountA = acceptConversationTurn({
      turnId: "account-a-turn",
      channel: "telegram",
      accountId: "account-a",
      senderId: "sender",
      deliveryTarget: "shared-target",
      sessionKey: "agent:main:main",
      messageId: "42",
      content: "from account A",
      stateDir,
    });
    const accountB = acceptConversationTurn({
      turnId: "account-b-turn",
      channel: "telegram",
      accountId: "account-b",
      senderId: "sender",
      deliveryTarget: "shared-target",
      sessionKey: "agent:main:main",
      messageId: "42",
      content: "from account B",
      stateDir,
    });

    expect(
      findConversationTurnForDelivery({
        channel: "telegram",
        accountId: "account-a",
        sessionKey: "agent:main:main",
        deliveryTarget: "shared-target",
        messageId: "42",
        stateDir,
      })?.turnId,
    ).toBe(accountA.turnId);
    expect(accountA.turnId).not.toBe(accountB.turnId);
  });

  it("queues exactly one visible recovery action across repeated startup recovery", async () => {
    const turn = acceptTestTurn("run-interrupted");
    markConversationTurnRunning(turn.turnId, stateDir);
    closeOpenClawStateDatabaseForTest(); // restart boundary

    let recoveryPending = false;
    const sendRecovery = vi.fn<ConversationTurnRecoveryDeps["sendRecovery"]>(async () => {
      recoveryPending = true;
      return { status: "queued" };
    });
    let originalPending = true;
    const abandonPendingDelivery = vi.fn(async () => {
      originalPending = false;
    });
    const deps: ConversationTurnRecoveryDeps = {
      loadDeliveryEvidence: async (queueId) =>
        queueId === turn.originalDeliveryQueueId && originalPending
          ? { kind: "pending" }
          : queueId === turn.recoveryDeliveryQueueId && recoveryPending
            ? { kind: "pending" }
            : undefined,
      abandonPendingDelivery,
      sendRecovery,
    };

    await recoverAcceptedConversationTurns({ cfg: {}, stateDir, deps });
    closeOpenClawStateDatabaseForTest(); // a second startup sees the durable queued state
    await recoverAcceptedConversationTurns({ cfg: {}, stateDir, deps });

    expect(sendRecovery).toHaveBeenCalledTimes(1);
    expect(abandonPendingDelivery).toHaveBeenCalledOnce();
    expect(sendRecovery.mock.calls[0]?.[1]).toContain(
      'was interrupted by a restart — resend or say "retry"',
    );
    expect(readConversationTurn(turn.turnId, stateDir)?.status).toBe("recovery_queued");
  });

  it("takes no recovery action when retained delivery evidence proves the reply succeeded", async () => {
    const turn = acceptTestTurn("run-delivered");
    const deliveryQueueId = `${turn.originalDeliveryQueueId}:payload`;
    markConversationTurnDeliveryDispatched(turn.turnId, deliveryQueueId, stateDir);
    recordConversationTurnDeliveryEvidence(
      turn.turnId,
      { kind: "sent", receipt: { messageId: "platform-message-1" } },
      stateDir,
    );
    finalizeConversationTurnDelivery({
      channel: turn.channel,
      accountId: turn.accountId ?? "",
      sessionKey: turn.sessionKey,
      messageId: turn.messageId,
      deliveryTarget: turn.deliveryTarget,
      stateDir,
    });
    closeOpenClawStateDatabaseForTest(); // restart after dispatcher-settled finalization

    const sendRecovery = vi.fn<ConversationTurnRecoveryDeps["sendRecovery"]>();
    const deps: ConversationTurnRecoveryDeps = {
      loadDeliveryEvidence: async () => undefined,
      sendRecovery,
    };

    const result = await recoverAcceptedConversationTurns({ cfg: {}, stateDir, deps });

    expect(result).toEqual({ recovered: 0, delivered: 0, skipped: 0, failed: 0 });
    expect(sendRecovery).not.toHaveBeenCalled();
    expect(readConversationTurn(turn.turnId, stateDir)).toMatchObject({
      status: "succeeded",
      deliveryReceipt: [{ kind: "sent", receipt: { messageId: "platform-message-1" } }],
    });
  });

  it("reports UNKNOWN when a payload was sent but the complete dispatcher never settled", async () => {
    const turn = acceptTestTurn("run-partial-delivery");
    const deliveryQueueId = `${turn.originalDeliveryQueueId}:payload`;
    markConversationTurnDeliveryDispatched(turn.turnId, deliveryQueueId, stateDir);
    closeOpenClawStateDatabaseForTest(); // restart before complete dispatcher finalization

    const sendRecovery = vi.fn<ConversationTurnRecoveryDeps["sendRecovery"]>(async () => ({
      status: "queued",
    }));
    const result = await recoverAcceptedConversationTurns({
      cfg: {},
      stateDir,
      deps: {
        loadDeliveryEvidence: async (queueId) =>
          queueId === deliveryQueueId
            ? { kind: "sent", receipt: { messageId: "partial-platform-message" } }
            : undefined,
        sendRecovery,
      },
    });

    expect(result).toEqual({ recovered: 1, delivered: 0, skipped: 0, failed: 0 });
    expect(sendRecovery).toHaveBeenCalledOnce();
    expect(readConversationTurn(turn.turnId, stateDir)).toMatchObject({
      status: "recovery_queued",
      deliveryReceipt: [{ kind: "sent", receipt: { messageId: "partial-platform-message" } }],
    });
  });

  it("treats an intentionally suppressed settled dispatch as terminal", async () => {
    const turn = acceptTestTurn("run-suppressed");
    recordConversationTurnDeliveryEvidence(
      turn.turnId,
      { kind: "suppressed", reason: "cancelled_by_message_sending_hook" },
      stateDir,
    );
    finalizeConversationTurnDelivery({
      channel: turn.channel,
      accountId: turn.accountId ?? "",
      sessionKey: turn.sessionKey,
      messageId: turn.messageId,
      deliveryTarget: turn.deliveryTarget,
      stateDir,
    });
    closeOpenClawStateDatabaseForTest(); // restart after dispatcher-settled finalization

    const sendRecovery = vi.fn<ConversationTurnRecoveryDeps["sendRecovery"]>();
    const result = await recoverAcceptedConversationTurns({
      cfg: {},
      stateDir,
      deps: {
        loadDeliveryEvidence: async () => undefined,
        sendRecovery,
      },
    });

    expect(result).toEqual({ recovered: 0, delivered: 0, skipped: 0, failed: 0 });
    expect(sendRecovery).not.toHaveBeenCalled();
    expect(readConversationTurn(turn.turnId, stateDir)?.status).toBe("completed_no_send");
  });

  it("does not recover a successfully settled untracked or silent dispatch", async () => {
    const turn = acceptTestTurn("run-untracked");
    finalizeConversationTurnDelivery({
      sessionKey: turn.sessionKey,
      messageId: turn.messageId,
      stateDir,
    });
    closeOpenClawStateDatabaseForTest();

    const sendRecovery = vi.fn<ConversationTurnRecoveryDeps["sendRecovery"]>();
    await recoverAcceptedConversationTurns({
      cfg: {},
      stateDir,
      deps: {
        loadDeliveryEvidence: async () => undefined,
        sendRecovery,
      },
    });

    expect(sendRecovery).not.toHaveBeenCalled();
    expect(readConversationTurn(turn.turnId, stateDir)?.status).toBe("completed_untracked");
  });
});
