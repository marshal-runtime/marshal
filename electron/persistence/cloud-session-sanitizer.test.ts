import { describe, expect, it } from "vitest";

import { GOAL_DOCUMENT_SCHEMA_VERSION } from "../../common/goal-contract";
import { GoalDocumentV2Schema } from "../schemas/goal-schema";
import type { PersistedSession, SessionsIndex } from "../session-store";
import {
  createGoalRedactionFixture,
  GOAL_REDACTION_SENTINEL,
} from "../test-helpers/goal-redaction-fixture";
import {
  prepareGoalForCloudStorage,
  sanitizePortableGoalTree,
  sanitizeSessionForCloudStorage,
  sanitizeSessionsIndexForCloudStorage,
} from "./cloud-session-sanitizer";

describe("cloud session sanitizer", () => {
  it("redacts the complete minimal goal record without changing structural identity", () => {
    const goal = createGoalRedactionFixture();
    const sanitized = prepareGoalForCloudStorage(goal);

    expect(JSON.stringify(sanitized.value)).not.toContain(GOAL_REDACTION_SENTINEL);
    expect(JSON.stringify(goal)).toContain(GOAL_REDACTION_SENTINEL);
    expect(sanitized.redactionCount).toBeGreaterThanOrEqual(8);
    expect(GoalDocumentV2Schema.safeParse(sanitized.value).success).toBe(true);
    expect(sanitized.value).toMatchObject({
      id: goal.id,
      schemaVersion: 3,
      status: goal.status,
      epoch: goal.epoch,
      continuationCount: goal.continuationCount,
    });
    expect(sanitized.value.state).toHaveProperty("nested");
    expect(sanitized.value).not.toHaveProperty("validationGraph");
    expect(sanitized.value).not.toHaveProperty("evidence");
  });

  it("redacts newly introduced text recursively while preserving explicit IDs and digests", () => {
    const future = {
      id: `future-${GOAL_REDACTION_SENTINEL}`,
      digest: GOAL_REDACTION_SENTINEL,
      futureText: `future ${GOAL_REDACTION_SENTINEL}`,
      nested: [{ summary: GOAL_REDACTION_SENTINEL }],
      scratchpad: { id: GOAL_REDACTION_SENTINEL },
    };

    const sanitized = sanitizePortableGoalTree(future).value;

    expect(sanitized.id).toBe(future.id);
    expect(sanitized.digest).toBe(future.digest);
    expect(sanitized.futureText).not.toContain(GOAL_REDACTION_SENTINEL);
    expect(sanitized.nested[0]?.summary).not.toContain(GOAL_REDACTION_SENTINEL);
    expect(sanitized.scratchpad.id).not.toContain(GOAL_REDACTION_SENTINEL);
  });

  it("migrates legacy goal state before applying cloud redaction", () => {
    const sanitized = prepareGoalForCloudStorage({
      id: "legacy-goal",
      objective: `legacy ${GOAL_REDACTION_SENTINEL}`,
      acceptanceCriteria: [`legacy criterion ${GOAL_REDACTION_SENTINEL}`],
      status: "pursuing",
      createdAt: "2026-07-25T10:00:00.000Z",
      updatedAt: "2026-07-25T10:01:00.000Z",
      tokensUsed: 0,
      activeMs: 0,
      continuationCount: 0,
    });

    expect(sanitized.value.schemaVersion).toBe(3);
    expect(JSON.stringify(sanitized.value)).not.toContain(GOAL_REDACTION_SENTINEL);
    expect(GoalDocumentV2Schema.safeParse(sanitized.value).success).toBe(true);
  });

  it("sanitizes session and index projections without mutating the in-memory source", () => {
    const session: PersistedSession = {
      id: "session-1",
      name: `Goal ${GOAL_REDACTION_SENTINEL}`,
      createdAt: "2026-07-25T10:00:00.000Z",
      updatedAt: "2026-07-25T10:01:00.000Z",
      hasUnread: false,
      isActive: false,
      messages: [
        {
          id: "message-1",
          role: "assistant",
          content: `message ${GOAL_REDACTION_SENTINEL}`,
          timestamp: "2026-07-25T10:01:00.000Z",
        },
      ],
      aiGeneratedTitle: `Title ${GOAL_REDACTION_SENTINEL}`,
      repositoryAgent: {
        name: `Reviewer ${GOAL_REDACTION_SENTINEL}`,
        path: `.github/${GOAL_REDACTION_SENTINEL}.agent.md`,
        description: `Description ${GOAL_REDACTION_SENTINEL}`,
        identity: {
          version: 1,
          normalizedPath: ".github/agents/reviewer.agent.md",
          declaredName: "Reviewer",
          contentDigest: "sha256:repository-agent",
        },
      },
      goal: createGoalRedactionFixture(),
    };
    Reflect.set(session.repositoryAgent!, "instructions", GOAL_REDACTION_SENTINEL);
    const index: SessionsIndex = {
      sessions: [
        {
          id: session.id,
          name: session.name,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          hasUnread: session.hasUnread,
          isActive: session.isActive,
          repositoryAgent: session.repositoryAgent,
        },
      ],
      activeSessionId: session.id,
    };

    const sanitizedSession = sanitizeSessionForCloudStorage(session);
    const sanitizedIndex = sanitizeSessionsIndexForCloudStorage(index);

    expect(JSON.stringify(sanitizedSession.value)).not.toContain(GOAL_REDACTION_SENTINEL);
    expect(JSON.stringify(sanitizedIndex.value)).not.toContain(GOAL_REDACTION_SENTINEL);
    expect(JSON.stringify(session)).toContain(GOAL_REDACTION_SENTINEL);
    expect(sanitizedSession.value.id).toBe(session.id);
    expect(sanitizedSession.value.goal?.schemaVersion).toBe(GOAL_DOCUMENT_SCHEMA_VERSION);
    expect(sanitizedSession.value.repositoryAgent?.identity).toEqual(
      session.repositoryAgent?.identity,
    );
    expect(
      Reflect.get(sanitizedSession.value.repositoryAgent ?? {}, "instructions"),
    ).toBeUndefined();
  });

  it("sanitizes live turn checkpoints before cloud persistence", () => {
    const session: PersistedSession = {
      id: "live-session",
      name: "Live session",
      createdAt: "2026-07-25T10:00:00.000Z",
      updatedAt: "2026-07-25T10:01:00.000Z",
      hasUnread: false,
      isActive: true,
      messages: [],
      liveTurnCheckpoint: {
        version: 1,
        ownerId: "process-1",
        message: {
          id: "live-message",
          role: "assistant",
          content: `live ${GOAL_REDACTION_SENTINEL}`,
          timestamp: "2026-07-25T10:01:30.000Z",
          contentBlocks: [
            {
              id: "live-text",
              type: "text",
              content: `block ${GOAL_REDACTION_SENTINEL}`,
            },
          ],
        },
        updatedAt: "2026-07-25T10:01:31.000Z",
      },
    };

    const sanitized = sanitizeSessionForCloudStorage(session);

    expect(JSON.stringify(sanitized.value.liveTurnCheckpoint)).not.toContain(
      GOAL_REDACTION_SENTINEL,
    );
    expect(JSON.stringify(session.liveTurnCheckpoint)).toContain(GOAL_REDACTION_SENTINEL);
  });
});
