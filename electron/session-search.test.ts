import { describe, it, expect } from "vitest";

import type { SessionMessage, SessionMetadata } from "../common/marshal-ipc-contract";
import { isConditionCheckSession, searchSessions, type SessionSearchDeps } from "./session-search";
import type { SessionsIndex, PersistedSession } from "./session-store";
import { GOAL_REDACTION_SENTINEL } from "./test-helpers/goal-redaction-fixture";

// ---------------------------------------------------------------------------
// isConditionCheckSession
// ---------------------------------------------------------------------------

describe("isConditionCheckSession()", () => {
  it('returns true for { source: "automation" } with no automationId', () => {
    expect(isConditionCheckSession({ source: "automation" })).toBe(true);
  });

  it('returns true for { source: "workflow" } with no workflowId (legacy)', () => {
    expect(isConditionCheckSession({ source: "workflow" })).toBe(true);
  });

  it('returns false for { source: "automation", automationId: "123" }', () => {
    expect(isConditionCheckSession({ source: "automation", automationId: "123" })).toBe(false);
  });

  it('returns false for { source: "workflow", workflowId: "w1" } (legacy with ID)', () => {
    expect(isConditionCheckSession({ source: "workflow", workflowId: "w1" })).toBe(false);
  });

  it('returns false for { source: "user" }', () => {
    expect(isConditionCheckSession({ source: "user" })).toBe(false);
  });

  it("returns false for {}", () => {
    expect(isConditionCheckSession({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// searchSessions
// ---------------------------------------------------------------------------

function makeMeta(
  id: string,
  name: string,
  source?: SessionMetadata["source"],
  automationId?: string,
): SessionMetadata {
  return {
    id,
    name,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    hasUnread: false,
    isActive: false,
    source,
    automationId,
    backendOrigin: "copilot",
  };
}

function makeSession(
  id: string,
  name: string,
  messages: Array<
    Pick<SessionMessage, "role" | "content"> & Partial<Omit<SessionMessage, "role" | "content">>
  >,
): PersistedSession {
  return {
    id,
    name,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    hasUnread: false,
    isActive: false,
    messages: messages.map((message, index) => ({
      ...message,
      id: message.id ?? `msg-${index}`,
      timestamp: message.timestamp ?? "2025-01-01T00:00:00Z",
    })),
  };
}

function createDeps(
  index: SessionsIndex,
  sessionMap: Record<string, PersistedSession>,
  runtimeId = "copilot",
): SessionSearchDeps {
  return {
    loadIndex: () => index,
    loadSessionDataAsync: async (id: string) => sessionMap[id] ?? null,
    runtimeId,
  };
}

describe("searchSessions()", () => {
  it("returns empty array for empty query", async () => {
    const deps = createDeps({ sessions: [], activeSessionId: null }, {});
    const results = await searchSessions(deps, "");
    expect(results).toEqual([]);
  });

  it("returns empty array for whitespace-only query", async () => {
    const deps = createDeps({ sessions: [], activeSessionId: null }, {});
    const results = await searchSessions(deps, "   ");
    expect(results).toEqual([]);
  });

  it("finds sessions by name match", async () => {
    const meta = makeMeta("s1", "Budget Planning", "user");
    const session = makeSession("s1", "Budget Planning", [{ role: "user", content: "hello" }]);
    const deps = createDeps({ sessions: [meta], activeSessionId: null }, { s1: session });

    const results = await searchSessions(deps, "budget");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("s1");
  });

  it("finds sessions by message content match", async () => {
    const meta = makeMeta("s1", "General Chat", "user");
    const session = makeSession("s1", "General Chat", [
      { role: "user", content: "Can you help me with the quarterly report?" },
    ]);
    const deps = createDeps({ sessions: [meta], activeSessionId: null }, { s1: session });

    const results = await searchSessions(deps, "quarterly");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("s1");
  });

  it("does not match or return snippets from non-conversational control messages", async () => {
    const meta = makeMeta("s1", "General Chat", "user");
    const session = makeSession("s1", "General Chat", [
      { role: "assistant", content: "PRIVATE_INTERNAL_COMPOSER_RESULT" },
      {
        role: "system",
        content: "PRIVATE_READINESS_STATUS",
        agentMessage: {
          source: "child-1",
          sourceLabel: "Worker",
          sourceSessionSource: "subagent",
          kind: "readiness",
          deliveryMode: "queue",
          sequence: 2,
          readinessGeneration: "generation-2",
        },
      },
      { role: "assistant", content: "PRIVATE_READINESS_REPLY" },
      { role: "assistant", content: "Visible ordinary reply" },
    ]);
    session.messages[0].internalControl = {
      kind: "goal-continuation-composer",
      exchangeId: "goal-continuation:goal-1:1",
      side: "response",
    };
    session.messages[2].suppressedAgentStatusResponse = true;
    const deps = createDeps({ sessions: [meta], activeSessionId: null }, { s1: session });

    await expect(searchSessions(deps, "PRIVATE_INTERNAL_COMPOSER_RESULT")).resolves.toEqual([]);
    await expect(searchSessions(deps, "PRIVATE_READINESS_STATUS")).resolves.toEqual([]);
    await expect(searchSessions(deps, "PRIVATE_READINESS_REPLY")).resolves.toEqual([]);
    await expect(searchSessions(deps, "ordinary")).resolves.toMatchObject([
      {
        id: "s1",
        snippets: [expect.stringContaining("Visible ordinary reply")],
      },
    ]);
  });

  it("searches visible assistant work produced by a hidden readiness wake", async () => {
    const meta = makeMeta("s1", "General Chat", "user");
    const session = makeSession("s1", "General Chat", [
      {
        role: "user",
        content: "PRIVATE_PARENT_WAKE_PROMPT",
        internalControl: {
          kind: "subagent-readiness",
          exchangeId: "subagent-readiness:s1:test",
          side: "request",
        },
      },
      {
        role: "assistant",
        content: "Integrated the validator results.",
        internalControl: {
          kind: "subagent-readiness",
          exchangeId: "subagent-readiness:s1:test",
          side: "response",
        },
      },
    ]);
    const deps = createDeps({ sessions: [meta], activeSessionId: null }, { s1: session });

    await expect(searchSessions(deps, "PRIVATE_PARENT_WAKE_PROMPT")).resolves.toEqual([]);
    await expect(searchSessions(deps, "validator")).resolves.toMatchObject([
      {
        id: "s1",
        snippets: [expect.stringContaining("Integrated the validator results.")],
      },
    ]);
  });

  it("excludes condition-check sessions", async () => {
    const conditionCheck = makeMeta("s1", "Automation Check", "automation");
    const real = makeMeta("s2", "User Chat", "user");
    const sessions = {
      s1: makeSession("s1", "Automation Check", [{ role: "user", content: "test keyword" }]),
      s2: makeSession("s2", "User Chat", [{ role: "user", content: "test keyword" }]),
    };
    const deps = createDeps({ sessions: [conditionCheck, real], activeSessionId: null }, sessions);

    const results = await searchSessions(deps, "keyword");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("s2");
  });

  it("excludes workflow-run host sessions", async () => {
    const workflowHost = makeMeta("s1", "Workflow: Incident run", "workflow-run");
    const userMeta = makeMeta("s2", "User Session", "user");
    const sessions = {
      s1: makeSession("s1", "Workflow: Incident run", [
        { role: "user", content: "important data" },
      ]),
      s2: makeSession("s2", "User Session", [{ role: "user", content: "important data" }]),
    };
    const deps = createDeps(
      { sessions: [workflowHost, userMeta], activeSessionId: null },
      sessions,
    );

    const results = await searchSessions(deps, "important");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("s2");
  });

  it("respects maxResults limit", async () => {
    const metas = Array.from({ length: 5 }, (_, i) => makeMeta(`s${i}`, `Session ${i}`, "user"));
    const sessions: Record<string, PersistedSession> = {};
    for (let i = 0; i < 5; i++) {
      sessions[`s${i}`] = makeSession(`s${i}`, `Session ${i}`, [
        { role: "user", content: "common search term" },
      ]);
    }
    const deps = createDeps({ sessions: metas, activeSessionId: null }, sessions);

    const results = await searchSessions(deps, "common", 2);
    expect(results).toHaveLength(2);
  });

  it("ranks name matches above message-only matches", async () => {
    const nameMatch = makeMeta("s1", "Budget Report", "user");
    const contentMatch = makeMeta("s2", "General Chat", "user");
    const sessions = {
      s1: makeSession("s1", "Budget Report", [{ role: "user", content: "hello" }]),
      s2: makeSession("s2", "General Chat", [
        { role: "user", content: "Let me find the budget figures" },
      ]),
    };
    const deps = createDeps(
      { sessions: [nameMatch, contentMatch], activeSessionId: null },
      sessions,
    );

    const results = await searchSessions(deps, "budget");
    expect(results).toHaveLength(2);
    // Name match (score +3) should rank above content match (score +1)
    expect(results[0].id).toBe("s1");
    expect(results[1].id).toBe("s2");
  });

  it("returns snippets around matched text", async () => {
    const meta = makeMeta("s1", "Research", "user");
    const longContent =
      "This is some preamble text. The important keyword appears here in the middle of a longer message that continues on.";
    const session = makeSession("s1", "Research", [{ role: "user", content: longContent }]);
    const deps = createDeps({ sessions: [meta], activeSessionId: null }, { s1: session });

    const results = await searchSessions(deps, "keyword");
    expect(results).toHaveLength(1);
    expect(results[0].snippets).toHaveLength(1);
    expect(results[0].snippets[0]).toContain("keyword");
    // Snippet should be prefixed with the role
    expect(results[0].snippets[0]).toMatch(/^\[user\]/);
  });

  it("redacts secrets from returned metadata and snippets", async () => {
    const meta = makeMeta("s1", `Goal ${GOAL_REDACTION_SENTINEL}`, "user");
    const session = makeSession("s1", meta.name, [
      { role: "user", content: `credential ${GOAL_REDACTION_SENTINEL}` },
    ]);
    const deps = createDeps({ sessions: [meta], activeSessionId: null }, { s1: session });

    const results = await searchSessions(deps, "ghp_");

    expect(results).toHaveLength(1);
    expect(JSON.stringify(results)).not.toContain(GOAL_REDACTION_SENTINEL);
    expect(results[0].name).toContain("[REDACTED:github-pat]");
    expect(results[0].snippets[0]).toContain("[REDACTED:github-pat]");
  });

  // ── Runtime filtering ─────────────────────────────────────────────────

  describe("cross-runtime isolation (clean-slate switching)", () => {
    it("copilot search hides gateway sessions and legacy sessions that default to another runtime", async () => {
      const copilotMeta = { ...makeMeta("c1", "Copilot chat"), backendOrigin: "copilot" as const };
      const gatewayMeta = { ...makeMeta("g1", "Gateway chat"), backendOrigin: "gateway" as const };
      const legacyMeta = { ...makeMeta("l1", "Legacy chat"), backendOrigin: undefined };
      const deps = createDeps(
        {
          sessions: [copilotMeta, gatewayMeta, legacyMeta],
          activeSessionId: null,
        },
        {
          c1: makeSession("c1", "Copilot chat", [{ role: "user", content: "hi" }]),
          g1: makeSession("g1", "Gateway chat", [{ role: "user", content: "hi" }]),
          l1: makeSession("l1", "Legacy chat", [{ role: "user", content: "hi" }]),
        },
        "copilot",
      );
      const results = await searchSessions(deps, "chat");
      expect(results.map((r) => r.id).sort()).toEqual(["c1"]);
    });

    it("gateway search hides copilot sessions + pre-migration legacy sessions", async () => {
      const copilotMeta = { ...makeMeta("c1", "Copilot chat"), backendOrigin: "copilot" as const };
      const gatewayMeta = { ...makeMeta("g1", "Gateway chat"), backendOrigin: "gateway" as const };
      const legacyMeta = { ...makeMeta("l1", "Legacy chat"), backendOrigin: undefined };
      const deps = createDeps(
        {
          sessions: [copilotMeta, gatewayMeta, legacyMeta],
          activeSessionId: null,
        },
        {
          c1: makeSession("c1", "Copilot chat", [{ role: "user", content: "hi" }]),
          g1: makeSession("g1", "Gateway chat", [{ role: "user", content: "hi" }]),
          l1: makeSession("l1", "Legacy chat", [{ role: "user", content: "hi" }]),
        },
        "gateway",
      );
      const results = await searchSessions(deps, "chat");
      expect(results.map((r) => r.id)).toEqual(["g1"]);
    });

    it("separates local runtime adapters that share the copilot backend origin", async () => {
      const copilotMeta = {
        ...makeMeta("c1", "Copilot chat"),
        runtimeId: "copilot",
        backendOrigin: "copilot" as const,
      };
      const codexMeta = {
        ...makeMeta("x1", "Codex chat"),
        runtimeId: "codex",
        backendOrigin: "copilot" as const,
      };
      const deps = createDeps(
        { sessions: [copilotMeta, codexMeta], activeSessionId: null },
        {
          c1: makeSession("c1", "Copilot chat", [{ role: "user", content: "shared term" }]),
          x1: makeSession("x1", "Codex chat", [{ role: "user", content: "shared term" }]),
        },
        "codex",
      );

      const results = await searchSessions(deps, "term");

      expect(results.map((result) => result.id)).toEqual(["x1"]);
    });
  });
});
