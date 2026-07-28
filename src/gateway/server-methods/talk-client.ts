import { resolveExpiresAtMsFromDurationOrEpoch } from "@openclaw/normalization-core/number-coercion";
// Talk client methods create browser-owned realtime voice sessions and route
// client tool calls back into OpenClaw agent consult/control flows.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateTalkClientCreateParams,
  validateTalkClientSteerParams,
  validateTalkClientToolCallParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../../talk/agent-consult-tool.js";
import { controlRealtimeVoiceAgentRun } from "../../talk/agent-run-control.js";
import { resolveConfiguredRealtimeVoiceProvider } from "../../talk/provider-resolver.js";
import { reportRealtimeVoiceHealth } from "../../talk/voice-health.js";
import { startTalkRealtimeAgentConsult } from "../talk-agent-consult.js";
import {
  claimOwnedTalkClientSession,
  rememberTalkClientSession,
  resolveTalkClientSessionOwnerId,
} from "../talk-client-session-registry.js";
import {
  formatGatewayToolExecutionError,
  GATEWAY_TOOL_MAX_BUFFER_BYTES,
  GATEWAY_TOOL_TIMEOUT_MS,
  runTalkRealtimeGatewayTool,
} from "../talk-realtime-relay.js";
import { formatForLog } from "../ws-log.js";
import {
  buildRealtimeInstructions,
  buildRealtimeVoiceLaunchOptions,
  buildTalkRealtimeConfig,
  buildTalkRealtimeSessionTools,
  isUnsupportedBrowserWebRtcSession,
} from "./talk-shared.js";
import type { GatewayRequestHandlers } from "./types.js";

/**
 * Gateway methods for browser-owned realtime Talk sessions.
 *
 * These handlers create provider browser sessions and bridge client-owned tool
 * calls back into OpenClaw agent consult runs.
 */
