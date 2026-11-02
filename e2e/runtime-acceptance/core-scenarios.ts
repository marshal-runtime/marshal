/**
 * Direct, deterministic live-process acceptance scenarios for the Marshal Runtime
 * embedded-runtime acceptance harness (see scripts/runtime-acceptance/marshal-runtime-live-user-stories.md).
 *
 * This module owns only the "direct deterministic" story set that can be proven against a
 * single already-running acceptance-gated Electron process through the finite
 * `window.runtimeAcceptanceAPI` bridge (`RuntimeAcceptanceClient` in `./harness`). It does not
 * cover restart/recovery stories (MRT-BOOT-003/004/006/007/008, MRT-REC-001/002),
 * static-only provenance stories (MRT-PRV-001/002, MRT-LEG-002), or any story requiring a second
 * Electron launch — those remain the caller's responsibility.
 *
 * Every story is recorded through `LiveStoryRecorder.run()`, which isolates failures per story so
 * one broken scenario does not block independent ones. Assertions use `node:assert/strict` and
 * throw on any product mismatch; the recorder converts a thrown error into a FAIL entry with a
 * bug ID and continues.
 */

/* eslint-disable no-await-in-loop -- live scenarios intentionally serialize stateful operations */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { computeRuntimeExtensionIntegrity } from "@marshal/runtime/extensions";
import type { Page } from "@playwright/test";

import type {
  RuntimeAcceptanceAbort,
  RuntimeAcceptanceScope,
} from "../../common/runtime-acceptance";
import {
  MARSHAL_RUNTIME_PERMISSION,
  MARSHAL_RUNTIME_TOOL_PERMISSION_PREFIX,
} from "../../electron/marshal-runtime/contracts";
import { RUNTIME_SELF_TOOL_NAMES } from "../../electron/marshal-runtime/runtime-self-tools";
import {
  array,
  record,
  requireOk,
  type LiveStoryProof,
  type LiveStoryRecorder,
  type RuntimeAcceptanceClient,
} from "./harness";

// ---------------------------------------------------------------------------
// Public entry point and result shape
// ---------------------------------------------------------------------------

export interface CoreScenarioOptions {
  /** Bound to one already-running, fully gated acceptance Electron process. */
  readonly client: RuntimeAcceptanceClient;
  readonly recorder: LiveStoryRecorder;
}

export interface ExtensionScenarioOptions extends CoreScenarioOptions {
  readonly storyIds?: ReadonlySet<string>;
}

export interface RuntimeStartupFailureProof {
  readonly lifecycle: string;
  readonly startupErrorCode: string | null;
  readonly selfTools: readonly {
    readonly name: string;
    readonly objectId: string;
    readonly parameters?: Readonly<Record<string, unknown>>;
  }[];
  readonly runtimeResults: Readonly<Record<string, unknown>>;
  readonly ordinarySelfTools: readonly {
    readonly name: string;
    readonly objectId: string;
  }[];
}

export interface ApiContextScenarioOptions extends CoreScenarioOptions {
  readonly page: Page;
  readonly storyIds?: ReadonlySet<string>;
  readonly runRuntimeStartupFailure?: () => Promise<RuntimeStartupFailureProof>;
}

/**
 * State the caller's restart/recovery stories (MRT-REC-001/002, ...) need in order
 * to compare pre-restart and post-restart behavior without re-deriving it themselves.
 */
export interface CoreScenarioRestartState {
  readonly sessionId: string;
  readonly workspaceName: string;
  /** Extension identities this run installed and left enabled (not removed) when it finished. */
  readonly installedFixtureIdentities: readonly string[];
  /** Package roots backing `installedFixtureIdentities`, in the same order. */
  readonly installedFixturePackageRoots: readonly string[];
  /**
   * Bridge/product capabilities this module discovered were unavailable while trying to reach
   * full story fidelity, so the caller does not misinterpret a narrowed assertion as a gap in
   * this module's own testing rather than a harness limitation.
   */
  readonly missingBridgeCapabilities: readonly string[];
}

export async function runCoreScenarios(
  options: CoreScenarioOptions,
): Promise<CoreScenarioRestartState> {
  const { client, recorder } = options;
  const missingBridgeCapabilities = new Set<string>();
  const installedIdentities = new Map<string, string>(); // identity -> packageRoot, while installed
  const state: MutableScenarioState = {
    client,
    recorder,
    installedIdentities,
    missingBridgeCapabilities,
  };

  // Section 4.0 — acceptance harness confinement and fidelity.
  await recorder.run("MRT-HAR-002", () => scenarioHar002(state));

  // Section 4.1 — embedded package startup and lifecycle (non-restart subset).
  await recorder.run("MRT-BOOT-001", () => scenarioBoot001(state));
  await recorder.run("MRT-BOOT-002", () => scenarioBoot002(state));

  // Section 4.3 — TypeScript runtime execution.
  await recorder.run("MRT-TS-001", () => scenarioTs001(state));
  await recorder.run("MRT-TS-002", () => scenarioTs002(state));
  await recorder.run("MRT-TS-003", () => scenarioTs003(state));
  await recorder.run("MRT-TS-004", () => scenarioTs004(state));

  // Section 4.4 — live extension lifecycle, integrity, and ownership.
  await recorder.run("MRT-EXT-001", () => scenarioExt001(state));
  await recorder.run("MRT-EXT-002", () => scenarioExt002(state));
  await recorder.run("MRT-EXT-003", () => scenarioExt003(state));
  await recorder.run("MRT-EXT-004", () => scenarioExt004(state));
  await recorder.run("MRT-EXT-005", () => scenarioExt005(state));
  await recorder.run("MRT-EXT-006", () => scenarioExt006(state));
  await recorder.run("MRT-EXT-007", () => scenarioExt007(state));
  await recorder.run("MRT-EXT-008", () => scenarioExt008(state));
  await recorder.run("MRT-EXT-009", () => scenarioExt009(state));
  await recorder.run("MRT-EXT-010", () => scenarioExt010(state));
  await recorder.run("MRT-EXT-011", () => scenarioExt011(state));
  await recorder.run("MRT-EXT-012", () => scenarioExt012(state));
  await recorder.run("MRT-EXT-013", () => scenarioExt013(state));

  // Section 4.7 — agent-facing runtime self-tools, API validation, and authority.
  await recorder.run("MRT-API-001", () => scenarioApi001(state));
  await recorder.run("MRT-API-002", () => scenarioApi002(state));
  await recorder.run("MRT-CTX-001", () => scenarioCtx001(state));

  // Section 4.14 — portable swarm boundary and external extension ownership.
  await recorder.run("MRT-LEG-001", () => scenarioLeg001(state));

  const remainingIdentities = [...installedIdentities.keys()];
  const remainingPackageRoots = remainingIdentities.map(
    (identity) => installedIdentities.get(identity) ?? "",
  );
  return {
    sessionId: client.scope.sessionId,
    workspaceName: client.scope.workspaceName,
    installedFixtureIdentities: remainingIdentities,
    installedFixturePackageRoots: remainingPackageRoots,
    missingBridgeCapabilities: [...missingBridgeCapabilities],
  };
}

export async function runExtensionScenarios(
  options: ExtensionScenarioOptions,
): Promise<CoreScenarioRestartState> {
  const state = createScenarioState(options);
  const run = async (storyId: string, action: () => Promise<LiveStoryProof>): Promise<void> => {
    if (options.storyIds && !options.storyIds.has(storyId)) return;
    await options.recorder.run(storyId, "LIVE-ELECTRON", action);
  };

  await run("MRT-EXT-001", () => scenarioExt001(state));
  await run("MRT-EXT-002", () => scenarioExt002(state));
  await run("MRT-EXT-003", () => scenarioExt003(state));
  await run("MRT-EXT-004", () => scenarioExt004(state));
  await run("MRT-EXT-005", () => scenarioExt005(state));
  await run("MRT-EXT-006", () => scenarioExt006(state));
  await run("MRT-EXT-007", () => scenarioExt007(state));
  await run("MRT-EXT-008", () => scenarioExt008(state));
  await run("MRT-EXT-009", () => scenarioExt009(state));
  await run("MRT-EXT-010", () => scenarioExt010(state));
  await run("MRT-EXT-011", () => scenarioExt011(state));
  await run("MRT-EXT-013", () => scenarioExt013(state));
  return scenarioRestartState(state);
}

export async function runApiContextScenarios(options: ApiContextScenarioOptions): Promise<void> {
  const state = {
    ...createScenarioState(options),
    runRuntimeStartupFailure: options.runRuntimeStartupFailure,
  };
  const run = async (storyId: string, action: () => Promise<LiveStoryProof>): Promise<void> => {
    if (options.storyIds && !options.storyIds.has(storyId)) return;
    await options.recorder.run(storyId, "LIVE-ELECTRON", action);
  };
  await run("MRT-API-001", () => scenarioApi001(state));
  await run("MRT-API-002", () => scenarioApi002(state));
  await run("MRT-CTX-001", () => scenarioCtx001(state));
  await run("MRT-CTX-002", () => scenarioCtx002(state, options.page));
}

function createScenarioState(options: CoreScenarioOptions): MutableScenarioState {
  return {
    client: options.client,
    recorder: options.recorder,
    installedIdentities: new Map<string, string>(),
    missingBridgeCapabilities: new Set<string>(),
  };
}

async function scenarioRestartState(
  state: MutableScenarioState,
): Promise<CoreScenarioRestartState> {
  const installedFixtureIdentities = [...state.installedIdentities.keys()];
  return {
    sessionId: state.client.scope.sessionId,
    workspaceName: state.client.scope.workspaceName,
    installedFixtureIdentities,
    installedFixturePackageRoots: installedFixtureIdentities.map(
      (identity) => state.installedIdentities.get(identity) ?? "",
    ),
    missingBridgeCapabilities: [...state.missingBridgeCapabilities],
  };
}

// ---------------------------------------------------------------------------
// Shared mutable state threaded through scenario functions
// ---------------------------------------------------------------------------

interface MutableScenarioState {
  readonly client: RuntimeAcceptanceClient;
  readonly recorder: LiveStoryRecorder;
  readonly installedIdentities: Map<string, string>;
  readonly missingBridgeCapabilities: Set<string>;
  readonly runRuntimeStartupFailure?: () => Promise<RuntimeStartupFailureProof>;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function newKey(label: string): string {
  return `acceptance-${label}-${randomUUID()}`;
}

function readJsonLines(filePath: string): readonly Record<string, unknown>[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => record(JSON.parse(line) as unknown));
}

function captureTcpConnections(pid: number): readonly string[] {
  if (process.platform !== "win32") return [];
  const netstatOutput = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
  const connections = new Set<string>();
  for (const line of netstatOutput.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || fields[0]?.toUpperCase() !== "TCP") continue;
    if (Number(fields[4]) !== pid || fields[3] === "LISTENING") continue;
    connections.add(`${fields[2]} ${fields[3]}`);
  }
  return [...connections].sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function grant(
  client: RuntimeAcceptanceClient,
  permission: string,
  decision: "allow" | "deny" | "prompt" = "allow",
): Promise<void> {
  await client.value("setAcceptancePermission", permission, decision);
}

/** True for a `MarshalRuntimeApiErrorCode` accepted by the spec as "rejected before commit". */
function isRejectedBeforeCommit(code: string | null): boolean {
  return code === "invalid-request" || code === "operation-failed";
}

