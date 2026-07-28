#!/usr/bin/env node
// Builds live gateway artifacts in isolation and activates only complete version trees.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");
const BUILD_STORE = ".openclaw-builds";
const SOURCE_EXCLUDES = [
  ".artifacts",
  ".git",
  ".openclaw-builds",
  ".pnpm-store",
  ".worktrees",
  "coverage",
  "dist",
  "node_modules",
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${String(result.status)}`);
  }
}

function replaceSymlink(linkPath, target) {
  const temporary = `${linkPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, temporary);
  fs.renameSync(temporary, linkPath);
}

function outputLinkTarget(relativeOutput) {
  const depth = relativeOutput.split("/").length - 1;
  return `${"../".repeat(depth)}${BUILD_STORE}/current/${relativeOutput}`;
}

export function listVersionOutputs(versionDir) {
  const outputs = ["dist", "dist-runtime"];
  const packagesDir = path.join(versionDir, "packages");
  if (fs.existsSync(packagesDir)) {
    for (const packageName of fs.readdirSync(packagesDir).toSorted()) {
      if (fs.existsSync(path.join(packagesDir, packageName, "dist"))) {
        outputs.push(`packages/${packageName}/dist`);
      }
    }
  }
  return outputs;
}

function linkVersionDependencies(rootDir, versionDir) {
  const sourceNodeModules = path.join(rootDir, "node_modules");
  const nodeModulesDir = path.join(versionDir, "node_modules");
  fs.mkdirSync(nodeModulesDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceNodeModules)) {
    if (entry === "@openclaw" || entry === "openclaw") {
      continue;
    }
    const target = path.join(nodeModulesDir, entry);
    if (!fs.existsSync(target)) {
      fs.symlinkSync(path.join(sourceNodeModules, entry), target);
    }
  }

  const sourceScope = path.join(sourceNodeModules, "@openclaw");
  const versionScope = path.join(nodeModulesDir, "@openclaw");
  fs.mkdirSync(versionScope, { recursive: true });
  if (fs.existsSync(sourceScope)) {
    for (const entry of fs.readdirSync(sourceScope)) {
      const target = path.join(versionScope, entry);
      if (!fs.existsSync(target)) {
        fs.symlinkSync(path.join(sourceScope, entry), target);
      }
    }
  }
}

export function pinVersionSelfReference(
  versionDir,
  rootDir = path.resolve(versionDir, "../../.."),
) {
  const packageManifest = path.join(versionDir, "openclaw-package.json");
  if (!fs.existsSync(packageManifest)) {
    throw new Error(`Immutable build version is missing its package manifest: ${versionDir}`);
  }
  linkVersionDependencies(rootDir, versionDir);
  const nodeModulesDir = path.join(versionDir, "node_modules");
  const selfRoot = path.join(nodeModulesDir, "openclaw");
  fs.mkdirSync(selfRoot, { recursive: true });
  fs.copyFileSync(packageManifest, path.join(selfRoot, "package.json"));
  for (const output of ["dist", "dist-runtime"]) {
    const target = path.join(selfRoot, output);
    if (!fs.existsSync(target)) {
      fs.symlinkSync(path.join("..", "..", output), target, "dir");
    }
  }
}

export function activateBuildVersion(params) {
  const rootDir = path.resolve(params.rootDir);
  const storeDir = path.join(rootDir, BUILD_STORE);
  const versionDir = path.resolve(params.versionDir);
  const relativeVersion = path.relative(storeDir, versionDir);
  if (
    relativeVersion.startsWith("..") ||
    path.isAbsolute(relativeVersion) ||
    !fs.existsSync(path.join(versionDir, "dist", "index.js"))
  ) {
    throw new Error(`Invalid live build version: ${versionDir}`);
  }
  pinVersionSelfReference(versionDir, rootDir);
  const outputs = listVersionOutputs(versionDir);
  for (const output of outputs) {
    if (!fs.existsSync(path.join(versionDir, output))) {
      throw new Error(`Incomplete live build output: ${output}`);
    }
  }

  const currentLink = path.join(storeDir, "current");
  const previousCurrent = fs.existsSync(currentLink) ? fs.readlinkSync(currentLink) : undefined;
  const backupDir = path.join(storeDir, "legacy", `${Date.now()}-${process.pid}`);
  const migrated = [];
  try {
    replaceSymlink(currentLink, relativeVersion);
    for (const output of outputs) {
      const outputPath = path.join(rootDir, output);
      let existing;
      try {
        existing = fs.lstatSync(outputPath);
      } catch {
        existing = undefined;
      }
      if (existing?.isSymbolicLink()) {
        continue;
      }
      if (existing) {
        const backupPath = path.join(backupDir, output);
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.renameSync(outputPath, backupPath);
        migrated.push({ outputPath, backupPath });
      }
      const temporary = `${outputPath}.tmp-${process.pid}`;
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.symlinkSync(outputLinkTarget(output), temporary);
      fs.renameSync(temporary, outputPath);
    }
  } catch (error) {
    for (const entry of migrated.toReversed()) {
      try {
        fs.rmSync(entry.outputPath, { force: true });
        fs.renameSync(entry.backupPath, entry.outputPath);
      } catch {
        // Preserve the original activation error; the backup remains recoverable.
      }
    }
    if (previousCurrent) {
      replaceSymlink(currentLink, previousCurrent);
    } else {
      fs.rmSync(currentLink, { force: true });
    }
    throw error;
  }
  return { outputs, backupDir: migrated.length > 0 ? backupDir : undefined };
}

