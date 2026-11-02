/**
 * F-DEPLOY-4 kernel-integration regression (R5 / D2 agent path).
 *
 * Reproduces the live defect at its actual layer: a real, installed extension
 * declares a permission on its own capability; the REAL production authority
 * (createProductionMarshalRuntimePorts) and a REAL MarshalRuntimeHost/kernel
 * are driven through ProductionMarshalRuntimeApi.invoke() — the same agent
 * invoke path runtimeInvoke uses live. Unlike production-adapter.test.ts's
 * existing coverage (which injects a hand-written resolveExtensionDeclaredPermission
 * mock and so never exercises MarshalRuntimeHost.search() at all), this test
 * wires the resolver hook exactly as electron/main.ts does — a mutable
 * forward reference assigned to a live MarshalRuntimeHost-backed resolver —
 * so a defect inside that resolver's own search-context construction is
 * actually reachable.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createAgentRuntime,
  createRuntimeServiceContainer,
  RUNTIME_PROTOCOL_VERSION,
} from "@marshal/runtime";
import {
  createRuntimeDelegationProvider,
  type DelegationManager,
} from "@marshal/runtime/delegation";
import { computeRuntimeExtensionIntegrity } from "@marshal/runtime/extensions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PermissionPolicy } from "../permission-policy";
import type { PersistedSession } from "../session-store";
import type { SessionManager } from "../sessions";
import { testDouble } from "../testing/harness";
import { ProductionMarshalRuntimeApi } from "./api";
import type { MarshalRuntimeModule, MarshalRuntimePackageMetadata } from "./contracts";
import { MarshalRuntimeHost } from "./host";
import {
  createExtensionDeclaredPermissionResolver,
  createProductionMarshalRuntimePorts,
  type ExtensionDeclaredPermissionResolver,
} from "./production-adapter";
import type { MarshalRuntimePackageLoader } from "./runtime-package-loader";
import type { RuntimeUiDeliveryPorts } from "./ui-controller";

const SESSION_ID = "session-1";
const WORKSPACE_NAME = "workspace";
const EXTENSION_IDENTITY = "@fixture/declared-permission-extension";
const CAPABILITY_NAME = "fixture.codereview.accounts.list";
const DECLARED_PERMISSION = "fixture.codereview.read";

const packageMetadata: MarshalRuntimePackageMetadata = {
  name: "@marshal/runtime",
  version: "0.1.0-test",
  entrypoint: "dist/host.js",
  entrySha256: "0".repeat(64),
};

function extensionSource(): string {
  return `
    const descriptor = Object.freeze({
      protocolVersion: ${JSON.stringify(RUNTIME_PROTOCOL_VERSION)},
      name: ${JSON.stringify(CAPABILITY_NAME)},
      version: "1.0.0",
      title: "Fixture code review accounts",
      description: "Lists fixture code review accounts.",
      inputSchema: { type: "object", additionalProperties: true },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["accounts"],
        properties: { accounts: { type: "array" } }
      },
      permissions: [{ permission: ${JSON.stringify(DECLARED_PERMISSION)} }]
    });
    module.exports = {
      async activate() {
        return {
          capabilityProviders: [{
            id: "fixture.declared-permission",
            version: "1.0.0",
            list() { return [descriptor]; },
            get(name) { return name === descriptor.name ? descriptor : undefined; },
            invoke(name) {
              if (name !== descriptor.name) throw Object.assign(new Error("not found"), { code: "not_found" });
              return { output: { accounts: [] } };
            }
          }],
          dispose() {}
        };
      }
    };
  `;
}

describe("F-DEPLOY-4: extension-declared permission on the live agent invoke path", () => {
  let root: string;
  let trustedExtensionRoot: string;
  let host: MarshalRuntimeHost;
  let api: ProductionMarshalRuntimeApi;
  let evaluateDetailedCalls: unknown[];
  let resolveExtensionDeclaredPermissionHook: ExtensionDeclaredPermissionResolver;

  beforeEach(async () => {
    root = await mkdtemp(
      path.join(await realpath(tmpdir()), "marshal-runtime-declared-permission-test-"),
    );
    trustedExtensionRoot = path.join(root, "extensions");
    evaluateDetailedCalls = [];
    resolveExtensionDeclaredPermissionHook = () => false;
    await Promise.all([
      mkdir(path.join(root, "workspace"), { recursive: true }),
      mkdir(path.join(root, "scope"), { recursive: true }),
      mkdir(path.join(root, "protected-results"), { recursive: true }),
      mkdir(path.join(root, "worktrees"), { recursive: true }),
      mkdir(trustedExtensionRoot, { recursive: true }),
    ]);

    // A REAL production authority — the same factory electron/main.ts uses —
    // with a forward-referenced resolver hook, exactly mirroring main.ts's
    // `let resolveExtensionDeclaredPermissionHook = () => false;` pattern.
    // Fixture stands in for SessionManager: only the two methods the
    // authority actually calls.
    const sessionManager = testDouble<SessionManager>({
      getSessionScopeAsync: async () =>
        testDouble<PersistedSession>({
          id: SESSION_ID,
          name: "Fixture session",
          workspaceName: WORKSPACE_NAME,
          messages: [],
        }),
      listWorkspacesForSelfTools: () => [{ name: WORKSPACE_NAME, path: path.join(root, "scope") }],
    });
    const permissionPolicy = testDouble<PermissionPolicy>({
      evaluateDetailed: (request: Parameters<PermissionPolicy["evaluateDetailed"]>[0]) => {
        evaluateDetailedCalls.push(request);
        return testDouble({ decision: "approve" });
      },
    });
    const ports = createProductionMarshalRuntimePorts({
      sessionManager,
      permissionPolicy,
      workspaceDir: path.join(root, "default-workspace"),
      resolveExtensionDeclaredPermission: (permission, capability, scope) =>
        resolveExtensionDeclaredPermissionHook(permission, capability, scope),
    });
    const catalog = {
      listTools: () => [],
      listSkills: () => [],
      getSkill: () => null,
      listWorkspaces: () => [],
      getSessionContext: async () => null,
    };
    const runtimeModule: MarshalRuntimeModule = {
      createAgentRuntime,
      createRuntimeBuiltinsSource: () => () => ({ providers: [], dispose: async () => {} }),
    };
    const packageLoader: MarshalRuntimePackageLoader = {
      load: async () => runtimeModule,
      metadata: () => packageMetadata,
    };
    const delivery: RuntimeUiDeliveryPorts = {
      notification: async () => undefined,
      chatMessage: async () => undefined,
      chatCard: async () => undefined,
    };

    host = new MarshalRuntimeHost({
      location: { isPackaged: false, appPath: root, resourcesPath: root },
      hostWorkspacePath: path.join(root, "workspace"),
      protectedLifecycleResultRoot: path.join(root, "protected-results"),
      worktreeRoot: path.join(root, "worktrees"),
      trustedExtensionRoot,
      authority: ports.authority,
      catalog,
      serviceContainer: createRuntimeServiceContainer(),
      packageLoader,
      ui: { delivery },
    });
    api = new ProductionMarshalRuntimeApi(host);
    await host.start();

    const packageRoot = path.join(trustedExtensionRoot, "declared-permission-v1");
    await mkdir(packageRoot, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: EXTENSION_IDENTITY,
          version: "1.0.0",
          type: "commonjs",
          main: "index.cjs",
        }),
      ),
      writeFile(
        path.join(packageRoot, "runtime-extension.json"),
        JSON.stringify({
          schemaVersion: 1,
          identity: EXTENSION_IDENTITY,
          version: "1.0.0",
          entrypoint: "index.cjs",
          moduleFormat: "commonjs-bundle-v1",
        }),
      ),
      writeFile(path.join(packageRoot, "index.cjs"), extensionSource()),
    ]);
    const installed = await api.installExtension({
      sessionId: SESSION_ID,
      workspaceName: WORKSPACE_NAME,
      packageRoot,
      integrity: computeRuntimeExtensionIntegrity(packageRoot),
      idempotencyKey: "install-declared-permission-extension",
    });
    if (!installed.ok) throw new Error(`${installed.error.code}: ${installed.error.message}`);
  });

  afterEach(async () => {
    api.dispose();
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  });

  function invokeCapability(idempotencyKey: string) {
    return api.invoke({
      sessionId: SESSION_ID,
      workspaceName: WORKSPACE_NAME,
      capability: CAPABILITY_NAME,
      input: {},
      idempotencyKey,
    });
  }

  it("[RED] pre-repair resolver context shape denies a permission the installed extension DOES declare (F-DEPLOY-4 reproduction)", async () => {
    // Frozen copy of the pre-repair main.ts hook (electron/main.ts @
    // d421db1ad, lines ~2075-2104): the search context carries workspacePath
    // at the top level but never sets metadata[marshalWorkspaceName]. The
    // kernel's own resolveWorkspace callback (host.ts's
    // resolveRuntimeWorkspace) requires that metadata key and throws
    // "invalid_scope" without it — a throw this hook's own try/catch
    // silently swallows into a plain `false`, exactly reproducing the live
    // "Marshal Runtime permission is not supported" fall-through deny for a
    // permission the extension's live capability descriptor does declare.
    resolveExtensionDeclaredPermissionHook = async (permission, capability, scope) => {
      try {
        const response = await host.search(
          { protocolVersion: RUNTIME_PROTOCOL_VERSION, name: capability },
          { sessionId: scope.sessionId, workspacePath: scope.workspacePath },
        );
        const match = response.matches.find(
          (candidate) =>
            candidate.capability.name === capability &&
            candidate.capability.permissions?.some(
              (requirement) => requirement.permission === permission,
            ),
        );
        if (!match) return false;
        const extensionId = await host.resolveExtensionOwningProvider(match.capability.provider.id);
        return extensionId ? { declared: true as const, extensionId } : false;
      } catch {
        return false;
      }
    };

    const result = await invokeCapability("red-repro");
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "permission-denied",
        message: `Marshal Runtime permission is not supported: ${DECLARED_PERMISSION}.`,
      },
    });
    // The failure never reaches policy — proving this is the resolver
    // chain failing closed, not a legitimate policy denial.
    expect(evaluateDetailedCalls).toHaveLength(0);
  });

  it("[GREEN] repaired resolver lets a declared permission reach policy on the agent invoke path (F-DEPLOY-4)", async () => {
    resolveExtensionDeclaredPermissionHook = createExtensionDeclaredPermissionResolver(host);

    const result = await invokeCapability("green-repair");
    expect(result).toMatchObject({ ok: true, value: { output: { accounts: [] } } });
    expect(evaluateDetailedCalls).toHaveLength(1);
    expect(evaluateDetailedCalls[0]).toMatchObject({
      toolName: `runtime-extension:${EXTENSION_IDENTITY}:${DECLARED_PERMISSION}`,
    });
  });
});

/**
 * F-DEPLOY-5 kernel-integration regression.
 *
 * The @marshal/swarm pack's capability descriptors legitimately declare the
 * BUILTIN permission ids "swarm.execute"/"swarm.read" verbatim
 * (permissions: [{ permission: readOnly ? "swarm.read" : "swarm.execute" }]).
 * Once the F-DEPLOY-4 resolver fix made the live resolver actually return
 * declared matches, authorize()'s builtin-branch F-R2 guard denied every
 * swarm.runs.* invoke with "Marshal Runtime permission is not supported:
 * swarm.execute." — blocking swarm run creation host-wide. The repair routes a
 * verified declared builtin id to the SAME identity-qualified policy bucket
 * the declared-permission branch uses, so the decision is the policy's — never
 * an unconditional builtin allow, never a hard deny of a declared id.
 *
 * Same live wiring as the F-DEPLOY-4 suite above: REAL kernel, REAL
 * production authority, REAL createExtensionDeclaredPermissionResolver, driven
 * through ProductionMarshalRuntimeApi.invoke().
 */
