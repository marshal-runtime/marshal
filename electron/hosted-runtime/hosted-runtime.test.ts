import { describe, expect, it } from "vitest";

import { HostedRuntimeRegistry, type HostedRuntimeProvider } from "./contracts";

function stubProvider(id: string, url: string, sharedToken: string): HostedRuntimeProvider {
  return {
    id,
    resolveEndpoint: () => ({ url, sharedToken }),
    acquireAuthToken: async () => `${id}-token`,
    resolveDeviceIdentityPath: (defaultPath) => defaultPath,
  };
}

describe("HostedRuntimeRegistry", () => {
  it("creates a registered provider", () => {
    const registry = new HostedRuntimeRegistry();
    registry.register("cloud", () => stubProvider("cloud", "wss://host/rt", "shared"));
    expect(registry.has("cloud")).toBe(true);
    expect(registry.create("cloud").resolveEndpoint()).toEqual({
      url: "wss://host/rt",
      sharedToken: "shared",
    });
  });

  it("rejects duplicate and malformed IDs", () => {
    const registry = new HostedRuntimeRegistry();
    registry.register("cloud", () => stubProvider("cloud", "wss://host/rt", "shared"));
    expect(() => registry.register("cloud", () => stubProvider("cloud", "u", "t"))).toThrow(
      /already registered/,
    );
    expect(() => registry.register(" cloud", () => stubProvider(" cloud", "u", "t"))).toThrow(
      /non-empty, trimmed/,
    );
  });

  it("lists registered IDs when asked for an unknown provider", () => {
    const registry = new HostedRuntimeRegistry();
    registry.register("cloud", () => stubProvider("cloud", "wss://host/rt", "shared"));
    expect(() => registry.create("nope")).toThrow(/Registered providers: cloud/);
  });

  it("rejects a factory returning a mismatched provider ID", () => {
    const registry = new HostedRuntimeRegistry();
    registry.register("cloud", () => stubProvider("other", "u", "t"));
    expect(() => registry.create("cloud")).toThrow(/returned provider "other"/);
  });
});

describe("hosted runtime selection", () => {
  it("reads the endpoint, shared token and bearer token from configuration", async () => {
    const { resolveHostedRuntimeProvider } = await import("./current");
    const provider = resolveHostedRuntimeProvider({
      MARSHAL_HOSTED_GATEWAY_URL: "wss://self-hosted/rt",
      MARSHAL_GATEWAY_TOKEN: "self-hosted-token",
      MARSHAL_HOSTED_GATEWAY_AUTH_TOKEN: "bearer",
    });
    expect(provider.id).toBe("config");
    expect(provider.resolveEndpoint()).toEqual({
      url: "wss://self-hosted/rt",
      sharedToken: "self-hosted-token",
    });
    await expect(provider.acquireAuthToken()).resolves.toBe("bearer");
  });

  it("has no built-in endpoint when nothing is configured", async () => {
    const { resolveHostedRuntimeProvider } = await import("./current");
    const provider = resolveHostedRuntimeProvider({});
    expect(provider.resolveEndpoint()).toEqual({ url: "", sharedToken: "" });
    await expect(provider.acquireAuthToken()).resolves.toBeUndefined();
  });
});

describe("config hosted runtime provider", () => {
  it("relocates device trust when configured", async () => {
    const { createConfigHostedRuntimeProvider } = await import("./config-provider");
    const provider = createConfigHostedRuntimeProvider({
      endpoint: { url: "wss://host/rt", sharedToken: "t" },
      authToken: "bearer",
      deviceIdentityPath: "/custom/device.json",
    });
    expect(provider.resolveDeviceIdentityPath("/default/device.json")).toBe("/custom/device.json");
    await expect(provider.acquireAuthToken()).resolves.toBe("bearer");
  });

  it("keeps the default device identity path when not configured", async () => {
    const { createConfigHostedRuntimeProvider } = await import("./config-provider");
    const provider = createConfigHostedRuntimeProvider({
      endpoint: { url: "wss://host/rt", sharedToken: "t" },
    });
    expect(provider.resolveDeviceIdentityPath("/default/device.json")).toBe("/default/device.json");
  });
});
