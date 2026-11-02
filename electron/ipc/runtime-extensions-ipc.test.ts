import { createRuntimeServiceContainer } from "@marshal/runtime";
import {
  RUNTIME_EXTENSION_CATALOG_SERVICE,
  RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE,
  type RuntimeExtensionCatalogEntry,
  type RuntimeExtensionCatalogService,
  type RuntimeExtensionRecord,
  type RuntimeExtensionUiPublicationService,
} from "@marshal/runtime/extensions";
import { describe, expect, it, vi } from "vitest";

import type { IpcHandler, IpcInvokeMap } from "../../common/marshal-ipc-contract";
import type { MarshalRuntimeApi } from "../marshal-runtime/contracts";
import type {
  MarshalRuntimeExtensionDiscovery,
  MarshalRuntimeExtensionDiscoverySnapshot,
} from "../marshal-runtime/host";
import { flushMicrotasks, testDouble } from "../testing/harness";
import { registerRuntimeExtensionsHandlers } from "./runtime-extensions-ipc";

type RegisteredHandler = (...args: unknown[]) => unknown;

const scope = { sessionId: "session-1", workspaceName: "workspace-1" };
const record: RuntimeExtensionRecord = {
  identity: "@fixture/extension",
  version: "1.0.0",
  integrity: {
    algorithm: "sha256",
    domain: "marshal-runtime-extension-package-v1",
    value: "a".repeat(64),
  },
  entrypoint: "dist/index.cjs",
  status: "enabled",
  activationOrder: 1,
  configuration: {},
};

function catalogService(query: string): RuntimeExtensionCatalogService {
  return testDouble<RuntimeExtensionCatalogService>({
    discover: vi.fn<RuntimeExtensionCatalogService["discover"]>().mockResolvedValue([]),
    search: vi
      .fn<RuntimeExtensionCatalogService["search"]>()
      .mockResolvedValue({ query, matches: [] }),
    install: vi.fn<RuntimeExtensionCatalogService["install"]>().mockResolvedValue(record),
    update: vi.fn<RuntimeExtensionCatalogService["update"]>().mockResolvedValue(record),
    enable: vi.fn<RuntimeExtensionCatalogService["enable"]>().mockResolvedValue(record),
    disable: vi.fn<RuntimeExtensionCatalogService["disable"]>().mockResolvedValue({
      ...record,
      status: "disabled",
    }),
    remove: vi.fn<RuntimeExtensionCatalogService["remove"]>().mockResolvedValue(undefined),
  });
}

async function createHarness(options?: {
  readonly publication?: RuntimeExtensionUiPublicationService;
  readonly discovery?: MarshalRuntimeExtensionDiscovery;
  readonly emitChanged?: (event: { revision: number }) => void;
  readonly runtimeApi?: MarshalRuntimeApi;
  readonly runtimeReady?: () => Promise<void>;
}) {
  const serviceContainer = createRuntimeServiceContainer();
  const service = catalogService("initial");
  await serviceContainer.bind(RUNTIME_EXTENSION_CATALOG_SERVICE, { useValue: service });
  if (options?.publication) {
    await serviceContainer.bind(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE, {
      useValue: options.publication,
    });
  }
  const handlers = new Map<string, RegisteredHandler>();
  const runCatalogOperation = vi.fn<() => void>();
  const dispose = registerRuntimeExtensionsHandlers({
    serviceContainer,
    runCatalogOperation: async (operation) => {
      runCatalogOperation();
      return operation(serviceContainer.get(RUNTIME_EXTENSION_CATALOG_SERVICE));
    },
    extensionDiscovery: options?.discovery ? () => options.discovery : undefined,
    emitChanged: options?.emitChanged,
    runtimeApi: options?.runtimeApi,
    runtimeReady: options?.runtimeReady,
    ipcHandle: <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) => {
      handlers.set(channel, testDouble<RegisteredHandler>(handler));
    },
  });
  return { handlers, service, serviceContainer, runCatalogOperation, dispose };
}

function discoverySnapshot(revision: number) {
  return {
    revision,
    status: "ready" as const,
    scannedAt: "2026-08-29T00:00:00.000Z",
    candidates: [],
    diagnostics: [],
  };
}