export const talkClientHandlers: GatewayRequestHandlers = {
  "talk.client.create": async ({ params, respond, context, client }) => {
    if (!validateTalkClientCreateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.client.create params: ${formatValidationErrors(validateTalkClientCreateParams.errors)}`,
        ),
      );
      return;
    }
    const typedParams = params as {
      provider?: string;
      model?: string;
      voice?: string;
      vadThreshold?: number;
      silenceDurationMs?: number;
      prefixPaddingMs?: number;
      reasoningEffort?: string;
      mode?: string;
      transport?: string;
      brain?: string;
    };
    try {
      const runtimeConfig = context.getRuntimeConfig();
      const realtimeConfig = buildTalkRealtimeConfig(runtimeConfig, typedParams.provider);
      const mode =
        normalizeOptionalLowercaseString(typedParams.mode) ?? realtimeConfig.mode ?? "realtime";
      if (mode !== "realtime") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `talk.client.create only supports mode="realtime"; use talk.catalog for ${mode} provider discovery`,
          ),
        );
        return;
      }
      const brain =
        normalizeOptionalLowercaseString(typedParams.brain) ??
        realtimeConfig.brain ??
        "agent-consult";
      if (brain !== "agent-consult") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `talk.client.create only supports brain="agent-consult"`,
          ),
        );
        return;
      }
      const transport =
        normalizeOptionalLowercaseString(typedParams.transport) ?? realtimeConfig.transport;
      if (transport === "managed-room") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "managed-room realtime Talk sessions are not available in the browser UI yet",
          ),
        );
        return;
      }
      if (transport === "gateway-relay") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `talk.client.create is client-owned; use talk.session.create for gateway-relay`,
          ),
        );
        return;
      }
      const resolution = resolveConfiguredRealtimeVoiceProvider({
        configuredProviderId: realtimeConfig.provider,
        providerConfigs: realtimeConfig.providers,
        cfg: runtimeConfig,
        cfgForResolve: runtimeConfig,
        defaultModel: realtimeConfig.model,
        noRegisteredProviderMessage: "No realtime voice provider registered",
      });
      const launchOptions = buildRealtimeVoiceLaunchOptions({
        requested: typedParams,
        defaults: realtimeConfig,
      });
      if (resolution.provider.createBrowserSession && transport !== "gateway-relay") {
        const session = await resolution.provider.createBrowserSession({
          cfg: runtimeConfig,
          providerConfig: resolution.providerConfig,
          instructions: buildRealtimeInstructions(realtimeConfig.instructions),
          // Client-owned sessions run configured gateway tools through talk.client.toolCall, so they
          // must advertise the same list as the relay; hardcoding the built-ins here silently
          // stripped every configured tool (control_home) from WebRTC voice.
          tools: buildTalkRealtimeSessionTools(
            realtimeConfig.clientTools,
            realtimeConfig.gatewayTools,
          ),
          ...launchOptions,
        });
        if (
          !isUnsupportedBrowserWebRtcSession(session) &&
          (!transport || session.transport === transport)
        ) {
          rememberTalkClientSession({
            connId: client?.connId,
            deviceId: resolveTalkClientSessionOwnerId(client),
            sessionKey: normalizeOptionalString(params.sessionKey),
          });
          const voiceHealthExpiresAtMs =
            resolveExpiresAtMsFromDurationOrEpoch(session.expiresAt) ?? Date.now() + 30_000;
          reportRealtimeVoiceHealth({
            sourceId: `browser:${client?.connId ?? "unknown"}`,
            active: true,
            healthy: true,
            expiresAtMs: voiceHealthExpiresAtMs,
          });
          respond(true, session, undefined);
          return;
        }
        if (transport) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.UNAVAILABLE,
              `Realtime provider "${resolution.provider.id}" does not support requested browser transport "${transport}"`,
            ),
          );
          return;
        }
      }
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Realtime provider "${resolution.provider.id}" does not support client-owned realtime sessions`,
        ),
      );
    } catch (err) {
      reportRealtimeVoiceHealth({
        sourceId: `browser:${client?.connId ?? "unknown"}`,
        active: true,
        healthy: false,
        expiresAtMs: Date.now() + 10_000,
      });
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "talk.client.toolCall": async (request) => {
    const { params, respond } = request;
    if (!validateTalkClientToolCallParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.client.toolCall params: ${formatValidationErrors(validateTalkClientToolCallParams.errors)}`,
        ),
      );
      return;
    }
    if (
      !claimOwnedTalkClientSession({
        connId: request.client?.connId,
        deviceId: resolveTalkClientSessionOwnerId(request.client),
        sessionKey: params.sessionKey,
      })
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "talk.client.toolCall requires an active browser-owned Talk session",
        ),
      );
      return;
    }
    if (params.name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      // Client-owned realtime sessions send tool calls back through this RPC,
      // so configured gateway tools must use the same bounded runner as relays.
      const gatewayTool = buildTalkRealtimeConfig(
        request.context.getRuntimeConfig(),
        undefined,
      ).gatewayTools?.find((tool) => tool.name === params.name);
      if (!gatewayTool) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unsupported realtime Talk tool: ${params.name}`),
        );
        return;
      }
      const argKey = gatewayTool.argKey ?? "command";
      const rawArgs = params.args;
      const argument =
        rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)[argKey]
          : undefined;
      if (typeof argument !== "string") {
        respond(true, { result: { error: `Gateway tool requires string argument "${argKey}".` } });
        return;
      }
      try {
        const execution = await runTalkRealtimeGatewayTool(gatewayTool.exec, [argument], {
          encoding: "utf8",
          env: process.env,
          maxBuffer: GATEWAY_TOOL_MAX_BUFFER_BYTES,
          shell: false,
          timeout: GATEWAY_TOOL_TIMEOUT_MS,
          windowsHide: true,
        });
        respond(true, { result: { response: execution.stdout.trim() || "Done." } });
      } catch (error) {
        respond(true, { result: { error: formatGatewayToolExecutionError(error) } });
      }
      return;
    }
    reportRealtimeVoiceHealth({
      sourceId: `browser:${request.client?.connId ?? "unknown"}`,
      active: true,
      healthy: true,
      expiresAtMs: Date.now() + 30_000,
    });

    const result = await startTalkRealtimeAgentConsult({
      context: request.context,
      client: request.client,
      isWebchatConnect: request.isWebchatConnect,
      requestId: request.req.id,
      sessionKey: params.sessionKey,
      callId: params.callId,
      args: params.args ?? {},
      relaySessionId: normalizeOptionalString(params.relaySessionId),
      connId: normalizeOptionalString(request.client?.connId),
    });
    if (!result.ok) {
      respond(false, undefined, result.error);
      return;
    }
    respond(
      true,
      {
        runId: result.runId,
        idempotencyKey: result.idempotencyKey,
        sessionKey: result.sessionKey,
        receipt: result.receipt,
      },
      undefined,
    );
  },
  "talk.client.steer": async ({ params, respond, client, context }) => {
    if (!validateTalkClientSteerParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.client.steer params: ${formatValidationErrors(validateTalkClientSteerParams.errors)}`,
        ),
      );
      return;
    }
    const ownsBrowserTalkSession = claimOwnedTalkClientSession({
      connId: client?.connId,
      deviceId: resolveTalkClientSessionOwnerId(client),
      sessionKey: params.sessionKey,
    });
    if (
      !ownsBrowserTalkSession &&
      !hasOwnedActiveTalkClientRun({
        context,
        clientConnId: client?.connId,
        sessionKey: params.sessionKey,
      })
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "talk.client.steer requires an active browser-owned Talk session",
        ),
      );
      return;
    }
    try {
      // Exact job control is authorized by the durable task's owner key in
      // controlRealtimeVoiceAgentRun, including after the live Talk run ends.
      const result = await controlRealtimeVoiceAgentRun({
        sessionKey: params.sessionKey,
        text: params.text,
        mode: params.mode,
        ...(params.jobId ? { jobId: params.jobId } : {}),
      });
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};

function hasOwnedActiveTalkClientRun(params: {
  context: Parameters<GatewayRequestHandlers[string]>[0]["context"];
  clientConnId?: string;
  sessionKey: string;
}): boolean {
  // Browser steering is only allowed for the connection that owns the live
  // browser session; agent-owned consult runs use the relay steering path.
  const connId = normalizeOptionalString(params.clientConnId);
  const sessionKey = params.sessionKey.trim();
  if (!connId || !sessionKey) {
    return false;
  }
  for (const entry of params.context.chatAbortControllers.values()) {
    if (entry.sessionKey === sessionKey && entry.ownerConnId === connId && entry.kind !== "agent") {
      return true;
    }
  }
  return false;
}
