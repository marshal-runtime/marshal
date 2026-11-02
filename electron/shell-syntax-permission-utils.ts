// Owned by the shell-syntax permission utilities.

// Shared shell-syntax regexes. Keeps permission-patterns.ts and
// permission-pattern-guardrails.ts in sync — drift between them would cause
// G_COMPOUND to allow broadening for commands that the pattern matcher
// rejects (or vice versa).

/** Matches shell operators that split compound commands: `||`, `&&`, `|`, `;`, `&`, `>`, `>>`. */
export const SHELL_OPERATOR_RE = /\s*(?:\|\||&&|[|;&>])\s*/;

/** Matches subshell / heredoc / process-substitution syntax. */
export const SUBSHELL_RE = /`|\$\(|<\(|>\(|<</;

/** Matches a leading PowerShell-style `$var = ` assignment so the downstream
 *  check (readonly gate / pattern extraction) operates on the RHS command. */
export const VAR_ASSIGN_PREFIX_RE = /^\$\w+\s*=\s*/;

/** Host shell flavor. Used by the parser/readonly check to interpret
 *  shell-specific syntax (backtick-escape, scriptblocks, control flow) without
 *  forking codepaths. */
export type ShellMode = "powershell" | "bash";

/** Detect the host shell. Matches what the Copilot SDK does internally
 *  (`process.platform === "win32" ? powerShell : bash`) — the SDK spawns the
 *  same shell, so deriving from `process.platform` keeps our policy aligned
 *  with what's actually executed. Future: plumb from SDK shellConfig once we
 *  pass one. */
export function getShellMode(): ShellMode {
  return process.platform === "win32" ? "powershell" : "bash";
}

/**
 * Strip a matching pair of outer quotes (`"..."` or `'...'`) from a token.
 * Shell quotes are pure metasyntax — the program never sees them — so
 * `foo`, `"foo"`, and `'foo'` are the same value at runtime. The matcher
 * compares semantic values, not lexical forms.
 *
 * Tokens with mismatched or absent outer quotes pass through unchanged.
 * Internal quotes are left alone — only the outer pair is stripped.
 */
export function stripOuterQuotes(token: string): string {
  if (token.length < 2) return token;
  const first = token[0];
  const last = token[token.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    return token.slice(1, -1);
  }
  return token;
}

/**
 * In PowerShell, `` `<char> `` is the escape syntax — backtick followed by
 * any char means "literal <char>". So `` `$expand ``, `'$expand'`, and (in
 * a non-expanding context) `$expand` all denote the same literal value
 * `$expand` at runtime. The matcher needs to see them as equal.
 *
 * IMPORTANT: This must only be applied in PowerShell mode. In bash, the
 * backtick is command substitution — stripping it would defeat the
 * upstream `hasUnsafeSyntax` gate that catches `cat \`whoami\``. The
 * helper itself is shell-mode-agnostic; the caller (normalizeTokenForMatching)
 * gates it.
 *
 * A trailing backtick with no following char is preserved as a literal
 * backtick — it can't escape anything.
 */
