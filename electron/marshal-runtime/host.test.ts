import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createAgentRuntime, createRuntimeServiceContainer } from "@marshal/runtime";
import {
  RUNTIME_EXTENSION_CATALOG_SERVICE,
  RUNTIME_EXTENSION_LIFECYCLE_SERVICE,
  RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE,
  type RuntimeExtensionCatalogService,
  type RuntimeExtensionUiPublishedApplication,
  type RuntimeExtensionUiPublicationService,
  type RuntimeExtensionLifecycleService,
  type RuntimeExtensionRecord,
} from "@marshal/runtime/extensions";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RUNTIME_UI_USER_SCOPE } from "../../common/runtime-ui";
import { testDouble } from "../testing/harness";
import { ProductionMarshalRuntimeApi } from "./api";
import type {
  MarshalRuntimeAuthorityPort,
  MarshalRuntimeApprovalPort,
  MarshalRuntimeCatalogPort,
  MarshalRuntimeFactory,
  MarshalRuntimeModule,
  MarshalRuntimePackageMetadata,
} from "./contracts";
import type { RuntimeExtensionSecrets } from "./extension-secrets";
import {
  MarshalRuntimeHost,
  MarshalRuntimeHostStartupError,
  publicAuthority,
  publicUiDelivery,
  type MarshalRuntimeHostOptions,
} from "./host";
import {
  MARSHAL_RUNTIME_LOCAL_ENV,
  MARSHAL_RUNTIME_LOCAL_FLAG_VALUE,
  MARSHAL_RUNTIME_SOURCE_ENV,
} from "./local-source";
import type { MarshalRuntimePackageLoader } from "./runtime-package-loader";
import { MarshalServiceSymbols } from "./service-symbols";
import type { RuntimeUiDeliveryPorts } from "./ui-controller";

const tempDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const metadata: MarshalRuntimePackageMetadata = {
  name: "@marshal/runtime",
  version: "0.1.0-test",
  entrypoint: "dist/host.js",
  entrySha256: "0".repeat(64),
};

const authority: MarshalRuntimeAuthorityPort = {
  async resolveScope(scope) {
    return { ...scope, workspacePath: "Q:\\runtime-test\\workspace" };
  },
  async authorize() {
    return { decision: "allow" };
  },
};

const catalog: MarshalRuntimeCatalogPort = {
  listTools: () => [],
  listSkills: () => [],
  getSkill: () => null,
  listWorkspaces: () => [],
  getSessionContext: async () => null,
};

async function hostRoots(): Promise<{
  readonly root: string;
  readonly workspace: string;
  readonly protectedResults: string;
  readonly worktrees: string;
  readonly extensions: string;
}> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "marshal-runtime-host-test-")));
  tempDirectories.push(root);
  const workspace = path.join(root, "workspace");
  const protectedResults = path.join(root, "protected-results");
  const worktrees = path.join(root, "worktrees");
  const extensions = path.join(root, "extensions");
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(protectedResults, { recursive: true }),
    mkdir(worktrees, { recursive: true }),
    mkdir(extensions, { recursive: true }),
  ]);
  return {
    root,
    workspace,
    protectedResults,
    worktrees,
    extensions,
  };
}

function loader(load: () => Promise<MarshalRuntimeModule>): MarshalRuntimePackageLoader {
  return {
    load: vi.fn<MarshalRuntimePackageLoader["load"]>().mockImplementation(load),
    metadata: () => metadata,
  };
}

function runtimeModule(
  dispose: () => Promise<void>,
  disposeDiscovery: () => Promise<void> = async () => undefined,
  createRuntime: MarshalRuntimeFactory = createAgentRuntime,
): MarshalRuntimeModule {
  const createRuntimeBuiltinsSource: MarshalRuntimeModule["createRuntimeBuiltinsSource"] =
    () => () => ({
      providers: [],
      dispose,
    });
  const snapshot = () => ({
    revision: 1,
    status: "ready" as const,
    scannedAt: "2026-08-29T00:00:00.000Z",
    candidates: [],
    diagnostics: [],
  });
  return {
    createAgentRuntime: createRuntime,
    createRuntimeBuiltinsSource,
    createRuntimeNativeExtensionDiscoveryService: async () => ({
      snapshot,
      subscribe: () => ({ dispose: () => undefined }),
      refresh: async () => snapshot(),
      dispose: disposeDiscovery,
    }),
  };
}

