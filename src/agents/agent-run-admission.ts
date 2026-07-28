// Bounded admission for agent workers, provider calls, and pre-ledger resource safety.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type AgentRunAdmissionPriority = "foreground" | "background" | "cron";
export type AgentRunWorkerSlot = "foreground" | "background" | "existing";

export type AgentRunResourceScope =
  | { kind: "exclusive" }
  | { kind: "keys"; keys: readonly string[] };

export type AgentRunQueueReasonCode =
  | "worker_slot_full"
  | "provider_saturated"
  | "load_guard"
  | "voice_unhealthy"
  | "resource_busy";

export type AgentRunQueueReason = {
  code: AgentRunQueueReasonCode;
  detail: string;
};

export type AgentRunAdmissionOptions = {
  priority?: AgentRunAdmissionPriority;
  resourceScope?: AgentRunResourceScope;
  /** Stable durable job identity when it differs from this attempt's runId. */
  jobId?: string;
  /** Absolute deadline after which a produced result must be revalidated or reported stale. */
  freshnessDeadlineAtMs?: number;
  onQueueReason?: (reason: AgentRunQueueReason | undefined) => void;
  onAdmitted?: () => void;
};

type AdmissionTask = {
  id: number;
  runId: string;
  priority: AgentRunAdmissionPriority;
  workerSlot: AgentRunWorkerSlot;
  resourceScope: AgentRunResourceScope;
  ancestorAdmissionIds: ReadonlySet<number>;
  sequence: number;
  queueReasonCode?: AgentRunQueueReasonCode;
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  onQueueReason?: AgentRunAdmissionOptions["onQueueReason"];
  onAdmitted?: AgentRunAdmissionOptions["onAdmitted"];
  clearQueuedAbort?: () => void;
};

type ActiveAdmission = Pick<AdmissionTask, "id" | "priority" | "workerSlot" | "resourceScope">;

type ProviderTask = {
  id: number;
  provider: string;
  priority: AgentRunAdmissionPriority;
  sequence: number;
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  onQueueReason?: AgentRunAdmissionOptions["onQueueReason"];
  queueReasonCode?: AgentRunQueueReasonCode;
  clearQueuedAbort?: () => void;
};

type ProviderState = {
  active: Map<number, AgentRunAdmissionPriority>;
  queue: ProviderTask[];
};

type VoiceHealth = {
  active: boolean;
  healthy: boolean;
};

type AdmissionState = {
  nextId: number;
  nextSequence: number;
  workerQueue: AdmissionTask[];
  activeWorkers: Map<number, ActiveAdmission>;
  providers: Map<string, ProviderState>;
  overrides: Map<string, AgentRunAdmissionOptions>;
  readLoadDegraded: () => boolean;
  readVoiceHealth: () => VoiceHealth;
  now: () => number;
  circuitHoldMs: number;
  healthPollMs: number;
  loadCircuitOpenUntil: number;
  voiceCircuitOpenUntil: number;
  healthRetryTimer?: ReturnType<typeof setTimeout>;
};

const AGENT_RUN_ADMISSION_STATE_KEY = Symbol.for("openclaw.agentRunAdmissionState");
const activeAdmissionContext = new AsyncLocalStorage<ReadonlySet<number>>();
const FOREGROUND_WORKER_LIMIT = 1;
const BACKGROUND_WORKER_LIMIT = 1;
// This is deliberately a whole-harness-attempt subscription guard, including
// tool time. Cron/subagent lane settings remain fan-out ceilings, while one
// non-foreground attempt per provider prevents that fan-out from consuming the
// slot reserved for interactive work.
const PROVIDER_TOTAL_CONCURRENCY_LIMIT = 2;
const PROVIDER_NON_FOREGROUND_CONCURRENCY_LIMIT = 1;
const DEFAULT_CIRCUIT_HOLD_MS = 2_000;
const DEFAULT_HEALTH_POLL_MS = 250;

function createAdmissionState(): AdmissionState {
  return {
    nextId: 1,
    nextSequence: 1,
    workerQueue: [],
    activeWorkers: new Map(),
    providers: new Map(),
    overrides: new Map(),
    readLoadDegraded: () => false,
    readVoiceHealth: () => ({ active: false, healthy: true }),
    now: Date.now,
    circuitHoldMs: DEFAULT_CIRCUIT_HOLD_MS,
    healthPollMs: DEFAULT_HEALTH_POLL_MS,
    loadCircuitOpenUntil: 0,
    voiceCircuitOpenUntil: 0,
  };
}

