// Durable locks, external-effect dedupe, and freshness for agent mutations.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { mergeAbortSignals } from "../infra/abort-signal.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { AgentRunResourceScope } from "./agent-run-admission.js";

type MutationDatabase = Pick<
  OpenClawStateDatabase,
  | "agent_mutation_locks"
  | "agent_external_effects"
  | "agent_external_effect_events"
  | "agent_freshness_results"
  | "delivery_queue_entries"
>;

type ExternalEffectStatus = "prepared" | "submitting" | "applied" | "failed" | "unknown";
type FreshnessStatus = "fresh" | "revalidated" | "stale";

type Clock = () => number;

const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_MUTATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export type AgentMutationLease = {
  ownerId: string;
  runId: string;
  resources: ReadonlyMap<string, number>;
  renew: () => void;
  assertValid: () => void;
  release: () => void;
};

export type AgentExternalEffectResult<T> =
  | {
      status: "applied";
      idempotencyKey: string;
      value: T;
      replayed: boolean;
    }
  | {
      status: "failed";
      idempotencyKey: string;
      error?: string;
      replayed: boolean;
    }
  | {
      status: "unknown";
      idempotencyKey: string;
      error?: string;
      replayed: boolean;
    };

export type AgentFreshnessResult<T> =
  | { status: "fresh" | "revalidated"; value: T }
  | { status: "stale"; producedAt: number; deadlineAt: number };

export class AgentMutationFencingError extends Error {
  constructor(resourceKey: string) {
    super(`Mutation lease for "${resourceKey}" is stale or no longer owned by this worker.`);
    this.name = "AgentMutationFencingError";
  }
}

