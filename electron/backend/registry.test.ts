import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = await vi.hoisted(async () => await import("../test-helpers/session-test-mocks"));
vi.mock("electron", mocks.electronFactory);
vi.mock("../cli-path", mocks.cliPathFactory);
vi.mock("../safe-storage-file");

import { HOSTED_GATEWAY_URL_ENV } from "../hosted-runtime/current";
import { testDouble } from "../testing/harness/test-double";
import {
  buildClaudeClientFactoryOptions,
  buildCodexClientFactoryOptions,
  buildGatewayBackendConfig,
  createBuiltinRuntimeRegistry,
} from "./create-backend";
import { RuntimeAdapterRegistry, type RuntimeAdapterCreateContext } from "./registry";
import type { IBackendProvider } from "./types";

interface TestContext extends RuntimeAdapterCreateContext {
  marker: string;
}

function provider(runtimeId: string, origin: "copilot" | "gateway"): IBackendProvider {
  return testDouble<IBackendProvider>({ runtimeId, origin });
}

afterEach(() => {
  delete process.env[HOSTED_GATEWAY_URL_ENV];
  delete process.env.MARSHAL_GATEWAY_TOKEN;
});

describe("RuntimeAdapterRegistry", () => {
  it("rejects duplicate runtime IDs", () => {
    const registry = new RuntimeAdapterRegistry<TestContext>();
    registry.register({
      id: "test",
      origin: "copilot",
      create: () => provider("test", "copilot"),
    });

    expect(() =>
      registry.register({
        id: "test",
        origin: "copilot",
        create: () => provider("test", "copilot"),
      }),
    ).toThrow('Runtime adapter "test" is already registered');
  });

  it("fails unknown IDs with the registered IDs in the error", () => {
    const registry = new RuntimeAdapterRegistry<TestContext>();
    registry.register({
      id: "known",
      origin: "copilot",
      create: () => provider("known", "copilot"),
    });

    expect(() =>
      registry.create("missing", {
        workspaceDir: "Q:\\workspace",
        mockMode: false,
        marker: "x",
      }),
    ).toThrow('Unknown runtime adapter "missing". Registered runtimes: known');
  });

  it("forwards composition context to adapters", () => {
    const create = vi.fn<(context: TestContext) => IBackendProvider>(() =>
      provider("cloud-test", "copilot"),
    );
    const registry = new RuntimeAdapterRegistry<TestContext>();
    registry.register({ id: "cloud-test", origin: "copilot", create });

    registry.create("cloud-test", {
      workspaceDir: "Q:\\workspace",
      mockMode: false,
      marker: "forwarded",
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ marker: "forwarded" }));
  });

  it("registers all built-in runtime adapters", () => {
    const registry = createBuiltinRuntimeRegistry();
    expect(registry.ids().sort()).toEqual([
      "claude",
      "codex",
      "copilot",
      "cursor",
      "gateway",
      "marshal-cloud",
    ]);

    const copilot = registry.create("copilot", {
      workspaceDir: "Q:\\workspace",
      mockMode: true,
      gatewayE2E: false,
    });
    const claude = registry.create("claude", {
      workspaceDir: "Q:\\workspace",
      mockMode: false,
      gatewayE2E: false,
    });
    const codex = registry.create("codex", {
      workspaceDir: "Q:\\workspace",
      mockMode: false,
      isPackaged: true,
      resourcesPath: "Q:\\Marshal\\resources",
      gatewayE2E: false,
    });
    const cursor = registry.create("cursor", {
      workspaceDir: "Q:\\workspace",
      mockMode: false,
      gatewayE2E: false,
    });
    const gateway = registry.create("gateway", {
      workspaceDir: "Q:\\workspace",
      mockMode: true,
      gatewayE2E: true,
      gatewayDeviceIdentityPath: "Q:\\identity\\device.json",
    });

    expect({ runtimeId: copilot.runtimeId, origin: copilot.origin }).toEqual({
      runtimeId: "copilot",
      origin: "copilot",
    });
    expect({ runtimeId: gateway.runtimeId, origin: gateway.origin }).toEqual({
      runtimeId: "gateway",
      origin: "gateway",
    });
    expect({ runtimeId: claude.runtimeId, origin: claude.origin }).toEqual({
      runtimeId: "claude",
      origin: "copilot",
    });
    expect({ runtimeId: codex.runtimeId, origin: codex.origin }).toEqual({
      runtimeId: "codex",
      origin: "copilot",
    });
    expect({ runtimeId: cursor.runtimeId, origin: cursor.origin }).toEqual({
      runtimeId: "cursor",
      origin: "copilot",
    });
    expect(
      registry.createClientFactory("claude", {
        workspaceDir: "Q:\\workspace",
        mockMode: false,
        gatewayE2E: false,
      }),
    ).toEqual(expect.any(Function));
    expect(
      registry.createClientFactory("codex", {
        workspaceDir: "Q:\\workspace",
        mockMode: false,
        isPackaged: true,
        resourcesPath: "Q:\\Marshal\\resources",
        gatewayE2E: false,
      }),
    ).toEqual(expect.any(Function));
    expect(
      registry.createClientFactory("cursor", {
        workspaceDir: "Q:\\workspace",
        mockMode: false,
        gatewayE2E: false,
      }),
    ).toEqual(expect.any(Function));
  });

  it("forwards Electron packaged-runtime context to the Codex factory", () => {
    expect(
      buildCodexClientFactoryOptions({
        isPackaged: true,
        resourcesPath: "Q:\\Marshal\\resources",
      }),
    ).toEqual({
      isPackaged: true,
      resourcesPath: "Q:\\Marshal\\resources",
    });
  });

  it("forwards Electron unpackaged-runtime context to the Claude factory", () => {
    expect(
      buildClaudeClientFactoryOptions({
        isPackaged: false,
        resourcesPath: "Q:\\electron\\resources",
      }),
    ).toEqual({
      isPackaged: false,
      resourcesPath: "Q:\\electron\\resources",
    });
  });

  describe("Gateway hosted-runtime composition", () => {
    it("creates Copilot without requiring hosted Gateway configuration", () => {
      const backend = createBuiltinRuntimeRegistry().create("copilot", {
        workspaceDir: "Q:\\workspace",
        mockMode: true,
        gatewayE2E: false,
      });

      expect({ runtimeId: backend.runtimeId, origin: backend.origin }).toEqual({
        runtimeId: "copilot",
        origin: "copilot",
      });
    });

    it("uses the configured hosted runtime endpoint", () => {
      process.env[HOSTED_GATEWAY_URL_ENV] = "wss://self-hosted/rt";
      process.env.MARSHAL_GATEWAY_TOKEN = "self-hosted-token";

      expect(
        buildGatewayBackendConfig({ deviceIdentityPath: "Q:\\identity\\device.json" }),
      ).toMatchObject({
        gatewayUrl: "ws://localhost:8001/v1/marshal-gateway",
        hostedGatewayUrl: "wss://self-hosted/rt",
        gatewayToken: "self-hosted-token",
        deviceIdentityPath: "Q:\\identity\\device.json",
        hostedRuntime: { id: "config" },
      });
    });
  });
});
