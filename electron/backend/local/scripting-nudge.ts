/**
 * Detects shell commands that are really scripts (jq, inline python/node,
 * awk, loops, long pipes) so a runtime adapter can steer the agent toward the
 * session's full-Node scripting tool. Detection is advisory only: it never
 * blocks or rewrites the command.
 */

const SCRIPTING_SIGNALS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|[\s|;&(])jq(\s|$)/, "jq"],
  [/(^|[\s|;&(])python3?\s+(-c\b|-\s*<<)/, "inline python"],
  [/(^|[\s|;&(])node\s+(-e|--eval|-p|--print)\b/, "inline node"],
  [/(^|[\s|;&(])awk\s/, "awk"],
  [/(^|[\s|;&(])xargs\s/, "xargs"],
  [/(^|[\s;&(])(for|while)\s[^;]*;\s*do\b/, "a shell loop"],
];

const MIN_PIPE_STAGES_FOR_SCRIPT = 3;

/** Drops heredoc bodies, quoted strings, and escapes, so `grep "a\|b"` or a
 *  commit message mentioning jq is not mistaken for shell structure. */
function shellStructure(command: string): string {
  return command
    .replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, "<<$2$3")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'[^']*'/g, "''")
    .replace(/\\./g, "");
}

/** Longest pipeline among the commands joined by `;`, `&&`, `||`, or newlines. */
function pipeStages(structure: string): number {
  return Math.max(...structure.split(/&&|\|\||;|\n/).map((segment) => segment.split("|").length));
}

/** Returns what makes `command` a script, or undefined for ordinary CLI use. */
export function detectShellScripting(command: string): string | undefined {
  const structure = shellStructure(command);
  for (const [pattern, label] of SCRIPTING_SIGNALS) {
    if (pattern.test(structure)) return label;
  }
  const stages = pipeStages(structure);
  return stages >= MIN_PIPE_STAGES_FOR_SCRIPT ? `a ${stages}-stage pipe` : undefined;
}

export function scriptingNudge(command: unknown, scriptingToolName: string): string | undefined {
  if (typeof command !== "string") return undefined;
  const signal = detectShellScripting(command);
  if (!signal) return undefined;
  return (
    `This shell command is a script (${signal}). For work like this, prefer ${scriptingToolName}: ` +
    "write top-level TypeScript statements ending in `return`; it runs in the session workspace with " +
    "`process` and `Buffer` pre-imported and returns compact structured JSON. The command is running as sent."
  );
}
