/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { GoalTransitionReviewInput } from "../../common/goal-contract";
import { REVIEWER_SESSION_CAPABILITIES } from "../../common/marshal-ipc-contract";
import { createClaudeClientFactory } from "../backend/claude/client-factory";
import type {
  RuntimePermissionHandler,
  RuntimePermissionRequest,
} from "../backend/runtime-contract";
import type { ApprovalRequest } from "../backend/types";
import { PermissionPolicy, REVIEWER_ALLOWED_CUSTOM_TOOLS } from "../permission-policy";
import type { SettingsManager } from "../settings-manager";
import { testDouble } from "../testing/harness";
import { buildTransitionReviewPrompt, parseTransitionReviewVerdict } from "./transition-reviewer";

/**
 * Gated real-provider smoke that exercises the PRODUCTION reviewer wiring
 * against the audit's reviewer-challenge fixtures — the actual
 * buildTransitionReviewPrompt, the actual PermissionPolicy in
 * read-only-reviewer mode with a registered ReviewerSessionPermissionScope
 * (the same shape main.ts registers), and the actual Claude backend client
 * the app ships. This is deliberately NOT the standalone `claude` CLI smoke:
 * every tool call the reviewer makes is classified by the fail-closed
 * ReviewerToolPolicy, and the decision log is persisted with the verdict.
 *
 * Run manually (spends real provider tokens; skipped everywhere else):
 *   MARSHAL_REVIEWER_FIXTURE_SMOKE=1 pnpm vitest run \
 *     electron/goal/reviewer-fixture-smoke.test.ts
 *
 * Judgment assertions are single-run model behavior, not a benchmark; the
 * results JSON (written before any assertion) is the durable record either way.
 */
const FIXTURE_ROOT =
  process.env.REVIEWER_FIXTURE_ROOT ??
  "/Users/omer/marshal/harness-audit-2026-09-09/reviewer-challenge";
const enabled = process.env.MARSHAL_REVIEWER_FIXTURE_SMOKE === "1" && fs.existsSync(FIXTURE_ROOT);

interface DecisionRecord {
  kind: string;
  detail: string;
  decision: string;
}

function reviewerPolicy(artifactDir: string): PermissionPolicy {
  return new PermissionPolicy({
    settingsManager: testDouble<SettingsManager>({
      get: () => ({
        permissions: {
          autoApproveReadOnly: false,
          allow: [],
          tools: {},
          servers: {
            filesystem: { enabled: true, autoApprove: false },
            playwright: { enabled: true, autoApprove: false },
            shell: { enabled: true, autoApprove: false },
          },
        },
      }),
      update: vi.fn<(s: Record<string, unknown>) => void>(),
    }),
    getPermissionMode: () => "read-only-reviewer",
    // The exact scope shape main.ts registers for a transition reviewer.
    getReviewerSessionPermissionScope: () => ({
      ...REVIEWER_SESSION_CAPABILITIES,
      role: "reviewer",
      repoPath: artifactDir,
      allowedTools: [...REVIEWER_ALLOWED_CUSTOM_TOOLS],
      folderGrants: { read: [artifactDir], write: [] },
      skills: [],
      mcp: [],
      verificationRoot: artifactDir,
    }),
  });
}

function toApprovalRequest(request: RuntimePermissionRequest): ApprovalRequest {
  return testDouble<ApprovalRequest>({
    id: `fixture-${Math.random().toString(36).slice(2)}`,
    sessionId: "fixture-reviewer",
    ...request,
  });
}

