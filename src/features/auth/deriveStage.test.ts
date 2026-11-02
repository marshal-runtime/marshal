import { describe, it, expect } from "vitest";

import { deriveStage, type AuthInputs } from "./deriveStage";

function input(gh: Partial<AuthInputs["gh"]> = {}): AuthInputs {
  return { gh: { status: "signed-out", ...gh } };
}

describe("deriveStage", () => {
  it("checking while the runtime auth probe is in flight", () => {
    expect(deriveStage(input({ status: "checking" })).kind).toBe("checking");
  });

  it("not-allowed-plan surfaces as copilot-access-error carrying the login (no plan name)", () => {
    const stage = deriveStage(
      input({ status: "not-allowed-plan", login: "freeuser", copilotPlan: "individual_pro" }),
    );
    // Both rejection reasons collapse to one stage that only carries the login.
    // The specific plan name is never plumbed through, so it cannot leak to the UI.
    expect(stage).toEqual({ kind: "copilot-access-error", login: "freeuser" });
  });

  it("copilot-access-error carries the login", () => {
    const stage = deriveStage(input({ status: "copilot-access-error", login: "baduser" }));
    expect(stage).toEqual({
      kind: "copilot-access-error",
      login: "baduser",
    });
  });

  it("github-device-code when device flow has a code", () => {
    const stage = deriveStage(input({ status: "device-code", deviceCode: "ABCD-1234" }));
    expect(stage).toEqual({ kind: "github-device-code", code: "ABCD-1234", expired: false });
  });

  it("github-device-code carries expired flag when set", () => {
    const stage = deriveStage(
      input({ status: "device-code", deviceCode: "ABCD-1234", deviceCodeExpired: true }),
    );
    expect(stage).toEqual({ kind: "github-device-code", code: "ABCD-1234", expired: true });
  });

  it("device-code without a code falls back to start", () => {
    expect(deriveStage(input({ status: "device-code" })).kind).toBe("start");
  });

  it("ready when GitHub is signed in", () => {
    expect(deriveStage(input({ status: "signed-in" })).kind).toBe("ready");
  });

  it("start with error message when signed out", () => {
    const stage = deriveStage(input({ status: "signed-out", errorMessage: "boom" }));
    expect(stage).toEqual({ kind: "start", error: "boom" });
  });
});