const SWARM_SESSION_ID = "session-swarm-1";
const SWARM_WORKSPACE_NAME = "swarm-workspace";
const SWARM_EXTENSION_IDENTITY = "@fixture/swarm-extension";
const SWARM_CAPABILITY_NAME = "swarm.runs.create";
const SWARM_BUILTIN_PERMISSION = "swarm.execute";

function swarmExtensionSource(): string {
  return `
    const descriptor = Object.freeze({
      protocolVersion: ${JSON.stringify(RUNTIME_PROTOCOL_VERSION)},
      name: ${JSON.stringify(SWARM_CAPABILITY_NAME)},
      version: "0.1.0",
      title: "Fixture swarm run creation",
      description: "Creates a fixture swarm run.",
      tags: ["swarm", "recursive"],
      inputSchema: { type: "object", additionalProperties: true },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["runId"],
        properties: { runId: { type: "string" } }
      },
      permissions: [{ permission: ${JSON.stringify(SWARM_BUILTIN_PERMISSION)}, risk: "high" }]
    });
    module.exports = {
      async activate() {
        return {
          capabilityProviders: [{
            id: "fixture.swarm",
            version: "0.1.0",
            list() { return [descriptor]; },
            get(name) { return name === descriptor.name ? descriptor : undefined; },
            invoke(name) {
              if (name !== descriptor.name) throw Object.assign(new Error("not found"), { code: "not_found" });
              return { output: { runId: "run-fixture-1" } };
            }
          }],
          dispose() {}
        };
      }
    };
  `;
}

