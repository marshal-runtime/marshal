const HTML_ESCAPES: ReadonlyArray<[RegExp, string]> = [
  [/&/g, "&amp;"],
  [/</g, "&lt;"],
  [/>/g, "&gt;"],
  [/"/g, "&quot;"],
  [/'/g, "&#39;"],
];

export function escapeHtml(str: string): string {
  return HTML_ESCAPES.reduce(
    (escaped, [pattern, replacement]) => escaped.replace(pattern, replacement),
    str,
  );
}

const BASIC_HTML_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

/** Convert HTML content into plain text without relying on tag-stripping regexes. */
export function htmlToPlainText(html: string): string {
  let text = "";
  let inTag = false;

  for (const char of html) {
    if (char === "<") {
      inTag = true;
      continue;
    }

    if (char === ">" && inTag) {
      inTag = false;
      continue;
    }

    if (!inTag) {
      text += char;
    }
  }

  return text
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (entity) => BASIC_HTML_ENTITIES[entity] ?? entity)
    .trim();
}
