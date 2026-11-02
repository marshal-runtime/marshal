// electron/workflows/sanitize-key.ts
//
// FanOut and artifact paths are derived from caller-supplied strings.
// Sanitise them once, in one place, so disk paths are safe on both
// Windows and POSIX and we never accidentally let `..` traversal slip
// into a workflow run directory. Spec: r1-fixes "fanOut artifact path".

export const MAX_SEGMENT_LEN = 64;

/**
 * Normalise an arbitrary string to a filesystem-safe path segment.
 * - Allows ASCII alphanumerics plus `-`, `_`, `.`.
 * - Replaces every other character (incl. `/`, `\`, spaces, unicode) with `_`.
 * - Caps length at `MAX_SEGMENT_LEN`.
 * - Falls back to a deterministic stub when the input collapses to empty.
 */
export function sanitizeArtifactSegment(value: string, fallback = "_unnamed"): string {
  // Drop any non-allowed character, collapse runs of `_`, trim leading dots
  // (hidden files), then cap length. The replacement char is `_` rather
  // than `-` so the result composes cleanly with `unit-<index>` fallbacks.
  let cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/_+/g, "_");
  while (cleaned.startsWith(".")) cleaned = cleaned.slice(1);
  if (cleaned.length > MAX_SEGMENT_LEN) cleaned = cleaned.slice(0, MAX_SEGMENT_LEN);
  if (cleaned.length === 0) return fallback;
  // Disallow reserved Windows device names as a final guard. (We use `_`
  // prefix because the case-insensitive matching catches both COM1 and com1.)
  if (RESERVED_WIN_NAMES.has(cleaned.toUpperCase())) return `_${cleaned}`;
  return cleaned;
}

const RESERVED_WIN_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);
