import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentMutationCoordinator,
  setDefaultAgentMutationCoordinatorForTest,
} from "../agents/agent-mutation-coordinator.js";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import type { EmbeddedAgentRunResult } from "../agents/embedded-agent-runner/types.js";
import type {
  ForkSessionEntryFromParentParams,
  ForkSessionEntryFromParentResult,
} from "../auto-reply/reply/session-fork.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { runExclusiveSessionLifecycleMutation } from "../sessions/session-lifecycle-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  cancelTaskById,
  getTaskById,
  listTasksForOwnerKey,
  maybeDeliverTaskTerminalUpdate,
  reloadTaskRegistryFromStore,
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
  setTaskRegistryDeliveryRuntimeForTests,
} from "../tasks/runtime-internal.js";
import {
  configureTaskRegistryRuntime,
  type TaskRegistryStore,
} from "../tasks/task-registry.store.js";
import { installInMemoryTaskRegistryRuntime } from "../test-utils/task-registry-runtime.js";
import {
  setRealtimeVoiceAgentConsultDepsForTest,
  consultRealtimeVoiceAgent,
  resolveRealtimeVoiceAgentConsultTools,
  resolveRealtimeVoiceAgentConsultToolsAllow,
} from "./agent-consult-runtime.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL } from "./agent-consult-tool.js";

function createAgentRuntime(
  payloads: NonNullable<EmbeddedAgentRunResult["payloads"]> = [{ text: "Speak this." }],
) {
  const sessionStore: Record<
    string,
    {
      sessionId?: string;
      updatedAt?: number;
      archivedAt?: number;
      sessionFile?: string;
      spawnedBy?: string;
      forkedFromParent?: boolean;
      totalTokens?: number;
      deliveryContext?: {
        channel?: string;
        to?: string;
        accountId?: string;
        threadId?: string | number;
      };
      lastChannel?: string;
      lastTo?: string;
      lastAccountId?: string;
      lastThreadId?: string | number;
    }
  > = {};
  const runEmbeddedAgent = vi.fn(
    async (_params: RunEmbeddedAgentParams): Promise<EmbeddedAgentRunResult> => ({
      payloads,
      meta: { durationMs: 0 },
    }),
  );
  const updateSessionStore = vi.fn(
    async (
      _storePath: string,
      mutator: (store: Record<string, { sessionId?: string; updatedAt?: number }>) => unknown,
    ) => {
      return await mutator(sessionStore);
    },
  );
  const getSessionEntry = vi.fn(
    (params: { sessionKey: string }) => sessionStore[params.sessionKey],
  );
  const patchSessionEntry = vi.fn(
    async (params: {
      sessionKey: string;
      fallbackEntry?: Record<string, unknown>;
      update: (
        entry: Record<string, unknown>,
      ) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
    }) => {
      const existing = sessionStore[params.sessionKey] ?? params.fallbackEntry;
      if (!existing) {
        return null;
      }
      const patch = await params.update({ ...existing });
      if (!patch) {
        return existing;
      }
      const next = { ...existing, ...patch };
      sessionStore[params.sessionKey] = next;
      return next;
    },
  );
  const upsertSessionEntry = vi.fn(
    async (params: { sessionKey: string; entry: Record<string, unknown> }) => {
      sessionStore[params.sessionKey] = { ...params.entry };
    },
  );
  return {
    runtime: {
      resolveAgentDir: vi.fn(() => "/tmp/agent"),
      resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
      ensureAgentWorkspace: vi.fn(async () => {}),
      resolveAgentTimeoutMs: vi.fn(() => 30_000),
      session: {
        resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
        loadSessionStore: vi.fn(() => sessionStore),
        saveSessionStore: vi.fn(async () => {}),
        updateSessionStore,
        getSessionEntry,
        patchSessionEntry,
        upsertSessionEntry,
        resolveSessionFilePath: vi.fn(
          (_sessionId: string, entry?: { sessionFile?: string }) =>
            entry?.sessionFile ?? "/tmp/session.json",
        ),
      },
      runEmbeddedAgent,
    },
    runEmbeddedAgent,
    sessionStore,
  };
}

