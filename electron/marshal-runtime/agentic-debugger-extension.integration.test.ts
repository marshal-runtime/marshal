import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEBUGGER_HOST_ADAPTER_SERVICE,
  type DebuggerHostAdapter,
} from "@marshal/agentic-debugger-extension";
import {
  createAgentRuntime,
  createRuntimeBuiltinsSource,
  createRuntimeServiceContainer,
  RUNTIME_PROTOCOL_VERSION,
  RuntimeCompositionRegistry,
  type RuntimeCompositionServiceDescriptor,
  type RuntimeServiceContainer,
} from "@marshal/runtime";
import {
  computeRuntimeExtensionIntegrity,
  createNodeBuiltinModuleMap,
  LocalRuntimeExtensionPackageLoader,
} from "@marshal/runtime/extensions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAcceptanceDebuggerHostAdapter } from "./acceptance-debugger-host";
import { BUILTIN_AGENTIC_DEBUGGER_EXTENSION_IDENTITY } from "./agentic-debugger-extension";
import {
  AGENTIC_DEBUGGER_HOST_COMPOSITION_SERVICE,
  bindAgenticDebuggerHostAdapter,
  isAgenticDebuggerNativeProviderId,
  adaptAgenticDebuggerExtensionPackage,
} from "./agentic-debugger-runtime-host";
import { ProductionMarshalRuntimeApi } from "./api";
import type {
  MarshalRuntimeAuthorityPort,
  MarshalRuntimeCatalogPort,
  MarshalRuntimeModule,
  MarshalRuntimePackageMetadata,
} from "./contracts";
import { MarshalRuntimeHost } from "./host";
import type { MarshalRuntimePackageLoader } from "./runtime-package-loader";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEBUGGER_PACKAGE_ROOT = path.join(
  REPOSITORY_ROOT,
  "node_modules",
  "@marshal",
  "agentic-debugger-extension",
);
const SESSION_ID = "agentic-debugger-smoke";
const WORKSPACE_NAME = "marshal";
const UI_RESOURCE_URI = "runtime://debugger/ui/application/v1";
const DEBUGGER_COMPOSITION_SERVICE =
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- registry inspection/override APIs erase the descriptor value type to unknown
  AGENTIC_DEBUGGER_HOST_COMPOSITION_SERVICE as RuntimeCompositionServiceDescriptor;

const packageMetadata: MarshalRuntimePackageMetadata = {
  name: "@marshal/runtime",
  version: "0.1.0-test",
  entrypoint: "dist/host.js",
  entrySha256: "0".repeat(64),
};