describe("F-DEPLOY-5: descriptor-declared BUILTIN permission id on the live agent invoke path", () => {
  let root: string;
  let trustedExtensionRoot: string;
  let host: MarshalRuntimeHost;
  let api: ProductionMarshalRuntimeApi;
  let evaluateDetailedCalls: Array<Parameters<PermissionPolicy["evaluateDetailed"]>[0]>;
  let policyResponse: () => { decision: "approve" | "prompt" | "deny"; denyReason?: string };
  let resolveExtensionDeclaredPermissionHook: ExtensionDeclaredPermissionResolver;

  beforeEach(async () => {
    root = await mkdtemp(path.join(await realpath(tmpdir()), "marshal-runtime-fdeploy5-test-"));
    trustedExtensionRoot = path.join(root, "extensions");
    evaluateDetailedCalls = [];
    policyResponse = () => ({ decision: "approve" });
    resolveExtensionDeclaredPermissionHook = () => false;
    await Promise.all([
      mkdir(path.join(root, "workspace"), { recursive: true }),
      mkdir(path.join(root, "scope"), { recursive: true }),
      mkdir(path.join(root, "protected-results"), { recursive: true }),
      mkdir(path.join(root, "worktrees"), { recursive: true }),
      mkdir(trustedExtensionRoot, { recursive: true }),
    ]);

    const sessionManager = testDouble<SessionManager>({
      getSessionScopeAsync: async () =>
        testDouble<PersistedSession>({
          id: SWARM_SESSION_ID,
          name: "Fixture swarm session",
          workspaceName: SWARM_WORKSPACE_NAME,
          messages: [],
        }),
      listWorkspacesForSelfTools: () => [
        { name: SWARM_WORKSPACE_NAME, path: path.join(root, "scope") },
      ],
    });
    const permissionPolicy = testDouble<PermissionPolicy>({
      evaluateDetailed: (request: Parameters<PermissionPolicy["evaluateDetailed"]>[0]) => {
        evaluateDetailedCalls.push(request);
        return testDouble(policyResponse());
      },
    });
    const ports = createProductionMarshalRuntimePorts({
      sessionManager,
      permissionPolicy,
      workspaceDir: path.join(root, "default-workspace"),
      resolveExtensionDeclaredPermission: (permission, capability, scope) =>
        resolveExtensionDeclaredPermissionHook(permission, capability, scope),
    });
    const catalog = {
      listTools: () => [],
      listSkills: () => [],
      getSkill: () => null,
      listWorkspaces: () => [],
      getSessionContext: async () => null,
    };
    const runtimeModule: MarshalRuntimeModule = {
      createAgentRuntime,
      createRuntimeBuiltinsSource: () => () => ({ providers: [], dispose: async () => {} }),
    };
    const packageLoader: MarshalRuntimePackageLoader = {
      load: async () => runtimeModule,
      metadata: () => packageMetadata,
    };
    const delivery: RuntimeUiDeliveryPorts = {
      notification: async () => undefined,
      chatMessage: async () => undefined,
      chatCard: async () => undefined,
    };

    host = new MarshalRuntimeHost({
      location: { isPackaged: false, appPath: root, resourcesPath: root },
      hostWorkspacePath: path.join(root, "workspace"),
      protectedLifecycleResultRoot: path.join(root, "protected-results"),
      worktreeRoot: path.join(root, "worktrees"),
      trustedExtensionRoot,
      authority: ports.authority,
      catalog,
      serviceContainer: createRuntimeServiceContainer(),
      packageLoader,
      ui: { delivery },
    });
    api = new ProductionMarshalRuntimeApi(host);
    await host.start();

    const packageRoot = path.join(trustedExtensionRoot, "swarm-fixture-v1");
    await mkdir(packageRoot, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: SWARM_EXTENSION_IDENTITY,
          version: "1.0.0",
          type: "commonjs",
          main: "index.cjs",
        }),
      ),
      writeFile(
        path.join(packageRoot, "runtime-extension.json"),
        JSON.stringify({
          schemaVersion: 1,
          identity: SWARM_EXTENSION_IDENTITY,
          version: "1.0.0",
          entrypoint: "index.cjs",
          moduleFormat: "commonjs-bundle-v1",
        }),
      ),
      writeFile(path.join(packageRoot, "index.cjs"), swarmExtensionSource()),
    ]);
    const installed = await api.installExtension({
      sessionId: SWARM_SESSION_ID,
      workspaceName: SWARM_WORKSPACE_NAME,
      packageRoot,
      integrity: computeRuntimeExtensionIntegrity(packageRoot),
      idempotencyKey: "install-swarm-fixture-extension",
    });
    if (!installed.ok) throw new Error(`${installed.error.code}: ${installed.error.message}`);

    resolveExtensionDeclaredPermissionHook = createExtensionDeclaredPermissionResolver(host);
  });

  afterEach(async () => {
    api.dispose();
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  });

  function invokeSwarmCapability(idempotencyKey: string) {
    return api.invoke({
      sessionId: SWARM_SESSION_ID,
      workspaceName: SWARM_WORKSPACE_NAME,
      capability: SWARM_CAPABILITY_NAME,
      input: { objective: "fixture objective" },
      idempotencyKey,
    });
  }

  it("authorizes a declared builtin permission id through the declaring extension's identity-qualified policy bucket (F-DEPLOY-5)", async () => {
    // Pre-repair this denied with "Marshal Runtime permission is not
    // supported: swarm.execute." before policy was ever consulted.
    const result = await invokeSwarmCapability("fdeploy5-allow");
    expect(result).toMatchObject({ ok: true, value: { output: { runId: "run-fixture-1" } } });
    expect(evaluateDetailedCalls).toHaveLength(1);
    expect(evaluateDetailedCalls[0]).toMatchObject({
      toolName: `runtime-extension:${SWARM_EXTENSION_IDENTITY}:${SWARM_BUILTIN_PERMISSION}`,
    });
  });

  it("returns the policy deny for a declared builtin permission id instead of a blanket unsupported-permission deny (F-DEPLOY-5)", async () => {
    policyResponse = () => ({ decision: "deny", denyReason: "Denied by fixture policy." });

    const result = await invokeSwarmCapability("fdeploy5-deny");
    expect(result).toMatchObject({
      ok: false,
      error: { code: "permission-denied", message: "Denied by fixture policy." },
    });
    expect(evaluateDetailedCalls).toHaveLength(1);
    expect(evaluateDetailedCalls[0]).toMatchObject({
      toolName: `runtime-extension:${SWARM_EXTENSION_IDENTITY}:${SWARM_BUILTIN_PERMISSION}`,
    });
  });
});

