/**
 * Deterministic color picker for persona avatar fallbacks.
 *
 * Hashes the supplied key (typically email, falling back to displayName) into
 * one of a small palette of muted Tailwind class strings. Palette is themed for
 * both light and dark modes.
 *
 * Returns a stable className string ready to drop onto an AvatarFallback.
 */

export const PALETTE = [
  "bg-blue-100 text-blue-900 dark:bg-blue-900 dark:text-blue-100",
  "bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100",
  "bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100",
  "bg-rose-100 text-rose-900 dark:bg-rose-900 dark:text-rose-100",
  "bg-violet-100 text-violet-900 dark:bg-violet-900 dark:text-violet-100",
  "bg-teal-100 text-teal-900 dark:bg-teal-900 dark:text-teal-100",
] as const;

const DEFAULT_CLASSES = "bg-muted text-muted-foreground";
const HASH_MULTIPLIER = 31;

function hash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * HASH_MULTIPLIER + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function pickAvatarColorClasses(key: string | undefined): string {
  const trimmed = key?.trim();
  if (!trimmed) return DEFAULT_CLASSES;
  return PALETTE[hash(trimmed) % PALETTE.length];
}
