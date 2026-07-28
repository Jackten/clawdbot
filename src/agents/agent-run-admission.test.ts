import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enqueueCommandInLane,
  resetCommandLane,
  setCommandLaneConcurrency,
} from "../process/command-queue.js";
import {
  bindAgentRunAdmissionContext,
  configureAgentRunAdmissionHealth,
  deriveAgentRunResourceScope,
  resetAgentRunAdmissionForTest,
  resolveAgentRunAdmission,
  runWithAgentProviderAdmission,
  runWithAgentWorkerAdmission,
  wakeAgentRunAdmission,
  type AgentRunAdmissionPriority,
  type AgentRunQueueReason,
  type AgentRunResourceScope,
  type AgentRunWorkerSlot,
} from "./agent-run-admission.js";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function runWorker(params: {
  runId: string;
  priority: AgentRunAdmissionPriority;
  workerSlot?: AgentRunWorkerSlot;
  resourceScope: AgentRunResourceScope;
  started: string[];
  release: Promise<void>;
  onQueueReason?: (reason: AgentRunQueueReason | undefined) => void;
}): Promise<void> {
  return runWithAgentWorkerAdmission(
    {
      runId: params.runId,
      priority: params.priority,
      workerSlot:
        params.workerSlot ?? (params.priority === "foreground" ? "foreground" : "background"),
      resourceScope: params.resourceScope,
      onQueueReason: params.onQueueReason,
    },
    async () => {
      params.started.push(params.runId);
      await params.release;
    },
  );
}

afterEach(() => {
  resetAgentRunAdmissionForTest();
});

describe("agent run admission resolution", () => {
  it("routes subagent lanes through the shared background admission policy", () => {
    expect(
      resolveAgentRunAdmission({
        runId: "child-run",
        lane: "subagent",
        request: "review the scheduler",
      }),
    ).toMatchObject({
      priority: "background",
      resourceScope: { kind: "keys", keys: [] },
    });
  });
});

