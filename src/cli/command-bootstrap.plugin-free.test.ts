// Behavioral bootstrap coverage for plugin-free CLI command preflight.
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setChannelPluginModuleLoaderFactoryForTest } from "../channels/plugins/module-loader.js";
import {
  resetAutoMigrateLegacyStateDirForTest,
  resetAutoMigrateLegacyStateForTest,
  resetAutoMigrateLegacyTaskStateSidecarsForTest,
} from "../infra/state-migrations.js";
import {
  clearPluginDoctorContractRegistryCache,
  setPluginDoctorContractRegistryModuleLoaderFactoryForTest,
} from "../plugins/doctor-contract-registry.js";
import type { PluginModuleLoaderFactory } from "../plugins/plugin-module-loader-cache.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { ensureCliCommandBootstrap } from "./command-bootstrap.js";
import { testApi as configGuardTestApi } from "./program/config-guard.js";

describe("plugin-free command bootstrap", () => {
  let testState: OpenClawTestState | undefined;
  const sourceTransformLoader = vi.fn(() => ({}));
  const createSourceTransformLoader = vi.fn(() => sourceTransformLoader);

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      label: "cli-plugin-free",
      scenario: "minimal",
    });
    await testState.writeConfig({
      channels: {
        signal: {
          enabled: false,
        },
      },
      plugins: {
        entries: {
          signal: {
            enabled: true,
          },
        },
      },
    });
    configGuardTestApi.resetConfigGuardStateForTests();
    resetAutoMigrateLegacyStateForTest();
    resetAutoMigrateLegacyStateDirForTest();
    resetAutoMigrateLegacyTaskStateSidecarsForTest();
    clearPluginDoctorContractRegistryCache();
    sourceTransformLoader.mockClear();
    createSourceTransformLoader.mockClear();
    const factory = createSourceTransformLoader as unknown as PluginModuleLoaderFactory;
    setChannelPluginModuleLoaderFactoryForTest(factory);
    setPluginDoctorContractRegistryModuleLoaderFactoryForTest(factory);
  });

  afterEach(async () => {
    setChannelPluginModuleLoaderFactoryForTest(undefined);
    setPluginDoctorContractRegistryModuleLoaderFactoryForTest(undefined);
    clearPluginDoctorContractRegistryCache();
    configGuardTestApi.resetConfigGuardStateForTests();
    resetAutoMigrateLegacyStateForTest();
    resetAutoMigrateLegacyStateDirForTest();
    resetAutoMigrateLegacyTaskStateSidecarsForTest();
    await testState?.cleanup();
    testState = undefined;
  });

  async function writeInvalidSourceChannelConfig() {
    await testState?.writeConfig({
      gateway: {
        port: "invalid",
      },
      channels: {
        signal: {
          enabled: false,
        },
      },
      plugins: {
        entries: {
          signal: {
            enabled: true,
          },
        },
      },
    });
  }

  it("does not create a source-transform loader for gateway call", async () => {
    await writeInvalidSourceChannelConfig();
    const runtime = {
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`unexpected config-guard exit ${code}`);
      }),
    };

    await ensureCliCommandBootstrap({
      runtime: runtime as never,
      commandPath: ["gateway", "call"],
      loadPlugins: false,
    });

    expect(sourceTransformLoader).not.toHaveBeenCalled();
    expect(createSourceTransformLoader).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("keeps invalid-config snapshots plugin-free for health", async () => {
    await writeInvalidSourceChannelConfig();
    const runtime = {
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`unexpected config-guard exit ${code}`);
      }),
    };

    await ensureCliCommandBootstrap({
      runtime: runtime as never,
      commandPath: ["health"],
      loadPlugins: false,
    });

    expect(sourceTransformLoader).not.toHaveBeenCalled();
    expect(createSourceTransformLoader).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("defers opaque channel session migration without loading its runtime", async () => {
    const legacySessionKey = "15551234567@g.us";
    await testState?.writeJson("sessions/sessions.json", {
      [legacySessionKey]: {
        sessionId: "legacy-channel-session",
        updatedAt: 1,
      },
    });
    const runtime = {
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`unexpected config-guard exit ${code}`);
      }),
    };

    await ensureCliCommandBootstrap({
      runtime: runtime as never,
      commandPath: ["gateway", "call"],
      loadPlugins: false,
    });

    const preservedStore = JSON.parse(
      await fs.readFile(testState!.statePath("sessions", "sessions.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(preservedStore).toHaveProperty(legacySessionKey);
    await expect(
      fs.stat(testState!.statePath("agents", "main", "sessions", "sessions.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(createSourceTransformLoader).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});