function getAdmissionState(): AdmissionState {
  return resolveGlobalSingleton(AGENT_RUN_ADMISSION_STATE_KEY, createAdmissionState);
}

function priorityRank(priority: AgentRunAdmissionPriority): number {
  switch (priority) {
    case "foreground":
      return 2;
    case "background":
      return 1;
    case "cron":
      return 0;
  }
}

function insertByPriority<T extends { priority: AgentRunAdmissionPriority; sequence: number }>(
  queue: T[],
  entry: T,
): void {
  const insertAt = queue.findIndex(
    (queued) =>
      priorityRank(queued.priority) < priorityRank(entry.priority) ||
      (queued.priority === entry.priority && queued.sequence > entry.sequence),
  );
  if (insertAt < 0) {
    queue.push(entry);
    return;
  }
  queue.splice(insertAt, 0, entry);
}

function notifyQueueReason(
  entry: Pick<AdmissionTask, "queueReasonCode" | "onQueueReason">,
  reason: AgentRunQueueReason | undefined,
): void {
  if (entry.queueReasonCode === reason?.code) {
    return;
  }
  entry.queueReasonCode = reason?.code;
  try {
    entry.onQueueReason?.(reason);
  } catch {
    // Admission callbacks are observability only; they never own execution.
  }
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("Agent run admission aborted");
  error.name = "AbortError";
  return error;
}

function bindQueuedAbort<T extends { clearQueuedAbort?: () => void }>(params: {
  signal?: AbortSignal;
  queue: T[];
  entry: T;
  reject: (reason?: unknown) => void;
  onRemoved: () => void;
}): void {
  if (!params.signal) {
    return;
  }
  const onAbort = () => {
    const index = params.queue.indexOf(params.entry);
    if (index < 0) {
      return;
    }
    params.queue.splice(index, 1);
    params.entry.clearQueuedAbort?.();
    params.reject(abortReason(params.signal!));
    params.onRemoved();
  };
  params.signal.addEventListener("abort", onAbort, { once: true });
  params.entry.clearQueuedAbort = () => params.signal?.removeEventListener("abort", onAbort);
  if (params.signal.aborted) {
    onAbort();
  }
}

function activeWorkerCount(state: AdmissionState, workerSlot: "foreground" | "background"): number {
  let count = 0;
  for (const active of state.activeWorkers.values()) {
    if (active.workerSlot === workerSlot) {
      count += 1;
    }
  }
  return count;
}

function scopesConflict(left: AgentRunResourceScope, right: AgentRunResourceScope): boolean {
  // Message actions now take an exact durable lock at their broker boundary.
  // Other families retain Stage 2's process guard until their complete tool
  // surface is converted; removing it early would expose unfenced mutations.
  if (
    (left.kind === "keys" && left.keys.length === 0) ||
    (right.kind === "keys" && right.keys.length === 0)
  ) {
    return false;
  }
  if (left.kind === "exclusive" || right.kind === "exclusive") {
    return true;
  }
  const rightKeys = new Set(right.keys);
  return left.keys.some((key) => rightKeys.has(key) && !key.startsWith("message:"));
}

function hasResourceConflict(state: AdmissionState, entry: AdmissionTask): boolean {
  for (const active of state.activeWorkers.values()) {
    // Nested work inherits its admission lineage. It must still conflict with
    // unrelated owners, but never queue behind resources held by an ancestor
    // that is synchronously awaiting this child.
    if (entry.ancestorAdmissionIds.has(active.id)) {
      continue;
    }
    if (scopesConflict(active.resourceScope, entry.resourceScope)) {
      return true;
    }
  }
  return false;
}

function hasEarlierQueuedResourceReservation(state: AdmissionState, entry: AdmissionTask): boolean {
  for (const queued of state.workerQueue) {
    if (queued === entry) {
      return false;
    }
    const blockedByAwaitingAncestor = [...entry.ancestorAdmissionIds].some((ancestorId) => {
      const ancestor = state.activeWorkers.get(ancestorId);
      return ancestor && scopesConflict(ancestor.resourceScope, queued.resourceScope);
    });
    if (blockedByAwaitingAncestor) {
      // The earlier entry cannot run until this child's awaiting ancestor
      // releases its resource. Let the child finish so the ancestor can release.
      continue;
    }
    if (scopesConflict(queued.resourceScope, entry.resourceScope)) {
      return true;
    }
  }
  return false;
}