/** Reads the `.ok`/`.value`/`.error` envelope out of an already-unwrapped bridge result. */
interface ApiEnvelopeSummary {
  readonly ok: boolean;
  readonly value: Record<string, unknown>;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

function apiEnvelope(value: unknown): ApiEnvelopeSummary {
  const envelope = record(value);
  const errorRecord = record(envelope.error);
  return {
    ok: envelope.ok === true,
    value: record(envelope.value),
    errorCode:
      envelope.ok === false && typeof errorRecord.code === "string" ? errorRecord.code : null,
    errorMessage:
      envelope.ok === false && typeof errorRecord.message === "string" ? errorRecord.message : null,
  };
}

async function materializeEcho(
  client: RuntimeAcceptanceClient,
  version = "1.0.0",
): Promise<{
  readonly fixtureId: string;
  readonly packageRoot: string;
  readonly integrity: {
    readonly algorithm: "sha256";
    readonly domain: "marshal-runtime-extension-package-v1";
    readonly value: string;
  };
  readonly identity: string;
  readonly version: string;
  readonly capabilityNames: readonly string[];
  readonly catalogIds: readonly string[];
  readonly resourceUris: readonly string[];
}> {
  return client.value("materializeExtensionFixture", { profile: "echo", version });
}

/** Removes a previously installed identity and drops it from the restart-state ledger. */
async function removeIdentity(
  state: MutableScenarioState,
  identity: string,
): Promise<ReturnType<typeof apiEnvelope>> {
  const result = await state.client.value("removeExtension", {
    ...state.client.scope,
    identity,
    idempotencyKey: newKey("remove"),
  });
  state.installedIdentities.delete(identity);
  return apiEnvelope(result);
}

interface DirectoryConfinementProof {
  readonly directory: string;
  readonly exists: boolean;
  readonly isDirectory: boolean;
  readonly platform: NodeJS.Platform;
  readonly posixMode: string | null;
  readonly windowsAcl: string | null;
  readonly restrictedToOwner: boolean;
}

/**
 * Confirms a reported runtime directory is a real directory with owner-restricted access.
 * POSIX asserts mode `0700`. Windows inspects the real ACL via `icacls` and fails when a broad,
 * non-owner principal (`Everyone`, `BUILTIN\Users`, `Authenticated Users`) is granted access.
 */
function inspectDirectoryConfinement(directory: string): DirectoryConfinementProof {
  const stat = fs.statSync(directory);
  const platform = process.platform;
  if (platform !== "win32") {
    const mode = (stat.mode & 0o777).toString(8);
    return {
      directory,
      exists: true,
      isDirectory: stat.isDirectory(),
      platform,
      posixMode: mode,
      windowsAcl: null,
      restrictedToOwner: mode === "700",
    };
  }
  const raw = execFileSync("icacls", [directory], { encoding: "utf8" });
  const broadPrincipals = [/\bEveryone\b/i, /BUILTIN\\Users/i, /Authenticated Users/i];
  const grantsBroadAccess = raw
    .split(/\r?\n/)
    .filter((line) => /:\(/.test(line))
    .some((line) => broadPrincipals.some((pattern) => pattern.test(line)));
  return {
    directory,
    exists: true,
    isDirectory: stat.isDirectory(),
    platform,
    posixMode: null,
    windowsAcl: raw,
    restrictedToOwner: !grantsBroadAccess,
  };
}

// ---------------------------------------------------------------------------
// 4.0 — Acceptance harness confinement and fidelity
// ---------------------------------------------------------------------------

async function scenarioHar002(state: MutableScenarioState): Promise<LiveStoryProof> {
  const { client } = state;
  const bridgeInfo = await client.value("getBridgeInfo");
  assert.equal(bridgeInfo.compileTimeGate, true, "compile-time gate must be reported true");
  assert.equal(bridgeInfo.runtimeGates.unpackaged, true);
  assert.equal(bridgeInfo.runtimeGates.marshalE2E, true);
  assert.equal(bridgeInfo.runtimeGates.runtimeAcceptance, true);
  const instanceIds = Object.values(bridgeInfo.instanceIds);
  assert.equal(
    new Set(instanceIds).size,
    instanceIds.length,
    "host/api/controller/sessionManager/memoryManager/authority instance IDs must all be distinct objects",
  );

  // The harness caches one opaque ID per literal object reference (WeakMap-keyed). Calling
  // getBridgeInfo twice must reuse identical IDs — proof the "host"/"api"/... references are the
  // same already-constructed production singletons, not recreated per call.
  const bridgeInfoAgain = await client.value("getBridgeInfo");
  assert.deepEqual(
    bridgeInfoAgain.instanceIds,
    bridgeInfo.instanceIds,
    "repeated getBridgeInfo calls must resolve to the same production object identities",
  );

  const lifecycle = await client.value("getLifecycleEvents");
  assert.equal(
    lifecycle.filter((event) => event.type === "host.constructed").length,
    1,
    "exactly one runtime host must have been constructed",
  );
  assert.equal(
    lifecycle.filter((event) => event.type === "kernel.providers.inventory").length,
    1,
    "exactly one kernel provider inventory event (one kernel) is expected",
  );

  const selfTools = await client.value("listRegisteredSelfTools");
  assert.deepEqual(
    selfTools.map((tool) => tool.name),
    [...RUNTIME_SELF_TOOL_NAMES],
    "installed self-tools must be exactly the additionalTools runtime self-tools, in order",
  );
  assert.equal(
    new Set(selfTools.map((tool) => tool.objectId)).size,
    selfTools.length,
    "each registered self-tool object must have a distinct identity",
  );
  const selfToolsAgain = await client.value("listRegisteredSelfTools");
  assert.deepEqual(
    selfToolsAgain.map((tool) => tool.objectId),
    selfTools.map((tool) => tool.objectId),
    "self-tool object identities must be stable across calls (the exact additionalTools objects, not recreated handlers)",
  );

  const directSearch = requireOk(await client.search({ query: "runtime search invoke extension" }));
  const selfToolCallId = `acceptance-har-002-${randomUUID()}`;
  const selfToolSearchRaw = await client.value("invokeRegisteredSelfTool", {
    name: "runtimeSearch",
    sessionId: client.scope.sessionId,
    toolCallId: selfToolCallId,
    arguments: { query: "runtime search invoke extension" },
  });
  const selfToolSearch = requireOk(JSON.parse(selfToolSearchRaw) as unknown);
  assert.equal(
    array(selfToolSearch.matches).length > 0,
    array(directSearch.matches).length > 0,
    "the self-tool search and the direct API search must observe the same catalog",
  );

  // Fixture/failure controls must be allowlisted profile+scalars only: arbitrary source or an
  // arbitrary package root supplied to the runtime self-tools must be rejected before ever
  // reaching the production API, proving the bridge does not accept arbitrary code/paths.
  const arbitrarySource = await client.acceptance("invokeRegisteredSelfTool", {
    name: "runtimeExecuteTypeScript",
    sessionId: client.scope.sessionId,
    toolCallId: `acceptance-har-002-source-${randomUUID()}`,
    arguments: { source: "export default () => 1;" },
  });
  assert.equal(
    arbitrarySource.success,
    false,
    "raw source must never reach runtimeExecuteTypeScript",
  );

  const arbitraryPackageRoot = await client.acceptance("invokeRegisteredSelfTool", {
    name: "runtimeInstallExtension",
    sessionId: client.scope.sessionId,
    toolCallId: `acceptance-har-002-package-${randomUUID()}`,
    arguments: { packageRoot: "C:\\not-a-trusted-root", integritySha256: "0".repeat(64) },
  });
  assert.equal(
    arbitraryPackageRoot.success,
    false,
    "an arbitrary package root must never reach runtimeInstallExtension",
  );

  return {
    proof: {
      bridgeInfo,
      instanceIdsStable: true,
      selfToolNames: selfTools.map((tool) => tool.name),
      selfToolObjectIdsStable: true,
      directSearchHadMatches: array(directSearch.matches).length > 0,
      selfToolSearchHadMatches: array(selfToolSearch.matches).length > 0,
      arbitrarySourceRejected: true,
      arbitraryPackageRootRejected: true,
    },
  };
}

// ---------------------------------------------------------------------------
// 4.1 — Embedded package startup and lifecycle (non-restart subset)
// ---------------------------------------------------------------------------

async function scenarioBoot001(state: MutableScenarioState): Promise<LiveStoryProof> {
  const { client } = state;
  const status = await client.value("getStatus");
  const statusRecord = record(status);
  assert.equal(statusRecord.lifecycle, "running", "runtime host must be running");
  const runtimePackage = record(statusRecord.runtimePackage);
  assert.equal(runtimePackage.name, "@marshal/runtime");
  assert.equal(runtimePackage.version, "0.1.0");
  assert.equal(runtimePackage.entrypoint, "dist/host.js");

  const requiredCapabilities = [
    "marshal.agent.launch",
    "marshal.memory.store",
    "marshal.brain.launch",
    "ui.application.open",
    "code.index.status",
  ] as const;
  const foundCapabilities: Record<string, boolean> = {};
  for (const capabilityName of requiredCapabilities) {
    const found = requireOk(await client.search({ name: capabilityName, detail: "full" }));
    const matches = array(found.matches).map(record);
    foundCapabilities[capabilityName] = matches.some(
      (match) => record(match.capability).name === capabilityName,
    );
    assert.equal(
      foundCapabilities[capabilityName],
      true,
      `capability must be discoverable via runtime search: ${capabilityName}`,
    );
  }

  const paths = await client.value("getPaths");
  const inspectedDirectories = [
    paths.runtimeRoot,
    paths.workspaceRoot,
    paths.protectedResultsRoot,
    paths.worktreeRoot,
    paths.trustedExtensionRoot,
  ];
  const confinement = inspectedDirectories.map(inspectDirectoryConfinement);
  for (const entry of confinement) {
    assert.equal(entry.isDirectory, true, `${entry.directory} must be a real directory`);
  }
  const notRestricted = confinement.filter((entry) => !entry.restrictedToOwner);
  assert.equal(
    notRestricted.length,
    0,
    `runtime directories must be owner-restricted; offenders: ${notRestricted
      .map((entry) => entry.directory)
      .join(", ")}`,
  );

  return {
    proof: {
      status: statusRecord,
      foundCapabilities,
      directoryConfinement: confinement,
    },
  };
}

async function scenarioBoot002(state: MutableScenarioState): Promise<LiveStoryProof> {
  const { client } = state;
  const beforeLifecycle = await client.value("getLifecycleEvents");
  const calls: Promise<unknown>[] = [];
  for (let index = 0; index < 8; index += 1) {
    calls.push(client.value("getStatus"));
  }
  for (let index = 0; index < 8; index += 1) {
    calls.push(client.search({ query: "code" }));
  }
  for (let index = 0; index < 4; index += 1) {
    calls.push(client.invoke("code.index.status", {}, newKey(`boot-002-first-use-${index}`)));
  }
  const settled = await Promise.allSettled(calls);
  assert.equal(
    settled.filter((entry) => entry.status === "fulfilled").length,
    settled.length,
    "every concurrent bridge call must resolve without throwing",
  );

  const lifecycle = await client.value("getLifecycleEvents");
  assert.equal(
    lifecycle.filter((event) => event.type === "host.constructed").length,
    1,
    "concurrent first-use calls must not construct a second runtime host",
  );
  assert.equal(
    lifecycle.filter((event) => event.type === "kernel.providers.inventory").length,
    1,
    "concurrent first-use calls must not register providers twice (one kernel)",
  );
  assert.equal(
    lifecycle.some((event) =>
      /duplicate-provider|duplicate-resource|partial-start/.test(event.type),
    ),
    false,
    "no duplicate-provider/duplicate-resource/partial-start lifecycle event may appear",
  );

  return {
    proof: {
      concurrentCallCount: calls.length,
      allSettled: true,
      lifecycleEventCountBefore: beforeLifecycle.length,
      lifecycleEventCountAfter: lifecycle.length,
    },
  };
}

// ---------------------------------------------------------------------------
// 4.3 — TypeScript runtime execution
// ---------------------------------------------------------------------------

async function scenarioTs001(state: MutableScenarioState): Promise<LiveStoryProof> {
  const { client } = state;
  const fixture = await materializeEcho(client);
  await grant(client, `marshal.tool.invoke:${fixture.capabilityNames[0]}`, "allow");
  const installed = apiEnvelope(
    await client.value("installExtension", {
      ...client.scope,
      fixtureId: fixture.fixtureId,
      idempotencyKey: newKey("ts-001-install"),
    }),
  );
  assert.equal(installed.ok, true, "the echo fixture must install cleanly");
  if (typeof installed.value.identity === "string") {
    state.installedIdentities.set(installed.value.identity, fixture.packageRoot);
  }

  const input = { marker: `ts-001-${randomUUID()}` };
  const result = requireOk(
    await client.value("executeTypeScript", {
      ...client.scope,
      profile: "invoke-capability",
      capability: fixture.capabilityNames[0],
      input,
      idempotencyKey: newKey("ts-001-exec"),
    }),
  );
  const value = record(result.value);
  const nestedOutput = record(value.output);
  assert.deepEqual(nestedOutput.input, input, "the nested invoke must preserve the exact input");
  const receipts = array(result.receipts).map(record);
  assert.equal(receipts.length > 0, true, "at least one execution receipt must be produced");
  assert.equal(
    receipts.every((receipt) => receipt.status === "success"),
    true,
    "every receipt for a successful brokered execution must report status success",
  );

  return {
    proof: {
      fixture,
      input,
      output: nestedOutput,
      receiptStatuses: receipts.map((receipt) => receipt.status),
    },
  };
}

async function scenarioTs002(state: MutableScenarioState): Promise<LiveStoryProof> {
  const { client } = state;
  await grant(client, "code.read", "deny");
  const denied = await client.value("executeTypeScript", {
    ...client.scope,
    profile: "invoke-capability",
    capability: "code.index.status",
    input: {},
    idempotencyKey: newKey("ts-002-denied"),
  });
  const deniedEnvelope = apiEnvelope(denied);
  assert.equal(deniedEnvelope.ok, false, "denying code.read must fail the nested invoke");
  assert.equal(
    deniedEnvelope.errorCode,
    "permission-denied",
    "the normalized error code for a denied nested capability must be permission-denied",
  );

  const ambientProfiles = [
    "ambient-fs",
    "ambient-child-process",
    "ambient-process",
    "undeclared-import",
  ] as const;
  const ambientResults: Record<string, string | null> = {};
  for (const profile of ambientProfiles) {
    const envelope = apiEnvelope(
      await client.value("executeTypeScript", {
        ...client.scope,
        profile,
        idempotencyKey: newKey(`ts-002-${profile}`),
      }),
    );
    assert.equal(
      envelope.ok,
      false,
      `${profile} must not gain ambient Node/undeclared-import authority`,
    );
    ambientResults[profile] = envelope.errorCode;
  }

  await grant(client, "code.read", "allow");
  return {
    proof: {
      deniedNestedCapability: deniedEnvelope,
      ambientResults,
    },
  };
}

async function scenarioTs003(state: MutableScenarioState): Promise<LiveStoryProof> {
  const { client } = state;

  const fixture = await materializeEcho(client);
  const installed = apiEnvelope(
    await client.value("installExtension", {
      ...client.scope,
      fixtureId: fixture.fixtureId,
      idempotencyKey: newKey("ts-003-install"),
    }),
  );
  assert.equal(installed.ok, true);
  if (typeof installed.value.identity === "string") {
    state.installedIdentities.set(installed.value.identity, fixture.packageRoot);
  }

  const normalRun = requireOk(
    await client.value("executeTypeScript", {
      ...client.scope,
      profile: "invoke-capability",
      capability: fixture.capabilityNames[0],
      input: { probe: "ts-003-normal" },
      idempotencyKey: newKey("ts-003-normal"),
    }),
  );
  assert.equal(record(normalRun.value).output !== undefined, true);

  const overLimitTimeout = apiEnvelope(
    await client.value("executeTypeScript", {
      ...client.scope,
      profile: "invoke-capability",
      capability: fixture.capabilityNames[0],
      timeoutMs: 65_000,
      idempotencyKey: newKey("ts-003-timeout-limit"),
    }),
  );
  assert.equal(
    overLimitTimeout.ok,
    false,
    "a requested timeoutMs above 60,000 ms must be rejected",
  );
  assert.equal(isRejectedBeforeCommit(overLimitTimeout.errorCode), true);

  const outputOverflow = apiEnvelope(
    await client.value("executeTypeScript", {
      ...client.scope,
      profile: "output-overflow",
      idempotencyKey: newKey("ts-003-output-overflow"),
    }),
  );
  assert.equal(
    outputOverflow.ok,
    false,
    "output above the bounded cap must fail with a bounded diagnostic",
  );

  // Observe the real child process the host spawns for a brokered execution. `nodeExecutable`
  // is `process.execPath` in this (non-packaged) acceptance build; poll for a live descendant of
  // the Electron main process at that same executable while a long-running module is in flight.
  const mainExecPath = await client.app.evaluate(() => process.execPath);
  const bridgeInfo = await client.value("getBridgeInfo");
  const longRunning = client.value("executeTypeScript", {
    ...client.scope,
    profile: "timeout",
    idempotencyKey: newKey("ts-003-child-observe"),
    abort: { timing: "after-ms", delayMs: 4_000 },
  });
  let observedChild: ReturnType<typeof captureWindowsProcessSnapshot>[number] | undefined;
  if (process.platform === "win32") {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && !observedChild) {
      const snapshot = captureWindowsProcessSnapshot(bridgeInfo.mainProcessPid);
      observedChild = snapshot.find((entry) =>
        pathsRoughlyEqual(entry.executablePath, mainExecPath),
      );
      if (!observedChild) await sleep(150);
    }
  }
  await longRunning;

  return {
    proof: {
      normalRunSucceeded: true,
      overLimitTimeoutRejected: true,
      outputOverflowRejected: true,
      childProcessObserved: Boolean(observedChild),
      childProcessRecord: observedChild ?? null,
    },
    supportingEvidence:
      process.platform === "win32"
        ? []
        : ["Child-process observation is Windows-specific; this run is not on win32."],
  };
}

async function scenarioTs004(state: MutableScenarioState): Promise<LiveStoryProof> {
  const { client } = state;
  const fixture = await materializeEcho(client);
  const installed = apiEnvelope(
    await client.value("installExtension", {
      ...client.scope,
      fixtureId: fixture.fixtureId,
      idempotencyKey: newKey("ts-004-install"),
    }),
  );
  assert.equal(installed.ok, true);
  if (typeof installed.value.identity === "string") {
    state.installedIdentities.set(installed.value.identity, fixture.packageRoot);
  }

  // Identical concurrent requests (same key + same payload) must share one underlying execution.
  const sharedKey = newKey("ts-004-shared");
  const sharedInput = { marker: "ts-004-shared" };
  const beforeCounts = await client.value("getInvocationCounts");
  const [first, second] = await Promise.all([
    client.value("executeTypeScript", {
      ...client.scope,
      profile: "invoke-capability",
      capability: fixture.capabilityNames[0],
      input: sharedInput,
      idempotencyKey: sharedKey,
    }),
    client.value("executeTypeScript", {
      ...client.scope,
      profile: "invoke-capability",
      capability: fixture.capabilityNames[0],
      input: sharedInput,
      idempotencyKey: sharedKey,
    }),
  ]);
  const firstOk = requireOk(first);
  const secondOk = requireOk(second);
  assert.deepEqual(
    record(firstOk.value).output,
    record(secondOk.value).output,
    "identical concurrent requests must resolve to the same shared execution result",
  );
  const afterCounts = await client.value("getInvocationCounts");
  const fixtureKey = `fixture:${fixture.fixtureId}`;
  const beforeInvokeCount = (beforeCounts.fixtureEvents[fixtureKey] ?? []).filter((event) =>
    event.startsWith("invoke:"),
  ).length;
  const afterInvokeCount = (afterCounts.fixtureEvents[fixtureKey] ?? []).filter((event) =>
    event.startsWith("invoke:"),
  ).length;
  assert.equal(
    afterInvokeCount - beforeInvokeCount,
    1,
    "two identical concurrent requests must invoke the underlying provider exactly once",
  );

  // Reusing the same key with a different payload must conflict.
  const conflict = apiEnvelope(
    await client.value("executeTypeScript", {
      ...client.scope,
      profile: "invoke-capability",
      capability: fixture.capabilityNames[0],
      input: { marker: "different-payload" },
      idempotencyKey: sharedKey,
    }),
  );
  assert.equal(conflict.ok, false);
  assert.equal(conflict.errorCode, "idempotency-conflict");

  // A never-settling execution shared by two waiters: aborting one waiter must not cancel the
  // other still-pending waiter; aborting the sole remaining waiter must then return "aborted".
  const blockingKey = newKey("ts-004-blocking");
  const earlyAbortWaiter = client.value("executeTypeScript", {
    ...client.scope,
    profile: "timeout",
    idempotencyKey: blockingKey,
    abort: { timing: "after-ms", delayMs: 300 },
  });
  const survivingWaiter = client.value("executeTypeScript", {
    ...client.scope,
    profile: "timeout",
    idempotencyKey: blockingKey,
    abort: { timing: "after-ms", delayMs: 3_500 },
  });
  const earlyAbortResult = apiEnvelope(await earlyAbortWaiter);
  assert.equal(earlyAbortResult.ok, false);
  assert.equal(earlyAbortResult.errorCode, "aborted");

  let survivingSettledEarly = false;
  const raceResult = await Promise.race([
    survivingWaiter.then(() => "settled" as const),
    sleep(500).then(() => "still-pending" as const),
  ]);
  survivingSettledEarly = raceResult === "settled";
  assert.equal(
    survivingSettledEarly,
    false,
    "aborting one waiter must not cancel a shared execution another waiter is still awaiting",
  );
  const survivingResult = apiEnvelope(await survivingWaiter);
  assert.equal(survivingResult.ok, false);
  assert.equal(
    survivingResult.errorCode,
    "aborted",
    "aborting the sole remaining waiter must propagate cancellation and return aborted",
  );

  return {
    proof: {
      sharedExecutionResultsEqual: true,
      sharedExecutionInvokedOnce: afterInvokeCount - beforeInvokeCount === 1,
      idempotencyConflict: conflict,
      earlyAbortResult,
      survivorNotCancelledByFirstAbort: !survivingSettledEarly,
      survivorResultAfterSoleAbort: survivingResult,
    },
    supportingEvidence: [
      "No fixture profile can model a bounded 'block then resolve' capability; the current " +
        "profile set only offers an immediately-resolving invoke and a never-resolving timeout, " +
        "so 'the surviving waiter gets the real result' could not be proven end-to-end — only " +
        "that a second waiter is unaffected by the first waiter's abort while the shared " +
        "execution is still outstanding.",
    ],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface WindowsProcessRecord {
  readonly pid: number;
  readonly parentPid: number;
  readonly name: string;
  readonly executablePath: string | null;
  readonly commandLine: string | null;
}

/** Snapshots live child processes of `parentPid` via WMI (Windows-only; best-effort). */
function captureWindowsProcessSnapshot(parentPid: number): readonly WindowsProcessRecord[] {
  if (process.platform !== "win32") return [];
  try {
    const script =
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid}" | ` +
      "Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
    const raw = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
      },
    ).trim();
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    return entries.map((entry) => {
      const row = record(entry);
      return {
        pid: Number(row.ProcessId ?? 0),
        parentPid: Number(row.ParentProcessId ?? 0),
        name: typeof row.Name === "string" ? row.Name : "",
        executablePath: typeof row.ExecutablePath === "string" ? row.ExecutablePath : null,
        commandLine: typeof row.CommandLine === "string" ? row.CommandLine : null,
      };
    });
  } catch {
    return [];
  }
}

