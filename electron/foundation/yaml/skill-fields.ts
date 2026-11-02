/** Strip surrounding YAML quotes (single or double) and unescape backslash sequences. */
export function stripYamlQuotes(v: string): string {
  if (
    v.length > 1 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  ) {
    return unescapeYamlValue(v.slice(1, -1));
  }

  function unescapeYamlValue(value: string): string {
    return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return v;
}

/**
 * Extract a short description from skill body text.
 * Takes the first non-empty, non-heading line and truncates to ~200 chars
 * at the last sentence-ending punctuation (. ! ?) within the limit.
 */
export function descriptionFromBody(body: string): string {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  if (!line) return "";
  if (line.length <= 200) return line;
  // Find the last sentence-ending punctuation within 200 chars
  const slice = line.slice(0, 200);
  const lastSentence = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? "),
    slice.search(/[.!?]$/),
  );
  if (lastSentence > 0) return slice.slice(0, lastSentence + 1);
  return slice + "…";
}
