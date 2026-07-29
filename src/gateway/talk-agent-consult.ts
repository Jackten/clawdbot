// Gateway Talk realtime agent-consult bridge.
// Starts chat.send runs that answer realtime Talk tool calls.
import { randomUUID } from "node:crypto";
import {
  ErrorCodes,
  errorShape,
  type ConnectParams,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import {
  deriveAgentRunResourceScope,
  registerAgentRunAdmissionOverride,
} from "../agents/agent-run-admission.js";
import { buildAgentRunTerminalOutcomeFromWaitResult } from "../agents/agent-run-terminal-outcome.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { captureSubagentCompletionReply } from "../agents/subagent-announce-output.js";
import { forkSessionEntryFromParent } from "../auto-reply/reply/session-fork.js";
import { normalizeTalkSection } from "../config/talk.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import {
  buildRealtimeVoiceAgentConsultChatMessage,
  parseRealtimeVoiceAgentConsultArgs,
} from "../talk/agent-consult-tool.js";
import { registerActiveCliTaskRun } from "../tasks/cli-task-cancel.js";
import {
  createRunningTaskRun,
  finalizeTaskRunByRunId,
  recordTaskRunProgressByRunId,
  setDetachedTaskDeliveryStatusByRunId,
} from "../tasks/detached-task-runtime.js";
import { markTaskLostById, maybeDeliverTaskTerminalUpdate } from "../tasks/runtime-internal.js";
import { formatCompletedWithoutReplyError } from "../tasks/task-completion-contract.js";
import { formatTaskStatusTitleText } from "../tasks/task-status.js";
import { deliveryContextFromSession } from "../utils/delivery-context.shared.js";
import { readTerminalSnapshotFromGatewayDedupe } from "./server-methods/agent-wait-dedupe.js";
import { chatHandlers } from "./server-methods/chat.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlers,
} from "./server-methods/shared-types.js";
import { resolveSessionStoreKey } from "./session-store-key.js";
import {
  acknowledgeTalkRealtimeRelayAgentConsult,
  registerTalkRealtimeRelayAgentRun,
} from "./talk-realtime-relay.js";
import { formatForLog } from "./ws-log.js";

type TalkChatSendAckStatus = "started" | "in_flight" | "ok" | "timeout" | "error";
type TalkRealtimeAgentConsultReceipt = {
  text: string;
  status: "accepted";
  jobId: string;
  runId: string;
  title: string;
  state: "running";
};

async function finalizeTalkRealtimeAgentConsultFromGateway(params: {
  context: GatewayRequestContext;
  taskRunId: string;
  runId: string;
  sessionKey: string;
}): Promise<boolean> {
  if (!params.context.dedupe) {
    return false;
  }
  const snapshot = readTerminalSnapshotFromGatewayDedupe({
    dedupe: params.context.dedupe,
    runId: params.runId,
    ignoreAgentTerminalSnapshot: true,
  });
  if (!snapshot) {
    return false;
  }
  const outcome = buildAgentRunTerminalOutcomeFromWaitResult(snapshot);
  if (!outcome) {
    return false;
  }
  const status =
    outcome.reason === "completed"
      ? "succeeded"
      : outcome.reason === "hard_timeout" || outcome.reason === "timed_out"
        ? "timed_out"
        : outcome.reason === "cancelled" || outcome.reason === "aborted"
          ? "cancelled"
          : "failed";
  let terminalSummary: string | undefined;
  let error: string | undefined;
  let terminalStatus: "succeeded" | "failed" | "timed_out" | "cancelled" = status;
  if (status === "succeeded") {
    try {
      terminalSummary = await captureSubagentCompletionReply(params.sessionKey, {
        waitForReply: true,
        outcome: { status: "ok" },
      });
    } catch (captureError) {
      error = `completion_capture_failed: ${formatForLog(captureError)} (run ${params.runId})`;
      terminalStatus = "failed";
    }
    if (!terminalSummary?.trim() && !error) {
      error = `${formatCompletedWithoutReplyError(
        "Agent consult completed without a visible reply or artifact.",
      )} (run ${params.runId})`;
      terminalStatus = "failed";
    }
  } else {
    error = `${outcome.error ?? "Agent consult failed without a reported reason."} (run ${params.runId})`;
  }
  finalizeTaskRunByRunId({
    runId: params.taskRunId,
    runtime: "cli",
    sessionKey: params.sessionKey,
    status: terminalStatus,
    endedAt: outcome.endedAt ?? Date.now(),
    ...(error ? { error, terminalSummary: error } : { terminalSummary }),
    ...(terminalStatus === "succeeded" ? { terminalOutcome: "succeeded" as const } : {}),
  });
  return true;
}

