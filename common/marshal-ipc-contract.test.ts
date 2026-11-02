import { describe, expect, it } from "vitest";

import {
  isGatewayRoleMode,
  roleModeIncludesNode,
  roleModeIncludesOperator,
  type IpcEventMap,
  type IpcInvokeMap,
} from "./marshal-ipc-contract";

describe("goal:changed contract", () => {
  it("uses the minimal runtime snapshot and has no legacy goal field", () => {
    const payload: IpcEventMap["goal:changed"] = {
      sessionId: "session-1",
      snapshot: {
        sessionId: "session-1",
        goal: null,
        fence: { goalId: "goal-1", epoch: 1 },
      },
    };

    expect(payload.snapshot.fence).toEqual({ goalId: "goal-1", epoch: 1 });
    expect("goal" in payload).toBe(false);
  });
});

describe("goal API contract", () => {
  it("exposes the compact set and fenced mutation shapes", () => {
    type Pause = IpcInvokeMap["goal:pause"];
    type UpdateContext = IpcInvokeMap["goal:updateContext"];
    const pauseFence: Parameters<Pause>[1] = { goalId: "goal-1", epoch: 2 };
    const contextInput: Parameters<UpdateContext>[1] = {
      expectedFence: pauseFence,
      patch: { progress: ["Tests repaired"], state: { set: { ready: true } } },
    };

    expect(pauseFence).toEqual({ goalId: "goal-1", epoch: 2 });
    expect(contextInput.patch.progress).toEqual(["Tests repaired"]);
  });
});

describe("roleModeIncludesOperator", () => {
  it("returns true for undefined (back-compat — pre-roleMode creds default to operator)", () => {
    expect(roleModeIncludesOperator(undefined)).toBe(true);
  });

  it("returns true for 'operator'", () => {
    expect(roleModeIncludesOperator("operator")).toBe(true);
  });

  it("returns true for 'operator-and-node'", () => {
    expect(roleModeIncludesOperator("operator-and-node")).toBe(true);
  });

  it("returns false for 'node'", () => {
    expect(roleModeIncludesOperator("node")).toBe(false);
  });
});

describe("roleModeIncludesNode", () => {
  it("returns false for undefined", () => {
    expect(roleModeIncludesNode(undefined)).toBe(false);
  });

  it("returns false for 'operator'", () => {
    expect(roleModeIncludesNode("operator")).toBe(false);
  });

  it("returns true for 'node'", () => {
    expect(roleModeIncludesNode("node")).toBe(true);
  });

  it("returns true for 'operator-and-node'", () => {
    expect(roleModeIncludesNode("operator-and-node")).toBe(true);
  });
});

describe("isGatewayRoleMode", () => {
  it("returns true and narrows for a valid mode", () => {
    const value: string = "operator";
    expect(isGatewayRoleMode(value)).toBe(true);
  });

  it("returns false for an unrecognized string", () => {
    expect(isGatewayRoleMode("bogus")).toBe(false);
  });
});
