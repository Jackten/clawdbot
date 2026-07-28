import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import type { GatewayClient } from "./server-methods/types.js";

type TalkClientSessionRecord = {
  sessionKey?: string;
  expiresAtMs: number;
};

type TalkClientSessionRegistry = {
  byConnectionId: Map<string, TalkClientSessionRecord>;
};

type TalkClientSessionDatabase = Pick<OpenClawStateKyselyDatabase, "talk_client_sessions">;

const TALK_CLIENT_SESSION_REGISTRY_KEY = Symbol.for("openclaw.talkClientSessionRegistry");
const TALK_CLIENT_SESSION_IDLE_TTL_MS = 30 * 60_000;
const LOCAL_SHARED_CLI_OWNER_ID = "shared-gateway-auth:local-cli";

function getRegistry(): TalkClientSessionRegistry {
  return resolveGlobalSingleton(TALK_CLIENT_SESSION_REGISTRY_KEY, () => ({
    byConnectionId: new Map(),
  }));
}

function normalize(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

/**
 * Resolves the stable authenticated owner across WebSocket reconnects.
 * Device handshakes are installation-bound; the loopback CLI is an explicit
 * local-admin exception because each one-shot command opens a new connection.
 */
export function resolveTalkClientSessionOwnerId(
  client: GatewayClient | null | undefined,
): string | undefined {
  const deviceId = normalize(client?.connect?.device?.id);
  if (deviceId) {
    return deviceId;
  }
  if (
    client?.usesSharedGatewayAuth === true &&
    client.isLocal === true &&
    client.connect.client?.id === GATEWAY_CLIENT_IDS.CLI &&
    client.connect.client.mode === GATEWAY_CLIENT_MODES.CLI
  ) {
    return LOCAL_SHARED_CLI_OWNER_ID;
  }
  return undefined;
}

/** Records a provider-issued browser session against its owning gateway connection. */
export function rememberTalkClientSession(params: {
  connId?: string;
  deviceId?: string;
  sessionKey?: string;
  nowMs?: number;
}): void {
  const connId = normalize(params.connId);
  if (!connId) {
    return;
  }
  const nowMs = params.nowMs ?? Date.now();
  const deviceId = normalize(params.deviceId);
  const sessionKey = normalize(params.sessionKey);
  if (deviceId) {
    runOpenClawStateWriteTransaction(({ db }) => {
      const stateDb = getNodeSqliteKysely<TalkClientSessionDatabase>(db);
      executeSqliteQuerySync(
        db,
        stateDb.deleteFrom("talk_client_sessions").where("expires_at_ms", "<=", nowMs),
      );
      executeSqliteQuerySync(
        db,
        stateDb
          .insertInto("talk_client_sessions")
          .values({
            device_id: deviceId,
            conn_id: connId,
            session_key: sessionKey ?? null,
            expires_at_ms: nowMs + TALK_CLIENT_SESSION_IDLE_TTL_MS,
            updated_at_ms: nowMs,
          })
          .onConflict((conflict) =>
            conflict.column("device_id").doUpdateSet({
              conn_id: connId,
              session_key: sessionKey ?? null,
              expires_at_ms: nowMs + TALK_CLIENT_SESSION_IDLE_TTL_MS,
              updated_at_ms: nowMs,
            }),
          ),
      );
    });
    return;
  }
  const registry = getRegistry();
  for (const [candidateId, record] of registry.byConnectionId) {
    if (record.expiresAtMs <= nowMs) {
      registry.byConnectionId.delete(candidateId);
    }
  }
  registry.byConnectionId.set(connId, {
    ...(sessionKey ? { sessionKey } : {}),
    expiresAtMs: nowMs + TALK_CLIENT_SESSION_IDLE_TTL_MS,
  });
}

/**
 * Proves that this connection owns the browser Talk session, binding a
 * prefetched session to its first concrete OpenClaw session key.
 */
export function claimOwnedTalkClientSession(params: {
  connId?: string;
  deviceId?: string;
  sessionKey: string;
  nowMs?: number;
}): boolean {
  const connId = normalize(params.connId);
  const sessionKey = normalize(params.sessionKey);
  if (!connId || !sessionKey) {
    return false;
  }
  const nowMs = params.nowMs ?? Date.now();
  const deviceId = normalize(params.deviceId);
  if (deviceId) {
    return runOpenClawStateWriteTransaction(({ db }) => {
      const stateDb = getNodeSqliteKysely<TalkClientSessionDatabase>(db);
      const record = executeSqliteQueryTakeFirstSync(
        db,
        stateDb
          .selectFrom("talk_client_sessions")
          .select(["session_key", "expires_at_ms"])
          .where("device_id", "=", deviceId),
      );
      if (!record || record.expires_at_ms <= nowMs) {
        executeSqliteQuerySync(
          db,
          stateDb.deleteFrom("talk_client_sessions").where("device_id", "=", deviceId),
        );
        return false;
      }
      if (record.session_key && record.session_key !== sessionKey) {
        return false;
      }
      executeSqliteQuerySync(
        db,
        stateDb
          .updateTable("talk_client_sessions")
          .set({
            conn_id: connId,
            session_key: sessionKey,
            expires_at_ms: nowMs + TALK_CLIENT_SESSION_IDLE_TTL_MS,
            updated_at_ms: nowMs,
          })
          .where("device_id", "=", deviceId),
      );
      return true;
    });
  }
  const registry = getRegistry();
  const record = registry.byConnectionId.get(connId);
  if (!record || record.expiresAtMs <= nowMs) {
    registry.byConnectionId.delete(connId);
    return false;
  }
  if (record.sessionKey && record.sessionKey !== sessionKey) {
    return false;
  }
  record.sessionKey = sessionKey;
  record.expiresAtMs = nowMs + TALK_CLIENT_SESSION_IDLE_TTL_MS;
  return true;
}

export function resetTalkClientSessionRegistryForTest(): void {
  getRegistry().byConnectionId.clear();
  const { db } = openOpenClawStateDatabase();
  const stateDb = getNodeSqliteKysely<TalkClientSessionDatabase>(db);
  executeSqliteQuerySync(db, stateDb.deleteFrom("talk_client_sessions"));
}