function pathsRoughlyEqual(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

// ---------------------------------------------------------------------------
// 4.4 — Live extension lifecycle, integrity, and ownership
// ---------------------------------------------------------------------------

async function scenarioExt001(state: MutableScenarioState): Promise<LiveStoryProof> {
  const { client } = state;
  const extensions = requireOk(await client.value("listExtensions", client.scope));
  const list = array(extensions.value).map(record);
  const undeclared = list.filter(
    (extension) => !state.installedIdentities.has(String(extension.identity)),
  );
  assert.equal(undeclared.length, 0, "no undeclared extension may be present before installs");

  const audit = await client.value("getAuthorityAudit");
  assert.equal(
    audit.some((entry) => entry.capability === "marshal.extension.list"),
    true,
    "listExtensions must request marshal.extension.list authority",
  );

  return { proof: { list, undeclaredCount: undeclared.length } };
}

async function scenarioExt002(state: MutableScenarioState): Promise<LiveStoryProof> {
  const { client } = state;
  const statusBefore = record(await client.value("getStatus"));
  const fixture = await materializeEcho(client);
  const installed = requireOk(
    await client.value("installExtension", {
      ...client.scope,
      fixtureId: fixture.fixtureId,
      idempotencyKey: newKey("ext-002-install"),
    }),
  );
  const record_ = record(installed.value);
  assert.equal(record_.identity, fixture.identity);
  assert.equal(record_.version, fixture.version);
  assert.equal(record_.status, "enabled");
  state.installedIdentities.set(record_.identity, fixture.packageRoot);

  const searchResult = requireOk(await client.search({ name: fixture.capabilityNames[0] }));
  assert.equal(
    array(searchResult.matches).some(
      (match) => record(record(match).capability).name === fixture.capabilityNames[0],
    ),
    true,
    "the freshly installed capability must be immediately searchable, without a restart",
  );

  const invokeResult = requireOk(
    await client.invoke(fixture.capabilityNames[0], { probe: "ext-002" }, newKey("ext-002-invoke")),
  );
  assert.deepEqual(record(invokeResult.value.output).input, { probe: "ext-002" });

  const statusAfter = record(await client.value("getStatus"));
  assert.deepEqual(
    statusAfter,
    statusBefore,
    "host lifecycle status must be unchanged by a live install",
  );

  const counts = await client.value("getInvocationCounts");
  const events = counts.fixtureEvents[`fixture:${fixture.fixtureId}`] ?? [];
  assert.equal(
    events.filter((event) => event === "activate:start").length,
    1,
    "activation must occur exactly once",
  );

  return {
    proof: { fixture, installed: record_, statusUnchanged: true, activationCount: 1 },
  };
}

async function scenarioExt003(state: MutableScenarioState): Promise<LiveStoryProof> {
  const { client } = state;
  const fixture = await materializeEcho(client, "1.0.0");
  const installed = requireOk(
    await client.value("installExtension", {
      ...client.scope,
      fixtureId: fixture.fixtureId,
      idempotencyKey: newKey("ext-003-install"),
    }),
  );
  const identity = String(record(installed.value).identity);
  state.installedIdentities.set(identity, fixture.packageRoot);
  const replacement = await client.value("materializeExtensionFixture", {
    profile: "echo",
    version: "2.0.0",
    identityFixtureId: fixture.fixtureId,
  });

  const searchesDuringUpdate: Promise<unknown>[] = [];
  for (let index = 0; index < 10; index += 1) {
    searchesDuringUpdate.push(client.search({ name: fixture.capabilityNames[0] }));
  }
  const updatePromise = client.value("updateExtension", {
    ...client.scope,
    identity,
    fixtureId: replacement.fixtureId,
    idempotencyKey: newKey("ext-003-update"),
  });
  const [updateEnvelope, ...searchSnapshots] = await Promise.all([
    updatePromise,
    ...searchesDuringUpdate,
  ]);
  const updated = requireOk(updateEnvelope);
  assert.equal(
    record(updated.value).identity,
    identity,
    "update must preserve the extension identity",
  );
  assert.equal(record(updated.value).status, "enabled");

  for (const snapshot of searchSnapshots) {
    const ok = requireOk(snapshot);
    const matches = array(ok.matches).filter(
      (match) => record(record(match).capability).name === fixture.capabilityNames[0],
    );
    assert.equal(
      matches.length,
      1,
      "every concurrent reader must see exactly one complete version",
    );
    assert.equal(
      ["1.0.0", "2.0.0"].includes(String(record(record(matches[0]).capability).version)),
      true,
      "a concurrent reader must see either the complete old or complete new descriptor",
    );
  }

  const counts = await client.value("getInvocationCounts");
  const oldEvents = counts.fixtureEvents[`fixture:${fixture.fixtureId}`] ?? [];
  const replacementEvents = counts.fixtureEvents[`fixture:${replacement.fixtureId}`] ?? [];
  assert.equal(
    oldEvents.filter((event) => event === "dispose").length,
    1,
    "the old activation must be disposed exactly once",
  );
  assert.equal(
    replacementEvents.filter((event) => event === "activate:complete").length,
    1,
    "the replacement activation must complete exactly once",
  );
  const paths = await client.value("getPaths");
  const eventTimeline = readJsonLines(path.join(paths.evidenceRoot, "fixture-events.jsonl"));
  const replacementCompleteIndex = eventTimeline.findIndex(
    (event) =>
      record(event).fixture === `fixture:${replacement.fixtureId}` &&
      record(event).event === "activate:complete",
  );
  const oldDisposeIndex = eventTimeline.findIndex(
    (event) =>
      record(event).fixture === `fixture:${fixture.fixtureId}` && record(event).event === "dispose",
  );
  assert.equal(
    replacementCompleteIndex >= 0 && oldDisposeIndex > replacementCompleteIndex,
    true,
    "the old activation must be disposed only after replacement activation completes",
  );

  const finalInvoke = requireOk(
    await client.invoke(
      fixture.capabilityNames[0],
      { probe: "ext-003-post-update" },
      newKey("ext-003-final"),
    ),
  );
  assert.equal(record(finalInvoke.value.output).version, "2.0.0");
  const finalSearch = requireOk(await client.search({ name: fixture.capabilityNames[0] }));
  const finalMatches = array(finalSearch.matches).filter(
    (match) => record(record(match).capability).name === fixture.capabilityNames[0],
  );
  assert.equal(finalMatches.length, 1);
  assert.equal(record(record(finalMatches[0]).capability).version, "2.0.0");

  return {
    proof: {
      identity,
      updated: record(updated.value),
      oldEvents,
      replacementEvents,
      concurrentReaderCount: searchSnapshots.length,
      finalMatches,
      eventTimeline,
    },
  };
}

async function scenarioExt004(state: MutableScenarioState): Promise<LiveStoryProof> {
  const { client } = state;
  const fixture = await materializeEcho(client);
  const installed = requireOk(
    await client.value("installExtension", {
      ...client.scope,
      fixtureId: fixture.fixtureId,
      idempotencyKey: newKey("ext-004-install"),
    }),
  );
  const identity = String(record(installed.value).identity);
  state.installedIdentities.set(identity, fixture.packageRoot);

  const activationFailure = await client.value("materializeExtensionFixture", {
    profile: "activation-failure",
    version: "2.0.0",
    identityFixtureId: fixture.fixtureId,
  });
  const activationFailingUpdate = apiEnvelope(
    await client.value("updateExtension", {
      ...client.scope,
      identity,
      fixtureId: activationFailure.fixtureId,
      idempotencyKey: newKey("ext-004-activation-failure"),
    }),
  );
  assert.equal(
    activationFailingUpdate.ok,
    false,
    "a corrupted staged update must fail before commit",
  );
  assert.equal(isRejectedBeforeCommit(activationFailingUpdate.errorCode), true);

  const afterFirstFailure = requireOk(await client.search({ name: fixture.capabilityNames[0] }));
  assert.equal(
    array(afterFirstFailure.matches).some(
      (match) => record(record(match).capability).name === fixture.capabilityNames[0],
    ),
    true,
    "version 1 must remain searchable after a failed update attempt",
  );
  const survivingInvoke = requireOk(
    await client.invoke(
      fixture.capabilityNames[0],
      { probe: "ext-004-survives" },
      newKey("ext-004-invoke-1"),
    ),
  );
  assert.equal(record(survivingInvoke.value.output).input !== undefined, true);

  const duplicateFailure = await client.value("materializeExtensionFixture", {
    profile: "duplicate-capability",
    version: "2.1.0",
    identityFixtureId: fixture.fixtureId,
  });
  const duplicateRegistrationUpdate = apiEnvelope(
    await client.value("updateExtension", {
      ...client.scope,
      identity,
      fixtureId: duplicateFailure.fixtureId,
      idempotencyKey: newKey("ext-004-duplicate"),
    }),
  );
  assert.equal(duplicateRegistrationUpdate.ok, false);
  assert.equal(isRejectedBeforeCommit(duplicateRegistrationUpdate.errorCode), true);
  const survivingInvokeAfterDuplicate = requireOk(
    await client.invoke(
      fixture.capabilityNames[0],
      { probe: "ext-004-survives-duplicate" },
      newKey("ext-004-invoke-2"),
    ),
  );
  assert.equal(record(survivingInvokeAfterDuplicate.value.output).version, "1.0.0");
  const inventory = record(await client.value("getRegistrationInventory"));
  const matches = array(record(inventory.search).matches).filter(
    (match) => record(record(match).capability).name === fixture.capabilityNames[0],
  );
  assert.equal(matches.length, 1);
  const counts = await client.value("getInvocationCounts");
  assert.equal(
    (counts.fixtureEvents[`fixture:${fixture.fixtureId}`] ?? []).includes("dispose"),
    false,
    "the old activation must not be disposed after failed replacements",
  );
  assert.equal(
    (counts.fixtureEvents[`fixture:${duplicateFailure.fixtureId}`] ?? []).includes("dispose"),
    true,
    "a staged activation must be disposed after registration failure",
  );

  return {
    proof: {
      activationFailingUpdate,
      duplicateRegistrationUpdate,
      firstFixtureSurvivedInvoke: true,
      survivingInvokeAfterDuplicate,
      inventory,
      counts,
    },
  };
}

async function scenarioExt005(state: MutableScenarioState): Promise<LiveStoryProof> {
  const { client } = state;
  const fixture = await materializeEcho(client);
  const installed = requireOk(
    await client.value("installExtension", {
      ...client.scope,
      fixtureId: fixture.fixtureId,
      idempotencyKey: newKey("ext-005-install"),
    }),
  );
  const identity = String(record(installed.value).identity);
  state.installedIdentities.set(identity, fixture.packageRoot);

  const disabled = requireOk(
    await client.value("disableExtension", {
      ...client.scope,
      identity,
      idempotencyKey: newKey("ext-005-disable"),
    }),
  );
  assert.equal(record(disabled.value).status, "disabled");
  const searchWhileDisabled = requireOk(await client.search({ name: fixture.capabilityNames[0] }));
  assert.equal(
    array(searchWhileDisabled.matches).some(
      (match) => record(record(match).capability).name === fixture.capabilityNames[0],
    ),
    false,
    "a disabled extension's capability must not be searchable",
  );
  const invokeWhileDisabled = apiEnvelope(
    await client.invoke(fixture.capabilityNames[0], {}, newKey("ext-005-invoke-disabled")),
  );
  assert.equal(
    invokeWhileDisabled.ok,
    false,
    "a disabled extension's capability must not be invokable",
  );

  const enabledOnce = requireOk(
    await client.value("enableExtension", {
      ...client.scope,
      identity,
      idempotencyKey: newKey("ext-005-enable-1"),
    }),
  );
  assert.equal(record(enabledOnce.value).status, "enabled");
  const searchAfterEnable = requireOk(await client.search({ name: fixture.capabilityNames[0] }));
  const matchesAfterEnable = array(searchAfterEnable.matches).filter(
    (match) => record(record(match).capability).name === fixture.capabilityNames[0],
  );
  assert.equal(matchesAfterEnable.length, 1, "re-enabling must restore exactly one registration");

  const enabledTwice = requireOk(
    await client.value("enableExtension", {
      ...client.scope,
      identity,
      idempotencyKey: newKey("ext-005-enable-2"),
    }),
  );
  assert.equal(record(enabledTwice.value).status, "enabled");
  const searchAfterSecondEnable = requireOk(
    await client.search({ name: fixture.capabilityNames[0] }),
  );
  const matchesAfterSecondEnable = array(searchAfterSecondEnable.matches).filter(
    (match) => record(record(match).capability).name === fixture.capabilityNames[0],
  );
  assert.equal(
    matchesAfterSecondEnable.length,
    1,
    "repeated enable must not duplicate the registration",
  );

  const removed = await removeIdentity(state, identity);
  assert.equal(removed.ok, true, "remove must succeed for an installed identity");
  assert.equal(removed.value.removed, true);
  const searchAfterRemove = requireOk(await client.search({ name: fixture.capabilityNames[0] }));
  assert.equal(
    array(searchAfterRemove.matches).some(
      (match) => record(record(match).capability).name === fixture.capabilityNames[0],
    ),
    false,
  );
  const invokeAfterRemove = apiEnvelope(
    await client.invoke(fixture.capabilityNames[0], {}, newKey("ext-005-invoke-removed")),
  );
  assert.equal(invokeAfterRemove.ok, false);
  assert.equal(invokeAfterRemove.errorCode, "not-found");
  const listAfterRemove = requireOk(await client.value("listExtensions", client.scope));
  assert.equal(
    array(listAfterRemove.value).some((extension) => record(extension).identity === identity),
    false,
    "remove must delete the extension record",
  );

  return {
    proof: {
      identity,
      disabledStatus: record(disabled.value).status,
      enabledOnceRegistrations: matchesAfterEnable.length,
      enabledTwiceRegistrations: matchesAfterSecondEnable.length,
      removedResult: removed.value,
      invokeAfterRemoveErrorCode: invokeAfterRemove.errorCode,
    },
  };
}

async function scenarioExt006(state: MutableScenarioState): Promise<LiveStoryProof> {
  const { client } = state;
  const multi = await client.value("materializeExtensionFixture", {
    profile: "multi-contribution",
    version: "1.0.0",
  });
  const installedMulti = requireOk(
    await client.value("installExtension", {
      ...client.scope,
      fixtureId: multi.fixtureId,
      idempotencyKey: newKey("ext-006-install-multi"),
    }),
  );
  const multiIdentity = String(record(installedMulti.value).identity);
  state.installedIdentities.set(multiIdentity, multi.packageRoot);
  assert.equal(
    multi.capabilityNames.length,
    2,
    "the multi-contribution fixture must declare two capabilities",
  );
  assert.equal(
    multi.providerIds.length,
    2,
    "the multi-contribution fixture must declare two providers",
  );
  assert.equal(
    multi.catalogProviderIds.length,
    2,
    "the multi-contribution fixture must declare two catalog providers",
  );
  assert.equal(
    multi.resourceUris.length,
    2,
    "the multi-contribution fixture must declare two resources",
  );
  assert.equal(
    multi.uiApplicationIds.length,
    2,
    "the multi-contribution fixture must declare two UI applications",
  );
  for (const capabilityName of multi.capabilityNames) {
    const found = requireOk(await client.search({ name: capabilityName }));
    assert.equal(
      array(found.matches).some(
        (match) => record(record(match).capability).name === capabilityName,
      ),
      true,
      `multi-contribution capability must be searchable: ${capabilityName}`,
    );
  }

  const collisionResults: Record<string, ReturnType<typeof apiEnvelope>> = {};
  for (const collisionKind of [
    "provider",
    "catalog-provider",
    "catalog-entry",
    "capability",
    "resource",
  ] as const) {
    const duplicate = await client.value("materializeExtensionFixture", {
      profile: "collision",
      version: "1.0.0",
      collisionFixtureId: multi.fixtureId,
      collisionKind,
    });
    const duplicateInstall = apiEnvelope(
      await client.value("installExtension", {
        ...client.scope,
        fixtureId: duplicate.fixtureId,
        idempotencyKey: newKey(`ext-006-install-${collisionKind}`),
      }),
    );
    assert.equal(
      duplicateInstall.ok,
      false,
      `a cross-extension ${collisionKind} collision must be rejected`,
    );
    assert.equal(isRejectedBeforeCommit(duplicateInstall.errorCode), true);
    collisionResults[collisionKind] = duplicateInstall;
  }

  for (const capabilityName of multi.capabilityNames) {
    const stillFound = requireOk(await client.search({ name: capabilityName }));
    assert.equal(
      array(stillFound.matches).some(
        (match) => record(record(match).capability).name === capabilityName,
      ),
      true,
      `the first extension's registrations must survive a rejected second install: ${capabilityName}`,
    );
  }

  const removedMulti = await removeIdentity(state, multiIdentity);
  assert.equal(removedMulti.ok, true);
  for (const capabilityName of multi.capabilityNames) {
    const goneAfterDispose = requireOk(await client.search({ name: capabilityName }));
    assert.equal(
      array(goneAfterDispose.matches).some(
        (match) => record(record(match).capability).name === capabilityName,
      ),
      false,
    );
  }
  const codeIndexStillPresent = requireOk(await client.search({ name: "code.index.status" }));
  assert.equal(
    array(codeIndexStillPresent.matches).some(
      (match) => record(record(match).capability).name === "code.index.status",
    ),
    true,
    "disposing one extension's activation must not revoke native code intelligence",
  );

  return {
    proof: {
      multiIdentity,
      multiCapabilities: multi.capabilityNames,
      multiProviders: multi.providerIds,
      multiCatalogProviders: multi.catalogProviderIds,
      multiCatalogIds: multi.catalogIds,
      multiResources: multi.resourceUris,
      multiUiApplications: multi.uiApplicationIds,
      collisionResults,
    },
  };
}

async function scenarioExt007(state: MutableScenarioState): Promise<LiveStoryProof> {
  const { client } = state;
  const fixture = await materializeEcho(client);
  const validInstall = requireOk(
    await client.value("installExtension", {
      ...client.scope,
      fixtureId: fixture.fixtureId,
      idempotencyKey: newKey("ext-007-valid-install"),
    }),
  );
  const identity = String(record(validInstall.value).identity);
  state.installedIdentities.set(identity, fixture.packageRoot);
  const replacement = await client.value("materializeExtensionFixture", {
    profile: "echo",
    version: "2.0.0",
    identityFixtureId: fixture.fixtureId,
  });
  requireOk(
    await client.value("updateExtension", {
      ...client.scope,
      identity,
      fixtureId: replacement.fixtureId,
      idempotencyKey: newKey("ext-007-valid-update"),
    }),
  );
  requireOk(
    await client.value("disableExtension", {
      ...client.scope,
      identity,
      idempotencyKey: newKey("ext-007-valid-disable"),
    }),
  );
  requireOk(
    await client.value("enableExtension", {
      ...client.scope,
      identity,
      idempotencyKey: newKey("ext-007-valid-enable"),
    }),
  );
  requireOk(await client.value("listExtensions", client.scope));

  const unused = await materializeEcho(client);
  const beforeInvalid = requireOk(await client.value("listExtensions", client.scope));
  type ExtensionOperationScope = RuntimeAcceptanceScope & {
    readonly abort?: RuntimeAcceptanceAbort;
  };
  const operations = {
    list: (scope: ExtensionOperationScope) => client.value("listExtensions", scope),
    install: (scope: ExtensionOperationScope) =>
      client.value("installExtension", {
        ...scope,
        fixtureId: unused.fixtureId,
        idempotencyKey: newKey("ext-007-invalid-install"),
      }),
    update: (scope: ExtensionOperationScope) =>
      client.value("updateExtension", {
        ...scope,
        identity,
        fixtureId: replacement.fixtureId,
        idempotencyKey: newKey("ext-007-invalid-update"),
      }),
    enable: (scope: ExtensionOperationScope) =>
      client.value("enableExtension", {
        ...scope,
        identity,
        idempotencyKey: newKey("ext-007-invalid-enable"),
      }),
    disable: (scope: ExtensionOperationScope) =>
      client.value("disableExtension", {
        ...scope,
        identity,
        idempotencyKey: newKey("ext-007-invalid-disable"),
      }),
    remove: (scope: ExtensionOperationScope) =>
      client.value("removeExtension", {
        ...scope,
        identity,
        idempotencyKey: newKey("ext-007-invalid-remove"),
      }),
  };
  const scopeMatrix: Record<
    string,
    {
      readonly wrong: ReturnType<typeof apiEnvelope>;
      readonly missing: ReturnType<typeof apiEnvelope>;
      readonly aborted: ReturnType<typeof apiEnvelope>;
    }
  > = {};
  for (const [operation, invoke] of Object.entries(operations)) {
    const wrong = apiEnvelope(
      await invoke({
        sessionId: client.scope.sessionId,
        workspaceName: `not-a-real-workspace-${randomUUID()}`,
      }),
    );
    const missing = apiEnvelope(
      await invoke({ sessionId: "", workspaceName: client.scope.workspaceName }),
    );
    const aborted = apiEnvelope(await invoke({ ...client.scope, abort: { timing: "pre" } }));
    assert.equal(wrong.ok, false, `${operation} must fail for a mismatched scope`);
    assert.equal(missing.ok, false, `${operation} must fail for a missing scope`);
    assert.equal(aborted.errorCode, "aborted", `${operation} must honor pre-abort`);
    scopeMatrix[operation] = { wrong, missing, aborted };
  }

  const permissions = [
    "marshal.extension.list",
    "marshal.extension.install",
    "marshal.extension.update",
    "marshal.extension.enable",
    "marshal.extension.disable",
    "marshal.extension.remove",
  ];
  const overrideAttempts = await Promise.all(
    permissions.map((permission) =>
      client.acceptance("setAcceptancePermission", permission, "deny"),
    ),
  );
  assert.equal(
    overrideAttempts.every((attempt) => !attempt.success),
    true,
    "fixed extension permissions cannot be overridden",
  );
  const afterInvalid = requireOk(await client.value("listExtensions", client.scope));
  assert.deepEqual(afterInvalid.value, beforeInvalid.value);
  const audit = await client.value("getAuthorityAudit");
  const authorityMapping = Object.fromEntries(
    permissions.map((permission) => {
      const decisions = audit.filter((entry) => entry.capability === permission);
      assert.equal(
        decisions.some((entry) => entry.decision === "allow"),
        true,
      );
      return [permission, decisions];
    }),
  );
  const removed = await removeIdentity(state, identity);
  assert.equal(removed.ok, true);

  return {
    proof: {
      identity,
      scopeMatrix,
      authorityMapping,
      overrideAttempts,
      inventoryUnchanged: true,
      removed,
    },
  };
}

const EXT_NEGATIVE_MUTATIONS = [
  "invalid-integrity-descriptor",
  "source-unavailable",
  "wrong-digest",
  "post-hash-mutation",
  "manifest-identity",
  "manifest-version",
  "manifest-extra-key",
  "manifest-missing-key",
  "manifest-missing-entrypoint",
  "manifest-unsupported-format",
  "manifest-invalid-utf8",
  "manifest-oversized",
  "unsafe-entrypoint",
  "reserved-entrypoint",
  "non-cjs-entrypoint",
  "package-type-mismatch",
  "package-main-mismatch",
  "unsupported-import",
  "module-load-throw",
  "missing-activate",
  "case-colliding-paths",
  "trailing-dot-path",
  "tree-escape",
] as const;

async function scenarioExt008(state: MutableScenarioState): Promise<LiveStoryProof> {
  const { client } = state;
  const perMutation: Record<string, { readonly ok: boolean; readonly errorCode: string | null }> =
    {};

  for (const mutation of EXT_NEGATIVE_MUTATIONS) {
    const fixture = await materializeEcho(client);
    const mutated = await client.value("mutateExtensionFixture", {
      fixtureId: fixture.fixtureId,
      mutation,
    });
    assert.equal(mutated.fixtureId, fixture.fixtureId);
    const attempt = apiEnvelope(
      await client.value("installExtension", {
        ...client.scope,
        fixtureId: fixture.fixtureId,
        idempotencyKey: newKey(`ext-008-${mutation}`),
      }),
    );
    assert.equal(attempt.ok, false, `mutation must be rejected before commit: ${mutation}`);
    assert.equal(
      isRejectedBeforeCommit(attempt.errorCode),
      true,
      `mutation must normalize to invalid-request or operation-failed: ${mutation} (got ${attempt.errorCode})`,
    );
    const list = requireOk(await client.value("listExtensions", client.scope));
    assert.equal(
      array(list.value).some((extension) => record(extension).identity === fixture.identity),
      false,
      `a rejected install must leave no registration: ${mutation}`,
    );
    perMutation[mutation] = { ok: attempt.ok, errorCode: attempt.errorCode };
  }

  const oversizedResults: Record<
    string,
    { readonly ok: boolean; readonly errorCode: string | null }
  > = {};
  const fileCountFixture = await client.value("materializeExtensionFixture", {
    profile: "file-count-limit",
    version: "1.0.0",
    fileCount: 2_049,
  });
  const fileSizeFixture = await client.value("materializeExtensionFixture", {
    profile: "file-size-limit",
    version: "1.0.0",
    fileSizeBytes: 33 * 1024 * 1024,
  });
  const treeSizeFixture = await client.value("materializeExtensionFixture", {
    profile: "tree-size-limit",
    version: "1.0.0",
    treeSizeBytes: 129 * 1024 * 1024,
  });
  for (const [profile, fixture] of [
    ["file-count-limit", fileCountFixture],
    ["file-size-limit", fileSizeFixture],
    ["tree-size-limit", treeSizeFixture],
  ] as const) {
    const attempt = apiEnvelope(
      await client.value("installExtension", {
        ...client.scope,
        fixtureId: fixture.fixtureId,
        idempotencyKey: newKey(`ext-008-${profile}`),
      }),
    );
    assert.equal(attempt.ok, false, `oversized package must be rejected: ${profile}`);
    assert.equal(isRejectedBeforeCommit(attempt.errorCode), true);
    oversizedResults[profile] = { ok: attempt.ok, errorCode: attempt.errorCode };
  }
  const counts = await client.value("getInvocationCounts");
  for (const fixtureEvent of Object.values(counts.fixtureEvents)) {
    assert.equal(
      fixtureEvent.includes("activate-complete"),
      false,
      "invalid packages must never complete activation",
    );
  }

  return {
    proof: { perMutation, oversizedResults, counts },
    supportingEvidence: [
      "The supporting loader contract records the exact upstream code for the complete loader " +
        "set, including INVALID_LOADER_ROOT and INVALID_REQUEST, while these live calls prove " +
        "the product API normalization and zero committed activation.",
    ],
  };
}

async function scenarioExt009(state: MutableScenarioState): Promise<LiveStoryProof> {
  const { client } = state;
  const results: Record<string, { readonly ok: boolean; readonly errorCode: string | null }> = {};
  const bridgeInfo = await client.value("getBridgeInfo");
  const networkBefore = captureTcpConnections(bridgeInfo.mainProcessPid);

  for (const mutation of [
    "symlink-entrypoint",
    "symlink-root",
    "unsupported-import",
    "post-hash-mutation",
  ] as const) {
    const fixture = await materializeEcho(client);
    await client.value("mutateExtensionFixture", { fixtureId: fixture.fixtureId, mutation });
    const attempt = apiEnvelope(
      await client.value("installExtension", {
        ...client.scope,
        fixtureId: fixture.fixtureId,
        idempotencyKey: newKey(`ext-009-${mutation}`),
      }),
    );
    assert.equal(attempt.ok, false, `must be rejected: ${mutation}`);
    assert.equal(isRejectedBeforeCommit(attempt.errorCode), true);
    results[mutation] = { ok: attempt.ok, errorCode: attempt.errorCode };
  }
  const outside = await client.value("materializeExtensionFixture", {
    profile: "echo",
    version: "1.0.0",
    location: "outside-root",
  });
  const outsideAttempt = apiEnvelope(
    await client.value("installExtension", {
      ...client.scope,
      fixtureId: outside.fixtureId,
      idempotencyKey: newKey("ext-009-outside-root"),
    }),
  );
  assert.equal(outsideAttempt.ok, false);
  assert.equal(isRejectedBeforeCommit(outsideAttempt.errorCode), true);
  const networkAfter = captureTcpConnections(bridgeInfo.mainProcessPid);
  assert.deepEqual(
    networkAfter,
    networkBefore,
    "extension package loading must not create a network connection",
  );

  return {
    proof: { results, outsideAttempt, networkBefore, networkAfter },
    supportingEvidence: [
      "The loader supporting contract records ROOT_NOT_ALLOWED and UNSAFE_PACKAGE_TREE and " +
        "exercises stable file-identity checks; the live evidence records the product's normalized " +
        "results and the Electron main process TCP snapshot around the attempts.",
    ],
  };
}

async function scenarioExt010(state: MutableScenarioState): Promise<LiveStoryProof> {
  const { client } = state;

  const preAbortFixture = await materializeEcho(client);
  const preAbortInstall = apiEnvelope(
    await client.value("installExtension", {
      ...client.scope,
      fixtureId: preAbortFixture.fixtureId,
      idempotencyKey: newKey("ext-010-pre-abort"),
      abort: { timing: "pre" },
    }),
  );
  assert.equal(preAbortInstall.ok, false);
  assert.equal(preAbortInstall.errorCode, "aborted");
  const listAfterPreAbort = requireOk(await client.value("listExtensions", client.scope));
  assert.equal(
    array(listAfterPreAbort.value).some(
      (extension) => record(extension).identity === preAbortFixture.identity,
    ),
    false,
    "a pre-aborted install must leave no installed record",
  );

  const delayedFixture = await client.value("materializeExtensionFixture", {
    profile: "activation-delay",
    version: "1.0.0",
    activationDelayMs: 1_200,
  });
  const midActivationAbort = apiEnvelope(
    await client.value("installExtension", {
      ...client.scope,
      fixtureId: delayedFixture.fixtureId,
      idempotencyKey: newKey("ext-010-mid-activation"),
      abort: { timing: "after-ms", delayMs: 200 },
    }),
  );
  assert.equal(
    midActivationAbort.ok,
    false,
    "aborting during a slow activation must fail the install",
  );
  assert.equal(midActivationAbort.errorCode, "aborted");
  const listAfterMidAbort = requireOk(await client.value("listExtensions", client.scope));
  assert.equal(
    array(listAfterMidAbort.value).some(
      (extension) => record(extension).identity === delayedFixture.identity,
    ),
    false,
    "an install aborted during activation must leave no registration",
  );
  const beforeCommitFixture = await materializeEcho(client);
  const beforeCommitAbort = apiEnvelope(
    await client.value("installExtension", {
      ...client.scope,
      fixtureId: beforeCommitFixture.fixtureId,
      idempotencyKey: newKey("ext-010-before-commit"),
      abort: { timing: "fixture-event", event: "activate:complete" },
    }),
  );
  assert.equal(beforeCommitAbort.errorCode, "aborted");
  const listAfterBeforeCommitAbort = requireOk(await client.value("listExtensions", client.scope));
  assert.equal(
    array(listAfterBeforeCommitAbort.value).some(
      (extension) => record(extension).identity === beforeCommitFixture.identity,
    ),
    false,
  );

  const sharedFixture = await materializeEcho(client);
  const sharedKey = newKey("ext-010-shared");
  const [first, second] = await Promise.all([
    client.value("installExtension", {
      ...client.scope,
      fixtureId: sharedFixture.fixtureId,
      idempotencyKey: sharedKey,
    }),
    client.value("installExtension", {
      ...client.scope,
      fixtureId: sharedFixture.fixtureId,
      idempotencyKey: sharedKey,
    }),
  ]);
  const firstOk = requireOk(first);
  const secondOk = requireOk(second);
  assert.deepEqual(record(firstOk.value), record(secondOk.value));
  state.installedIdentities.set(String(record(firstOk.value).identity), sharedFixture.packageRoot);
  const listAfterShared = requireOk(await client.value("listExtensions", client.scope));
  assert.equal(
    array(listAfterShared.value).filter(
      (extension) => record(extension).identity === sharedFixture.identity,
    ).length,
    1,
    "identical concurrent install requests must produce exactly one installed record",
  );
  const sharedIdentity = String(record(firstOk.value).identity);
  const replacement = await client.value("materializeExtensionFixture", {
    profile: "echo",
    version: "2.0.0",
    identityFixtureId: sharedFixture.fixtureId,
  });
  const updateKey = newKey("ext-010-shared-update");
  const [firstUpdate, secondUpdate] = await Promise.all([
    client.value("updateExtension", {
      ...client.scope,
      identity: sharedIdentity,
      fixtureId: replacement.fixtureId,
      idempotencyKey: updateKey,
    }),
    client.value("updateExtension", {
      ...client.scope,
      identity: sharedIdentity,
      fixtureId: replacement.fixtureId,
      idempotencyKey: updateKey,
    }),
  ]);
  assert.deepEqual(record(requireOk(firstUpdate).value), record(requireOk(secondUpdate).value));
  const disableKey = newKey("ext-010-shared-disable");
  const [firstDisable, secondDisable] = await Promise.all([
    client.value("disableExtension", {
      ...client.scope,
      identity: sharedIdentity,
      idempotencyKey: disableKey,
    }),
    client.value("disableExtension", {
      ...client.scope,
      identity: sharedIdentity,
      idempotencyKey: disableKey,
    }),
  ]);
  assert.deepEqual(record(requireOk(firstDisable).value), record(requireOk(secondDisable).value));
  const enableKey = newKey("ext-010-shared-enable");
  const [firstEnable, secondEnable] = await Promise.all([
    client.value("enableExtension", {
      ...client.scope,
      identity: sharedIdentity,
      idempotencyKey: enableKey,
    }),
    client.value("enableExtension", {
      ...client.scope,
      identity: sharedIdentity,
      idempotencyKey: enableKey,
    }),
  ]);
  assert.deepEqual(record(requireOk(firstEnable).value), record(requireOk(secondEnable).value));

  const conflictingFixture = await materializeEcho(client);
  const conflict = apiEnvelope(
    await client.value("installExtension", {
      ...client.scope,
      fixtureId: conflictingFixture.fixtureId,
      idempotencyKey: sharedKey,
    }),
  );
  assert.equal(conflict.ok, false);
  assert.equal(
    conflict.errorCode,
    "idempotency-conflict",
    "reusing a settled key with a different payload must conflict",
  );

  const retryFixture = await materializeEcho(client);
  const retryKey = newKey("ext-010-retry");
  const firstAttempt = apiEnvelope(
    await client.value("installExtension", {
      ...client.scope,
      fixtureId: retryFixture.fixtureId,
      idempotencyKey: retryKey,
      abort: { timing: "pre" },
    }),
  );
  assert.equal(firstAttempt.ok, false);
  const retryAttempt = apiEnvelope(
    await client.value("installExtension", {
      ...client.scope,
      fixtureId: retryFixture.fixtureId,
      idempotencyKey: retryKey,
    }),
  );
  assert.equal(
    retryAttempt.ok,
    true,
    "a failed idempotency entry must not poison a later retry of the same key",
  );
  if (typeof retryAttempt.value.identity === "string") {
    state.installedIdentities.set(retryAttempt.value.identity, retryFixture.packageRoot);
  }
  const counts = await client.value("getInvocationCounts");
  assert.equal(
    counts.fixtureEvents[`fixture:${beforeCommitFixture.fixtureId}`].includes("dispose"),
    true,
    "the staged activation must be disposed when cancellation arrives before commit",
  );

  return {
    proof: {
      preAbortInstall,
      midActivationAbort,
      beforeCommitAbort,
      sharedInstallEqual: true,
      sharedUpdateEqual: true,
      sharedStateEqual: true,
      conflict,
      firstAttempt,
      retryAttempt,
      counts,
    },
  };
}

async function scenarioExt011(state: MutableScenarioState): Promise<LiveStoryProof> {
  const { client } = state;
  const fixture = await materializeEcho(client);
  const install1 = requireOk(
    await client.value("installExtension", {
      ...client.scope,
      fixtureId: fixture.fixtureId,
      idempotencyKey: newKey("ext-011-install-1"),
    }),
  );
  const identity = String(record(install1.value).identity);
  state.installedIdentities.set(identity, fixture.packageRoot);

  const duplicateInstall = apiEnvelope(
    await client.value("installExtension", {
      ...client.scope,
      fixtureId: fixture.fixtureId,
      idempotencyKey: newKey("ext-011-install-2"),
    }),
  );
  assert.equal(duplicateInstall.ok, false, "installing the same fixture identity twice must fail");
  assert.equal(
    duplicateInstall.errorCode,
    "invalid-request",
    "ALREADY_INSTALLED normalizes to invalid-request",
  );

  const unknownIdentity = `acceptance.unknown-${randomUUID()}`;
  const unknownUpdate = apiEnvelope(
    await client.value("updateExtension", {
      ...client.scope,
      identity: unknownIdentity,
      fixtureId: fixture.fixtureId,
      idempotencyKey: newKey("ext-011-unknown-update"),
    }),
  );
  const unknownDisable = apiEnvelope(
    await client.value("disableExtension", {
      ...client.scope,
      identity: unknownIdentity,
      idempotencyKey: newKey("ext-011-unknown-disable"),
    }),
  );
  const unknownEnable = apiEnvelope(
    await client.value("enableExtension", {
      ...client.scope,
      identity: unknownIdentity,
      idempotencyKey: newKey("ext-011-unknown-enable"),
    }),
  );
  const unknownRemove = apiEnvelope(
    await client.value("removeExtension", {
      ...client.scope,
      identity: unknownIdentity,
      idempotencyKey: newKey("ext-011-unknown-remove"),
    }),
  );
  for (const [label, result] of Object.entries({
    update: unknownUpdate,
    disable: unknownDisable,
    enable: unknownEnable,
    remove: unknownRemove,
  })) {
    assert.equal(result.ok, false, `unknown identity ${label} must fail`);
    assert.equal(
      result.errorCode,
      "not-found",
      `NOT_INSTALLED must normalize to not-found for ${label}`,
    );
  }

  const disabled = requireOk(
    await client.value("disableExtension", {
      ...client.scope,
      identity,
      idempotencyKey: newKey("ext-011-disable"),
    }),
  );
  assert.equal(record(disabled.value).status, "disabled");
  const version2 = await client.value("materializeExtensionFixture", {
    profile: "echo",
    version: "2.0.0",
    identityFixtureId: fixture.fixtureId,
  });
  const updatedWhileDisabled = requireOk(
    await client.value("updateExtension", {
      ...client.scope,
      identity,
      fixtureId: version2.fixtureId,
      idempotencyKey: newKey("ext-011-update-disabled"),
    }),
  );
  assert.equal(
    record(updatedWhileDisabled.value).status,
    "disabled",
    "updating a disabled extension must not implicitly activate it",
  );
  assert.equal(record(updatedWhileDisabled.value).version, "2.0.0");
  const countsBeforeEnable = await client.value("getInvocationCounts");
  assert.equal(
    countsBeforeEnable.fixtureEvents[`fixture:${version2.fixtureId}`]?.includes(
      "activate:complete",
    ) ?? false,
    false,
  );
  const enabledAfterUpdate = requireOk(
    await client.value("enableExtension", {
      ...client.scope,
      identity,
      idempotencyKey: newKey("ext-011-enable-after-update"),
    }),
  );
  assert.equal(record(enabledAfterUpdate.value).status, "enabled");
  assert.equal(record(enabledAfterUpdate.value).version, "2.0.0");
  const version2Invoke = requireOk(
    await client.invoke(
      version2.capabilityNames[0],
      { probe: "ext-011-version-2" },
      newKey("ext-011-version-2"),
    ),
  );
  assert.equal(record(version2Invoke.value.output).version, "2.0.0");

  const second = await materializeEcho(client);
  const third = await materializeEcho(client);
  for (const extra of [second, third].sort((left, right) =>
    right.identity.localeCompare(left.identity),
  )) {
    const installed = requireOk(
      await client.value("installExtension", {
        ...client.scope,
        fixtureId: extra.fixtureId,
        idempotencyKey: newKey("ext-011-install-extra"),
      }),
    );
    state.installedIdentities.set(String(record(installed.value).identity), extra.packageRoot);
  }
  const list = requireOk(await client.value("listExtensions", client.scope));
  const identities = array(list.value).map((extension) => String(record(extension).identity));
  const sorted = [...identities].sort((left, right) => left.localeCompare(right));
  assert.deepEqual(identities, sorted, "the extension list must be sorted by identity");
  const installedRecords = array(list.value).filter((extension) =>
    state.installedIdentities.has(String(record(extension).identity)),
  );
  for (const extension of installedRecords) {
    const entry = record(extension);
    assert.equal(entry.status, "enabled");
    assert.match(String(entry.version), /^\d+\.\d+\.\d+$/);
    assert.match(String(record(entry.integrity).value), /^[0-9a-f]{64}$/);
  }
  const counts = await client.value("getInvocationCounts");

  return {
    proof: {
      duplicateInstall,
      unknownMutations: { unknownUpdate, unknownDisable, unknownEnable, unknownRemove },
      remainsInactiveAfterUpdate: record(updatedWhileDisabled.value).status === "disabled",
      enabledAfterUpdate: record(enabledAfterUpdate.value),
      version2Invoke,
      sortedRecords: installedRecords,
      counts,
    },
  };
}

async function scenarioExt012(state: MutableScenarioState): Promise<LiveStoryProof> {
  const { client } = state;
  const fixture = await client.value("materializeExtensionFixture", {
    profile: "disposal-failure",
    version: "1.0.0",
  });
  const installed = requireOk(
    await client.value("installExtension", {
      ...client.scope,
      fixtureId: fixture.fixtureId,
      idempotencyKey: newKey("ext-012-install"),
    }),
  );
  const identity = String(record(installed.value).identity);
  state.installedIdentities.set(identity, fixture.packageRoot);

  const removeResult = await client.value("removeExtension", {
    ...client.scope,
    identity,
    idempotencyKey: newKey("ext-012-remove"),
  });
  const removeEnvelope = apiEnvelope(removeResult);
  state.installedIdentities.delete(identity);

  const list = requireOk(await client.value("listExtensions", client.scope));
  assert.equal(
    array(list.value).some((extension) => record(extension).identity === identity),
    false,
    "remove must delete the record even when the extension's own disposer throws",
  );
  const searchAfter = requireOk(await client.search({ name: fixture.capabilityNames[0] }));
  assert.equal(
    array(searchAfter.matches).some(
      (match) => record(record(match).capability).name === fixture.capabilityNames[0],
    ),
    false,
    "remove must revoke the extension's registrations even when disposal fails",
  );
  const counts = await client.value("getInvocationCounts");
  const events = counts.fixtureEvents[`fixture:${fixture.fixtureId}`] ?? [];
  assert.equal(events.includes("dispose"), true, "the disposer must still have been invoked");

  return {
    proof: {
      identity,
      removeReportedOk: removeEnvelope.ok,
      removeErrorCode: removeEnvelope.errorCode,
      recordDeletedDespiteDisposalFailure: true,
      registrationsRevokedDespiteDisposalFailure: true,
      disposerInvoked: true,
    },
    supportingEvidence: [
      "Disposing the whole RuntimeExtensionManager with multiple simultaneously-failing " +
        "extensions and confirming MANAGER_DISPOSED on every later mutation requires either " +
        "process shutdown or a direct (non-Electron) manager instance, both out of this " +
        "single-process bridge's reach; the spec marks that aggregate/post-dispose contract " +
        "NODE-INTEGRATION-primary for exactly this reason.",
    ],
  };
}

async function scenarioExt013(state: MutableScenarioState): Promise<LiveStoryProof> {
  const { client } = state;
  const fixture = await client.value("materializeExtensionFixture", {
    profile: "ui-application",
    version: "1.0.0",
  });
  assert.equal(fixture.integrity.algorithm, "sha256");
  assert.equal(fixture.integrity.domain, "marshal-runtime-extension-package-v1");
  assert.match(
    fixture.integrity.value,
    /^[0-9a-f]{64}$/,
    "integrity value must be 64 lowercase hex characters",
  );
  const recomputed1 = computeRuntimeExtensionIntegrity(fixture.packageRoot);
  const recomputed2 = computeRuntimeExtensionIntegrity(fixture.packageRoot);
  assert.deepEqual(recomputed1, recomputed2);
  assert.equal(
    recomputed1.value,
    fixture.integrity.value,
    "independently recomputed integrity must match byte-for-byte",
  );
  assert.equal(recomputed1.algorithm, "sha256");
  assert.equal(recomputed1.domain, "marshal-runtime-extension-package-v1");
  const manifest = record(
    JSON.parse(
      fs.readFileSync(path.join(fixture.packageRoot, "runtime-extension.json"), "utf8"),
    ) as unknown,
  );
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.moduleFormat, "commonjs-bundle-v1");

  const installed = requireOk(
    await client.value("installExtension", {
      ...client.scope,
      fixtureId: fixture.fixtureId,
      idempotencyKey: newKey("ext-013-install-1"),
    }),
  );
  const identity = String(record(installed.value).identity);
  state.installedIdentities.set(identity, fixture.packageRoot);
  const inventory1 = await client.value("getRegistrationInventory");
  const catalogId1 = fixture.catalogIds[0];
  const applicationId = fixture.uiApplicationIds[0];
  assert.ok(catalogId1 && applicationId);
  const resourceCatalogEntry1 = (inventory1.search.discoveries ?? [])
    .map((discovery) => record(record(discovery).entry))
    .find(
      (entry) =>
        record(entry.action).type === "resource_read" &&
        record(entry.action).uri === fixture.resourceUris[0],
    );
  const uiCatalogEntry1 = (inventory1.search.discoveries ?? [])
    .map((discovery) => record(record(discovery).entry))
    .find(
      (entry) =>
        entry.kind === "ui_application" &&
        record(entry.metadata).extensionApplicationId === applicationId,
    );
  assert.ok(resourceCatalogEntry1, "the installed resource must generate a catalog entry");
  assert.ok(uiCatalogEntry1, "the installed UI application must generate a catalog entry");
  assert.match(
    String(uiCatalogEntry1.id),
    new RegExp(`^ui://runtime-extension/[a-z0-9-]+/${escapeRegExp(applicationId)}$`),
  );

  await removeIdentity(state, identity);
  const reinstalled = requireOk(
    await client.value("installExtension", {
      ...client.scope,
      fixtureId: fixture.fixtureId,
      idempotencyKey: newKey("ext-013-install-2"),
    }),
  );
  assert.equal(
    record(reinstalled.value).identity,
    identity,
    "reinstalling the same package must reuse the same identity",
  );
  state.installedIdentities.set(identity, fixture.packageRoot);
  const inventory2 = await client.value("getRegistrationInventory");
  assert.deepEqual(
    inventory2.extensions.filter((extension) => extension.identity === identity),
    inventory1.extensions.filter((extension) => extension.identity === identity),
    "the extension record must be identical across reinstall",
  );
  const resourceCatalogEntry2 = (inventory2.search.discoveries ?? [])
    .map((discovery) => record(record(discovery).entry))
    .find(
      (entry) =>
        record(entry.action).type === "resource_read" &&
        record(entry.action).uri === fixture.resourceUris[0],
    );
  const uiCatalogEntry2 = (inventory2.search.discoveries ?? [])
    .map((discovery) => record(record(discovery).entry))
    .find(
      (entry) =>
        entry.kind === "ui_application" &&
        record(entry.metadata).extensionApplicationId === applicationId,
    );
  assert.deepEqual(resourceCatalogEntry2, resourceCatalogEntry1);
  assert.deepEqual(uiCatalogEntry2, uiCatalogEntry1);
  const catalogMatches1 = inventory1.search.matches.filter(
    (match) => record(record(match).capability).name === fixture.capabilityNames[0],
  );
  const catalogMatches2 = inventory2.search.matches.filter(
    (match) => record(record(match).capability).name === fixture.capabilityNames[0],
  );
  assert.deepEqual(catalogMatches2, catalogMatches1);

  const duplicateResourceFixture = await client.value("materializeExtensionFixture", {
    profile: "duplicate-resource",
    version: "1.0.0",
  });
  const duplicateInstall = apiEnvelope(
    await client.value("installExtension", {
      ...client.scope,
      fixtureId: duplicateResourceFixture.fixtureId,
      idempotencyKey: newKey("ext-013-duplicate-resource"),
    }),
  );
  assert.equal(
    duplicateInstall.ok,
    false,
    "a package that declares a duplicate resource URI must be rejected",
  );
  assert.equal(isRejectedBeforeCommit(duplicateInstall.errorCode), true);

  return {
    proof: {
      integrity: fixture.integrity,
      independentlyComputed: [recomputed1, recomputed2],
      processIds: {
        electronMain: (await client.value("getBridgeInfo")).mainProcessPid,
        playwright: process.pid,
      },
      manifest,
      catalogId: catalogId1,
      generatedCatalogEntries: {
        resource: resourceCatalogEntry1,
        uiApplication: uiCatalogEntry1,
      },
      stableAcrossReinstall: true,
      duplicateResourceRejected: duplicateInstall,
    },
    supportingEvidence: [
      "The package-level supporting contract records DUPLICATE_RESOURCE for aggregate resource " +
        "list and read paths in addition to the validation-time live rejection above.",
    ],
  };
}

