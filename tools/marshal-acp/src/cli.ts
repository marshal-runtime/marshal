#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";
import { z } from "zod";

import { ensureBase, loadConfig, writeDefaultConfigIfMissing } from "./config.ts";
import { sessionFilePath, sessionsDir } from "./paths.ts";
import { isToolUseAllowed } from "./permission-policy.ts";
import {
  appendTurnToFile,
  buildSessionFilename,
  listSessions,
  readSession,
  writeSession,
} from "./persistence.ts";
import { spawnConfigFor } from "./runtimes/index.ts";
import { runSlot } from "./slot.ts";
import {
  AgentRuntimeSchema,
  MarshalAcpConfigSchema,
  PermissionProfileSchema,
  type AgentRuntime,
  type MarshalAcpConfig,
  type PermissionProfileName,
  type SessionRecord,
} from "./types.ts";

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
    // Best-effort.
  }
  return "0.0.0";
}

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

type PromptOpts = {
  runtime?: AgentRuntime;
  profile?: PermissionProfileName;
  cwd?: string;
  resume?: string;
};

async function runOneTurn(
  cfg: MarshalAcpConfig,
  title: string,
  promptText: string,
  opts: PromptOpts,
  startedAtOverride?: string,
): Promise<{ filePath: string; sessionId: string }> {
  const runtime = opts.runtime ?? cfg.defaultRuntime;
  const profile = opts.profile ?? cfg.defaultPermissionProfile;
  const cwd = opts.cwd ?? process.cwd();
  // --detach passes the parent-computed startedAt so parent and subprocess
  // agree on the filename (which is derived from startedAt + title).
  const startedAt = startedAtOverride ?? new Date().toISOString();

  if (!opts.resume) {
    const result = await runSlot({
      spawn: spawnConfigFor(runtime, { cwd }),
      prompt: promptText,
      isAllowed: (rq) => isToolUseAllowed(rq, { profile }),
      onUpdate: () => {},
      maxLifetimeMs: cfg.maxLifetimeMs,
    });
    const completedAt = new Date().toISOString();
    const rec: SessionRecord = {
      title,
      sessionId: result.sessionId ?? "",
      runtime,
      cwd,
      permissionProfile: profile,
      startedAt,
      completedAt,
      turns: [
        {
          at: startedAt,
          promptText,
          responseText: result.body || "_(empty)_",
          ...(result.stopReason ? { stopReason: result.stopReason } : {}),
          ...(result.usageOutputTokens !== undefined
            ? { usageOutputTokens: result.usageOutputTokens }
            : {}),
        },
      ],
    };
    const filePath = await writeSession(rec);
    return { filePath, sessionId: rec.sessionId };
  }

  // Resume reuses the saved session's runtime/cwd/profile — those are
  // baked into the ACP session id on Claude's side.
  const existing = await readSession(opts.resume);
  const result = await runSlot({
    spawn: spawnConfigFor(existing.runtime, { cwd: existing.cwd }),
    prompt: promptText,
    resumeSessionId: existing.sessionId,
    resumePrompt: promptText,
    isAllowed: (rq) => isToolUseAllowed(rq, { profile: existing.permissionProfile }),
    onUpdate: () => {},
    maxLifetimeMs: cfg.maxLifetimeMs,
  });
  const at = new Date().toISOString();
  const filePath = await appendTurnToFile(opts.resume, {
    at,
    promptText,
    responseText: result.body || "_(empty)_",
    ...(result.stopReason ? { stopReason: result.stopReason } : {}),
    ...(result.usageOutputTokens !== undefined
      ? { usageOutputTokens: result.usageOutputTokens }
      : {}),
  });
  return { filePath, sessionId: existing.sessionId };
}

function printSessionInfo(opts: { title: string; sessionId: string; filePath: string }): void {
  const basename = path.basename(opts.filePath);
  process.stdout.write(`session: ${opts.sessionId}\n`);
  process.stdout.write(`file:    ${opts.filePath}\n`);
  process.stdout.write(
    `resume:  marshal-acp prompt --resume ${basename} "${opts.title}" "<follow-up text>"\n`,
  );
  process.stdout.write(`open:    marshal-acp open ${basename}\n`);
}

