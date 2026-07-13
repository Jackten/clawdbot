import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const modelSelectionMocks = vi.hoisted(() => ({
  buildModelAliasIndex: vi.fn(() => ({
    byAlias: new Map([["gpt", { alias: "gpt", ref: { provider: "openai", model: "gpt-5.5" } }]]),
    byProviderAlias: new Map([
      ["openai/gpt", { alias: "gpt", ref: { provider: "openai", model: "gpt-5.5" } }],
    ]),
    byKey: new Map([["openai/gpt-5.5", ["gpt"]]]),
  })),
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-5.5" })),
}));

vi.mock("../../agents/model-selection.js", () => ({
  buildModelAliasIndex: modelSelectionMocks.buildModelAliasIndex,
  resolveDefaultModelForAgent: modelSelectionMocks.resolveDefaultModelForAgent,
}));

describe("resolveDefaultModel", () => {
  beforeEach(() => {
    modelSelectionMocks.buildModelAliasIndex.mockClear();
    modelSelectionMocks.resolveDefaultModelForAgent.mockClear();
  });

  it("defers alias index construction until aliases are read", async () => {
    const { resolveDefaultModel } = await import("./directive-handling.defaults.js");
    const cfg = { agents: { defaults: {} } } as OpenClawConfig;

    const resolved = resolveDefaultModel({ cfg, agentId: "main" });

    expect(resolved.defaultProvider).toBe("openai");
    expect(resolved.defaultModel).toBe("gpt-5.5");
    expect(modelSelectionMocks.resolveDefaultModelForAgent).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
      allowPluginNormalization: false,
    });
    expect(modelSelectionMocks.buildModelAliasIndex).not.toHaveBeenCalled();

    expect(resolved.aliasIndex.byAlias.get("gpt")?.ref).toEqual({
      provider: "openai",
      model: "gpt-5.5",
    });
    expect(resolved.aliasIndex.byProviderAlias?.get("openai/gpt")?.ref).toEqual({
      provider: "openai",
      model: "gpt-5.5",
    });
    expect(resolved.aliasIndex.byKey.get("openai/gpt-5.5")).toEqual(["gpt"]);
    expect(modelSelectionMocks.buildModelAliasIndex).toHaveBeenCalledTimes(1);
    expect(modelSelectionMocks.buildModelAliasIndex).toHaveBeenCalledWith({
      cfg,
      defaultProvider: "openai",
      allowPluginNormalization: false,
    });
  });
});