function requireEmbeddedAgentCall(runEmbeddedAgent: {
  mock: { calls: unknown[][] };
}): RunEmbeddedAgentParams {
  const [call] = runEmbeddedAgent.mock.calls;
  if (!call) {
    throw new Error("Expected embedded OpenClaw agent call");
  }
  const [params] = call;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("Expected embedded OpenClaw agent params to be an object");
  }
  return params as RunEmbeddedAgentParams;
}

function expectPositiveTimestamp(value: unknown) {
  expect(typeof value).toBe("number");
  expect(value as number).toBeGreaterThan(0);
}

function expectNonEmptyString(value: unknown) {
  expect(typeof value).toBe("string");
  expect((value as string).trim()).not.toBe("");
}

function createDeferred() {
  let resolve = () => {};
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createDeferredValue<T>() {
  let resolve = (_value: T) => {};
  let reject = (_error: unknown) => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("realtime voice agent consult runtime", () => {
  const sendMessage = vi.fn(async (params: { channel?: string; to: string }) => ({
    channel: params.channel ?? "unknown",
    to: params.to,
    via: "direct" as const,
    mediaUrl: null,
  }));
  let taskStore: TaskRegistryStore;

  beforeEach(() => {
    resetTaskRegistryForTests({ persist: false });
    ({ taskStore } = installInMemoryTaskRegistryRuntime());
    setTaskRegistryDeliveryRuntimeForTests({ sendMessage });
  });

  afterEach(() => {
    setDefaultAgentMutationCoordinatorForTest(null);
    setRealtimeVoiceAgentConsultDepsForTest(null);
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryForTests({ persist: false });
    sendMessage.mockReset();
  });

  it("exposes the shared consult tool based on policy", () => {
    expect(resolveRealtimeVoiceAgentConsultTools("safe-read-only")).toStrictEqual([
      REALTIME_VOICE_AGENT_CONSULT_TOOL,
    ]);
    expect(resolveRealtimeVoiceAgentConsultTools("none")).toStrictEqual([]);
    expect(resolveRealtimeVoiceAgentConsultToolsAllow("safe-read-only")).toEqual([
      "read",
      "web_search",
      "web_fetch",
      "x_search",
      "memory_search",
      "memory_get",
    ]);
    expect(resolveRealtimeVoiceAgentConsultToolsAllow("owner")).toBeUndefined();
    expect(resolveRealtimeVoiceAgentConsultToolsAllow("none")).toStrictEqual([]);
  });

  it("runs an embedded agent using the shared session and prompt contract", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime();

    const result = await consultRealtimeVoiceAgent({
      cfg: {} as never,
      agentRuntime: runtime as never,
      logger: { warn: vi.fn() },
      sessionKey: "voice:15550001234",
      messageProvider: "voice",
      lane: "voice",
      runIdPrefix: "voice-realtime-consult:call-1",
      args: { question: "What should I say?", context: "Caller asked about PR #123." },
      transcript: [{ role: "user", text: "Can you check this?" }],
      surface: "a live phone call",
      userLabel: "Caller",
      questionSourceLabel: "caller",
      toolsAllow: ["read"],
      provider: "openai",
      model: "gpt-5.4",
      thinkLevel: "high",
      fastMode: true,
      timeoutMs: 10_000,
    });

    expect(result).toEqual({ text: "Speak this." });
    const voiceSession = sessionStore["voice:15550001234"];
    if (!voiceSession) {
      throw new Error("Expected voice consult session entry");
    }
    expect(Object.keys(voiceSession).toSorted()).toStrictEqual(["sessionId", "updatedAt"]);
    expectNonEmptyString(voiceSession.sessionId);
    expectPositiveTimestamp(voiceSession.updatedAt);
    const call = requireEmbeddedAgentCall(runEmbeddedAgent);
    expect(call.sessionId).toBe(voiceSession.sessionId);
    expect(call.sessionKey).toBe("voice:15550001234");
    expect(call.sandboxSessionKey).toBe("agent:main:voice:15550001234");
    expect(call.agentId).toBe("main");
    expect(call.messageProvider).toBe("voice");
    expect(call.lane).toBe("voice");
    expect(call.admission).toMatchObject({
      priority: "background",
      resourceScope: { kind: "keys", keys: [] },
      onQueueReason: expect.any(Function),
    });
    expect(call.toolsAllow).toStrictEqual(["read"]);
    expect(call.provider).toBe("openai");
    expect(call.model).toBe("gpt-5.4");
    expect(call.thinkLevel).toBe("high");
    expect(call.fastMode).toBe(true);
    expect(call.timeoutMs).toBe(10_000);
    expect(call.prompt).toBe(
      [
        "Live voice request from the caller during a live phone call.",
        "Act as the configured OpenClaw agent on behalf of this user. Use available tools when the request asks you to do work.",
        "When finished, return only the concise result the realtime voice agent should speak back.",
        "Do not include markdown, tool logs, or private reasoning. Include citations only when the spoken answer needs them.",
        "Recent voice transcript for context:\nCaller: Can you check this?",
        "Additional realtime context:\nCaller asked about PR #123.",
        "User request:\nWhat should I say?",
      ].join("\n\n"),
    );
    expect(call.extraSystemPrompt).toBe(
      "You are the configured OpenClaw agent receiving delegated requests from a live voice bridge. Act on behalf of the user, use available tools when appropriate, and return a brief speakable result.",
    );
  });

  it("does not present a late voice result as current", async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "openclaw-talk-freshness-"));
    try {
      setDefaultAgentMutationCoordinatorForTest(
        new AgentMutationCoordinator({
          databasePath: path.join(temporaryDirectory, "state.sqlite"),
        }),
      );
      const { runtime } = createAgentRuntime([{ text: "The current value is 42." }]);

      const result = await consultRealtimeVoiceAgent({
        cfg: {} as never,
        agentRuntime: runtime as never,
        logger: { warn: vi.fn() },
        sessionKey: "voice:freshness",
        messageProvider: "voice",
        lane: "voice",
        runIdPrefix: "voice-freshness",
        args: { question: "What is the current value?" },
        transcript: [],
        surface: "a live call",
        userLabel: "Caller",
        freshnessDeadlineAtMs: 0,
      });

      expect(result).toEqual({
        text: "That result finished after its freshness deadline, so I will not present it as current.",
      });
    } finally {
      closeOpenClawStateDatabaseForTest();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("delivers exactly once after acceptance, client disconnect, completion, and registry restart", async () => {
    const deferred = createDeferredValue<EmbeddedAgentRunResult>();
    const { runtime, sessionStore } = createAgentRuntime();
    let runAbortSignal: AbortSignal | undefined;
    runtime.runEmbeddedAgent = vi.fn((params: RunEmbeddedAgentParams) => {
      runAbortSignal = params.abortSignal;
      return deferred.promise;
    });
    sessionStore["agent:main:main"] = {
      sessionId: "origin-session",
      updatedAt: 1,
      deliveryContext: {
        channel: "discord",
        to: "channel:123",
        accountId: "default",
      },
    };

    const receipt = await consultRealtimeVoiceAgent({
      cfg: {} as never,
      agentRuntime: runtime as never,
      logger: { warn: vi.fn() },
      sessionKey: "voice:consult-wait",
      spawnedBy: "agent:main:main",
      messageProvider: "voice",
      lane: "voice",
      runIdPrefix: "voice-realtime-consult:wait",
      args: { question: "Finish the long-running account audit" },
      transcript: [],
      surface: "a live phone call",
      userLabel: "Caller",
      waitTimeoutMs: 0,
    });

    if (!("jobId" in receipt)) {
      throw new Error("expected a durable running receipt");
    }
    expect(receipt).toMatchObject({
      status: "accepted",
      title: "Finish the long-running account audit",
      state: "running",
    });
    expect(receipt.runId).toContain("voice-realtime-consult:wait:");
    expect(runAbortSignal?.aborted).toBe(false);
    expect(getTaskById(receipt.jobId)).toMatchObject({
      runId: receipt.runId,
      status: "running",
      deliveryStatus: "pending",
      taskKind: "agent_consult",
      progressSummary: "Queued for background admission.",
    });
    expect(listTasksForOwnerKey("agent:main:main")).toEqual([
      expect.objectContaining({
        taskId: receipt.jobId,
        status: "running",
      }),
    ]);

    // The accepted job has no dependency on the originating Talk connection
    // after this point; dropping that client leaves the durable task as owner.
    deferred.resolve({
      payloads: [{ text: "The account audit is complete." }],
      meta: { durationMs: 50 },
    });
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        to: "channel:123",
        content: expect.stringContaining("The account audit is complete."),
        idempotencyKey: expect.stringContaining(`task-terminal:${receipt.jobId}:succeeded`),
      }),
    );
    expect(getTaskById(receipt.jobId)).toMatchObject({
      status: "succeeded",
      deliveryStatus: "delivered",
    });

    await maybeDeliverTaskTerminalUpdate(receipt.jobId);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // A restored ledger sees the persisted delivered marker and cannot
    // publish the same terminal result after a reconnect/restart.
    resetTaskRegistryForTests({ persist: false });
    configureTaskRegistryRuntime({ store: taskStore });
    reloadTaskRegistryFromStore();
    await maybeDeliverTaskTerminalUpdate(receipt.jobId);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("routes completion at the wait deadline through durable delivery when the direct response is lost", async () => {
    let monotonicNow = 100;
    setRealtimeVoiceAgentConsultDepsForTest({
      monotonicNow: () => monotonicNow,
    });
    const deferred = createDeferredValue<EmbeddedAgentRunResult>();
    const { runtime, sessionStore } = createAgentRuntime();
    runtime.runEmbeddedAgent = vi.fn(() => deferred.promise);
    sessionStore["agent:main:main"] = {
      sessionId: "origin-session",
      updatedAt: 1,
      deliveryContext: {
        channel: "discord",
        to: "channel:boundary",
        accountId: "default",
      },
    };

    const pendingReceipt = consultRealtimeVoiceAgent({
      cfg: {} as never,
      agentRuntime: runtime as never,
      logger: { warn: vi.fn() },
      sessionKey: "voice:consult-boundary",
      spawnedBy: "agent:main:main",
      messageProvider: "voice",
      lane: "voice",
      runIdPrefix: "voice-realtime-consult:boundary",
      args: { question: "Finish exactly at the wait boundary" },
      transcript: [],
      surface: "a live phone call",
      userLabel: "Caller",
      waitTimeoutMs: 10,
    });
    await vi.waitFor(() => expect(runtime.runEmbeddedAgent).toHaveBeenCalledTimes(1));

    monotonicNow = 110;
    deferred.resolve({
      payloads: [{ text: "Boundary result." }],
      meta: { durationMs: 10 },
    });
    const receipt = await pendingReceipt;

    expect(receipt).toMatchObject({
      status: "accepted",
      state: "running",
    });
    if (!("jobId" in receipt)) {
      throw new Error("expected a durable receipt at the wait deadline");
    }
    expect(getTaskById(receipt.jobId)).toMatchObject({
      status: "succeeded",
      deliveryStatus: "pending",
    });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Boundary result."),
        idempotencyKey: expect.stringContaining(`task-terminal:${receipt.jobId}:succeeded`),
      }),
    );

    // Simulate losing the accepted HTTP/WebSocket response, restarting the
    // gateway registry, and reconnecting to the same durable owner.
    resetTaskRegistryForTests({ persist: false });
    configureTaskRegistryRuntime({ store: taskStore });
    reloadTaskRegistryFromStore();
    await maybeDeliverTaskTerminalUpdate(receipt.jobId);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps explicit job cancellation wired to the underlying consult abort signal", async () => {
    const { runtime } = createAgentRuntime();
    let runAbortSignal: AbortSignal | undefined;
    let abortObserved = false;
    runtime.runEmbeddedAgent = vi.fn(
      (params: RunEmbeddedAgentParams) =>
        new Promise<EmbeddedAgentRunResult>((_resolve, reject) => {
          runAbortSignal = params.abortSignal;
          params.abortSignal?.addEventListener(
            "abort",
            () => {
              abortObserved = true;
              reject(params.abortSignal?.reason);
            },
            { once: true },
          );
        }),
    );

    const receipt = await consultRealtimeVoiceAgent({
      cfg: {} as never,
      agentRuntime: runtime as never,
      logger: { warn: vi.fn() },
      sessionKey: "agent:main:voice:cancel",
      messageProvider: "voice",
      lane: "voice",
      runIdPrefix: "voice-realtime-consult:cancel",
      args: { question: "Keep checking until I stop you" },
      transcript: [],
      surface: "a live phone call",
      userLabel: "Caller",
      waitTimeoutMs: 0,
    });
    if (!("jobId" in receipt)) {
      throw new Error("expected a durable running receipt");
    }

    const cancelled = await cancelTaskById({
      cfg: {} as never,
      taskId: receipt.jobId,
      reason: "Stopped by user.",
    });

    expect(cancelled).toMatchObject({
      found: true,
      cancelled: true,
      task: {
        taskId: receipt.jobId,
        status: "cancelled",
        error: "Stopped by user.",
      },
    });
    expect(runAbortSignal?.aborted).toBe(true);
    expect(abortObserved).toBe(true);
    await vi.waitFor(() => {
      expect(getTaskById(receipt.jobId)).toMatchObject({
        status: "cancelled",
        deliveryStatus: "session_queued",
      });
    });
  });

  it("rejects an archived consult session before mutating or starting work", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime();
    sessionStore["voice:archived"] = {
      sessionId: "archived-session",
      updatedAt: 1,
      archivedAt: 2,
    };

    await expect(
      consultRealtimeVoiceAgent({
        cfg: {} as never,
        agentRuntime: runtime as never,
        logger: { warn: vi.fn() },
        sessionKey: "voice:archived",
        messageProvider: "voice",
        lane: "voice",
        runIdPrefix: "voice-realtime-consult:archived",
        args: { question: "What should I say?" },
        transcript: [],
        surface: "a live phone call",
        userLabel: "Caller",
      }),
    ).rejects.toThrow('Session "voice:archived" is archived. Restore it before starting new work.');
    expect(runtime.ensureAgentWorkspace).not.toHaveBeenCalled();
    expect(runtime.session.patchSessionEntry).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("fresh-checks archive state after a queued lifecycle mutation", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime();
    const sessionKey = "voice:archive-race";
    sessionStore[sessionKey] = {
      sessionId: "active-session",
      updatedAt: 1,
    };
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: "/tmp/sessions.json",
      identities: [sessionKey, "active-session"],
      run: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
        const entry = sessionStore[sessionKey];
        if (entry) {
          entry.archivedAt = 2;
        }
      },
    });
    await mutationStarted.promise;

    const consult = consultRealtimeVoiceAgent({
      cfg: {} as never,
      agentRuntime: runtime as never,
      logger: { warn: vi.fn() },
      sessionKey,
      messageProvider: "voice",
      lane: "voice",
      runIdPrefix: "voice-realtime-consult:archive-race",
      args: { question: "What should I say?" },
      transcript: [],
      surface: "a live phone call",
      userLabel: "Caller",
    });
    await Promise.resolve();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();

    releaseMutation.resolve();
    await mutation;
    await expect(consult).rejects.toThrow(
      'Session "voice:archive-race" is archived. Restore it before starting new work.',
    );
    expect(runtime.ensureAgentWorkspace).not.toHaveBeenCalled();
    expect(runtime.session.patchSessionEntry).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("scopes sandbox resolution to the configured consult agent", async () => {
    const { runtime, runEmbeddedAgent } = createAgentRuntime();

    await consultRealtimeVoiceAgent({
      cfg: {} as never,
      agentRuntime: runtime as never,
      logger: { warn: vi.fn() },
      agentId: "voice",
      sessionKey: "voice:15550001234",
      messageProvider: "voice",
      lane: "voice",
      runIdPrefix: "voice-realtime-consult:call-1",
      args: { question: "What should I say?" },
      transcript: [],
      surface: "a live phone call",
      userLabel: "Caller",
    });

    const call = requireEmbeddedAgentCall(runEmbeddedAgent);
    expect(call.sessionKey).toBe("voice:15550001234");
    expect(call.sandboxSessionKey).toBe("agent:voice:voice:15550001234");
    expect(call.agentId).toBe("voice");
  });

  it("fails visibly when the embedded agent completes without a reply or artifact", async () => {
    const warn = vi.fn();
    const { runtime } = createAgentRuntime([{ text: "hidden", isReasoning: true }]);

    await expect(
      consultRealtimeVoiceAgent({
        cfg: {} as never,
        agentRuntime: runtime as never,
        logger: { warn },
        sessionKey: "google-meet:meet-1",
        messageProvider: "google-meet",
        lane: "google-meet",
        runIdPrefix: "google-meet:meet-1",
        args: { question: "What now?" },
        transcript: [],
        surface: "a private Google Meet",
        userLabel: "Participant",
        fallbackText: "Let me verify that first.",
      }),
    ).rejects.toThrow("completed_without_reply");

    expect(warn).toHaveBeenCalledWith(
      "[talk] agent consult produced no answer: agent returned no speakable text",
    );
    expect(listTasksForOwnerKey("google-meet:meet-1")).toEqual([
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("completed_without_reply"),
      }),
    ]);
  });

  it("preserves a generated PDF reference when the delegated reply has no text", async () => {
    const { runtime } = createAgentRuntime([
      { mediaUrls: ["https://files.example/date-plan.pdf"] },
    ]);

    const result = await consultRealtimeVoiceAgent({
      cfg: {} as never,
      agentRuntime: runtime as never,
      logger: { warn: vi.fn() },
      sessionKey: "voice:artifact",
      messageProvider: "voice",
      lane: "voice",
      runIdPrefix: "voice-artifact",
      args: { question: "Create the date-plan PDF" },
      transcript: [],
      surface: "a live call",
      userLabel: "Caller",
    });

    expect(result).toEqual({
      text: "The requested artifact is ready: https://files.example/date-plan.pdf",
    });
    expect(listTasksForOwnerKey("voice:artifact")).toEqual([
      expect.objectContaining({
        status: "succeeded",
        terminalSummary: "The requested artifact is ready: https://files.example/date-plan.pdf",
      }),
    ]);
  });

  it("forks requester context when fork mode has a parent session", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime();
    sessionStore["agent:main:main"] = {
      sessionId: "parent-session",
      sessionFile: "/tmp/parent.jsonl",
      totalTokens: 100,
      updatedAt: 1,
    };
    const resolveParentForkDecision = vi.fn(async () => ({
      status: "fork" as const,
      maxTokens: 100_000,
      parentTokens: 100,
    }));
    const forkSessionEntryFromParent = vi.fn(
      async (
        params: ForkSessionEntryFromParentParams,
      ): Promise<ForkSessionEntryFromParentResult> => {
        const fork = {
          sessionId: "forked-session",
          sessionFile: "/tmp/forked.jsonl",
        };
        const parentEntry = sessionStore["agent:main:main"];
        if (!parentEntry?.sessionId) {
          return { status: "missing-parent" };
        }
        const typedParentEntry: SessionEntry = {
          ...parentEntry,
          sessionId: parentEntry.sessionId,
          updatedAt: parentEntry.updatedAt ?? Date.now(),
        };
        const decision = {
          status: "fork" as const,
          maxTokens: 100_000,
        };
        const entry = params.fallbackEntry ?? { sessionId: "", updatedAt: Date.now() };
        const sessionEntry: SessionEntry = {
          ...entry,
          ...params.patch?.({ entry, parentEntry: typedParentEntry, fork, decision }),
          sessionId: fork.sessionId,
          sessionFile: fork.sessionFile,
          forkedFromParent: true,
        };
        sessionStore[params.sessionKey] = sessionEntry;
        return {
          status: "forked" as const,
          fork,
          parentEntry: typedParentEntry,
          sessionEntry,
          decision,
        };
      },
    );
    setRealtimeVoiceAgentConsultDepsForTest({
      forkSessionEntryFromParent,
    });

    await consultRealtimeVoiceAgent({
      cfg: {} as never,
      agentRuntime: runtime as never,
      logger: { warn: vi.fn() },
      agentId: "main",
      sessionKey: "agent:main:subagent:google-meet:meet-1",
      spawnedBy: "agent:main:main",
      contextMode: "fork",
      messageProvider: "google-meet",
      lane: "google-meet",
      runIdPrefix: "google-meet:meet-1",
      args: { question: "What should I say?" },
      transcript: [],
      surface: "a private Google Meet",
      userLabel: "Participant",
    });

    expect(resolveParentForkDecision).not.toHaveBeenCalled();
    expect(forkSessionEntryFromParent).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionKey: "agent:main:main",
        agentId: "main",
        config: {},
        sessionKey: "agent:main:subagent:google-meet:meet-1",
      }),
    );
    expect(runtime.session.patchSessionEntry).not.toHaveBeenCalled();
    const forkedEntry = sessionStore["agent:main:subagent:google-meet:meet-1"];
    if (!forkedEntry) {
      throw new Error("Expected forked consult session entry");
    }
    expect(forkedEntry).toStrictEqual({
      sessionId: "forked-session",
      sessionFile: "/tmp/forked.jsonl",
      spawnedBy: "agent:main:main",
      forkedFromParent: true,
      updatedAt: forkedEntry.updatedAt,
    });
    expectPositiveTimestamp(forkedEntry.updatedAt);
    const call = requireEmbeddedAgentCall(runEmbeddedAgent);
    expect(call.sessionId).toBe("forked-session");
    expect(call.sessionFile).toBeUndefined();
    expect(call.sessionTarget).toMatchObject({
      agentId: "main",
      sessionId: "forked-session",
      sessionKey: "agent:main:subagent:google-meet:meet-1",
      storePath: "/tmp/sessions.json",
    });
    expect(call.spawnedBy).toBe("agent:main:main");
  });

  it("falls back to a fresh isolated consult session when requester context is too large", async () => {
    const { runtime, runEmbeddedAgent } = createAgentRuntime();
    const warn = vi.fn();
    const forkSessionEntryFromParent = vi.fn(
      async (
        params: ForkSessionEntryFromParentParams,
      ): Promise<ForkSessionEntryFromParentResult> => ({
        status: "skipped",
        reason: "decision-skip",
        sessionEntry: {
          ...(params.fallbackEntry ?? { sessionId: "", updatedAt: Date.now() }),
          sessionId: "",
          updatedAt: Date.now(),
        },
        decision: {
          status: "skip",
          reason: "parent-too-large",
          maxTokens: 100_000,
          parentTokens: 150_000,
          message:
            "Parent context is too large to fork (150000/100000 tokens); starting with isolated context instead.",
        },
      }),
    );
    setRealtimeVoiceAgentConsultDepsForTest({
      forkSessionEntryFromParent,
      randomUUID: () => "00000000-0000-4000-8000-000000000000",
    });

    await consultRealtimeVoiceAgent({
      cfg: {} as never,
      agentRuntime: runtime as never,
      logger: { warn },
      agentId: "main",
      sessionKey: "agent:main:subagent:google-meet:meet-1",
      spawnedBy: "agent:main:main",
      contextMode: "fork",
      messageProvider: "google-meet",
      lane: "google-meet",
      runIdPrefix: "google-meet:meet-1",
      args: { question: "What should I say?" },
      transcript: [],
      surface: "a private Google Meet",
      userLabel: "Participant",
    });

    expect(warn).toHaveBeenCalledWith(
      "[talk] Parent context is too large to fork (150000/100000 tokens); starting with isolated context instead.",
    );
    expect(runtime.session.patchSessionEntry).toHaveBeenCalled();
    const call = requireEmbeddedAgentCall(runEmbeddedAgent);
    expect(call.sessionId).toBe("00000000-0000-4000-8000-000000000000");
    expect(call.sessionFile).toBeUndefined();
    expect(call.sessionTarget).toMatchObject({
      agentId: "main",
      sessionId: "00000000-0000-4000-8000-000000000000",
      sessionKey: "agent:main:subagent:google-meet:meet-1",
      storePath: "/tmp/sessions.json",
    });
    expect(call.spawnedBy).toBe("agent:main:main");
  });

  it("inherits requester message routing for forked consult sessions", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime();
    sessionStore["agent:main:discord:channel:123"] = {
      sessionId: "parent-session",
      deliveryContext: {
        channel: "discord",
        to: "channel:123",
        accountId: "default",
      },
      updatedAt: 1,
    };

    await consultRealtimeVoiceAgent({
      cfg: {} as never,
      agentRuntime: runtime as never,
      logger: { warn: vi.fn() },
      agentId: "main",
      sessionKey: "voice:google-meet:meet-1",
      spawnedBy: "agent:main:discord:channel:123",
      contextMode: "fork",
      messageProvider: "voice",
      lane: "voice",
      runIdPrefix: "voice-realtime-consult:call-1",
      args: { question: "Send a status message." },
      transcript: [],
      surface: "a live phone call",
      userLabel: "Caller",
    });

    const call = requireEmbeddedAgentCall(runEmbeddedAgent);
    expect(call.sessionKey).toBe("voice:google-meet:meet-1");
    expect(call.spawnedBy).toBe("agent:main:discord:channel:123");
    expect(call.messageProvider).toBe("discord");
    expect(call.agentAccountId).toBe("default");
    expect(call.messageTo).toBe("channel:123");
    expect(call.currentChannelId).toBe("channel:123");
    const voiceEntry = sessionStore["voice:google-meet:meet-1"];
    if (!voiceEntry) {
      throw new Error("Expected voice consult session entry");
    }
    expect(voiceEntry).toStrictEqual({
      sessionId: voiceEntry.sessionId,
      spawnedBy: "agent:main:discord:channel:123",
      deliveryContext: {
        channel: "discord",
        to: "channel:123",
        accountId: "default",
      },
      lastChannel: "discord",
      lastTo: "channel:123",
      lastAccountId: "default",
      lastThreadId: undefined,
      updatedAt: voiceEntry.updatedAt,
    });
    expectNonEmptyString(voiceEntry.sessionId);
    expectPositiveTimestamp(voiceEntry.updatedAt);
  });

  it("reuses the call session delivery context when requester metadata is absent", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime();
    sessionStore["voice:google-meet:meet-1"] = {
      sessionId: "call-session",
      deliveryContext: {
        channel: "discord",
        to: "channel:123",
        accountId: "default",
        threadId: "thread-456",
      },
      updatedAt: 1,
    };

    await consultRealtimeVoiceAgent({
      cfg: {} as never,
      agentRuntime: runtime as never,
      logger: { warn: vi.fn() },
      agentId: "main",
      sessionKey: "voice:google-meet:meet-1",
      messageProvider: "voice",
      lane: "voice",
      runIdPrefix: "voice-realtime-consult:call-1",
      args: { question: "Send this to the original chat." },
      transcript: [],
      surface: "a live phone call",
      userLabel: "Caller",
    });

    const call = requireEmbeddedAgentCall(runEmbeddedAgent);
    expect(call.sessionId).toBe("call-session");
    expect(call.sessionKey).toBe("voice:google-meet:meet-1");
    expect(call.messageProvider).toBe("discord");
    expect(call.agentAccountId).toBe("default");
    expect(call.messageTo).toBe("channel:123");
    expect(call.messageThreadId).toBe("thread-456");
    expect(call.currentChannelId).toBe("channel:123");
    expect(call.currentThreadTs).toBe("thread-456");
  });
});
