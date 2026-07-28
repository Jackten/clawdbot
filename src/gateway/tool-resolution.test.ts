/**
 * Gateway tool-resolution tests.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

describe("resolveGatewayScopedTools", () => {
  beforeAll(() => {
    resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "telegram",
      inboundEventKind: "room_event",
      surface: "loopback",
    });
  });

  it("force-allows the message tool for room-event loopback turns", () => {
    const result = resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "telegram",
      inboundEventKind: "room_event",
      surface: "loopback",
    });

    const messageTool = result.tools.find((tool) => tool.name === "message");
    expect(messageTool?.description).toContain(
      "visible replies to the current source conversation",
    );
  });

  it("keeps webchat room-event turns on automatic source delivery", () => {
    const result = resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:webchat:forge-main",
      messageProvider: "webchat",
      inboundEventKind: "room_event",
      surface: "loopback",
    });

    expect(result.tools.some((tool) => tool.name === "message")).toBe(false);
  });

  it("force-allows the message tool for routed webchat room-event turns", () => {
    const result = resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "webchat",
      inboundEventKind: "room_event",
      sourceReplyDeliveryMode: "message_tool_only",
      surface: "loopback",
    });

    const messageTool = result.tools.find((tool) => tool.name === "message");
    expect(messageTool?.description).toContain(
      "visible replies to the current source conversation",
    );
  });

  it("keeps ordinary loopback turns under the configured profile", () => {
    const result = resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "telegram",
      inboundEventKind: "user_request",
      surface: "loopback",
    });

    expect(result.tools.some((tool) => tool.name === "message")).toBe(false);
  });

  it("exposes only node-scoped owner tools to a signed non-owner node turn", () => {
    const result = resolveGatewayScopedTools({
      cfg: {} as OpenClawConfig,
      sessionKey: "agent:main:main",
      senderIsOwner: false,
      requesterNodeId: "qa-node-5554",
      surface: "loopback",
    });
    const names = new Set(result.tools.map((tool) => tool.name));

    expect(names.has("nodes")).toBe(true);
    expect(names.has("cron")).toBe(false);
    expect(names.has("gateway")).toBe(false);
  });

  it("does not trust a requester node id on the public HTTP surface", () => {
    const result = resolveGatewayScopedTools({
      cfg: {
        gateway: { tools: { allow: ["nodes"] } },
      } as OpenClawConfig,
      sessionKey: "agent:main:main",
      senderIsOwner: false,
      requesterNodeId: "qa-node-5554",
      surface: "http",
    });

    expect(result.tools.some((tool) => tool.name === "nodes")).toBe(false);
  });

  it("passes loopback yield context into sessions_yield", async () => {
    const onYield = vi.fn();
    const result = resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal", alsoAllow: ["sessions_yield"] } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      sessionId: "session-123",
      onYield,
      surface: "loopback",
    });
    const yieldTool = result.tools.find((tool) => tool.name === "sessions_yield");
    if (!yieldTool) {
      throw new Error("expected sessions_yield tool");
    }

    const toolResult = await yieldTool.execute("tool-call-1", {
      message: "waiting on subagents",
    });

    expect(onYield).toHaveBeenCalledWith("waiting on subagents");
    expect(toolResult.details).toEqual({
      status: "yielded",
      message: "waiting on subagents",
    });
  });
});