export class AgentExternalEffectUnknownError extends Error {
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string, detail?: string) {
    super(
      `External effect ${idempotencyKey} has an unknown outcome and must be reconciled before retry.${detail ? ` ${detail}` : ""}`,
    );
    this.name = "AgentExternalEffectUnknownError";
    this.idempotencyKey = idempotencyKey;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .toSorted()
      .map((key) => [key, canonicalize(record[key])]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? "null";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createAgentMutationResourceKey(kind: string, identity: unknown): string {
  return `${kind}:${sha256(stableJson(identity)).slice(0, 24)}`;
}

export function createAgentMutationFileResourceKey(filePath: string): string {
  return `memory-file:${sha256(path.resolve(filePath))}`;
}

function parseJson<T>(value: string | null): T | undefined {
  if (value === null) {
    return undefined;
  }
  return JSON.parse(value) as T;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(
        signal?.reason instanceof Error ? signal.reason : new Error("Lock acquisition aborted"),
      );
    };
    if (!signal) {
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeResourceKeys(keys: readonly string[]): string[] {
  return [...new Set(keys.map((key) => key.trim()).filter(Boolean))].toSorted();
}

function effectEvent(
  db: ReturnType<typeof openOpenClawStateDatabase>["db"],
  params: {
    idempotencyKey: string;
    status: ExternalEffectStatus;
    detail?: unknown;
    now: number;
  },
): void {
  const kysely = getNodeSqliteKysely<MutationDatabase>(db);
  executeSqliteQuerySync(
    db,
    kysely.insertInto("agent_external_effect_events").values({
      idempotency_key: params.idempotencyKey,
      status: params.status,
      detail_json: params.detail === undefined ? null : stableJson(params.detail),
      created_at: params.now,
    }),
  );
}

export class AgentMutationCoordinator {
  private readonly databaseOptions: OpenClawStateDatabaseOptions;
  private readonly now: Clock;
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly retentionMs: number;
  private readonly pruneIntervalMs: number;
  private readonly activeEffectSubmissions = new Set<string>();
  private nextPruneAt = 0;

  constructor(
    options: {
      databasePath?: string;
      env?: NodeJS.ProcessEnv;
      now?: Clock;
      leaseMs?: number;
      pollIntervalMs?: number;
      retentionMs?: number;
      pruneIntervalMs?: number;
    } = {},
  ) {
    this.databaseOptions = { path: options.databasePath, env: options.env };
    this.now = options.now ?? Date.now;
    this.leaseMs = Math.max(1, options.leaseMs ?? 30_000);
    this.pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 50);
    this.retentionMs = Math.max(1, options.retentionMs ?? DEFAULT_MUTATION_RETENTION_MS);
    this.pruneIntervalMs = Math.max(1, options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS);
  }

  async acquireResourceLocks(params: {
    resourceKeys: readonly string[];
    ownerId?: string;
    runId: string;
    signal?: AbortSignal;
    autoRenew?: boolean;
  }): Promise<AgentMutationLease> {
    this.maybePruneExpiredState();
    const resourceKeys = normalizeResourceKeys(params.resourceKeys);
    const ownerId = params.ownerId ?? randomUUID();
    if (resourceKeys.length === 0) {
      return {
        ownerId,
        runId: params.runId,
        resources: new Map(),
        renew: () => {},
        assertValid: () => {},
        release: () => {},
      };
    }

    let tokens: Map<string, number> | undefined;
    while (!tokens) {
      if (params.signal?.aborted) {
        throw params.signal.reason instanceof Error
          ? params.signal.reason
          : new Error("Lock acquisition aborted");
      }
      tokens = this.tryAcquireResourceLocks({
        resourceKeys,
        ownerId,
        runId: params.runId,
      });
      if (!tokens) {
        await sleep(this.pollIntervalMs, params.signal);
      }
    }

    let released = false;
    const assertValid = () => {
      if (released) {
        throw new AgentMutationFencingError(resourceKeys[0]);
      }
      this.assertLease(ownerId, tokens!);
    };
    const renew = () => {
      if (released) {
        throw new AgentMutationFencingError(resourceKeys[0]);
      }
      this.renewLease(ownerId, tokens!);
    };
    let interval: ReturnType<typeof setInterval> | undefined;
    if (params.autoRenew !== false) {
      interval = setInterval(
        () => {
          try {
            renew();
          } catch {
            if (interval) {
              clearInterval(interval);
            }
          }
        },
        Math.max(1, Math.floor(this.leaseMs / 3)),
      );
    }
    interval?.unref?.();

    return {
      ownerId,
      runId: params.runId,
      resources: tokens,
      renew,
      assertValid,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        if (interval) {
          clearInterval(interval);
        }
        this.releaseLease(ownerId, tokens!);
      },
    };
  }

  async runWithResourceLocks<T>(
    params: {
      resourceKeys: readonly string[];
      ownerId?: string;
      runId: string;
      signal?: AbortSignal;
    },
    task: (lease: AgentMutationLease) => Promise<T>,
  ): Promise<T> {
    const lease = await this.acquireResourceLocks(params);
    try {
      return await task(lease);
    } finally {
      lease.release();
    }
  }

  private tryAcquireResourceLocks(params: {
    resourceKeys: readonly string[];
    ownerId: string;
    runId: string;
  }): Map<string, number> | undefined {
    return runOpenClawStateWriteTransaction(({ db }) => {
      const kysely = getNodeSqliteKysely<MutationDatabase>(db);
      const now = this.now();
      const rows = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("agent_mutation_locks")
          .select(["resource_key", "fencing_token", "owner_id", "lease_expires_at"])
          .where("resource_key", "in", params.resourceKeys),
      ).rows;
      const byKey = new Map(rows.map((row) => [row.resource_key, row]));
      const blocked = params.resourceKeys.some((key) => {
        const row = byKey.get(key);
        return Boolean(
          row?.owner_id &&
          row.owner_id !== params.ownerId &&
          row.lease_expires_at !== null &&
          row.lease_expires_at > now,
        );
      });
      if (blocked) {
        return undefined;
      }

      const tokens = new Map<string, number>();
      for (const resourceKey of params.resourceKeys) {
        const row = byKey.get(resourceKey);
        const token =
          row?.owner_id === params.ownerId &&
          row.lease_expires_at !== null &&
          row.lease_expires_at > now
            ? row.fencing_token
            : (row?.fencing_token ?? 0) + 1;
        executeSqliteQuerySync(
          db,
          kysely
            .insertInto("agent_mutation_locks")
            .values({
              resource_key: resourceKey,
              fencing_token: token,
              owner_id: params.ownerId,
              owner_run_id: params.runId,
              lease_expires_at: now + this.leaseMs,
              acquired_at: now,
              updated_at: now,
            })
            .onConflict((conflict) =>
              conflict.column("resource_key").doUpdateSet({
                fencing_token: token,
                owner_id: params.ownerId,
                owner_run_id: params.runId,
                lease_expires_at: now + this.leaseMs,
                acquired_at: now,
                updated_at: now,
              }),
            ),
        );
        tokens.set(resourceKey, token);
      }
      return tokens;
    }, this.databaseOptions);
  }

  private assertLease(ownerId: string, tokens: ReadonlyMap<string, number>): void {
    const { db } = openOpenClawStateDatabase(this.databaseOptions);
    const kysely = getNodeSqliteKysely<MutationDatabase>(db);
    const now = this.now();
    for (const [resourceKey, token] of tokens) {
      const row = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("agent_mutation_locks")
          .select(["fencing_token", "owner_id", "lease_expires_at"])
          .where("resource_key", "=", resourceKey),
      );
      if (
        row?.owner_id !== ownerId ||
        row.fencing_token !== token ||
        row.lease_expires_at === null ||
        row.lease_expires_at <= now
      ) {
        throw new AgentMutationFencingError(resourceKey);
      }
    }
  }

  private renewLease(ownerId: string, tokens: ReadonlyMap<string, number>): void {
    runOpenClawStateWriteTransaction(({ db }) => {
      const kysely = getNodeSqliteKysely<MutationDatabase>(db);
      const now = this.now();
      for (const [resourceKey, token] of tokens) {
        const result = executeSqliteQuerySync(
          db,
          kysely
            .updateTable("agent_mutation_locks")
            .set({ lease_expires_at: now + this.leaseMs, updated_at: now })
            .where("resource_key", "=", resourceKey)
            .where("owner_id", "=", ownerId)
            .where("fencing_token", "=", token)
            .where("lease_expires_at", ">", now),
        );
        if (result.numAffectedRows !== 1n) {
          throw new AgentMutationFencingError(resourceKey);
        }
      }
    }, this.databaseOptions);
  }

  private releaseLease(ownerId: string, tokens: ReadonlyMap<string, number>): void {
    runOpenClawStateWriteTransaction(({ db }) => {
      const kysely = getNodeSqliteKysely<MutationDatabase>(db);
      const now = this.now();
      for (const [resourceKey, token] of tokens) {
        executeSqliteQuerySync(
          db,
          kysely
            .updateTable("agent_mutation_locks")
            .set({
              owner_id: null,
              owner_run_id: null,
              lease_expires_at: null,
              acquired_at: null,
              updated_at: now,
            })
            .where("resource_key", "=", resourceKey)
            .where("owner_id", "=", ownerId)
            .where("fencing_token", "=", token),
        );
      }
    }, this.databaseOptions);
  }

  createIdempotencyKey(params: { jobId: string; logicalSlot: string; effectKind: string }): string {
    return `effect:${sha256(stableJson(params))}`;
  }

  async executeExternalEffect<T>(params: {
    jobId: string;
    runId: string;
    /** Stable controller-owned effect identity reused by every attempt of this job. */
    logicalSlot: string;
    effectKind: string;
    resourceKey?: string;
    payload: unknown;
    /**
     * Dynamic model tool calls cannot prove a new slot is a new intention after
     * worker replacement. Fail closed instead of letting replanning duplicate it.
     */
    rejectNewSlotAfterRunChange?: boolean;
    submit: (idempotencyKey: string) => Promise<T>;
    classifySubmitError?: (error: unknown) => { status: "failed" | "unknown"; error?: string };
    reconcile?: (
      idempotencyKey: string,
    ) => Promise<
      | { status: "applied"; value: T }
      | { status: "failed"; error?: string }
      | { status: "unknown"; error?: string }
    >;
  }): Promise<AgentExternalEffectResult<T>> {
    this.maybePruneExpiredState();
    const idempotencyKey = this.createIdempotencyKey({
      jobId: params.jobId,
      logicalSlot: params.logicalSlot,
      effectKind: params.effectKind,
    });
    const payloadHash = sha256(stableJson(params.payload));
    const row = this.prepareEffect({
      idempotencyKey,
      jobId: params.jobId,
      runId: params.runId,
      logicalSlot: params.logicalSlot,
      effectKind: params.effectKind,
      resourceKey: params.resourceKey,
      payloadHash,
      rejectNewSlotAfterRunChange: params.rejectNewSlotAfterRunChange,
    });
    if (row.status === "applied") {
      return {
        status: "applied",
        idempotencyKey,
        value: parseJson<T>(row.result_json) as T,
        replayed: true,
      };
    }
    if (row.status === "failed") {
      return { status: "failed", idempotencyKey, error: row.error ?? undefined, replayed: true };
    }
    if (row.status === "submitting" || row.status === "unknown") {
      if (row.status === "submitting" && this.activeEffectSubmissions.has(idempotencyKey)) {
        return {
          status: "unknown",
          idempotencyKey,
          error: "The original provider submission is still in progress; do not retry it.",
          replayed: true,
        };
      }
      if (!params.reconcile) {
        if (row.status === "submitting") {
          return this.completeEffect(
            idempotencyKey,
            {
              status: "unknown",
              error: "Worker stopped after submission; provider reconciliation is required.",
            },
            true,
          );
        }
        return { status: "unknown", idempotencyKey, error: row.error ?? undefined, replayed: true };
      }
      try {
        const reconciled = await params.reconcile(idempotencyKey);
        return this.completeEffect(idempotencyKey, reconciled, true);
      } catch (error) {
        return this.completeEffect(
          idempotencyKey,
          { status: "unknown", error: String(error) },
          true,
        );
      }
    }

    if (!this.claimEffectSubmission(idempotencyKey)) {
      return {
        status: "unknown",
        idempotencyKey,
        error: "Another worker already claimed this logical effect for submission.",
        replayed: true,
      };
    }
    this.activeEffectSubmissions.add(idempotencyKey);
    try {
      const value = await params.submit(idempotencyKey);
      return this.completeEffect(idempotencyKey, { status: "applied", value }, false);
    } catch (error) {
      const classified = params.classifySubmitError?.(error);
      return this.completeEffect(
        idempotencyKey,
        classified ?? { status: "unknown", error: String(error) },
        false,
      );
    } finally {
      this.activeEffectSubmissions.delete(idempotencyKey);
    }
  }

  private prepareEffect(params: {
    idempotencyKey: string;
    jobId: string;
    runId: string;
    logicalSlot: string;
    effectKind: string;
    resourceKey?: string;
    payloadHash: string;
    rejectNewSlotAfterRunChange?: boolean;
  }) {
    return runOpenClawStateWriteTransaction(({ db }) => {
      const kysely = getNodeSqliteKysely<MutationDatabase>(db);
      const now = this.now();
      const existing = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("agent_external_effects")
          .selectAll()
          .where("idempotency_key", "=", params.idempotencyKey),
      );
      if (existing) {
        if (
          existing.job_id !== params.jobId ||
          existing.logical_slot !== params.logicalSlot ||
          existing.effect_kind !== params.effectKind ||
          existing.payload_hash !== params.payloadHash
        ) {
          throw new Error(`Idempotency key collision for ${params.idempotencyKey}`);
        }
        return existing;
      }
      if (params.rejectNewSlotAfterRunChange) {
        const priorEffects = executeSqliteQuerySync(
          db,
          kysely
            .selectFrom("agent_external_effects")
            .select(["idempotency_key", "logical_slot", "run_id", "status"])
            .where("job_id", "=", params.jobId)
            .where("effect_kind", "=", params.effectKind),
        ).rows;
        const blockingEffect = priorEffects.find(
          (effect) =>
            effect.logical_slot !== params.logicalSlot &&
            (effect.run_id !== params.runId ||
              effect.status === "prepared" ||
              effect.status === "submitting" ||
              effect.status === "unknown"),
        );
        if (blockingEffect) {
          throw new Error(
            `Run ${params.runId} proposed a new dynamic effect slot while ${blockingEffect.idempotency_key} is ${blockingEffect.status}; reconcile the prior effect before authorizing another send.`,
          );
        }
      }
      executeSqliteQuerySync(
        db,
        kysely.insertInto("agent_external_effects").values({
          idempotency_key: params.idempotencyKey,
          job_id: params.jobId,
          run_id: params.runId,
          logical_slot: params.logicalSlot,
          effect_kind: params.effectKind,
          resource_key: params.resourceKey ?? null,
          payload_hash: params.payloadHash,
          status: "prepared",
          result_json: null,
          error: null,
          created_at: now,
          updated_at: now,
        }),
      );
      effectEvent(db, { idempotencyKey: params.idempotencyKey, status: "prepared", now });
      return executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("agent_external_effects")
          .selectAll()
          .where("idempotency_key", "=", params.idempotencyKey),
      )!;
    }, this.databaseOptions);
  }

  private claimEffectSubmission(idempotencyKey: string): boolean {
    return runOpenClawStateWriteTransaction(({ db }) => {
      const kysely = getNodeSqliteKysely<MutationDatabase>(db);
      const now = this.now();
      const result = executeSqliteQuerySync(
        db,
        kysely
          .updateTable("agent_external_effects")
          .set({ status: "submitting", updated_at: now })
          .where("idempotency_key", "=", idempotencyKey)
          .where("status", "=", "prepared"),
      );
      if (result.numAffectedRows !== 1n) {
        return false;
      }
      effectEvent(db, { idempotencyKey, status: "submitting", now });
      return true;
    }, this.databaseOptions);
  }

  private completeEffect<T>(
    idempotencyKey: string,
    outcome:
      | { status: "applied"; value: T }
      | { status: "failed"; error?: string }
      | { status: "unknown"; error?: string },
    replayed: boolean,
  ): AgentExternalEffectResult<T> {
    const completion = runOpenClawStateWriteTransaction(({ db }) => {
      const kysely = getNodeSqliteKysely<MutationDatabase>(db);
      const now = this.now();
      const existing = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("agent_external_effects")
          .selectAll()
          .where("idempotency_key", "=", idempotencyKey),
      );
      if (!existing) {
        throw new Error(`External effect ${idempotencyKey} disappeared before completion.`);
      }
      // A late submitter must not downgrade a conclusive reconciliation that
      // reached the ledger first.
      if (existing.status === "applied" || existing.status === "failed") {
        return { row: existing, preservedTerminalResult: true };
      }
      executeSqliteQuerySync(
        db,
        kysely
          .updateTable("agent_external_effects")
          .set({
            status: outcome.status,
            result_json: outcome.status === "applied" ? stableJson(outcome.value) : null,
            error: outcome.status === "applied" ? null : (outcome.error ?? null),
            updated_at: now,
          })
          .where("idempotency_key", "=", idempotencyKey),
      );
      effectEvent(db, {
        idempotencyKey,
        status: outcome.status,
        detail: outcome.status === "applied" ? { result: outcome.value } : { error: outcome.error },
        now,
      });
      const row = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("agent_external_effects")
          .selectAll()
          .where("idempotency_key", "=", idempotencyKey),
      );
      if (!row) {
        throw new Error(`External effect ${idempotencyKey} disappeared after completion.`);
      }
      return { row, preservedTerminalResult: false };
    }, this.databaseOptions);
    if (completion.row.status === "applied") {
      return {
        status: "applied",
        idempotencyKey,
        value: parseJson<T>(completion.row.result_json) as T,
        replayed: replayed || completion.preservedTerminalResult,
      };
    }
    if (completion.row.status !== "failed" && completion.row.status !== "unknown") {
      throw new Error(
        `External effect ${idempotencyKey} remained ${completion.row.status} after completion.`,
      );
    }
    return {
      status: completion.row.status,
      idempotencyKey,
      error: completion.row.error ?? undefined,
      replayed: replayed || completion.preservedTerminalResult,
    };
  }

  async commitFile(params: {
    jobId: string;
    runId: string;
    filePath: string;
    update: (current: string) => string | Promise<string>;
    signal?: AbortSignal;
    lockWaitTimeoutMs?: number;
  }): Promise<void> {
    const resourceKey = createAgentMutationFileResourceKey(params.filePath);
    const lockWaitTimeoutMs = Math.max(1, params.lockWaitTimeoutMs ?? DEFAULT_LOCK_WAIT_TIMEOUT_MS);
    const lockWaitSignal = AbortSignal.timeout(lockWaitTimeoutMs);
    const combinedSignal = mergeAbortSignals([params.signal, lockWaitSignal]);
    try {
      await this.runWithResourceLocks(
        {
          resourceKeys: [resourceKey],
          runId: params.runId,
          signal: combinedSignal.signal,
        },
        async (lease) => {
          const before = await readFile(params.filePath, "utf8").catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") {
                return "";
              }
              throw error;
            },
          );
          const next = await params.update(before);
          lease.assertValid();
          const current = await readFile(params.filePath, "utf8").catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") {
                return "";
              }
              throw error;
            },
          );
          if (sha256(current) !== sha256(before)) {
            throw new Error(
              `Memory commit conflict for ${params.filePath}; retry from fresh content.`,
            );
          }
          await mkdir(path.dirname(params.filePath), { recursive: true });
          const temporaryPath = `${params.filePath}.${randomUUID()}.tmp`;
          try {
            await writeFile(temporaryPath, next, "utf8");
            this.commitFencedFile({
              lease,
              resourceKey,
              expectedContentHash: sha256(before),
              filePath: params.filePath,
              temporaryPath,
            });
          } finally {
            await rm(temporaryPath, { force: true });
          }
        },
      );
    } finally {
      combinedSignal.dispose();
    }
  }

  private maybePruneExpiredState(): void {
    const now = this.now();
    if (now < this.nextPruneAt) {
      return;
    }
    this.nextPruneAt = now + this.pruneIntervalMs;
    const cutoff = now - this.retentionMs;
    runOpenClawStateWriteTransaction(({ db }) => {
      const kysely = getNodeSqliteKysely<MutationDatabase>(db);
      executeSqliteQuerySync(
        db,
        kysely
          .deleteFrom("agent_external_effect_events")
          .where(
            "idempotency_key",
            "in",
            kysely
              .selectFrom("agent_external_effects")
              .select("idempotency_key")
              .where("updated_at", "<", cutoff),
          ),
      );
      executeSqliteQuerySync(
        db,
        kysely.deleteFrom("agent_external_effects").where("updated_at", "<", cutoff),
      );
      executeSqliteQuerySync(
        db,
        kysely
          .deleteFrom("delivery_queue_entries")
          .where("queue_name", "=", "outbound")
          .where("status", "=", "sent")
          .where("updated_at", "<", cutoff),
      );
      executeSqliteQuerySync(
        db,
        kysely
          .deleteFrom("agent_mutation_locks")
          .where("owner_id", "is", null)
          .where("updated_at", "<", cutoff),
      );
      executeSqliteQuerySync(
        db,
        kysely.deleteFrom("agent_freshness_results").where("checked_at", "<", cutoff),
      );
    }, this.databaseOptions);
  }

  private commitFencedFile(params: {
    lease: AgentMutationLease;
    resourceKey: string;
    expectedContentHash: string;
    filePath: string;
    temporaryPath: string;
  }): void {
    runOpenClawStateWriteTransaction(({ db }) => {
      const kysely = getNodeSqliteKysely<MutationDatabase>(db);
      const token = params.lease.resources.get(params.resourceKey);
      const row = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("agent_mutation_locks")
          .select(["fencing_token", "owner_id", "lease_expires_at"])
          .where("resource_key", "=", params.resourceKey),
      );
      if (
        token === undefined ||
        row?.owner_id !== params.lease.ownerId ||
        row.fencing_token !== token ||
        row.lease_expires_at === null ||
        row.lease_expires_at <= this.now()
      ) {
        throw new AgentMutationFencingError(params.resourceKey);
      }
      let current = "";
      try {
        current = readFileSync(params.filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      if (sha256(current) !== params.expectedContentHash) {
        throw new Error(`Memory commit conflict for ${params.filePath}; retry from fresh content.`);
      }
      // Lock takeover uses the same SQLite write transaction. Keeping the
      // final rename inside it makes the fencing check and file commit one
      // broker decision, so an expired worker cannot race a replacement.
      renameSync(params.temporaryPath, params.filePath);
    }, this.databaseOptions);
  }

  async resolveFreshness<T>(params: {
    jobId: string;
    resultKey: string;
    deadlineAt: number;
    producedAt?: number;
    value: T;
    revalidate?: () => Promise<T | undefined>;
  }): Promise<AgentFreshnessResult<T>> {
    const producedAt = params.producedAt ?? this.now();
    let status: FreshnessStatus = producedAt <= params.deadlineAt ? "fresh" : "stale";
    let value: T | undefined = status === "fresh" ? params.value : undefined;
    if (status === "stale" && params.revalidate) {
      const revalidated = await params.revalidate();
      if (revalidated !== undefined) {
        status = "revalidated";
        value = revalidated;
      }
    }
    this.writeFreshness({
      jobId: params.jobId,
      resultKey: params.resultKey,
      deadlineAt: params.deadlineAt,
      producedAt,
      status,
      value,
    });
    return status === "stale"
      ? { status, producedAt, deadlineAt: params.deadlineAt }
      : { status, value: value as T };
  }

  private writeFreshness<T>(params: {
    jobId: string;
    resultKey: string;
    deadlineAt: number;
    producedAt: number;
    status: FreshnessStatus;
    value?: T;
  }): void {
    runOpenClawStateWriteTransaction(({ db }) => {
      const kysely = getNodeSqliteKysely<MutationDatabase>(db);
      executeSqliteQuerySync(
        db,
        kysely
          .insertInto("agent_freshness_results")
          .values({
            job_id: params.jobId,
            result_key: params.resultKey,
            deadline_at: params.deadlineAt,
            produced_at: params.producedAt,
            status: params.status,
            result_json: params.value === undefined ? null : stableJson(params.value),
            checked_at: this.now(),
          })
          .onConflict((conflict) =>
            conflict.columns(["job_id", "result_key"]).doUpdateSet({
              deadline_at: params.deadlineAt,
              produced_at: params.producedAt,
              status: params.status,
              result_json: params.value === undefined ? null : stableJson(params.value),
              checked_at: this.now(),
            }),
          ),
      );
    }, this.databaseOptions);
  }
}