// ---------------------------------------------------------------------------
// 4.7 — Agent-facing runtime self-tools, API validation, and authority
// ---------------------------------------------------------------------------

async function scenarioApi001(state: MutableScenarioState): Promise<LiveStoryProof> {
  const { client } = state;
  const selfTools = await client.value("listRegisteredSelfTools");
  assert.deepEqual(
    selfTools.map((tool) => tool.name),
    [...RUNTIME_SELF_TOOL_NAMES],
  );
  assert.equal(
    selfTools.every((tool) => record(tool.parameters).additionalProperties === false),
    true,
    "all runtime self-tool schemas must be closed",
  );
  for (const name of ["runtimeInstallExtension", "runtimeUpdateExtension"]) {
    const descriptor = selfTools.find((tool) => tool.name === name);
    assert.equal(
      record(record(record(descriptor?.parameters).properties).integritySha256).pattern,
      "^[0-9a-f]{64}$",
      `${name} must require exactly 64 lowercase hex integrity characters`,
    );
  }

  const invocationResults: Record<string, unknown> = {};
  const call = async (name: string, args: unknown): Promise<Record<string, unknown>> => {
    const raw = await client.value("invokeRegisteredSelfTool", {
      name,
      sessionId: client.scope.sessionId,
      toolCallId: `acceptance-api-001-${name}-${randomUUID()}`,
      arguments: args,
    });
    return record(JSON.parse(raw) as unknown);
  };

  invocationResults.runtimeSearch = await call("runtimeSearch", { query: "code" });
  await grant(client, "code.read", "allow");
  invocationResults.runtimeInvoke = await call("runtimeInvoke", {
    capability: "code.index.status",
    idempotencyKey: newKey("api-001-invoke"),
  });
  invocationResults.runtimeExecuteTypeScript = await call("runtimeExecuteTypeScript", {
    acceptanceProfile: "search-capability",
    input: { query: "code" },
    idempotencyKey: newKey("api-001-ts"),
  });
  const acceptancePaths = record(await client.value("getPaths"));
  const workspaceRoot = String(acceptancePaths.workspaceRoot);
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceRoot, "self-tool-module.ts"),
    "export default async (input) => ({ source: 'runtimeExecuteModule', input });\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(workspaceRoot, "self-tool-render.tsx"),
    "export default function AcceptanceRender({ label = 'Ready' }) { return <main>{label}</main>; }\n",
    "utf8",
  );
  invocationResults.runtimeExecuteModule = await call("runtimeExecuteModule", {
    module: { kind: "workspace_file", path: "self-tool-module.ts" },
    input: { source: "acceptance" },
    idempotencyKey: newKey("api-001-module"),
  });
  const compiled = await call("runtimeInvoke", {
    capability: "ui.compile",
    input: { entryPath: "self-tool-render.tsx", title: "Runtime self-tool acceptance" },
    idempotencyKey: newKey("api-001-render-compile"),
  });
  const component = record(record(record(compiled.value).output).component);
  const rendered = await call("runtimeInvoke", {
    capability: "ui.render",
    input: {
      componentId: String(component.id),
      props: { label: "Rendered through runtime self-tools" },
      fallback: { summary: "Rendered through runtime self-tools" },
    },
    idempotencyKey: newKey("api-001-render"),
  });
  const render = record(record(record(rendered.value).output).render);
  invocationResults.runtimeListRenderTools = await call("runtimeListRenderTools", {});
  invocationResults.runtimeInvokeRenderTool = await call("runtimeInvokeRenderTool", {
    name: "marshal_get_react_payload",
    input: { renderId: String(render.id) },
    idempotencyKey: newKey("api-001-render-tool"),
  });
  invocationResults.runtimeListExtensions = await call("runtimeListExtensions", {});

  const fixture = await materializeEcho(client);
  invocationResults.runtimeInstallExtension = await call("runtimeInstallExtension", {
    fixtureId: fixture.fixtureId,
    idempotencyKey: newKey("api-001-install"),
  });
  const installedRecord = record(record(invocationResults.runtimeInstallExtension).value);
  const identity = String(installedRecord.identity);
  state.installedIdentities.set(identity, fixture.packageRoot);

  invocationResults.runtimeUpdateExtension = await call("runtimeUpdateExtension", {
    identity,
    fixtureId: fixture.fixtureId,
    idempotencyKey: newKey("api-001-update"),
  });
  invocationResults.runtimeDisableExtension = await call("runtimeDisableExtension", {
    identity,
    idempotencyKey: newKey("api-001-disable"),
  });
  invocationResults.runtimeEnableExtension = await call("runtimeEnableExtension", {
    identity,
    idempotencyKey: newKey("api-001-enable"),
  });
  invocationResults.runtimeRemoveExtension = await call("runtimeRemoveExtension", {
    identity,
    idempotencyKey: newKey("api-001-remove"),
  });
  state.installedIdentities.delete(identity);

  for (const [name, result] of Object.entries(invocationResults)) {
    assert.equal(
      record(result).ok,
      true,
      `runtime self-tool must succeed under a valid request: ${name}`,
    );
  }

  const catalogSearch = requireOk(
    await client.search({
      query: "",
      tags: ["marshal", "host", "tool"],
      detail: "full",
      limit: 200,
    }),
  );
  const catalogNames = array(catalogSearch.matches).map(
    (match) => record(record(match).capability).name,
  );
  for (const selfToolName of RUNTIME_SELF_TOOL_NAMES) {
    assert.equal(
      catalogNames.includes(`marshal.tool.${selfToolName}`),
      false,
      `the runtime self-tools must be excluded from the ordinary tool catalog to prevent recursion: ${selfToolName}`,
    );
  }

  const startupFailure = state.runRuntimeStartupFailure
    ? await state.runRuntimeStartupFailure()
    : null;
  if (startupFailure) {
    assert.equal(startupFailure.lifecycle, "failed");
    assert.equal(
      startupFailure.selfTools.map((tool) => tool.name).join(","),
      RUNTIME_SELF_TOOL_NAMES.join(","),
      "startup failure must preserve the exact registered runtime self-tools",
    );
    assert.equal(
      Object.values(startupFailure.runtimeResults).every(
        (result) =>
          record(result).ok === false &&
          record(record(result).error).code === "runtime-unavailable",
      ),
      true,
      "all registered runtime self-tools must return runtime-unavailable after startup failure",
    );
    assert.equal(
      startupFailure.ordinarySelfTools.length > 0,
      true,
      "ordinary production self-tools must remain registered after runtime startup failure",
    );
  }

  return {
    proof: {
      selfToolNames: selfTools.map((tool) => tool.name),
      selfToolObjectIds: Object.fromEntries(selfTools.map((tool) => [tool.name, tool.objectId])),
      schemasClosed: true,
      integrityPatternsClosed: true,
      invocationsOk: Object.fromEntries(
        Object.entries(invocationResults).map(([name, result]) => [name, record(result).ok]),
      ),
      excludedFromCatalog: true,
      startupFailure,
    },
    supportingEvidence: startupFailure ? [] : ["MRT-BOOT-003", "MRT-BOOT-004"],
  };
}

