/**
 * The Codex app-server executes model shell calls through the user's login
 * shell (argv like `["/bin/zsh", "-lc", "git status"]`) and renders approval
 * `command` strings by shlex-joining that argv. Forwarding the wrapped string
 * into the shared permission policy defeats persistence: the leading shell
 * path generalises to `*`, guardrails null the pattern via
 * G_FIRST_TOKEN_MISMATCH, and only the exact wrapped literal survives — so
 * "Allow for session" never matches the next equivalent invocation and every
 * command re-prompts. Unwrapping restores the inner command so the
 * established policy semantics (segment-wise compound checks, deny binaries,
 * dynamic-expansion gating, exact fallback) apply to what actually runs.
 *
 * Unwrapping is strictly shape-matched and fails closed: anything ambiguous
 * (unknown shell, extra positional args, multiple payload arguments, malformed
 * quoting) is left untouched, which preserves today's behavior.
 *
 * Shell identity trust policy: only the wrapper identities the app-server
 * itself launches are accepted — a bare basename (`bash`, PATH-resolved, the
 * same trust posture as every stored policy pattern like `git status`) or an
 * exact system path under /bin | /usr/bin. An arbitrary path that merely ends
 * in a trusted basename (`/tmp/zsh`) is a different program; granting policy
 * on its "inner text" would misattribute what actually runs, so it stays
 * wrapped and is judged by the policy as the literal command it is.
 */

const WRAPPER_SHELL_BASENAMES = new Set(["zsh", "bash", "sh", "dash", "ksh"]);
const WRAPPER_SHELL_PATHS = new Set(
  [...WRAPPER_SHELL_BASENAMES].flatMap((shell) => [`/bin/${shell}`, `/usr/bin/${shell}`]),
);
// Short clusters may combine only login/interactive/command flags; anything
// else (e.g. -x, -e, -o) changes execution semantics and stays wrapped.
const SHORT_FLAG_RE = /^-[cil]+$/;
const DOUBLE_QUOTE_ESCAPABLE = new Set(['"', "\\", "$", "`"]);

function isWrapperShell(token: string): boolean {
  if (token.includes("/")) return WRAPPER_SHELL_PATHS.has(token);
  return WRAPPER_SHELL_BASENAMES.has(token);
}

/** Valid when every flag is `--login` or a short l/i/c cluster and the set
 *  carries exactly one `c` (the "run this command string" switch). */
function isCommandFlagList(flags: readonly string[]): boolean {
  if (flags.length === 0) return false;
  let commandFlagCount = 0;
  for (const flag of flags) {
    if (flag === "--login") continue;
    if (!SHORT_FLAG_RE.test(flag)) return false;
    commandFlagCount += flag.split("c").length - 1;
  }
  return commandFlagCount === 1;
}

/**
 * Argv form (legacy execCommandApproval): unwrap `[shell, flags..., command]`.
 * Returns null when the argv is not exactly a login-shell command wrapper.
 */
export function unwrapLoginShellArgv(argv: readonly string[]): string | null {
  if (argv.length < 3) return null;
  if (!isWrapperShell(argv[0])) return null;
  if (!isCommandFlagList(argv.slice(1, -1))) return null;
  const command = argv[argv.length - 1];
  if (!command.trim() || command.startsWith("-")) return null;
  return command;
}

/**
 * Rendered-string form: unwrap `/bin/zsh -lc 'git status'` (or the rust-shlex
 * double-quoted rendering `/bin/zsh -lc "git status"`). Returns the original
 * string when the shape does not match.
 */
export function unwrapLoginShellCommandText(command: string): string {
  const text = command.trim();
  const tokenRe = /\S+/g;
  const first = tokenRe.exec(text);
  if (!first || !isWrapperShell(first[0])) return command;

  const flags: string[] = [];
  let payloadStart = -1;
  for (;;) {
    const match = tokenRe.exec(text);
    if (!match) return command;
    if (match[0].startsWith("-")) {
      flags.push(match[0]);
      continue;
    }
    payloadStart = match.index;
    break;
  }
  if (!isCommandFlagList(flags)) return command;

  const inner = decodeShlexArgument(text.slice(payloadStart));
  return inner !== null && inner.trim() ? inner : command;
}

/** Decode the payload as exactly ONE shell word. Multiple words would mean
 *  extra argv entries (positional $0 args) — ambiguous, so bail with null. */
function decodeShlexArgument(payload: string): string | null {
  if (payload.startsWith('"')) return decodeDoubleQuoted(payload);
  if (payload.includes("'") || payload.includes("\\")) return decodeSingleQuoted(payload);
  if (payload.includes('"') || /\s/.test(payload)) return null;
  return payload;
}

/** Rust-shlex rendering: one double-quoted unit spanning the whole payload,
 *  with backslash escapes limited to `\` `"` `$` and backtick. Rust shlex
 *  ALWAYS escapes `$` and backtick inside double quotes — an unescaped one
 *  means the string is not a shlex-rendered argv but live shell expansion,
 *  whose value is policy-opaque; such payloads stay wrapped. */
function decodeDoubleQuoted(payload: string): string | null {
  if (payload.length < 2 || !payload.endsWith('"')) return null;
  const body = payload.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"') return null; // closing quote mid-payload = multiple words
    if (ch === "$" || ch === "`") return null; // unescaped expansion = not shlex output
    if (ch === "\\") {
      const next = body[i + 1];
      if (next === undefined || !DOUBLE_QUOTE_ESCAPABLE.has(next)) return null;
      out += next;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

/** POSIX-shlex rendering: concatenated single-quoted spans plus `\'` escapes
 *  (`'don'\''t'`), nothing else. */
function decodeSingleQuoted(payload: string): string | null {
  let out = "";
  let i = 0;
  while (i < payload.length) {
    const ch = payload[i];
    if (ch === "'") {
      const end = payload.indexOf("'", i + 1);
      if (end === -1) return null;
      out += payload.slice(i + 1, end);
      i = end + 1;
    } else if (ch === "\\" && payload[i + 1] === "'") {
      out += "'";
      i += 2;
    } else {
      return null;
    }
  }
  return out;
}
