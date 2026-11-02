import type { ModelInfo } from "@/types/electron";

const PROVIDER_ORDER = {
  claude: 0,
  openai: 1,
  other: 2,
} as const;

type Provider = keyof typeof PROVIDER_ORDER;

function providerOf(model: ModelInfo): Provider {
  const id = model.id?.toLowerCase() ?? "";
  if (id.startsWith("claude")) return "claude";
  // OpenAI families: gpt-*, openai/*, and the o-series (o1, o3, o4 today;
  // o2 was skipped for trademark reasons). The `o\d` match future-proofs
  // against o5+ landing in "other".
  if (/^(gpt|openai|o\d)/.test(id)) return "openai";
  return "other";
}

function versionOf(model: ModelInfo): [major: number, minor: number] {
  // First numeric (major or major.minor) in the display name; falls back to id.
  // Major and minor are compared as separate integers so "4.10" ranks above
  // "4.7" — parseFloat would misorder them by treating the version as a float.
  const match = (model.name || model.id || "").match(/(\d+)(?:\.(\d+))?/);
  if (!match) return [0, 0];
  return [parseInt(match[1], 10), parseInt(match[2] ?? "0", 10)];
}

/**
 * Sort models by provider (Claude → OpenAI → others), then by version descending,
 * then by name ascending. The trailing alphabetical tiebreak keeps variants of the
 * same model (e.g. "(1M context)", "(High reasoning)") sitting next to their base.
 */
export function sortModels<T extends ModelInfo>(models: readonly T[]): T[] {
  const sorted = Array.from(models);
  sorted.sort((a, b) => {
    const providerDiff = PROVIDER_ORDER[providerOf(a)] - PROVIDER_ORDER[providerOf(b)];
    if (providerDiff !== 0) return providerDiff;
    const [aMajor, aMinor] = versionOf(a);
    const [bMajor, bMinor] = versionOf(b);
    if (aMajor !== bMajor) return bMajor - aMajor;
    if (aMinor !== bMinor) return bMinor - aMinor;
    // localeCompare treats a shorter string as less than a longer string with
    // the same prefix, which is what makes variants like "Claude Opus 4.7
    // (1M context)" cluster directly after their base "Claude Opus 4.7".
    // Don't switch this to name.length or similar — the prefix invariant is
    // load-bearing for the variant-clustering test.
    return (a.name || a.id).localeCompare(b.name || b.id);
  });
  return sorted;
}
