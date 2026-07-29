// Hooks CLI process tests cover plugin-owned handles that outlive command output.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildNativeHookRelayCommand } from "../agents/harness/native-hook-relay.js";

const tempDirs: string[] = [];
const activeChildren = new Set<ChildProcessWithoutNullStreams>();

afterEach(async () => {
  await Promise.all(Array.from(activeChildren, terminateChild));
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGKILL");
  await once(child, "close");
}

async function createLingeringPluginFixture(): Promise<{
  configPath: string;
  markerPath: string;
  stateDir: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hooks-cli-"));
  tempDirs.push(root);
  const stateDir = path.join(root, "state");
  const pluginDir = path.join(root, "linger-plugin");
  const markerPath = path.join(root, "registered");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: "linger-plugin",
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.js"] },
    }),
  );
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "linger",
      name: "Linger",
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    [
      'import fs from "node:fs";',
      "export default {",
      '  id: "linger",',
      '  name: "Linger",',
      "  register() {",
      '    fs.writeFileSync(process.env.LINGER_MARKER, "registered\\n");',
      "    setInterval(() => {}, 60_000);",
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      plugins: {
        load: { paths: [pluginDir] },
        entries: { linger: { enabled: true } },
      },
    }),
  );
  return { configPath, markerPath, stateDir };
}

async function createTimeoutOwnershipFixture(): Promise<{
  nodeWrapperPath: string;
  pidLogPath: string;
  preloadPath: string;
  readyMarkerPath: string;
  stateDir: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hooks-timeout-owner-"));
  tempDirs.push(root);
  const nodeWrapperPath = path.join(root, "node-with-tsx");
  const pidLogPath = path.join(root, "pids");
  const preloadPath = path.join(root, "track-relay-pid.mjs");
  const readyMarkerPath = path.join(root, "ready");
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    preloadPath,
    [
      'import fs from "node:fs";',
      "fs.appendFileSync(process.env.RELAY_PID_LOG, `${process.pid}\\n`);",
      "const originalAsyncIterator = process.stdin[Symbol.asyncIterator].bind(process.stdin);",
      "process.stdin[Symbol.asyncIterator] = function () {",
      "  fs.writeFileSync(process.env.RELAY_READY_MARKER, `${process.pid}\\n`);",
      "  return originalAsyncIterator();",
      "};",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    nodeWrapperPath,
    ["#!/bin/sh", 'exec "$OPENCLAW_TEST_NODE" --import tsx "$@"', ""].join("\n"),
  );
  await fs.chmod(nodeWrapperPath, 0o755);
  return { nodeWrapperPath, pidLogPath, preloadPath, readyMarkerPath, stateDir };
}

async function readPidFile(filePath: string): Promise<number[]> {
  try {
    return (await fs.readFile(filePath, "utf8"))
      .split(/\s+/u)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isSafeInteger(value) && value > 0);
  } catch {
    return [];
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runHooksList(fixture: Awaited<ReturnType<typeof createLingeringPluginFixture>>) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/entry.ts", "hooks", "list", "--json"],
    {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        LINGER_MARKER: fixture.markerPath,
        OPENCLAW_CONFIG_PATH: fixture.configPath,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_STATE_DIR: fixture.stateDir,
        NODE_ENV: undefined,
        VITEST: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
    stdout: string;
  }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("hooks list did not exit after emitting output"));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr, stdout });
    });
  });
}

describe("hooks CLI process lifecycle", () => {
  it.runIf(process.platform !== "win32")(
    "keeps the relay on the timeout-owned shell PID",
    async () => {
      const fixture = await createTimeoutOwnershipFixture();
      const command = buildNativeHookRelayCommand({
        provider: "codex",
        relayId: "timeout-owner",
        event: "post_tool_use",
        executable: path.resolve("src/entry.ts"),
        nodeExecutable: fixture.nodeWrapperPath,
        timeoutMs: 60_000,
      });
      const child = spawn("/bin/sh", ["-lc", command], {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          NODE_ENV: undefined,
          VITEST: undefined,
          NODE_OPTIONS: `--import=${pathToFileURL(fixture.preloadPath).href}`,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_STATE_DIR: fixture.stateDir,
          OPENCLAW_TEST_NODE: process.execPath,
          RELAY_PID_LOG: fixture.pidLogPath,
          RELAY_READY_MARKER: fixture.readyMarkerPath,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      activeChildren.add(child);
      child.once("close", () => activeChildren.delete(child));
      const timeoutOwnedPid = child.pid;
      if (!timeoutOwnedPid) {
        throw new Error("Expected native hook relay shell PID");
      }

      try {
        await expect
          .poll(async () => (await readPidFile(fixture.readyMarkerPath))[0], {
            interval: 100,
            timeout: 45_000,
          })
          .toBe(timeoutOwnedPid);
        expect(new Set(await readPidFile(fixture.pidLogPath))).toEqual(new Set([timeoutOwnedPid]));

        const closed = once(child, "close");
        expect(child.kill("SIGKILL")).toBe(true);
        await closed;
        await expect
          .poll(() => isProcessAlive(timeoutOwnedPid), { interval: 50, timeout: 5_000 })
          .toBe(false);
        await expect
          .poll(
            async () =>
              (await readPidFile(fixture.pidLogPath)).filter((pid) => isProcessAlive(pid)),
            { interval: 50, timeout: 5_000 },
          )
          .toEqual([]);
      } finally {
        await terminateChild(child);
        for (const pid of await readPidFile(fixture.pidLogPath)) {
          if (pid !== timeoutOwnedPid && isProcessAlive(pid)) {
            process.kill(pid, "SIGKILL");
          }
        }
      }
    },
    60_000,
  );

  it("exits after JSON output when plugin registration leaves a ref'd handle", async () => {
    const fixture = await createLingeringPluginFixture();

    const result = await runHooksList(fixture);

    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(result.stderr).not.toContain("Error:");
    expect(JSON.parse(result.stdout)).toMatchObject({ hooks: expect.any(Array) });
    await expect(fs.readFile(fixture.markerPath, "utf8")).resolves.toBe("registered\n");
  }, 20_000);
});
