import { describe, it, expect } from "vitest";

import { approvalResultToRuntimePermission } from "./internal";

describe("approvalResultToRuntimePermission", () => {
  it("maps approved to the runtime approve-once result", () => {
    expect(approvalResultToRuntimePermission("approved")).toEqual({ kind: "approve-once" });
  });

  it("maps denied-by-rules to user-not-available (no-approver semantics)", () => {
    expect(approvalResultToRuntimePermission("denied-by-rules")).toEqual({
      kind: "user-not-available",
    });
  });

  it("maps an interactive user denial to a bare reject", () => {
    expect(approvalResultToRuntimePermission("denied-interactively-by-user")).toEqual({
      kind: "reject",
    });
  });

  it("maps a policy-feedback denial to reject carrying the actionable reason", () => {
    const result = approvalResultToRuntimePermission({
      kind: "denied-by-policy-with-feedback",
      feedback: "Blocked by security policy. Do not retry.",
    });

    expect(result).toEqual({
      kind: "reject",
      feedback: "Blocked by security policy. Do not retry.",
    });
  });
});