function sampleCircuitState(state: AdmissionState): {
  loadGuarded: boolean;
  voiceGuarded: boolean;
} {
  const now = state.now();
  try {
    if (state.readLoadDegraded()) {
      state.loadCircuitOpenUntil = Math.max(state.loadCircuitOpenUntil, now + state.circuitHoldMs);
    }
  } catch {
    state.loadCircuitOpenUntil = Math.max(state.loadCircuitOpenUntil, now + state.circuitHoldMs);
  }
  try {
    const voice = state.readVoiceHealth();
    if (voice.active && !voice.healthy) {
      state.voiceCircuitOpenUntil = Math.max(
        state.voiceCircuitOpenUntil,
        now + state.circuitHoldMs,
      );
    }
  } catch {
    state.voiceCircuitOpenUntil = Math.max(state.voiceCircuitOpenUntil, now + state.circuitHoldMs);
  }
  return {
    loadGuarded: now < state.loadCircuitOpenUntil,
    voiceGuarded: now < state.voiceCircuitOpenUntil,
  };
}

function resolveWorkerQueueReason(
  state: AdmissionState,
  entry: AdmissionTask,
  circuits: ReturnType<typeof sampleCircuitState>,
): AgentRunQueueReason | undefined {
  if (entry.priority !== "foreground" && circuits.loadGuarded) {
    return {
      code: "load_guard",
      detail: "Gateway load is high, so background admission is paused.",
    };
  }
  if (entry.priority !== "foreground" && circuits.voiceGuarded) {
    return {
      code: "voice_unhealthy",
      detail: "Realtime voice health is degraded, so background admission is paused.",
    };
  }
  if (entry.workerSlot !== "existing") {
    const workerLimit =
      entry.workerSlot === "foreground" ? FOREGROUND_WORKER_LIMIT : BACKGROUND_WORKER_LIMIT;
    if (activeWorkerCount(state, entry.workerSlot) >= workerLimit) {
      return {
        code: "worker_slot_full",
        detail:
          entry.workerSlot === "foreground"
            ? "The reserved foreground worker is busy."
            : "The background worker is busy.",
      };
    }
  }
  // Foreground admission is an availability boundary, including when its
  // prompt-derived scope looks mutating. Admission never authorizes an effect:
  // an unconverted adapter must refuse at execution, while converted adapters
  // acquire exact durable locks. Keeping coarse serialization here would make
  // prompt classification a safety gate and strand the interactive worker.
  if (entry.priority !== "foreground") {
    if (hasEarlierQueuedResourceReservation(state, entry)) {
      return {
        code: "resource_busy",
        detail: "Earlier queued work is waiting for the same side-effect resource.",
      };
    }
    if (hasResourceConflict(state, entry)) {
      return {
        code: "resource_busy",
        detail: "Earlier work still owns the same side-effect resource.",
      };
    }
  }
  return undefined;
}

function scheduleHealthRetry(state: AdmissionState): void {
  if (state.healthRetryTimer || state.workerQueue.length === 0) {
    return;
  }
  state.healthRetryTimer = setTimeout(() => {
    state.healthRetryTimer = undefined;
    pumpWorkerQueue();
  }, state.healthPollMs);
  state.healthRetryTimer.unref?.();
}

function pumpWorkerQueue(): void {
  const state = getAdmissionState();
  const circuits = sampleCircuitState(state);
  let healthBlocked = false;
  for (const entry of [...state.workerQueue]) {
    const reason = resolveWorkerQueueReason(state, entry, circuits);
    if (reason) {
      notifyQueueReason(entry, reason);
      healthBlocked ||= reason.code === "load_guard" || reason.code === "voice_unhealthy";
      continue;
    }
    const index = state.workerQueue.indexOf(entry);
    if (index < 0) {
      continue;
    }
    state.workerQueue.splice(index, 1);
    entry.clearQueuedAbort?.();
    state.activeWorkers.set(entry.id, {
      id: entry.id,
      priority: entry.priority,
      workerSlot: entry.workerSlot,
      resourceScope: entry.resourceScope,
    });
    notifyQueueReason(entry, undefined);
    try {
      entry.onAdmitted?.();
    } catch {
      // Lifecycle observers cannot revoke a scheduler admission.
    }
    void Promise.resolve()
      .then(() =>
        activeAdmissionContext.run(new Set([...entry.ancestorAdmissionIds, entry.id]), entry.task),
      )
      .then(entry.resolve, entry.reject)
      .finally(() => {
        state.activeWorkers.delete(entry.id);
        pumpWorkerQueue();
      });
  }
  if (healthBlocked) {
    scheduleHealthRetry(state);
  }
}

function normalizeProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase() || "unknown";
  return normalized === "openai-codex" ? "openai" : normalized;
}

function getProviderState(provider: string): ProviderState {
  const state = getAdmissionState();
  const key = normalizeProvider(provider);
  const existing = state.providers.get(key);
  if (existing) {
    return existing;
  }
  const created: ProviderState = { active: new Map(), queue: [] };
  state.providers.set(key, created);
  return created;
}

function providerCanStart(
  providerState: ProviderState,
  priority: AgentRunAdmissionPriority,
): boolean {
  if (providerState.active.size >= PROVIDER_TOTAL_CONCURRENCY_LIMIT) {
    return false;
  }
  if (priority === "foreground") {
    return true;
  }
  let backgroundActive = 0;
  for (const activePriority of providerState.active.values()) {
    if (activePriority !== "foreground") {
      backgroundActive += 1;
    }
  }
  // Keep one provider slot available for the reserved foreground worker.
  return backgroundActive < PROVIDER_NON_FOREGROUND_CONCURRENCY_LIMIT;
}

function pumpProviderQueue(provider: string): void {
  const providerState = getProviderState(provider);
  for (const entry of [...providerState.queue]) {
    if (!providerCanStart(providerState, entry.priority)) {
      notifyQueueReason(entry, {
        code: "provider_saturated",
        detail: `The ${entry.provider} subscription concurrency limit is full.`,
      });
      continue;
    }
    const index = providerState.queue.indexOf(entry);
    if (index < 0) {
      continue;
    }
    providerState.queue.splice(index, 1);
    entry.clearQueuedAbort?.();
    providerState.active.set(entry.id, entry.priority);
    notifyQueueReason(entry, undefined);
    void Promise.resolve()
      .then(entry.task)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        providerState.active.delete(entry.id);
        pumpProviderQueue(provider);
      });
  }
}

export function runWithAgentWorkerAdmission<T>(
  params: {
    runId: string;
    priority: AgentRunAdmissionPriority;
    workerSlot: AgentRunWorkerSlot;
    resourceScope: AgentRunResourceScope;
    onQueueReason?: AgentRunAdmissionOptions["onQueueReason"];
    onAdmitted?: AgentRunAdmissionOptions["onAdmitted"];
    abortSignal?: AbortSignal;
  },
  task: () => Promise<T>,
): Promise<T> {
  const state = getAdmissionState();
  return new Promise<T>((resolve, reject) => {
    const entry: AdmissionTask = {
      id: state.nextId++,
      runId: params.runId,
      priority: params.priority,
      workerSlot: params.workerSlot,
      resourceScope: params.resourceScope,
      ancestorAdmissionIds: new Set(activeAdmissionContext.getStore() ?? []),
      sequence: state.nextSequence++,
      task,
      resolve: (value) => resolve(value as T),
      reject,
      onQueueReason: params.onQueueReason,
      onAdmitted: params.onAdmitted,
    };
    insertByPriority(state.workerQueue, entry);
    bindQueuedAbort({
      signal: params.abortSignal,
      queue: state.workerQueue,
      entry,
      reject,
      onRemoved: pumpWorkerQueue,
    });
    pumpWorkerQueue();
  });
}

/**
 * Preserve the current admission lineage when a lane stores work for later.
 * AsyncLocalStorage does not follow a plain callback invoked by another queue.
 */
export function bindAgentRunAdmissionContext<T>(task: () => Promise<T>): () => Promise<T> {
  const current = activeAdmissionContext.getStore();
  if (!current) {
    return task;
  }
  const lineage = new Set(current);
  return () => activeAdmissionContext.run(lineage, task);
}

