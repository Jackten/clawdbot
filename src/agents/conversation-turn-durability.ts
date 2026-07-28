/**
 * Durable lifecycle for accepted inbound conversation turns.
 *
 * Acceptance is recorded before model/tool work starts. Delivery transitions
 * are driven only by durable outbound intent and platform receipt evidence.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type {
  ConversationTurns,
  DB as OpenClawStateKyselyDatabase,
} from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";

export type ConversationTurnStatus =
  | "accepted"
  | "running"
  | "delivery_dispatched"
  | "succeeded"
  | "completed_no_send"
  | "completed_untracked"
  | "unknown"
  | "recovery_queued"
  | "recovery_sent";

export type ConversationTurnRecord = {
  turnId: string;
  channel: string;
  accountId?: string;
  senderId: string;
  deliveryTarget: string;
  threadId?: string;
  sessionKey: string;
  messageId: string;
  contentRef: string;
  status: ConversationTurnStatus;
  originalDeliveryQueueId: string;
  recoveryDeliveryQueueId: string;
  acceptedAt: number;
  updatedAt: number;
  deliveryDispatchedAt?: number;
  succeededAt?: number;
  deliveryReceipt?: unknown;
  unknownAt?: number;
  recoveryQueuedAt?: number;
  recoverySentAt?: number;
  lastError?: string;
};

export type AcceptConversationTurnParams = {
  turnId: string;
  channel: string;
  accountId?: string;
  senderId: string;
  deliveryTarget: string;
  threadId?: string | number;
  sessionKey: string;
  messageId: string;
  content: string;
  acceptedAt?: number;
  stateDir?: string;
};

type ConversationTurnDatabase = Pick<OpenClawStateKyselyDatabase, "conversation_turns">;
type ConversationTurnRow = Selectable<ConversationTurns>;

function stateDirEnv(stateDir: string): NodeJS.ProcessEnv {
  const env = Object.create(process.env) as NodeJS.ProcessEnv;
  env.OPENCLAW_STATE_DIR = stateDir;
  return env;
}

function openDatabase(stateDir?: string) {
  return openOpenClawStateDatabase({ env: stateDir ? stateDirEnv(stateDir) : process.env });
}

function kysely(db: DatabaseSync) {
  return getNodeSqliteKysely<ConversationTurnDatabase>(db);
}

function normalizeRequired(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Conversation turn ${field} cannot be empty`);
  }
  return normalized;
}

function contentReference(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function resolveConversationTurnId(params: {
  channel: string;
  accountId?: string;
  sessionKey: string;
  deliveryTarget: string;
  threadId?: string | number;
  messageId: string;
}): string {
  const identity = [
    normalizeRequired(params.channel, "channel"),
    params.accountId?.trim() ?? "",
    normalizeRequired(params.sessionKey, "session key"),
    normalizeRequired(params.deliveryTarget, "delivery target"),
    params.threadId == null ? "" : String(params.threadId),
    normalizeRequired(params.messageId, "message id"),
  ].join("\0");
  return createHash("sha256").update(identity).digest("hex");
}

function queueId(turnId: string, kind: "reply" | "recovery"): string {
  return `conversation-turn:${turnId}:${kind}`;
}

export function resolveConversationTurnDeliveryQueueId(turnId: string, payload: unknown): string {
  const payloadRef = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 24);
  return `${queueId(turnId, "reply")}:${payloadRef}`;
}

function parseJson(value: string | null): unknown {
  return value === null ? undefined : JSON.parse(value);
}

function toRecord(row: ConversationTurnRow): ConversationTurnRecord {
  return {
    turnId: row.turn_id,
    channel: row.channel,
    ...(row.account_id ? { accountId: row.account_id } : {}),
    senderId: row.sender_id,
    deliveryTarget: row.delivery_target,
    ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
    sessionKey: row.session_key,
    messageId: row.message_id,
    contentRef: row.content_ref,
    status: row.status as ConversationTurnStatus,
    originalDeliveryQueueId: row.original_delivery_queue_id,
    recoveryDeliveryQueueId: row.recovery_delivery_queue_id,
    acceptedAt: row.accepted_at,
    updatedAt: row.updated_at,
    ...(row.delivery_dispatched_at === null
      ? {}
      : { deliveryDispatchedAt: row.delivery_dispatched_at }),
    ...(row.succeeded_at === null ? {} : { succeededAt: row.succeeded_at }),
    ...(row.delivery_receipt_json === null
      ? {}
      : { deliveryReceipt: parseJson(row.delivery_receipt_json) }),
    ...(row.unknown_at === null ? {} : { unknownAt: row.unknown_at }),
    ...(row.recovery_queued_at === null ? {} : { recoveryQueuedAt: row.recovery_queued_at }),
    ...(row.recovery_sent_at === null ? {} : { recoverySentAt: row.recovery_sent_at }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
  };
}

function selectById(db: DatabaseSync, turnId: string): ConversationTurnRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    kysely(db).selectFrom("conversation_turns").selectAll().where("turn_id", "=", turnId),
  );
}

export function acceptConversationTurn(
  params: AcceptConversationTurnParams,
): ConversationTurnRecord {
  const turnId = normalizeRequired(params.turnId, "turn id");
  const channel = normalizeRequired(params.channel, "channel");
  const senderId = normalizeRequired(params.senderId, "sender id");
  const deliveryTarget = normalizeRequired(params.deliveryTarget, "delivery target");
  const sessionKey = normalizeRequired(params.sessionKey, "session key");
  const messageId = normalizeRequired(params.messageId, "message id");
  const acceptedAt = params.acceptedAt ?? Date.now();
  const database = openDatabase(params.stateDir);
  return runOpenClawStateWriteTransaction(
    (tx) => {
      executeSqliteQuerySync(
        tx.db,
        kysely(tx.db)
          .insertInto("conversation_turns")
          .values({
            turn_id: turnId,
            channel,
            account_id: params.accountId?.trim() || "",
            sender_id: senderId,
            delivery_target: deliveryTarget,
            thread_id: params.threadId == null ? null : String(params.threadId),
            session_key: sessionKey,
            message_id: messageId,
            content_ref: contentReference(params.content),
            status: "accepted",
            original_delivery_queue_id: queueId(turnId, "reply"),
            recovery_delivery_queue_id: queueId(turnId, "recovery"),
            accepted_at: acceptedAt,
            updated_at: acceptedAt,
          })
          .onConflict((conflict) => conflict.column("turn_id").doNothing()),
      );
      const row = selectById(tx.db, turnId);
      if (!row) {
        throw new Error(`Failed to read accepted conversation turn ${turnId}`);
      }
      return toRecord(row);
    },
    { path: database.path },
  );
}

export function readConversationTurn(
  turnId: string,
  stateDir?: string,
): ConversationTurnRecord | undefined {
  const database = openDatabase(stateDir);
  const row = selectById(database.db, turnId.trim());
  return row ? toRecord(row) : undefined;
}

export function findConversationTurnForDelivery(params: {
  channel?: string;
  accountId?: string;
  sessionKey?: string;
  messageId?: string;
  deliveryTarget?: string;
  stateDir?: string;
}): ConversationTurnRecord | undefined {
  const sessionKey = params.sessionKey?.trim();
  const messageId = params.messageId?.trim();
  if (!sessionKey || !messageId) {
    return undefined;
  }
  const database = openDatabase(params.stateDir);
  let query = kysely(database.db)
    .selectFrom("conversation_turns")
    .selectAll()
    .where("session_key", "=", sessionKey)
    .where("message_id", "=", messageId);
  const channel = params.channel?.trim();
  if (channel) {
    query = query.where("channel", "=", channel);
  }
  if (params.accountId !== undefined) {
    query = query.where("account_id", "=", params.accountId.trim());
  }
  const deliveryTarget = params.deliveryTarget?.trim();
  if (deliveryTarget) {
    query = query.where("delivery_target", "=", deliveryTarget);
  }
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    query.orderBy("accepted_at", "desc").limit(1),
  );
  return row ? toRecord(row) : undefined;
}

export function listRecoverableConversationTurns(
  stateDir?: string,
  acceptedBeforeMs?: number,
): ConversationTurnRecord[] {
  const database = openDatabase(stateDir);
  let query = kysely(database.db)
    .selectFrom("conversation_turns")
    .selectAll()
    .where("status", "not in", [
      "succeeded",
      "completed_no_send",
      "completed_untracked",
      "recovery_sent",
    ]);
  if (acceptedBeforeMs !== undefined) {
    query = query.where("accepted_at", "<=", acceptedBeforeMs);
  }
  return executeSqliteQuerySync(
    database.db,
    query.orderBy("accepted_at", "asc").orderBy("turn_id", "asc"),
  ).rows.map(toRecord);
}

function updateTurn(
  turnId: string,
  patch: Partial<ConversationTurnRow>,
  stateDir?: string,
): ConversationTurnRecord | undefined {
  const database = openDatabase(stateDir);
  return runOpenClawStateWriteTransaction(
    (tx) => {
      executeSqliteQuerySync(
        tx.db,
        kysely(tx.db).updateTable("conversation_turns").set(patch).where("turn_id", "=", turnId),
      );
      const row = selectById(tx.db, turnId);
      return row ? toRecord(row) : undefined;
    },
    { path: database.path },
  );
}

export function markConversationTurnRunning(turnId: string, stateDir?: string): void {
  const database = openDatabase(stateDir);
  executeSqliteQuerySync(
    database.db,
    kysely(database.db)
      .updateTable("conversation_turns")
      .set({ status: "running", updated_at: Date.now() })
      .where("turn_id", "=", turnId)
      .where("status", "=", "accepted"),
  );
}

export function prepareConversationTurnDelivery(
  turnId: string,
  deliveryQueueId: string,
  stateDir?: string,
): void {
  updateTurn(
    turnId,
    { original_delivery_queue_id: deliveryQueueId, updated_at: Date.now() },
    stateDir,
  );
}

export function markConversationTurnDeliveryDispatched(
  turnId: string,
  deliveryQueueId: string,
  stateDir?: string,
): void {
  const now = Date.now();
  updateTurn(
    turnId,
    {
      status: "delivery_dispatched",
      original_delivery_queue_id: deliveryQueueId,
      delivery_dispatched_at: now,
      updated_at: now,
    },
    stateDir,
  );
}

type ConversationTurnDeliveryEvidence =
  | { kind: "sent"; receipt: unknown }
  | { kind: "suppressed"; reason: string };

function readDeliveryEvidence(record: ConversationTurnRecord): ConversationTurnDeliveryEvidence[] {
  return Array.isArray(record.deliveryReceipt)
    ? (record.deliveryReceipt as ConversationTurnDeliveryEvidence[])
    : [];
}

export function recordConversationTurnDeliveryEvidence(
  turnId: string,
  evidence: ConversationTurnDeliveryEvidence,
  stateDir?: string,
): void {
  const database = openDatabase(stateDir);
  runOpenClawStateWriteTransaction(
    (tx) => {
      const row = selectById(tx.db, turnId);
      if (!row) {
        return;
      }
      const record = toRecord(row);
      executeSqliteQuerySync(
        tx.db,
        kysely(tx.db)
          .updateTable("conversation_turns")
          .set({
            delivery_receipt_json: JSON.stringify([...readDeliveryEvidence(record), evidence]),
            last_error: null,
            updated_at: Date.now(),
          })
          .where("turn_id", "=", turnId),
      );
    },
    { path: database.path },
  );
}

function finalizeTurnFromDeliveryEvidence(
  turn: ConversationTurnRecord,
  stateDir?: string,
): "succeeded" | "completed_no_send" | undefined {
  const evidence = readDeliveryEvidence(turn);
  const now = Date.now();
  if (evidence.some((item) => item.kind === "sent")) {
    updateTurn(
      turn.turnId,
      { status: "succeeded", succeeded_at: now, last_error: null, updated_at: now },
      stateDir,
    );
    return "succeeded";
  }
  if (evidence.some((item) => item.kind === "suppressed")) {
    updateTurn(
      turn.turnId,
      { status: "completed_no_send", last_error: null, updated_at: now },
      stateDir,
    );
    return "completed_no_send";
  }
  return undefined;
}

export function finalizeConversationTurnDelivery(params: {
  channel?: string;
  accountId?: string;
  sessionKey?: string;
  messageId?: string;
  deliveryTarget?: string;
  stateDir?: string;
}): void {
  const turn = findConversationTurnForDelivery(params);
  if (
    !turn ||
    turn.status === "succeeded" ||
    turn.status === "completed_no_send" ||
    turn.status === "completed_untracked"
  ) {
    return;
  }
  if (finalizeTurnFromDeliveryEvidence(turn, params.stateDir)) {
    return;
  }
  const now = Date.now();
  // The complete dispatcher settled without a durable source-send receipt.
  // This covers intentional silence and successful legacy/plugin delivery;
  // neither may become a false restart interruption on a later startup.
  updateTurn(
    turn.turnId,
    { status: "completed_untracked", last_error: null, updated_at: now },
    params.stateDir,
  );
}

export function markConversationTurnUnknown(turnId: string, stateDir?: string): void {
  const now = Date.now();
  updateTurn(turnId, { status: "unknown", unknown_at: now, updated_at: now }, stateDir);
}

export function markConversationTurnRecoveryQueued(turnId: string, stateDir?: string): void {
  const now = Date.now();
  updateTurn(
    turnId,
    { status: "recovery_queued", recovery_queued_at: now, updated_at: now },
    stateDir,
  );
}

export function markConversationTurnRecoverySent(
  turnId: string,
  deliveryReceipt: unknown,
  stateDir?: string,
): void {
  const now = Date.now();
  updateTurn(
    turnId,
    {
      status: "recovery_sent",
      recovery_sent_at: now,
      delivery_receipt_json: JSON.stringify(deliveryReceipt),
      last_error: null,
      updated_at: now,
    },
    stateDir,
  );
}

export function recordConversationTurnRecoveryError(
  turnId: string,
  error: unknown,
  stateDir?: string,
): void {
  updateTurn(
    turnId,
    {
      last_error: error instanceof Error ? error.message : String(error),
      updated_at: Date.now(),
    },
    stateDir,
  );
}
