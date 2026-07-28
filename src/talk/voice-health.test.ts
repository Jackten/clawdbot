import { afterEach, describe, expect, it } from "vitest";
import { resetAgentRunAdmissionForTest } from "../agents/agent-run-admission.js";
import {
  getRealtimeVoiceHealthSnapshot,
  reportRealtimeVoiceHealth,
  resetRealtimeVoiceHealthForTest,
} from "./voice-health.js";

afterEach(() => {
  resetRealtimeVoiceHealthForTest();
  resetAgentRunAdmissionForTest();
});

describe("realtime voice health", () => {
  it("reports the combined health of active voice sessions", () => {
    reportRealtimeVoiceHealth({
      sourceId: "relay:one",
      active: true,
      healthy: true,
      expiresAtMs: 200,
    });
    reportRealtimeVoiceHealth({
      sourceId: "browser:two",
      active: true,
      healthy: false,
      expiresAtMs: 200,
    });

    expect(getRealtimeVoiceHealthSnapshot(100)).toEqual({
      active: true,
      healthy: false,
    });

    reportRealtimeVoiceHealth({
      sourceId: "browser:two",
      active: false,
      healthy: true,
    });
    expect(getRealtimeVoiceHealthSnapshot(100)).toEqual({
      active: true,
      healthy: true,
    });
  });

  it("expires stale voice sessions", () => {
    reportRealtimeVoiceHealth({
      sourceId: "relay:expired",
      active: true,
      healthy: false,
      expiresAtMs: 100,
    });

    expect(getRealtimeVoiceHealthSnapshot(100)).toEqual({
      active: false,
      healthy: true,
    });
  });
});