export function runWithAgentProviderAdmission<T>(
  params: {
    provider: string;
    priority: AgentRunAdmissionPriority;
    onQueueReason?: AgentRunAdmissionOptions["onQueueReason"];
    abortSignal?: AbortSignal;
  },
  task: () => Promise<T>,
): Promise<T> {
  const state = getAdmissionState();
  const provider = normalizeProvider(params.provider);
  const providerState = getProviderState(provider);
  return new Promise<T>((resolve, reject) => {
    const entry: ProviderTask = {
      id: state.nextId++,
      provider,
      priority: params.priority,
      sequence: state.nextSequence++,
      task,
      resolve: (value) => resolve(value as T),
      reject,
      onQueueReason: params.onQueueReason,
    };
    insertByPriority(providerState.queue, entry);
    bindQueuedAbort({
      signal: params.abortSignal,
      queue: providerState.queue,
      entry,
      reject,
      onRemoved: () => pumpProviderQueue(provider),
    });
    pumpProviderQueue(provider);
  });
}

function resourceKey(kind: string, value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 24);
  return `${kind}:${digest}`;
}

function extractFirstMatch(request: string, pattern: RegExp): string | undefined {
  const value = pattern.exec(request)?.[1]?.trim();
  return value || undefined;
}

/**
 * Produces a scheduling hint for known mutation families. Exact durable keys
 * are derived again from validated tool arguments at each broker boundary.
 */
