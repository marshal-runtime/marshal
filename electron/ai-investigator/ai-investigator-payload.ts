/**
 * Pure helpers for assembling the prompt payload sent to the
 * ai-investigator skill. Kept separate from ai-investigator-manager.ts so
 * that payload assembly can be unit-tested without spinning up Electron,
 * the SDK, or the filesystem.
 *
 * Everything that goes through these helpers MUST be passed through
 * `sanitizeForTelemetry` first by the caller — these functions assume
 * inputs are already sanitized and concern themselves only with
 * trimming/formatting/size capping.
 */

/** Hard cap for the entire prompt sent to the AI. ~64KB is well below the
 *  context limit but keeps payloads small enough to log + post quickly. */
export const AI_INVESTIGATOR_PROMPT_MAX_BYTES = 64 * 1024;

/** Cap on diagnostic-tail bytes within the prompt. */
export const AI_INVESTIGATOR_DIAGNOSTICS_MAX_BYTES = 32 * 1024;

/** Cap on the raw diagnostics tail appended to the posted issue body.
 *  Half of a typical destination's ~65 KB body limit — plenty of room for the
 *  AI's report + future growth. */
export const AI_INVESTIGATOR_ISSUE_DIAGNOSTICS_MAX_BYTES = 16 * 1024;

export interface BuildAIInvestigatorPromptInput {
  /** Pre-sanitized one-line description from the user. */
  userDescription: string;
  /** Pre-sanitized tail of the diagnostics JSONL log. */
  diagnosticsTail: string;
  /** Destination-specific research instructions, supplied by the configured
   *  `IssueReporterProvider`. This module stays provider-neutral. */
  instructions: string;
}

/** Truncate a string to at most `maxBytes` UTF-8 bytes, head-biased: we keep
 *  the head and append an explicit truncation marker if we trim. For diagnostic
 *  logs we keep the *most recent* lines (tail-biased) instead — see
 *  {@link tailTruncate}. */
function headTruncate(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  // Binary search for the largest prefix that fits, to handle multi-byte chars.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes - 64) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo) + "\n…[truncated]…";
}

function tailTruncate(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (Buffer.byteLength(text.slice(text.length - mid), "utf8") <= maxBytes - 64) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return "…[earlier truncated]…\n" + text.slice(text.length - lo);
}

export function buildAIInvestigatorPrompt(input: BuildAIInvestigatorPromptInput): string {
  const description = input.userDescription.trim() || "(no description provided)";

  const diagTrimmed = tailTruncate(input.diagnosticsTail, AI_INVESTIGATOR_DIAGNOSTICS_MAX_BYTES);

  const sections: string[] = [
    input.instructions,
    "",
    "## User description",
    description,
    "",
    "## Diagnostics tail",
    "```",
    diagTrimmed || "(no diagnostics available)",
    "```",
    "",
    AI_INVESTIGATOR_OUTPUT_CONTRACT,
    "",
    "Reminder: emit only the structured markdown report above — no preamble, no closing remarks. The first `# ` line becomes the issue title; everything after becomes the body.",
  ];

  const full = sections.join("\n");
  // Final hard cap (defensive — the diagnostics sub-section is already capped,
  // but overhead from headers etc. could in theory push us over).
  return headTruncate(full, AI_INVESTIGATOR_PROMPT_MAX_BYTES);
}

const AI_INVESTIGATOR_OUTPUT_CONTRACT = [
  "## Output contract",
  "",
  "When you finish, emit **exactly one** markdown report in this format. Nothing before, nothing after — your entire final assistant message must be this report and only this report:",
  "",
  "```",
  "# <Concise issue title (~80 chars max)>",
  "",
  "## Summary",
  "",
  "<1–3 sentence restatement of what the user is reporting, in your own words.>",
  "",
  "## Suspected cause",
  "",
  "<Best guess at where the problem lives, citing specific files, line ranges, and commits. Quote short snippets (≤10 lines, fenced) when helpful. If you don't know, say so plainly.>",
  "",
  "## Reproduction steps",
  "",
  '<Numbered steps derived from diagnostics. If not reconstructible, write "Not reproducible from the captured diagnostics — see the diagnostics excerpt below.">',
  "",
  "## Diagnostics excerpt",
  "",
  "<≤20-line excerpt of the smoking-gun log entries motivating your suspected cause, fenced. Do NOT dump the full log — the issue body already includes a collapsed `<details>` block with the full sanitized tail. If nothing stands out, write `(no relevant diagnostic lines — see full tail below)`.>",
  "```",
].join("\n");

