import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeSystemPromptWithHookContext } from "../agents/pi-embedded-runner/run/attempt.js";
import { createHookRunner } from "./hooks.js";
import { addTestHook } from "./hooks.test-helpers.js";
import {
  createModelFamilyShimBeforePromptBuildHook,
  MODEL_FAMILY_SHIM_HOOK_PRIORITY,
} from "./model-family-shims.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforePromptBuildResult,
  PluginHookRegistration,
} from "./types.js";

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function makeWorkspace(params: { openai?: string; anthropic?: string } = {}): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-family-shims-"));
  const shimsDir = path.join(workspaceDir, "shims");
  fs.mkdirSync(shimsDir, { recursive: true });
  if (typeof params.openai === "string") {
    fs.writeFileSync(path.join(shimsDir, "model-openai.md"), params.openai, "utf-8");
  }
  if (typeof params.anthropic === "string") {
    fs.writeFileSync(path.join(shimsDir, "model-anthropic.md"), params.anthropic, "utf-8");
  }
  return workspaceDir;
}

function createHookCtx(params: {
  workspaceDir: string;
  provider: string;
  model: string;
  runId?: string;
}): PluginHookAgentContext {
  return {
    agentId: "test-agent",
    sessionId: "session-1",
    sessionKey: "agent:test",
    workspaceDir: params.workspaceDir,
    provider: params.provider,
    model: params.model,
    runId: params.runId ?? "run-1",
  };
}

function addBeforePromptBuildHook(
  registry: PluginRegistry,
  params: {
    pluginId: string;
    priority?: number;
    handler: (
      event: { prompt: string; messages: unknown[] },
      ctx: PluginHookAgentContext,
    ) =>
      | PluginHookBeforePromptBuildResult
      | Promise<PluginHookBeforePromptBuildResult | void>
      | void;
  },
) {
  addTestHook({
    registry,
    pluginId: params.pluginId,
    hookName: "before_prompt_build",
    handler: params.handler as PluginHookRegistration["handler"],
    priority: params.priority,
  });
}

