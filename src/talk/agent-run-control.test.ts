// Agent run control tests cover talk-driven agent pause and resume behavior.
import { describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import {
  classifyRealtimeVoiceAgentControlText,
  controlRealtimeVoiceAgentRun,
  parseRealtimeVoiceAgentControlToolArgs,
  resolveRealtimeVoiceAgentControlIntent,
  shouldAutoControlRealtimeVoiceAgentText,
  type RealtimeVoiceAgentRunActivity,
} from "./agent-run-control.js";
import type { TalkEvent } from "./talk-events.js";

function createDeps(options: {
  activeSessionId?: string;
  queued?: boolean;
  abortResult?: boolean;
  activity?: RealtimeVoiceAgentRunActivity;
  reason?: "no_active_run" | "not_streaming" | "compacting" | "runtime_rejected";
  tasks?: TaskRecord[];
  relatedTasks?: TaskRecord[];
  requestedTask?: TaskRecord;
  rawTask?: TaskRecord;
  cancelledTask?: TaskRecord;
}) {
  return {
    abortEmbeddedAgentRun: vi.fn(() => options.abortResult ?? true),
    queueEmbeddedAgentMessageWithOutcomeAsync: vi.fn(
      async (sessionId: string, _text: string, _options?: { steeringMode?: "all" }) =>
        options.queued === false
          ? {
              queued: false as const,
              sessionId,
              reason: options.reason ?? "not_streaming",
              gatewayHealth: "live" as const,
            }
          : {
              queued: true as const,
              sessionId,
              target: "embedded_run" as const,
              gatewayHealth: "live" as const,
              enqueuedAtMs: 123,
            },
    ),
    getDiagnosticSessionActivitySnapshot: vi.fn(() => options.activity ?? {}),
    resolveActiveEmbeddedRunSessionId: vi.fn(() => options.activeSessionId),
    listTasksForOwnerKey: vi.fn(() => options.tasks ?? []),
    listTasksForRelatedSessionKey: vi.fn(() => options.relatedTasks ?? []),
    resolveTaskForLookupTokenForOwner: vi.fn(() => options.requestedTask),
    getTaskById: vi.fn(() => options.rawTask),
    cancelTaskById: vi.fn(async () => ({
      found: Boolean(options.requestedTask ?? options.rawTask),
      cancelled: Boolean(options.cancelledTask),
      ...(options.cancelledTask ? { task: options.cancelledTask } : {}),
    })),
  };
}

function createTask(
  overrides: Partial<TaskRecord> & Pick<TaskRecord, "taskId" | "status">,
): TaskRecord {
  return {
    runtime: "cli",
    taskKind: "agent_consult",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    task: "Finish the account audit",
    createdAt: 1,
    notifyPolicy: "done_only",
    deliveryStatus: "pending",
    ...overrides,
    taskId: overrides.taskId,
    status: overrides.status,
  };
}

describe("classifyRealtimeVoiceAgentControlText", () => {
  it("classifies common voice control phrases conservatively", () => {
    expect(classifyRealtimeVoiceAgentControlText("status?")).toBe("status");
    expect(classifyRealtimeVoiceAgentControlText("update?")).toBe("status");
    expect(classifyRealtimeVoiceAgentControlText("give me an update")).toBe("status");
    expect(classifyRealtimeVoiceAgentControlText("cancel that")).toBe("cancel");
    expect(classifyRealtimeVoiceAgentControlText("can you cancel the check")).toBe("cancel");
    expect(classifyRealtimeVoiceAgentControlText("actually can we just cancel")).toBe("cancel");
    expect(classifyRealtimeVoiceAgentControlText("OK, cancel")).toBe("cancel");
    expect(classifyRealtimeVoiceAgentControlText("please cancle the run")).toBe("cancel");
    expect(shouldAutoControlRealtimeVoiceAgentText("cancel my meeting tomorrow")).toBe(false);
    expect(shouldAutoControlRealtimeVoiceAgentText("abort the deploy")).toBe(false);
    expect(classifyRealtimeVoiceAgentControlText("when you're done also check tests")).toBe(
      "followup",
    );
    expect(classifyRealtimeVoiceAgentControlText("how is it going")).toBe("status");
    expect(classifyRealtimeVoiceAgentControlText("All right, how is that going?")).toBe("status");
    expect(classifyRealtimeVoiceAgentControlText("what is it doing")).toBe("status");
    expect(classifyRealtimeVoiceAgentControlText("update the docs too")).toBe("steer");
    expect(classifyRealtimeVoiceAgentControlText("use the smaller implementation")).toBe("steer");
    expect(classifyRealtimeVoiceAgentControlText("stop using the slow path")).toBe("steer");
    expect(classifyRealtimeVoiceAgentControlText("can you stop using the slow path")).toBe("steer");
    expect(classifyRealtimeVoiceAgentControlText("stop the run from using the slow path")).toBe(
      "steer",
    );
    expect(classifyRealtimeVoiceAgentControlText("actually focus on WebUI first")).toBe("steer");
    expect(classifyRealtimeVoiceAgentControlText("change that to check discord voice")).toBe(
      "steer",
    );
    expect(
      classifyRealtimeVoiceAgentControlText("Can you actually change it to Discord path?"),
    ).toBe("steer");
  });

  it("keeps ambiguous active-call speech out of automatic steering", () => {
    expect(resolveRealtimeVoiceAgentControlIntent({ text: "hello" })).toMatchObject({
      mode: "status",
      confidence: "low",
      reason: "safe_default",
      shouldAutoControl: false,
    });
    expect(shouldAutoControlRealtimeVoiceAgentText("hi")).toBe(false);
    expect(shouldAutoControlRealtimeVoiceAgentText("hey")).toBe(false);
    expect(shouldAutoControlRealtimeVoiceAgentText("don't stop that")).toBe(false);
    expect(classifyRealtimeVoiceAgentControlText("stop it from using the slow path")).toBe("steer");
    expect(shouldAutoControlRealtimeVoiceAgentText("stop it from using the slow path")).toBe(true);
    expect(shouldAutoControlRealtimeVoiceAgentText("stop using the slow path")).toBe(true);
    expect(resolveRealtimeVoiceAgentControlIntent({ text: "¿cómo va esto?" })).toMatchObject({
      mode: "status",
      confidence: "low",
      reason: "safe_default",
      shouldAutoControl: false,
    });
    expect(shouldAutoControlRealtimeVoiceAgentText("¿cómo va esto?")).toBe(false);
    expect(shouldAutoControlRealtimeVoiceAgentText("actually focus on WebUI")).toBe(true);
  });

  it("parses semantic realtime control tool calls", () => {
    expect(
      parseRealtimeVoiceAgentControlToolArgs({
        text: "revísalo en español",
        mode: "steer",
      }),
    ).toStrictEqual({ text: "revísalo en español", mode: "steer" });
    expect(parseRealtimeVoiceAgentControlToolArgs({ message: "status?" })).toStrictEqual({
      text: "status?",
      mode: "status",
    });
    expect(
      parseRealtimeVoiceAgentControlToolArgs(
        JSON.stringify({ text: "check that job", mode: "status", jobId: "task-123" }),
      ),
    ).toStrictEqual({ text: "check that job", mode: "status", jobId: "task-123" });
  });
});

describe("controlRealtimeVoiceAgentRun", () => {
  it("queues steering into the active embedded run", async () => {
    const deps = createDeps({ activeSessionId: "session-active" });

    const result = await controlRealtimeVoiceAgentRun(
      {
        sessionKey: "agent:main:main",
        text: "use the safer path",
        mode: "steer",
      },
      deps,
    );

    expect(result).toMatchObject({
      ok: true,
      mode: "steer",
      sessionKey: "agent:main:main",
      sessionId: "session-active",
      active: true,
      queued: true,
      speak: true,
      suppress: false,
    });
    expect(deps.queueEmbeddedAgentMessageWithOutcomeAsync).toHaveBeenCalledWith(
      "session-active",
      "use the safer path",
      { steeringMode: "all", debounceMs: 0 },
    );
  });

  it("wraps follow-up steering so the active run treats it as deferred context", async () => {
    const deps = createDeps({ activeSessionId: "session-active" });

    const result = await controlRealtimeVoiceAgentRun(
      {
        sessionKey: "agent:main:main",
        text: "also check the migration",
        mode: "followup",
      },
      deps,
    );

    expect(result).toMatchObject({ ok: true, mode: "followup", speak: true });
    const queuedText = deps.queueEmbeddedAgentMessageWithOutcomeAsync.mock.calls[0]?.[1] ?? "";
    expect(queuedText).toContain("Spoken follow-up for the current voice call.");
    expect(queuedText).toContain("also check the migration");
  });

  it("cancels the active run without queueing a steering message", async () => {
    const deps = createDeps({ activeSessionId: "session-active", abortResult: true });

    const result = await controlRealtimeVoiceAgentRun(
      {
        sessionKey: "agent:main:main",
        text: "stop",
        mode: "cancel",
      },
      deps,
    );

    expect(result).toMatchObject({
      ok: true,
      mode: "cancel",
      sessionId: "session-active",
      aborted: true,
      providerResult: {
        status: "cancelled",
        message: "Cancelled the active OpenClaw run.",
      },
    });
    expect(deps.abortEmbeddedAgentRun).toHaveBeenCalledWith("session-active");
    expect(deps.queueEmbeddedAgentMessageWithOutcomeAsync).not.toHaveBeenCalled();
  });

  it("answers status from recent Talk tool events", async () => {
    const deps = createDeps({ activeSessionId: "session-active" });
    const recentEvents = [
      {
        id: "event-1",
        type: "tool.progress",
        sessionId: "talk-1",
        seq: 1,
        timestamp: new Date(0).toISOString(),
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        payload: { name: "read", phase: "running" },
      } satisfies TalkEvent,
    ];

    const result = await controlRealtimeVoiceAgentRun(
      {
        sessionKey: "agent:main:main",
        text: "status",
        mode: "status",
        recentEvents,
      },
      deps,
    );

    expect(result).toMatchObject({
      ok: true,
      mode: "status",
      active: true,
      message: "OpenClaw is working in read (running).",
    });
    expect(deps.queueEmbeddedAgentMessageWithOutcomeAsync).not.toHaveBeenCalled();
  });

  it("answers status from diagnostic run activity when Talk events are absent", async () => {
    const deps = createDeps({
      activity: {
        activeWorkKind: "tool_call",
        hasActiveEmbeddedRun: true,
        activeToolName: "exec_command",
      },
    });

    const result = await controlRealtimeVoiceAgentRun(
      {
        sessionKey: "agent:main:discord:channel:1001",
        text: "what are you doing",
        mode: "status",
      },
      deps,
    );

    expect(result).toMatchObject({
      ok: true,
      mode: "status",
      active: true,
      message: "OpenClaw is running exec_command.",
    });
    expect(deps.queueEmbeddedAgentMessageWithOutcomeAsync).not.toHaveBeenCalled();
  });

  it("answers status from the durable task ledger with actionable job ids", async () => {
    const task = createTask({
      taskId: "task-123",
      status: "running",
      label: "Finish the account audit",
      ownerKey: "agent:main:main",
      childSessionKey: "agent:voice:call:123",
    });
    const deps = createDeps({ relatedTasks: [task] });

    const result = await controlRealtimeVoiceAgentRun(
      {
        sessionKey: "agent:voice:call:123",
        text: "what are you still working on?",
        mode: "status",
      },
      deps,
    );

    expect(result).toMatchObject({
      ok: true,
      active: true,
      message: "Finish the account audit is running. Job task-123.",
    });
  });

  it("cancels the exact durable job named by the voice tool", async () => {
    const running = createTask({
      taskId: "task-123",
      status: "running",
      label: "Finish the account audit",
      ownerKey: "agent:main:main",
      childSessionKey: "agent:voice:call:123",
    });
    const cancelled = createTask({
      ...running,
      taskId: "task-123",
      status: "cancelled",
      error: "Cancelled by voice request.",
    });
    const deps = createDeps({
      rawTask: running,
      cancelledTask: cancelled,
    });

    const result = await controlRealtimeVoiceAgentRun(
      {
        sessionKey: "agent:voice:call:123",
        text: "cancel that audit",
        mode: "cancel",
        jobId: "task-123",
        cfg: {},
      },
      deps,
    );

    expect(deps.cancelTaskById).toHaveBeenCalledWith({
      cfg: {},
      taskId: "task-123",
      reason: "Cancelled by voice request.",
    });
    expect(result).toMatchObject({
      ok: true,
      mode: "cancel",
      target: "task",
      jobId: "task-123",
      active: false,
      aborted: true,
      message: "Cancelled Finish the account audit. Job task-123.",
    });
  });

  it("routes no-job steering through the active consult worker session", async () => {
    const running = createTask({
      taskId: "task-implicit",
      status: "running",
      ownerKey: "agent:main:main",
      childSessionKey: "agent:main:talk-job:worker",
    });
    const deps = createDeps({
      tasks: [running],
      activeSessionId: "worker-session-active",
    });

    const result = await controlRealtimeVoiceAgentRun(
      {
        sessionKey: "agent:main:main",
        text: "use the safer plan",
        mode: "steer",
      },
      deps,
    );

    expect(deps.resolveActiveEmbeddedRunSessionId).toHaveBeenCalledWith(
      "agent:main:talk-job:worker",
    );
    expect(deps.queueEmbeddedAgentMessageWithOutcomeAsync).toHaveBeenCalledWith(
      "worker-session-active",
      "use the safer plan",
      { steeringMode: "all", debounceMs: 0 },
    );
    expect(result).toMatchObject({
      ok: true,
      mode: "steer",
      sessionKey: "agent:main:main",
      sessionId: "worker-session-active",
      queued: true,
    });
  });

  it("cancels the active consult task without requiring a job id", async () => {
    const running = createTask({
      taskId: "task-implicit",
      status: "running",
      ownerKey: "agent:main:main",
      childSessionKey: "agent:main:talk-job:worker",
    });
    const cancelled = createTask({
      ...running,
      taskId: running.taskId,
      status: "cancelled",
      error: "Cancelled by voice request.",
    });
    const deps = createDeps({
      tasks: [running],
      cancelledTask: cancelled,
    });

    const result = await controlRealtimeVoiceAgentRun(
      {
        sessionKey: "agent:main:main",
        text: "cancel that",
        mode: "cancel",
        cfg: {},
      },
      deps,
    );

    expect(deps.cancelTaskById).toHaveBeenCalledWith({
      cfg: {},
      taskId: "task-implicit",
      reason: "Cancelled by voice request.",
    });
    expect(result).toMatchObject({
      ok: true,
      mode: "cancel",
      target: "task",
      jobId: "task-implicit",
      aborted: true,
    });
  });

  it("does not report stale control tool progress after the active run ends", async () => {
    const deps = createDeps({});
    const recentEvents = [
      {
        id: "event-1",
        type: "tool.progress",
        sessionId: "talk-1",
        seq: 1,
        timestamp: new Date(0).toISOString(),
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        payload: { name: "openclaw_agent_control", phase: "status" },
      } satisfies TalkEvent,
    ];

    const result = await controlRealtimeVoiceAgentRun(
      {
        sessionKey: "agent:main:main",
        text: "status",
        mode: "status",
        recentEvents,
      },
      deps,
    );

    expect(result).toMatchObject({
      ok: true,
      mode: "status",
      active: false,
      message: "I'm not working on an active request right now.",
    });
    expect(deps.queueEmbeddedAgentMessageWithOutcomeAsync).not.toHaveBeenCalled();
  });

  it("skips control tool progress when reporting active run status", async () => {
    const deps = createDeps({ activeSessionId: "session-active" });
    const recentEvents = [
      {
        id: "event-1",
        type: "tool.progress",
        sessionId: "talk-1",
        seq: 1,
        timestamp: new Date(0).toISOString(),
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        payload: { name: "exec_command", phase: "running" },
      },
      {
        id: "event-2",
        type: "tool.progress",
        sessionId: "talk-1",
        seq: 2,
        timestamp: new Date(1).toISOString(),
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        payload: { name: "openclaw_agent_control", phase: "status" },
      },
    ] satisfies TalkEvent[];

    const result = await controlRealtimeVoiceAgentRun(
      {
        sessionKey: "agent:main:main",
        text: "status",
        mode: "status",
        recentEvents,
      },
      deps,
    );

    expect(result).toMatchObject({
      ok: true,
      mode: "status",
      active: true,
      message: "OpenClaw is working in exec_command (running).",
    });
    expect(deps.queueEmbeddedAgentMessageWithOutcomeAsync).not.toHaveBeenCalled();
  });

  it("returns a structured rejection when no run is active", async () => {
    const deps = createDeps({});

    const result = await controlRealtimeVoiceAgentRun(
      {
        sessionKey: "agent:main:main",
        text: "use the safer path",
        mode: "steer",
      },
      deps,
    );

    expect(result).toMatchObject({
      ok: false,
      mode: "steer",
      active: false,
      queued: false,
      reason: "no_active_run",
    });
    expect(deps.queueEmbeddedAgentMessageWithOutcomeAsync).not.toHaveBeenCalled();
  });
});
