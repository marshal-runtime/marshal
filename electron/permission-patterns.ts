import type { ApprovalRequest } from "./backend/types";
import {
  getShellMode,
  normalizeTokenForMatching,
  SHELL_OPERATOR_RE,
  type ShellMode,
  SUBSHELL_RE,
  VAR_ASSIGN_PREFIX_RE,
} from "./shell-syntax-permission-utils";

export { SHELL_OPERATOR_RE, SUBSHELL_RE, VAR_ASSIGN_PREFIX_RE };

/**
 * Plain glob match: `*` matches any characters; no structured flag semantics.
 * Used as a building block and as a fallback when structured matching fails.
 *
 * Also exported as `matchesDenyPattern` for deny-list use: deny patterns are
 * a broad safety net (e.g. "any command containing `-X DELETE`"), and the
 * structured matcher's subset rule defeats that — it would treat `-X*` as a
 * required flag spec (matching commands that *could* take -X) rather than as
 * a literal "any token starting with -X" guard.
 */
export function matchesDenyPattern(
  command: string,
  pattern: string,
  shellMode: ShellMode = getShellMode(),
): boolean {
  return matchesAllowPatternGlob(command, pattern, shellMode);
}

function matchesAllowPatternGlob(
  command: string,
  pattern: string,
  shellMode: ShellMode = getShellMode(),
): boolean {
  // Normalize away shell-quote / PowerShell-escape syntax so the matcher
  // compares semantic values (what the program receives at runtime) rather
  // than lexical forms. The PRINCIPAL value comes from the structured-
  // matcher path (matchesStructuredPattern → individual flag values),
  // where each comparison is per-token and `stripOuterQuotes` strips the
  // outer pair from `"fields=foo"` → `fields=foo`. When called directly
  // from the non-structured (glob) path, the input is the whole command
  // string — `stripOuterQuotes` only fires if the WHOLE command happens
  // to be a quoted blob (rare); the PowerShell backtick-strip still does
  // real work on the whole string. Either way, `"fields=foo"` won't
  // match `fields=*` and `'$expand=relations'` won't match
  // `` `$expand=* `` (PS mode) without this. One-pass only; iterative
  // unwrapping (`"`$x`"` → strip backticks → `"$x"` → strip quotes → `$x`)
  // is deliberately out of scope — it'd make the security envelope
  // harder to reason about.
  const normalizedCommand = normalizeTokenForMatching(normalizeCommandText(command), shellMode);
  const normalizedPattern = normalizeTokenForMatching(normalizeCommandText(pattern), shellMode);

  if (!normalizedPattern.includes("*")) {
    return normalizedCommand === normalizedPattern;
  }

  const segments = normalizedPattern.split("*");
  let pos = 0;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (i === 0) {
      // First segment must be a prefix
      if (!normalizedCommand.startsWith(segment)) return false;
      pos = segment.length;
    } else {
      // Subsequent segments must appear in order
      const idx = normalizedCommand.indexOf(segment, pos);
      if (idx === -1) return false;
      pos = idx + segment.length;
    }
  }

  // If the pattern doesn't end with *, the last segment must be anchored to end of command
  const lastSegment = segments[segments.length - 1];
  if (lastSegment !== "") {
    return pos === normalizedCommand.length;
  }

  return true;
}

export interface ShellSplitResult {
  segments: string[];
  operators: string[];
  hasUnsafeSyntax: boolean;
}

function normalizeCommandText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function pushSegment(segments: string[], chars: string[]): boolean {
  const segment = chars.join("").trim();
  chars.length = 0;
  if (!segment) return false;
  segments.push(segment);
  return true;
}