describe("Runtime extensions IPC", () => {
  it("passes explicit scope to Runtime catalog search and resolves replacements per call", async () => {
    const { handlers, service, serviceContainer } = await createHarness();
    const request = { ...scope, search: { query: "browser", limit: 5 } };

    await expect(handlers.get("runtime-extensions:search")!(undefined, request)).resolves.toEqual({
      success: true,
      value: { query: "initial", matches: [] },
    });
    expect(service.search).toHaveBeenCalledWith(
      request.search,
      expect.objectContaining({
        principal: { id: "marshal-renderer", kind: "user" },
        scope: { sessionId: scope.sessionId },
        metadata: { marshalWorkspaceName: scope.workspaceName },
      }),
    );

    await serviceContainer.replace(RUNTIME_EXTENSION_CATALOG_SERVICE, {
      useValue: catalogService("replacement"),
    });
    await expect(handlers.get("runtime-extensions:search")!(undefined, request)).resolves.toEqual({
      success: true,
      value: { query: "replacement", matches: [] },
    });
  });

  it("routes lifecycle actions and rejects unknown request fields", async () => {
    const { handlers, service } = await createHarness();

    await expect(
      handlers.get("runtime-extensions:disable")!(undefined, {
        ...scope,
        identity: record.identity,
      }),
    ).resolves.toMatchObject({
      success: true,
      value: { identity: record.identity, status: "disabled" },
    });
    expect(service.disable).toHaveBeenCalledWith(
      record.identity,
      expect.objectContaining({ scope: { sessionId: scope.sessionId } }),
    );

    await expect(
      handlers.get("runtime-extensions:search")!(undefined, {
        ...scope,
        search: {},
        unexpected: true,
      }),
    ).resolves.toEqual({
      success: false,
      error: "Invalid Runtime extension request.",
    });
    expect(service.search).not.toHaveBeenCalled();
  });

  it("routes catalog mutations through the host lifecycle queue without affecting catalog reads", async () => {
    const { handlers, runCatalogOperation } = await createHarness();
    await expect(
      handlers.get("runtime-extensions:search")!(undefined, { ...scope, search: {} }),
    ).resolves.toMatchObject({ success: true });
    expect(runCatalogOperation).not.toHaveBeenCalled();
    await expect(
      handlers.get("runtime-extensions:disable")!(undefined, {
        ...scope,
        identity: record.identity,
      }),
    ).resolves.toMatchObject({ success: true });
    expect(runCatalogOperation).toHaveBeenCalledOnce();
  });

  it("does not report a changed catalog when its host lifecycle operation fails", async () => {
    const emitChanged = vi.fn<(event: { revision: number }) => void>();
    const { handlers, service } = await createHarness({ emitChanged });
    vi.mocked(service.disable).mockRejectedValueOnce(new Error("activation failed"));
    await expect(
      handlers.get("runtime-extensions:disable")!(undefined, {
        ...scope,
        identity: record.identity,
      }),
    ).resolves.toEqual({ success: false, error: "activation failed" });
    expect(emitChanged).not.toHaveBeenCalled();
  });

  it("projects invalid and installed extension status from discovery plus administration", async () => {
    const discovery = testDouble<MarshalRuntimeExtensionDiscovery>({
      snapshot: () => ({
        revision: 7,
        status: "ready",
        scannedAt: "2026-08-29T00:00:00.000Z",
        candidates: [
          {
            packageRoot: "Q:/extensions/broken",
            status: "unbuilt",
            identity: "@fixture/broken",
            version: "1.0.0",
            installation: { script: "install:marshal", packageManager: "pnpm" },
            diagnostics: [
              {
                code: "entrypoint_missing",
                path: "Q:/extensions/broken/dist/index.cjs",
                message: "Runtime extension entrypoint has not been built.",
              },
            ],
          },
        ],
        diagnostics: [],
      }),
      subscribe: vi
        .fn<MarshalRuntimeExtensionDiscovery["subscribe"]>()
        .mockReturnValue({ dispose: vi.fn<() => void>() }),
    });
    const { handlers, service } = await createHarness({ discovery });
    vi.mocked(service.discover).mockResolvedValue([
      testDouble<RuntimeExtensionCatalogEntry>({
        id: "@fixture/extension@1.0.0",
        identity: record.identity,
        version: record.version,
        installation: record,
      }),
    ]);

    await expect(
      handlers.get("runtime-extensions:status")!(undefined, scope),
    ).resolves.toMatchObject({
      success: true,
      value: {
        revision: 7,
        items: [
          {
            identity: "@fixture/broken",
            status: "unbuilt",
            installation: { script: "install:marshal", packageManager: "pnpm" },
          },
          { identity: record.identity, status: "installed-enabled" },
        ],
      },
    });
  });

  it("projects ONE row per enabled identity when the same install is reachable through discovery and the native catalog (HOST-UX-1)", async () => {
    // Live defect: the one enabled @marshal/code-review identity rendered TWO
    // installed-enabled rows -- one from a materialized discovery root whose
    // candidate carries catalogEntry id A, one from a native catalog entry
    // with id B that no candidate references. The identity+version dedupe
    // only covered discovery candidates; the catalog-entries loop appended
    // unconditionally.
    const discovery = testDouble<MarshalRuntimeExtensionDiscovery>({
      snapshot: () => ({
        revision: 9,
        status: "ready",
        scannedAt: "2026-09-11T00:00:00.000Z",
        candidates: [
          {
            packageRoot: "Q:/extensions/materialized-code-review",
            status: "installable",
            identity: record.identity,
            version: record.version,
            catalogEntry: { id: "materialized:@fixture/extension@1.0.0" },
            diagnostics: [],
          },
        ],
        diagnostics: [],
      }),
      subscribe: vi
        .fn<MarshalRuntimeExtensionDiscovery["subscribe"]>()
        .mockReturnValue({ dispose: vi.fn<() => void>() }),
    });
    const { handlers, service } = await createHarness({ discovery });
    vi.mocked(service.discover).mockResolvedValue([
      testDouble<RuntimeExtensionCatalogEntry>({
        id: "materialized:@fixture/extension@1.0.0",
        identity: record.identity,
        version: record.version,
        installation: record,
      }),
      testDouble<RuntimeExtensionCatalogEntry>({
        id: "native:@fixture/extension@1.0.0",
        identity: record.identity,
        version: record.version,
        installation: record,
      }),
    ]);

    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- assertion is guarded by the surrounding logic; a typed guard is lint debt
    const response = (await handlers.get("runtime-extensions:status")!(undefined, scope)) as {
      success: boolean;
      value: { items: readonly { identity?: string; status: string }[] };
    };
    expect(response.success).toBe(true);
    const rows = response.value.items.filter((item) => item.identity === record.identity);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("installed-enabled");
  });

  it("publishes installing state and rejects a concurrent duplicate install", async () => {
    let resolveInstall!: (value: RuntimeExtensionRecord) => void;
    const installPending = new Promise<RuntimeExtensionRecord>((resolve) => {
      resolveInstall = resolve;
    });
    const emitChanged = vi.fn<(event: { revision: number }) => void>();
    const { handlers, service } = await createHarness({ emitChanged });
    vi.mocked(service.install).mockReturnValue(installPending);
    const request = { ...scope, catalogEntryId: "@fixture/extension@1.0.0" };

    const first = handlers.get("runtime-extensions:install")!(undefined, request);
    await expect(handlers.get("runtime-extensions:install")!(undefined, request)).resolves.toEqual({
      success: false,
      error: "This Runtime extension installation is already active.",
    });
    await expect(
      handlers.get("runtime-extensions:status")!(undefined, scope),
    ).resolves.toMatchObject({
      success: true,
      value: { items: [{ catalogEntryId: request.catalogEntryId, status: "installing" }] },
    });

    resolveInstall(record);
    await expect(first).resolves.toMatchObject({ success: true });
    expect(emitChanged).toHaveBeenCalledTimes(3);
  });

  it("publishes changes for direct Runtime API mutations", async () => {
    const emitChanged = vi.fn<(event: { revision: number }) => void>();
    const success = { ok: true as const, value: record, receipts: [] };
    const runtimeApi = testDouble<MarshalRuntimeApi>({
      updateExtension: vi.fn<MarshalRuntimeApi["updateExtension"]>().mockResolvedValue(success),
      configureExtension: vi
        .fn<MarshalRuntimeApi["configureExtension"]>()
        .mockResolvedValue(success),
      setProvider: vi.fn<MarshalRuntimeApi["setProvider"]>().mockResolvedValue(success),
      clearProvider: vi.fn<MarshalRuntimeApi["clearProvider"]>().mockResolvedValue(success),
    });
    const listApplications = vi.fn<RuntimeExtensionUiPublicationService["listApplications"]>();
    const { handlers, runCatalogOperation } = await createHarness({
      emitChanged,
      runtimeApi,
      publication: testDouble<RuntimeExtensionUiPublicationService>({ listApplications }),
    });

    await expect(
      handlers.get("runtime-extensions:update")!(undefined, {
        ...scope,
        identity: record.identity,
        packageRoot: "Q:/extensions/updated",
      }),
    ).resolves.toMatchObject({ success: true });
    await expect(
      handlers.get("runtime-extensions:configure")!(undefined, {
        ...scope,
        identity: record.identity,
        configuration: { enabled: true },
      }),
    ).resolves.toMatchObject({ success: true });
    await expect(
      handlers.get("runtime-extensions:setProvider")!(undefined, {
        ...scope,
        identity: record.identity,
        serviceId: "fixture.service",
        providerId: "fixture.provider",
      }),
    ).resolves.toMatchObject({ success: true });
    await expect(
      handlers.get("runtime-extensions:clearProvider")!(undefined, {
        ...scope,
        identity: record.identity,
        serviceId: "fixture.service",
      }),
    ).resolves.toMatchObject({ success: true });

    expect(emitChanged).toHaveBeenCalledTimes(4);
    expect(runCatalogOperation).not.toHaveBeenCalled();
    expect(listApplications).not.toHaveBeenCalled();
  });
});

