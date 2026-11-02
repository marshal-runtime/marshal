/**
 * Parse a YAML field from frontmatter.
 *
 * Handles: plain values, quoted values, and block scalars (|, |-, |+).
 * Used by both renderer and main process to avoid diverging implementations.
 *
 * @param fm — frontmatter string (e.g., the YAML block between `---` markers)
 * @param key — field name to extract (e.g., "type", "name", "description")
 * @returns field value or `null` if not found
 */
export function readYamlField(fm: string, key: string): string | null {
  // Use string startsWith rather than a dynamic RegExp to avoid regex injection.
  const prefix = `${key}:`;
  const lines = fm.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(prefix)) continue;
    const val = lines[i].slice(prefix.length).trim();
    // Block scalar — collect indented continuation lines
    if (isBlockScalar(val)) {
      if (val === "") return null; // empty value
      const blockLines: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s/.test(lines[j]) || lines[j] === "") {
          // Dedent by 2 spaces (standard YAML indent)
          blockLines.push(lines[j].replace(/^ {1,2}/, ""));
        } else {
          break;
        }
      }
      const result = blockLines.join("\n").trim();
      return result || null;
    }
    // Quoted string
    if (hasMatchingQuotes(val)) {
      return val.slice(1, -1) || null;
    }
    return val || null;
  }
  return null;
}

function isBlockScalar(value: string): boolean {
  return value === "|" || value === "|-" || value === "|+" || value === "";
}

function hasMatchingQuotes(value: string): boolean {
  return (
    (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
  );
}
