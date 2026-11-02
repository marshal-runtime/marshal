import { execFileSync } from "node:child_process";

import { createLogger } from "../common/marshal-logger";
import { sanitizeForTelemetry } from "./marshal-value-sanitization";

const log = createLogger("FixPath");

// Cap log lines so a pathological PATH (some dev machines push ~kB) doesn't
// flood diagnostic logs. 2000 chars is plenty to debug "is brew/nvm in there?"
// without being abusive.
const MAX_PATH_LOG_LEN = 2000;
const SHELL_TIMEOUT_MS = 3000;

// Idempotency guard — `applyShellPathFix()` mutates `process.env.PATH`. A
// stray second call (HMR re-import in dev, or a future caller) would
// double-prepend. Module state is fine here because main.ts loads exactly
// once per Electron process.
let applied = false;

function truncate(s: string | undefined): string {
  if (!s) return "<empty>";
  return s.length > MAX_PATH_LOG_LEN ? `${s.slice(0, MAX_PATH_LOG_LEN)}…` : s;
}

// Strip ANSI CSI sequences (\x1b[...) and OSC sequences (\x1b]...\x07 or
// \x1b]...\x1b\\). zsh under iTerm emits OSC-1337 codes inline with command
// output; without stripping, those would land in process.env.PATH.
// eslint-disable-next-line no-control-regex
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g;
function stripAnsiAndOsc(s: string): string {
  return s.replace(ANSI_OSC_RE, "");
}

/**
 * Resolve the user's login shell PATH by spawning `$SHELL -ilc 'echo "$PATH"'`
 * and parsing the result. Returns null on any failure.
 *
 * `-i` (interactive) and `-l` (login) make the shell source ~/.zshrc /
 * ~/.bash_profile / fish config etc., which is where users add brew/nvm/etc.
 *
 * Quoting `$PATH` matters for fish: bare `echo $PATH` prints the list as
 * space-separated tokens, but `echo "$PATH"` flattens to the same colon-
 * delimited form bash/zsh use. POSIX shells treat the two forms identically
 * for this scalar variable.
 *
 * Output normalization & validation:
 *   - Strip ANSI/OSC escape sequences (zsh on iTerm emits `\x1b]1337;...`
 *     OSC codes inline with command output).
 *   - Take the LAST non-empty line — banner output from oh-my-zsh, nvm,
 *     starship, MOTDs, etc. lands on earlier lines.
 *   - Require a colon — anything that doesn't look like a colon-delimited
 *     PATH (e.g., a degenerate single-dir or shell error message) is
 *     rejected. We degrade to "no shell PATH applied" — same as pre-fix
 *     state, never a corrupted PATH that breaks every subsequent spawn.
 */
function resolveShellPath(): string | null {
  const shell = process.env.SHELL;
  if (!shell) return null;
  try {
    const out = execFileSync(shell, ["-ilc", 'echo "$PATH"'], {
      timeout: SHELL_TIMEOUT_MS,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = out
      .split("\n")
      .map(stripAnsiAndOsc)
      .map((s) => s.trim())
      .filter(Boolean);
    const candidate = lines[lines.length - 1] ?? "";
    return candidate.includes(":") ? candidate : null;
  } catch (err) {
    log.warn(
      `resolveShellPath: ${sanitizeForTelemetry(shell)} failed: ${sanitizeForTelemetry(String(err))}`,
    );
    return null;
  }
}

/**
 * Resolve the user's login-shell PATH and prepend it to process.env.PATH.
 *
 * GUI-launched Electron apps on macOS and Linux do NOT inherit shell PATH —
 * they get a minimal `/usr/bin:/bin:/usr/sbin:/sbin`. That breaks any MCP
 * server configured with bare commands like `npx`, `agency`, `uvx`.
 *
 * Call this ONCE at app startup, before spawning any child process.
 * Safe on all platforms: no-op on Windows, no-op under E2E.
 *
 * Errors are logged and swallowed — failure regresses to current behavior,
 * never crashes the app.
 *
 * Inline implementation (no `fix-path` dependency) to avoid CJS/ESM
 * bundling complications with rolldown.
 */
export function applyShellPathFix(): void {
  if (applied) return;
  applied = true;

  if (process.platform === "win32") {
    return;
  }
  if (process.env.MARSHAL_E2E === "1") {
    log.info("applyShellPathFix: skipped (MARSHAL_E2E=1)");
    return;
  }

  const before = process.env.PATH;
  log.info(`applyShellPathFix: PATH before=${sanitizeForTelemetry(truncate(before))}`);

  const shellPath = resolveShellPath();
  if (!shellPath) {
    log.warn("applyShellPathFix: could not resolve shell PATH, continuing with bare PATH");
    return;
  }

  process.env.PATH = before ? `${shellPath}:${before}` : shellPath;

  const after = process.env.PATH;
  log.info(`applyShellPathFix: PATH after=${sanitizeForTelemetry(truncate(after))}`);
}
