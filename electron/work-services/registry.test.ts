import { describe, expect, it } from "vitest";

import {
  createWorkServiceProviderRegistry,
  registerWorkServiceProvider,
  selectWorkServiceProvider,
} from "./registry";

interface TestProvider {
  readonly id: string;
}

describe("WorkServiceProviderRegistry", () => {
  it("creates registered providers and treats none as disabled", () => {
    const registry = createWorkServiceProviderRegistry<TestProvider>();
    registerWorkServiceProvider(registry, "example", () => ({ id: "example" }));

    expect(registry.ids()).toEqual(["example"]);
    expect(selectWorkServiceProvider(registry, "example")).toEqual({ id: "example" });
    expect(selectWorkServiceProvider(registry, "none")).toBeNull();
  });

  it("uses a registered fallback when the requested provider is unavailable", () => {
    const registry = createWorkServiceProviderRegistry<TestProvider>();
    registerWorkServiceProvider(registry, "default", () => ({ id: "default" }));

    expect(selectWorkServiceProvider(registry, "future-adapter", "default")).toEqual({
      id: "default",
    });
  });

  it("treats a disabled fallback as no provider when a retired adapter is configured", () => {
    const registry = createWorkServiceProviderRegistry<TestProvider>();

    expect(selectWorkServiceProvider(registry, "retired-adapter", "none")).toBeNull();
  });

  it("rejects invalid, duplicate, reserved, unknown, and mismatched registrations", () => {
    const registry = createWorkServiceProviderRegistry<TestProvider>();
    expect(() => registerWorkServiceProvider(registry, "", () => ({ id: "" }))).toThrow(
      "non-empty",
    );
    expect(() => registerWorkServiceProvider(registry, " none", () => ({ id: " none" }))).toThrow(
      "trimmed",
    );
    expect(() => registerWorkServiceProvider(registry, "none", () => ({ id: "none" }))).toThrow(
      "reserved",
    );

    registerWorkServiceProvider(registry, "example", () => ({ id: "example" }));
    expect(() =>
      registerWorkServiceProvider(registry, "example", () => ({ id: "example" })),
    ).toThrow("already registered");
    expect(() => selectWorkServiceProvider(registry, "missing")).toThrow(
      'Unknown provider "missing"',
    );

    const mismatched = createWorkServiceProviderRegistry<TestProvider>();
    registerWorkServiceProvider(mismatched, "expected", () => ({ id: "actual" }));
    expect(() => selectWorkServiceProvider(mismatched, "expected")).toThrow(
      'registered as "expected" returned instance "actual"',
    );
  });
});
