import { describe, it, expect } from "vitest";

import { sessionGateStage } from "./sessionGate";

describe("sessionGateStage", () => {
  it("returns the stage unchanged when not ready", () => {
    expect(sessionGateStage({ kind: "start" })).toEqual({ kind: "start" });
    expect(sessionGateStage({ kind: "checking" })).toEqual({ kind: "checking" });
    expect(sessionGateStage({ kind: "copilot-access-error", login: "baduser" })).toEqual({
      kind: "copilot-access-error",
      login: "baduser",
    });
  });

  it("starts the session as soon as auth is ready", () => {
    expect(sessionGateStage({ kind: "ready" })).toBeNull();
  });
});
