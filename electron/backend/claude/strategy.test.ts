import { describe, expect, it } from "vitest";

import { createClaudeLocalRuntimeStrategy } from "./strategy";

describe("Claude local runtime strategy", () => {
  it("uses Claude identity with the local compatibility origin", () => {
    const strategy = createClaudeLocalRuntimeStrategy();

    expect(strategy).toMatchObject({
      runtimeId: "claude",
      origin: "copilot",
      displayName: "Claude Agent",
      defaultInferenceModel: "sonnet",
      accountIdentityPrefix: "anthropic",
    });
    expect(strategy.capabilities.automations.multiStep).toBe(true);
    expect(strategy.capabilities.sessionCompaction).toBe(true);
    expect(strategy.capabilities.desktopCapabilities.localTools).toBe(false);
  });
});
