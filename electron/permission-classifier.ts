import { createLogger } from "../common/marshal-logger";
import {
  FALLBACK_CLASSIFICATION,
  type Category,
  type CommandClassification,
} from "./permission-classification-contracts";
// electron/permission-classifier.ts
import { applyGuardrails } from "./permission-pattern-guardrails";

const log = createLogger("permission-classifier");

export type InferFn = (opts: {
  systemPrompt: string;
  userMessage: string;
  model?: string;
  timeoutMs?: number;
}) => Promise<string>;

export interface ClassifierDeps {
  infer: InferFn;
  isReadOnlyCommand: (command: string) => boolean;
}

const SYSTEM_PROMPT = [
  "Classify a shell command for a permission-approval dialog.",
  'Respond with JSON only, matching: {"explanation":string,"category":"readonly"|"writes"|"network"|"destructive"|"unknown","suggestedPattern":string|null,"patternRationale":string|null}.',
  "explanation: one short non-technical sentence, no jargon.",
  "category: best single fit.",
  "suggestedPattern: a pattern using * wildcards that safely matches future similar commands; null if broadening would be unsafe.",
  "patternRationale: one-sentence justification; null iff suggestedPattern is null.",
].join(" ");

const VALID_CATEGORIES: ReadonlySet<Category> = new Set<Category>([
  "readonly",
  "writes",
  "network",
  "destructive",
  "unknown",
]);

function str(val: unknown): string | null {
  return typeof val === "string" ? val : null;
}

interface ParsedLLMOutput {
  explanation: string;
  category: Category;
  suggestedPattern: string | null;
  patternRationale: string | null;
}

function parseLLMOutput(raw: string): ParsedLLMOutput | null {
  try {
    // SF-4: result is immediately narrowed to unknown and validated field-by-field below
    const obj: unknown = JSON.parse(raw); // SF-4: field-by-field validation follows
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed to object above, casting to index type
    const rec = obj as Record<string, unknown>;
    const category = rec.category;
    if (typeof category !== "string") return null;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed to string above, validated by VALID_CATEGORIES.has() next
    const typedCategory = category as Category;
    if (!VALID_CATEGORIES.has(typedCategory)) return null;
    const explanation = str(rec.explanation) ?? "";
    const suggestedPattern = rec.suggestedPattern === null ? null : str(rec.suggestedPattern);
    const patternRationale = rec.patternRationale === null ? null : str(rec.patternRationale);
    return {
      explanation,
      category: typedCategory,
      suggestedPattern,
      patternRationale,
    };
  } catch {
    return null;
  }
}

export async function classifyShellCommand(
  command: string,
  deps: ClassifierDeps,
): Promise<CommandClassification> {
  const startedAt = Date.now();
  let raw: string;
  try {
    raw = await deps.infer({
      systemPrompt: SYSTEM_PROMPT,
      userMessage: `Classify this command: ${command}`,
      // 15s is the permission-card UX budget — card stays hidden until this resolves.
      timeoutMs: 15_000,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("infer failed", { reason: message, latencyMs: Date.now() - startedAt });
    return FALLBACK_CLASSIFICATION;
  }

  const parsed = parseLLMOutput(raw);
  if (!parsed) {
    log.warn("parse failed", { latencyMs: Date.now() - startedAt });
    return FALLBACK_CLASSIFICATION;
  }

  const beforeGuardrails: CommandClassification = {
    ...parsed,
    source: "llm",
    guardrailRuleId: null,
  };

  const after = applyGuardrails(command, beforeGuardrails, {
    isReadOnlyCommand: deps.isReadOnlyCommand,
  });

  log.info("classified", {
    category: after.category,
    source: after.source,
    guardrailRuleId: after.guardrailRuleId,
    patternKept: after.suggestedPattern !== null,
    latencyMs: Date.now() - startedAt,
  });

  return after;
}
