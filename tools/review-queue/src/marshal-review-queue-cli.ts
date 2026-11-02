#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { httpRequest } from "./marshal-review-http-client.ts";
import { socketPath, statusPath, reviewFilePath, daemonLogPath } from "./marshal-review-paths.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readVersion(): string {
  try {
    const pkg: unknown = JSON.parse(
      readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8"),
    );
    if (
      typeof pkg === "object" &&
      pkg !== null &&
      "version" in pkg &&
      typeof pkg.version === "string"
    ) {
      return pkg.version;
    }
  } catch {
    // Best-effort — fall through to the placeholder.
  }
  return "0.0.0";
}

async function probeAlive(): Promise<boolean> {
  try {
    const r = await httpRequest({ socketPath: socketPath(), method: "GET", path: "/status" });
    return r.status === 200;
  } catch {
    return false;
  }
}

/** True when `cmd` resolves on `$PATH`. Tries `cmd --version` and relies on the
 *  spawn `error` event (ENOENT) vs `close` event (any exit code = it ran) to
 *  decide — cheap and cross-platform without parsing `where` / `which`. */
async function isOnPath(cmd: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const probe = spawn(cmd, ["--version"], { stdio: "ignore", windowsHide: true });
    probe.on("error", () => resolve(false));
    probe.on("close", () => resolve(true));
  });
}

function zellijInstallHint(): string {
  if (process.platform === "win32") return "Install with: scoop install zellij";
  if (process.platform === "darwin") return "Install with: brew install zellij";
  return "Install from https://zellij.dev/documentation/installation";
}

async function ensureDaemon(): Promise<void> {
  if (await probeAlive()) return;
  const daemonEntry = path.resolve(__dirname, "daemon.ts");
  const child = spawn(process.execPath, [daemonEntry], {
    detached: true,
    stdio: "ignore",
    env: process.env,
    windowsHide: true,
  });
  child.unref();

  const start = Date.now();
  while (Date.now() - start < 5000) {
    // Sequential by design — we're polling for daemon-alive, parallelizing
    // would just hammer the socket.
    // oxlint-disable-next-line no-await-in-loop
    if (await probeAlive()) return;
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("daemon failed to come online within 5s; check daemon.log");
}

/** Claude stores sessions at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
 *  where the encoding replaces each of `:`, `/`, `\` with `-`. Exported for tests. */
export function claudeSessionPath(cwd: string, sessionId: string): string {
  const encoded = cwd.replace(/[:/\\]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", encoded, `${sessionId}.jsonl`);
}

type ResumableIter = {
  sessionId: string;
  agentRuntime: string;
  cwd?: string;
  sha?: string;
};

/** Walk iterations newest → oldest and return the first one whose on-disk
 *  session can actually be resumed. For Claude, that means the JSONL exists
 *  at `claudeSessionPath`. For other runtimes (copilot today) we can't
 *  validate without more work, so any sessionId-bearing iteration is
 *  accepted. `existsFn` is injected for testability.
 *
 *  Returns the iteration plus its index, or null if nothing is resumable.
 *  Callers use `index < iterations.length - 1` to know whether they fell
 *  back from the latest. */
export async function findResumableIteration(
  iterations: ResumableIter[],
  fallbackCwd: string | undefined,
  existsFn: (p: string) => Promise<boolean> = async (p) => {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  },
): Promise<{ iter: ResumableIter; index: number } | null> {
  for (let i = iterations.length - 1; i >= 0; i--) {
    const it = iterations[i];
    if (!it?.sessionId) continue;
    if (it.agentRuntime !== "claude") {
      return { iter: it, index: i };
    }
    const cwd = it.cwd ?? fallbackCwd;
    if (!cwd) continue;
    // Sequential by design — we want the latest valid iteration and
    // short-circuit on first hit; Promise.all would do unnecessary work.
    // oxlint-disable-next-line no-await-in-loop
    if (await existsFn(claudeSessionPath(cwd, it.sessionId))) {
      return { iter: it, index: i };
    }
  }
  return null;
}

/** Parse a positional PR argument. Throws with a friendly message that
 *  commander surfaces verbatim to the user. */
function parsePr(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`expected a positive integer PR number, got '${raw}'`);
  }
  return n;
}

// ───────────────────────────────────────────────────────────────────────────
// Command actions — each returns an exit code; the top-level wrapper exits.
// ───────────────────────────────────────────────────────────────────────────

async function cmdEnsure(): Promise<number> {
  await ensureDaemon();
  process.stdout.write("marshal-review-queue: daemon up\n");
  return 0;
}