async function scenarioApi002(state: MutableScenarioState): Promise<LiveStoryProof> {
  const { client } = state;
  await grant(client, "code.read", "allow");

  const invalidCountsBefore = await client.value("getInvocationCounts");
  const requiredStringCases: Record<string, ReturnType<typeof apiEnvelope>> = {};
  const invokeRequest = (overrides: Readonly<Record<string, unknown>>) =>
    client.value("invoke", {
      ...client.scope,
      capability: "code.index.status",
      idempotencyKey: newKey("api-002-default"),
      ...overrides,
    });
  for (const [label, value] of [
    ["session-empty", ""],
    ["session-whitespace", " \r\n\t "],
    ["session-over", "s".repeat(257)],
  ] as const) {
    requiredStringCases[label] = apiEnvelope(await invokeRequest({ sessionId: value }));
  }
  for (const [label, value] of [
    ["workspace-empty", ""],
    ["workspace-whitespace", " \r\n\t "],
    ["workspace-over", "w".repeat(257)],
  ] as const) {
    requiredStringCases[label] = apiEnvelope(await invokeRequest({ workspaceName: value }));
  }
  for (const [label, value] of [
    ["capability-empty", ""],
    ["capability-whitespace", " \r\n\t "],
    ["capability-over", "c".repeat(513)],
  ] as const) {
    requiredStringCases[label] = apiEnvelope(await invokeRequest({ capability: value }));
  }
  for (const [label, value] of [
    ["idempotency-empty", ""],
    ["idempotency-whitespace", " \r\n\t "],
    ["idempotency-over", "k".repeat(257)],
  ] as const) {
    requiredStringCases[label] = apiEnvelope(await invokeRequest({ idempotencyKey: value }));
  }
  for (const [label, value] of [
    ["identity-empty", ""],
    ["identity-whitespace", " \r\n\t "],
    ["identity-over", "x".repeat(215)],
  ] as const) {
    requiredStringCases[label] = apiEnvelope(
      await client.value("disableExtension", {
        ...client.scope,
        identity: value,
        idempotencyKey: newKey(`api-002-${label}`),
      }),
    );
  }
  const sourceCases = {
    empty: apiEnvelope(
      await client.value("executeTypeScript", {
        ...client.scope,
        profile: "source-empty",
        idempotencyKey: newKey("api-002-source-empty"),
      }),
    ),
    whitespace: apiEnvelope(
      await client.value("executeTypeScript", {
        ...client.scope,
        profile: "source-whitespace",
        idempotencyKey: newKey("api-002-source-whitespace"),
      }),
    ),
    over: apiEnvelope(
      await client.value("executeTypeScript", {
        ...client.scope,
        profile: "source-over-limit",
        idempotencyKey: newKey("api-002-source-over"),
      }),
    ),
  };
  const packageFixture = await materializeEcho(client);
  const packageRootCases: Readonly<Record<string, ApiEnvelopeSummary>> = Object.fromEntries(
    await Promise.all(
      (["empty", "whitespace", "over-limit"] as const).map(async (variant) => [
        variant,
        apiEnvelope(
          await client.value("installExtension", {
            ...client.scope,
            fixtureId: packageFixture.fixtureId,
            packageRootVariant: variant,
            idempotencyKey: newKey(`api-002-package-${variant}`),
          }),
        ),
      ]),
    ),
  );
  for (const [label, result] of Object.entries({
    ...requiredStringCases,
    ...sourceCases,
    ...packageRootCases,
  })) {
    assert.equal(result.ok, false, `${label} must be rejected`);
    assert.equal(result.errorCode, "invalid-request", `${label} must map to invalid-request`);
  }
  const invalidCountsAfter = await client.value("getInvocationCounts");
  assert.deepEqual(
    invalidCountsAfter.fixtureEvents,
    invalidCountsBefore.fixtureEvents,
    "invalid required-string inputs must not activate or invoke a fixture",
  );
  assert.deepEqual(
    invalidCountsAfter.ordinaryToolInvocations,
    invalidCountsBefore.ordinaryToolInvocations,
    "invalid required-string inputs must not invoke an ordinary tool",
  );

  const trimmed = apiEnvelope(
    await client.value("invoke", {
      sessionId: ` ${client.scope.sessionId} `,
      workspaceName: ` ${client.scope.workspaceName} `,
      capability: " code.index.status ",
      idempotencyKey: ` ${newKey("api-002-trimmed")} `,
    }),
  );
  assert.equal(trimmed.ok, true, "required strings must be trimmed before execution");
  const sourceAtLimit = apiEnvelope(
    await client.value("executeTypeScript", {
      ...client.scope,
      profile: "source-at-limit",
      idempotencyKey: newKey("api-002-source-at-limit"),
    }),
  );
  assert.equal(sourceAtLimit.errorCode === "invalid-request", false);

  const authorityBeforePackageBoundary = await client.value("getAuthorityAudit");
  const packageRootAtLimit = apiEnvelope(
    await client.value("installExtension", {
      ...client.scope,
      fixtureId: packageFixture.fixtureId,
      packageRootVariant: "at-limit",
      idempotencyKey: newKey("api-002-package-at-limit"),
    }),
  );
  const authorityAfterPackageBoundary = await client.value("getAuthorityAudit");
  assert.equal(
    authorityAfterPackageBoundary.length > authorityBeforePackageBoundary.length,
    true,
    "a 32,768-character package root must pass API normalization and reach authority",
  );

  const longQuery = "a".repeat(5_000);
  const truncatedSearch = requireOk(await client.search({ query: longQuery }));
  assert.equal(
    truncatedSearch.query.length,
    4_000,
    "an over-limit search query must be truncated to 4,000 characters, not rejected",
  );
  const builtInAllowed = requireOk(
    await client.invoke("marshal.session.context", {}, newKey("api-002-builtin")),
  );
  assert.equal(record(builtInAllowed.value.output).session !== null, true);

  await grant(client, "code.read", "prompt");
  const promptResult = apiEnvelope(
    await client.invoke("code.index.status", {}, newKey("api-002-prompt")),
  );
  assert.equal(promptResult.ok, false);
  assert.equal(
    promptResult.errorCode,
    "approval-required",
    "an unresolved (prompt) decision must surface as approval-required",
  );
  await grant(client, "code.read", "allow");

  await grant(client, "code.read", "deny");
  const deniedCodeIndex = apiEnvelope(
    await client.invoke("code.index.status", {}, newKey("api-002-code-index-deny")),
  );
  assert.equal(deniedCodeIndex.errorCode, "permission-denied");
  await grant(client, "code.read", "allow");

  const ordinaryTools = await client.value("listOrdinarySelfTools", client.scope.sessionId);
  const ordinaryTool = ordinaryTools.find((tool) => tool.name === "listWorkspaces");
  assert.ok(ordinaryTool, "the production listWorkspaces tool must be available");
  const ordinaryPermission = `${MARSHAL_RUNTIME_TOOL_PERMISSION_PREFIX}${ordinaryTool.name}`;
  const ordinaryBefore = await client.value("getInvocationCounts");
  await grant(client, ordinaryPermission, "allow");
  const customAllowed = apiEnvelope(
    await client.invoke(`marshal.tool.${ordinaryTool.name}`, {}, newKey("api-002-custom-allow")),
  );
  assert.equal(customAllowed.ok, true);
  const ordinaryAfterAllow = await client.value("getInvocationCounts");
  await grant(client, ordinaryPermission, "prompt");
  const customPrompt = apiEnvelope(
    await client.invoke(`marshal.tool.${ordinaryTool.name}`, {}, newKey("api-002-custom-prompt")),
  );
  await grant(client, ordinaryPermission, "deny");
  const customDeny = apiEnvelope(
    await client.invoke(`marshal.tool.${ordinaryTool.name}`, {}, newKey("api-002-custom-deny")),
  );
  const ordinaryAfterDenied = await client.value("getInvocationCounts");
  assert.equal(customPrompt.errorCode, "approval-required");
  assert.equal(customDeny.errorCode, "permission-denied");
  assert.equal(
    ordinaryAfterAllow.ordinaryToolInvocations[ordinaryTool.name]?.count,
    (ordinaryBefore.ordinaryToolInvocations[ordinaryTool.name]?.count ?? 0) + 1,
  );
  assert.deepEqual(
    ordinaryAfterDenied.ordinaryToolInvocations,
    ordinaryAfterAllow.ordinaryToolInvocations,
    "prompt and deny must not invoke the original ordinary tool object",
  );
  await grant(client, ordinaryPermission, "allow");

  const unknownPermissionFixture = await client.value("materializeExtensionFixture", {
    profile: "unknown-permission",
  });
  const unknownInstalled = requireOk(
    await client.value("installExtension", {
      ...client.scope,
      fixtureId: unknownPermissionFixture.fixtureId,
      idempotencyKey: newKey("api-002-unknown-install"),
    }),
  );
  state.installedIdentities.set(
    String(record(unknownInstalled.value).identity),
    unknownPermissionFixture.packageRoot,
  );
  const unknownBefore = await client.value("getInvocationCounts");
  const unknownPermission = apiEnvelope(
    await client.invoke(
      unknownPermissionFixture.capabilityNames[0],
      {},
      newKey("api-002-unknown-permission"),
    ),
  );
  const unknownAfter = await client.value("getInvocationCounts");
  assert.equal(unknownPermission.errorCode, "permission-denied");
  assert.deepEqual(
    unknownAfter.fixtureEvents,
    unknownBefore.fixtureEvents,
    "an unsupported permission must deny before provider invocation",
  );

  const mismatchedScope = apiEnvelope(
    await client.value("invoke", {
      sessionId: client.scope.sessionId,
      workspaceName: `not-a-real-workspace-${randomUUID()}`,
      capability: "code.index.status",
      idempotencyKey: newKey("api-002-mismatched-scope"),
    }),
  );
  assert.equal(mismatchedScope.ok, false);
  assert.equal(
    mismatchedScope.errorCode,
    "permission-denied",
    "an unresolved/mismatched scope must fail closed as permission-denied",
  );

  const preAbortBeforeScope = apiEnvelope(
    await client.invoke("code.index.status", {}, newKey("api-002-pre-abort"), {
      abort: { timing: "pre" },
    }),
  );
  assert.equal(preAbortBeforeScope.ok, false);
  assert.equal(preAbortBeforeScope.errorCode, "aborted");

  const delayedFixture = await client.value("materializeExtensionFixture", {
    profile: "invocation-delay",
    invocationDelayMs: 250,
  });
  const delayedInstalled = requireOk(
    await client.value("installExtension", {
      ...client.scope,
      fixtureId: delayedFixture.fixtureId,
      idempotencyKey: newKey("api-002-delayed-install"),
    }),
  );
  state.installedIdentities.set(
    String(record(delayedInstalled.value).identity),
    delayedFixture.packageRoot,
  );
  const abortAfterScope = apiEnvelope(
    await client.invoke(
      delayedFixture.capabilityNames[0],
      {},
      newKey("api-002-abort-after-scope"),
      {
        abort: { timing: "after-ms", delayMs: 1 },
      },
    ),
  );
  assert.equal(abortAfterScope.ok, false);
  assert.equal(abortAfterScope.errorCode, "aborted");

  const authorityAudit = await client.value("getAuthorityAudit");
  const builtinAllow = authorityAudit.find(
    (entry) =>
      entry.capability === "marshal.session.context" &&
      entry.permissions.includes(MARSHAL_RUNTIME_PERMISSION.sessionRead),
  );
  const customDecisions = authorityAudit.filter((entry) =>
    entry.permissions.includes(ordinaryPermission),
  );
  const unknownDecision = authorityAudit.find((entry) =>
    entry.permissions.includes("acceptance.unknown"),
  );
  assert.equal(
    customDecisions.some((entry) => entry.decision === "allow"),
    true,
  );
  assert.equal(
    customDecisions.some((entry) => entry.decision === "approval"),
    true,
  );
  assert.equal(
    customDecisions.some((entry) => entry.decision === "deny"),
    true,
  );
  assert.equal(unknownDecision?.decision, "deny");

  return {
    proof: {
      requiredStringCases,
      sourceCases,
      packageRootCases,
      trimmed,
      sourceAtLimit,
      packageRootAtLimit,
      truncatedSearchLength: truncatedSearch.query.length,
      promptResult,
      deniedCodeIndex,
      customAllowed,
      customPrompt,
      customDeny,
      unknownPermission,
      mismatchedScope,
      preAbortBeforeScope,
      abortAfterScope,
      authorityAudit,
      sideEffectInventories: {
        invalidCountsBefore,
        invalidCountsAfter,
        ordinaryBefore,
        ordinaryAfterAllow,
        ordinaryAfterDenied,
        unknownBefore,
        unknownAfter,
      },
      fixedBuiltInObserved: !!builtinAllow,
    },
  };
}

