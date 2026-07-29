/**
 * Tests for relaying native hook events through gateway request handlers.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { testing, registerNativeHookRelay } from "../../agents/harness/native-hook-relay.js";
import { nativeHookRelayHandlers } from "./native-hook-relay.js";

const POST_TOOL_USE_PAYLOAD = {
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_response: { output: "ok" },
};

afterEach(() => {
  testing.clearNativeHookRelaysForTests();
});

describe("native hook relay gateway method", () => {
  it("accepts a live relay invocation", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["post_tool_use"],
    });

    const respond = await invokeNativeHook({
      provider: "codex",
      relayId: relay.relayId,
      generation: relay.generation,
      event: "post_tool_use",
      rawPayload: POST_TOOL_USE_PAYLOAD,
    });

    expect(respond).toHaveBeenCalledWith(true, { stdout: "", stderr: "", exitCode: 0 });
    expect(testing.getNativeHookRelayInvocationsForTests()).toHaveLength(1);
  });

  it("rejects unknown relay ids", async () => {
    const respond = await invokeNativeHook({
      provider: "codex",
      relayId: "missing",
      event: "pre_tool_use",
      rawPayload: {},
    });

    expectInvalidRequest(respond, "not found");
  });

  it("rejects stale relay generations", async () => {
    const first = registerNativeHookRelay({
      provider: "codex",
      relayId: "relay-1",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["post_tool_use"],
    });
    registerNativeHookRelay({
      provider: "codex",
      relayId: first.relayId,
      sessionId: "session-1",
      runId: "run-2",
      allowedEvents: ["post_tool_use"],
    });

    const respond = await invokeNativeHook({
      provider: "codex",
      relayId: first.relayId,
      generation: first.generation,
      event: "post_tool_use",
      rawPayload: POST_TOOL_USE_PAYLOAD,
    });

    expectInvalidRequest(respond, "native hook relay bridge stale registration");
    expect(testing.getNativeHookRelayInvocationsForTests()).toStrictEqual([]);
  });

  it("returns retryable unavailable while an active owner restores its relay", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "recovering-relay",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["post_tool_use"],
    });
    expect(testing.dropNativeHookRelayRegistrationForTests(relay.relayId)).toBe(true);

    const recovering = await invokeNativeHook({
      provider: "codex",
      relayId: relay.relayId,
      generation: relay.generation,
      event: "post_tool_use",
      rawPayload: POST_TOOL_USE_PAYLOAD,
    });
    expectRetryableUnavailable(recovering);

    await expect
      .poll(() => testing.getNativeHookRelayRegistrationForTests(relay.relayId), {
        interval: 25,
        timeout: 2_000,
      })
      .toBeDefined();
    const recovered = await invokeNativeHook({
      provider: "codex",
      relayId: relay.relayId,
      generation: relay.generation,
      event: "post_tool_use",
      rawPayload: POST_TOOL_USE_PAYLOAD,
    });
    expect(recovered).toHaveBeenCalledWith(true, { stdout: "", stderr: "", exitCode: 0 });
  });
});

async function invokeNativeHook(params: Record<string, unknown>) {
  const respond = viRespond();
  await nativeHookRelayHandlers["nativeHook.invoke"]({
    req: { type: "req", id: "1", method: "nativeHook.invoke" },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: {} as never,
  });
  return respond;
}

function expectInvalidRequest(respond: ReturnType<typeof viRespond>, message: string) {
  const call = respond.mock.calls.at(0) as
    | [boolean, unknown, { code?: string; message?: string }]
    | undefined;
  expect(call?.[0]).toBe(false);
  expect(call?.[1]).toBeUndefined();
  expect(call?.[2]?.code).toBe("INVALID_REQUEST");
  expect(call?.[2]?.message).toContain(message);
}

function expectRetryableUnavailable(respond: ReturnType<typeof viRespond>) {
  const call = respond.mock.calls.at(0) as
    | [
        boolean,
        unknown,
        {
          code?: string;
          details?: unknown;
          retryable?: boolean;
          retryAfterMs?: number;
        },
      ]
    | undefined;
  expect(call?.[0]).toBe(false);
  expect(call?.[1]).toBeUndefined();
  expect(call?.[2]).toMatchObject({
    code: "UNAVAILABLE",
    details: { reason: "native-hook-relay-recovering" },
    retryable: true,
    retryAfterMs: 100,
  });
}

function viRespond() {
  return vi.fn();
}
