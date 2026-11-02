import { describe, expect, it } from "vitest";

import { trustedDelegationContext } from "./host";

describe("host delegation authority", () => {
  it("overwrites forged identity and rejects launch authority from caller metadata", async () => {
    const context = await trustedDelegationContext(
      {
        sessionId: "worker",
        metadata: {
          delegationId: "forged",
          marshalLaunchDelegationId: "forged-launch",
          other: "kept",
        },
      },
      async (id) => (id === "worker" ? "persisted" : undefined),
    );
    expect(context.metadata).toEqual({ delegationId: "persisted", other: "kept" });
  });
  it("does not accept delegation authority for an ordinary session", async () => {
    const context = await trustedDelegationContext(
      { sessionId: "ordinary", metadata: { delegationId: "forged" } },
      async () => undefined,
    );
    expect(context.metadata).toEqual({});
  });
  it("derives the task controller from session state and strips forged extension origins", async () => {
    const context = await trustedDelegationContext(
      {
        sessionId: "worker",
        metadata: {
          runtimeTaskController: "forged",
          runtimeExtensionIdentity: "forged",
          marshalLaunchTaskController: "forged",
        },
      },
      async () => ({ delegationId: "delegation", taskController: "extension" }),
    );
    expect(context.metadata).toEqual({
      delegationId: "delegation",
      runtimeTaskController: "extension",
    });
  });
});
