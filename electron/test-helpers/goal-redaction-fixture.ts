import type { GoalDocumentV2 } from "../../common/goal-contract";
import { createInitialGoalDocument } from "../schemas/goal-schema";

export const GOAL_REDACTION_SENTINEL = "ghp_" + "R".repeat(36);

function sensitive(label: string): string {
  return `${label} ${GOAL_REDACTION_SENTINEL}`;
}

export function createGoalRedactionFixture(): GoalDocumentV2 {
  return {
    ...createInitialGoalDocument({
      id: "goal-redaction",
      objective: sensitive("objective"),
      criteria: [sensitive("criterion")],
      now: "2026-07-25T10:00:00.000Z",
    }),
    updatedAt: "2026-07-25T10:01:00.000Z",
    progress: [sensitive("progress")],
    openQuestions: [sensitive("question")],
    assumptions: [sensitive("assumption")],
    decisions: [sensitive("decision")],
    state: {
      note: sensitive("state note"),
      nested: { summary: sensitive("nested state") },
    },
    continuationCount: 1,
    activeMs: 20,
    tokensUsed: 10,
  };
}