describe("agent run worker admission", () => {
  it("runs independent foreground and background jobs concurrently", async () => {
    const foreground = deferred();
    const background = deferred();
    const started: string[] = [];

    const foregroundRun = runWorker({
      runId: "foreground",
      priority: "foreground",
      resourceScope: { kind: "keys", keys: ["memory:one"] },
      started,
      release: foreground.promise,
    });
    const backgroundRun = runWorker({
      runId: "background",
      priority: "background",
      resourceScope: { kind: "keys", keys: ["memory:two"] },
      started,
      release: background.promise,
    });

    await vi.waitFor(() => {
      expect(started).toEqual(["foreground", "background"]);
    });
    foreground.resolve();
    background.resolve();
    await Promise.all([foregroundRun, backgroundRun]);
  });

  it("lets durable locks own contention for jobs with the same known resource key", async () => {
    const first = deferred();
    const second = deferred();
    const started: string[] = [];

    const firstRun = runWorker({
      runId: "first",
      priority: "foreground",
      resourceScope: { kind: "keys", keys: ["message:thread"] },
      started,
      release: first.promise,
    });
    const secondRun = runWorker({
      runId: "second",
      priority: "background",
      resourceScope: { kind: "keys", keys: ["message:thread"] },
      started,
      release: second.promise,
    });

    await vi.waitFor(() => {
      expect(started).toEqual(["first", "second"]);
    });
    first.resolve();
    second.resolve();
    await Promise.all([firstRun, secondRun]);
  });

  it("retains coarse serialization for an unconverted keyed family", async () => {
    const first = deferred();
    const second = deferred();
    const started: string[] = [];
    const resourceScope = { kind: "keys", keys: ["food-log:2026-07-27"] } as const;
    const firstRun = runWorker({
      runId: "first",
      priority: "foreground",
      resourceScope,
      started,
      release: first.promise,
    });
    const secondRun = runWorker({
      runId: "second",
      priority: "background",
      resourceScope,
      started,
      release: second.promise,
    });

    await vi.waitFor(() => expect(started).toEqual(["first"]));
    first.resolve();
    await vi.waitFor(() => expect(started).toEqual(["first", "second"]));
    second.resolve();
    await Promise.all([firstRun, secondRun]);
  });

  it("keeps the foreground worker available under background load", async () => {
    const firstBackground = deferred();
    const secondBackground = deferred();
    const foreground = deferred();
    const started: string[] = [];

    const firstBackgroundRun = runWorker({
      runId: "background-1",
      priority: "background",
      resourceScope: { kind: "keys", keys: ["resource:one"] },
      started,
      release: firstBackground.promise,
    });
    const secondBackgroundRun = runWorker({
      runId: "background-2",
      priority: "background",
      resourceScope: { kind: "keys", keys: ["resource:two"] },
      started,
      release: secondBackground.promise,
    });
    const foregroundRun = runWorker({
      runId: "foreground",
      priority: "foreground",
      resourceScope: { kind: "keys", keys: ["resource:three"] },
      started,
      release: foreground.promise,
    });

    await vi.waitFor(() => {
      expect(started).toEqual(["background-1", "foreground"]);
    });
    foreground.resolve();
    firstBackground.resolve();
    await vi.waitFor(() => {
      expect(started).toEqual(["background-1", "foreground", "background-2"]);
    });
    secondBackground.resolve();
    await Promise.all([firstBackgroundRun, secondBackgroundRun, foregroundRun]);
  });

  it.each(["hey", "yes", "thanks", "tell me a joke", "call Mom"])(
    "does not let background exclusive work starve foreground input: %s",
    async (request) => {
      const background = deferred();
      const foreground = deferred();
      const started: string[] = [];

      const backgroundRun = runWorker({
        runId: "background-exclusive",
        priority: "background",
        resourceScope: { kind: "exclusive" },
        started,
        release: background.promise,
      });
      const foregroundRun = runWorker({
        runId: `foreground:${request}`,
        priority: "foreground",
        resourceScope: deriveAgentRunResourceScope({ request }),
        started,
        release: foreground.promise,
      });

      await vi.waitFor(() => {
        expect(started).toEqual(["background-exclusive", `foreground:${request}`]);
      });
      foreground.resolve();
      background.resolve();
      await Promise.all([backgroundRun, foregroundRun]);
    },
  );

  it("inherits parent admission so an awaited nested child cannot deadlock", async () => {
    const started: string[] = [];
    const parentRun = runWithAgentWorkerAdmission(
      {
        runId: "parent",
        priority: "background",
        workerSlot: "background",
        resourceScope: { kind: "exclusive" },
      },
      async () => {
        started.push("parent");
        await runWithAgentWorkerAdmission(
          {
            runId: "child",
            priority: "background",
            workerSlot: "existing",
            resourceScope: { kind: "exclusive" },
          },
          async () => {
            started.push("child");
          },
        );
        started.push("parent-complete");
      },
    );

    await expect(parentRun).resolves.toBeUndefined();
    expect(started).toEqual(["parent", "child", "parent-complete"]);
  });

  it("lets an awaited child bypass a queued sibling blocked by its parent", async () => {
    const siblingRelease = deferred();
    const siblingQueued = deferred();
    const childQueuedOnLane = deferred();
    const started: string[] = [];
    let siblingRun: Promise<void> | undefined;
    const lane = "test:admission-lineage";
    setCommandLaneConcurrency(lane, 0);

    const parentRun = runWithAgentWorkerAdmission(
      {
        runId: "parent",
        priority: "background",
        workerSlot: "background",
        resourceScope: { kind: "exclusive" },
      },
      async () => {
        started.push("parent");
        siblingRun = runWorker({
          runId: "queued-sibling",
          priority: "background",
          resourceScope: { kind: "exclusive" },
          started,
          release: siblingRelease.promise,
          onQueueReason: (reason) => {
            if (reason) {
              siblingQueued.resolve();
            }
          },
        });
        await siblingQueued.promise;
        const childRun = enqueueCommandInLane(
          lane,
          bindAgentRunAdmissionContext(() =>
            runWithAgentWorkerAdmission(
              {
                runId: "awaited-child",
                priority: "background",
                workerSlot: "existing",
                resourceScope: { kind: "exclusive" },
              },
              async () => {
                started.push("awaited-child");
              },
            ),
          ),
        );
        childQueuedOnLane.resolve();
        await childRun;
        started.push("parent-complete");
      },
    );

    await childQueuedOnLane.promise;
    // Resume the lane from outside the parent's AsyncLocalStorage context.
    setCommandLaneConcurrency(lane, 1);
    await expect(parentRun).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(started).toEqual(["parent", "awaited-child", "parent-complete", "queued-sibling"]);
    });
    siblingRelease.resolve();
    await siblingRun;
    resetCommandLane(lane);
  });

  it("leaves existing bounded lanes independent while enforcing resource conflicts", async () => {
    const first = deferred();
    const second = deferred();
    const started: string[] = [];

    const firstRun = runWorker({
      runId: "cron-1",
      priority: "cron",
      workerSlot: "existing",
      resourceScope: { kind: "keys", keys: ["cron:one"] },
      started,
      release: first.promise,
    });
    const secondRun = runWorker({
      runId: "cron-2",
      priority: "cron",
      workerSlot: "existing",
      resourceScope: { kind: "keys", keys: ["cron:two"] },
      started,
      release: second.promise,
    });

    await vi.waitFor(() => {
      expect(started).toEqual(["cron-1", "cron-2"]);
    });
    first.resolve();
    second.resolve();
    await Promise.all([firstRun, secondRun]);
  });

  it("sheds background admission while the event loop load guard is open", async () => {
    let now = 0;
    let degraded = true;
    const release = deferred();
    const started: string[] = [];
    const queueReasons: Array<AgentRunQueueReason | undefined> = [];
    resetAgentRunAdmissionForTest({
      now: () => now,
      circuitHoldMs: 100,
      healthPollMs: 60_000,
    });
    configureAgentRunAdmissionHealth({
      readLoadDegraded: () => degraded,
    });

    const run = runWorker({
      runId: "background",
      priority: "background",
      resourceScope: { kind: "keys", keys: [] },
      started,
      release: release.promise,
      onQueueReason: (reason) => queueReasons.push(reason),
    });

    await vi.waitFor(() => {
      expect(queueReasons.at(-1)?.code).toBe("load_guard");
    });
    expect(started).toEqual([]);

    degraded = false;
    now = 101;
    wakeAgentRunAdmission();
    await vi.waitFor(() => {
      expect(started).toEqual(["background"]);
    });
    release.resolve();
    await run;
  });

  it("sheds background admission while an active voice session is unhealthy", async () => {
    let now = 0;
    let healthy = false;
    const release = deferred();
    const started: string[] = [];
    const queueReasons: Array<AgentRunQueueReason | undefined> = [];
    resetAgentRunAdmissionForTest({
      now: () => now,
      circuitHoldMs: 100,
      healthPollMs: 60_000,
    });
    configureAgentRunAdmissionHealth({
      readVoiceHealth: () => ({ active: true, healthy }),
    });

    const run = runWorker({
      runId: "background",
      priority: "background",
      resourceScope: { kind: "keys", keys: [] },
      started,
      release: release.promise,
      onQueueReason: (reason) => queueReasons.push(reason),
    });

    await vi.waitFor(() => {
      expect(queueReasons.at(-1)?.code).toBe("voice_unhealthy");
    });
    healthy = true;
    now = 101;
    wakeAgentRunAdmission();
    await vi.waitFor(() => {
      expect(started).toEqual(["background"]);
    });
    release.resolve();
    await run;
  });

  it("admits foreground work before cron after a shared resource clears", async () => {
    const blocker = deferred();
    const foreground = deferred();
    const cron = deferred();
    const started: string[] = [];
    const scope = { kind: "exclusive" } as const;

    const blockerRun = runWorker({
      runId: "blocker",
      priority: "foreground",
      resourceScope: scope,
      started,
      release: blocker.promise,
    });
    const cronRun = runWorker({
      runId: "cron",
      priority: "cron",
      resourceScope: scope,
      started,
      release: cron.promise,
    });
    const foregroundRun = runWorker({
      runId: "foreground",
      priority: "foreground",
      resourceScope: scope,
      started,
      release: foreground.promise,
    });

    await vi.waitFor(() => {
      expect(started).toEqual(["blocker"]);
    });
    blocker.resolve();
    await vi.waitFor(() => {
      expect(started).toEqual(["blocker", "foreground"]);
    });
    foreground.resolve();
    await vi.waitFor(() => {
      expect(started).toEqual(["blocker", "foreground", "cron"]);
    });
    cron.resolve();
    await Promise.all([blockerRun, cronRun, foregroundRun]);
  });
});

