// Ownership: shared command classification contracts.

// electron/permission-classification-contracts.ts

export type Category = "readonly" | "writes" | "network" | "destructive" | "unknown";

export interface CommandClassification {
  /** One sentence, non-technical. Empty string on fallback. */
  explanation: string;
  category: Category;
  /** null = broadening unsafe or refused. */
  suggestedPattern: string | null;
  /** Non-null iff suggestedPattern is non-null. */
  patternRationale: string | null;
  source: "llm" | "fallback";
  /** Telemetry: which guardrail rule force-nulled the LLM pattern. */
  guardrailRuleId: string | null;
}

/** Sentinel: classification used when no LLM call was made or the call failed. */
export const FALLBACK_CLASSIFICATION: CommandClassification = {
  explanation: "",
  category: "unknown",
  suggestedPattern: null,
  patternRationale: null,
  source: "fallback",
  guardrailRuleId: null,
};