/**
 * F-DEPLOY-5c kernel-integration regression (live at 05:01:53Z + 36 further
 * denials).
 *
 * F-DEPLOY-5b's blanket owner-null→indeterminate deny bricked every builtin
 * invoke whose capability descriptor is HOST-registered (not extension-owned):
 * the real `marshal.delegation` provider declares `runtime.delegation.spawn`
 * verbatim and the real `marshal.runtime-ui` provider declares
 * `marshal.ui.application.*` verbatim, the extension-owner lookup verifiably
 * returns null for both, and the builtin branch denied "ownership could not
 * be verified" — blocking swarm root dispatch and all runtime-ui application
 * flows. The repair adds affirmative host provenance
 * (MarshalRuntimeHost.isHostRegisteredCapabilityProvider, backed by the
 * bindings.providers bootstrap registry): owner-null WITH provenance is
 * verified not-extension-declared → builtin allow; owner-null WITHOUT
 * provenance still fails closed (the extension enable/disable race window).
 *
 * REAL kernel, REAL production authority, REAL resolver, REAL host-registered
 * delegation + runtime-ui providers, driven through
 * ProductionMarshalRuntimeApi.invoke() — same wiring as the suites above.
 */
const HOST_SESSION_ID = "session-hostowned-1";
const HOST_WORKSPACE_NAME = "hostowned-workspace";
const PROXY_EXTENSION_IDENTITY = "@fixture/delegation-proxy-extension";
const PROXY_CAPABILITY_NAME = "fixture.delegation.proxy";
const PROXY_PROVIDER_ID = "fixture.delegation-proxy";
const DELEGATION_BUILTIN_PERMISSION = "runtime.delegation.spawn";