describe("resource-scope derivation", () => {
  it("keys known side effects and makes unknown mutations exclusive", () => {
    const today = deriveAgentRunResourceScope({
      request: "Add lunch to my food log today",
    });
    const sameDay = deriveAgentRunResourceScope({
      request: "Log dinner in the food diary today",
    });
    const yesterday = deriveAgentRunResourceScope({
      request: "Record breakfast in the food log yesterday",
    });

    expect(today).toEqual(sameDay);
    expect(yesterday).not.toEqual(today);
    expect(
      deriveAgentRunResourceScope({ request: "Update the thing when you work it out" }),
    ).toEqual({ kind: "exclusive" });
    expect(deriveAgentRunResourceScope({ request: "Log breakfast for me" })).toMatchObject({
      kind: "keys",
      keys: [expect.stringMatching(/^food-log:/)],
    });
    expect(deriveAgentRunResourceScope({ request: "Purchase another one" })).toMatchObject({
      kind: "keys",
      keys: [expect.stringMatching(/^purchase:/)],
    });
  });

  it("does not fail-close read-only food-log or purchase lookups", () => {
    expect(deriveAgentRunResourceScope({ request: "Check my food log today" })).toEqual({
      kind: "keys",
      keys: [],
    });
    expect(deriveAgentRunResourceScope({ request: "Show my purchase history" })).toEqual({
      kind: "keys",
      keys: [],
    });
    expect(
      deriveAgentRunResourceScope({
        request: "Check the current price and then purchase another one",
      }),
    ).toMatchObject({
      kind: "keys",
      keys: [expect.stringMatching(/^purchase:/)],
    });
  });
});

