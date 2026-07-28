/**
 * Runtime adapter for realtime voice control of active OpenClaw agent runs.
 *
 * The shared module owns classification and message contracts; this adapter
 * binds those contracts to embedded-run abort, status, and steering primitives.
 */
import type { EmbeddedAgentQueueMessageOutcome } from "../agents/embedded-agent-runner/runs.js";
import {
  abortEmbeddedAgentRun,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunSessionId,
} from "../agents/embedded-agent-runner/runs.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getDiagnosticSessionActivitySnapshot } from "../logging/diagnostic-run-activity.js";
import {
  cancelTaskById,
  getTaskById,
  listTasksForOwnerKey,
  listTasksForRelatedSessionKey,
} from "../tasks/runtime-internal.js";
import { resolveTaskForLookupTokenForOwner } from "../tasks/task-owner-access.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { formatTaskStatusDetail, formatTaskStatusTitle } from "../tasks/task-status.js";
import {
  buildRealtimeVoiceAgentCancelProviderResult,
  buildRealtimeVoiceAgentFollowupSteeringText,
  formatRealtimeVoiceAgentQueueRejection,
  formatRealtimeVoiceAgentStatus,
  resolveRealtimeVoiceAgentControlIntent,
  type RealtimeVoiceAgentControlResult,
  type RealtimeVoiceAgentRunActivity,
} from "./agent-run-control-shared.js";
import type { TalkEvent } from "./talk-events.js";

export {
  buildRealtimeVoiceAgentCancelProviderResult,
  buildRealtimeVoiceAgentControlSpeechMessage,
  classifyRealtimeVoiceAgentControlText,
  normalizeRealtimeVoiceAgentControlMode,
  parseRealtimeVoiceAgentControlToolArgs,
  REALTIME_VOICE_AGENT_CONTROL_MODES,
  REALTIME_VOICE_AGENT_CONTROL_TOOL,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  resolveRealtimeVoiceAgentControlIntent,
  shouldAutoControlRealtimeVoiceAgentText,
  type RealtimeVoiceAgentControlMode,
  type RealtimeVoiceAgentControlIntent,
  type RealtimeVoiceAgentControlProviderResult,
  type RealtimeVoiceAgentControlResult,
  type RealtimeVoiceAgentRunActivity,
} from "./agent-run-control-shared.js";

type RealtimeVoiceAgentControlDeps = {
  abortEmbeddedAgentRun: (sessionId: string) => boolean;
  queueEmbeddedAgentMessageWithOutcomeAsync: (
    sessionId: string,
    text: string,
    options?: { steeringMode?: "all"; debounceMs?: number },
  ) => Promise<EmbeddedAgentQueueMessageOutcome>;
  getDiagnosticSessionActivitySnapshot: (params: {
    sessionId?: string;
    sessionKey?: string;
  }) => RealtimeVoiceAgentRunActivity;
  resolveActiveEmbeddedRunSessionId: (sessionKey: string) => string | undefined;
  cancelTaskById?: typeof cancelTaskById;
  getTaskById?: typeof getTaskById;
  listTasksForOwnerKey?: typeof listTasksForOwnerKey;
  listTasksForRelatedSessionKey?: typeof listTasksForRelatedSessionKey;
  resolveTaskForLookupTokenForOwner?: typeof resolveTaskForLookupTokenForOwner;
};

const defaultDeps: RealtimeVoiceAgentControlDeps = {
  abortEmbeddedAgentRun,
  getDiagnosticSessionActivitySnapshot,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunSessionId,
  cancelTaskById,
  getTaskById,
  listTasksForOwnerKey,
  listTasksForRelatedSessionKey,
  resolveTaskForLookupTokenForOwner,
};

function isActiveTask(task: TaskRecord): boolean {
  return task.status === "queued" || task.status === "running";
}

function isChildVoiceConsultTask(task: TaskRecord | undefined, sessionKey: string): boolean {
  return (
    task?.scopeKind === "session" &&
    task.taskKind === "agent_consult" &&
    task.childSessionKey?.trim() === sessionKey
  );
}

function isOwnedActiveVoiceConsultTask(task: TaskRecord, ownerKey: string): boolean {
  return (
    isActiveTask(task) &&
    task.scopeKind === "session" &&
    task.taskKind === "agent_consult" &&
    task.ownerKey?.trim() === ownerKey &&
    Boolean(task.childSessionKey?.trim())
  );
}

function formatVoiceTaskStatus(task: TaskRecord): string {
  const detail = formatTaskStatusDetail(task);
  return `${formatTaskStatusTitle(task)} is ${task.status}${detail ? `: ${detail}` : ""}. Job ${task.taskId}.`;
}