async function abortTalkRealtimeAgentConsult(params: {
  context: GatewayRequestContext;
  client: GatewayClient | null;
  isWebchatConnect: (params: ConnectParams | null | undefined) => boolean;
  requestId: string;
  sessionKey: string;
  runId: string;
}): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let responded = false;
    const abortResult = chatHandlers["chat.abort"]({
      req: {
        type: "req",
        id: `${params.requestId}:talk-tool-cancel`,
        method: "chat.abort",
      },
      client: params.client,
      isWebchatConnect: params.isWebchatConnect,
      context: params.context,
      params: {
        sessionKey: params.sessionKey,
        runId: params.runId,
      },
      respond: (ok: boolean, result?: unknown) => {
        responded = true;
        const aborted =
          ok &&
          result !== null &&
          typeof result === "object" &&
          !Array.isArray(result) &&
          (result as Record<string, unknown>).aborted === true;
        resolve(aborted);
      },
    } as Parameters<GatewayRequestHandlers[string]>[0]);
    void Promise.resolve(abortResult).then(
      () => {
        if (!responded) {
          resolve(false);
        }
      },
      () => resolve(false),
    );
  });
}

function normalizeTalkChatSendAckStatus(result: unknown): TalkChatSendAckStatus {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return "started";
  }
  const status = (result as Record<string, unknown>).status;
  return status === "in_flight" || status === "ok" || status === "timeout" || status === "error"
    ? status
    : "started";
}

function terminalTalkChatSendAckError(status: TalkChatSendAckStatus): ErrorShape | undefined {
  if (status === "timeout") {
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      "Realtime agent consult ended before the run started.",
    );
  }
  if (status === "error") {
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      "Realtime agent consult failed before the run started.",
    );
  }
  if (status === "ok") {
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      "Realtime agent consult completed before the tool result subscription started.",
    );
  }
  return undefined;
}

/**
 * Starts the agent-consult chat run that backs realtime Talk tool calls.
 */
export async function startTalkRealtimeAgentConsult(params: {
  context: GatewayRequestContext;
  client: GatewayClient | null;
  isWebchatConnect: (params: ConnectParams | null | undefined) => boolean;
  requestId: string;
  sessionKey: string;
  callId: string;
  args: unknown;
  relaySessionId?: string;
  connId?: string;
}): Promise<
  | {
      ok: true;
      runId: string;
      idempotencyKey: string;
      sessionKey: string;
      receipt: TalkRealtimeAgentConsultReceipt;
    }
  | { ok: false; error: ErrorShape }
