import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  AgentMutationCoordinator,
  AgentMutationFencingError,
  createAgentMutationFileResourceKey,
  runWithAgentMutationJob,
} from "./agent-mutation-coordinator.js";
import { deriveAgentRunResourceScope } from "./agent-run-admission.js";

let temporaryDirectory: string;
let databasePath: string;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "openclaw-mutation-"));
  databasePath = path.join(temporaryDirectory, "state.sqlite");
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function coordinator(
  options: {
    now?: () => number;
    leaseMs?: number;
    retentionMs?: number;
    pruneIntervalMs?: number;
  } = {},
) {
  return new AgentMutationCoordinator({
    databasePath,
    pollIntervalMs: 1,
    ...options,
  });
}

function seedExternalEffect(params: {
  mutations: AgentMutationCoordinator;
  jobId: string;
  runId: string;
  logicalSlot: string;
  effectKind: string;
  payload: unknown;
  status: "prepared" | "submitting";
}): string {
  const idempotencyKey = params.mutations.createIdempotencyKey({
    jobId: params.jobId,
    logicalSlot: params.logicalSlot,
    effectKind: params.effectKind,
  });
  const payloadHash = createHash("sha256").update(JSON.stringify(params.payload)).digest("hex");
  const now = Date.now();
  const { db } = openOpenClawStateDatabase({ path: databasePath });
  db.prepare(
    `INSERT INTO agent_external_effects (
       idempotency_key, job_id, run_id, logical_slot, effect_kind,
       resource_key, payload_hash, status, result_json, error, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?, ?)`,
  ).run(
    idempotencyKey,
    params.jobId,
    params.runId,
    params.logicalSlot,
    params.effectKind,
    payloadHash,
    params.status,
    now,
    now,
  );
  return idempotencyKey;
}

