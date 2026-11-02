import type { ContextTier, ModelInfo } from "@/types/electron";

export const CONTEXT_TIERS: ContextTier[] = ["default", "long_context"];

export function isContextTier(value: unknown): value is ContextTier {
  return value === "default" || value === "long_context";
}

export function supportsLongContext(model: ModelInfo | undefined): boolean {
  return model?.supportedContextTiers?.includes("long_context") === true;
}

function formatTokenLimit(tokens: number | undefined, fallback: string): string {
  if (tokens === undefined) return fallback;
  if (tokens >= 900_000) return "1M";
  return `${Math.round(tokens / 1_000)}K`;
}

export function formatContextTier(model: ModelInfo | undefined, contextTier: ContextTier): string {
  if (contextTier === "long_context") {
    return formatTokenLimit(model?.contextWindowTokens?.long_context, "1M");
  }
  return formatTokenLimit(model?.contextWindowTokens?.default, "Default");
}
