// Verifies talk config validation errors and warnings.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRuntimeConfig,
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
} from "./config.js";
import { withTempHomeConfig } from "./test-helpers.js";

describe("talk config validation fail-closed behavior", () => {
  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    vi.restoreAllMocks();
  });

  it("can load an unpinned runtime config without replacing the process snapshot", async () => {
    await withTempHomeConfig({ gateway: { port: 19002 } }, async () => {
      const unpinned = getRuntimeConfig({ skipPluginValidation: true, pin: false });

      expect(unpinned.gateway?.port).toBe(19002);
      expect(getRuntimeConfigSnapshot()).toBeNull();

      const pinned = getRuntimeConfig();

      expect(pinned.gateway?.port).toBe(19002);
      expect(getRuntimeConfigSnapshot()).toBe(pinned);
    });
  });

  async function expectInvalidTalkConfig(config: unknown, messagePattern: RegExp) {
    await withTempHomeConfig(config, async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      let thrown: unknown;
      try {
        getRuntimeConfig();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as { code?: string } | undefined)?.code).toBe("INVALID_CONFIG");
      expect((thrown as Error).message).toMatch(messagePattern);
      expect(consoleSpy).toHaveBeenCalled();
    });
  }

  it.each([
    ["boolean", true],
    ["string", "1500"],
    ["float", 1500.5],
  ])("rejects %s talk.silenceTimeoutMs during config load", async (_label, value) => {
    await expectInvalidTalkConfig(
      {
        agents: { list: [{ id: "main" }] },
        talk: {
          silenceTimeoutMs: value,
        },
      },
      /silenceTimeoutMs|talk/i,
    );
  });

  it("rejects talk.provider when it does not match talk.providers during config load", async () => {
    await expectInvalidTalkConfig(
      {
        agents: { list: [{ id: "main" }] },
        talk: {
          provider: "acme",
          providers: {
            elevenlabs: {
              voiceId: "voice-123",
            },
          },
        },
      },
      /talk\.provider|talk\.providers|acme/i,
    );
  });

  it("rejects multi-provider talk config without talk.provider during config load", async () => {
    await expectInvalidTalkConfig(
      {
        agents: { list: [{ id: "main" }] },
        talk: {
          providers: {
            acme: {
              voiceId: "voice-acme",
            },
            elevenlabs: {
              voiceId: "voice-eleven",
            },
          },
        },
      },
      /talk\.provider|required/i,
    );
  });

  it.each(["openclaw_agent_consult", "openclaw_agent_control"])(
    "rejects talk.realtime.clientTools collision with built-in %s",
    async (name) => {
      await expectInvalidTalkConfig(
        {
          agents: { list: [{ id: "main" }] },
          talk: {
            realtime: {
              clientTools: [{ name, description: "Replace a built-in tool." }],
            },
          },
        },
        /talk\.realtime\.clientTools|must not collide|built-in/i,
      );
    },
  );

  it("rejects a client tool parameters value that is not a provider-compatible object schema", async () => {
    await expectInvalidTalkConfig(
      {
        agents: { list: [{ id: "main" }] },
        talk: {
          realtime: {
            clientTools: [
              {
                name: "phone_vibrate",
                description: "Vibrate the phone.",
                parameters: ["not", "a", "schema"],
              },
            ],
          },
        },
      },
      /talk\.realtime\.clientTools|parameters|expected object/i,
    );
  });

  it.each(["openclaw_agent_consult", "openclaw_agent_control"])(
    "rejects talk.realtime.gatewayTools collision with built-in %s",
    async (name) => {
      await expectInvalidTalkConfig(
        {
          agents: { list: [{ id: "main" }] },
          talk: {
            realtime: {
              gatewayTools: [
                { name, description: "Replace a built-in tool.", exec: "/usr/bin/false" },
              ],
            },
          },
        },
        /talk\.realtime\.gatewayTools|must not collide|built-in/i,
      );
    },
  );

  it.each([
    [
      "relative executable",
      {
        name: "control_home",
        description: "Control Home Assistant.",
        exec: "bin/control-home",
      },
      /gatewayTools|exec|absolute path/i,
    ],
    [
      "non-object parameters",
      {
        name: "control_home",
        description: "Control Home Assistant.",
        parameters: ["not", "a", "schema"],
        exec: "/usr/local/bin/control-home",
      },
      /gatewayTools|parameters|expected object/i,
    ],
    [
      "empty argument key",
      {
        name: "control_home",
        description: "Control Home Assistant.",
        exec: "/usr/local/bin/control-home",
        argKey: "   ",
      },
      /gatewayTools|argKey|too small/i,
    ],
  ])("rejects gateway tool with %s", async (_label, gatewayTool, messagePattern) => {
    await expectInvalidTalkConfig(
      {
        agents: { list: [{ id: "main" }] },
        talk: { realtime: { gatewayTools: [gatewayTool] } },
      },
      messagePattern as RegExp,
    );
  });

  it.runIf(process.platform !== "win32")(
    "rejects a Windows absolute Gateway executable path on a POSIX host",
    async () => {
      await expectInvalidTalkConfig(
        {
          agents: { list: [{ id: "main" }] },
          talk: {
            realtime: {
              gatewayTools: [
                {
                  name: "control_home",
                  description: "Control Home Assistant.",
                  exec: "C:\\tools\\control-home.exe",
                },
              ],
            },
          },
        },
        /gatewayTools|exec|absolute path/i,
      );
    },
  );

  it("rejects duplicate names across client and Gateway realtime tools", async () => {
    await expectInvalidTalkConfig(
      {
        agents: { list: [{ id: "main" }] },
        talk: {
          realtime: {
            clientTools: [{ name: "control_home", description: "Run on the phone." }],
            gatewayTools: [
              {
                name: "control_home",
                description: "Run on the Gateway.",
                exec: "/usr/local/bin/control-home",
              },
            ],
          },
        },
      },
      /tool name|unique|clientTools|gatewayTools/i,
    );
  });
});