export type AgentMutationContext = {
  coordinator: AgentMutationCoordinator;
  jobId: string;
  runId: string;
  resourceScope: AgentRunResourceScope;
  freshnessDeadlineAtMs?: number;
};

const mutationContext = new AsyncLocalStorage<AgentMutationContext>();
let defaultCoordinator = new AgentMutationCoordinator();

export function getAgentMutationContext(): AgentMutationContext | undefined {
  return mutationContext.getStore();
}

export async function runWithAgentMutationJob<T>(
  params: {
    jobId: string;
    runId: string;
    resourceScope: AgentRunResourceScope;
    freshnessDeadlineAtMs?: number;
  },
  task: () => Promise<T>,
): Promise<T> {
  return mutationContext.run(
    {
      coordinator: defaultCoordinator,
      jobId: params.jobId,
      runId: params.runId,
      resourceScope: params.resourceScope,
      freshnessDeadlineAtMs: params.freshnessDeadlineAtMs,
    },
    task,
  );
}

export function setDefaultAgentMutationCoordinatorForTest(
  coordinator: AgentMutationCoordinator | null,
): void {
  defaultCoordinator = coordinator ?? new AgentMutationCoordinator();
}

export function resolveAgentResultFreshness<T>(params: {
  jobId: string;
  resultKey: string;
  deadlineAt: number;
  producedAt?: number;
  value: T;
  revalidate?: () => Promise<T | undefined>;
}): Promise<AgentFreshnessResult<T>> {
  return defaultCoordinator.resolveFreshness(params);
}
