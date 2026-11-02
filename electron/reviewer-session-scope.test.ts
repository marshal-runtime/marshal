import { describe, it, expect, vi } from "vitest";

import type {
  PermissionsConfig,
  ReviewerSessionPermissionScope,
} from "../common/marshal-ipc-contract";
import { REVIEWER_SESSION_CAPABILITIES } from "../common/marshal-ipc-contract";
import { PermissionPolicy, REVIEWER_ALLOWED_CUSTOM_TOOLS } from "./permission-policy";
import { makeRequest } from "./policy-rules/test-helpers";
import type { SettingsManager } from "./settings-manager";
import { testDouble } from "./testing/harness";

const PERMISSIONS: PermissionsConfig = {
  autoApproveReadOnly: false,
  allow: [],
  tools: {},
  servers: {
    filesystem: { enabled: true, autoApprove: true },
    playwright: { enabled: true, autoApprove: false },
    shell: { enabled: true, autoApprove: false },
  },
};

function makeScope(): ReviewerSessionPermissionScope {
  return {
    ...REVIEWER_SESSION_CAPABILITIES,
    role: "reviewer",
    repoPath: "/repo",
    allowedTools: [...REVIEWER_ALLOWED_CUSTOM_TOOLS],
    folderGrants: { read: ["/repo"], write: [] },
    skills: [],
    mcp: [],
    verificationRoot: "/repo",
  };
}

function makePolicy(scope: ReviewerSessionPermissionScope | undefined) {
  return new PermissionPolicy({
    settingsManager: testDouble<SettingsManager>({
      get: () => ({ permissions: PERMISSIONS }),
      update: vi.fn<(s: Record<string, unknown>) => void>(),
    }),
    getPermissionMode: () => "read-only-reviewer",
    getReviewerSessionPermissionScope: () => scope,
  });
}

/**
 * Production enforcement for goal-transition reviewer sessions: the scope
 * registered at reviewer creation (main.ts) is what activates the fail-closed
 * ReviewerToolPolicy. These tests pin the enforced surface: reads approved,
 * allowlisted read-only self-tools (incl. getSessionTranscript for
 * sourceInstruction verification) approved, everything mutating or external
 * denied — and no scope means fail-closed even in reviewer mode.
 */
describe("reviewer session permission scope", () => {
  it("approves reads and allowlisted read-only tools under a registered scope", () => {
    const policy = makePolicy(makeScope());
    expect(policy.evaluate(makeRequest({ kind: "read", path: "/repo/src/index.ts" }))).toBe(
      "approve",
    );
    expect(
      policy.evaluate(
        makeRequest({ kind: "custom-tool", toolName: "getSessionTranscript", toolArgs: {} }),
      ),
    ).toBe("approve");
    expect(
      policy.evaluate(makeRequest({ kind: "custom-tool", toolName: "goalGet", toolArgs: {} })),
    ).toBe("approve");
  });

  it("denies writes, shell, url, mcp, and unclassified tools", () => {
    const policy = makePolicy(makeScope());
    expect(
      policy.evaluate(
        makeRequest({ kind: "write", path: "/repo/src/index.ts", diff: null, origin: "sdk" }),
      ),
    ).toBe("deny");
    expect(policy.evaluate(makeRequest({ kind: "shell", command: "rm -rf /" }))).toBe("deny");
    expect(policy.evaluate(makeRequest({ kind: "shell", command: "git status" }))).toBe("deny");
    expect(
      policy.evaluate(makeRequest({ kind: "url", url: "https://example.com", toolName: "fetch" })),
    ).toBe("deny");
    expect(
      policy.evaluate(
        makeRequest({
          kind: "mcp",
          toolName: "playwright-browser_navigate",
          serverName: undefined,
          toolArgs: {},
          readOnly: true,
        }),
      ),
    ).toBe("deny");
    expect(
      policy.evaluate(makeRequest({ kind: "custom-tool", toolName: "sendEmail", toolArgs: {} })),
    ).toBe("deny");
    expect(
      policy.evaluate(
        makeRequest({ kind: "custom-tool", toolName: "goalUpdateContext", toolArgs: {} }),
      ),
    ).toBe("deny");
  });

  it("fails closed when reviewer mode has no registered scope", () => {
    const policy = makePolicy(undefined);
    expect(policy.evaluate(makeRequest({ kind: "read", path: "/repo/src/index.ts" }))).toBe("deny");
    expect(
      policy.evaluate(
        makeRequest({ kind: "custom-tool", toolName: "getSessionTranscript", toolArgs: {} }),
      ),
    ).toBe("deny");
  });
});
