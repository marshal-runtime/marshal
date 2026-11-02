import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Mirrors scripts/runtime-acceptance/run.mjs's pnpm resolution so this
// facility's scripts behave the same on Windows (corepack shim) and
// macOS/Linux, without importing from scripts/ (ignored by oxlint and not
// this facility's to depend on).
export function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function resolveInvocation(command, args) {
  if (process.platform !== "win32" || command.toLowerCase() !== "pnpm.cmd") {
    return { command, args };
  }
  const corepackEntrypoint = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "corepack",
    "dist",
    "pnpm.js",
  );
  const entrypoint =
    process.env.npm_execpath ?? (fs.existsSync(corepackEntrypoint) ? corepackEntrypoint : null);
  if (!entrypoint) throw new Error("Unable to resolve the pnpm entrypoint on Windows.");
  return { command: process.execPath, args: [entrypoint, ...args] };
}

/** Runs `pnpm <args>` in `cwd`, returning {status, stdout, stderr}. Never throws on a non-zero exit — callers decide pass/fail/blocked. */
export function runPnpm(args, cwd) {
  const invocation = resolveInvocation(pnpmCommand(), args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function tail(text, lines = 40) {
  return text.split(/\r?\n/).slice(-lines).join("\n");
}
