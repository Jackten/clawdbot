import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { sendTaskMessage } from "./task-registry-delivery-runtime.js";

const sendOutboundMessage = vi.hoisted(() =>
  vi.fn(async () => ({
    channel: "whatsapp",
    to: "15551234567",
    via: "direct" as const,
    mediaUrl: null,
    deliveryStatus: "sent" as const,
  })),
);
const reconcilePendingDeliveryOutcome = vi.hoisted(() => vi.fn());

vi.mock("../infra/outbound/message.js", () => ({
  sendMessage: sendOutboundMessage,
}));

vi.mock("../infra/outbound/delivery-queue.js", () => ({
  isPermanentDeliveryError: (error: string) => /outbound not configured for channel/i.test(error),
  reconcilePendingDeliveryOutcome,
}));

let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-task-delivery-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  sendOutboundMessage.mockClear();
  reconcilePendingDeliveryOutcome.mockReset();
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("task registry delivery runtime", () => {
  it("locks the target and replays a completed effect without a second send", async () => {
    const params = {
      channel: "whatsapp",
      to: "15551234567",
      content: "Background task finished.",
      idempotencyKey: "task-terminal:task-1",
      mutation: {
        jobId: "task-1",
        runId: "exec:session-1",
        logicalSlot: "task-terminal:task-1",
      },
    };

    await sendTaskMessage(params);
    await sendTaskMessage(params);

    expect(sendOutboundMessage).toHaveBeenCalledTimes(1);
    expect(sendOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "task-terminal:task-1" }),
    );
    const { db } = openOpenClawStateDatabase();
    expect(
      db.prepare("SELECT fencing_token, owner_id, owner_run_id FROM agent_mutation_locks").get(),
    ).toEqual({
      fencing_token: 2,
      owner_id: null,
      owner_run_id: null,
    });
    expect(
      db
        .prepare(
          "SELECT job_id, run_id, logical_slot, effect_kind, status FROM agent_external_effects",
        )
        .get(),
    ).toEqual({
      job_id: "task-1",
      run_id: "exec:session-1",
      logical_slot: "task-terminal:task-1",
      effect_kind: "message.task-notification",
      status: "applied",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM agent_external_effect_events").get()).toEqual({
      count: 3,
    });
  });

  it("reconciles an interrupted effect by its original transport key", async () => {
    const params = {
      cfg: {},
      channel: "whatsapp",
      to: "15551234567",
      content: "Background task finished.",
      idempotencyKey: "task-terminal:task-2",
      mutation: {
        jobId: "task-2",
        runId: "exec:session-2",
        logicalSlot: "task-terminal:task-2",
      },
    };
    sendOutboundMessage.mockRejectedValueOnce(new Error("connection dropped after send"));
    await expect(sendTaskMessage(params)).rejects.toThrow("unknown outcome");

    reconcilePendingDeliveryOutcome.mockResolvedValueOnce({
      status: "sent",
      entry: {
        id: "task-terminal:task-2",
        channel: "whatsapp",
        to: "15551234567",
      },
      results: [{ channel: "whatsapp", messageId: "message-2" }],
    });

    await expect(sendTaskMessage(params)).resolves.toMatchObject({
      channel: "whatsapp",
      to: "15551234567",
      deliveryStatus: "sent",
    });
    expect(sendOutboundMessage).toHaveBeenCalledTimes(1);
    expect(reconcilePendingDeliveryOutcome).toHaveBeenCalledWith({
      id: "task-terminal:task-2",
      cfg: {},
    });
  });

  it("retries a queue-less gateway effect with the same transport key", async () => {
    const params = {
      cfg: {},
      channel: "gateway-chat",
      to: "room-1",
      content: "Background task finished.",
      idempotencyKey: "task-terminal:task-3",
      mutation: {
        jobId: "task-3",
        runId: "exec:session-3",
        logicalSlot: "task-terminal:task-3",
      },
    };
    sendOutboundMessage.mockRejectedValueOnce(new Error("gateway disconnected after send"));
    await expect(sendTaskMessage(params)).rejects.toThrow("unknown outcome");
    reconcilePendingDeliveryOutcome.mockResolvedValueOnce({ status: "missing" });

    await expect(sendTaskMessage(params)).resolves.toMatchObject({
      channel: "whatsapp",
      deliveryStatus: "sent",
    });
    expect(sendOutboundMessage).toHaveBeenCalledTimes(2);
    expect(sendOutboundMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ idempotencyKey: "task-terminal:task-3" }),
    );
  });

  it("records deterministic pre-send delivery errors as failed", async () => {
    sendOutboundMessage.mockRejectedValueOnce(
      new Error("outbound not configured for channel disabled-chat"),
    );

    await expect(
      sendTaskMessage({
        cfg: {},
        channel: "disabled-chat",
        to: "room-1",
        content: "Background task finished.",
        idempotencyKey: "task-terminal:task-4",
        mutation: {
          jobId: "task-4",
          runId: "exec:session-4",
          logicalSlot: "task-terminal:task-4",
        },
      }),
    ).rejects.toThrow("outbound not configured");

    const { db } = openOpenClawStateDatabase();
    expect(
      db.prepare("SELECT status, error FROM agent_external_effects WHERE job_id = 'task-4'").get(),
    ).toEqual({
      status: "failed",
      error: "outbound not configured for channel disabled-chat",
    });
    expect(reconcilePendingDeliveryOutcome).not.toHaveBeenCalled();
  });
});