/** Append the full sanitized diagnostics tail to an issue body inside a
 *  collapsed `<details>` block. The AI's report already includes a curated
 *  excerpt at the top; this guarantees the raw tail is always available for
 *  triagers without bloating the issue's default rendering.
 *
 *  - No-op when `diagnosticsTail` is empty.
 *  - Tail-truncates to {@link AI_INVESTIGATOR_ISSUE_DIAGNOSTICS_MAX_BYTES}.
 *  - Caller MUST pass an already-sanitized tail (we don't re-sanitize here —
 *    re-running sanitizers on already-redacted markers like `[EMAIL]` could
 *    mangle them). */
export function appendDiagnosticsToIssueBody(body: string, diagnosticsTail: string): string {
  if (!diagnosticsTail) return body;
  const trimmed = tailTruncate(diagnosticsTail, AI_INVESTIGATOR_ISSUE_DIAGNOSTICS_MAX_BYTES);
  const sizeKb = Math.round(Buffer.byteLength(trimmed, "utf8") / 1024);
  return [
    body.trimEnd(),
    "",
    "",
    "---",
    "",
    `<details>`,
    `<summary>Full diagnostics tail (sanitized, ~${sizeKb} KB)</summary>`,
    "",
    "```",
    trimmed,
    "```",
    "",
    "</details>",
    "",
  ].join("\n");
}

/** Split a structured markdown report into title (first H1) and body
 *  (everything after, with the H1 line removed). Returns nulls when the
 *  report doesn't conform — callers that need a guaranteed
 *  `{title, body}` should use {@link composeInvestigatorReport} instead. */
function parseInvestigatorReport(text: string): { title: string; body: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const lines = trimmed.split(/\r?\n/);
  const h1Index = lines.findIndex((l) => /^#\s+\S/.test(l));
  if (h1Index === -1) return null;
  const titleLine = lines[h1Index].replace(/^#\s+/, "").trim();
  if (!titleLine) return null;
  const bodyLines = lines.slice(h1Index + 1);
  // Strip leading blank lines from the body.
  while (bodyLines.length > 0 && !bodyLines[0].trim()) bodyLines.shift();
  const body = bodyLines.join("\n").trim();
  return { title: titleLine, body: body || "(no investigation report produced)" };
}

/** Maximum length for a synthesized title. */
const SYNTHESIZED_TITLE_MAX_CHARS = 80;
const SYNTHESIZED_TITLE_PREFIX = "AI investigation: ";
/** Used when both the model output and the user description are empty. */
const SYNTHESIZED_TITLE_FALLBACK = "AI investigation report";

/** Always produces a `{ title, body }` from the model's response. Prefers the
 *  AI's own `# H1` when present; otherwise synthesizes the title from the
 *  user's verbatim description (preserving their voice in the issue title)
 *  and uses the model's full text as the body.
 *
 *  Rationale: the only reason to "fail to parse" an investigator response is
 *  to split title from body for the destination's title/body fields. Throwing
 *  the whole 2–3-minute investigation away over a missing `# ` produces a
 *  brutal UX. The user always edits the draft in the modal before posting,
 *  so a synthesized title is fine.
 *
 *  `synthesized` is `true` when the title was derived from `userDescription`
 *  rather than extracted from the model output — callers can use this to log
 *  the malformed response for diagnosis without surfacing an error to the user. */
export function composeInvestigatorReport(
  text: string,
  userDescription: string,
): { title: string; body: string; synthesized: boolean } {
  const parsed = parseInvestigatorReport(text);
  if (parsed) {
    return { title: parsed.title, body: parsed.body, synthesized: false };
  }

  // Synthesize from the user's own description.
  const desc = userDescription.trim().replace(/\s+/g, " ");
  const titleCore = desc
    ? truncateWithEllipsis(desc, SYNTHESIZED_TITLE_MAX_CHARS - SYNTHESIZED_TITLE_PREFIX.length)
    : "";
  const title = titleCore ? `${SYNTHESIZED_TITLE_PREFIX}${titleCore}` : SYNTHESIZED_TITLE_FALLBACK;

  // Body is the model's full response when present, else a placeholder so the
  // issue body isn't empty.
  const body = text.trim() || "(no investigation report produced)";

  return { title, body, synthesized: true };
}

function truncateWithEllipsis(s: string, maxChars: number): string {
  const codepoints = Array.from(s);
  if (codepoints.length <= maxChars) return s;
  // Reserve 1 char for the ellipsis. Never produce the empty string.
  const cut = Math.max(1, maxChars - 1);
  return `${codepoints.slice(0, cut).join("").trimEnd()}…`;
}
