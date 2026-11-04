#!/usr/bin/env node
/**
 * Compile TS, bundle stdio runtime using esbuild, and update BUILD_MANIFEST.json.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

function run(cmd, args, cwd = ROOT) {
  console.log(`[build-bundle] Running: ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (res.status !== 0) {
    console.error(`[build-bundle] Command failed with exit code ${res.status}`);
    process.exit(res.status ?? 1);
  }
}

// 1. Compile TS
const tscBin = resolve(ROOT, "node_modules", "typescript", "bin", "tsc");
if (existsSync(tscBin)) {
  run(process.execPath, [tscBin, "-b"]);
} else {
  run("npx", ["tsc", "-b"]);
}

// 2. Bundle with esbuild
const esbuildBin = resolve(ROOT, "node_modules", "esbuild", "bin", "esbuild");
const entryPoint = resolve(ROOT, "apps", "stdio-runtime", "dist", "src", "agent-host-main.js");
const outFile = resolve(ROOT, "release", "stdio-runtime.bundle.mjs");

const esbuildArgs = [
  entryPoint,
  "--bundle",
  "--platform=node",
  "--format=esm",
  `--outfile=${outFile}`,
  "--log-level=warning",
];

if (existsSync(esbuildBin)) {
  run(process.execPath, [esbuildBin, ...esbuildArgs]);
} else {
  run("npx", ["esbuild", ...esbuildArgs]);
}

// 3. Build release manifest
const pythonBin = process.env.PYTHON || "python";
const manifestScript = resolve(ROOT, "scripts", "build_release_manifest.py");
run(pythonBin, [manifestScript]);

// 4. Verify release manifest
const manifestJson = resolve(ROOT, "release", "BUILD_MANIFEST.json");
run(pythonBin, [manifestScript, "--verify", manifestJson]);

console.log("[build-bundle] Successfully built runtime bundle and updated manifest.");