async function cmdPrompt(
  title: string,
  promptText: string,
  rawOpts: { runtime?: string; profile?: string; cwd?: string; resume?: string; detach?: boolean },
): Promise<number> {
  await ensureBase();
  await writeDefaultConfigIfMissing();
  const cfg = await loadConfig();
  const opts: PromptOpts = {
    cwd: rawOpts.cwd,
    resume: rawOpts.resume,
  };
  if (rawOpts.runtime) {
    const parsed = AgentRuntimeSchema.safeParse(rawOpts.runtime);
    if (!parsed.success) {
      throw new Error(`invalid --runtime '${rawOpts.runtime}' (expected claude or copilot)`);
    }
    opts.runtime = parsed.data;
  }
  if (rawOpts.profile) {
    const parsed = PermissionProfileSchema.safeParse(rawOpts.profile);
    if (!parsed.success) {
      throw new Error(`invalid --profile '${rawOpts.profile}' (expected review or default)`);
    }
    opts.profile = parsed.data;
  }

  if (rawOpts.detach) {
    const startedAt = new Date().toISOString();
    // For resume the file already exists (we append to it); for fresh
    // sessions we compute the new filename from startedAt + title.
    const filePath = opts.resume
      ? sessionFilePath(opts.resume)
      : path.join(sessionsDir(), buildSessionFilename(startedAt, "", title));
    const logPath = `${filePath}.log`;

    // stderr redirected to a .log file so a crashed subprocess leaves a
    // trace `marshal-acp wait` can surface. Parent dups the fd and immediately
    // closes its handle; child keeps the dup.
    const logFd = openSync(logPath, "w");
    const cliEntry = process.argv[1] ?? "";
    const payload = JSON.stringify({ title, promptText, opts, cfg, startedAt });
    const child = spawn(process.execPath, [cliEntry, "__internal-detached-prompt", payload], {
      detached: true,
      stdio: ["ignore", "ignore", logFd],
      windowsHide: true,
    });
    child.unref();
    closeSync(logFd);

    // sessionId for resume is already in the existing file; for fresh
    // sessions we poll for the subprocess's first markdown write (~1-5s).
    let sessionId = "[pending]";
    if (opts.resume) {
      try {
        const existing = await fs.readFile(filePath, "utf8");
        const match = /^sessionId:\s+(.+)$/m.exec(existing);
        if (match && match[1]) sessionId = match[1].trim();
      } catch {
        // Resume target missing — surface as [pending] and let the user
        // see the eventual subprocess error in the .log file.
      }
    } else {
      for (let i = 0; i < 50; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 100));
        try {
          // eslint-disable-next-line no-await-in-loop
          const existing = await fs.readFile(filePath, "utf8");
          const match = /^sessionId:\s+(.+)$/m.exec(existing);
          if (match && match[1]) {
            sessionId = match[1].trim();
            break;
          }
        } catch {
          // Not written yet — keep polling.
        }
      }
    }
    printSessionInfo({ title, sessionId, filePath });
    return 0;
  }

  const { filePath, sessionId } = await runOneTurn(cfg, title, promptText, opts);
  printSessionInfo({ title, sessionId: sessionId || "[unknown]", filePath });
  return 0;
}

/** Internal: the body of `marshal-acp prompt --detach` after the parent forks.
 *  Runs the full session in the subprocess. Argv: the JSON-encoded args. */
const DetachedPayloadSchema = z.object({
  title: z.string(),
  promptText: z.string(),
  opts: z.object({
    runtime: AgentRuntimeSchema.optional(),
    profile: PermissionProfileSchema.optional(),
    cwd: z.string().optional(),
    resume: z.string().optional(),
  }),
  cfg: MarshalAcpConfigSchema,
  startedAt: z.string(),
});

async function runDetachedPrompt(payload: string): Promise<number> {
  const p = DetachedPayloadSchema.parse(JSON.parse(payload));
  await ensureBase();

  // Marker file at <session-file>.running lets `marshal-acp wait` and
  // `marshal-acp status` detect liveness. For resume we mark the EXISTING
  // session file's path (bug fix: parent used to print a freshly-
  // computed filename that was never written).
  const filePath = p.opts.resume
    ? sessionFilePath(p.opts.resume)
    : path.join(sessionsDir(), buildSessionFilename(p.startedAt, "", p.title));
  const markerPath = `${filePath}.running`;
  await fs.writeFile(
    markerPath,
    JSON.stringify({ pid: process.pid, startedAt: p.startedAt }),
    "utf8",
  );

  try {
    await runOneTurn(p.cfg, p.title, p.promptText, p.opts, p.startedAt);
    return 0;
  } finally {
    await fs.unlink(markerPath).catch(() => {});
  }
}