> {
  let message: string;
  let title: string;
  try {
    message = buildRealtimeVoiceAgentConsultChatMessage(params.args);
    title = formatTaskStatusTitleText(
      parseRealtimeVoiceAgentConsultArgs(params.args).question,
      "Agent consult",
    );
  } catch (err) {
    return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)) };
  }
  const idempotencyKey = `talk-${params.callId}-${randomUUID()}`;
  const taskRunId = `talk-task-${params.callId}-${randomUUID()}`;
  const parsedArgs = parseRealtimeVoiceAgentConsultArgs(params.args);
  const cfg = params.context.getRuntimeConfig();
  const agentId = parseAgentSessionKey(params.sessionKey)?.agentId ?? resolveDefaultAgentId(cfg);
  const workerSessionKey = `agent:${agentId}:talk-job:${randomUUID()}`;
  const parentSessionKey = resolveSessionStoreKey({
    cfg,
    sessionKey: params.sessionKey,
  });
  let requesterOrigin;
  try {
    const forkResult = await forkSessionEntryFromParent({
      parentSessionKey,
      agentId,
      config: cfg,
      sessionKey: workerSessionKey,
      fallbackEntry: {
        sessionId: "",
        updatedAt: Date.now(),
      },
      patch: () => ({
        label: title,
        parentSessionKey,
        updatedAt: Date.now(),
      }),
      decisionSkipPatch: ({ entry }) => ({
        label: title,
        parentSessionKey,
        sessionId: entry.sessionId,
        updatedAt: Date.now(),
      }),
    });
    if (forkResult.status === "failed") {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.UNAVAILABLE,
          "Realtime agent consult could not snapshot the originating session context.",
        ),
      };
    }
    if (forkResult.status === "forked" || forkResult.status === "skipped") {
      requesterOrigin = deliveryContextFromSession(forkResult.sessionEntry);
    }
  } catch (error) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.UNAVAILABLE, formatForLog(error)),
    };
  }
  const task = createRunningTaskRun({
    runtime: "cli",
    taskKind: "agent_consult",
    sourceId: "talk.client.toolCall",
    requesterSessionKey: params.sessionKey,
    ownerKey: params.sessionKey,
    scopeKind: "session",
    requesterOrigin,
    childSessionKey: workerSessionKey,
    agentId,
    runId: taskRunId,
    label: title,
    task: parsedArgs.question,
    progressSummary: "Queued for background admission.",
    // The provider receives a final acknowledgement immediately. The durable
    // task is the sole owner of the later terminal result.
    notifyPolicy: "done_only",
    deliveryStatus: "not_applicable",
  });
  if (!task) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.UNAVAILABLE,
        "Realtime agent consult receipt could not be persisted.",
      ),
    };
  }
  const unregisterAdmission = registerAgentRunAdmissionOverride(idempotencyKey, {
    priority: "background",
    jobId: task.taskId,
    resourceScope: deriveAgentRunResourceScope({ request: parsedArgs.question }),
    onQueueReason: (reason) => {
      recordTaskRunProgressByRunId({
        runId: taskRunId,
        runtime: "cli",
        sessionKey: workerSessionKey,
        lastEventAt: Date.now(),
        progressSummary: reason?.detail ?? "Agent consult is running.",
        eventSummary: reason ? `Agent consult queued: ${reason.code}` : "Agent consult admitted.",
      });
    },
  });
  let relayAcknowledged = false;
  if (params.relaySessionId && params.connId) {
    try {
      relayAcknowledged = acknowledgeTalkRealtimeRelayAgentConsult({
        relaySessionId: params.relaySessionId,
        connId: params.connId,
        callId: params.callId,
      });
    } catch (error) {
      params.context.logGateway.warn(
        `realtime Talk agent consult acknowledgement failed: ${formatForLog(error)}`,
      );
    }
  }
  const finalizeUnstartedTask = async (error: ErrorShape) => {
    unregisterAdmission();
    if (relayAcknowledged) {
      setDetachedTaskDeliveryStatusByRunId({
        runId: taskRunId,
        runtime: "cli",
        sessionKey: workerSessionKey,
        deliveryStatus: "pending",
      });
    }
    const finalizedTasks = finalizeTaskRunByRunId({
      runId: taskRunId,
      runtime: "cli",
      sessionKey: workerSessionKey,
      status: "failed",
      endedAt: Date.now(),
      error: `${error.message} (run ${idempotencyKey})`,
      terminalSummary: `${error.message} (run ${idempotencyKey})`,
      suppressDelivery: !relayAcknowledged,
    });
    if (relayAcknowledged) {
      await Promise.all(
        finalizedTasks.map((finalizedTask) => maybeDeliverTaskTerminalUpdate(finalizedTask.taskId)),
      );
    }
  };
  const normalizedTalk = normalizeTalkSection(cfg.talk);
  const chatResponse = await new Promise<
    { ok: true; result: unknown } | { ok: false; error: ErrorShape } | undefined
  >((resolve) => {
    let acknowledged = false;
    const chatSendResult = chatHandlers["chat.send"]({
      req: {
        type: "req",
        id: `${params.requestId}:talk-tool-call`,
        method: "chat.send",
      },
      client: params.client,
      isWebchatConnect: params.isWebchatConnect,
      context: params.context,
      params: {
        sessionKey: workerSessionKey,
        message,
        idempotencyKey,
        ...(normalizedTalk?.consultThinkingLevel
          ? { thinking: normalizedTalk.consultThinkingLevel }
          : {}),
        ...(typeof normalizedTalk?.consultFastMode === "boolean"
          ? { fastMode: normalizedTalk.consultFastMode }
          : {}),
      },
      respond: (ok: boolean, result?: unknown, error?: ErrorShape) => {
        acknowledged = true;
        resolve(
          ok
            ? { ok: true, result }
            : {
                ok: false,
                error:
                  error ?? errorShape(ErrorCodes.UNAVAILABLE, "chat.send failed without error"),
              },
        );
      },
    } as Parameters<GatewayRequestHandlers[string]>[0]);
    void Promise.resolve(chatSendResult).then(
      () => {
        if (!acknowledged) {
          resolve(undefined);
        }
      },
      (error: unknown) => {
        if (acknowledged) {
          params.context.logGateway.warn(
            `realtime Talk agent consult failed after acknowledgement: ${formatForLog(error)}`,
          );
          return;
        }
        resolve({
          ok: false,
          error: errorShape(ErrorCodes.UNAVAILABLE, formatForLog(error)),
        });
      },
    );
  });

  if (!chatResponse) {
    const error = errorShape(
      ErrorCodes.UNAVAILABLE,
      "chat.send did not return a realtime tool result",
    );
    await finalizeUnstartedTask(error);
    return { ok: false, error };
  }
  if (!chatResponse.ok) {
    await finalizeUnstartedTask(chatResponse.error);
    return { ok: false, error: chatResponse.error };
  }
  const result = chatResponse.result;
  const terminalAckError = terminalTalkChatSendAckError(normalizeTalkChatSendAckStatus(result));
  if (terminalAckError) {
    await finalizeUnstartedTask(terminalAckError);
    return { ok: false, error: terminalAckError };
  }
  const runId =
    result && typeof result === "object" && !Array.isArray(result)
      ? typeof (result as Record<string, unknown>).runId === "string"
        ? (result as Record<string, string>).runId
        : idempotencyKey
      : idempotencyKey;
  const unregisterCancellation = registerActiveCliTaskRun({
    runId: taskRunId,
    cancel: () =>
      abortTalkRealtimeAgentConsult({
        context: params.context,
        client: params.client,
        isWebchatConnect: params.isWebchatConnect,
        requestId: params.requestId,
        sessionKey: workerSessionKey,
        runId,
      }),
  });
  const activeRun = params.context.chatAbortControllers?.get(runId);
  if (activeRun) {
    const previousOnRemoved = activeRun.onRemoved;
    activeRun.onRemoved = () => {
      try {
        previousOnRemoved?.();
      } finally {
        unregisterCancellation?.();
        unregisterAdmission();
        // Most chat runs terminalize the ledger through lifecycle events. The
        // terminal dedupe record covers valid no-lifecycle completion paths.
        void finalizeTalkRealtimeAgentConsultFromGateway({
          context: params.context,
          taskRunId,
          runId,
          sessionKey: workerSessionKey,
        });
      }
    };
  } else {
    unregisterCancellation?.();
    unregisterAdmission();
    // Production Gateway contexts always own this map. Minimal direct-handler
    // contexts may omit it; only a present map can prove the accepted run lost
    // its in-process owner.
    if (params.context.chatAbortControllers) {
      const finalizedFromGateway = await finalizeTalkRealtimeAgentConsultFromGateway({
        context: params.context,
        taskRunId,
        runId,
        sessionKey: workerSessionKey,
      });
      if (!finalizedFromGateway) {
        const error = `unknown_outcome: Realtime agent consult lost its in-process run controller after acceptance (run ${runId}).`;
        markTaskLostById({
          taskId: task.taskId,
          endedAt: Date.now(),
          error,
        });
      }
    }
  }
  const armedTasks = setDetachedTaskDeliveryStatusByRunId({
    runId: taskRunId,
    runtime: "cli",
    sessionKey: workerSessionKey,
    deliveryStatus: "pending",
  });
  await Promise.all(
    armedTasks.map((armedTask) => maybeDeliverTaskTerminalUpdate(armedTask.taskId)),
  );
  if (params.relaySessionId && params.connId) {
    registerTalkRealtimeRelayAgentRun({
      relaySessionId: params.relaySessionId,
      connId: params.connId,
      sessionKey: workerSessionKey,
      runId,
      callId: params.callId,
    });
  }
  return {
    ok: true,
    runId,
    idempotencyKey,
    sessionKey: workerSessionKey,
    receipt: {
      text: "That work is still running. I’ll deliver the result when it finishes.",
      status: "accepted",
      jobId: task.taskId,
      runId,
      title,
      state: "running",
    },
  };
}
