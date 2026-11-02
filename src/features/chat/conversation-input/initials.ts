/**
 * Derive up-to-two-letter initials from a display name.
 *
 * Rules:
 *  - 2+ whitespace-separated tokens -> first letter of first token + first letter of last token (e.g. "Dino Ilic" -> "DI", "Dino van der Berg" -> "DB").
 *  - Single token -> first letter only (e.g. "Cher" -> "C").
 *  - Empty / whitespace-only / undefined -> null (caller decides on a non-initials fallback).
 *
 * Output is uppercased and may contain non-Latin glyphs unchanged. Surrogate
 * pairs (e.g. emoji) are preserved by iterating code points instead of code
 * units.
 */
export function getInitials(displayName?: string | null): string | null {
  if (!displayName) return null;
  const tokens = tokenizeDisplayName(displayName);
  if (tokens.length === 0) return null;
  const first = firstCodePoint(tokens[0]);
  if (tokens.length === 1) return first.toUpperCase() || null;
  const last = firstCodePoint(tokens[tokens.length - 1]);
  return (first + last).toUpperCase() || null;
}

function tokenizeDisplayName(displayName: string): string[] {
  return displayName.trim().split(/\s+/).filter(Boolean);
}

function firstCodePoint(token: string): string {
  // `Array.from` iterates by code point, so an emoji-prefixed token yields the
  // full emoji rather than a lone high surrogate.
  return Array.from(token)[0] ?? "";
}