// R6: an already-open window must learn about agent-path extension installs/updates
// (runtime-extensions:changed) without the renderer ever touching extensions IPC first.
describe("Runtime extensions IPC — eager discovery subscription (R6)", () => {
  it("subscribes to extension discovery at registration time, before any renderer IPC call", async () => {
    const subscribe = vi
      .fn<MarshalRuntimeExtensionDiscovery["subscribe"]>()
      .mockReturnValue({ dispose: vi.fn<() => void>() });
    const discovery = testDouble<MarshalRuntimeExtensionDiscovery>({
      snapshot: () => discoverySnapshot(1),
      subscribe,
    });

    await createHarness({ discovery });

    // No handler was ever invoked here — this is the R6 reproduction: prior to the
    // fix, `subscribe` was only ever called lazily from the "runtime-extensions:status"
    // handler, so this assertion is red on unfixed code.
    expect(subscribe).toHaveBeenCalledOnce();
  });

  it("broadcasts runtime-extensions:changed on a discovery revision bump, with no renderer call", async () => {
    let onSnapshot: ((snapshot: MarshalRuntimeExtensionDiscoverySnapshot) => void) | undefined;
    const discovery = testDouble<MarshalRuntimeExtensionDiscovery>({
      snapshot: () => discoverySnapshot(1),
      subscribe: vi
        .fn<MarshalRuntimeExtensionDiscovery["subscribe"]>()
        .mockImplementation((listener) => {
          onSnapshot = listener;
          return { dispose: vi.fn<() => void>() };
        }),
    });
    const emitChanged = vi.fn<(event: { revision: number }) => void>();

    await createHarness({ discovery, emitChanged });

    expect(onSnapshot).toBeDefined();
    onSnapshot!(discoverySnapshot(9));
    expect(emitChanged).toHaveBeenCalledWith(expect.objectContaining({ revision: 9 }));
  });

  it("subscribes once extension discovery becomes available after runtimeReady resolves", async () => {
    let discoveryReady = false;
    let resolveRuntimeReady!: () => void;
    const runtimeReadyPromise = new Promise<void>((resolve) => {
      resolveRuntimeReady = resolve;
    });
    const subscribe = vi
      .fn<MarshalRuntimeExtensionDiscovery["subscribe"]>()
      .mockReturnValue({ dispose: vi.fn<() => void>() });
    const discovery = testDouble<MarshalRuntimeExtensionDiscovery>({
      snapshot: () => discoverySnapshot(1),
      subscribe,
    });
    const serviceContainer = createRuntimeServiceContainer();
    await serviceContainer.bind(RUNTIME_EXTENSION_CATALOG_SERVICE, {
      useValue: catalogService("initial"),
    });
    const handlers = new Map<string, RegisteredHandler>();

    registerRuntimeExtensionsHandlers({
      serviceContainer,
      runCatalogOperation: async (operation) =>
        operation(serviceContainer.get(RUNTIME_EXTENSION_CATALOG_SERVICE)),
      extensionDiscovery: () => (discoveryReady ? discovery : undefined),
      runtimeReady: () => runtimeReadyPromise,
      ipcHandle: <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) => {
        handlers.set(channel, testDouble<RegisteredHandler>(handler));
      },
    });
    await flushMicrotasks();
    expect(subscribe).not.toHaveBeenCalled();

    discoveryReady = true;
    resolveRuntimeReady();
    await flushMicrotasks();

    expect(subscribe).toHaveBeenCalledOnce();
  });

  it("does not double-subscribe when the renderer later calls runtime-extensions:status", async () => {
    const subscribe = vi
      .fn<MarshalRuntimeExtensionDiscovery["subscribe"]>()
      .mockReturnValue({ dispose: vi.fn<() => void>() });
    const discovery = testDouble<MarshalRuntimeExtensionDiscovery>({
      snapshot: () => discoverySnapshot(1),
      subscribe,
    });

    const { handlers } = await createHarness({ discovery });
    expect(subscribe).toHaveBeenCalledOnce();

    await handlers.get("runtime-extensions:status")!(undefined, scope);

    expect(subscribe).toHaveBeenCalledOnce();
  });

  it("does not throw, delay registration, or crash on a rejected eager runtimeReady()", async () => {
    const serviceContainer = createRuntimeServiceContainer();
    await serviceContainer.bind(RUNTIME_EXTENSION_CATALOG_SERVICE, {
      useValue: catalogService("initial"),
    });

    expect(() =>
      registerRuntimeExtensionsHandlers({
        serviceContainer,
        runCatalogOperation: async (operation) =>
          operation(serviceContainer.get(RUNTIME_EXTENSION_CATALOG_SERVICE)),
        runtimeReady: () => Promise.reject(new Error("boom")),
        ipcHandle: () => undefined,
      }),
    ).not.toThrow();

    await flushMicrotasks();
  });

  // F-001: if the disposer runs before the eager `runtimeReady()` promise settles,
  // the pending `.then(() => ensureDiscoverySubscription())` callback must not
  // resubscribe after teardown — otherwise a listener stays active past disposal
  // and may emit through a disposed/replaced registration.
  it("F-001: discovery initially absent — stays unsubscribed after dispose, even once runtimeReady resolves late", async () => {
    let discoveryReady = false;
    let resolveRuntimeReady!: () => void;
    const runtimeReadyPromise = new Promise<void>((resolve) => {
      resolveRuntimeReady = resolve;
    });
    const subscribe = vi
      .fn<MarshalRuntimeExtensionDiscovery["subscribe"]>()
      .mockReturnValue({ dispose: vi.fn<() => void>() });
    const discovery = testDouble<MarshalRuntimeExtensionDiscovery>({
      snapshot: () => discoverySnapshot(1),
      subscribe,
    });
    const serviceContainer = createRuntimeServiceContainer();
    await serviceContainer.bind(RUNTIME_EXTENSION_CATALOG_SERVICE, {
      useValue: catalogService("initial"),
    });

    const dispose = registerRuntimeExtensionsHandlers({
      serviceContainer,
      runCatalogOperation: async (operation) =>
        operation(serviceContainer.get(RUNTIME_EXTENSION_CATALOG_SERVICE)),
      extensionDiscovery: () => (discoveryReady ? discovery : undefined),
      runtimeReady: () => runtimeReadyPromise,
      ipcHandle: () => undefined,
    });
    await flushMicrotasks();
    expect(subscribe).not.toHaveBeenCalled();

    dispose();
    discoveryReady = true;
    resolveRuntimeReady();
    await flushMicrotasks();

    expect(subscribe).not.toHaveBeenCalled();
  });

  it("F-001: discovery initially present — unsubscribes on dispose and does not resurrect on late runtimeReady", async () => {
    let resolveRuntimeReady!: () => void;
    const runtimeReadyPromise = new Promise<void>((resolve) => {
      resolveRuntimeReady = resolve;
    });
    const disposeSubscription = vi.fn<() => void>();
    const subscribe = vi
      .fn<MarshalRuntimeExtensionDiscovery["subscribe"]>()
      .mockReturnValue({ dispose: disposeSubscription });
    const discovery = testDouble<MarshalRuntimeExtensionDiscovery>({
      snapshot: () => discoverySnapshot(1),
      subscribe,
    });

    const { dispose } = await createHarness({ discovery, runtimeReady: () => runtimeReadyPromise });
    expect(subscribe).toHaveBeenCalledOnce();
    expect(disposeSubscription).not.toHaveBeenCalled();

    dispose();
    expect(disposeSubscription).toHaveBeenCalledOnce();

    resolveRuntimeReady();
    await flushMicrotasks();

    expect(subscribe).toHaveBeenCalledOnce();
    expect(disposeSubscription).toHaveBeenCalledOnce();
  });
});