async function cmdResume(file: string): Promise<number> {
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

  const rec = await readSession(file);
  const launcher = path.resolve(rec.cwd, "skills/marshal-review-dashboard/scripts/launch-review.sh");
  // launch-review.sh expects a PR number positional; synthesize an id so the
  // launcher's tab naming still works for ad-hoc marshal-acp sessions.
  const tabId = `acp-${rec.sessionId.slice(0, 8)}`;
  const proc = spawn(
    "bash",
    [launcher, tabId, "--resume-session", rec.sessionId, "--runtime", rec.runtime],
    { stdio: "inherit", env: { ...process.env, MARSHAL_REPO: rec.cwd } },
  );
  return await new Promise<number>((resolve) => {
    proc.on("exit", (code) => resolve(code ?? 1));
  });
}

async function cmdList(): Promise<number> {
  const names = await listSessions();
  if (names.length === 0) {
    process.stdout.write("(no sessions yet)\n");
    return 0;
  }
  for (const name of names) process.stdout.write(`${name}\n`);
  return 0;
}

async function cmdShow(file: string): Promise<number> {
  try {
    const text = await fs.readFile(sessionFilePath(file), "utf8");
    process.stdout.write(text);
    return 0;
  } catch {
    process.stderr.write(`no session file: ${file}\n`);
    return 1;
  }
}