describe("agent mutation coordinator", () => {
  it("reconciles an unknown submitted effect without sending it twice", async () => {
    const mutations = coordinator();
    const externalReceipts = new Map<string, { providerId: string }>();
    const submit = vi.fn(async (idempotencyKey: string) => {
      externalReceipts.set(idempotencyKey, { providerId: "sent-1" });
      // Simulates worker death after the provider accepted the effect but before
      // OpenClaw could observe the returned receipt.
      return new Promise<{ providerId: string }>(() => {});
    });
    const request = {
      jobId: "job-send",
      runId: "run-1",
      logicalSlot: "message-1",
      effectKind: "message.send",
      resourceKey: "message:thread-1",
      payload: { to: "thread-1", text: "hello" },
      submit,
    };

    void mutations.executeExternalEffect(request);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));

    closeOpenClawStateDatabaseForTest();
    const afterRestart = coordinator();
    const reconciled = await afterRestart.executeExternalEffect({
      ...request,
      runId: "replacement-run",
      submit,
      reconcile: async (idempotencyKey) => {
        const receipt = externalReceipts.get(idempotencyKey);
        return receipt
          ? { status: "applied" as const, value: receipt }
          : { status: "unknown" as const };
      },
    });

    expect(reconciled).toMatchObject({
      status: "applied",
      replayed: true,
      value: { providerId: "sent-1" },
    });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a replacement model invents a new dynamic effect slot", async () => {
    const mutations = coordinator();
    const submit = vi.fn(async () => ({ providerId: "sent" }));
    const base = {
      jobId: "dynamic-job",
      effectKind: "message.send",
      resourceKey: "message:thread",
      payload: { to: "thread", text: "hello" },
      rejectNewSlotAfterRunChange: true,
      submit,
    };
    await expect(
      mutations.executeExternalEffect({
        ...base,
        runId: "attempt-1",
        logicalSlot: "message-tool:call-1",
      }),
    ).resolves.toMatchObject({ status: "applied" });

    await expect(
      mutations.executeExternalEffect({
        ...base,
        runId: "attempt-2",
        logicalSlot: "message-tool:new-call-after-replan",
      }),
    ).rejects.toThrow("proposed a new dynamic effect slot");
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a new same-run slot while an earlier effect is unknown", async () => {
    const mutations = coordinator();
    const submit = vi.fn(async () => {
      throw new Error("provider timeout");
    });
    const base = {
      jobId: "same-run-job",
      runId: "attempt-1",
      effectKind: "message.send",
      resourceKey: "message:thread",
      payload: { to: "thread", text: "hello" },
      rejectNewSlotAfterRunChange: true,
      submit,
    };
    await expect(
      mutations.executeExternalEffect({
        ...base,
        logicalSlot: "message-tool:first",
      }),
    ).resolves.toMatchObject({ status: "unknown" });

    await expect(
      mutations.executeExternalEffect({
        ...base,
        logicalSlot: "message-tool:model-retry",
      }),
    ).rejects.toThrow("reconcile the prior effect");
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a new same-run slot even when the model re-addresses the resource", async () => {
    const mutations = coordinator();
    const submit = vi.fn(async () => {
      throw new Error("provider timeout");
    });
    const base = {
      jobId: "same-run-readdress-job",
      runId: "attempt-1",
      effectKind: "message.send",
      payload: { text: "hello" },
      rejectNewSlotAfterRunChange: true,
      submit,
    };
    await expect(
      mutations.executeExternalEffect({
        ...base,
        logicalSlot: "message-tool:first",
        resourceKey: "message:target-field",
      }),
    ).resolves.toMatchObject({ status: "unknown" });

    await expect(
      mutations.executeExternalEffect({
        ...base,
        logicalSlot: "message-tool:model-retry",
        resourceKey: "message:to-field",
      }),
    ).rejects.toThrow("reconcile the prior effect");
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("rejects changed payload under one controller-owned logical slot", async () => {
    const mutations = coordinator();
    const submit = vi.fn(async () => ({ ok: true }));
    const base = {
      jobId: "stable-slot-job",
      runId: "attempt-1",
      logicalSlot: "food-entry-1",
      effectKind: "food-log.upsert",
      resourceKey: "food-log:2026-07-27",
      submit,
    };
    await mutations.executeExternalEffect({ ...base, payload: { calories: 500 } });
    await expect(
      mutations.executeExternalEffect({
        ...base,
        runId: "attempt-2",
        payload: { calories: 700 },
      }),
    ).rejects.toThrow("Idempotency key collision");
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("allows only one worker to claim a prepared logical effect", async () => {
    const mutations = coordinator();
    let finishSubmit!: (value: { receipt: string }) => void;
    const pendingSubmit = new Promise<{ receipt: string }>((resolve) => {
      finishSubmit = resolve;
    });
    const submit = vi.fn(() => pendingSubmit);
    const request = {
      jobId: "claim-job",
      runId: "attempt-1",
      logicalSlot: "send-once",
      effectKind: "message.send",
      resourceKey: "message:thread",
      payload: { text: "one" },
      submit,
    };

    const first = mutations.executeExternalEffect(request);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const contender = await mutations.executeExternalEffect(request);
    expect(contender).toMatchObject({ status: "unknown", replayed: true });
    expect(submit).toHaveBeenCalledTimes(1);

    finishSubmit({ receipt: "sent" });
    await expect(first).resolves.toMatchObject({ status: "applied" });
  });

  it("does not let a late submit failure downgrade an applied reconciliation", async () => {
    const mutations = coordinator();
    let rejectSubmit!: (error: Error) => void;
    const submit = vi.fn(
      () =>
        new Promise<{ receipt: string }>((_resolve, reject) => {
          rejectSubmit = reject;
        }),
    );
    const request = {
      jobId: "completion-race-job",
      runId: "attempt-1",
      logicalSlot: "send-once",
      effectKind: "message.send",
      resourceKey: "message:thread",
      payload: { text: "one" },
      submit,
    };

    const first = mutations.executeExternalEffect(request);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    openOpenClawStateDatabase({ path: databasePath })
      .db.prepare(
        `UPDATE agent_external_effects
         SET status = 'applied', result_json = ?, error = NULL
         WHERE job_id = ?`,
      )
      .run(JSON.stringify({ receipt: "reconciled-sent" }), request.jobId);
    rejectSubmit(new Error("late local timeout"));

    await expect(first).resolves.toMatchObject({
      status: "applied",
      value: { receipt: "reconciled-sent" },
      replayed: true,
    });
  });

  it("recovers committed pre-dispatch crash boundaries without blind resends", async () => {
    const fresh = coordinator();
    const freshSubmit = vi.fn(async () => ({ receipt: "fresh" }));
    await expect(
      fresh.executeExternalEffect({
        jobId: "before-prepared",
        runId: "attempt-1",
        logicalSlot: "send",
        effectKind: "message.send",
        payload: { text: "before prepared" },
        submit: freshSubmit,
      }),
    ).resolves.toMatchObject({ status: "applied" });
    expect(freshSubmit).toHaveBeenCalledTimes(1);

    const prepared = coordinator();
    const preparedRequest = {
      jobId: "after-prepared",
      runId: "attempt-1",
      logicalSlot: "send",
      effectKind: "message.send",
      payload: { text: "after prepared" },
    };
    seedExternalEffect({ mutations: prepared, ...preparedRequest, status: "prepared" });
    closeOpenClawStateDatabaseForTest();
    const preparedSubmit = vi.fn(async () => ({ receipt: "prepared" }));
    await expect(
      coordinator().executeExternalEffect({
        ...preparedRequest,
        runId: "attempt-2",
        submit: preparedSubmit,
      }),
    ).resolves.toMatchObject({ status: "applied" });
    expect(preparedSubmit).toHaveBeenCalledTimes(1);

    const submitting = coordinator();
    const submittingRequest = {
      jobId: "after-submitting",
      runId: "attempt-1",
      logicalSlot: "send",
      effectKind: "message.send",
      payload: { text: "after submitting" },
    };
    seedExternalEffect({ mutations: submitting, ...submittingRequest, status: "submitting" });
    closeOpenClawStateDatabaseForTest();
    const submittingSubmit = vi.fn(async () => ({ receipt: "must-not-send" }));
    const reconcile = vi.fn(async () => ({
      status: "failed" as const,
      error: "sink confirms no request was written",
    }));
    await expect(
      coordinator().executeExternalEffect({
        ...submittingRequest,
        runId: "attempt-2",
        submit: submittingSubmit,
        reconcile,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      replayed: true,
    });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(submittingSubmit).not.toHaveBeenCalled();
  });

  it("rejects a stale worker after its expired lease is replaced", async () => {
    let now = 100;
    const mutations = coordinator({ now: () => now, leaseMs: 10 });
    const stale = await mutations.acquireResourceLocks({
      resourceKeys: ["memory:page"],
      ownerId: "old-worker",
      runId: "old-run",
      autoRenew: false,
    });
    expect(stale.resources.get("memory:page")).toBe(1);

    now = 111;
    const replacement = await mutations.acquireResourceLocks({
      resourceKeys: ["memory:page"],
      ownerId: "new-worker",
      runId: "new-run",
      autoRenew: false,
    });
    expect(replacement.resources.get("memory:page")).toBe(2);
    expect(() => stale.assertValid()).toThrow(AgentMutationFencingError);
    expect(() => stale.renew()).toThrow(AgentMutationFencingError);

    stale.release();
    replacement.assertValid();
    replacement.release();
  });

  it("rejects a stale file commit after lock takeover", async () => {
    let now = 100;
    const mutations = coordinator({ now: () => now, leaseMs: 10 });
    const filePath = path.join(temporaryDirectory, "memory", "stale.md");
    let replacement:
      | Awaited<ReturnType<AgentMutationCoordinator["acquireResourceLocks"]>>
      | undefined;

    const staleCommit = mutations.commitFile({
      jobId: "old-job",
      runId: "old-run",
      filePath,
      update: async () => {
        now = 111;
        replacement = await mutations.acquireResourceLocks({
          resourceKeys: [createAgentMutationFileResourceKey(filePath)],
          ownerId: "replacement",
          runId: "new-run",
          autoRenew: false,
        });
        return "stale write\n";
      },
    });

    await expect(staleCommit).rejects.toThrow(AgentMutationFencingError);
    await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    replacement?.release();
  });

  it("brokers concurrent writes to one memory page without losing either update", async () => {
    const mutations = coordinator();
    const filePath = path.join(temporaryDirectory, "memory", "page.md");
    let releaseFirst!: () => void;
    const firstPaused = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstRead = false;

    const first = mutations.commitFile({
      jobId: "job-one",
      runId: "run-one",
      filePath,
      update: async (current) => {
        firstRead = true;
        await firstPaused;
        return `${current}first\n`;
      },
    });
    await vi.waitFor(() => expect(firstRead).toBe(true));
    const second = mutations.commitFile({
      jobId: "job-two",
      runId: "run-two",
      filePath,
      update: async (current) => `${current}second\n`,
    });

    releaseFirst();
    await Promise.all([first, second]);
    expect(await readFile(filePath, "utf8")).toBe("first\nsecond\n");
  });

  it("cancels a file-commit lock wait with the run signal", async () => {
    const mutations = coordinator();
    const filePath = path.join(temporaryDirectory, "memory", "blocked.md");
    const lock = await mutations.acquireResourceLocks({
      resourceKeys: [createAgentMutationFileResourceKey(filePath)],
      ownerId: "holder",
      runId: "holder-run",
    });
    const controller = new AbortController();
    const blockedCommit = mutations.commitFile({
      jobId: "waiting-job",
      runId: "waiting-run",
      filePath,
      signal: controller.signal,
      update: () => "should not land\n",
    });

    controller.abort(new Error("run cancelled"));
    await expect(blockedCommit).rejects.toThrow("run cancelled");
    lock.release();
  });

  it.each([
    "log 200g of chicken to my diary",
    "add 3 eggs and toast to cronometer",
    "reorder my supplements",
    "get me a new coffee filter from amazon",
    "what did I log for breakfast today",
    "did the amazon order ship yet",
    "remind me to buy milk tomorrow",
  ])("never treats prompt-derived scope as an effect authorization gate: %s", async (request) => {
    const task = vi.fn(async () => "model-started");
    await expect(
      runWithAgentMutationJob(
        {
          jobId: `prompt-job:${request}`,
          runId: `prompt-run:${request}`,
          resourceScope: deriveAgentRunResourceScope({ request }),
        },
        task,
      ),
    ).resolves.toBe("model-started");
    expect(task).toHaveBeenCalledOnce();
  });

  it("prunes expired effect projections before accepting new work", async () => {
    let now = 0;
    const mutations = coordinator({
      now: () => now,
      retentionMs: 100,
      pruneIntervalMs: 1,
    });
    const submit = vi.fn(async () => ({ ok: true }));
    const first = {
      jobId: "retention-job",
      runId: "run-1",
      logicalSlot: "first",
      effectKind: "message.send",
      payload: { text: "first" },
      submit,
    };
    await mutations.executeExternalEffect(first);

    now = 101;
    await mutations.executeExternalEffect({
      ...first,
      jobId: "retention-trigger",
      logicalSlot: "second",
      payload: { text: "second" },
    });
    await mutations.executeExternalEffect(first);

    expect(submit).toHaveBeenCalledTimes(3);
  });

  it("marks a result past its deadline stale instead of returning it as current", async () => {
    const mutations = coordinator({ now: () => 1_100 });
    const stale = await mutations.resolveFreshness({
      jobId: "weather-job",
      resultKey: "forecast",
      deadlineAt: 1_000,
      producedAt: 1_100,
      value: { temperature: 81 },
    });

    expect(stale).toEqual({
      status: "stale",
      producedAt: 1_100,
      deadlineAt: 1_000,
    });
    expect(stale).not.toHaveProperty("value");

    const revalidated = await mutations.resolveFreshness({
      jobId: "weather-job",
      resultKey: "forecast",
      deadlineAt: 1_000,
      producedAt: 1_100,
      value: { temperature: 81 },
      revalidate: async () => ({ temperature: 82 }),
    });
    expect(revalidated).toEqual({
      status: "revalidated",
      value: { temperature: 82 },
    });
  });
});
