import { describe, expect, it } from "vitest";

import { MarshalServiceSymbols, type MarshalServiceMap } from "./service-symbols";

const expectedDescriptions = {
  authority: "@marshal/marshal:authority",
  catalog: "@marshal/marshal:catalog",
  agents: "@marshal/marshal:agents",
  brain: "@marshal/marshal:brain",
  memory: "@marshal/marshal:memory",
  memoryProviderRegistry: "@marshal/marshal:memory-provider-registry",
  browserExecution: "@marshal/marshal:browser.execution",
  uiDelivery: "@marshal/marshal:ui.delivery",
  uiReview: "@marshal/marshal:ui.review",
} as const;

type Assert<T extends true> = T;
type Same<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;
function assertTypeSurface(): void {
  const names: Assert<Same<keyof typeof MarshalServiceSymbols, keyof MarshalServiceMap>> = true;
  void names;
}

assertTypeSurface();

describe("Marshal service symbols", () => {
  it("preserves the complete named token surface and descriptions", () => {
    expect(MarshalServiceSymbols).toEqual(
      Object.fromEntries(
        Object.entries(expectedDescriptions).map(([name]) => [name, expect.any(Symbol)]),
      ),
    );

    expect(Object.values(MarshalServiceSymbols).map(String)).toEqual(
      Object.values(expectedDescriptions).map((description) => `Symbol(${description})`),
    );
  });

  it("uses distinct token identities", () => {
    const tokens = Object.values(MarshalServiceSymbols);
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(Object.isFrozen(MarshalServiceSymbols)).toBe(true);
  });
});