async function cmdTick(): Promise<number> {
  await ensureDaemon();
  const r = await httpRequest({ socketPath: socketPath(), method: "POST", path: "/tick" });
  if (r.status !== 200) return 1;
  // ranTick=false means a prior tick is still running. Persistent coalescing
  // usually points at a hung dashboard child — surface it so the user doesn't
  // have to grep daemon.log to notice.
  try {
    const parsed: unknown = JSON.parse(r.body);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "ranTick" in parsed &&
      parsed.ranTick === false
    ) {
      process.stderr.write(
        "marshal-review-queue: tick coalesced — another tick is in flight. If this persists, check `marshal-review-queue logs`.\n",
      );
    }
  } catch {
    // Non-JSON 200 body — accept.
  }
  return 0;
}

async function cmdStatus(): Promise<number> {
  try {
    const md = await fs.readFile(statusPath(), "utf8");
    process.stdout.write(md);
  } catch {
    process.stdout.write(
      "# marshal-review-queue status\n\n_no state yet — run `marshal-review-queue ensure` first._\n",
    );
  }
  return 0;
}

async function cmdShow(pr: number): Promise<number> {
  try {
    const md = await fs.readFile(reviewFilePath(pr), "utf8");
    process.stdout.write(md);
    return 0;
  } catch {
    process.stderr.write(`no review for PR #${pr}\n`);
    return 1;
  }
}

async function cmdResume(pr: number): Promise<number> {
  await ensureDaemon();
  const r = await httpRequest({ socketPath: socketPath(), method: "GET", path: "/status" });
  const state = JSON.parse(r.body);
  const row = state.prs?.[String(pr)];
  if (!row?.iterations?.length) {
    process.stderr.write(`no session id for PR #${pr}\n`);
    return 1;
  }
  const fallbackCwd = state.config?.repos?.default?.cwd;
  const found = await findResumableIteration(row.iterations, fallbackCwd);
  if (!found) {
    process.stderr.write(
      `no resumable session for PR #${pr} (no iteration has a sessionId with a matching on-disk session).\n`,
    );
    return 1;
  }
  if (found.index < row.iterations.length - 1) {
    const skipped = row.iterations.length - 1 - found.index;
    process.stderr.write(
      `marshal-review-queue: latest ${skipped > 1 ? skipped + " iterations have" : "iteration has"} no on-disk session; resuming iteration #${found.index + 1} (sha ${found.iter.sha ? found.iter.sha.slice(0, 8) : "?"}).\n`,
    );
  }
  // Pre-flight: bail before forking bash so the user sees a CLI-level
  // error with install hint instead of bash spawn ENOENT or the launcher's
  // mid-script error.
  const [hasBash, hasZellij] = await Promise.all([isOnPath("bash"), isOnPath("zellij")]);
  if (!hasBash) {
    process.stderr.write(
      process.platform === "win32"
        ? "bash not found on PATH. Install Git for Windows (https://git-scm.com/download/win) and re-open the shell.\n"
        : "bash not found on PATH.\n",
    );
    return 1;
  }
  if (!hasZellij) {
    process.stderr.write(`zellij not found on PATH. ${zellijInstallHint()}\n`);
    return 1;
  }
  // Prefer the iteration's recorded cwd; fall back to config for legacy rows.
  const repoCwd = found.iter.cwd ?? fallbackCwd ?? process.cwd();
  const launcher = path.resolve(repoCwd, "skills/marshal-review-dashboard/scripts/launch-review.sh");
  const proc = spawn(
    "bash",
    [
      launcher,
      String(pr),
      "--resume-session",
      found.iter.sessionId,
      "--runtime",
      found.iter.agentRuntime,
    ],
    { stdio: "inherit", env: { ...process.env, MARSHAL_REPO: repoCwd } },
  );
  return await new Promise<number>((resolve) => {
    proc.on("exit", (code) => resolve(code ?? 1));
  });
}

async function cmdRoute(routeName: string, pr: number): Promise<number> {
  await ensureDaemon();
  const r = await httpRequest({
    socketPath: socketPath(),
    method: "POST",
    path: `/${routeName}`,
    body: { pr },
  });
  if (r.status !== 200) {
    // Routes that operate on a specific PR return 4xx with `{ error: "..." }`
    // for known per-pr conditions (unknown pr, no prior session, missing pr
    // arg). Unwrap the message instead of dumping JSON at the user.
    let msg = r.body;
    try {
      const parsed: unknown = JSON.parse(r.body);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "error" in parsed &&
        typeof parsed.error === "string"
      ) {
        msg = parsed.error;
      }
    } catch {
      // Non-JSON body — fall through and print verbatim.
    }
    process.stderr.write(msg + "\n");
  }
  return r.status === 200 ? 0 : 1;
}

async function cmdStop(): Promise<number> {
  if (!(await probeAlive())) {
    process.stdout.write("daemon not running\n");
    return 0;
  }
  await httpRequest({ socketPath: socketPath(), method: "POST", path: "/shutdown" });
  return 0;
}

