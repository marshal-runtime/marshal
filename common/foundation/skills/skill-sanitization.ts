/**
 * Shared content-safety validation for custom skill instructions.
 * Used by the main process (IPC handlers, self-tools) to detect model-specific
 * delimiter tokens that have zero legitimate use in skill content.
 *
 * Design: warn, not block — skills are user-authored so we flag suspicious
 * content but never prevent creation.
 */

export interface SanitizationWarning {
  field: "description" | "instructions";
  /** Human-readable name of the matched pattern. */
  pattern: string;
  /** ~60-char window around the match for display. */
  excerpt: string;
}

export interface SanitizationResult {
  warnings: SanitizationWarning[];
}

export const SKILL_DESCRIPTION_MAX_LENGTH = 1_000;
export const SKILL_INSTRUCTIONS_MAX_LENGTH = 100_000;

// -- Pattern registry --------------------------------------------------------
// Only high-confidence model-specific delimiters that have zero legitimate use
// in skill content. Natural-language patterns (e.g. "ignore previous
// instructions") are intentionally excluded — too many false positives with
// security education, prompt engineering, and documentation skills.

interface DelimiterPattern {
  regex: RegExp;
  name: string;
}

const DELIMITER_PATTERNS: DelimiterPattern[] = [
  // ChatML delimiters
  { regex: /<\|im_start\|>/i, name: "ChatML delimiter (<|im_start|>)" },
  { regex: /<\|im_end\|>/i, name: "ChatML delimiter (<|im_end|>)" },
  // Role delimiters
  { regex: /<\|system\|>/i, name: "Role delimiter (<|system|>)" },
  { regex: /<\|user\|>/i, name: "Role delimiter (<|user|>)" },
  { regex: /<\|assistant\|>/i, name: "Role delimiter (<|assistant|>)" },
  // GPT end-of-text
  { regex: /<\|endoftext\|>/i, name: "End-of-text token (<|endoftext|>)" },
  // Llama instruction delimiters
  { regex: /\[INST\]/i, name: "Llama delimiter ([INST])" },
  { regex: /\[\/INST\]/i, name: "Llama delimiter ([/INST])" },
  // Llama 3 special tokens
  { regex: /<\|begin_of_text\|>/i, name: "Llama 3 token (<|begin_of_text|>)" },
  { regex: /<\|end_of_text\|>/i, name: "Llama 3 token (<|end_of_text|>)" },
];

const EXCERPT_RADIUS = 30;

function extractExcerpt(text: string, matchIndex: number, matchLength: number): string {
  const start = Math.max(0, matchIndex - EXCERPT_RADIUS);
  const end = Math.min(text.length, matchIndex + matchLength + EXCERPT_RADIUS);
  let excerpt = text.slice(start, end).replace(/\n/g, " ");
  if (start > 0) excerpt = "..." + excerpt;
  if (end < text.length) excerpt = excerpt + "...";
  return excerpt;
}

function warningForLimit(field: SanitizationWarning["field"], limit: number): SanitizationWarning {
  const label = field === "description" ? "Description" : "Instructions";
  return {
    field,
    pattern: "Content truncated",
    excerpt: `${label} exceeded ${limit.toLocaleString()} character limit`,
  };
}

function scanField(text: string, field: SanitizationWarning["field"]): SanitizationWarning[] {
  const warnings: SanitizationWarning[] = [];
  for (const { regex, name } of DELIMITER_PATTERNS) {
    const match = regex.exec(text);
    if (match) {
      warnings.push({
        field,
        pattern: name,
        excerpt: extractExcerpt(text, match.index, match[0].length),
      });
    }
  }
  return warnings;
}

/**
 * Check skill description and instructions for model-specific delimiter tokens.
 * Returns warnings (possibly empty). Use `sanitizeSkillContent()` for the
 * combined truncation + safety check in a single call.
 */
export function checkSkillContentSafety(
  description: string,
  instructions: string,
): SanitizationResult {
  return {
    warnings: [
      ...scanField(description, "description"),
      ...scanField(instructions, "instructions"),
    ],
  };
}

/**
 * Truncate description and instructions to their respective length limits.
 * Returns the (possibly truncated) strings and which fields were truncated.
 */
export function truncateSkillContent(
  description: string,
  instructions: string,
): {
  description: string;
  instructions: string;
  descriptionTruncated: boolean;
  instructionsTruncated: boolean;
} {
  const descriptionTruncated = description.length > SKILL_DESCRIPTION_MAX_LENGTH;
  const instructionsTruncated = instructions.length > SKILL_INSTRUCTIONS_MAX_LENGTH;
  return {
    description: descriptionTruncated
      ? description.slice(0, SKILL_DESCRIPTION_MAX_LENGTH)
      : description,
    instructions: instructionsTruncated
      ? instructions.slice(0, SKILL_INSTRUCTIONS_MAX_LENGTH)
      : instructions,
    descriptionTruncated,
    instructionsTruncated,
  };
}

/**
 * Combined truncation + safety check. Truncates content to length limits, then
 * scans for model-specific delimiter tokens. Returns sanitized content and all
 * warnings (truncation + delimiter detection).
 *
 * This is the primary entry point for callers — use instead of calling
 * `truncateSkillContent()` and `checkSkillContentSafety()` separately.
 */
export function sanitizeSkillContent(
  description: string,
  instructions: string,
): { description: string; instructions: string; warnings: SanitizationWarning[] } {
  const truncated = truncateSkillContent(description, instructions);
  const { warnings } = checkSkillContentSafety(truncated.description, truncated.instructions);
  const allWarnings: SanitizationWarning[] = [];
  if (truncated.descriptionTruncated) {
    allWarnings.push(warningForLimit("description", SKILL_DESCRIPTION_MAX_LENGTH));
  }
  if (truncated.instructionsTruncated) {
    allWarnings.push(warningForLimit("instructions", SKILL_INSTRUCTIONS_MAX_LENGTH));
  }
  allWarnings.push(...warnings);
  return {
    description: truncated.description,
    instructions: truncated.instructions,
    warnings: allWarnings,
  };
}
