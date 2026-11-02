import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createAgentRuntime,
  createRuntimeServiceContainer,
  RUNTIME_PROTOCOL_VERSION,
} from "@marshal/runtime";
import {
  computeRuntimeExtensionIntegrity,
  type RuntimeExtensionIntegrity,
} from "@marshal/runtime/extensions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProductionMarshalRuntimeApi } from "./api";
import {
  MARSHAL_RUNTIME_PERMISSION,
  type MarshalRuntimeAuthorityPort,
  type MarshalRuntimeAuthorityRequest,
  type MarshalRuntimeCatalogPort,
  type MarshalRuntimeModule,
  type MarshalRuntimePackageMetadata,
} from "./contracts";
import { MarshalRuntimeHost } from "./host";
import type { MarshalRuntimePackageLoader } from "./runtime-package-loader";
import type { RuntimeUiDeliveryPorts } from "./ui-controller";
import type { ResolvedFirstPartyExtension } from "./first-party-extension-catalog";

const SESSION_ID = "session-1";
const WORKSPACE_NAME = "workspace";
const EXTENSION_IDENTITY = "@fixture/live-extension";
const CAPABILITY_NAME = "fixture.live-extension.echo";

interface MaterializedExtension {
  readonly packageRoot: string;
  readonly integrity: RuntimeExtensionIntegrity;
}

interface ExtensionSourceOptions {
  readonly identity?: string;
  readonly version: string;
  readonly activationFailure?: boolean;
  readonly activationDelayMs?: number;
  readonly waitForCancellation?: boolean;
  readonly eventKey?: string;
  readonly uiApplicationId?: string;
  readonly capabilityProvider?: boolean;
}

const packageMetadata: MarshalRuntimePackageMetadata = {
  name: "@marshal/runtime",
  version: "0.1.0-test",
  entrypoint: "dist/host.js",
  entrySha256: "0".repeat(64),
};

