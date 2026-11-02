import type {
  GoalTransitionReviewInput,
  GoalTransitionReviewVerdict,
} from "../../common/goal-contract";
import type { SendAndCollectResult } from "../sessions";
import { fitGoalPayload } from "./goal-context";

export const TRANSITION_REVIEWER_TIMEOUT_MS = 5 * 60_000;

export interface TransitionReviewerDeps {
  createReviewerSession: (sourceSessionId: string) => Promise<string>;
  runPrompt: (
    reviewerSessionId: string,
    prompt: string,
    timeoutMs: number,
  ) => Promise<SendAndCollectResult>;
  disposeSession: (reviewerSessionId: string) => Promise<void>;
}

export function createTransitionReviewer(
  deps: TransitionReviewerDeps,
): (
  input: GoalTransitionReviewInput,
  sourceSessionId: string,
) => Promise<GoalTransitionReviewVerdict> {
  return async (input, sourceSessionId) => {
    const reviewerSessionId = await deps.createReviewerSession(sourceSessionId);
    try {
      const result = await deps.runPrompt(
        reviewerSessionId,
        buildTransitionReviewPrompt(input, sourceSessionId),
        TRANSITION_REVIEWER_TIMEOUT_MS,
      );
      if (result.kind !== "ok") {
        throw new Error(`Transition reviewer returned ${result.kind}`);
      }
      return parseTransitionReviewVerdict(result.text);
    } finally {
      await deps.disposeSession(reviewerSessionId);
    }
  };
}

export function buildTransitionReviewPrompt(
  input: GoalTransitionReviewInput,
  sourceSessionId?: string,
): string {
  const payload = fitGoalPayload({
    goal: input.goal,
    proposal: input.proposal,
    conversationContext: input.conversationContext,
  });
  return [
    "You are the independent reviewer for one proposed goal transition. Your job is to try to DISPROVE the proposal, not to confirm the narrative around it.",
    "You have read-only tools: file reads and glob/grep/rg/view under the goal's repository, goalGet, and getSessionTranscript. Everything else (writes, shell, network, MCP) is denied by policy. You cannot mutate the goal.",
    ...(sourceSessionId ? [`The goal under review lives in session ${sourceSessionId}.`] : []),
    "When the goal carries a sourceInstruction, it points at the user's actual instruction message — read it verbatim (getSessionTranscript on the goal's session) and compare the proposal against the user's words, not against the extracted objective alone. Extraction can itself drop a requirement.",
    "For a completed target: actively hunt for an unmet criterion or an unexercised real path. Inspect at least one claimed artifact or changed file with your read tools before approving; a report about work is a claim, not evidence. Approve only after you fail to find a gap.",
    "For blocked or paused: approve only when the stated reason genuinely prevents productive continuation.",
    'A "truncated" marker in the payload means durable entries or conversation text were omitted for size. Treat omitted content as unknown, not absent — recover the full record with goalGet — and reject completion when you cannot verify every criterion.',
    'When your tools are unavailable or a path is denied, judge only what you can actually verify and reject completion claims you could not check. Return only JSON: {"decision":"approve"} or {"decision":"reject","feedback":"specific remaining work or reason"}.',
    "",
    payload,
  ].join("\n");
}

export function parseTransitionReviewVerdict(text: string): GoalTransitionReviewVerdict {
  const stripped = stripCodeFence(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped) as unknown;
  } catch {
    // A tools-enabled reviewer often narrates its inspection before the JSON
    // verdict. Recover the last embedded {"decision": ...} object instead of
    // failing the review (which would burn bounded retries on a formatting
    // slip); the verdict fields are still validated below.
    const embedded = extractLastVerdictObject(stripped);
    if (embedded === null) throw new Error("Transition reviewer returned malformed JSON");
    try {
      parsed = JSON.parse(embedded) as unknown;
    } catch {
      throw new Error("Transition reviewer returned malformed JSON");
    }
  }
  if (!isRecord(parsed)) throw new Error("Transition reviewer returned a non-object verdict");
  if (parsed.decision === "approve") return { decision: "approve" };
  if (
    parsed.decision === "reject" &&
    typeof parsed.feedback === "string" &&
    parsed.feedback.trim().length > 0
  ) {
    return { decision: "reject", feedback: parsed.feedback.trim().slice(0, 8_000) };
  }
  throw new Error("Transition reviewer returned an invalid verdict");
}

/** Last balanced JSON object starting with a "decision" key, string-aware. */
function extractLastVerdictObject(text: string): string | null {
  const matches = [...text.matchAll(/\{\s*"decision"/g)];
  for (let m = matches.length - 1; m >= 0; m -= 1) {
    const start = matches[m].index;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const char = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
