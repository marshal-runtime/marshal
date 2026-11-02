// Shared reasoning-effort helpers. The canonical level list mirrors the
// Copilot CLI reasoning-effort levels. The SDK 1.0.6 type omits `max`, but its
// bundled CLI runtime and model catalog support it. A model's supported subset
// and default come from runtime capabilities.

import type { ModelInfo, ReasoningEffort } from "@/types/electron";

export const REASONING_EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

const REASONING_EFFORT_SET = new Set<string>(REASONING_EFFORTS);

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && REASONING_EFFORT_SET.has(value);
}

/** The reasoning levels a model actually supports. Prefers the model's
 *  declared `supportedReasoningEfforts`; falls back to the full set when the
 *  model only advertises the `reasoningEffort` capability flag; otherwise
 *  empty (the model has no reasoning-effort control). */
export function getSupportedReasoningEfforts(model: ModelInfo | undefined): ReasoningEffort[] {
  const declared = model?.supportedReasoningEfforts?.filter(isReasoningEffort) ?? [];
  if (declared.length > 0) return declared;
  if (model?.capabilities?.supports?.reasoningEffort) return REASONING_EFFORTS;
  return [];
}

export function getAutomaticReasoningEffort(
  model: ModelInfo | undefined,
): ReasoningEffort | undefined {
  const supported = getSupportedReasoningEfforts(model);
  if (model?.id.toLowerCase() === "gpt-5.6-sol" && supported.includes("max")) return "max";
  if (supported.includes("high")) return "high";
  return model?.defaultReasoningEffort;
}

export function formatReasoningEffort(effort: ReasoningEffort): string {
  switch (effort) {
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra high";
    case "max":
      return "Max";
  }
  const exhaustive: never = effort;
  return exhaustive;
}
