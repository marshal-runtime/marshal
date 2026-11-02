import { describe, expect, it } from "vitest";

import { E2E_DYNAMIC_STUBS, E2E_STUBS } from "./e2e-stubs";

describe("E2E stubs", () => {
  it("does not carry obsolete goal runtime stubs", () => {
    for (const channel of [
      "goal:get",
      "goal:set",
      "goal:updateDefinition",
      "goal:updateContext",
      "goal:pause",
      "goal:resume",
      "goal:steer",
      "goal:stop",
    ]) {
      expect(Object.hasOwn(E2E_STUBS, channel)).toBe(false);
      expect(Object.hasOwn(E2E_DYNAMIC_STUBS, channel)).toBe(false);
    }
  });
});