function copyBuildInputs(rootDir, workspaceDir) {
  const args = ["-a", "--delete"];
  for (const excluded of SOURCE_EXCLUDES) {
    args.push(`--exclude=${excluded}`);
  }
  args.push(`${rootDir}/`, `${workspaceDir}/`);
  run("rsync", args);
  fs.symlinkSync(path.join(rootDir, "node_modules"), path.join(workspaceDir, "node_modules"));
  fs.writeFileSync(
    path.join(workspaceDir, ".git"),
    `gitdir: ${path.join(rootDir, ".git")}\n`,
    "utf8",
  );
}

function listCarryForwardVersions(rootDir, versionDir) {
  const versionsDir = path.join(rootDir, BUILD_STORE, "versions");
  const currentLink = path.join(rootDir, BUILD_STORE, "current");
  if (!fs.existsSync(currentLink)) {
    return [];
  }
  const currentVersion = fs.realpathSync(currentLink);
  const excludedVersion = fs.existsSync(versionDir) ? fs.realpathSync(versionDir) : versionDir;
  const versions = fs
    .readdirSync(versionsDir)
    .map((entry) => fs.realpathSync(path.join(versionsDir, entry)))
    .filter((entry) => entry !== excludedVersion && fs.statSync(entry).isDirectory())
    .toSorted();
  const currentIndex = versions.indexOf(currentVersion);
  if (currentIndex === -1) {
    return [];
  }
  return versions.slice(Math.max(0, currentIndex - 1), currentIndex + 1);
}

export function seedVersionOutputHistory(params) {
  const target = path.join(params.versionDir, params.output);
  fs.mkdirSync(target, { recursive: true });
  for (const version of listCarryForwardVersions(params.rootDir, params.versionDir)) {
    const source = path.join(version, params.output);
    if (fs.existsSync(source)) {
      run("rsync", ["-a", `${source}/`, `${target}/`]);
    }
  }
}

function collectVersionOutput(params) {
  seedVersionOutputHistory(params);
  run("rsync", [
    "-a",
    `${path.join(params.workspaceDir, params.output)}/`,
    `${path.join(params.versionDir, params.output)}/`,
  ]);
  fs.rmSync(path.join(params.workspaceDir, params.output), { recursive: true });
}

function collectVersionOutputs(rootDir, workspaceDir, versionDir) {
  fs.copyFileSync(
    path.join(workspaceDir, "package.json"),
    path.join(versionDir, "openclaw-package.json"),
  );
  pinVersionSelfReference(versionDir, rootDir);
  for (const output of ["dist", "dist-runtime"]) {
    const source = path.join(workspaceDir, output);
    if (!fs.existsSync(source)) {
      throw new Error(`Build completed without ${output}`);
    }
    collectVersionOutput({ rootDir, versionDir, workspaceDir, output });
  }
  const versionPackages = path.join(versionDir, "packages");
  const packageRoot = path.join(workspaceDir, "packages");
  const packageLinks = [];
  for (const packageName of fs.readdirSync(packageRoot).toSorted()) {
    const sourceRoot = path.join(packageRoot, packageName);
    const sourceDist = path.join(sourceRoot, "dist");
    if (!fs.existsSync(sourceDist)) {
      continue;
    }
    const targetRoot = path.join(versionPackages, packageName);
    fs.mkdirSync(targetRoot, { recursive: true });
    fs.renameSync(sourceDist, path.join(targetRoot, "dist"));
    const packageJsonPath = path.join(sourceRoot, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      fs.copyFileSync(packageJsonPath, path.join(targetRoot, "package.json"));
      const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      if (typeof manifest.name === "string" && manifest.name.startsWith("@openclaw/")) {
        packageLinks.push({ name: manifest.name.slice("@openclaw/".length), targetRoot });
      }
    }
  }
  const scopeDir = path.join(versionDir, "node_modules", "@openclaw");
  fs.mkdirSync(scopeDir, { recursive: true });
  for (const entry of packageLinks) {
    const linkPath = path.join(scopeDir, entry.name);
    fs.rmSync(linkPath, { force: true, recursive: true });
    fs.symlinkSync(path.relative(path.dirname(linkPath), entry.targetRoot), linkPath);
  }
}