async function scenarioCtx001(state: MutableScenarioState): Promise<LiveStoryProof> {
  const { client } = state;
  const secondaryScope = {
    sessionId: "e2e-runtime-secondary",
    workspaceName: "PBI",
  } as const;
  const primarySkillName = "acceptance-marshal-skill";
  const secondarySkillName = "acceptance-pbi-skill";
  const descriptors: Record<string, unknown> = {};
  for (const name of ["marshal.session.context", "marshal.workspace.list", "marshal.skill.read"]) {
    const found = requireOk(await client.search({ name, detail: "full" }));
    const matches = array(found.matches).filter(
      (match) => record(record(match).capability).name === name,
    );
    assert.equal(matches.length, 1, `capability descriptor must exist exactly once: ${name}`);
    descriptors[name] = record(record(matches[0]).capability);
  }
  const permissionOf = (descriptor: unknown): readonly string[] =>
    array(record(descriptor).permissions).map((entry) => String(record(entry).permission));
  assert.deepEqual(permissionOf(descriptors["marshal.session.context"]), [
    MARSHAL_RUNTIME_PERMISSION.sessionRead,
  ]);
  assert.deepEqual(permissionOf(descriptors["marshal.workspace.list"]), [
    MARSHAL_RUNTIME_PERMISSION.workspaceRead,
  ]);
  assert.deepEqual(permissionOf(descriptors["marshal.skill.read"]), [
    MARSHAL_RUNTIME_PERMISSION.skillRead,
  ]);

  const fixedPermissionOverrides = await Promise.all(
    [
      MARSHAL_RUNTIME_PERMISSION.sessionRead,
      MARSHAL_RUNTIME_PERMISSION.workspaceRead,
      MARSHAL_RUNTIME_PERMISSION.skillRead,
    ].map(async (permission) => ({
      permission,
      result: await client.acceptance("setAcceptancePermission", permission, "deny"),
    })),
  );
  assert.equal(
    fixedPermissionOverrides.every(
      ({ result }) =>
        !result.success && /unsupported|cannot be changed/i.test(result.error.message),
    ),
    true,
    "fixed context permissions must reject acceptance override attempts",
  );

  const sessionContext = requireOk(
    await client.invoke("marshal.session.context", {}, newKey("ctx-001-session")),
  );
  const session = record(record(sessionContext.value.output).session);
  assert.equal(session.id, client.scope.sessionId);
  const secondarySessionContext = requireOk(
    await client.invoke("marshal.session.context", {}, newKey("ctx-001-secondary-session"), {
      scope: secondaryScope,
    }),
  );
  const secondarySession = record(record(secondarySessionContext.value.output).session);
  assert.equal(secondarySession.id, secondaryScope.sessionId);
  const allowedKeys = new Set(["id", "name", "workspaceName", "repoPath", "source"]);
  for (const key of Object.keys(session)) {
    assert.equal(
      allowedKeys.has(key),
      true,
      `session context must be bounded to id/name/workspace/repo/source, saw: ${key}`,
    );
  }

  const workspaceList = requireOk(
    await client.invoke("marshal.workspace.list", {}, newKey("ctx-001-workspace")),
  );
  const workspaces = array(record(workspaceList.value.output).workspaces).map(record);
  assert.equal(
    workspaces.some(
      (workspace) =>
        String(workspace.name).toLowerCase() === client.scope.workspaceName.toLowerCase(),
    ),
    true,
    "the active workspace must be present in marshal.workspace.list",
  );
  assert.equal(
    workspaces.some((workspace) => workspace.name === "PBI" && typeof workspace.path === "string"),
    true,
    "the secondary registered PBI workspace must be returned with its path",
  );

  const missingSkill = requireOk(
    await client.invoke(
      "marshal.skill.read",
      { name: `no-such-skill-${randomUUID()}` },
      newKey("ctx-001-missing-skill"),
    ),
  );
  assert.equal(
    record(missingSkill.value.output).skill,
    null,
    "an unknown skill must resolve to null, not an error",
  );
  const primarySkill = requireOk(
    await client.invoke(
      "marshal.skill.read",
      { name: primarySkillName },
      newKey("ctx-001-primary-skill"),
    ),
  );
  const secondarySkill = requireOk(
    await client.invoke(
      "marshal.skill.read",
      { name: secondarySkillName },
      newKey("ctx-001-secondary-skill"),
      { scope: secondaryScope },
    ),
  );
  const primaryCrossRead = requireOk(
    await client.invoke(
      "marshal.skill.read",
      { name: secondarySkillName },
      newKey("ctx-001-primary-cross"),
    ),
  );
  const secondaryCrossRead = requireOk(
    await client.invoke(
      "marshal.skill.read",
      { name: primarySkillName },
      newKey("ctx-001-secondary-cross"),
      { scope: secondaryScope },
    ),
  );
  assert.equal(record(primaryCrossRead.value.output).skill, null);
  assert.equal(record(secondaryCrossRead.value.output).skill, null);

  const primaryUri = `marshal-skill://skill/${encodeURIComponent(primarySkillName)}`;
  const secondaryUri = `marshal-skill://skill/${encodeURIComponent(secondarySkillName)}`;
  const primaryResources = await client.value("listResources", client.scope);
  const secondaryResources = await client.value("listResources", secondaryScope);
  assert.equal(
    primaryResources.some((resource) => resource.uri === primaryUri),
    true,
  );
  assert.equal(
    primaryResources.some((resource) => resource.uri === secondaryUri),
    false,
  );
  assert.equal(
    secondaryResources.some((resource) => resource.uri === secondaryUri),
    true,
  );
  assert.equal(
    secondaryResources.some((resource) => resource.uri === primaryUri),
    false,
  );

  const primaryResource = await client.value("readResource", {
    ...client.scope,
    uri: primaryUri,
  });
  const secondaryResource = await client.value("readResource", {
    ...secondaryScope,
    uri: secondaryUri,
  });
  assert.equal(primaryResource.mimeType, "text/markdown");
  assert.equal(secondaryResource.mimeType, "text/markdown");
  assert.equal(primaryResource.text, record(record(primarySkill.value.output).skill).instructions);
  assert.equal(
    secondaryResource.text,
    record(record(secondarySkill.value.output).skill).instructions,
  );

  const crossResource = await client.acceptance("readResource", {
    ...secondaryScope,
    uri: primaryUri,
  });
  assert.equal(crossResource.success, false);

  const primarySearch = requireOk(
    await client.search({ query: primarySkillName, detail: "full", limit: 100 }),
  );
  const secondarySearch = requireOk(
    await client.search({ query: secondarySkillName, detail: "full", limit: 100 }, secondaryScope),
  );
  const crossCatalogSearch = requireOk(
    await client.search({ query: primarySkillName, detail: "full", limit: 100 }, secondaryScope),
  );
  const discoveryIds = (value: unknown): readonly string[] =>
    array(record(value).discoveries).map((match) => String(record(record(match).entry).id));
  const primaryCatalogId = `catalog://marshal.skill-catalog/${encodeURIComponent(primarySkillName)}`;
  const secondaryCatalogId = `catalog://marshal.skill-catalog/${encodeURIComponent(secondarySkillName)}`;
  assert.equal(discoveryIds(primarySearch).includes(primaryCatalogId), true);
  assert.equal(discoveryIds(secondarySearch).includes(secondaryCatalogId), true);
  assert.equal(discoveryIds(crossCatalogSearch).includes(primaryCatalogId), false);

  return {
    proof: {
      descriptorNames: Object.keys(descriptors),
      sessionKeys: Object.keys(session),
      secondarySessionKeys: Object.keys(secondarySession),
      workspaceCount: workspaces.length,
      missingSkillIsNull: true,
      skillVisibility: {
        primarySkillName,
        secondarySkillName,
        primaryUri,
        secondaryUri,
        primaryCatalogId,
        secondaryCatalogId,
      },
      primaryResources,
      secondaryResources,
      primaryResource,
      secondaryResource,
      crossResource,
      fixedPermissionOverrides,
      primaryDiscoveries: discoveryIds(primarySearch),
      secondaryDiscoveries: discoveryIds(secondarySearch),
      crossDiscoveries: discoveryIds(crossCatalogSearch),
    },
  };
}