export function stripPowerShellBacktickEscapes(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "`" && i + 1 < s.length) {
      if (s[i + 1] === "u" && i + 2 < s.length && s[i + 2] === "{") {
        const close = s.indexOf("}", i + 3);
        const hex = close !== -1 ? s.slice(i + 3, close) : "";
        const cp = parseInt(hex, 16);
        // surrogates (0xD800–0xDFFF) pass through as lone surrogates — can't produce \\ or //, harmless for UNC detection
        if (/^[0-9a-fA-F]{1,6}$/.test(hex) && cp <= 0x10ffff) {
          out += String.fromCodePoint(cp);
          i = close;
          continue;
        }
      }
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

/**
 * Normalize a token for matching by stripping shell-quote/escape syntax
 * that doesn't change the runtime value. Both pattern and command tokens
 * are normalized through this before comparison so that semantically-
 * equivalent forms match:
 *
 *  - `"x"`, `'x'`, and `x` all match each other (quote stripping)
 *  - `'$expand'` matches `` `$expand `` in PowerShell mode (both denote `$expand`)
 *
 * Bash backticks are deliberately NOT stripped — they're command
 * substitution and are caught upstream by `isUnsafeShellSyntax`. The
 * backtick-strip is gated on `shellMode === "powershell"` where backtick
 * means escape, not command substitution.
 */
export function normalizeTokenForMatching(token: string, shellMode: ShellMode): string {
  const stripped = stripOuterQuotes(token);
  return shellMode === "powershell" ? stripPowerShellBacktickEscapes(stripped) : stripped;
}

/** Tight pure-literal check: `"..."` or `'...'` with no internal occurrence
 *  of the same quote (escape-respecting). Used by the PowerShell readonly
 *  path so a string-only segment (`else { "x" }` → segment `"x"`) doesn't
 *  fail the cmdlet check — a bare string in a scriptblock is just a value,
 *  no side effects.
 *
 *  Escape semantics by quote type (matches PowerShell + bash, the two shells
 *  we model):
 *  - `"..."` (double-quoted): backtick-escaped `` `" `` (PowerShell) and
 *    backslash-escaped `\"` (bash) both count as escaped.
 *  - `'...'` (single-quoted): PowerShell escapes via doubling (`''`), bash
 *    treats `'` literally with no in-string escape at all. We accept the `''`
 *    doubling — pairs of inner single quotes count as one literal quote each
 *    and don't end the string. The pairing must be strictly internal: if the
 *    second quote of an `''` pair IS the closing quote of the segment, the
 *    literal is malformed (unterminated) and we reject.
 *
 *  Exported for direct unit testing — security-sensitive helper. */
export function isPureQuotedLiteral(segment: string): boolean {
  const s = segment.trim();
  if (s.length < 2) return false;
  const q = s[0];
  if ((q !== '"' && q !== "'") || s[s.length - 1] !== q) return false;
  for (let i = 1; i < s.length - 1; i++) {
    if (s[i] !== q) continue;
    // Escaped occurrences don't break the literal:
    //   `"...`"..."`  → PowerShell backtick-escape of `"`
    //   `"...\"..."`  → bash backslash-escape of `"`
    //   `'...''...'`  → PowerShell single-quote doubling
    if (q === '"' && (s[i - 1] === "`" || s[i - 1] === "\\")) continue;
    if (q === "'" && s[i + 1] === "'") {
      i++; // consume the paired quote
      // If the second quote of the pair IS the closing quote, the literal
      // was unterminated (`'foo''` → 5 chars: open, 'f', 'o', 'o', pair-of-
      // quotes-but-the-second-is-the-closer). Reject.
      if (i === s.length - 1) return false;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Extract the canonical command name from a shell command's first token.
 * Handles cross-platform invocation shapes from writeCliShim: bare names,
 * Windows shim paths, POSIX shim paths, mixed separators, and quoted paths.
 * Returns "" when the command is empty.
 */
export function getShellCommandName(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "";
  let firstToken: string;
  if (trimmed[0] === '"' || trimmed[0] === "'") {
    const quote = trimmed[0];
    const closeIdx = trimmed.indexOf(quote, 1);
    firstToken = closeIdx > 0 ? trimmed.slice(1, closeIdx) : trimmed.slice(1);
  } else {
    firstToken = trimmed.split(/\s+/)[0] ?? "";
  }
  if (!firstToken) return "";
  const basename = firstToken.split(/[\\/]/).pop() ?? firstToken;
  const stem = basename.replace(/\.(cmd|exe|bat|ps1)$/i, "");
  return stem.toLowerCase();
}

/** PowerShell keywords and operators that are inert on their own — they have
 *  no side effects, just structure. Lets a segment like `if` or `else` (split
 *  out from `if (cond) { ... } else { ... }`) pass the read-only check rather
 *  than failing it because the first token doesn't match any cmdlet. Stored
 *  lowercased; callers must lowercase the lookup key. */
export const POWERSHELL_INERT_TOKENS: ReadonlySet<string> = new Set([
  "if",
  "else",
  "elseif",
  "try",
  "catch",
  "finally",
  "while",
  "for",
  "foreach",
  "do",
  "until",
  "switch",
  "begin",
  "process",
  "end",
  "in",
  "param",
  // Logical / comparison / type operators — these only ever appear as
  // standalone segments after splitting out `(...)` and `{...}` blocks.
  "-and",
  "-or",
  "-not",
  "-xor",
  "-eq",
  "-ne",
  "-lt",
  "-gt",
  "-le",
  "-ge",
  "-like",
  "-notlike",
  "-match",
  "-notmatch",
  "-contains",
  "-notcontains",
  "-in",
  "-notin",
  "-is",
  "-isnot",
]);