function gatewayIsListening() {
  if (process.platform !== "darwin") {
    return false;
  }
  const result = spawnSync("/usr/sbin/lsof", ["-nP", "-iTCP:18789", "-sTCP:LISTEN", "-t"], {
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim().length > 0;
}

export function shouldUseLiveSafeBuild(params = {}) {
  const rootDir = path.resolve(params.rootDir ?? DEFAULT_ROOT);
  const env = params.env ?? process.env;
  if (env.OPENCLAW_LIVE_SAFE_BUILD === "0") {
    return false;
  }
  if (env.OPENCLAW_LIVE_SAFE_BUILD === "1") {
    return true;
  }
  try {
    if (fs.lstatSync(path.join(rootDir, "dist")).isSymbolicLink()) {
      return true;
    }
  } catch {
    // A checkout with no build output uses the ordinary build path.
  }
  return gatewayIsListening() && fs.existsSync(path.join(rootDir, "dist", "index.js"));
}

export function stageLiveBuild(params = {}) {
  const rootDir = path.resolve(params.rootDir ?? DEFAULT_ROOT);
  const storeDir = path.join(rootDir, BUILD_STORE);
  const versionsDir = path.join(storeDir, "versions");
  const buildId = `${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-${process.pid}`;
  const stagingDir = path.join(storeDir, `.staging-${buildId}`);
  const workspaceDir = path.join(stagingDir, "workspace");
  const versionDir = path.join(versionsDir, buildId);
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(versionsDir, { recursive: true });
  try {
    copyBuildInputs(rootDir, workspaceDir);
    run(process.execPath, ["scripts/build-all.mjs", ...(params.buildArgs ?? [])], {
      cwd: workspaceDir,
      env: {
        ...process.env,
        OPENCLAW_BUILD_ALL_NO_PNPM: "1",
        OPENCLAW_BUILD_CACHE: "0",
      },
    });
    fs.mkdirSync(versionDir, { recursive: true });
    collectVersionOutputs(rootDir, workspaceDir, versionDir);
    fs.writeFileSync(
      path.join(versionDir, "build.json"),
      `${JSON.stringify({ buildId, createdAt: Date.now() })}\n`,
      "utf8",
    );
  } catch (error) {
    fs.rmSync(versionDir, { force: true, recursive: true });
    throw error;
  } finally {
    fs.rmSync(stagingDir, { force: true, recursive: true });
  }

  const distPath = path.join(rootDir, "dist");
  const liveLayoutActive = fs.existsSync(distPath) && fs.lstatSync(distPath).isSymbolicLink();
  if (liveLayoutActive) {
    activateBuildVersion({ rootDir, versionDir });
    fs.rmSync(path.join(storeDir, "pending"), { force: true });
    return { buildId, versionDir, status: "activated" };
  }
  replaceSymlink(path.join(storeDir, "pending"), path.relative(storeDir, versionDir));
  return { buildId, versionDir, status: "pending-restart" };
}

function runOrdinaryBuild(args) {
  run(process.execPath, [path.join(SCRIPT_DIR, "build-all.mjs"), ...args], {
    cwd: DEFAULT_ROOT,
  });
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--activate-pending") {
    const pending = path.join(DEFAULT_ROOT, BUILD_STORE, "pending");
    if (!fs.existsSync(pending)) {
      throw new Error("No pending live build exists.");
    }
    const versionDir = fs.realpathSync(pending);
    const result = activateBuildVersion({ rootDir: DEFAULT_ROOT, versionDir });
    fs.rmSync(pending, { force: true });
    console.error(
      `[live-safe-build] activated ${path.basename(versionDir)} (${result.outputs.length} outputs)`,
    );
    return;
  }
  if (!shouldUseLiveSafeBuild()) {
    runOrdinaryBuild(args);
    return;
  }
  const result = stageLiveBuild({ buildArgs: args });
  console.error(`[live-safe-build] ${result.status}: ${result.buildId}`);
  if (result.status === "pending-restart") {
    console.error(
      "[live-safe-build] complete build staged; run openclaw-safe-restart.sh to migrate the live output links.",
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(`[live-safe-build] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
