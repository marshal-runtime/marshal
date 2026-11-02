/**
 * Minimal `.env`-style parser used by the main process (`envFile` reader for
 * custom MCP servers). Lives in `common/` so parser behavior stays centralized
 * for all env-file consumers.
 *
 * Supports: `KEY=VALUE` per line, blank lines, `#` comments, single- or
 * double-quoted values. No shell interpolation, no `\` escapes, no inline
 * comments after a value.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = removeMatchingQuotes(line.slice(eq + 1).trim());
    if (key) out[key] = value;
  }
  return out;
}

function removeMatchingQuotes(value: string): string {
  const quote = value[0];
  const isQuoted = (quote === '"' || quote === "'") && value.endsWith(quote);
  return isQuoted ? value.slice(1, -1) : value;
}