/** True if `pid` names a live process. `process.kill(pid, 0)` doesn't
 *  actually signal; it just probes existence. EPERM means the process is
 *  alive but in another security context — treat as alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err) {
      if (err.code === "EPERM") return true;
      return false;
    }
    return false;
  }
}

function formatElapsed(isoStart: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - new Date(isoStart).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m${seconds % 60}s`;
  return `${Math.floor(mins / 60)}h${mins % 60}m`;
}

const MarkerSchema = z.object({ pid: z.number().int().positive(), startedAt: z.string() });

async function cmdStatus(): Promise<number> {
  const dir = sessionsDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      process.stdout.write("(no sessions)\n");
      return 0;
    }
    throw err;
  }

  type Marker = { name: string; pid: number; startedAt: string; alive: boolean };
  const markers: Marker[] = [];
  const completed: string[] = [];
  for (const entry of entries) {
    if (entry.endsWith(".running")) {
      const base = entry.slice(0, -".running".length);
      try {
        // eslint-disable-next-line no-await-in-loop
        const raw = await fs.readFile(path.join(dir, entry), "utf8");
        const m = MarkerSchema.parse(JSON.parse(raw));
        markers.push({ name: base, ...m, alive: isAlive(m.pid) });
      } catch {
        // malformed marker — skip
      }
    } else if (entry.endsWith(".md")) {
      completed.push(entry);
    }
  }

  if (markers.length === 0 && completed.length === 0) {
    process.stdout.write("(no sessions)\n");
    return 0;
  }
  const runningNames = new Set(markers.map((m) => m.name));
  for (const m of markers) {
    const elapsed = formatElapsed(m.startedAt);
    if (m.alive) {
      process.stdout.write(`⏳ ${m.name} — running ${elapsed} (PID ${m.pid})\n`);
    } else {
      process.stdout.write(`❌ ${m.name} — crashed (PID ${m.pid} no longer alive)\n`);
    }
  }
  const recent = completed
    .filter((c) => !runningNames.has(c))
    .sort()
    .reverse()
    .slice(0, 10);
  for (const c of recent) {
    process.stdout.write(`✅ ${c}\n`);
  }
  return 0;
}

async function cmdWait(
  file: string,
  rawOpts: { timeout?: string; pollInterval?: string },
): Promise<number> {
  const timeoutMs = Number(rawOpts.timeout ?? "900") * 1000;
  const pollMs = Number(rawOpts.pollInterval ?? "3") * 1000;
  const target = sessionFilePath(file);
  const markerPath = `${target}.running`;
  const logPath = `${target}.log`;
  const start = Date.now();
  const graceMs = 5000;
  let sawMarker = false;

  while (Date.now() - start < timeoutMs) {
    let markerExists = false;
    try {
      // eslint-disable-next-line no-await-in-loop
      await fs.access(markerPath);
      markerExists = true;
      sawMarker = true;
    } catch {
      // marker absent
    }

    if (markerExists) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }

    // Marker not present. If we never saw it AND we're still within the
    // grace window, the parent might just not have written the marker yet —
    // wait briefly before declaring crash.
    if (!sawMarker && Date.now() - start < graceMs) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }

    // Marker gone → check completion.
    try {
      // eslint-disable-next-line no-await-in-loop
      const text = await fs.readFile(target, "utf8");
      if (/^completedAt:/m.test(text)) {
        process.stdout.write(text);
        return 0;
      }
    } catch {
      // file missing — fall through to crash branch
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const log = await fs.readFile(logPath, "utf8");
      process.stderr.write(`Session crashed. Log:\n${log}\n`);
    } catch {
      process.stderr.write("Session crashed with no output.\n");
    }
    return 2;
  }

  process.stderr.write(`Timed out after ${rawOpts.timeout ?? "900"}s\n`);
  return 1;
}

async function cmdInit(): Promise<number> {
  await ensureBase();
  const wrote = await writeDefaultConfigIfMissing();
  process.stdout.write(
    wrote
      ? `marshal-acp: wrote default config to ${path.join(sessionsDir(), "..", "config.json")}\n`
      : `marshal-acp: config already exists; leaving it alone\n`,
  );
  return 0;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("marshal-acp")
    .description(
      "Ad-hoc Claude/Copilot agent sessions over ACP. Persists each session to a markdown file under ~/.marshal-acp/sessions/.",
    )
    .version(readVersion(), "-V, --version", "print the Marshal version");

  const run = (action: () => Promise<number>): void => {
    void (async () => {
      try {
        const code = await action();
        process.exit(code);
      } catch (err: unknown) {
        process.stderr.write(`marshal-acp: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(2);
      }
    })();
  };

  program
    .command("init")
    .description("Create ~/.marshal-acp/ and a default config.json. Idempotent.")
    .action(() => run(cmdInit));

  program
    .command("prompt <title> <prompt-text>")
    .description("Run a one-shot ACP session and persist the result as markdown.")
    .option("--runtime <claude|copilot>", "Override the configured default runtime.")
    .option(
      "--profile <review|default>",
      "Permission profile. `review` blocks PR writes (review-queue's shape); `default` (the marshal-acp default) has no policy denies — the runtime's permission prompts are the filter.",
    )
    .option("--cwd <dir>", "Working directory for the spawned agent. Defaults to the current dir.")
    .option(
      "--resume <session-file>",
      "Programmatic follow-up: append a new turn to an existing session via ACP `session/load`. To open the session interactively instead, use `marshal-acp open <file>`.",
    )
    .option(
      "--detach",
      "Non-blocking. Spawn the session in a detached subprocess and return immediately. Output sessionId + file path + resume/open commands once available (~1s). The markdown file fills in as the agent runs; check with `marshal-acp show <file>`.",
    )
    .addHelpText(
      "after",
      `
The session file lands at ~/.marshal-acp/sessions/<ISO>-<slug>.md where <slug>
is derived from <title>. Title is required so files are human-scannable
in 'marshal-acp list'.`,
    )
    .action(
      (
        title: string,
        promptText: string,
        opts: {
          runtime?: string;
          profile?: string;
          cwd?: string;
          resume?: string;
          detach?: boolean;
        },
      ) => run(() => cmdPrompt(title, promptText, opts)),
    );

  program
    .command("open <session-file>")
    .description(
      "Open a saved session in a Zellij tab for manual interaction (uses launch-review.sh). For programmatic follow-up use `marshal-acp prompt --resume`.",
    )
    .action((file: string) => run(() => cmdResume(file)));

  program
    .command("list")
    .description("List session files in newest-first order.")
    .action(() => run(cmdList));

  program
    .command("show <session-file>")
    .description("Print a session file's markdown.")
    .action((file: string) => run(() => cmdShow(file)));

  program
    .command("status")
    .description("Print in-flight + recent sessions (uses `.running` marker files).")
    .action(() => run(cmdStatus));

  program
    .command("wait <session-file>")
    .description(
      "Block until a session completes. Prints the full markdown on success (exit 0), the crash log on failure (exit 2), or times out (exit 1). Intended for async-shell integration where the caller wants a single command to wait on.",
    )
    .option("--timeout <seconds>", "Max wait time. Default 900 (15min).", "900")
    .option("--poll-interval <seconds>", "Marker poll cadence. Default 3.", "3")
    .action((file: string, opts: { timeout?: string; pollInterval?: string }) =>
      run(() => cmdWait(file, opts)),
    );

  return program;
}

async function main(): Promise<void> {
  // Internal entry used by --detach: parent forks `node cli.ts
  // __internal-detached-prompt <json>`; this branch runs the detached body
  // without going through commander.
  if (process.argv[2] === "__internal-detached-prompt") {
    try {
      const code = await runDetachedPrompt(process.argv[3] ?? "");
      process.exit(code);
    } catch (err: unknown) {
      process.stderr.write(`marshal-acp: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    }
    return;
  }
  try {
    const program = buildProgram();
    await program.parseAsync(process.argv);
  } catch (err: unknown) {
    process.stderr.write(`marshal-acp: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}

if (process.argv[1] && (process.argv[1].endsWith("cli.ts") || process.argv[1].endsWith("cli.js"))) {
  void main();
}

export { buildSessionFilename };
