import { describe, expect, it } from "vitest";

import { createCodexLocalRuntimeStrategy } from "./strategy";

describe("Codex local runtime strategy", () => {
  it("uses Codex identity with the local compatibility origin", () => {
    const strategy = createCodexLocalRuntimeStrategy();

    expect(strategy).toMatchObject({
      runtimeId: "codex",
      origin: "copilot",
      displayName: "Codex",
      defaultInferenceModel: "gpt-5.4",
      accountIdentityPrefix: "openai",
      defaultClientLoginRequest: { type: "browser" },
    });
    expect(strategy.capabilities.automations.multiStep).toBe(true);
    expect(strategy.capabilities.sessionCompaction).toBe(true);
    expect(strategy.capabilities.desktopCapabilities.localTools).toBe(false);
  });

  it("advertises native busy-turn steer so host steer does not cancel the turn", () => {
    expect(createCodexLocalRuntimeStrategy().capabilities.busyTurnSteer).toBe(true);
  });
});
