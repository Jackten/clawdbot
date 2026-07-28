import { wakeAgentRunAdmission } from "../agents/agent-run-admission.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type RealtimeVoiceHealthEntry = {
  expiresAtMs: number;
  healthy: boolean;
};

type RealtimeVoiceHealthState = {
  entries: Map<string, RealtimeVoiceHealthEntry>;
};

const REALTIME_VOICE_HEALTH_STATE_KEY = Symbol.for("openclaw.realtimeVoiceHealthState");
const DEFAULT_HEALTH_TTL_MS = 30_000;

function getState(): RealtimeVoiceHealthState {
  return resolveGlobalSingleton(REALTIME_VOICE_HEALTH_STATE_KEY, () => ({
    entries: new Map(),
  }));
}

export function reportRealtimeVoiceHealth(params: {
  sourceId: string;
  active: boolean;
  healthy: boolean;
  expiresAtMs?: number;
}): void {
  const sourceId = params.sourceId.trim();
  if (!sourceId) {
    return;
  }
  const state = getState();
  if (!params.active) {
    state.entries.delete(sourceId);
  } else {
    state.entries.set(sourceId, {
      healthy: params.healthy,
      expiresAtMs: params.expiresAtMs ?? Date.now() + DEFAULT_HEALTH_TTL_MS,
    });
  }
  wakeAgentRunAdmission();
}

export function getRealtimeVoiceHealthSnapshot(nowMs = Date.now()): {
  active: boolean;
  healthy: boolean;
} {
  const state = getState();
  let active = false;
  let healthy = true;
  for (const [sourceId, entry] of state.entries) {
    if (entry.expiresAtMs <= nowMs) {
      state.entries.delete(sourceId);
      continue;
    }
    active = true;
    healthy &&= entry.healthy;
  }
  return { active, healthy };
}

export function resetRealtimeVoiceHealthForTest(): void {
  getState().entries.clear();
  wakeAgentRunAdmission();
}