async function scenarioCtx002(state: MutableScenarioState, page: Page): Promise<LiveStoryProof> {
  const { client } = state;
  const ordinaryTools = await client.value("listOrdinarySelfTools", client.scope.sessionId);
  const ordinaryTool = ordinaryTools.find((tool) => tool.name === "listWorkspaces");
  assert.ok(ordinaryTool, "the production listWorkspaces RuntimeTool object must be registered");
  const search = requireOk(
    await client.search({
      query: "",
      tags: ["marshal", "host", "tool"],
      detail: "full",
      limit: 200,
    }),
  );
  const descriptors = array(search.matches).map((match) => record(record(match).capability));
  const names = descriptors.map((descriptor) => String(descriptor.name));
  assert.equal(
    names.includes("marshal.tool.listWorkspaces"),
    true,
    "an ordinary session tool must be mirrored as a dynamic capability",
  );
  for (const selfToolName of RUNTIME_SELF_TOOL_NAMES) {
    assert.equal(
      names.includes(`marshal.tool.${selfToolName}`),
      false,
      `runtime self-tools must be excluded: ${selfToolName}`,
    );
  }
  const listWorkspacesDescriptor = descriptors.find(
    (descriptor) => descriptor.name === "marshal.tool.listWorkspaces",
  );
  assert.deepEqual(
    record(listWorkspacesDescriptor?.inputSchema),
    ordinaryTool.parameters,
    "the dynamic capability input schema must exactly mirror the original RuntimeTool schema",
  );
  const permission = array(record(listWorkspacesDescriptor).permissions)
    .map((entry) => String(record(entry).permission))
    .find((value) => value.startsWith(MARSHAL_RUNTIME_TOOL_PERMISSION_PREFIX));
  assert.equal(permission, `${MARSHAL_RUNTIME_TOOL_PERMISSION_PREFIX}listWorkspaces`);

  const countsBefore = await client.value("getInvocationCounts");
  await grant(client, `${MARSHAL_RUNTIME_TOOL_PERMISSION_PREFIX}listWorkspaces`, "allow");
  const allowed = requireOk(
    await client.invoke("marshal.tool.listWorkspaces", {}, newKey("ctx-002-allow")),
  );
  const rawContent = record(allowed.value.output).content;
  const content = typeof rawContent === "string" ? rawContent : "";
  assert.equal(content.includes("workspaces"), true);
  assert.deepEqual(Object.keys(record(allowed.value.output)), ["content"]);
  const countsAfterAllow = await client.value("getInvocationCounts");
  assert.equal(
    countsAfterAllow.ordinaryToolInvocations.listWorkspaces?.objectId,
    countsAfterAllow.ordinaryToolListings.listWorkspaces?.objectId,
    "the invoked object must be the exact RuntimeTool object listed by the production provider",
  );
  assert.equal(
    countsAfterAllow.ordinaryToolInvocations.listWorkspaces?.count,
    (countsBefore.ordinaryToolInvocations.listWorkspaces?.count ?? 0) + 1,
  );

  await grant(client, `${MARSHAL_RUNTIME_TOOL_PERMISSION_PREFIX}listWorkspaces`, "prompt");
  const ownerSession = page.locator(
    `[data-testid="session-item"][data-session-id="${client.scope.sessionId}"]`,
  );
  await ownerSession.click();
  await page.waitForFunction(
    (sessionId) =>
      document
        .querySelector(`[data-testid="session-item"][data-session-id="${sessionId}"]`)
        ?.getAttribute("data-active") === "true",
    client.scope.sessionId,
  );
  const promptIdempotencyKey = newKey("ctx-002-prompt");
  const promptedRaw = await client.invoke("marshal.tool.listWorkspaces", {}, promptIdempotencyKey);
  const prompted = apiEnvelope(promptedRaw);
  assert.equal(prompted.ok, false);
  assert.equal(prompted.errorCode, "approval-required");
  const approvalIdValue = record(record(record(promptedRaw).error).approval).approvalId;
  const approvalId = typeof approvalIdValue === "string" ? approvalIdValue : "";
  assert.notEqual(approvalId, "", "approval-required must include an approval ID");
  const permissionCard = page
    .locator('[data-testid="permission-card"]:not([data-resolved])[data-kind="custom-tool"]')
    .last();
  await permissionCard.waitFor({ state: "visible", timeout: 10_000 });
  await permissionCard.getByRole("button", { name: "Allow once" }).click();
  await page.waitForFunction(
    async ({ sessionId, requestId }) => {
      const permissionsApi: unknown = Reflect.get(window, "permissionsAPI");
      if (typeof permissionsApi !== "object" || permissionsApi === null) return false;
      const getCards: unknown = Reflect.get(permissionsApi, "getCards");
      if (typeof getCards !== "function") return false;
      const result: unknown = await Reflect.apply(getCards, permissionsApi, [sessionId]);
      if (typeof result !== "object" || result === null) return false;
      const cards: unknown = Reflect.get(result, "cards");
      return (
        Reflect.get(result, "success") === true &&
        Array.isArray(cards) &&
        cards.some(
          (card: unknown) =>
            typeof card === "object" &&
            card !== null &&
            Reflect.get(card, "id") === requestId &&
            Reflect.get(card, "resolved") === "allowed",
        )
      );
    },
    { sessionId: client.scope.sessionId, requestId: approvalId },
    { timeout: 10_000 },
  );
  const resolvedCards = record(
    await page.evaluate(async (sessionId) => {
      const permissionsApi: unknown = Reflect.get(window, "permissionsAPI");
      if (typeof permissionsApi !== "object" || permissionsApi === null) return undefined;
      const getCards: unknown = Reflect.get(permissionsApi, "getCards");
      return typeof getCards === "function"
        ? Reflect.apply(getCards, permissionsApi, [sessionId])
        : undefined;
    }, client.scope.sessionId),
  );
  const resolvedCard = array(resolvedCards.cards)
    .map((card) => record(card))
    .find((card) => card.id === approvalId);
  assert.equal(resolvedCard?.resolved, "allowed");
  await page.getByText("Working").last().waitFor({ state: "visible", timeout: 10_000 });
  const resumed = requireOk(
    await client.invoke("marshal.tool.listWorkspaces", {}, promptIdempotencyKey),
  );
  const resumedContentValue = record(resumed.value.output).content;
  const resumedContent = typeof resumedContentValue === "string" ? resumedContentValue : "";
  assert.equal(
    resumedContent.includes("workspaces"),
    true,
    "the approved Runtime request must resume through the original tool",
  );
  const consumedProof = apiEnvelope(
    await client.invoke("marshal.tool.listWorkspaces", {}, promptIdempotencyKey),
  );
  assert.equal(consumedProof.ok, false);
  assert.equal(consumedProof.errorCode, "permission-denied");
  const countsAfterApproval = await client.value("getInvocationCounts");

  await grant(client, `${MARSHAL_RUNTIME_TOOL_PERMISSION_PREFIX}listWorkspaces`, "deny");
  const denied = apiEnvelope(
    await client.invoke("marshal.tool.listWorkspaces", {}, newKey("ctx-002-deny")),
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.errorCode, "permission-denied");
  const countsAfterDenied = await client.value("getInvocationCounts");
  assert.deepEqual(
    countsAfterDenied.ordinaryToolInvocations,
    countsAfterApproval.ordinaryToolInvocations,
    "deny must not invoke the original RuntimeTool object after the approved resume",
  );
  await grant(client, `${MARSHAL_RUNTIME_TOOL_PERMISSION_PREFIX}listWorkspaces`, "allow");

  const unknownTool = apiEnvelope(
    await client.invoke(`marshal.tool.no-such-tool-${randomUUID()}`, {}, newKey("ctx-002-unknown")),
  );
  assert.equal(unknownTool.ok, false);
  assert.equal(unknownTool.errorCode, "not-found");

  return {
    proof: {
      dynamicToolNames: names,
      originalToolDescriptor: ordinaryTool,
      dynamicToolDescriptor: listWorkspacesDescriptor,
      listWorkspacesPermission: permission,
      allowedContentIncludesWorkspaces: content.includes("workspaces"),
      countsBefore,
      countsAfterAllow,
      countsAfterApproval,
      countsAfterDenied,
      promptResult: prompted,
      approvalId,
      resumedResult: resumed,
      consumedProof,
      denyResult: denied,
      unknownToolResult: unknownTool,
    },
    supportingEvidence: ["electron/marshal-runtime/providers.test.ts"],
  };
}

