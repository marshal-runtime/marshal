// Marshal ownership: relocated module identity.
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function escapeXmlLikeClosingTag(tagName: string, body: string | null | undefined): string {
  return makeClosingTagEscaper(tagName)(body);
}

export function makeClosingTagEscaper(
  tagName: string,
): (body: string | null | undefined) => string {
  const closeTagRe = new RegExp(`<\\s*\\/\\s*${escapeRegExp(tagName)}\\b[^>]*>`, "gi");
  return (body) => (body ?? "").replace(closeTagRe, () => `<\\/${tagName}>`);
}
