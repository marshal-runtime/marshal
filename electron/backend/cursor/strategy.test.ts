import { describe, expect, it } from "vitest";

import { createCursorLocalRuntimeStrategy } from "./strategy";

describe("Cursor local runtime strategy", () => {
  it("uses Cursor identity with the local compatibility origin", () => {
    const strategy = createCursorLocalRuntimeStrategy();

    expect(strategy).toMatchObject({
      runtimeId: "cursor",
      origin: "copilot",
      displayName: "Cursor",
      defaultInferenceModel: "composer-2.5",
      accountIdentityPrefix: "cursor",
      defaultClientLoginRequest: { type: "browser" },
    });
    expect(strategy.capabilities.automations.multiStep).toBe(true);
    expect(strategy.capabilities.sessionCompaction).toBe(true);
    expect(strategy.capabilities.busyTurnSteer).toBe(true);
    expect(strategy.capabilities.desktopCapabilities.localTools).toBe(false);
  });
});
