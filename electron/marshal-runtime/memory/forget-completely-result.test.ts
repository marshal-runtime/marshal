import { describe, expect, it } from "vitest";

import type { MemoryPurgeResult } from "../../backend/ports";
import { forgetCompletelyResult } from "./forget-completely-result";

describe("forgetCompletelyResult", () => {
  it("passes through every count-only status field, including the repository sweep", () => {
    const result = forgetCompletelyResult({
      memoryId: "m",
      purgedIds: ["m", "r0"],
      skippedIds: ["copy"],
      removedProjections: 3,
      indexRemovalsPending: 1,
      vacuumed: true,
      walTruncated: false,
      scopeKind: "project",
      compaction: "pending",
      pendingSlots: ["@marshal/brain:code-index:0123abcd"],
      lifecycleResults: { available: true, removed: 2 },
      repositorySweepState: "pending",
      pendingRepositories: 2,
      workspaceOverlays: "pending",
      pendingWorkspaceOverlays: [
        { workspace: "/Users/someone/repo", reason: "queued" },
        { workspace: "/Users/someone/other", reason: "upgrade" },
      ],
    });

    expect(result).toEqual({
      success: true,
      completely: true,
      purgedRevisions: 2,
      skippedRevisions: 1,
      removedProjections: 3,
      indexRemovalsPending: 1,
      vacuumed: true,
      walTruncated: false,
      scopeKind: "project",
      compaction: "pending",
      pendingSlots: ["@marshal/brain:code-index:0123abcd"],
      lifecycleResults: { available: true, removed: 2 },
      repositorySweepState: "pending",
      pendingRepositories: 2,
      workspaceOverlays: "pending",
      pendingWorkspaceOverlays: ["queued", "upgrade"],
    });
    expect(JSON.stringify(result)).not.toContain("/Users/someone");
  });

  it("bounds the pending workspace overlay list", () => {
    const pendingWorkspaceOverlays = Array.from({ length: 100 }, () => ({ reason: "not-open" }));
    const result = forgetCompletelyResult({
      memoryId: "m",
      purgedIds: ["m"],
      pendingWorkspaceOverlays,
    });

    expect(result.pendingWorkspaceOverlays).toHaveLength(64);
  });

  it("never lets memory text through, whatever key or shape it arrives in", () => {
    const secret = "Omer's private memory";
    const purged: MemoryPurgeResult & Record<string, unknown> = {
      memoryId: "m",
      purgedIds: ["m"],
      purgedFacts: [secret],
      purgedContents: [secret],
      repositorySweep: { at: secret, bundles: 1 },
      message: secret,
    };
    Object.assign(purged, {
      repositorySweepState: secret,
      pendingRepositories: secret,
      vacuumed: secret,
      pendingSlots: [secret, `@marshal/brain:${secret}`, "@marshal/brain:code-index:0123abcd x"],
      lifecycleResults: { available: true, removed: Number.NaN },
      workspaceOverlays: secret,
      pendingWorkspaceOverlays: [
        { workspace: `/Users/omer/${secret}`, reason: secret },
        { reason: "made-up-reason", note: secret },
        { reason: ["queued"] },
        "queued",
        null,
        { workspace: secret, reason: "busy", note: secret },
      ],
    });

    const output = JSON.stringify(forgetCompletelyResult(purged));

    expect(output).not.toContain(secret);
    expect(JSON.parse(output)).toEqual({
      success: true,
      completely: true,
      purgedRevisions: 1,
      pendingSlots: [],
      pendingWorkspaceOverlays: ["busy"],
    });
  });
});
