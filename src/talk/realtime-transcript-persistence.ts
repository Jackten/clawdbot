// Persists completed realtime Talk turns into the owning agent's main session.
import { randomUUID } from "node:crypto";
import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import type { AgentMessage } from "../agents/runtime/index.js";
import {
  resolveAgentMainSessionKey,
  resolveMainSessionKey,
} from "../config/sessions/main-session.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  createSessionEntryWithTranscript,
  loadSessionEntry,
  persistSessionTranscriptTurn,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import {
  OPENCLAW_TRANSCRIPT_ARTIFACT_API,
  OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
} from "../shared/transcript-only-openclaw-assistant.js";

const TALK_REALTIME_TRANSCRIPT_MODEL = "talk-realtime";

type SourcedTalkMessage = AgentMessage & { provenance: InputProvenance };

export type PersistRealtimeVoiceTranscriptTurnParams = {
  assistantText: string;
  cfg: OpenClawConfig;
  sessionKey?: string;
  source: "talk";
  timestamp: number;
  turnId: string;
  userText: string;
};

function resolveTalkTranscriptTarget(params: { cfg: OpenClawConfig; sessionKey?: string }): {
  agentId: string;
  sessionKey: string;
} {
  const explicitAgentId = parseAgentSessionKey(params.sessionKey)?.agentId;
  const agentId = explicitAgentId ?? resolveDefaultAgentId(params.cfg);
  return {
    agentId,
    sessionKey: explicitAgentId
      ? resolveAgentMainSessionKey({ cfg: params.cfg, agentId })
      : resolveMainSessionKey(params.cfg),
  };
}

function createTalkTranscriptMessages(params: {
  assistantText: string;
  source: "talk";
  timestamp: number;
  turnId: string;
  userText: string;
}): readonly SourcedTalkMessage[] {
  const provenance = {
    kind: "external_user",
    sourceChannel: "voice",
    sourceTool: `${params.source}.realtime`,
  } satisfies InputProvenance;
  return [
    {
      role: "user",
      content: params.userText,
      timestamp: params.timestamp,
      provenance,
      idempotencyKey: `${params.turnId}:user`,
    } as SourcedTalkMessage,
    {
      role: "assistant",
      content: [{ type: "text", text: params.assistantText }],
      api: OPENCLAW_TRANSCRIPT_ARTIFACT_API,
      provider: OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
      model: TALK_REALTIME_TRANSCRIPT_MODEL,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: params.timestamp,
      provenance,
      idempotencyKey: `${params.turnId}:assistant`,
    } as SourcedTalkMessage,
  ];
}

/**
 * Appends one completed voice turn through the normal session transcript writer.
 * Its transcript update is the same event Memory Core consumes for regular turns.
 */
export async function persistRealtimeVoiceTranscriptTurn(
  params: PersistRealtimeVoiceTranscriptTurnParams,
): Promise<void> {
  const userText = params.userText.trim();
  const assistantText = params.assistantText.trim();
  if (!userText || !assistantText) {
    return;
  }

  const target = resolveTalkTranscriptTarget(params);
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: target.agentId });
  let entry = loadSessionEntry({
    agentId: target.agentId,
    sessionKey: target.sessionKey,
    storePath,
    readConsistency: "latest",
  });
  let sessionFile = entry?.sessionFile;
  if (!entry) {
    const created = await createSessionEntryWithTranscript(
      {
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        storePath,
      },
      ({ existingEntry }) => ({
        ok: true,
        entry: existingEntry ?? {
          sessionId: randomUUID(),
          updatedAt: params.timestamp,
          sessionStartedAt: params.timestamp,
          lastInteractionAt: params.timestamp,
          chatType: "direct",
          totalTokens: 0,
          totalTokensFresh: true,
        },
      }),
    );
    if (!created.ok) {
      throw new Error(`could not initialize Talk transcript session: ${created.error}`);
    }
    entry = created.entry;
    sessionFile = created.sessionFile;
  }

  const messages = createTalkTranscriptMessages({
    assistantText,
    source: params.source,
    timestamp: params.timestamp,
    turnId: params.turnId,
    userText,
  });
  const result = await persistSessionTranscriptTurn(
    {
      agentId: target.agentId,
      sessionEntry: entry,
      sessionFile,
      sessionId: entry.sessionId,
      sessionKey: target.sessionKey,
      storePath,
    },
    {
      config: params.cfg,
      expectedSessionId: entry.sessionId,
      touchSessionEntry: true,
      updateMode: "inline",
      messages: messages.map((message) => ({
        message,
        idempotencyLookup: "scan" as const,
      })),
    },
  );
  if (result.rejectedReason === "session-rebound") {
    throw new Error("Talk transcript session changed before the turn could be persisted");
  }
}
