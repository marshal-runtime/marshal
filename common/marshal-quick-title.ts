const QUICK_TITLE_MAX_LENGTH = 120;
const INTENT_TITLE_MAX_WORDS = 4;

export function makeQuickTitle(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, " ");
  if (!cleaned) return "";
  if (cleaned.length <= QUICK_TITLE_MAX_LENGTH) return cleaned;
  return cleaned.slice(0, QUICK_TITLE_MAX_LENGTH).trimEnd() + "\u2026";
}

export function makeIntentTitleFallback(text: string): string {
  return makeQuickTitle(text).split(/\s+/).slice(0, INTENT_TITLE_MAX_WORDS).join(" ");
}
