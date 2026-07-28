import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateBuildVersion,
  listVersionOutputs,
  pinVersionSelfReference,
  seedVersionOutputHistory,
  shouldUseLiveSafeBuild,
} from "../../scripts/live-safe-build.mjs";

let roots: string[] = [];

function createRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-live-build-"));
  fs.mkdirSync(path.join(root, "extensions"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(root, "skills"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  roots.push(root);
  return root;
}

function writeFile(filePath: string, contents = "ok") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

afterEach(() => {
  for (const root of roots) {
    fs.rmSync(root, { force: true, recursive: true });
  }
  roots = [];
});

describe("live-safe build activation", () => {
  it("migrates served outputs to one versioned current pointer", () => {
    const root = createRoot();
    writeFile(path.join(root, "dist", "index.js"), "legacy");
    writeFile(path.join(root, "dist-runtime", "ready"), "legacy");
    writeFile(path.join(root, "packages", "ai", "dist", "index.js"), "legacy");
    const version = path.join(root, ".openclaw-builds", "versions", "v1");
    writeFile(path.join(version, "openclaw-package.json"), '{"name":"openclaw"}');
    writeFile(path.join(version, "dist", "index.js"), "v1");
    writeFile(path.join(version, "dist-runtime", "ready"), "v1");
    writeFile(path.join(version, "packages", "ai", "dist", "index.js"), "v1");

    const result = activateBuildVersion({ rootDir: root, versionDir: version });

    expect(result.outputs).toEqual(["dist", "dist-runtime", "packages/ai/dist"]);
    expect(fs.lstatSync(path.join(root, "dist")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(root, "dist", "index.js"), "utf8")).toBe("v1");
    expect(fs.readFileSync(path.join(root, "packages", "ai", "dist", "index.js"), "utf8")).toBe(
      "v1",
    );
    expect(
      result.backupDir && fs.readFileSync(path.join(result.backupDir, "dist", "index.js"), "utf8"),
    ).toBe("legacy");
  });

  it("switches current atomically while the old version remains intact", () => {
    const root = createRoot();
    const version1 = path.join(root, ".openclaw-builds", "versions", "v1");
    const version2 = path.join(root, ".openclaw-builds", "versions", "v2");
    for (const [version, contents] of [
      [version1, "v1"],
      [version2, "v2"],
    ] as const) {
      writeFile(path.join(version, "dist", "index.js"), contents);
      writeFile(path.join(version, "dist-runtime", "ready"), contents);
      writeFile(path.join(version, "openclaw-package.json"), '{"name":"openclaw"}');
    }
    activateBuildVersion({ rootDir: root, versionDir: version1 });
    const pinnedOldEntry = fs.realpathSync(path.join(root, "dist", "index.js"));

    activateBuildVersion({ rootDir: root, versionDir: version2 });

    expect(fs.readFileSync(path.join(root, "dist", "index.js"), "utf8")).toBe("v2");
    expect(fs.readFileSync(pinnedOldEntry, "utf8")).toBe("v1");
    expect(listVersionOutputs(version2)).toEqual(["dist", "dist-runtime"]);
  });

  it("pins bare openclaw self-references inside the immutable version", () => {
    const root = createRoot();
    const version = path.join(root, ".openclaw-builds", "versions", "v1");
    writeFile(
      path.join(version, "openclaw-package.json"),
      JSON.stringify({
        name: "openclaw",
        type: "module",
        exports: { "./plugin-sdk/test": "./dist/plugin-sdk/test.js" },
      }),
    );
    writeFile(path.join(version, "dist", "index.js"), "export {};");
    writeFile(path.join(version, "dist", "plugin-sdk", "test.js"), "export const pinned = true;");
    writeFile(path.join(version, "packages", "speech-core", "dist", "runtime.js"), "export {};");
    writeFile(path.join(root, "node_modules", "dependency", "index.js"), "module.exports = true;");
    pinVersionSelfReference(version, root);

    const requireFromVersion = createRequire(path.join(version, "dist", "index.js"));
    const requireFromPackage = createRequire(
      path.join(version, "packages", "speech-core", "dist", "runtime.js"),
    );

    expect(requireFromVersion.resolve("openclaw/plugin-sdk/test")).toBe(
      fs.realpathSync(path.join(version, "dist", "plugin-sdk", "test.js")),
    );
    expect(requireFromPackage.resolve("openclaw/plugin-sdk/test")).toBe(
      fs.realpathSync(path.join(version, "dist", "plugin-sdk", "test.js")),
    );
    expect(fs.existsSync(path.join(version, "package.json"))).toBe(false);
    expect(
      fs.realpathSync(path.join(version, "node_modules", "openclaw", "dist", "index.js")),
    ).toBe(fs.realpathSync(path.join(version, "dist", "index.js")));
    expect(fs.realpathSync(path.join(version, "node_modules", "dependency"))).toBe(
      fs.realpathSync(path.join(root, "node_modules", "dependency")),
    );
  });

  it("carries current and previous lazy chunks into the next version", () => {
    const root = createRoot();
    const versions = path.join(root, ".openclaw-builds", "versions");
    const previous = path.join(versions, "v1");
    const current = path.join(versions, "v2");
    const next = path.join(versions, "v3");
    writeFile(path.join(previous, "dist", "previous-only.js"), "previous");
    writeFile(path.join(previous, "dist", "shared.js"), "previous");
    writeFile(path.join(current, "dist", "current-only.js"), "current");
    writeFile(path.join(current, "dist", "shared.js"), "current");
    fs.symlinkSync("versions/v2", path.join(root, ".openclaw-builds", "current"));

    seedVersionOutputHistory({ rootDir: root, versionDir: next, output: "dist" });

    expect(fs.readFileSync(path.join(next, "dist", "previous-only.js"), "utf8")).toBe("previous");
    expect(fs.readFileSync(path.join(next, "dist", "current-only.js"), "utf8")).toBe("current");
    expect(fs.readFileSync(path.join(next, "dist", "shared.js"), "utf8")).toBe("current");
  });

  it("supports explicit safe-build enable and disable overrides", () => {
    const root = createRoot();
    expect(shouldUseLiveSafeBuild({ rootDir: root, env: { OPENCLAW_LIVE_SAFE_BUILD: "1" } })).toBe(
      true,
    );
    expect(shouldUseLiveSafeBuild({ rootDir: root, env: { OPENCLAW_LIVE_SAFE_BUILD: "0" } })).toBe(
      false,
    );
  });
});