function buildTaskControlResult(params: {
  task: TaskRecord;
  mode: RealtimeVoiceAgentControlResult["mode"];
  sessionKey: string;
  ok: boolean;
  message: string;
  aborted?: boolean;
  reason?: string;
}): RealtimeVoiceAgentControlResult {
  return {
    ok: params.ok,
    mode: params.mode,
    sessionKey: params.sessionKey,
    active: isActiveTask(params.task),
    target: "task",
    jobId: params.task.taskId,
    ...(params.aborted === undefined ? {} : { aborted: params.aborted }),
    ...(params.reason ? { reason: params.reason } : {}),
    message: params.message,
    speak: true,
    show: true,
    suppress: false,
    ...(params.mode === "cancel" && params.aborted
      ? { providerResult: buildRealtimeVoiceAgentCancelProviderResult(params.message) }
      : {}),
  };
}

/** Apply a spoken status, cancel, steer, or follow-up request to an active run. */
export async function controlRealtimeVoiceAgentRun(
  params: {
    sessionKey: string;
    text: string;
    mode?: unknown;
    jobId?: string;
    cfg?: OpenClawConfig;
    recentEvents?: readonly TalkEvent[];
  },
  deps: RealtimeVoiceAgentControlDeps = defaultDeps,
): Promise<RealtimeVoiceAgentControlResult> {
  const sessionKey = params.sessionKey.trim();
  const text = params.text.trim();
  const intent = resolveRealtimeVoiceAgentControlIntent({ text, mode: params.mode });
  const mode = intent.mode;
  const jobId = params.jobId?.trim();
  const resolveTask =
    deps.resolveTaskForLookupTokenForOwner ?? defaultDeps.resolveTaskForLookupTokenForOwner;
  const listTasks = deps.listTasksForOwnerKey ?? defaultDeps.listTasksForOwnerKey;
  const listRelatedTasks =
    deps.listTasksForRelatedSessionKey ?? defaultDeps.listTasksForRelatedSessionKey;
  const readTask = deps.getTaskById ?? defaultDeps.getTaskById;
  const cancelTask = deps.cancelTaskById ?? defaultDeps.cancelTaskById;
  const ownerTasks = listTasks?.(sessionKey) ?? [];
  const implicitConsultTask = jobId
    ? undefined
    : ownerTasks.find((task) => isOwnedActiveVoiceConsultTask(task, sessionKey));
  const ownerTask = jobId ? resolveTask?.({ token: jobId, callerOwnerKey: sessionKey }) : undefined;
  const childTask = jobId && !ownerTask ? readTask?.(jobId) : undefined;
  const requestedTask =
    ownerTask ??
    (isChildVoiceConsultTask(childTask, sessionKey) ? childTask : undefined) ??
    (mode === "cancel" ? implicitConsultTask : undefined);

  if (jobId && !requestedTask) {
    return {
      ok: false,
      mode,
      sessionKey,
      active: false,
      ...(mode === "cancel" ? { aborted: false } : {}),
      target: "task",
      jobId,
      reason: "task_not_found",
      message: `I couldn't find job ${jobId} in this session.`,
      speak: true,
      show: true,
      suppress: false,
    };
  }
  if (requestedTask && mode === "status") {
    return buildTaskControlResult({
      task: requestedTask,
      mode,
      sessionKey,
      ok: true,
      message: formatVoiceTaskStatus(requestedTask),
    });
  }
  if (requestedTask && mode === "cancel") {
    if (!cancelTask) {
      return buildTaskControlResult({
        task: requestedTask,
        mode,
        sessionKey,
        ok: false,
        aborted: false,
        reason: "task_cancel_unavailable",
        message: `Job ${requestedTask.taskId} cannot be cancelled from this voice surface.`,
      });
    }
    const cancelled = await cancelTask({
      cfg: params.cfg ?? getRuntimeConfig(),
      taskId: requestedTask.taskId,
      reason: "Cancelled by voice request.",
    });
    return buildTaskControlResult({
      task: cancelled.task ?? requestedTask,
      mode,
      sessionKey,
      ok: cancelled.cancelled,
      aborted: cancelled.cancelled,
      ...(cancelled.cancelled ? {} : { reason: cancelled.reason ?? "abort_rejected" }),
      message: cancelled.cancelled
        ? `Cancelled ${formatTaskStatusTitle(requestedTask)}. Job ${requestedTask.taskId}.`
        : (cancelled.reason ?? `Could not cancel job ${requestedTask.taskId}.`),
    });
  }
  if (requestedTask) {
    return buildTaskControlResult({
      task: requestedTask,
      mode,
      sessionKey,
      ok: false,
      reason: "task_control_mode_unsupported",
      message: `Job ${requestedTask.taskId} supports status and cancel controls only.`,
    });
  }
  // Talk consults execute in snapshot-forked worker sessions. Legacy spoken
  // controls do not carry a job id, so route them through the newest active
  // consult owned by this Talk session instead of missing the worker run.
  const activeRunSessionKey = implicitConsultTask?.childSessionKey?.trim() || sessionKey;
  const sessionId = deps.resolveActiveEmbeddedRunSessionId(activeRunSessionKey);
  const activity = deps.getDiagnosticSessionActivitySnapshot({
    sessionId,
    sessionKey: activeRunSessionKey,
  });
  const activeTasks =
    mode === "status"
      ? [
          ...ownerTasks,
          ...(listRelatedTasks?.(sessionKey) ?? []).filter((task) =>
            isChildVoiceConsultTask(task, sessionKey),
          ),
        ].filter(
          (task, index, tasks) =>
            isActiveTask(task) &&
            tasks.findIndex((candidate) => candidate.taskId === task.taskId) === index,
        )
      : [];
  const active = Boolean(
    activeTasks.length > 0 || sessionId || activity.activeWorkKind || activity.hasActiveEmbeddedRun,
  );

  // Status is read-only and can answer from diagnostic activity even when the
  // active embedded run id has already disappeared.
  if (mode === "status") {
    const taskMessage =
      activeTasks.length > 0
        ? activeTasks
            .slice(0, 3)
            .map((task) => formatVoiceTaskStatus(task))
            .join(" ")
        : undefined;
    return {
      ok: true,
      mode,
      sessionKey,
      ...(sessionId ? { sessionId } : {}),
      active,
      message:
        taskMessage ??
        formatRealtimeVoiceAgentStatus({
          active,
          recentEvents: params.recentEvents,
          activity,
        }),
      speak: true,
      show: true,
      suppress: false,
    };
  }

  // Cancellation requires a concrete embedded-run id; activity-only snapshots
  // are not abortable and should return an explicit no-active-run response.
  if (mode === "cancel") {
    if (!sessionId) {
      return {
        ok: false,
        mode,
        sessionKey,
        active: false,
        aborted: false,
        reason: "no_active_run",
        message: "There is no active OpenClaw run to cancel.",
        speak: true,
        show: true,
        suppress: false,
      };
    }
    const aborted = deps.abortEmbeddedAgentRun(sessionId);
    const message = aborted
      ? "Cancelled the active OpenClaw run."
      : "OpenClaw could not cancel the active run.";
    return {
      ok: aborted,
      mode,
      sessionKey,
      sessionId,
      active: true,
      aborted,
      ...(aborted ? {} : { reason: "abort_rejected" }),
      message,
      speak: true,
      show: true,
      suppress: false,
      ...(aborted ? { providerResult: buildRealtimeVoiceAgentCancelProviderResult(message) } : {}),
    };
  }

  if (!sessionId) {
    return {
      ok: false,
      mode,
      sessionKey,
      active: false,
      queued: false,
      reason: "no_active_run",
      message: "There is no active OpenClaw run to steer.",
      speak: true,
      show: true,
      suppress: false,
    };
  }

  // Steering and follow-up both enqueue to the active run; follow-up is wrapped
  // so the runner treats it as deferred context instead of an immediate pivot.
  const steerText = mode === "followup" ? buildRealtimeVoiceAgentFollowupSteeringText(text) : text;
  const outcome = await deps.queueEmbeddedAgentMessageWithOutcomeAsync(sessionId, steerText, {
    steeringMode: "all",
    debounceMs: 0,
  });
  if (!outcome.queued) {
    return {
      ok: false,
      mode,
      sessionKey,
      sessionId: outcome.sessionId,
      active: true,
      queued: false,
      reason: outcome.reason,
      message: formatRealtimeVoiceAgentQueueRejection(mode, outcome.reason),
      speak: true,
      show: true,
      suppress: false,
    };
  }

  return {
    ok: true,
    mode,
    sessionKey,
    sessionId: outcome.sessionId,
    active: true,
    queued: true,
    target: outcome.target,
    message:
      mode === "followup"
        ? "Queued that follow-up for the active OpenClaw run."
        : "Got it. I steered the active run.",
    speak: true,
    show: true,
    suppress: false,
    ...(outcome.enqueuedAtMs !== undefined ? { enqueuedAtMs: outcome.enqueuedAtMs } : {}),
    ...(outcome.deliveredAtMs !== undefined ? { deliveredAtMs: outcome.deliveredAtMs } : {}),
  };
}