function extensionSource(options: ExtensionSourceOptions): string {
  const eventKey = options.eventKey ? JSON.stringify(options.eventKey) : "undefined";
  const uiApplications = options.uiApplicationId
    ? `[{
        id: ${JSON.stringify(options.uiApplicationId)},
        title: "Live test application",
        description: "Live test application",
        renderId: "live-test-renderer",
        resource: {
          uri: ${JSON.stringify(`ui://fixture/${options.uiApplicationId}`)},
          mimeType: "text/html",
          text: "<main>Live test application</main>"
        },
        application: {
          version: "1.0.0",
          presentationModes: ["inline", "fullscreen", "pip"],
          actions: [],
          tools: []
        }
      }]`
    : "undefined";
  const capabilityProviders =
    options.capabilityProvider === false
      ? "undefined"
      : `[{
            id: "fixture.live-extension",
            version: ${JSON.stringify(options.version)},
            list() { return [descriptor]; },
            get(name) { return name === descriptor.name ? descriptor : undefined; },
            invoke(name, input) {
              if (name !== descriptor.name) throw Object.assign(new Error("not found"), { code: "not_found" });
              return { output: { version: ${JSON.stringify(options.version)}, input } };
            }
          }]`;
  return `
    const eventKey = ${eventKey};
    const events = eventKey ? globalThis[eventKey] : undefined;
    const descriptor = Object.freeze({
      protocolVersion: ${JSON.stringify(RUNTIME_PROTOCOL_VERSION)},
      name: ${JSON.stringify(CAPABILITY_NAME)},
      version: ${JSON.stringify(options.version)},
      title: "Live extension echo",
      description: "Returns the active live extension version.",
      inputSchema: { type: "object", additionalProperties: true },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["version", "input"],
        properties: { version: { type: "string" }, input: {} }
      }
    });
    module.exports = {
      async activate(context) {
        events?.push("activation-started");
        ${
          options.waitForCancellation
            ? `
        await new Promise((_, reject) => {
          const abort = () => reject(Object.assign(new Error("cancelled"), { code: "CANCELLED" }));
          if (context.signal?.aborted) abort();
          else context.signal?.addEventListener("abort", abort, { once: true });
        });
        `
            : ""
        }
        ${
          options.activationDelayMs
            ? `await new Promise((resolve) => setTimeout(resolve, ${options.activationDelayMs}));`
            : ""
        }
        ${options.activationFailure ? `throw new Error("fixture activation failed");` : ""}
        return {
          uiApplications: ${uiApplications},
          capabilityProviders: ${capabilityProviders},
          dispose() { events?.push("extension-dispose"); }
        };
      }
    };
  `;
}

describe("live Marshal Runtime extensions", () => {
  let root: string;
  let trustedExtensionRoot: string;
  let host: MarshalRuntimeHost;
  let api: ProductionMarshalRuntimeApi;
  let deniedPermissions: Set<string>;
  let authorizationRequests: MarshalRuntimeAuthorityRequest[];
  let bindingDisposalEvents: string[];
  let authority: MarshalRuntimeAuthorityPort;
  let catalog: MarshalRuntimeCatalogPort;
  let packageLoader: MarshalRuntimePackageLoader;
  let delivery: RuntimeUiDeliveryPorts;

  function createHost(firstPartyExtensions?: readonly ResolvedFirstPartyExtension[]): void {
    host = new MarshalRuntimeHost({
      location: { isPackaged: false, appPath: root, resourcesPath: root },
      hostWorkspacePath: path.join(root, "workspace"),
      protectedLifecycleResultRoot: path.join(root, "protected-results"),
      worktreeRoot: path.join(root, "worktrees"),
      trustedExtensionRoot,
      authority,
      catalog,
      serviceContainer: createRuntimeServiceContainer(),
      packageLoader,
      ui: { delivery },
      ...(firstPartyExtensions ? { firstPartyExtensions } : {}),
    });
    api = new ProductionMarshalRuntimeApi(host);
  }

  beforeEach(async () => {
    root = await mkdtemp(
      path.join(await realpath(tmpdir()), "marshal-runtime-extensions-test-"),
    );
    trustedExtensionRoot = path.join(root, "extensions");
    deniedPermissions = new Set();
    authorizationRequests = [];
    bindingDisposalEvents = [];
    await Promise.all([
      mkdir(path.join(root, "workspace"), { recursive: true }),
      mkdir(path.join(root, "scope"), { recursive: true }),
      mkdir(path.join(root, "protected-results"), { recursive: true }),
      mkdir(path.join(root, "worktrees"), { recursive: true }),
      mkdir(trustedExtensionRoot, { recursive: true }),
    ]);

    authority = {
      async resolveScope(scope, signal) {
        if (
          signal?.aborted ||
          scope.sessionId !== SESSION_ID ||
          scope.workspaceName.toLowerCase() !== WORKSPACE_NAME
        ) {
          return null;
        }
        return {
          sessionId: SESSION_ID,
          workspaceName: WORKSPACE_NAME,
          workspacePath: path.join(root, "scope"),
        };
      },
      async authorize(request) {
        authorizationRequests.push(request);
        const denied = request.permissions.find((permission) => deniedPermissions.has(permission));
        return denied
          ? { decision: "deny", reason: `Denied ${denied}.`, code: "permission_denied" }
          : { decision: "allow" };
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
      createRuntimeBuiltinsSource: () => () => ({
        providers: [],
        dispose: async () => {
          bindingDisposalEvents.push("bindings-dispose");
        },
      }),
    };
    packageLoader = {
      load: async () => runtimeModule,
      metadata: () => packageMetadata,
    };
    delivery = {
      notification: vi.fn<RuntimeUiDeliveryPorts["notification"]>(),
      chatMessage: vi.fn<RuntimeUiDeliveryPorts["chatMessage"]>(),
      chatCard: vi.fn<RuntimeUiDeliveryPorts["chatCard"]>(),
    };
    createHost();
    await host.start();
  });

  afterEach(async () => {
    api.dispose();
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  });

  async function materialize(
    directory: string,
    options: ExtensionSourceOptions,
    manifestOverrides: Readonly<Record<string, unknown>> = {},
  ): Promise<MaterializedExtension> {
    const packageRoot = path.join(trustedExtensionRoot, directory);
    await mkdir(packageRoot, { recursive: true });
    const identity = options.identity ?? EXTENSION_IDENTITY;
    const manifest = {
      schemaVersion: 1,
      identity,
      version: options.version,
      entrypoint: "index.cjs",
      moduleFormat: "commonjs-bundle-v1",
      ...manifestOverrides,
    };
    await Promise.all([
      writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: identity,
          version: options.version,
          type: "commonjs",
          main: "index.cjs",
        }),
      ),
      writeFile(path.join(packageRoot, "runtime-extension.json"), JSON.stringify(manifest)),
      writeFile(path.join(packageRoot, "index.cjs"), extensionSource(options)),
    ]);
    return {
      packageRoot,
      integrity: computeRuntimeExtensionIntegrity(packageRoot),
    };
  }

  function installRequest(extension: MaterializedExtension, idempotencyKey: string) {
    return {
      sessionId: SESSION_ID,
      workspaceName: WORKSPACE_NAME,
      packageRoot: extension.packageRoot,
      integrity: extension.integrity,
      idempotencyKey,
    };
  }

  async function searchCapability() {
    return api.search({
      sessionId: SESSION_ID,
      workspaceName: WORKSPACE_NAME,
      name: CAPABILITY_NAME,
      detail: "full",
    });
  }

  async function invokeCapability(idempotencyKey: string) {
    return api.invoke({
      sessionId: SESSION_ID,
      workspaceName: WORKSPACE_NAME,
      capability: CAPABILITY_NAME,
      input: { value: idempotencyKey },
      idempotencyKey,
    });
  }

  it("installs live without restarting the kernel and supports immediate search and invoke", async () => {
    const lifecycleBefore = host.getStatus();
    const extension = await materialize("live-v1", { version: "1.0.0" });

    const installed = await api.installExtension(installRequest(extension, "live-install"));

    if (!installed.ok) throw new Error(`${installed.error.code}: ${installed.error.message}`);
    expect(installed).toMatchObject({
      ok: true,
      value: { identity: EXTENSION_IDENTITY, version: "1.0.0", status: "enabled" },
      receipts: [],
    });
    expect(host.getStatus()).toEqual(lifecycleBefore);
    await expect(searchCapability()).resolves.toMatchObject({
      ok: true,
      value: { matches: [{ capability: { name: CAPABILITY_NAME, version: "1.0.0" } }] },
    });
    await expect(invokeCapability("live-invoke")).resolves.toMatchObject({
      ok: true,
      value: { output: { version: "1.0.0", input: { value: "live-invoke" } } },
      receipts: [{ status: "success" }],
    });
  });

  it("lists all four first-party extensions and persists disabling them across restart", async () => {
    api.dispose();
    await host.dispose();

    const definitions = [
      ["@agentic-browser/marshal-runtime-extension", "0.1.0"],
      ["@marshal/agentic-debugger-extension", "1.0.0"],
      ["@marshal/swarm", "0.1.0"],
      ["@marshal/overlay-review", "0.1.0"],
    ] as const;
    const materialized = await Promise.all(
      definitions.map(async ([identity, version], index) => ({
        identity,
        version,
        extension: await materialize(`first-party-${index}`, {
          identity,
          version,
          capabilityProvider: false,
        }),
      })),
    );
    const debuggerRoot = materialized.find(
      ({ identity }) => identity === "@marshal/agentic-debugger-extension",
    )!.extension.packageRoot;
    await mkdir(path.join(debuggerRoot, "dist", "runtime"), { recursive: true });
    await writeFile(
      path.join(debuggerRoot, "dist", "runtime", "native-host.mjs"),
      "export class NativeDebuggerHostAdapter { async invoke(input) { return input; } }\n",
    );
    const firstPartyExtensions: readonly ResolvedFirstPartyExtension[] = materialized.map(
      ({ identity, version, extension }) => ({
        identity,
        version,
        request: {
          packageRoot: extension.packageRoot,
          integrity: computeRuntimeExtensionIntegrity(extension.packageRoot),
        },
        ...(identity === "@marshal/swarm"
          ? { configuration: { runsDirectory: path.join(root, "swarm-runs") } }
          : {}),
        ...(identity === "@marshal/agentic-debugger-extension"
          ? { hostComposition: "agentic-debugger-host-adapter" as const }
          : {}),
      }),
    );

    createHost(firstPartyExtensions);
    await host.start();
    const listed = await api.listExtensions({
      sessionId: SESSION_ID,
      workspaceName: WORKSPACE_NAME,
    });
    expect(listed).toMatchObject({ ok: true });
    if (!listed.ok) throw new Error(listed.error.message);
    expect(listed.value.map(({ identity, status }) => ({ identity, status }))).toEqual(
      definitions
        .map(([identity]) => ({ identity, status: "enabled" }))
        .sort((left, right) => left.identity.localeCompare(right.identity)),
    );

    const disabled = await Promise.all(
      definitions.map(([identity]) =>
        api.disableExtension({
          sessionId: SESSION_ID,
          workspaceName: WORKSPACE_NAME,
          identity,
          idempotencyKey: `disable:${identity}`,
        }),
      ),
    );
    for (const [index, result] of disabled.entries()) {
      expect(result).toMatchObject({
        ok: true,
        value: { identity: definitions[index]?.[0], status: "disabled" },
      });
    }
    api.dispose();
    await host.dispose();

    createHost(firstPartyExtensions);
    await host.start();
    const restored = await api.listExtensions({
      sessionId: SESSION_ID,
      workspaceName: WORKSPACE_NAME,
    });
    expect(restored).toMatchObject({ ok: true });
    if (!restored.ok) throw new Error(restored.error.message);
    expect(restored.value.map(({ identity, status }) => ({ identity, status }))).toEqual(
      definitions
        .map(([identity]) => ({ identity, status: "disabled" }))
        .sort((left, right) => left.identity.localeCompare(right.identity)),
    );
  });

  it("keeps the old extension active when an update fails during activation", async () => {
    const versionOne = await materialize("update-v1", { version: "1.0.0" });
    const brokenVersion = await materialize("update-v2-broken", {
      version: "2.0.0",
      activationFailure: true,
    });
    await api.installExtension(installRequest(versionOne, "update-install"));

    const update = await api.updateExtension({
      ...installRequest(brokenVersion, "update-broken"),
      identity: EXTENSION_IDENTITY,
    });

    expect(update).toMatchObject({
      ok: false,
      error: { code: "operation-failed" },
      receipts: [],
    });
    await expect(searchCapability()).resolves.toMatchObject({
      ok: true,
      value: { matches: [{ capability: { version: "1.0.0" } }] },
    });
    await expect(invokeCapability("update-old-still-active")).resolves.toMatchObject({
      ok: true,
      value: { output: { version: "1.0.0" } },
    });
    await expect(
      api.listExtensions({ sessionId: SESSION_ID, workspaceName: WORKSPACE_NAME }),
    ).resolves.toMatchObject({
      ok: true,
      value: [{ identity: EXTENSION_IDENTITY, version: "1.0.0", status: "enabled" }],
    });
  });

  it("removes registrations on disable and remove, and restores only one registration on enable", async () => {
    const extension = await materialize("state-v1", { version: "1.0.0" });
    await api.installExtension(installRequest(extension, "state-install"));

    await expect(
      api.disableExtension({
        sessionId: SESSION_ID,
        workspaceName: WORKSPACE_NAME,
        identity: EXTENSION_IDENTITY,
        idempotencyKey: "state-disable",
      }),
    ).resolves.toMatchObject({ ok: true, value: { status: "disabled" } });
    await expect(searchCapability()).resolves.toMatchObject({
      ok: true,
      value: { matches: [] },
    });

    await expect(
      api.enableExtension({
        sessionId: SESSION_ID,
        workspaceName: WORKSPACE_NAME,
        identity: EXTENSION_IDENTITY,
        idempotencyKey: "state-enable",
      }),
    ).resolves.toMatchObject({ ok: true, value: { status: "enabled" } });
    const enabledSearch = await searchCapability();
    expect(enabledSearch).toMatchObject({ ok: true });
    if (!enabledSearch.ok) throw new Error(enabledSearch.error.message);
    expect(enabledSearch.value.matches).toHaveLength(1);

    await expect(
      api.removeExtension({
        sessionId: SESSION_ID,
        workspaceName: WORKSPACE_NAME,
        identity: EXTENSION_IDENTITY,
        idempotencyKey: "state-remove",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { identity: EXTENSION_IDENTITY, removed: true },
    });
    await expect(searchCapability()).resolves.toMatchObject({
      ok: true,
      value: { matches: [] },
    });
    await expect(invokeCapability("state-removed-invoke")).resolves.toMatchObject({
      ok: false,
      error: { code: "not-found" },
      receipts: [{ status: "not_found" }],
    });
  });

  it("tracks live UI applications and clears stale instances on disable and remove", async () => {
    const applicationId = "live-application";
    const extension = await materialize("ui-state-v1", {
      version: "1.0.0",
      uiApplicationId: applicationId,
    });
    await api.installExtension(installRequest(extension, "ui-install"));

    const open = (idempotencyKey: string) =>
      api.invoke({
        sessionId: SESSION_ID,
        workspaceName: WORKSPACE_NAME,
        capability: "ui.application.open",
        input: {
          extensionId: EXTENSION_IDENTITY,
          applicationId,
          surface: "panel",
          state: { idempotencyKey },
          idempotencyKey,
        },
        idempotencyKey: `invoke-${idempotencyKey}`,
      });
    await expect(open("ui-open-one")).resolves.toMatchObject({
      ok: true,
      value: { output: { ok: true, value: { instance: { surface: "panel" } } } },
    });
    await expect(
      host.ui!.snapshot({ sessionId: SESSION_ID, workspaceName: WORKSPACE_NAME }),
    ).resolves.toMatchObject({ ok: true, value: { instances: [expect.any(Object)] } });

    await api.disableExtension({
      sessionId: SESSION_ID,
      workspaceName: WORKSPACE_NAME,
      identity: EXTENSION_IDENTITY,
      idempotencyKey: "ui-disable",
    });
    await expect(
      host.ui!.snapshot({ sessionId: SESSION_ID, workspaceName: WORKSPACE_NAME }),
    ).resolves.toMatchObject({ ok: true, value: { instances: [] } });

    await api.enableExtension({
      sessionId: SESSION_ID,
      workspaceName: WORKSPACE_NAME,
      identity: EXTENSION_IDENTITY,
      idempotencyKey: "ui-enable",
    });
    await expect(open("ui-open-two")).resolves.toMatchObject({
      ok: true,
      value: { output: { ok: true } },
    });
    await api.removeExtension({
      sessionId: SESSION_ID,
      workspaceName: WORKSPACE_NAME,
      identity: EXTENSION_IDENTITY,
      idempotencyKey: "ui-remove",
    });
    await expect(
      host.ui!.snapshot({ sessionId: SESSION_ID, workspaceName: WORKSPACE_NAME }),
    ).resolves.toMatchObject({ ok: true, value: { instances: [] } });
  });

  it("rejects path escape, symlink escape, integrity mismatch, and invalid manifests", async () => {
    const escapedRoot = path.join(root, "outside-extension");
    const escaped = await materialize("temporary-inside", { version: "1.0.0" });
    await mkdir(escapedRoot, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(escapedRoot, "package.json"),
        JSON.stringify({
          name: EXTENSION_IDENTITY,
          version: "1.0.0",
          type: "commonjs",
          main: "index.cjs",
        }),
      ),
      writeFile(
        path.join(escapedRoot, "runtime-extension.json"),
        JSON.stringify({
          schemaVersion: 1,
          identity: EXTENSION_IDENTITY,
          version: "1.0.0",
          entrypoint: "index.cjs",
          moduleFormat: "commonjs-bundle-v1",
        }),
      ),
      writeFile(path.join(escapedRoot, "index.cjs"), extensionSource({ version: "1.0.0" })),
    ]);
    const escapedIntegrity = computeRuntimeExtensionIntegrity(escapedRoot);
    const symlinkRoot = path.join(trustedExtensionRoot, "symlink-escape");
    await symlink(escapedRoot, symlinkRoot, process.platform === "win32" ? "junction" : "dir");
    const invalidManifest = await materialize(
      "invalid-manifest",
      { version: "1.0.0" },
      { schemaVersion: 2 },
    );

    const cases = [
      {
        name: "path escape",
        request: {
          ...installRequest(escaped, "unused"),
          packageRoot: escapedRoot,
          integrity: escapedIntegrity,
          idempotencyKey: "reject-path-escape",
        },
      },
      {
        name: "symlink escape",
        request: {
          ...installRequest(escaped, "unused"),
          packageRoot: symlinkRoot,
          integrity: escapedIntegrity,
          idempotencyKey: "reject-symlink-escape",
        },
      },
      {
        name: "integrity mismatch",
        request: {
          ...installRequest(escaped, "reject-integrity"),
          integrity: { ...escaped.integrity, value: "0".repeat(64) },
        },
      },
      {
        name: "invalid manifest",
        request: installRequest(invalidManifest, "reject-manifest"),
      },
    ] as const;

    const results = await Promise.all(
      cases.map(async (testCase) => ({
        name: testCase.name,
        result: await api.installExtension(testCase.request),
      })),
    );
    for (const { name, result } of results) {
      expect(result, name).toMatchObject({
        ok: false,
        error: { code: "invalid-request" },
        receipts: [],
      });
    }
    await expect(
      api.listExtensions({ sessionId: SESSION_ID, workspaceName: WORKSPACE_NAME }),
    ).resolves.toMatchObject({ ok: true, value: [] });
  });

  it("enforces authority and scope and preserves extension idempotency", async () => {
    const extension = await materialize("authority-v1", {
      version: "1.0.0",
      activationDelayMs: 25,
    });
    deniedPermissions.add(MARSHAL_RUNTIME_PERMISSION.extensionInstall);
    await expect(
      api.installExtension(installRequest(extension, "authority-denied")),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "permission-denied" },
    });
    deniedPermissions.clear();

    await expect(
      api.installExtension({
        ...installRequest(extension, "scope-denied"),
        workspaceName: "other-workspace",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "permission-denied" },
    });

    const authorizationCountBeforeDeduplication = authorizationRequests.length;
    const request = installRequest(extension, "deduplicated-install");
    const first = api.installExtension(request);
    const second = api.installExtension(request);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toEqual(firstResult);
    expect(firstResult).toMatchObject({ ok: true, value: { status: "enabled" } });
    expect(
      authorizationRequests
        .slice(authorizationCountBeforeDeduplication)
        .filter(
          (installAuthorization) =>
            installAuthorization.permissions[0] === MARSHAL_RUNTIME_PERMISSION.extensionInstall,
        ),
    ).toHaveLength(1);

    const conflicting = await materialize("authority-v2", { version: "2.0.0" });
    await expect(
      api.installExtension(installRequest(conflicting, "deduplicated-install")),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "idempotency-conflict" },
    });
  });

  it("cancels activation without installing and cancels queued state changes before mutation", async () => {
    const eventKey = `__marshalRuntimeExtensionEvents_${Date.now()}_${Math.random()}`;
    const events: string[] = [];
    Reflect.set(globalThis, eventKey, events);
    try {
      const cancellable = await materialize("cancel-install", {
        version: "1.0.0",
        waitForCancellation: true,
        eventKey,
      });
      const controller = new AbortController();
      const installing = api.installExtension({
        ...installRequest(cancellable, "cancel-install"),
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(events).toContain("activation-started"));
      controller.abort();
      await expect(installing).resolves.toMatchObject({
        ok: false,
        error: { code: "aborted" },
      });
      await expect(
        api.listExtensions({ sessionId: SESSION_ID, workspaceName: WORKSPACE_NAME }),
      ).resolves.toMatchObject({ ok: true, value: [] });

      const extension = await materialize("cancel-state", {
        version: "1.0.0",
        activationDelayMs: 500,
      });
      const installingState = api.installExtension(
        installRequest(extension, "cancel-state-install"),
      );
      const stateController = new AbortController();
      const disabling = api.disableExtension({
        sessionId: SESSION_ID,
        workspaceName: WORKSPACE_NAME,
        identity: EXTENSION_IDENTITY,
        idempotencyKey: "cancel-state-disable",
        signal: stateController.signal,
      });
      await vi.waitFor(() =>
        expect(
          authorizationRequests.some(
            (request) => request.permissions[0] === MARSHAL_RUNTIME_PERMISSION.extensionDisable,
          ),
        ).toBe(true),
      );
      stateController.abort();
      await expect(disabling).resolves.toMatchObject({
        ok: false,
        error: { code: "aborted" },
      });
      await expect(installingState).resolves.toMatchObject({
        ok: true,
        value: { status: "enabled" },
      });
      await expect(searchCapability()).resolves.toMatchObject({
        ok: true,
        value: { matches: [{ capability: { name: CAPABILITY_NAME } }] },
      });
    } finally {
      Reflect.deleteProperty(globalThis, eventKey);
    }
  });

  it("lists status and disposes extensions before runtime bindings", async () => {
    const eventKey = `__marshalRuntimeExtensionEvents_${Date.now()}_${Math.random()}`;
    const events: string[] = [];
    Reflect.set(globalThis, eventKey, events);
    bindingDisposalEvents = events;
    try {
      const extension = await materialize("dispose-v1", {
        version: "1.0.0",
        eventKey,
        uiApplicationId: "dispose-application",
      });
      await api.installExtension(installRequest(extension, "dispose-install"));
      const uiEvents: string[] = [];
      host.ui!.subscribe((event) => uiEvents.push(event.type));
      await api.invoke({
        sessionId: SESSION_ID,
        workspaceName: WORKSPACE_NAME,
        capability: "ui.application.open",
        input: {
          extensionId: EXTENSION_IDENTITY,
          applicationId: "dispose-application",
          surface: "panel",
          idempotencyKey: "dispose-ui-open",
        },
        idempotencyKey: "dispose-ui-invoke",
      });

      await expect(
        api.listExtensions({ sessionId: SESSION_ID, workspaceName: WORKSPACE_NAME }),
      ).resolves.toMatchObject({
        ok: true,
        value: [{ identity: EXTENSION_IDENTITY, version: "1.0.0", status: "enabled" }],
      });
      expect(api.getStatus().lifecycle).toBe("running");

      await host.dispose();

      expect(api.getStatus().lifecycle).toBe("disposed");
      expect(events).toEqual(["activation-started", "extension-dispose", "bindings-dispose"]);
      expect(uiEvents).toContain("instance-closed");
      expect(uiEvents).toContain("owner-invalidated");
      await expect(searchCapability()).resolves.toMatchObject({
        ok: false,
        error: { code: "runtime-unavailable" },
      });
    } finally {
      Reflect.deleteProperty(globalThis, eventKey);
    }
  });
});
