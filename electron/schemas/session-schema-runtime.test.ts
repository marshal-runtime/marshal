import { describe, expect, it } from "vitest";

import { resolveSessionRuntimeId } from "../../common/runtime-config";
import { SessionMetadataSchema } from "./session-schema";

const BASE = {
  id: "session-1",
  name: "Session",
  createdAt: "",
  updatedAt: "",
  hasUnread: false,
  isActive: false,
};

describe("SessionMetadata runtime partition", () => {
  it("preserves an explicit open-ended runtimeId", () => {
    const parsed = SessionMetadataSchema.parse({
      ...BASE,
      runtimeId: "codex",
      backendOrigin: "copilot",
    });

    expect(parsed.runtimeId).toBe("codex");
    expect(resolveSessionRuntimeId(parsed)).toBe("codex");
  });

  it("derives legacy runtime identity from backendOrigin", () => {
    expect(resolveSessionRuntimeId({ backendOrigin: "gateway" })).toBe("gateway");
    expect(resolveSessionRuntimeId({ backendOrigin: "copilot" })).toBe("copilot");
  });

  it("treats rows missing runtimeId and backendOrigin as the default runtime", () => {
    expect(resolveSessionRuntimeId({})).toBe("claude");
  });
});

describe("SessionMetadata Runtime agent role", () => {
  it("preserves Runtime roles and rejects unknown roles", () => {
    for (const runtimeAgentRole of [
      "brain",
      "planner",
      "swarm",
      "worker",
      "reviewer",
      "validator",
      "reconciler",
    ] as const) {
      expect(
        SessionMetadataSchema.parse({
          ...BASE,
          source: "subagent",
          parentSessionId: "parent-1",
          runtimeAgentRole,
        }).runtimeAgentRole,
      ).toBe(runtimeAgentRole);
    }
    expect(
      SessionMetadataSchema.safeParse({
        ...BASE,
        source: "subagent",
        parentSessionId: "parent-1",
        runtimeAgentRole: "generic",
      }).success,
    ).toBe(false);
  });
});