export function deriveAgentRunResourceScope(params: {
  request: string;
  messageTo?: string;
  messageThreadId?: string | number;
}): AgentRunResourceScope {
  const request = params.request.trim();
  const normalized = request.toLowerCase();
  const keys: string[] = [];
  const mutationFamilies = new Set<string>();

  const memoryPage = extractFirstMatch(
    request,
    /\b(?:memory\s+(?:page|file)|(?:edit|update|write\s+to)\s+memory)\s+["'`]?([^"'`\n,.;]+)["'`]?/iu,
  );
  if (memoryPage) {
    mutationFamilies.add("memory");
    keys.push(resourceKey("memory", memoryPage));
  }

  const foodLogIntent =
    /\b(?:add|append|log|record|track)\b[^\n]*?\b(?:food(?:\s+(?:log|diary))?|meal|breakfast|lunch|dinner|snack)\b/iu.test(
      request,
    );
  const foodDate = extractFirstMatch(
    normalized,
    /\b(?:food\s+(?:log|diary)|log\s+(?:food|meal))\b[^\n]*?\b(\d{4}-\d{2}-\d{2}|today|yesterday)\b/iu,
  );
  if (foodLogIntent) {
    mutationFamilies.add("food-log");
    keys.push(resourceKey("food-log", foodDate ?? "unspecified-date"));
  }

  const isMessageMutation = /\b(?:send|message|email|text|reply)\b/iu.test(request);
  if (isMessageMutation) {
    mutationFamilies.add("message");
    const recipient =
      extractFirstMatch(
        request,
        /\b(?:send|message|email|text|reply)\b[^\n]*?\b(?:to|in\s+thread)\s+([^,\n.;]+)/iu,
      ) ??
      (params.messageThreadId == null
        ? undefined
        : `${params.messageTo ?? "unknown"}:${String(params.messageThreadId)}`);
    if (!recipient) {
      return { kind: "exclusive" };
    }
    keys.push(resourceKey("message", recipient));
  }

  const smartHomeEntity = extractFirstMatch(
    request,
    /\b(?:turn|set|lock|unlock|open|close)\s+(?:the\s+)?(.+?)(?:\s+(?:on|off|to|at)\b|[,.;\n]|$)/iu,
  );
  if (smartHomeEntity) {
    mutationFamilies.add("smart-home");
    keys.push(resourceKey("smart-home", smartHomeEntity));
  }

  const readOnlyPurchase =
    /\b(?:check|compare|explain|find|look\s+up|read|research|review|show|summarize|what|when|where|which|who|why)\b[^\n]*\b(?:buy|purchase|order|checkout|pay(?:ment)?)\b/iu.test(
      request,
    ) && !/\b(?:and|then)\s+(?:buy|purchase|order|checkout|pay)\b/iu.test(request);
  if (/\b(?:buy|purchase|order|checkout|pay)\b/iu.test(request) && !readOnlyPurchase) {
    mutationFamilies.add("purchase");
    // The mutation coordinator recognizes this family and fails the run before
    // model/tool execution until a purchase adapter owns durable reconciliation.
    keys.push(resourceKey("purchase", "global"));
  }

  const hasMutationVerb =
    /\b(?:add|append|book|cancel|change|create|delete|edit|post|remove|schedule|send|set|update|write)\b/iu.test(
      request,
    ) || /(?:^|\b(?:and|please|then)\s+)(?:log|record)\b/iu.test(request);
  if (hasMutationVerb && mutationFamilies.size === 0) {
    return { kind: "exclusive" };
  }
  if (keys.length > 0) {
    return { kind: "keys", keys: [...new Set(keys)].toSorted() };
  }

  const isReadOnly =
    !hasMutationVerb &&
    /(?:^|\b)(?:check|compare|explain|find|how|list|look\s+up|read|research|review|show|summarize|what|when|where|which|who|why)\b/iu.test(
      request,
    );
  return isReadOnly ? { kind: "keys", keys: [] } : { kind: "exclusive" };
}

function defaultAdmissionPriority(params: {
  trigger?: string;
  lane?: string;
}): AgentRunAdmissionPriority {
  if (params.trigger === "cron" || params.lane === "cron" || params.lane === "cron-nested") {
    return "cron";
  }
  if (
    params.trigger === "heartbeat" ||
    params.trigger === "memory" ||
    params.trigger === "overflow" ||
    params.lane === "subagent" ||
    params.lane === "nested"
  ) {
    return "background";
  }
  return "foreground";
}

export function resolveAgentRunAdmission(params: {
  runId: string;
  trigger?: string;
  lane?: string;
  request: string;
  messageTo?: string;
  messageThreadId?: string | number;
  explicit?: AgentRunAdmissionOptions;
}): Required<Pick<AgentRunAdmissionOptions, "priority" | "resourceScope">> &
  Pick<
    AgentRunAdmissionOptions,
    "freshnessDeadlineAtMs" | "jobId" | "onQueueReason" | "onAdmitted"
  > {
  const override = getAdmissionState().overrides.get(params.runId);
  const selected = params.explicit ?? override;
  return {
    priority: selected?.priority ?? defaultAdmissionPriority(params),
    resourceScope:
      selected?.resourceScope ??
      deriveAgentRunResourceScope({
        request: params.request,
        messageTo: params.messageTo,
        messageThreadId: params.messageThreadId,
      }),
    onQueueReason: selected?.onQueueReason,
    onAdmitted: selected?.onAdmitted,
    freshnessDeadlineAtMs: selected?.freshnessDeadlineAtMs,
    jobId: selected?.jobId,
  };
}

export function registerAgentRunAdmissionOverride(
  runId: string,
  options: AgentRunAdmissionOptions,
): () => void {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    return () => {};
  }
  const state = getAdmissionState();
  state.overrides.set(normalizedRunId, options);
  return () => {
    if (state.overrides.get(normalizedRunId) === options) {
      state.overrides.delete(normalizedRunId);
    }
  };
}

export function configureAgentRunAdmissionHealth(params: {
  readLoadDegraded?: () => boolean;
  readVoiceHealth?: () => VoiceHealth;
}): void {
  const state = getAdmissionState();
  state.readLoadDegraded = params.readLoadDegraded ?? (() => false);
  state.readVoiceHealth = params.readVoiceHealth ?? (() => ({ active: false, healthy: true }));
  pumpWorkerQueue();
}

export function wakeAgentRunAdmission(): void {
  pumpWorkerQueue();
}

export function resetAgentRunAdmissionForTest(params?: {
  now?: () => number;
  circuitHoldMs?: number;
  healthPollMs?: number;
}): void {
  const state = getAdmissionState();
  if (state.healthRetryTimer) {
    clearTimeout(state.healthRetryTimer);
  }
  Object.assign(state, createAdmissionState(), {
    now: params?.now ?? Date.now,
    circuitHoldMs: params?.circuitHoldMs ?? DEFAULT_CIRCUIT_HOLD_MS,
    healthPollMs: params?.healthPollMs ?? DEFAULT_HEALTH_POLL_MS,
  });
  state.healthRetryTimer = undefined;
}