// ---------------------------------------------------------------------------
// 4.14 — Portable swarm boundary and external extension ownership
// ---------------------------------------------------------------------------

async function scenarioLeg001(state: MutableScenarioState): Promise<LiveStoryProof> {
  const { client } = state;
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const runtimeRoot = path.join(repoRoot, "node_modules", "@marshal", "runtime");
  const runtimePackageJsonPath = path.join(runtimeRoot, "package.json");
  assert.equal(
    fs.existsSync(runtimePackageJsonPath),
    true,
    "installed @marshal/runtime package.json must exist",
  );
  const runtimePackageJson = record(
    JSON.parse(fs.readFileSync(runtimePackageJsonPath, "utf8")) as unknown,
  );
  const exportsField = record(runtimePackageJson.exports);
  assert.deepEqual(exportsField["./swarm"], {
    types: "./dist/swarm.d.ts",
    default: "./dist/swarm.js",
  });
  assert.ok(
    exportsField["./extensions"],
    "the runtime extension platform export must remain present",
  );

  assert.equal(
    typeof computeRuntimeExtensionIntegrity,
    "function",
    "@marshal/runtime/extensions must be a live, importable export",
  );

  const swarm = await import("@marshal/runtime/swarm");
  const main = await import("@marshal/runtime");
  const activationExports = Object.keys(swarm).filter((name) =>
    /(?:activate|activation|extension|kernel|provider|register)/i.test(name),
  );
  const mainSwarmExports = Object.keys(main).filter((name) => /swarm/i.test(name));
  assert.deepEqual(activationExports, [], "the portable subpath must expose no activation exports");
  assert.deepEqual(mainSwarmExports, [], "the main runtime entry must not re-export swarm");

  const commonjsProbeValue = record(
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--eval",
          `(async () => {
          const swarm = await import("@marshal/runtime/swarm");
          process.stdout.write(JSON.stringify({
            activationExports: Object.keys(swarm).filter((name) =>
              /(?:activate|activation|extension|kernel|provider|register)/i.test(name)
            ),
          }));
        })().catch((error) => { console.error(error); process.exit(1); });`,
        ],
        { cwd: repoRoot, encoding: "utf8", windowsHide: true },
      ),
    ) as unknown,
  );
  const commonjsProbe = {
    activationExports: array(commonjsProbeValue.activationExports),
  };
  assert.deepEqual(commonjsProbe, {
    activationExports: [],
  });

  const hostManifest = record(
    JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as unknown,
  );
  const lockSource = fs.readFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "utf8");
  const hostProductionMatches = scanHostProductionSwarmBoundary(repoRoot);
  const externalReferences = [
    ...["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].filter(
      (field) => record(hostManifest[field])["@marshal/swarm"] !== undefined,
    ),
    ...(record(record(hostManifest.pnpm).overrides)["@marshal/swarm"] !== undefined
      ? ["pnpm.overrides"]
      : []),
    ...(/(?:^|[\s'"])@marshal\/swarm(?:@|:|[\s'"])|packages[\\/]swarm/i.test(lockSource)
      ? ["pnpm-lock.yaml"]
      : []),
    ...(fs.existsSync(path.join(repoRoot, "node_modules", "@marshal", "swarm"))
      ? ["node_modules/@marshal/swarm"]
      : []),
    ...(fs.existsSync(path.join(repoRoot, "packages", "swarm")) ? ["packages/swarm"] : []),
  ];
  assert.deepEqual(hostProductionMatches, []);
  assert.deepEqual(externalReferences, []);

  const swarmSearch = requireOk(await client.search({ query: "swarm", detail: "full", limit: 50 }));
  const swarmMatches = array(swarmSearch.matches).filter((match) => {
    const capability = record(record(match).capability);
    const name = String(capability.name).toLowerCase();
    const tags = array(capability.tags).map((tag) => String(tag).toLowerCase());
    return name.includes("swarm") || tags.includes("swarm");
  });
  assert.ok(
    swarmMatches.length > 0,
    "the installed swarm extension must expose swarm capabilities",
  );

  return {
    proof: {
      swarmExport: exportsField["./swarm"],
      extensionsExportPresent: Boolean(exportsField["./extensions"]),
      commonjsProbe,
      activationExports,
      mainSwarmExports,
      hostProductionMatches,
      externalReferences,
      swarmMatchCount: swarmMatches.length,
    },
  };
}

function scanHostProductionSwarmBoundary(
  repoRoot: string,
): readonly { readonly file: string; readonly kind: "import" | "default-capability" }[] {
  const matches: Array<{ file: string; kind: "import" | "default-capability" }> = [];
  const visit = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (["__tests__", "e2e", "test", "tests"].includes(entry.name)) continue;
        visit(target);
        continue;
      }
      const relative = path.relative(repoRoot, target).replaceAll("\\", "/");
      if (
        !entry.isFile() ||
        !/\.(?:[cm]?js|tsx?)$/.test(entry.name) ||
        /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)
      ) {
        continue;
      }
      const source = fs.readFileSync(target, "utf8");
      if (
        /(?:\bfrom\s+|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)["'](?:@marshal\/runtime\/swarm|@marshal\/swarm)["']/i.test(
          source,
        )
      ) {
        matches.push({ file: relative, kind: "import" });
      }
      if (
        /\b(?:name|id)\s*:\s*["'][^"']*swarm[^"']*["']|\btags\s*:\s*\[[^\]]*["']swarm["']/i.test(
          source,
        )
      ) {
        matches.push({ file: relative, kind: "default-capability" });
      }
    }
  };
  for (const relative of ["common", "electron", "src"]) visit(path.join(repoRoot, relative));
  return matches;
}