describe("model family shim hook", () => {
  let registry: PluginRegistry;
  let workspaces: string[];
  let warnings: string[];

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
    workspaces = [];
    warnings = [];
  });

  afterEach(() => {
    for (const workspace of workspaces) {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  function createShimHook() {
    return createModelFamilyShimBeforePromptBuildHook({
      logger: {
        warn: (message) => warnings.push(message),
      },
    });
  }

  it("appends the OpenAI shim for canonical openai-codex refs", async () => {
    const workspaceDir = makeWorkspace({ openai: "OpenAI family shim" });
    workspaces.push(workspaceDir);

    const result = await createShimHook()(
      { prompt: "hello", messages: [] },
      createHookCtx({
        workspaceDir,
        provider: "openai-codex",
        model: "gpt-5.4-codex",
      }),
    );

    expect(result).toEqual({ appendSystemContext: "OpenAI family shim" });
    expect(warnings).toEqual([]);
  });

  it("appends the Anthropic shim for canonical openrouter/anthropic refs", async () => {
    const workspaceDir = makeWorkspace({ anthropic: "Anthropic family shim" });
    workspaces.push(workspaceDir);

    const result = await createShimHook()(
      { prompt: "hello", messages: [] },
      createHookCtx({
        workspaceDir,
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.6",
      }),
    );

    expect(result).toEqual({ appendSystemContext: "Anthropic family shim" });
    expect(warnings).toEqual([]);
  });

  it("returns no mutation for unsupported refs", async () => {
    const workspaceDir = makeWorkspace({
      openai: "OpenAI family shim",
      anthropic: "Anthropic family shim",
    });
    workspaces.push(workspaceDir);

    const result = await createShimHook()(
      { prompt: "hello", messages: [] },
      createHookCtx({
        workspaceDir,
        provider: "google-gemini-cli",
        model: "gemini-2.5-pro",
      }),
    );

    expect(result).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("warns and continues when a matched shim file is missing", async () => {
    const workspaceDir = makeWorkspace({ anthropic: "Anthropic family shim" });
    workspaces.push(workspaceDir);

    const result = await createShimHook()(
      { prompt: "hello", messages: [] },
      createHookCtx({
        workspaceDir,
        provider: "openai",
        model: "gpt-5.4",
      }),
    );

    expect(result).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("shims/model-openai.md");
    expect(warnings[0]).toContain("openai/gpt-5.4");
  });

  it("coexists deterministically with other prompt mutations by priority order", async () => {
    const workspaceDir = makeWorkspace({ openai: "OpenAI family shim" });
    workspaces.push(workspaceDir);

    addBeforePromptBuildHook(registry, {
      pluginId: "high-priority",
      priority: 20,
      handler: async () => ({
        systemPrompt: "Override system prompt",
        prependSystemContext: "Prepended system guidance",
      }),
    });
    addBeforePromptBuildHook(registry, {
      pluginId: "model-family-shims",
      priority: MODEL_FAMILY_SHIM_HOOK_PRIORITY,
      handler: createShimHook(),
    });
    addBeforePromptBuildHook(registry, {
      pluginId: "low-priority",
      priority: 1,
      handler: async () => ({
        appendSystemContext: "Trailing plugin guidance",
      }),
    });

    const runner = createHookRunner(registry);
    const result = await runner.runBeforePromptBuild(
      { prompt: "hello", messages: [] },
      createHookCtx({
        workspaceDir,
        provider: "openai",
        model: "gpt-5.4",
      }),
    );
    const finalSystemPrompt = composeSystemPromptWithHookContext({
      baseSystemPrompt: result?.systemPrompt,
      prependSystemContext: result?.prependSystemContext,
      appendSystemContext: result?.appendSystemContext,
    });

    expect(result?.systemPrompt).toBe("Override system prompt");
    expect(result?.prependSystemContext).toBe("Prepended system guidance");
    expect(result?.appendSystemContext).toBe("OpenAI family shim\n\nTrailing plugin guidance");
    expect(finalSystemPrompt).toBe(
      "Prepended system guidance\n\nOverride system prompt\n\nOpenAI family shim\n\nTrailing plugin guidance",
    );
  });

  it("stays idempotent across repeated prompt-build calls for the same attempt", async () => {
    const workspaceDir = makeWorkspace({ openai: "OpenAI family shim" });
    workspaces.push(workspaceDir);

    addBeforePromptBuildHook(registry, {
      pluginId: "model-family-shims",
      priority: MODEL_FAMILY_SHIM_HOOK_PRIORITY,
      handler: createShimHook(),
    });

    const runner = createHookRunner(registry);
    const ctx = createHookCtx({
      workspaceDir,
      provider: "openai",
      model: "gpt-5.4",
    });
    const first = await runner.runBeforePromptBuild({ prompt: "hello", messages: [] }, ctx);
    const second = await runner.runBeforePromptBuild({ prompt: "hello", messages: [] }, ctx);
    const firstPrompt = composeSystemPromptWithHookContext({
      baseSystemPrompt: "Base system prompt",
      appendSystemContext: first?.appendSystemContext,
    });
    const secondPrompt = composeSystemPromptWithHookContext({
      baseSystemPrompt: "Base system prompt",
      appendSystemContext: second?.appendSystemContext,
    });

    expect(first?.appendSystemContext).toBe("OpenAI family shim");
    expect(second?.appendSystemContext).toBe("OpenAI family shim");
    expect(firstPrompt).toBe("Base system prompt\n\nOpenAI family shim");
    expect(secondPrompt).toBe("Base system prompt\n\nOpenAI family shim");
    expect(countOccurrences(secondPrompt ?? "", "OpenAI family shim")).toBe(1);
  });

  it("reevaluates the shim family when a retry or fallback changes provider/model", async () => {
    const workspaceDir = makeWorkspace({
      openai: "OpenAI family shim",
      anthropic: "Anthropic family shim",
    });
    workspaces.push(workspaceDir);

    addBeforePromptBuildHook(registry, {
      pluginId: "model-family-shims",
      priority: MODEL_FAMILY_SHIM_HOOK_PRIORITY,
      handler: createShimHook(),
    });

    const runner = createHookRunner(registry);
    const openaiResult = await runner.runBeforePromptBuild(
      { prompt: "hello", messages: [] },
      createHookCtx({
        workspaceDir,
        provider: "openai",
        model: "gpt-5.4",
        runId: "run-shared",
      }),
    );
    const anthropicResult = await runner.runBeforePromptBuild(
      { prompt: "hello", messages: [] },
      createHookCtx({
        workspaceDir,
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.6",
        runId: "run-shared",
      }),
    );

    expect(openaiResult?.appendSystemContext).toBe("OpenAI family shim");
    expect(anthropicResult?.appendSystemContext).toBe("Anthropic family shim");
  });
});