describe("provider admission", () => {
  it("reserves one provider slot for foreground work", async () => {
    const background = deferred();
    const queuedBackground = deferred();
    const foreground = deferred();
    const started: string[] = [];
    const queuedReasons: Array<AgentRunQueueReason | undefined> = [];

    const firstRun = runWithAgentProviderAdmission(
      { provider: "openai", priority: "background" },
      async () => {
        started.push("background-1");
        await background.promise;
      },
    );
    const secondRun = runWithAgentProviderAdmission(
      {
        provider: "openai",
        priority: "background",
        onQueueReason: (reason) => queuedReasons.push(reason),
      },
      async () => {
        started.push("background-2");
        await queuedBackground.promise;
      },
    );
    const foregroundRun = runWithAgentProviderAdmission(
      { provider: "openai-codex", priority: "foreground" },
      async () => {
        started.push("foreground");
        await foreground.promise;
      },
    );

    await vi.waitFor(() => {
      expect(started).toEqual(["background-1", "foreground"]);
      expect(queuedReasons.at(-1)?.code).toBe("provider_saturated");
    });
    foreground.resolve();
    background.resolve();
    await vi.waitFor(() => {
      expect(started).toEqual(["background-1", "foreground", "background-2"]);
    });
    queuedBackground.resolve();
    await Promise.all([firstRun, secondRun, foregroundRun]);
  });
});