async function runCase(
  caseName: string,
  expected: "approve" | "reject",
): Promise<{
  verdict: ReturnType<typeof parseTransitionReviewVerdict>;
  decisions: DecisionRecord[];
}> {
  const caseDir = path.join(FIXTURE_ROOT, caseName);
  const artifactDir = path.join(caseDir, "artifact");
  // SF-4: fixture file authored by the audit reviewer; shaped as the
  // production GoalTransitionReviewInput via the centralized test cast.
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(caseDir, "review-input.json"), "utf8"));
  if (typeof raw !== "object" || raw === null)
    throw new Error("review-input.json is not an object");
  const input = testDouble<GoalTransitionReviewInput>(raw);

  const policy = reviewerPolicy(artifactDir);
  const decisions: DecisionRecord[] = [];
  const onPermissionRequest: RuntimePermissionHandler = (request) => {
    const decision = policy.evaluate(toApprovalRequest(request));
    const fields = request as Record<string, unknown>;
    const detail = [fields.path, fields.toolName, fields.command].find(
      (value): value is string => typeof value === "string",
    );
    decisions.push({
      kind: request.kind,
      detail: detail ?? "",
      decision,
    });
    return decision === "approve"
      ? { kind: "approve-once" }
      : { kind: "reject", feedback: "Blocked by the read-only reviewer policy." };
  };

  const factory = createClaudeClientFactory();
  const client = await factory(artifactDir);
  const session = await client.createSession({
    cwd: artifactDir,
    workingDirectory: artifactDir,
    availableTools: ["Read", "Glob", "Grep"],
    onPermissionRequest,
  });
  // The verdict is the last assistant message of the turn; collect through the
  // event stream (tool-use turns can end without the result event carrying the
  // final assistant message).
  let lastAssistantText = "";
  session.on((event) => {
    if (event.type === "assistant.message" && event.data.content.trim()) {
      lastAssistantText = event.data.content;
    }
  });
  const resultsDir = path.join(FIXTURE_ROOT, "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const record = (payload: Record<string, unknown>) =>
    fs.writeFileSync(
      path.join(resultsDir, `${caseName}-production-wiring.json`),
      JSON.stringify(
        { at: new Date().toISOString(), caseName, expected, decisions, ...payload },
        null,
        2,
      ),
    );
  try {
    const reply = await session.sendAndWait(
      { prompt: buildTransitionReviewPrompt(input, "fixture-goal-session") },
      8 * 60_000,
    );
    const text = (reply?.data.content?.trim() ? reply.data.content : lastAssistantText) ?? "";
    record({ raw: text });
    const verdict = parseTransitionReviewVerdict(text);
    record({ raw: text, verdict });
    return { verdict, decisions };
  } finally {
    await session.destroy().catch(() => undefined);
  }
}

// Note on the decision log: the Claude SDK fast-path allows in-cwd
// Read/Glob/Grep without consulting canUseTool, so a clean read-only review
// can produce an empty decision log — the reviewer's file inspection shows up
// in its analysis instead. Mutating/network tools DO consult the handler and
// the registered scope denies them (pinned by reviewer-session-scope.test.ts);
// the log records any such attempt.
describe.skipIf(!enabled)("reviewer fixture smoke — production wiring, real provider", () => {
  it("rejects the completion whose entrypoint never dispatches the fix agent", async () => {
    const { verdict, decisions } = await runCase("case-1-missing-integration", "reject");
    // No mutating/network tool slipped through the policy.
    expect(
      decisions.filter((entry) => entry.decision === "approve" && entry.kind !== "read"),
    ).toEqual([]);
    // Judgment (single-run): the inspected entrypoint exposes the gap, and
    // the feedback names it.
    expect(verdict).toMatchObject({
      decision: "reject",
      feedback: expect.stringMatching(/fix|dispatch|disposition|unclaimed|entrypoint|pipeline/i),
    });
  }, 600_000);

  it("approves the explicitly re-scoped completion", async () => {
    const { verdict, decisions } = await runCase("case-2-scoped-success", "approve");
    expect(
      decisions.filter((entry) => entry.decision === "approve" && entry.kind !== "read"),
    ).toEqual([]);
    expect(verdict.decision).toBe("approve");
  }, 600_000);
});
