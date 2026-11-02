import { describe, expect, it, vi } from "vitest";

import type { IMemoryStore, ISelfToolDeps, MemorySessionScope } from "../../backend/ports";
import { testDouble } from "../../testing/harness";
import { runForgetTool } from "./forget-tool";

const SCOPE = {
  workspaceId: "workspace-acme",
  projectId: "project-acme",
  workspacePath: "/repos/acme",
};

function deps(project?: { workspacePath: string; projectId: string; workspaceId?: string }) {
  return {
    confirmPermissionsEscalation: vi
      .fn<ISelfToolDeps["confirmPermissionsEscalation"]>()
      .mockResolvedValue(true),
    memoryProjectForSession: vi
      .fn<NonNullable<ISelfToolDeps["memoryProjectForSession"]>>()
      .mockResolvedValue(project),
  };
}

/** A provider whose memory `mem-p` lives in the session's project scope only. */
function projectProvider() {
  const inReach = (session?: MemorySessionScope) => session?.projectId === "project-acme";
  return testDouble<IMemoryStore>({
    list: () => [],
    delete: vi.fn<IMemoryStore["delete"]>().mockResolvedValue(false),
    forgetTarget: vi.fn<NonNullable<IMemoryStore["forgetTarget"]>>(async (id, session) =>
      inReach(session)
        ? {
            id,
            state: "active",
            text: "acme deploys on Fridays",
            revisions: 2,
            revisionsWithText: 2,
          }
        : null,
    ),
    forgetCompletely: vi.fn<NonNullable<IMemoryStore["forgetCompletely"]>>(async (id, session) =>
      inReach(session)
        ? {
            memoryId: id,
            purgedIds: [id, "rev-0"],
            purgedFacts: ["acme deploys on Fridays"],
            scopeKind: "project",
            compaction: "pending",
            pendingSlots: ["@marshal/brain:code-index:0123abcd"],
            lifecycleResults: { available: true, removed: 1 },
          }
        : null,
    ),
    forgetWithOutcome: vi.fn<NonNullable<IMemoryStore["forgetWithOutcome"]>>(async () => ({
      forgotten: true,
      contentBlanked: true,
      historyRevisionsWithText: 1,
      tombstoneKept: true,
      message: "Forgotten: 1 earlier revision still holds older text.",
    })),
  });
}

describe("runForgetTool", () => {
  it("finds and purges a project memory with the calling session's scope", async () => {
    const store = projectProvider();
    const toolDeps = deps(SCOPE);

    const result = await runForgetTool(store, { id: "mem-p", completely: true }, "s1", toolDeps);

    expect(toolDeps.memoryProjectForSession).toHaveBeenCalledWith("s1");
    expect(store.forgetTarget).toHaveBeenCalledWith("mem-p", SCOPE);
    expect(toolDeps.confirmPermissionsEscalation).toHaveBeenCalledWith("s1", {
      forgetCompletely: { memoryText: "acme deploys on Fridays" },
    });
    expect(store.forgetCompletely).toHaveBeenCalledWith("mem-p", SCOPE);
    expect(result).toEqual({
      success: true,
      completely: true,
      purgedRevisions: 2,
      scopeKind: "project",
      compaction: "pending",
      pendingSlots: ["@marshal/brain:code-index:0123abcd"],
      lifecycleResults: { available: true, removed: 1 },
    });
    expect(JSON.stringify(result)).not.toContain("Fridays");
  });

  it("falls back to the user's own scope when the session has no runtime scope", async () => {
    const store = projectProvider();
    const toolDeps = deps(undefined);

    const result = await runForgetTool(store, { id: "mem-p", completely: true }, "s1", toolDeps);

    expect(store.forgetTarget).toHaveBeenCalledWith("mem-p", undefined);
    expect(toolDeps.confirmPermissionsEscalation).not.toHaveBeenCalled();
    expect(store.forgetCompletely).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: "Memory not found" });
  });

  it("reports what a plain forget left, with the session scope", async () => {
    const store = projectProvider();

    const result = await runForgetTool(store, { id: "mem-p" }, "s1", deps(SCOPE));

    expect(store.forgetWithOutcome).toHaveBeenCalledWith("mem-p", SCOPE);
    expect(result).toMatchObject({
      success: true,
      historyRevisionsWithText: 1,
      tombstoneKept: true,
    });
    expect(store.delete).not.toHaveBeenCalled();
  });

  it("works with a store that has none of the forget methods", async () => {
    const store = testDouble<IMemoryStore>({
      list: () => [],
      delete: vi.fn<IMemoryStore["delete"]>().mockResolvedValue(true),
    });

    const plain = await runForgetTool(store, { id: "mem-1" }, "s1", deps(SCOPE));
    const complete = await runForgetTool(
      store,
      { id: "mem-1", completely: true },
      "s1",
      deps(SCOPE),
    );

    expect(plain).toEqual({ success: true });
    expect(store.delete).toHaveBeenCalledWith("mem-1");
    expect(complete).toMatchObject({
      success: false,
      error: expect.stringContaining("cannot forget completely"),
    });
  });
});
