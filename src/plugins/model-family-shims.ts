import fs from "node:fs";
import path from "node:path";
import { openBoundaryFile } from "../infra/boundary-file-read.js";
import type { PluginHookHandlerMap, PluginLogger } from "./types.js";

export const MODEL_FAMILY_SHIM_PLUGIN_ID = "model-family-shims";
export const MODEL_FAMILY_SHIM_HOOK_PRIORITY = 10;

const MAX_MODEL_FAMILY_SHIM_BYTES = 64 * 1024;

const MODEL_FAMILY_SHIM_FILES = {
  openai: "shims/model-openai.md",
  anthropic: "shims/model-anthropic.md",
} as const;

type SupportedModelFamily = keyof typeof MODEL_FAMILY_SHIM_FILES;

type ModelFamilyShimMatch = {
  family: SupportedModelFamily;
  relativePath: (typeof MODEL_FAMILY_SHIM_FILES)[SupportedModelFamily];
};

type ModelFamilyShimReadResult =
  | { status: "loaded"; content: string }
  | { status: "empty" }
  | { status: "error"; detail: string };

export function buildResolvedModelFamilyRef(params: {
  provider?: string;
  model?: string;
}): string | undefined {
  const provider = params.provider?.trim();
  const model = params.model?.trim();
  if (!provider || !model) {
    return undefined;
  }
  return `${provider}/${model}`;
}

export function matchModelFamilyShim(resolvedRef?: string): ModelFamilyShimMatch | undefined {
  const normalized = resolvedRef?.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.startsWith("openai/") || normalized.startsWith("openai-codex/")) {
    return {
      family: "openai",
      relativePath: MODEL_FAMILY_SHIM_FILES.openai,
    };
  }
  if (normalized.startsWith("anthropic/") || normalized.startsWith("openrouter/anthropic/")) {
    return {
      family: "anthropic",
      relativePath: MODEL_FAMILY_SHIM_FILES.anthropic,
    };
  }
  return undefined;
}

async function readModelFamilyShimFile(params: {
  workspaceDir: string;
  relativePath: ModelFamilyShimMatch["relativePath"];
}): Promise<ModelFamilyShimReadResult> {
  const workspaceDir = path.resolve(params.workspaceDir);
  const absolutePath = path.join(workspaceDir, params.relativePath);
  const opened = await openBoundaryFile({
    absolutePath,
    rootPath: workspaceDir,
    boundaryLabel: "workspace root",
    maxBytes: MAX_MODEL_FAMILY_SHIM_BYTES,
  });
  if (!opened.ok) {
    return {
      status: "error",
      detail: String(opened.reason),
    };
  }

  try {
    const content = fs.readFileSync(opened.fd, "utf-8").trim();
    if (!content) {
      return { status: "empty" };
    }
    return { status: "loaded", content };
  } catch (error) {
    return {
      status: "error",
      detail: String(error),
    };
  } finally {
    fs.closeSync(opened.fd);
  }
}

export function createModelFamilyShimBeforePromptBuildHook(params: {
  logger?: Pick<PluginLogger, "warn">;
}): PluginHookHandlerMap["before_prompt_build"] {
  return async (_event, ctx) => {
    const resolvedRef = buildResolvedModelFamilyRef({
      provider: ctx.provider,
      model: ctx.model,
    });
    const match = matchModelFamilyShim(resolvedRef);
    const workspaceDir = ctx.workspaceDir?.trim();
    if (!match || !workspaceDir) {
      return undefined;
    }

    const shim = await readModelFamilyShimFile({
      workspaceDir,
      relativePath: match.relativePath,
    });
    if (shim.status === "loaded") {
      return {
        appendSystemContext: shim.content,
      };
    }
    if (shim.status === "error") {
      params.logger?.warn(
        `[model-family-shims] unable to load ${match.relativePath} for ${resolvedRef} ` +
          `(runId=${ctx.runId ?? "unknown"}): ${shim.detail}`,
      );
    }
    return undefined;
  };
}