async function createHost(
  packageLoader: MarshalRuntimePackageLoader,
  hostAuthority: MarshalRuntimeAuthorityPort = authority,
  diagnostics?: { onEvent(event: { readonly type: string }): void },
  approval?: MarshalRuntimeApprovalPort,
): Promise<MarshalRuntimeHost> {
  const roots = await hostRoots();
  return new MarshalRuntimeHost({
    location: { isPackaged: false, appPath: roots.root, resourcesPath: roots.root },
    hostWorkspacePath: roots.workspace,
    protectedLifecycleResultRoot: roots.protectedResults,
    worktreeRoot: roots.worktrees,
    trustedExtensionRoot: roots.extensions,
    authority: hostAuthority,
    catalog,
    serviceContainer: createRuntimeServiceContainer(),
    packageLoader,
    ...(approval ? { approval } : {}),
    ...(diagnostics ? { diagnostics } : {}),
  });
}

describe("MarshalRuntimeHost", () => {
  it("starts once and disposes runtime bindings once", async () => {
    const disposeBindings = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const disposeDiscovery = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const packageLoader = loader(async () => runtimeModule(disposeBindings, disposeDiscovery));
    const diagnosticEvents: string[] = [];
    const approvalDispose = vi.fn<() => void>();
    const host = await createHost(
      packageLoader,
      authority,
      { onEvent: (event) => diagnosticEvents.push(event.type) },
      {
        permissionApproval: {
          requestApproval: () => ({ reason: "approval" }),
          verifyApproval: () => ({ approved: false }),
        },
        status: () => "missing",
        cancel: () => undefined,
        cancelRequest: () => undefined,
        dispose: approvalDispose,
      },
    );

    expect(host.getStatus().lifecycle).toBe("stopped");
    const firstStart = host.start();
    const secondStart = host.start();
    expect(secondStart).toBe(firstStart);
    await firstStart;
    expect(host.getStatus().lifecycle).toBe("running");
    expect(host.getExtensionDiscovery()?.snapshot().status).toBe("ready");
    expect(packageLoader.load).toHaveBeenCalledTimes(1);

    const firstDispose = host.dispose();
    const secondDispose = host.dispose();
    expect(secondDispose).toBe(firstDispose);
    await firstDispose;
    expect(disposeBindings).toHaveBeenCalledTimes(1);
    expect(disposeDiscovery).toHaveBeenCalledTimes(1);
    expect(approvalDispose).toHaveBeenCalledOnce();
    expect(host.getStatus().lifecycle).toBe("disposed");
    expect(diagnosticEvents).toEqual(
      expect.arrayContaining([
        "host.constructed",
        "host.start.requested",
        "host.running",
        "host.dispose.started",
        "host.disposed",
      ]),
    );
    await expect(host.start()).rejects.toThrow("Marshal Runtime host is disposed");
  });

  it("reports startup failures, permits an explicit retry, and maps API unavailability", async () => {
    const startupFailure = new Error("fixture runtime could not start");
    const packageLoader = loader(async () => {
      throw startupFailure;
    });
    const host = await createHost(packageLoader);

    const firstStart = host.start();
    expect(host.start()).toBe(firstStart);
    await expect(firstStart).rejects.toEqual(
      expect.objectContaining<Partial<MarshalRuntimeHostStartupError>>({
        code: "runtime_unavailable",
        cause: startupFailure,
      }),
    );
    expect(host.getStatus().lifecycle).toBe("failed");

    const api = new ProductionMarshalRuntimeApi(host);
    const result = await api.search({
      sessionId: "session-1",
      workspaceName: "workspace",
      query: "tools",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "runtime-unavailable", message: "Marshal Runtime host failed to start." },
    });
    expect(packageLoader.load).toHaveBeenCalledTimes(2);

    api.dispose();
    await host.dispose();
    expect(host.getStatus().lifecycle).toBe("disposed");
  });

  it("blocks lazy startup after an external startup prerequisite fails", async () => {
    const packageLoader = loader(async () => runtimeModule(async () => undefined));
    const diagnosticEvents: string[] = [];
    const host = await createHost(packageLoader, authority, {
      onEvent: (event) => diagnosticEvents.push(event.type),
    });
    const startupFailure = Object.assign(new Error("Runtime directory creation failed."), {
      code: "EPERM",
    });

    host.blockStartup(startupFailure);

    expect(host.getStatus().lifecycle).toBe("failed");
    await expect(host.start()).rejects.toMatchObject({
      code: "runtime_unavailable",
      cause: startupFailure,
    });
    const api = new ProductionMarshalRuntimeApi(host);
    await expect(
      api.search({
        sessionId: "session-1",
        workspaceName: "workspace",
        query: "tools",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "runtime-unavailable",
        message: "Marshal Runtime host failed to start.",
      },
    });
    expect(packageLoader.load).not.toHaveBeenCalled();
    expect(diagnosticEvents.filter((event) => event === "host.failed")).toHaveLength(1);

    api.dispose();
    await host.dispose();
    expect(() => host.blockStartup(new Error("late startup failure"))).not.toThrow();
    expect(host.getStatus().lifecycle).toBe("disposed");
  });

  it("rechecks cancellation after asynchronous scope resolution", async () => {
    let finishResolution:
      | ((value: { sessionId: string; workspaceName: string; workspacePath: string }) => void)
      | undefined;
    const resolvingAuthority: MarshalRuntimeAuthorityPort = {
      resolveScope: () =>
        new Promise((resolve) => {
          finishResolution = resolve;
        }),
      async authorize() {
        return { decision: "allow" };
      },
    };
    const host = await createHost(
      loader(async () => runtimeModule(async () => undefined)),
      resolvingAuthority,
    );
    const controller = new AbortController();
    const resolution = host.resolveScope(
      { sessionId: "session-1", workspaceName: "workspace" },
      controller.signal,
    );

    await vi.waitFor(() => expect(finishResolution).toBeTypeOf("function"));
    controller.abort();
    finishResolution?.({
      sessionId: "session-1",
      workspaceName: "workspace",
      workspacePath: "Q:\\runtime-test\\workspace",
    });

    await expect(resolution).rejects.toMatchObject({ code: "aborted" });
    await host.dispose();
  });

  it("fails clearly when Runtime omits extension host administration", async () => {
    const createRuntime: MarshalRuntimeFactory = async (options) => {
      const { extensionHost: _extensionHost, ...legacyBindings } =
        await createAgentRuntime(options);
      return legacyBindings;
    };
    const host = await createHost(
      loader(async () =>
        runtimeModule(vi.fn<() => Promise<void>>(), async () => undefined, createRuntime),
      ),
    );

    await expect(host.start()).rejects.toMatchObject({
      cause: {
        message: "Runtime extension lifecycle and background jobs are unavailable.",
      },
    });
    await host.dispose();
  });

  it("resolves Runtime calls through the current registered session workspace", async () => {
    const roots = await hostRoots();
    const namedWorkspace = path.join(roots.root, "named-workspace");
    const externalWorkspace = await mkdtemp(
      path.join(tmpdir(), "marshal-runtime-external-workspace-"),
    );
    tempDirectories.push(externalWorkspace);
    const replacementWorkspace = path.join(roots.root, "replacement-workspace");
    await Promise.all([mkdir(namedWorkspace), mkdir(replacementWorkspace)]);
    const bindings = new Map([
      ["session-default", { workspaceName: "workspace", workspacePath: roots.workspace }],
      ["session-named", { workspaceName: "Named", workspacePath: namedWorkspace }],
      ["session-external", { workspaceName: "External", workspacePath: externalWorkspace }],
    ]);
    const hostAuthority: MarshalRuntimeAuthorityPort = {
      resolveScope: vi.fn<MarshalRuntimeAuthorityPort["resolveScope"]>(async (scope) => {
        const binding = bindings.get(scope.sessionId);
        return binding && binding.workspaceName.toLowerCase() === scope.workspaceName.toLowerCase()
          ? { ...scope, ...binding }
          : null;
      }),
      authorize: vi.fn<MarshalRuntimeAuthorityPort["authorize"]>(async () => ({
        decision: "allow",
      })),
    };
    let runtimeOptions: Parameters<MarshalRuntimeFactory>[0] | undefined;
    const createRuntime: MarshalRuntimeFactory = async (options) => {
      runtimeOptions = options;
      return createAgentRuntime(options);
    };
    const serviceContainer = createRuntimeServiceContainer();
    const host = new MarshalRuntimeHost({
      location: { isPackaged: false, appPath: roots.root, resourcesPath: roots.root },
      hostWorkspacePath: roots.workspace,
      protectedLifecycleResultRoot: roots.protectedResults,
      worktreeRoot: roots.worktrees,
      trustedExtensionRoot: roots.extensions,
      authority: hostAuthority,
      catalog,
      serviceContainer,
      packageLoader: loader(async () =>
        runtimeModule(
          async () => undefined,
          async () => undefined,
          createRuntime,
        ),
      ),
    });

    await host.start();
    expect(hostAuthority.resolveScope).not.toHaveBeenCalled();
    const resolveWorkspace = runtimeOptions?.resolveWorkspace;
    expect(resolveWorkspace).toBeTypeOf("function");
    if (!resolveWorkspace) throw new Error("Runtime workspace resolver was not configured.");

    const resolve = (sessionId: string, workspaceName: string, workspacePath: string) =>
      resolveWorkspace({
        sessionId,
        workspacePath,
        metadata: { marshalWorkspaceName: workspaceName },
      });
    const defaultScope = await resolve("session-default", "workspace", externalWorkspace);
    const namedScope = await resolve("session-named", "named", roots.workspace);
    const externalScope = await resolve("session-external", "External", roots.workspace);
    const repeatedDefaultScope = await resolve("session-default", "workspace", externalWorkspace);
    expect(defaultScope.workspacePath).toBe(await realpath(roots.workspace));
    expect(namedScope.workspacePath).toBe(await realpath(namedWorkspace));
    expect(externalScope.workspacePath).toBe(await realpath(externalWorkspace));
    expect(repeatedDefaultScope).toEqual(defaultScope);
    expect(defaultScope).toMatchObject({
      workspaceId: expect.stringMatching(/^workspace-[a-f0-9]{24}$/),
      projectId: expect.stringMatching(/^project-[a-f0-9]{24}$/),
    });
    expect(
      new Set([defaultScope.workspaceId, namedScope.workspaceId, externalScope.workspaceId]).size,
    ).toBe(3);
    await rm(externalWorkspace, { recursive: true });
    await mkdir(externalWorkspace);
    const replacedExternalScope = await resolve("session-external", "External", roots.workspace);
    expect(replacedExternalScope.workspacePath).toBe(externalScope.workspacePath);
    expect(replacedExternalScope.workspaceId).not.toBe(externalScope.workspaceId);
    expect(replacedExternalScope.projectId).not.toBe(externalScope.projectId);

    const replacementAuthority: MarshalRuntimeAuthorityPort = {
      resolveScope: vi.fn<MarshalRuntimeAuthorityPort["resolveScope"]>(async (scope) =>
        scope.sessionId === "session-default" && scope.workspaceName === "workspace"
          ? { ...scope, workspacePath: replacementWorkspace }
          : null,
      ),
      authorize: hostAuthority.authorize,
    };
    await serviceContainer.replace(MarshalServiceSymbols.authority, {
      useValue: publicAuthority(replacementAuthority),
    });
    const replacementScope = await resolve("session-default", "workspace", roots.workspace);
    expect(replacementScope).toMatchObject({
      workspacePath: await realpath(replacementWorkspace),
    });
    expect(replacementScope.workspaceId).not.toBe(defaultScope.workspaceId);
    expect(replacementScope.projectId).not.toBe(defaultScope.projectId);
    expect(replacementAuthority.resolveScope).toHaveBeenCalledOnce();

    await expect(
      resolveWorkspace({
        workspacePath: roots.workspace,
        metadata: { marshalWorkspaceName: "workspace" },
      }),
    ).rejects.toMatchObject({ code: "invalid_scope" });
    await expect(
      resolveWorkspace({
        sessionId: "session-default",
        workspacePath: roots.workspace,
      }),
    ).rejects.toMatchObject({ code: "invalid_scope" });
    await expect(resolve("stale-session", "workspace", roots.workspace)).rejects.toMatchObject({
      code: "invalid_scope",
    });
    await expect(resolve("session-default", "mismatch", roots.workspace)).rejects.toMatchObject({
      code: "invalid_scope",
    });

    await host.dispose();
  });

  it("ends a runtime session against the workspace pinned at start after the session is gone", async () => {
    const roots = await hostRoots();
    const bindings = new Map([
      ["session-lifecycle", { workspaceName: "workspace", workspacePath: roots.workspace }],
    ]);
    const hostAuthority: MarshalRuntimeAuthorityPort = {
      resolveScope: vi.fn<MarshalRuntimeAuthorityPort["resolveScope"]>(async (scope) => {
        const binding = bindings.get(scope.sessionId);
        return binding ? { ...scope, ...binding } : null;
      }),
      authorize: vi.fn<MarshalRuntimeAuthorityPort["authorize"]>(async () => ({
        decision: "allow",
      })),
    };
    const host = new MarshalRuntimeHost({
      location: { isPackaged: false, appPath: roots.root, resourcesPath: roots.root },
      hostWorkspacePath: roots.workspace,
      protectedLifecycleResultRoot: roots.protectedResults,
      worktreeRoot: roots.worktrees,
      trustedExtensionRoot: roots.extensions,
      authority: hostAuthority,
      catalog,
      serviceContainer: createRuntimeServiceContainer(),
      packageLoader: loader(async () =>
        runtimeModule(
          async () => undefined,
          async () => undefined,
          createAgentRuntime,
        ),
      ),
    });

    await host.startRuntimeSession({ sessionId: "session-lifecycle", workspaceName: "workspace" });
    bindings.delete("session-lifecycle");

    await expect(
      host.startRuntimeSession({ sessionId: "session-lifecycle", workspaceName: "workspace" }),
    ).rejects.toMatchObject({ code: "invalid_scope" });
    await expect(
      host.endRuntimeSession({ sessionId: "session-lifecycle", outcome: "deleted:user-ipc" }),
    ).resolves.toBeDefined();
    await expect(host.endRuntimeSession({ sessionId: "session-lifecycle" })).rejects.toThrow(
      "not started in this app run",
    );

    await host.dispose();
  });

  it("injects secret storage only as a native extension backend module", async () => {
    const roots = await hostRoots();
    const extensionSecrets = {
      isAvailable: vi.fn<RuntimeExtensionSecrets["isAvailable"]>(() => true),
      seal: vi.fn<RuntimeExtensionSecrets["seal"]>(() => "opaque-fixture"),
      open: vi.fn<RuntimeExtensionSecrets["open"]>(() => "fixture-only-value"),
    };
    const host = new MarshalRuntimeHost({
      location: { isPackaged: false, appPath: roots.root, resourcesPath: roots.root },
      hostWorkspacePath: roots.workspace,
      protectedLifecycleResultRoot: roots.protectedResults,
      worktreeRoot: roots.worktrees,
      trustedExtensionRoot: roots.extensions,
      authority,
      catalog,
      extensionSecrets,
      serviceContainer: createRuntimeServiceContainer(),
      packageLoader: loader(async () => runtimeModule(async () => undefined)),
    });
    const packageRoot = path.join(roots.extensions, "secret-fixture");
    await mkdir(path.join(packageRoot, "dist"), { recursive: true });
    await Promise.all([
      writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@fixture/secrets",
          version: "1.0.0",
          type: "commonjs",
          main: "dist/index.cjs",
        }),
      ),
      writeFile(
        path.join(packageRoot, "runtime-extension.json"),
        JSON.stringify({
          schemaVersion: 1,
          identity: "@fixture/secrets",
          version: "1.0.0",
          entrypoint: "dist/index.cjs",
          moduleFormat: "commonjs-bundle-v1",
          contributes: { capabilities: ["fixture.secrets.check"] },
        }),
      ),
      writeFile(
        path.join(packageRoot, "dist/index.cjs"),
        `
        const secrets = require("@marshal/runtime-secrets");
        module.exports = { activate() {
          if (!secrets.isAvailable()) throw new Error("Storage unavailable");
          const namespace = "@fixture/secrets";
          const sealed = secrets.seal({ namespace, plaintext: "fixture-only-value" });
          if (secrets.open({ namespace, sealed }) !== "fixture-only-value") throw new Error("Roundtrip failed");
          const descriptor = { protocolVersion: "1.0.0", name: "fixture.secrets.check", version: "1.0.0", description: "Synthetic fixture check", inputSchema: {type: "object"}, outputSchema: {type: "object", properties: {ok: {type: "boolean"}}, additionalProperties: false}, permissions: [] };
          return { capabilityProviders: [{ id: "fixture-secrets-provider", version: "1.0.0", list: () => [descriptor], get: name => name === descriptor.name ? descriptor : undefined, invoke: () => ({output: {ok: true}}) }] };
        }};
      `,
      ),
    ]);
    try {
      await expect(host.installLocalExtension(packageRoot)).resolves.toMatchObject({
        identity: "@fixture/secrets",
        status: "enabled",
      });
      expect(extensionSecrets.isAvailable).toHaveBeenCalledOnce();
      expect(extensionSecrets.seal).toHaveBeenCalledWith({
        namespace: "@fixture/secrets",
        plaintext: "fixture-only-value",
      });
      expect(extensionSecrets.open).toHaveBeenCalledWith({
        namespace: "@fixture/secrets",
        sealed: "opaque-fixture",
      });
      expect(await host.ownsExtensionCapability("@fixture/secrets", "fixture.secrets.check")).toBe(
        true,
      );
      expect(await host.ownsExtensionCapability("@fixture/other", "fixture.secrets.check")).toBe(
        false,
      );
      expect(
        await host.ownsExtensionCapability("@fixture/secrets", "marshal.application.job.invoke"),
      ).toBe(false);
      await host.disableExtension("@fixture/secrets");
      expect(await host.ownsExtensionCapability("@fixture/secrets", "fixture.secrets.check")).toBe(
        false,
      );
    } finally {
      await host.dispose();
    }
  });

  it("preserves unrelated and failed-update applications while refreshing a replaced publication in place", async () => {
    const roots = await hostRoots();
    const serviceContainer = createRuntimeServiceContainer();
    const onApplicationInvalidated = vi.fn<
      NonNullable<MarshalRuntimeHostOptions["onApplicationInvalidated"]>
    >(async () => undefined);
    const host = new MarshalRuntimeHost({
      location: { isPackaged: false, appPath: roots.root, resourcesPath: roots.root },
      hostWorkspacePath: roots.workspace,
      protectedLifecycleResultRoot: roots.protectedResults,
      worktreeRoot: roots.worktrees,
      trustedExtensionRoot: roots.extensions,
      authority,
      onApplicationInvalidated,
      catalog,
      serviceContainer,
      resolveApplicationWorkspace: async () => roots.workspace,
      packageLoader: loader(async () => runtimeModule(async () => undefined)),
      ui: {
        delivery: {
          notification: vi.fn<RuntimeUiDeliveryPorts["notification"]>(),
          chatMessage: vi.fn<RuntimeUiDeliveryPorts["chatMessage"]>(),
          chatCard: vi.fn<RuntimeUiDeliveryPorts["chatCard"]>(),
        },
      },
    });
    await host.start();
    let applications: RuntimeExtensionUiPublishedApplication[] = ["one", "two"].map((id) => ({
      id,
      ownerId: `fixture.${id}`,
      revisionId: "v1",
      title: id,
      description: id,
      renderId: id,
      resource: { uri: `ui://${id}/v1`, mimeType: "text/html", text: "<h1>v1</h1>" },
      application: { version: "1.0.0", presentationModes: ["inline"], actions: [], tools: [] },
    }));
    const applicationForShutdown = applications[1];
    await serviceContainer.replace(RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE, {
      useValue: testDouble<RuntimeExtensionUiPublicationService>({
        listApplications: vi.fn<RuntimeExtensionUiPublicationService["listApplications"]>(
          async () => applications,
        ),
      }),
    });
    const enable = vi.fn<RuntimeExtensionLifecycleService["enable"]>(async () => {
      applications = applications.map((application) =>
        application.id === "one"
          ? {
              ...application,
              revisionId: "v2",
              resource: { ...application.resource, uri: "ui://one/v2", text: "<h1>v2</h1>" },
            }
          : application,
      );
      return testDouble<RuntimeExtensionRecord>({ identity: "fixture.one" });
    });
    await serviceContainer.replace(RUNTIME_EXTENSION_LIFECYCLE_SERVICE, {
      useValue: testDouble<RuntimeExtensionLifecycleService>({
        enable,
        disable: vi.fn<RuntimeExtensionLifecycleService["disable"]>(async (identity) => {
          applications = applications.filter((application) => application.ownerId !== identity);
          return testDouble<RuntimeExtensionRecord>({ identity });
        }),
      }),
    });
    const opened = await Promise.all(
      applications.map((application) =>
        host.ui!.open({
          ...RUNTIME_UI_USER_SCOPE,
          extensionId: application.ownerId,
          applicationId: application.id,
          surface: "tab",
          idempotencyKey: `open-${application.id}`,
          content: {
            kind: "application",
            renderId: application.renderId,
            resource: {
              uri: application.resource.uri,
              mimeType: application.resource.mimeType ?? "text/html",
            },
            descriptor: application.application,
            state: { draft: "retained" },
          },
        }),
      ),
    );
    expect(opened.every((result) => result.ok)).toBe(true);
    await serviceContainer.replace(RUNTIME_EXTENSION_CATALOG_SERVICE, {
      useValue: testDouble<RuntimeExtensionCatalogService>({ enable }),
    });
    await host.runExtensionCatalogOperation((catalogService) =>
      catalogService.enable("fixture.one", { principal: { id: "test", kind: "user" } }),
    );
    const afterUpdate = await host.ui!.snapshot(RUNTIME_UI_USER_SCOPE);
    expect(afterUpdate.ok && afterUpdate.value.instances).toHaveLength(2);
    const updated =
      afterUpdate.ok &&
      afterUpdate.value.instances.find((instance) => instance.owner.applicationId === "one");
    expect(updated).toMatchObject({
      instanceId: opened[0].ok && opened[0].value.instance?.instanceId,
      content: { resource: { uri: "ui://one/v2" }, state: { draft: "retained" } },
    });
    enable.mockRejectedValueOnce(new Error("activation failed"));
    await expect(host.enableExtension("fixture.two")).rejects.toThrow("activation failed");
    const afterFailure = await host.ui!.snapshot(RUNTIME_UI_USER_SCOPE);
    expect(afterFailure.ok && afterFailure.value.instances).toHaveLength(2);
    await host.disableExtension("fixture.one");
    const afterDisable = await host.ui!.snapshot(RUNTIME_UI_USER_SCOPE);
    expect(
      afterDisable.ok &&
        afterDisable.value.instances.map((instance) => instance.owner.applicationId),
    ).toEqual(["two"]);
    expect(onApplicationInvalidated).toHaveBeenCalledWith({
      extensionId: "fixture.one",
      applicationId: "one",
    });
    const remaining = afterDisable.ok ? afterDisable.value.instances[0] : undefined;
    if (!remaining) throw new Error("Fixture should retain the second application");
    await host.ui!.close({
      ...remaining.owner,
      instanceId: remaining.instanceId,
      idempotencyKey: "close-two",
    });
    onApplicationInvalidated.mockClear();
    await host.disableExtension("fixture.two");
    expect(onApplicationInvalidated).toHaveBeenCalledWith({
      extensionId: "fixture.two",
      applicationId: "two",
    });
    onApplicationInvalidated.mockClear();
    applications = [applicationForShutdown];
    await host.dispose();
    expect(onApplicationInvalidated).not.toHaveBeenCalled();
  });

  it("uses host authority and real delivery ports and disposes UI idempotently", async () => {
    const roots = await hostRoots();
    let denied = false;
    const hostAuthority: MarshalRuntimeAuthorityPort = {
      resolveScope: vi.fn<MarshalRuntimeAuthorityPort["resolveScope"]>(async (scope) => ({
        ...scope,
        workspacePath: roots.workspace,
      })),
      authorize: vi.fn<MarshalRuntimeAuthorityPort["authorize"]>(async () =>
        denied
          ? { decision: "deny", reason: "blocked", code: "permission_denied" }
          : { decision: "allow" },
      ),
    };
    const delivery: RuntimeUiDeliveryPorts = {
      notification: vi.fn<RuntimeUiDeliveryPorts["notification"]>(),
      chatMessage: vi.fn<RuntimeUiDeliveryPorts["chatMessage"]>(),
      chatCard: vi.fn<RuntimeUiDeliveryPorts["chatCard"]>(),
    };
    const serviceContainer = createRuntimeServiceContainer();
    const host = new MarshalRuntimeHost({
      location: { isPackaged: false, appPath: roots.root, resourcesPath: roots.root },
      hostWorkspacePath: roots.workspace,
      protectedLifecycleResultRoot: roots.protectedResults,
      worktreeRoot: roots.worktrees,
      trustedExtensionRoot: roots.extensions,
      authority: hostAuthority,
      catalog,
      serviceContainer,
      packageLoader: loader(async () => runtimeModule(async () => undefined)),
      ui: { delivery },
    });
    await host.start();
    const command = {
      sessionId: "session-1",
      workspaceName: "workspace",
      extensionId: "extension.test",
      applicationId: "application.test",
      title: "Title",
      message: "Body",
      idempotencyKey: "notification",
    };

    const first = await host.ui!.showNotification(command);
    const replay = await host.ui!.showNotification(command);
    expect(first).toMatchObject({ ok: true, value: { receipt: { status: "applied" } } });
    expect(replay).toMatchObject({ ok: true, value: { receipt: { status: "deduplicated" } } });
    expect(delivery.notification).toHaveBeenCalledOnce();
    expect(hostAuthority.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "ui.notification.show",
        permissions: ["marshal.ui.notification.show"],
      }),
    );

    const replacementDelivery: RuntimeUiDeliveryPorts = {
      notification: vi.fn<RuntimeUiDeliveryPorts["notification"]>(),
      chatMessage: vi.fn<RuntimeUiDeliveryPorts["chatMessage"]>(),
      chatCard: vi.fn<RuntimeUiDeliveryPorts["chatCard"]>(),
    };
    const replacementAuthority: MarshalRuntimeAuthorityPort = {
      ...hostAuthority,
      authorize: vi.fn<MarshalRuntimeAuthorityPort["authorize"]>((request) =>
        hostAuthority.authorize(request),
      ),
    };
    await serviceContainer.replace(MarshalServiceSymbols.authority, {
      useValue: publicAuthority(replacementAuthority),
    });
    await serviceContainer.replace(MarshalServiceSymbols.uiDelivery, {
      useValue: publicUiDelivery(replacementDelivery),
    });
    await expect(
      host.ui!.showNotification({ ...command, idempotencyKey: "replacement" }),
    ).resolves.toMatchObject({ ok: true });
    expect(replacementAuthority.authorize).toHaveBeenCalledOnce();
    expect(replacementDelivery.notification).toHaveBeenCalledOnce();
    expect(delivery.notification).toHaveBeenCalledOnce();

    denied = true;
    await expect(
      host.ui!.postChatMessage({
        sessionId: "session-1",
        workspaceName: "workspace",
        extensionId: "extension.test",
        applicationId: "application.test",
        content: { kind: "text", text: "Hello" },
        idempotencyKey: "denied",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "permission-denied" } });
    expect(delivery.chatMessage).not.toHaveBeenCalled();

    await host.dispose();
    await host.dispose();
    await expect(
      host.ui!.showNotification({ ...command, idempotencyKey: "disposed" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "runtime-unavailable" },
    });
  });

  it("discovers and installs a declared workspace package from the Runtime repository root", async () => {
    const roots = await hostRoots();
    const appPath = path.join(roots.root, "marshal");
    const runtimeRoot = path.join(roots.root, "marshal-runtime", "marshal-agent-runtime");
    const packageRoot = path.join(
      runtimeRoot,
      "extensions",
      "extension-repository",
      "packages",
      "runtime-extension",
    );
    await Promise.all([
      mkdir(appPath, { recursive: true }),
      mkdir(path.join(runtimeRoot, "packages", "runtime"), { recursive: true }),
    ]);
    await writeFile(path.join(runtimeRoot, "packages", "runtime", "package.json"), "{}");
    vi.stubEnv(MARSHAL_RUNTIME_LOCAL_ENV, MARSHAL_RUNTIME_LOCAL_FLAG_VALUE);
    vi.stubEnv(MARSHAL_RUNTIME_SOURCE_ENV, runtimeRoot);
    const serviceContainer = createRuntimeServiceContainer();
    const host = new MarshalRuntimeHost({
      location: { isPackaged: false, appPath, resourcesPath: appPath },
      hostWorkspacePath: roots.workspace,
      protectedLifecycleResultRoot: roots.protectedResults,
      worktreeRoot: roots.worktrees,
      trustedExtensionRoot: roots.extensions,
      authority,
      catalog,
      serviceContainer,
      packageLoader: loader(async () => runtimeModule(async () => undefined)),
    });

    await host.start();
    await mkdir(path.join(packageRoot, "dist"), { recursive: true });
    await Promise.all([
      writeFile(
        path.join(packageRoot, "..", "..", "package.json"),
        JSON.stringify({
          name: "extension-repository",
          private: true,
          workspaces: ["packages/runtime-extension"],
        }),
      ),
      writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@fixture/discovered-extension",
          version: "1.0.0",
          type: "commonjs",
          main: "dist/index.cjs",
        }),
      ),
      writeFile(
        path.join(packageRoot, "runtime-extension.json"),
        JSON.stringify({
          schemaVersion: 1,
          identity: "@fixture/discovered-extension",
          version: "1.0.0",
          entrypoint: "dist/index.cjs",
          moduleFormat: "commonjs-bundle-v1",
        }),
      ),
      writeFile(
        path.join(packageRoot, "dist", "index.cjs"),
        "module.exports={activate(){return {}}};",
      ),
    ]);

    const context = {
      principal: { id: "test", kind: "user" as const },
      scope: { sessionId: "test" },
    };
    const extensionCatalog = serviceContainer.get(RUNTIME_EXTENSION_CATALOG_SERVICE);
    const discovered = await extensionCatalog.discover(context);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      identity: "@fixture/discovered-extension",
      request: { packageRoot: await realpath(packageRoot) },
    });
    await expect(extensionCatalog.install(discovered[0].id, context)).resolves.toMatchObject({
      identity: "@fixture/discovered-extension",
      status: "enabled",
    });
    await host.dispose();
  });

  it("rejects a symlinked trusted extension root and cleans up started bindings", async () => {
    const roots = await hostRoots();
    const canonicalExtensions = path.join(roots.root, "canonical-extensions");
    await mkdir(canonicalExtensions);
    await rm(roots.extensions, { recursive: true });
    await symlink(
      canonicalExtensions,
      roots.extensions,
      process.platform === "win32" ? "junction" : "dir",
    );
    const disposeBindings = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const host = new MarshalRuntimeHost({
      location: { isPackaged: false, appPath: roots.root, resourcesPath: roots.root },
      hostWorkspacePath: roots.workspace,
      protectedLifecycleResultRoot: roots.protectedResults,
      worktreeRoot: roots.worktrees,
      trustedExtensionRoot: roots.extensions,
      authority,
      catalog,
      serviceContainer: createRuntimeServiceContainer(),
      packageLoader: loader(async () => runtimeModule(disposeBindings)),
    });

    await expect(host.start()).rejects.toMatchObject({
      code: "runtime_unavailable",
    });
    expect(disposeBindings).toHaveBeenCalledTimes(1);
    expect(host.getStatus().lifecycle).toBe("failed");
    await host.dispose();
  });
});