export function hasDynamicShellExpansion(
  command: string,
  shellMode: ShellMode = getShellMode(),
): boolean {
  const text = normalizeCommandText(command);
  if (hasWindowsCmdExpansion(text)) return true;

  // Quote-aware scan. Bash and PowerShell both prevent variable expansion
  // inside single quotes — `'$TOKEN'` is a literal string in both shells,
  // the program receives `$TOKEN` as a verbatim arg, no environment lookup
  // happens. So flagging single-quoted `$word` as "dynamic" would be wrong
  // (overconservative) and would prevent legitimate model output like
  // `'$expand=relations'` from matching its allow pattern. Double-quoted
  // `$word` still expands in both shells, so that case stays dynamic.
  let inSingleQuote = false;
  let inDoubleQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1] ?? "";

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    // Inside single quotes nothing expands — even `$(...)`, `$var`, etc.
    // are literal characters. Skip until the closing single quote.
    if (inSingleQuote) continue;

    if (ch === "$" && /[\w{(?$!@*#-]/.test(next)) {
      // PowerShell escape: `` `$ `` is the SDK's literal-dollar escape
      // outside quotes (used e.g. for `--query-parameters ... `$expand=*`).
      // Not dynamic — keep scanning. Bare `$var` and `$env:X` outside
      // single quotes remain "dynamic" in both shells because their
      // contents are policy-opaque and a leak vector for prompt-injection
      // / env-var exfiltration (mirrors the existing bash posture tested
      // by `step 7: broad shell allow does not cover dynamic variable
      // expansion`).
      if (shellMode === "powershell" && i > 0 && text[i - 1] === "`") continue;
      return true;
    }
  }
  return false;
}

export function hasWindowsCmdExpansion(command: string): boolean {
  return (
    /%[A-Za-z_][A-Za-z0-9_]*(?::[^%]*)?%/.test(command) ||
    /![A-Za-z_][A-Za-z0-9_]*(?::[^!]*)?!/.test(command)
  );
}

export function isUnsafeShellSyntax(
  command: string,
  shellMode: ShellMode = getShellMode(),
): boolean {
  const split = splitShellSegments(command, shellMode);
  return split.hasUnsafeSyntax || hasDynamicShellExpansion(command, shellMode);
}

export function splitShellSegments(
  command: string,
  shellMode: ShellMode = getShellMode(),
): ShellSplitResult {
  const text = normalizeCommandText(command);
  const segments: string[] = [];
  const operators: string[] = [];
  const current: string[] = [];
  let quote: "'" | '"' | null = null;
  let hasUnsafeSyntax = false;
  const isPowerShell = shellMode === "powershell";

  const pushOperator = (operator: string) => {
    if (pushSegment(segments, current)) {
      operators.push(operator);
    }
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1] ?? "";

    if (quote) {
      // PowerShell backtick-escape inside double-quotes: `` `$ ``, `` `" ``,
      // etc. consume the next char as literal. Must run before the generic
      // unsafe-syntax check below — otherwise the lone `` ` `` trips the
      // bash subshell flag.
      if (isPowerShell && ch === "`" && quote === '"' && next) {
        current.push(ch);
        current.push(next);
        i++;
        continue;
      }

      current.push(ch);

      if (ch === "\\" && quote === '"' && next) {
        current.push(next);
        i++;
        continue;
      }

      if (ch === quote) {
        quote = null;
      } else if ((ch === "`" && !isPowerShell) || (ch === "$" && next === "(")) {
        // Bash: backtick or `$(` is command substitution. PowerShell: `` ` ``
        // alone in quotes is rare (escape was handled above); `$(...)` is
        // still a sub-expression and remains unsafe.
        hasUnsafeSyntax = true;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      current.push(ch);
      continue;
    }

    // PowerShell backtick-escape outside quotes. Two flavors:
    //  - `` `<newline> `` (line continuation): discard both. Keeping them in
    //    the segment would leave the bare `` ` `` as a stray token after
    //    `tokenize` (which splits on whitespace) and defeat structured-flag
    //    matching of multi-line commands.
    //  - `` `<other> `` (literal escape, e.g. `` `$expand `` for the SDK's
    //    flag-value escape): keep both so the segment text matches what the
    //    user typed in their allow-pattern.
    if (isPowerShell && ch === "`" && next) {
      if (next === "\n") {
        i++; // consume the newline; both chars discarded
      } else {
        current.push(ch);
        current.push(next);
        i++;
      }
      continue;
    }

    // PowerShell sub-expressions and scriptblocks: `( ... )` and `{ ... }`
    // are not subshells — they're grouping/scriptblock syntax. Treat the
    // boundary as a segment break so the inner cmdlets are checked
    // individually. `$(`, `@(`, `<(`, `>(`, `<<` are still caught by the
    // unsafe block below — those forms ARE dangerous in PowerShell too.
    if (isPowerShell && (ch === "(" || ch === "{" || ch === ")" || ch === "}")) {
      pushOperator(";");
      continue;
    }

    if (
      (ch === "`" && !isPowerShell) ||
      (ch === "$" && next === "(") ||
      (ch === "@" && next === "(") ||
      (ch === "(" && !isPowerShell) ||
      (ch === "{" && !isPowerShell && text[i - 1] !== "$" && (i === 0 || /\s/.test(text[i - 1]))) ||
      ((ch === "<" || ch === ">") && next === "(") ||
      (ch === "<" && next === "<") ||
      ch === "<" ||
      ch === ">"
    ) {
      hasUnsafeSyntax = true;
      current.push(ch);
      continue;
    }

    if (ch === ";" || ch === "\n") {
      pushOperator(";");
      continue;
    }

    if (ch === "&") {
      if (current.every((char) => /\s/.test(char))) {
        hasUnsafeSyntax = true;
      }
      if (next === "&") {
        pushOperator("&&");
        i++;
      } else {
        pushOperator("&");
      }
      continue;
    }

    if (ch === "|") {
      if (next === "|") {
        pushOperator("||");
        i++;
      } else {
        pushOperator("|");
      }
      continue;
    }

    current.push(ch);
  }

  pushSegment(segments, current);
  return { segments, operators, hasUnsafeSyntax };
}

function exactCommandIsAllowed(command: string, patterns: string[]): boolean {
  const normalizedCommand = normalizeCommandText(command);
  return patterns.some(
    (pattern) => !pattern.includes("*") && normalizeCommandText(pattern) === normalizedCommand,
  );
}

function expandShellAllowPatterns(
  patterns: string[],
  shellMode: ShellMode = getShellMode(),
): string[] {
  const expanded: string[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    const split = splitShellSegments(pattern, shellMode);
    if (split.hasUnsafeSyntax) continue;
    for (const segment of split.segments) {
      const normalized = normalizeCommandText(segment);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      expanded.push(normalized);
    }
  }

  return expanded;
}

interface ParsedShellCommand {
  positional: string[];
  flags: Array<{ name: string; value: string | null }>;
}

/**
 * Parse a shell command (or pattern) into a positional prefix + flag list.
 *
 * - Tokens before the first flag form the positional prefix.
 * - `--flag=value` is one token; name/value are split on `=`.
 * - A bare flag whose next token is not itself a flag consumes that token
 *   as its value. Otherwise it is a boolean flag (value = null).
 * - Any non-flag token encountered after the first flag is appended to the
 *   positional list (unusual shell shape; don't lose the token).
 */
function parseShellCommand(input: string): ParsedShellCommand {
  const tokens = tokenize(input);
  const positional: string[] = [];
  const flags: Array<{ name: string; value: string | null }> = [];

  let i = 0;
  while (i < tokens.length && !isFlagToken(tokens[i])) {
    positional.push(tokens[i]);
    i++;
  }
  while (i < tokens.length) {
    const tok = tokens[i];
    if (!isFlagToken(tok)) {
      positional.push(tok);
      i++;
      continue;
    }
    const eqMatch = /^(-{1,2}[A-Za-z][\w-]*)=(\S+)$/.exec(tok);
    if (eqMatch) {
      flags.push({ name: eqMatch[1], value: eqMatch[2] });
      i++;
      continue;
    }
    const next = tokens[i + 1];
    if (next !== undefined && !isFlagToken(next)) {
      flags.push({ name: tok, value: next });
      i += 2;
    } else {
      flags.push({ name: tok, value: null });
      i += 1;
    }
  }

  return { positional, flags };
}

/** A pattern is "structured" if it contains at least one flag token. */
function isStructuredPattern(pattern: string): boolean {
  return /(^|\s)-{1,2}[A-Za-z]/.test(pattern);
}

const REQUIRED_PATTERN_FLAGS = new Set([
  "--dry-run",
  "--dryrun",
  "--check",
  "--no-emit",
  "--noemit",
  "--what-if",
  "-whatif",
]);

function isRequiredPatternFlag(flagName: string): boolean {
  return REQUIRED_PATTERN_FLAGS.has(flagName.toLowerCase());
}

/**
 * Match a command against a structured pattern.
 *
 * Rules:
 * - Positional prefix: command length must equal pattern length; each pattern
 *   positional token is a glob against the corresponding command token.
 * - Flags: every flag in the command must exist in the pattern (subset rule).
 *   A missing flag in the command is fine (user approved a broader shape);
 *   a new flag in the command re-prompts (could be destructive). Safety flags
 *   in the pattern are required so approvals like `--dry-run` cannot authorize
 *   the non-dry-run form.
 * - Flag values: pattern's value is a glob the command's value must satisfy.
 *   Boolean/value shape must agree on both sides.
 */
function matchesStructuredPattern(
  command: string,
  pattern: string,
  shellMode: ShellMode = getShellMode(),
): boolean {
  const cmd = parseShellCommand(command);
  const pat = parseShellCommand(pattern);

  if (cmd.positional.length !== pat.positional.length) return false;
  for (let i = 0; i < pat.positional.length; i++) {
    if (!matchesAllowPatternGlob(cmd.positional[i], pat.positional[i], shellMode)) return false;
  }

  const patFlagMap = new Map<string, string | null>(pat.flags.map((f) => [f.name, f.value]));
  const cmdFlagNames = new Set(cmd.flags.map((f) => f.name.toLowerCase()));
  for (const pf of pat.flags) {
    if (isRequiredPatternFlag(pf.name) && !cmdFlagNames.has(pf.name.toLowerCase())) {
      return false;
    }
  }

  for (const cf of cmd.flags) {
    if (!patFlagMap.has(cf.name)) return false;
    const patValue = patFlagMap.get(cf.name) ?? null;
    if (patValue === null && cf.value === null) continue;
    if (patValue === null && cf.value !== null) return false;
    if (patValue !== null && cf.value === null) return false;
    if (
      patValue !== null &&
      cf.value !== null &&
      !matchesAllowPatternGlob(cf.value, patValue, shellMode)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Check if a single command/key matches a single allow-list pattern.
 *
 * Structured patterns (containing `-` or `--` flag tokens) dispatch to the
 * structured matcher, which applies a subset rule: the command's flag set
 * must be a subset of the pattern's. A failure here is NOT softened by
 * glob — an unapproved flag must re-prompt; falling back to glob would
 * silently bypass the subset safety property.
 *
 * Non-structured patterns use plain glob matching: `*` is a wildcard.
 */
export function matchesAllowPattern(
  command: string,
  pattern: string,
  shellMode: ShellMode = getShellMode(),
): boolean {
  const normalizedCommand = normalizeCommandText(command);
  const normalizedPattern = normalizeCommandText(pattern);
  if (isStructuredPattern(normalizedPattern)) {
    return matchesStructuredPattern(normalizedCommand, normalizedPattern, shellMode);
  }
  return matchesAllowPatternGlob(normalizedCommand, normalizedPattern, shellMode);
}

/**
 * Split a compound command on shell operators, check every segment
 * against the allow list. All segments must match at least one pattern.
 */
export function allSegmentsMatchAllowPatterns(
  command: string,
  patterns: string[],
  shellMode: ShellMode = getShellMode(),
): boolean {
  if (patterns.length === 0) return false;

  if (hasWindowsCmdExpansion(command)) return false;
  if (exactCommandIsAllowed(command, patterns)) return true;
  if (hasDynamicShellExpansion(command, shellMode)) return false;

  const split = splitShellSegments(command, shellMode);
  if (split.segments.length === 0) return false;
  if (split.hasUnsafeSyntax) return false; // broad patterns must not cover redirection/subshells

  // Expand patterns with the SAME shell mode — a pattern containing PowerShell
  // escape syntax would otherwise be flagged as unsafe and dropped during
  // expansion, silently defeating the user's allow rule.
  const expandedPatterns = expandShellAllowPatterns(patterns, shellMode);
  if (expandedPatterns.length === 0) return false;

  return split.segments.every((segment) =>
    expandedPatterns.some((pattern) => matchesAllowPattern(segment, pattern, shellMode)),
  );
}

// Matches quoted strings (single or double)
const QUOTED_STRING_RE = /^(['"])[\s\S]*\1$/;

/** Returns true if a token looks like a file path. */
function isPathLike(token: string): boolean {
  return (
    token.includes("/") || token.includes("\\") || token.startsWith(".") || token.startsWith("~")
  );
}

/** Returns true if a token looks like a shell/env variable (dynamic content). */
function isVariable(token: string): boolean {
  return token.startsWith("$");
}

/** Returns true if a token is a bare numeric argument (optionally negative
 *  or decimal). These are almost always user-supplied counts/IDs (`head -20`,
 *  `sleep 5`) and are safe to generalise to `*` whether or not they appear
 *  adjacent to a flag. */
function isNumericArg(token: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(token);
}

/** Returns true if a token is a flag (starts with - or --). */
function isFlagToken(token: string): boolean {
  return /^-{1,2}[A-Za-z]/.test(token);
}

/**
 * If the token is a `--flag=value` pair, collapse it to `--flag=*`.
 * Values are dynamic (usually user-supplied). Pattern keeps the `=` so the
 * downstream matcher can distinguish `--flag=*` (takes value via =) from
 * `--flag` (boolean) and `--flag *` (takes value via space).
 */
function normalizeFlagEqualValue(token: string): string {
  const m = /^(-{1,2}[A-Za-z][\w-]*)=(\S+)$/.exec(token);
  return m ? `${m[1]}=*` : token;
}

/** Tokenize a command string, respecting quoted substrings. */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (inQuote) {
      current += ch;
      if (ch === inQuote) {
        inQuote = null;
      }
    } else if (ch === '"' || ch === "'") {
      current += ch;
      inQuote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Extract a permission pattern from a concrete shell command.
 * - Quoted strings become *
 * - File paths become *
 * - Shell/env variables become *
 * - Tokens after the first flag that aren't themselves flags become *
 *   (flag-value generalization — audit-log evidence shows 61% of real
 *   shell prompts have flag-value pairs, and leaving them literal
 *   fragments the stored rules)
 * - `--flag=value` is collapsed to `--flag=*`
 * - Consecutive wildcards collapse into one
 *
 * Compound commands (containing `|`, `&&`, `||`, `;`, `&`, `>`) are split
 * on operators; each segment is generalised independently and rejoined
 * with the original operators preserved. Subshell forms are returned as
 * the exact command string — G_COMPOUND nulls them upstream anyway.
 */
export function extractPattern(command: string, shellMode: ShellMode = getShellMode()): string {
  const split = splitShellSegments(command, shellMode);
  if (split.hasUnsafeSyntax) {
    return normalizeCommandText(command);
  }
  if (split.segments.length > 1) {
    let result = extractSegmentPattern(split.segments[0]);
    for (let i = 1; i < split.segments.length; i++) {
      result += ` ${split.operators[i - 1]} ${extractSegmentPattern(split.segments[i])}`;
    }
    return result;
  }
  return extractSegmentPattern(command);
}

function extractSegmentPattern(segment: string): string {
  const normalized = segment.replace(VAR_ASSIGN_PREFIX_RE, "");
  const tokens = tokenize(normalized).map(normalizeFlagEqualValue);

  let firstFlagIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (isFlagToken(tokens[i])) {
      firstFlagIdx = i;
      break;
    }
  }

  const pushCollapsedStar = (out: string[]) => {
    if (out[out.length - 1] !== "*") out.push("*");
  };

  const result: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // Positional prefix (before first flag, or no flags at all): existing rules,
    // with consecutive wildcards collapsed.
    if (firstFlagIdx === -1 || i <= firstFlagIdx) {
      if (
        QUOTED_STRING_RE.test(token) ||
        isPathLike(token) ||
        isVariable(token) ||
        isNumericArg(token)
      ) {
        pushCollapsedStar(result);
      } else {
        result.push(token);
      }
      continue;
    }

    // After the first flag: flags pass through, every other token is a value slot.
    // Don't collapse — each slot must survive so the structured matcher can check
    // flag/value arity (e.g. `grep -n * *` ≠ `grep -n *`).
    if (isFlagToken(token)) {
      result.push(token);
    } else {
      result.push("*");
    }
  }

  return result.join(" ");
}

export function extractPatterns(command: string, shellMode: ShellMode = getShellMode()): string[] {
  const split = splitShellSegments(command, shellMode);
  if (split.segments.length === 0) return [];

  if (split.hasUnsafeSyntax) {
    const exact = normalizeCommandText(command);
    return exact ? [exact] : [];
  }

  const patterns: string[] = [];
  const seen = new Set<string>();

  for (const segment of split.segments) {
    const pattern = extractPattern(segment, shellMode);
    const normalized = normalizeCommandText(pattern);
    if (!normalized || normalized === "*" || seen.has(normalized)) continue;
    seen.add(normalized);
    patterns.push(normalized);
  }

  return patterns;
}

/**
 * Compute the unified pattern key for a permission request.
 * Used for both "Allow for session" (RAM) and "Always allow" (disk).
 *
 * | Kind        | Format                      | Example                     |
 * |-------------|-----------------------------|-----------------------------|
 * | shell       | extracted pattern           | `npm run build`, `cat *`    |
 * | custom-tool | `tool:{toolName}`           | `tool:listEmails`   |
 * | mcp         | `mcp:{server}:{toolName}`   | `mcp:filesystem:read`       |
 * | write       | `write:{path}`              | `write:src/index.ts`        |
 * | url         | `url:{url}`                 | `url:https://...`           |
 * | memory      | `memory`                    |                             |
 * | hook        | `hook:{toolName}`           | `hook:shell`                |
 * | read        | null (always auto-approved) |                             |
 */
/** Normalize a file path for consistent matching across platforms.
 *  Always forward slashes + lowercase so the stored key is stable regardless
 *  of the casing the SDK happens to use (e.g., C:\Users\Foo.md vs c:\users\foo.md). */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

export function getPatternKey(request: ApprovalRequest): string | null {
  const keys = getPatternKeys(request);
  return keys.length > 0 ? keys.join("; ") : null;
}

export function getPatternKeys(request: ApprovalRequest): string[] {
  switch (request.kind) {
    case "shell": {
      const cmd = request.command;
      return cmd ? extractPatterns(cmd) : [];
    }
    case "custom-tool": {
      const toolName = request.toolName;
      return toolName ? [`tool:${toolName}`] : [];
    }
    case "mcp": {
      const server = request.serverName;
      const tool = request.toolName;
      return server && tool ? [`mcp:${server}:${tool}`] : [];
    }
    case "write": {
      const p = request.path;
      return p ? [`write:${normalizePath(p)}`] : [];
    }
    case "url": {
      const url = request.url;
      return url ? [`url:${url}`] : [];
    }
    case "memory":
      // Intentionally coarse: "Allow for session" on any memory write grants
      // the agent permission to maintain all memories for that session. Memory
      // requests represent the agent remembering context the user asked it to,
      // so session-scoped blanket consent is the expected UX here.
      return ["memory"];
    case "hook": {
      const toolName = request.toolName;
      return toolName ? [`hook:${toolName}`] : [];
    }
    case "read":
      // Collapse read approvals to one blanket key so persisted choices work.
      // Sensitive paths stay protected by the earlier gate.
      return ["tool:read"];
    default:
      return [];
  }
}

// Marshal-internal synthetic tool keys that have no analog in remote backends
// (e.g. marshal). Filter these out before patching cross-backend config so
// they don't leak as unmatched entries in alsoAllow/deny.
export const MARSHAL_LOCAL_TOOL_KEYS: ReadonlySet<string> = new Set(["tool:read"]);
