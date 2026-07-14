// Stable provider-facing names reserved by OpenClaw's realtime voice runtime.
export const REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME = "openclaw_agent_consult";
export const REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME = "openclaw_agent_control";

export const REALTIME_VOICE_BUILTIN_TOOL_NAMES = [
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
] as const;
