import { describe, expect, it } from "vitest";

import { evaluateRestartGuard, type RestartGuardSession } from "./app-restart-guard";

function session(
  overrides: Partial<RestartGuardSession> & { sessionId: string },
): RestartGuardSession {
  return { busy: false, ...overrides };
}

describe("evaluateRestartGuard", () => {
  it("allows when no other session is busy", () => {
    const result = evaluateRestartGuard({
      requesterSessionId: "req",
      force: false,
      sessions: [session({ sessionId: "req", busy: true }), session({ sessionId: "idle-1" })],
    });
    expect(result).toEqual({ allowed: true, blockingSessions: [] });
  });

  it("does not count the requester's own busy state against it", () => {
    const result = evaluateRestartGuard({
      requesterSessionId: "req",
      force: false,
      sessions: [session({ sessionId: "req", busy: true })],
    });
    expect(result.allowed).toBe(true);
  });

  it("excludes the requester's lineage (its subagents and its parent chain)", () => {
    const result = evaluateRestartGuard({
      requesterSessionId: "req",
      force: false,
      sessions: [
        session({ sessionId: "parent", busy: true }),
        session({ sessionId: "req", busy: true, parentSessionId: "parent" }),
        session({ sessionId: "child", busy: true, parentSessionId: "req" }),
        session({ sessionId: "grandchild", busy: true, parentSessionId: "child" }),
      ],
    });
    expect(result.allowed).toBe(true);
    expect(result.blockingSessions).toEqual([]);
  });

  it("refuses when an unrelated session is busy, listing the blockers", () => {
    const result = evaluateRestartGuard({
      requesterSessionId: "req",
      force: false,
      sessions: [
        session({ sessionId: "req", busy: true }),
        session({ sessionId: "other-1", busy: true, label: "mobile lane" }),
        session({ sessionId: "other-2", busy: true }),
        session({ sessionId: "other-idle" }),
      ],
    });
    expect(result.allowed).toBe(false);
    expect(result.blockingSessions.map((s) => s.sessionId)).toEqual(["other-1", "other-2"]);
    expect(result.blockingSessions[0]?.label).toBe("mobile lane");
  });

  it("refuses for a busy sibling subagent of a shared parent (siblings are not lineage)", () => {
    const result = evaluateRestartGuard({
      requesterSessionId: "req",
      force: false,
      sessions: [
        session({ sessionId: "parent", busy: false }),
        session({ sessionId: "req", busy: true, parentSessionId: "parent" }),
        session({ sessionId: "sibling", busy: true, parentSessionId: "parent" }),
      ],
    });
    expect(result.allowed).toBe(false);
    expect(result.blockingSessions.map((s) => s.sessionId)).toEqual(["sibling"]);
  });

  it("force overrides busy unrelated sessions but still reports them", () => {
    const result = evaluateRestartGuard({
      requesterSessionId: "req",
      force: true,
      sessions: [
        session({ sessionId: "req", busy: true }),
        session({ sessionId: "other-1", busy: true }),
      ],
    });
    expect(result.allowed).toBe(true);
    expect(result.blockingSessions.map((s) => s.sessionId)).toEqual(["other-1"]);
  });

  it("handles a requester unknown to the session list (treats it as lineage of itself only)", () => {
    const result = evaluateRestartGuard({
      requesterSessionId: "ghost",
      force: false,
      sessions: [session({ sessionId: "other", busy: true })],
    });
    expect(result.allowed).toBe(false);
    expect(result.blockingSessions.map((s) => s.sessionId)).toEqual(["other"]);
  });

  it("tolerates parent cycles without hanging", () => {
    const result = evaluateRestartGuard({
      requesterSessionId: "req",
      force: false,
      sessions: [
        session({ sessionId: "a", busy: true, parentSessionId: "b" }),
        session({ sessionId: "b", busy: true, parentSessionId: "a" }),
        session({ sessionId: "req", busy: false }),
      ],
    });
    expect(result.allowed).toBe(false);
    expect(result.blockingSessions.map((s) => s.sessionId).sort()).toEqual(["a", "b"]);
  });
});