describe("agentic debugger runtime extension", () => {
  let root: string;
  let host: MarshalRuntimeHost;
  let api: ProductionMarshalRuntimeApi;
  let serviceContainer: RuntimeServiceContainer;
  let compositionRegistry: RuntimeCompositionRegistry;
  let debuggerHostAdapter: DebuggerHostAdapter;
  let workspace: string;
  let trustedExtensionRoot: string;
  let authority: MarshalRuntimeAuthorityPort;
  let catalog: MarshalRuntimeCatalogPort;
  let packageLoader: MarshalRuntimePackageLoader;

  function createHost(): void {
    serviceContainer = createRuntimeServiceContainer();
    compositionRegistry = new RuntimeCompositionRegistry({ container: serviceContainer });
    debuggerHostAdapter = createAcceptanceDebuggerHostAdapter();
    const debuggerBindings = Promise.all([
      bindAgenticDebuggerHostAdapter(
        compositionRegistry,
        "@marshal/marshal:test-debugger-host",
        debuggerHostAdapter,
        { select: true },
      ),
    ]);
    host = new MarshalRuntimeHost({
      location: {
        isPackaged: false,
        appPath: REPOSITORY_ROOT,
        resourcesPath: REPOSITORY_ROOT,
      },
      hostWorkspacePath: workspace,
      protectedLifecycleResultRoot: path.join(root, "protected-results"),
      worktreeRoot: path.join(root, "worktrees"),
      trustedExtensionRoot,
      authority,
      catalog,
      serviceContainer,
      compositionRegistry,
      ownedServiceBindings: debuggerBindings,
      packageLoader,
    });
    api = new ProductionMarshalRuntimeApi(host);
  }

  async function installDebugger(idempotencyKey = "debugger-install"): Promise<void> {
    const installed = await api.installLocalExtension({
      sessionId: SESSION_ID,
      workspaceName: WORKSPACE_NAME,
      packageRoot: await realpath(DEBUGGER_PACKAGE_ROOT),
      idempotencyKey,
    });
    if (!installed.ok) throw new Error(`${installed.error.code}: ${installed.error.message}`);
    expect(installed.value).toMatchObject({
      identity: BUILTIN_AGENTIC_DEBUGGER_EXTENSION_IDENTITY,
      version: "1.0.0",
      status: "enabled",
    });
  }

  function nativeProviderId(): string {
    const providerId = compositionRegistry
      .inspect(DEBUGGER_COMPOSITION_SERVICE)
      ?.providers.find(({ provider }) => isAgenticDebuggerNativeProviderId(provider.id))
      ?.provider.id;
    if (!providerId) throw new Error("The installed debugger native provider is not registered.");
    return providerId;
  }

  beforeEach(async () => {
    root = await mkdtemp(
      path.join(await realpath(tmpdir()), "marshal-agentic-debugger-extension-test-"),
    );
    workspace = path.join(root, "workspace");
    trustedExtensionRoot = path.join(root, "extensions");
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(path.join(root, "protected-results"), { recursive: true }),
      mkdir(path.join(root, "worktrees"), { recursive: true }),
      mkdir(trustedExtensionRoot, { recursive: true }),
    ]);
    authority = {
      async resolveScope(scope) {
        return scope.sessionId === SESSION_ID && scope.workspaceName === WORKSPACE_NAME
          ? { ...scope, workspacePath: workspace }
          : null;
      },
      async authorize() {
        return { decision: "allow" };
      },
    };
    catalog = {
      listTools: () => [],
      listSkills: () => [],
      getSkill: () => null,
      listWorkspaces: () => [],
      getSessionContext: async () => null,
    };
    const runtimeModule: MarshalRuntimeModule = {
      createAgentRuntime,
      createRuntimeBuiltinsSource,
    };
    packageLoader = {
      load: async () => runtimeModule,
      metadata: () => packageMetadata,
    };
    createHost();
  });

  afterEach(async () => {
    api.dispose();
    await host.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("observes debugger host replacement and restoration on the next invocation", async () => {
    const registry = globalThis as typeof globalThis & Record<symbol, unknown>;
    expect(registry[DEBUGGER_HOST_ADAPTER_SERVICE]).toBeUndefined();

    await installDebugger();
    expect(serviceContainer.tryGet(DEBUGGER_HOST_ADAPTER_SERVICE)).toBeDefined();
    await expect(
      api.invoke({
        sessionId: SESSION_ID,
        workspaceName: WORKSPACE_NAME,
        capability: "debug.adapter.list",
        input: {},
        idempotencyKey: "debugger-host-a",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        output: {
          value: {
            adapters: [{ type: "js-debug", languages: ["typescript"] }],
          },
        },
      },
    });

    const replacementInvoke = vi
      .fn<DebuggerHostAdapter["invoke"]>()
      .mockResolvedValue({ adapters: [{ type: "js-debug", languages: ["typescript"] }] });
    const replacement = await serviceContainer.replace(DEBUGGER_HOST_ADAPTER_SERVICE, {
      useValue: { invoke: replacementInvoke },
    });
    const replacedInvocation = await api.invoke({
      sessionId: SESSION_ID,
      workspaceName: WORKSPACE_NAME,
      capability: "debug.adapter.list",
      input: {},
      idempotencyKey: "debugger-host-b",
    });
    if (!replacedInvocation.ok) {
      throw new Error(`${replacedInvocation.error.code}: ${replacedInvocation.error.message}`);
    }
    expect(replacedInvocation).toMatchObject({
      ok: true,
      value: {
        output: {
          value: {
            adapters: [{ type: "js-debug", languages: ["typescript"] }],
          },
        },
      },
    });
    expect(replacementInvoke).toHaveBeenCalledOnce();

    await replacement.dispose();
    await expect(
      api.invoke({
        sessionId: SESSION_ID,
        workspaceName: WORKSPACE_NAME,
        capability: "debug.adapter.list",
        input: {},
        idempotencyKey: "debugger-host-c",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        output: {
          value: {
            adapters: [{ type: "js-debug", languages: ["typescript"] }],
          },
        },
      },
    });
    expect(serviceContainer.tryGet(AGENTIC_DEBUGGER_HOST_COMPOSITION_SERVICE.token)).toBe(
      debuggerHostAdapter,
    );
  });

  it("registers the installed native host below an explicit override", async () => {
    await installDebugger();
    expect(serviceContainer.get(DEBUGGER_HOST_ADAPTER_SERVICE)).toBe(debuggerHostAdapter);

    await compositionRegistry.clearProviderOverride(DEBUGGER_COMPOSITION_SERVICE);

    expect(serviceContainer.get(DEBUGGER_HOST_ADAPTER_SERVICE)).not.toBe(debuggerHostAdapter);
    await expect(
      api.invoke({
        sessionId: SESSION_ID,
        workspaceName: WORKSPACE_NAME,
        capability: "debug.adapter.list",
        input: {},
        idempotencyKey: "debugger-native-fallback",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        output: {
          value: {
            adapters: expect.arrayContaining([expect.objectContaining({ type: "js-debug" })]),
          },
        },
      },
    });
  });

  it("removes and recreates the installed native fallback with package activation", async () => {
    const packageRoot = await realpath(DEBUGGER_PACKAGE_ROOT);
    const request = {
      packageRoot,
      integrity: computeRuntimeExtensionIntegrity(packageRoot),
    };
    const loader = new LocalRuntimeExtensionPackageLoader({
      allowedRoots: [packageRoot],
      modules: createNodeBuiltinModuleMap(),
    });
    const loaded = adaptAgenticDebuggerExtensionPackage(
      loader.load(request),
      compositionRegistry,
    );
    const activate = () =>
      loaded.module.activate({
        manifest: loaded.metadata.manifest,
        configuration: {},
        services: serviceContainer,
        search: async () => ({
          protocolVersion: RUNTIME_PROTOCOL_VERSION,
          query: "",
          detail: "summary",
          matches: [],
        }),
        execute: async () => {
          throw new Error("Unexpected nested execution.");
        },
      });

    const firstActivation = await activate();
    expect(serviceContainer.get(DEBUGGER_HOST_ADAPTER_SERVICE)).toBe(debuggerHostAdapter);
    await compositionRegistry.clearProviderOverride(DEBUGGER_COMPOSITION_SERVICE);
    const firstNativeAdapter = serviceContainer.get(DEBUGGER_HOST_ADAPTER_SERVICE);
    expect(firstNativeAdapter).not.toBe(debuggerHostAdapter);
    await expect(
      firstNativeAdapter.invoke({
        capability: "debug.adapter.list",
        input: {},
        scope: {
          chatId: SESSION_ID,
          sessionId: SESSION_ID,
          workspaceName: WORKSPACE_NAME,
          executionBlockId: "debugger-native-first",
          scopeKey: `${SESSION_ID}:${WORKSPACE_NAME}`,
        },
      }),
    ).resolves.toMatchObject({
      adapters: expect.arrayContaining([expect.objectContaining({ type: "js-debug" })]),
    });

    await compositionRegistry.setProviderOverride(
      DEBUGGER_COMPOSITION_SERVICE,
      "@marshal/marshal:test-debugger-host",
    );
    await firstActivation.dispose?.();
    expect(serviceContainer.get(DEBUGGER_HOST_ADAPTER_SERVICE)).toBe(debuggerHostAdapter);

    const secondActivation = await activate();
    expect(serviceContainer.get(DEBUGGER_HOST_ADAPTER_SERVICE)).toBe(debuggerHostAdapter);
    await compositionRegistry.clearProviderOverride(DEBUGGER_COMPOSITION_SERVICE);
    const secondNativeAdapter = serviceContainer.get(DEBUGGER_HOST_ADAPTER_SERVICE);
    expect(secondNativeAdapter).not.toBe(debuggerHostAdapter);
    expect(secondNativeAdapter).not.toBe(firstNativeAdapter);
    await compositionRegistry.setProviderOverride(
      DEBUGGER_COMPOSITION_SERVICE,
      "@marshal/marshal:test-debugger-host",
    );
    await secondActivation.dispose?.();
    expect(serviceContainer.get(DEBUGGER_HOST_ADAPTER_SERVICE)).toBe(debuggerHostAdapter);
  });

  it("restores only an owned debugger override and preserves newer selection", async () => {
    const container = createRuntimeServiceContainer();
    const registry = new RuntimeCompositionRegistry({ container });
    const first = { invoke: vi.fn<DebuggerHostAdapter["invoke"]>() };
    const selected = { invoke: vi.fn<DebuggerHostAdapter["invoke"]>() };
    const newer = { invoke: vi.fn<DebuggerHostAdapter["invoke"]>() };
    const firstBinding = await bindAgenticDebuggerHostAdapter(registry, "debugger:first", first, {
      select: true,
    });
    const selectedBinding = await bindAgenticDebuggerHostAdapter(
      registry,
      "debugger:selected",
      selected,
      { select: true },
    );

    expect(container.get(DEBUGGER_HOST_ADAPTER_SERVICE)).toBe(selected);
    await selectedBinding.dispose();
    expect(container.get(DEBUGGER_HOST_ADAPTER_SERVICE)).toBe(first);

    const fallbackBinding = await bindAgenticDebuggerHostAdapter(
      registry,
      "debugger:fallback",
      selected,
    );
    await registry.setProviderOverride(DEBUGGER_COMPOSITION_SERVICE, "debugger:fallback");
    await fallbackBinding.dispose();
    expect(container.get(DEBUGGER_HOST_ADAPTER_SERVICE)).toBe(first);

    const secondSelectedBinding = await bindAgenticDebuggerHostAdapter(
      registry,
      "debugger:selected-again",
      selected,
      { select: true },
    );
    const newerBinding = await bindAgenticDebuggerHostAdapter(registry, "debugger:newer", newer, {
      select: true,
    });
    await secondSelectedBinding.dispose();
    expect(container.get(DEBUGGER_HOST_ADAPTER_SERVICE)).toBe(newer);

    await newerBinding.dispose();
    await firstBinding.dispose();
  });

  it("installs, disables, restores, enables, and removes the real external package", async () => {
    await host.start();
    await expect(
      api.listExtensions({ sessionId: SESSION_ID, workspaceName: WORKSPACE_NAME }),
    ).resolves.toMatchObject({ ok: true, value: [] });

    await installDebugger();

    await expect(
      api.listExtensions({ sessionId: SESSION_ID, workspaceName: WORKSPACE_NAME }),
    ).resolves.toMatchObject({
      ok: true,
      value: [
        {
          identity: BUILTIN_AGENTIC_DEBUGGER_EXTENSION_IDENTITY,
          version: "1.0.0",
          entrypoint: "dist/runtime-extension.cjs",
          status: "enabled",
        },
      ],
    });

    const search = await api.search({
      sessionId: SESSION_ID,
      workspaceName: WORKSPACE_NAME,
      tags: ["agentic-debugger"],
      detail: "full",
      limit: 100,
    });
    expect(search.ok).toBe(true);
    if (!search.ok) throw new Error(search.error.message);
    const capabilities = search.value.matches.map((match) => match.capability);
    expect(capabilities).toHaveLength(36);
    expect(capabilities.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "debug.session.launch",
        "debug.execution.continue",
        "debug.inspect.variables",
        "debug.ui.selectExecutionBlock",
      ]),
    );
    expect(capabilities.find(({ name }) => name === "debug.session.launch")).toMatchObject({
      version: "1.0.0",
      permissions: [
        {
          permission: "marshal.tool.invoke:debug.session.launch",
          risk: "high",
        },
      ],
    });

    const context = {
      sessionId: SESSION_ID,
      metadata: { marshalWorkspaceName: WORKSPACE_NAME },
    };
    await expect(host.listResources(context)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uri: UI_RESOURCE_URI, mimeType: "text/html" }),
      ]),
    );
    await expect(host.readResource(UI_RESOURCE_URI, context)).resolves.toMatchObject({
      uri: UI_RESOURCE_URI,
      mimeType: "text/html",
      text: expect.stringContaining('data-render-id="marshal.agentic-debugger.v1"'),
    });
    const initialNativeProviderId = nativeProviderId();
    await expect(
      api.setProvider({
        sessionId: SESSION_ID,
        workspaceName: WORKSPACE_NAME,
        identity: BUILTIN_AGENTIC_DEBUGGER_EXTENSION_IDENTITY,
        serviceId: AGENTIC_DEBUGGER_HOST_COMPOSITION_SERVICE.key,
        providerId: initialNativeProviderId,
        idempotencyKey: "debugger-select-native",
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      api.invoke({
        sessionId: SESSION_ID,
        workspaceName: WORKSPACE_NAME,
        capability: "debug.adapter.list",
        input: {},
        idempotencyKey: "debugger-native-installed",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        output: {
          value: {
            adapters: expect.arrayContaining([expect.objectContaining({ type: "js-debug" })]),
          },
        },
      },
    });

    await expect(
      api.disableExtension({
        sessionId: SESSION_ID,
        workspaceName: WORKSPACE_NAME,
        identity: BUILTIN_AGENTIC_DEBUGGER_EXTENSION_IDENTITY,
        idempotencyKey: "debugger-disable",
      }),
    ).resolves.toMatchObject({ ok: true, value: { status: "disabled" } });
    expect(
      compositionRegistry.snapshot().overrides[AGENTIC_DEBUGGER_HOST_COMPOSITION_SERVICE.key],
    ).toBe("@marshal/marshal:test-debugger-host");
    expect(serviceContainer.get(DEBUGGER_HOST_ADAPTER_SERVICE)).toBe(debuggerHostAdapter);
    await expect(
      api.invoke({
        sessionId: SESSION_ID,
        workspaceName: WORKSPACE_NAME,
        capability: "debug.adapter.list",
        input: {},
        idempotencyKey: "debugger-disabled-invoke",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "not-found" },
      receipts: [{ status: "not_found" }],
    });

    await expect(
      api.enableExtension({
        sessionId: SESSION_ID,
        workspaceName: WORKSPACE_NAME,
        identity: BUILTIN_AGENTIC_DEBUGGER_EXTENSION_IDENTITY,
        idempotencyKey: "debugger-enable",
      }),
    ).resolves.toMatchObject({ ok: true, value: { status: "enabled" } });
    const reenabledNativeProviderId = nativeProviderId();
    await expect(
      api.setProvider({
        sessionId: SESSION_ID,
        workspaceName: WORKSPACE_NAME,
        identity: BUILTIN_AGENTIC_DEBUGGER_EXTENSION_IDENTITY,
        serviceId: AGENTIC_DEBUGGER_HOST_COMPOSITION_SERVICE.key,
        providerId: reenabledNativeProviderId,
        idempotencyKey: "debugger-reselect-native",
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      api.invoke({
        sessionId: SESSION_ID,
        workspaceName: WORKSPACE_NAME,
        capability: "debug.adapter.list",
        input: {},
        idempotencyKey: "debugger-reenabled-invoke",
      }),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      api.disableExtension({
        sessionId: SESSION_ID,
        workspaceName: WORKSPACE_NAME,
        identity: BUILTIN_AGENTIC_DEBUGGER_EXTENSION_IDENTITY,
        idempotencyKey: "debugger-disable-before-restart",
      }),
    ).resolves.toMatchObject({ ok: true, value: { status: "disabled" } });

    api.dispose();
    await host.dispose();
    createHost();
    await host.start();

    await expect(
      api.listExtensions({ sessionId: SESSION_ID, workspaceName: WORKSPACE_NAME }),
    ).resolves.toMatchObject({
      ok: true,
      value: [
        {
          identity: BUILTIN_AGENTIC_DEBUGGER_EXTENSION_IDENTITY,
          status: "disabled",
        },
      ],
    });
    await expect(
      api.invoke({
        sessionId: SESSION_ID,
        workspaceName: WORKSPACE_NAME,
        capability: "debug.adapter.list",
        input: {},
        idempotencyKey: "debugger-disabled-after-restart",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "not-found" } });

    await expect(
      api.enableExtension({
        sessionId: SESSION_ID,
        workspaceName: WORKSPACE_NAME,
        identity: BUILTIN_AGENTIC_DEBUGGER_EXTENSION_IDENTITY,
        idempotencyKey: "debugger-enable-after-restart",
      }),
    ).resolves.toMatchObject({ ok: true, value: { status: "enabled" } });
    const restoredNativeProviderId = nativeProviderId();
    await expect(
      api.setProvider({
        sessionId: SESSION_ID,
        workspaceName: WORKSPACE_NAME,
        identity: BUILTIN_AGENTIC_DEBUGGER_EXTENSION_IDENTITY,
        serviceId: AGENTIC_DEBUGGER_HOST_COMPOSITION_SERVICE.key,
        providerId: restoredNativeProviderId,
        idempotencyKey: "debugger-select-native-after-restart",
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      api.invoke({
        sessionId: SESSION_ID,
        workspaceName: WORKSPACE_NAME,
        capability: "debug.adapter.list",
        input: {},
        idempotencyKey: "debugger-enabled-after-restart",
      }),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      api.removeExtension({
        sessionId: SESSION_ID,
        workspaceName: WORKSPACE_NAME,
        identity: BUILTIN_AGENTIC_DEBUGGER_EXTENSION_IDENTITY,
        idempotencyKey: "debugger-remove",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        identity: BUILTIN_AGENTIC_DEBUGGER_EXTENSION_IDENTITY,
        removed: true,
      },
    });
    expect(
      compositionRegistry.snapshot().overrides[AGENTIC_DEBUGGER_HOST_COMPOSITION_SERVICE.key],
    ).toBe("@marshal/marshal:test-debugger-host");
    expect(serviceContainer.get(DEBUGGER_HOST_ADAPTER_SERVICE)).toBe(debuggerHostAdapter);
    await expect(
      api.listExtensions({ sessionId: SESSION_ID, workspaceName: WORKSPACE_NAME }),
    ).resolves.toMatchObject({ ok: true, value: [] });
    await expect(
      api.invoke({
        sessionId: SESSION_ID,
        workspaceName: WORKSPACE_NAME,
        capability: "debug.adapter.list",
        input: {},
        idempotencyKey: "debugger-removed-invoke",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "not-found" } });

    await installDebugger("debugger-reinstall");
    const reinstalledNativeProviderId = nativeProviderId();
    await expect(
      api.setProvider({
        sessionId: SESSION_ID,
        workspaceName: WORKSPACE_NAME,
        identity: BUILTIN_AGENTIC_DEBUGGER_EXTENSION_IDENTITY,
        serviceId: AGENTIC_DEBUGGER_HOST_COMPOSITION_SERVICE.key,
        providerId: reinstalledNativeProviderId,
        idempotencyKey: "debugger-select-native-after-reinstall",
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      api.invoke({
        sessionId: SESSION_ID,
        workspaceName: WORKSPACE_NAME,
        capability: "debug.adapter.list",
        input: {},
        idempotencyKey: "debugger-reinstalled-invoke",
      }),
    ).resolves.toMatchObject({ ok: true });
  }, 60_000);
});