async function cmdLogs(follow: boolean): Promise<number> {
  if (follow) {
    // `tail` isn't a built-in on Windows — Git Bash / MSYS2 ships one, and so
    // does WSL, but a fresh corporate dev box without git installed will
    // ENOENT here. Preflight + hint instead of letting spawn fail.
    if (!(await isOnPath("tail"))) {
      process.stderr.write(
        process.platform === "win32"
          ? "tail not found on PATH. Install Git for Windows (https://git-scm.com/download/win) or use PowerShell:\n  Get-Content -Wait " +
              daemonLogPath() +
              "\n"
          : "tail not found on PATH.\n",
      );
      return 1;
    }
    const tail = spawn("tail", ["-f", daemonLogPath()], {
      stdio: "inherit",
      windowsHide: true,
    });
    return await new Promise<number>((resolve) => tail.on("exit", (code) => resolve(code ?? 1)));
  }
  try {
    const log = await fs.readFile(daemonLogPath(), "utf8");
    process.stdout.write(log);
  } catch {
    // Empty / missing log file is not an error — nothing has happened yet.
  }
  return 0;
}

// ───────────────────────────────────────────────────────────────────────────
// Program definition. Wraps each action in a thin shim that exits with the
// code the action returned, so commander's flow stays "fire-and-forget."
// ───────────────────────────────────────────────────────────────────────────

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("marshal-review-queue")
    .description(
      "Background PR review queue — runs Claude/Copilot reviews via ACP and persists per-PR markdown.",
    )
    .version(readVersion(), "-V, --version", "print the Marshal version");

  const run = (action: () => Promise<number>): void => {
    void (async () => {
      try {
        const code = await action();
        process.exit(code);
      } catch (err: unknown) {
        process.stderr.write(`marshal-review-queue: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(2);
      }
    })();
  };

  program
    .command("ensure")
    .description("Spawn the daemon if not running. Idempotent.")
    .action(() => run(cmdEnsure));

  program
    .command("tick")
    .description(
      "Run one pass: read dashboard → diff state → fill slots → cancel stale → verify retention.",
    )
    .action(() => run(cmdTick));

  program
    .command("status")
    .description("Print the human-readable status snapshot.")
    .action(() => run(cmdStatus));

  program
    .command("show <pr>")
    .description("Print the review markdown for a PR.")
    .action((pr: string) => run(() => cmdShow(parsePr(pr))));

  program
    .command("resume <pr>")
    .description(
      "Open a Zellij tab on the PR's last session via launch-review.sh --resume-session.",
    )
    .action((pr: string) => run(() => cmdResume(parsePr(pr))));

  program
    .command("confirm <pr>")
    .description(
      "Mark as confirmed (you posted manually). Queue stops touching the row at this SHA.",
    )
    .action((pr: string) => run(() => cmdRoute("confirm", parsePr(pr))));

  program
    .command("dismiss <pr>")
    .description("Mark as dismissed. Sticky across SHA changes until explicit requeue.")
    .action((pr: string) => run(() => cmdRoute("dismiss", parsePr(pr))));

  program
    .command("requeue <pr>")
    .description("Force re-review at current head SHA, bypassing cooldown.")
    .action((pr: string) => run(() => cmdRoute("requeue", parsePr(pr))));

  program
    .command("cancel <pr>")
    .description("Cancel a running or queued review.")
    .action((pr: string) => run(() => cmdRoute("cancel", parsePr(pr))));

  program
    .command("keep-context <pr>")
    .description(
      "Resume the prior ACP session on the next iteration of this PR (session/load instead of session/new). One-shot.",
    )
    .addHelpText(
      "after",
      `
Use after running 'resume' and having a meaningful chat with the agent.
The flag is cleared the next time the queue spawns a slot for this PR
— it does not stick across iterations. Requires at least one prior
iteration to exist (so there's a sessionId to resume).`,
    )
    .action((pr: string) => run(() => cmdRoute("keep-context", parsePr(pr))));

  program
    .command("stop")
    .description("Drain in-flight reviews (mark crashed) and shut down.")
    .action(() => run(cmdStop));

  program
    .command("logs")
    .description("Print the daemon log.")
    .option("--follow", "Tail the log instead of printing once.")
    .action((opts: { follow?: boolean }) => run(() => cmdLogs(opts.follow === true)));

  return program;
}

async function main(): Promise<void> {
  // Each action calls process.exit() via run(). parseAsync resolves either
  // way; if it throws (commander internal error), surface it generically.
  try {
    const program = buildProgram();
    await program.parseAsync(process.argv);
  } catch (err: unknown) {
    process.stderr.write(
      `marshal-review-queue: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }
}

if (process.argv[1] && (process.argv[1].endsWith("cli.ts") || process.argv[1].endsWith("cli.js"))) {
  void main();
}
