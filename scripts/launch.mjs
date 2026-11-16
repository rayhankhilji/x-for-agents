#!/usr/bin/env node
// Self-bootstrapping launcher used by .mcp.json in this repo: works in a fresh cloud
// container (installs deps + builds on first run) and on a laptop. All setup output goes
// to stderr so stdout stays a clean MCP channel.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: ["ignore", 2, 2], shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
if (!fs.existsSync(path.join(root, "node_modules/playwright"))) run(npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);

const newest = (dir) =>
  fs.existsSync(dir) ? Math.max(0, ...fs.readdirSync(dir, { recursive: true }).map((f) => fs.statSync(path.join(dir, String(f))).mtimeMs)) : 0;
if (newest(path.join(root, "src")) > newest(path.join(root, "dist"))) run(npm, ["run", "--silent", "build"]);

process.env.CLAUDE_PROJECT_DIR ??= process.cwd();
await import(path.join(root, "dist/index.js"));
