import { describe, expect, it } from "vitest";

import { SessionMetadataSchema, StoredSessionSchema } from "./session-schema";

const workspaceIdentity = {
  version: 1 as const,
  device: "1",
  inode: "2",
  birthtimeNs: "3",
};
const repositoryAgent = {
  name: "Reviewer",
  path: ".github/agents/reviewer.agent.md",
  description: "Reviews changes",
  identity: {
    version: 1 as const,
    normalizedPath: ".github/agents/reviewer.agent.md",
    declaredName: "Reviewer",
    contentDigest: "reviewer-v1",
  },
};

describe("session workspace and role identity schema", () => {
  it("preserves identity metadata in index rows while stripping role content", () => {
    const parsed = SessionMetadataSchema.parse({
      id: "session-1",
      name: "Project chat",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
      hasUnread: false,
      isActive: false,
      source: "user",
      workspaceName: "Project",
      workspaceIdentity,
      repositoryAgent: {
        ...repositoryAgent,
        instructions: "This raw role content must not enter session metadata.",
      },
    });

    expect(parsed.workspaceIdentity).toEqual(workspaceIdentity);
    expect(parsed.repositoryAgent).toEqual(repositoryAgent);
    expect(parsed.repositoryAgent).not.toHaveProperty("instructions");
  });

  it("preserves identities in stored sessions and leaves legacy bindings unblessed", () => {
    const current = StoredSessionSchema.parse({
      id: "session-current",
      name: "Project chat",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
      hasUnread: false,
      isActive: false,
      source: "user",
      workspaceName: "Project",
      workspaceIdentity,
      repositoryAgent,
      messages: [],
    });
    const legacy = StoredSessionSchema.parse({
      id: "session-legacy",
      name: "Legacy project chat",
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:00:00.000Z",
      hasUnread: false,
      isActive: false,
      source: "user",
      workspaceName: "Project",
      repositoryAgent: {
        name: "Reviewer",
        path: ".github/agents/reviewer.agent.md",
      },
      messages: [],
    });

    expect(current.workspaceIdentity).toEqual(workspaceIdentity);
    expect(current.repositoryAgent?.identity).toEqual(repositoryAgent.identity);
    expect(legacy.workspaceIdentity).toBeUndefined();
    expect(legacy.repositoryAgent?.identity).toBeUndefined();
  });
});