function delegationProxyExtensionSource(): string {
  return `
    const descriptor = Object.freeze({
      protocolVersion: ${JSON.stringify(RUNTIME_PROTOCOL_VERSION)},
      name: ${JSON.stringify(PROXY_CAPABILITY_NAME)},
      version: "1.0.0",
      title: "Fixture delegation proxy",
      description: "Declares the builtin runtime.delegation.spawn id on its own capability.",
      inputSchema: { type: "object", additionalProperties: true },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["proxied"],
        properties: { proxied: { type: "boolean" } }
      },
      permissions: [{ permission: ${JSON.stringify(DELEGATION_BUILTIN_PERMISSION)}, risk: "high" }]
    });
    module.exports = {
      async activate() {
        return {
          capabilityProviders: [{
            id: ${JSON.stringify(PROXY_PROVIDER_ID)},
            version: "1.0.0",
            list() { return [descriptor]; },
            get(name) { return name === descriptor.name ? descriptor : undefined; },
            invoke(name) {
              if (name !== descriptor.name) throw Object.assign(new Error("not found"), { code: "not_found" });
              return { output: { proxied: true } };
            }
          }],
          dispose() {}
        };
      }
    };
  `;
}

describe("F-DEPLOY-5c: host-registered builtin capability descriptors on the live agent invoke path", () => {
  let root: string;
  let trustedExtensionRoot: string;
  let host: MarshalRuntimeHost;
  let api: ProductionMarshalRuntimeApi;
  let evaluateDetailedCalls: Array<Parameters<PermissionPolicy["evaluateDetailed"]>[0]>;
  let resolveExtensionDeclaredPermissionHook: ExtensionDeclaredPermissionResolver;
  let delegationSpawnCalls: number;

  beforeEach(async () => {
    root = await mkdtemp(path.join(await realpath(tmpdir()), "marshal-runtime-fdeploy5c-test-"));
    trustedExtensionRoot = path.join(root, "extensions");
    evaluateDetailedCalls = [];
    delegationSpawnCalls = 0;
    resolveExtensionDeclaredPermissionHook = () => false;
    await Promise.all([
      mkdir(path.join(root, "workspace"), { recursive: true }),
      mkdir(path.join(root, "scope"), { recursive: true }),
      mkdir(path.join(root, "protected-results"), { recursive: true }),
      mkdir(path.join(root, "worktrees"), { recursive: true }),
      mkdir(trustedExtensionRoot, { recursive: true }),
    ]);

    const sessionManager = testDouble<SessionManager>({
      getSessionScopeAsync: async () =>
        testDouble<PersistedSession>({
          id: HOST_SESSION_ID,
          name: "Fixture host-owned session",
          workspaceName: HOST_WORKSPACE_NAME,
          messages: [],
        }),
      listWorkspacesForSelfTools: () => [
        { name: HOST_WORKSPACE_NAME, path: path.join(root, "scope") },
      ],
    });
    const permissionPolicy = testDouble<PermissionPolicy>({
      evaluateDetailed: (request: Parameters<PermissionPolicy["evaluateDetailed"]>[0]) => {
        evaluateDetailedCalls.push(request);
        return testDouble({ decision: "approve" });
      },
    });
    const ports = createProductionMarshalRuntimePorts({
      sessionManager,
      permissionPolicy,
      workspaceDir: path.join(root, "default-workspace"),
      resolveExtensionDeclaredPermission: (permission, capability, scope) =>
        resolveExtensionDeclaredPermissionHook(permission, capability, scope),
    });
    const catalog = {
      listTools: () => [],
      listSkills: () => [],
      getSkill: () => null,
      listWorkspaces: () => [],
      getSessionContext: async () => null,
    };
    const runtimeModule: MarshalRuntimeModule = {
      createAgentRuntime,
      createRuntimeBuiltinsSource: () => () => ({ providers: [], dispose: async () => {} }),
    };
    const packageLoader: MarshalRuntimePackageLoader = {
      load: async () => runtimeModule,
      metadata: () => packageMetadata,
    };
    const delivery: RuntimeUiDeliveryPorts = {
      notification: async () => undefined,
      chatMessage: async () => undefined,
      chatCard: async () => undefined,
    };
    // The REAL delegation capability provider ("marshal.delegation" —
    // descriptors declare runtime.delegation.* verbatim), registered exactly
    // as electron/main.ts registers it live: through additionalProviderSources
    // at host bootstrap, which is what lands it in bindings.providers.
    const delegationProvider = createRuntimeDelegationProvider({
      manager: testDouble<DelegationManager>({
        spawn: async () => {
          delegationSpawnCalls += 1;
          return { delegationId: "delegation-fixture-1", state: "pending" as const };
        },
      }),
    });

    host = new MarshalRuntimeHost({
      location: { isPackaged: false, appPath: root, resourcesPath: root },
      hostWorkspacePath: path.join(root, "workspace"),
      protectedLifecycleResultRoot: path.join(root, "protected-results"),
      worktreeRoot: path.join(root, "worktrees"),
      trustedExtensionRoot,
      additionalProviderSources: [() => delegationProvider],
      authority: ports.authority,
      catalog,
      serviceContainer: createRuntimeServiceContainer(),
      packageLoader,
      ui: { delivery },
    });
    api = new ProductionMarshalRuntimeApi(host);
    await host.start();

    resolveExtensionDeclaredPermissionHook = createExtensionDeclaredPermissionResolver(host);
  });

  afterEach(async () => {
    api.dispose();
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  });

  async function installDelegationProxyExtension() {
    const packageRoot = path.join(trustedExtensionRoot, "delegation-proxy-v1");
    await mkdir(packageRoot, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: PROXY_EXTENSION_IDENTITY,
          version: "1.0.0",
          type: "commonjs",
          main: "index.cjs",
        }),
      ),
      writeFile(
        path.join(packageRoot, "runtime-extension.json"),
        JSON.stringify({
          schemaVersion: 1,
          identity: PROXY_EXTENSION_IDENTITY,
          version: "1.0.0",
          entrypoint: "index.cjs",
          moduleFormat: "commonjs-bundle-v1",
        }),
      ),
      writeFile(path.join(packageRoot, "index.cjs"), delegationProxyExtensionSource()),
    ]);
    const installed = await api.installExtension({
      sessionId: HOST_SESSION_ID,
      workspaceName: HOST_WORKSPACE_NAME,
      packageRoot,
      integrity: computeRuntimeExtensionIntegrity(packageRoot),
      idempotencyKey: "install-delegation-proxy-extension",
    });
    if (!installed.ok) throw new Error(`${installed.error.code}: ${installed.error.message}`);
  }

  it("authorizes the REAL host-registered runtime.delegation.spawn with the builtin allow and zero policy calls (F-DEPLOY-5c r1)", async () => {
    // Pre-repair (F-DEPLOY-5b at 09d7e72b7) this denied with "Marshal Runtime
    // permission ownership could not be verified: runtime.delegation.spawn."
    // — the live swarm root-dispatch failure blocking wave2f.
    const result = await api.invoke({
      sessionId: HOST_SESSION_ID,
      workspaceName: HOST_WORKSPACE_NAME,
      capability: "runtime.delegation.spawn",
      input: { prompt: "fixture objective" },
      idempotencyKey: "fdeploy5c-spawn",
    });
    expect(result).toMatchObject({
      ok: true,
      value: { output: { delegationId: "delegation-fixture-1", state: "pending" } },
    });
    expect(delegationSpawnCalls).toBe(1);
    expect(evaluateDetailedCalls).toHaveLength(0);
  });

  it("authorizes the REAL host-registered ui.application.list with the builtin allow and zero policy calls (F-DEPLOY-5c r2)", async () => {
    // Pre-repair this denied with "Marshal Runtime permission ownership could
    // not be verified: marshal.ui.application.list." — 36 live denials on
    // runtime-ui application flows.
    const result = await api.invoke({
      sessionId: HOST_SESSION_ID,
      workspaceName: HOST_WORKSPACE_NAME,
      capability: "ui.application.list",
      input: {},
      idempotencyKey: "fdeploy5c-ui-list",
    });
    expect(result).toMatchObject({ ok: true });
    expect(evaluateDetailedCalls).toHaveLength(0);
  });

  it("still routes an EXTENSION-declared runtime.delegation.spawn to its identity-qualified policy bucket, never the builtin allow (F-DEPLOY-5c g4)", async () => {
    await installDelegationProxyExtension();
    const result = await api.invoke({
      sessionId: HOST_SESSION_ID,
      workspaceName: HOST_WORKSPACE_NAME,
      capability: PROXY_CAPABILITY_NAME,
      input: {},
      idempotencyKey: "fdeploy5c-proxy",
    });
    expect(result).toMatchObject({ ok: true, value: { output: { proxied: true } } });
    expect(evaluateDetailedCalls).toHaveLength(1);
    expect(evaluateDetailedCalls[0]).toMatchObject({
      toolName: `runtime-extension:${PROXY_EXTENSION_IDENTITY}:${DELEGATION_BUILTIN_PERMISSION}`,
    });
  });

  it("projection completeness: an enabled extension's active provider appears in capabilityProviderIds and carries no host provenance (F-DEPLOY-5c)", async () => {
    await installDelegationProxyExtension();
    const records = await host.listExtensions();
    const proxy = records.find((record) => record.identity === PROXY_EXTENSION_IDENTITY) as
      | { status: string; capabilityProviderIds?: readonly string[] }
      | undefined;
    expect(proxy?.status).toBe("enabled");
    // The residual F-DEPLOY-5c assumption under review: an enabled extension's
    // kernel-registered provider must never be missing from its lifecycle
    // capabilityProviderIds projection — otherwise owner-null would be
    // spoofable. Both are projected from the same prepared activation array.
    // (Structural narrow: the pinned @marshal/runtime archive types
    // listExtensions() as the base RuntimeExtensionRecord, but the lifecycle
    // manager returns RuntimeExtensionLifecycleRecord, which carries
    // capabilityProviderIds — the exact field resolveExtensionOwningProvider
    // reads at host.ts.)
    expect(proxy?.capabilityProviderIds).toContain(PROXY_PROVIDER_ID);
    await expect(host.resolveExtensionOwningProvider(PROXY_PROVIDER_ID)).resolves.toBe(
      PROXY_EXTENSION_IDENTITY,
    );
    // Affirmative provenance separates the two owner-null-adjacent worlds:
    // extension providers are never in the bootstrap registry; host providers
    // always are.
    await expect(host.isHostRegisteredCapabilityProvider(PROXY_PROVIDER_ID)).resolves.toBe(false);
    await expect(host.isHostRegisteredCapabilityProvider("marshal.delegation")).resolves.toBe(true);
    await expect(host.isHostRegisteredCapabilityProvider("marshal.runtime-ui")).resolves.toBe(true);
  });
});
