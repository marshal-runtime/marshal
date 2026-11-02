import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

import type {
  RuntimeAcceptanceAPI,
  RuntimeAcceptanceBridgeInfo,
  RuntimeAcceptanceFixture,
  RuntimeAcceptanceLaunchProfile,
  RuntimeAcceptancePaths,
  RuntimeAcceptanceResult,
} from "../common/runtime-acceptance";
import { BUILTIN_AGENTIC_DEBUGGER_EXTENSION_IDENTITY } from "../electron/marshal-runtime/agentic-debugger-extension";
import { MARSHAL_RUNTIME_PACKAGE_PIN } from "../electron/marshal-runtime/runtime-package-pin.generated";
import { E2E_DATA_DIR } from "../electron/mock-mode";
import { launchPersistentE2EApp, seedTestData } from "./marshal-fixtures";
import { LiveStoryRecorder, array, record, requireOk } from "./runtime-acceptance/harness";

declare global {
  interface Window {
    runtimeAcceptanceAPI?: RuntimeAcceptanceAPI;
  }
}

const RUN_ROOT = requiredPath("MARSHAL_RUNTIME_ACCEPTANCE_RUN_ROOT");
const EVIDENCE_ROOT = requiredPath("MARSHAL_RUNTIME_ACCEPTANCE_EVIDENCE_ROOT");
const USER_DATA_ROOT = path.join(RUN_ROOT, "electron-user-data");
const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NORMAL_SOURCE_ROOT = requiredPath("MARSHAL_RUNTIME_ACCEPTANCE_NORMAL_SOURCE_ROOT");
const SCOPE = { sessionId: "e2e-fresh", workspaceName: "marshal" } as const;
const SELECTED_STORIES = new Set(
  (process.env.MARSHAL_RUNTIME_ACCEPTANCE_STORIES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const BASELINE_STORIES = new Set(["MRT-HAR-001", "MRT-HAR-002", "MRT-BOOT-001", "MRT-BOOT-006"]);
const EXPECTED_MINIMUM_STORIES =
  SELECTED_STORIES.size > 0 && [...SELECTED_STORIES].every((storyId) => storyId === "MRT-BOOT-005")
    ? 0
    : 1;
const ISOLATED_E2E_SEED_ROOT = path.join(EVIDENCE_ROOT, "isolated-e2e-seed");
const activeApps = new Set<ElectronApplication>();
const activeLogs = new Set<ProcessLogs>();
const activeSpawnedProcesses = new Set<ReturnType<typeof spawn>>();
const recorder = new LiveStoryRecorder(EVIDENCE_ROOT, {
  processId: process.pid,
  userDataDirectory: USER_DATA_ROOT,
  appDataDirectory: E2E_DATA_DIR,
});

test.afterEach(async () => {
  await Promise.allSettled([...activeApps].map((app) => app.close()));
  await Promise.allSettled([...activeLogs].map((logs) => logs.close()));
  for (const child of activeSpawnedProcesses) child.kill();
  activeApps.clear();
  activeLogs.clear();
  activeSpawnedProcesses.clear();
});

test("validates the bounded Marshal Runtime source host cluster", async () => {
  test.setTimeout(1_200_000);
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });
  seedTestData();
  restrictDirectoryToCurrentUser(E2E_DATA_DIR);
  fs.rmSync(ISOLATED_E2E_SEED_ROOT, { recursive: true, force: true });
  fs.cpSync(E2E_DATA_DIR, ISOLATED_E2E_SEED_ROOT, { recursive: true });

  await runSelectedStories();

  const result = recorder.finalize();
  expect(result.stories.length).toBeGreaterThanOrEqual(EXPECTED_MINIMUM_STORIES);
  recorder.writeSupporting("cluster-summary.json", {
    sessionId: SCOPE.sessionId,
    selectedStoryIds:
      SELECTED_STORIES.size > 0
        ? [...SELECTED_STORIES]
        : [
            "MRT-HAR-001",
            "MRT-HAR-002",
            "MRT-BOOT-001",
            "MRT-BOOT-002",
            "MRT-BOOT-003",
            "MRT-BOOT-004",
            "MRT-BOOT-006",
            "MRT-BOOT-007",
            "MRT-BOOT-008",
          ],
    statusCounts: countBy(result.stories.map((story) => story.status)),
    stories: result.stories,
    bugs: result.bugs,
  });
});

async function runSelectedStories(): Promise<void> {
  let baseline: BaselineLaunch | null = null;
  let baselineFailure: unknown = null;
  if ([...BASELINE_STORIES].some(shouldRunStory)) {
    try {
      baseline = await launchBaseline();
    } catch (error) {
      baselineFailure = error;
    }
  }

  await runBaselineStories(baseline, baselineFailure);

  if (shouldRunStory("MRT-BOOT-002")) await validateConcurrentStartup();
  if (shouldRunStory("MRT-BOOT-003")) await validatePackageTampering();
  if (shouldRunStory("MRT-BOOT-004")) await validatePackageLoaderFailures();
  if (shouldRunStory("MRT-BOOT-007")) await validateStartupFailures();
  if (shouldRunStory("MRT-BOOT-008")) await validateDisposalAggregation();
}

async function runBaselineStories(
  baseline: BaselineLaunch | null,
  baselineFailure: unknown,
): Promise<void> {
  if (baseline) {
    if (shouldRunStory("MRT-HAR-002")) await validateHarnessFidelity(baseline);
    if (shouldRunStory("MRT-BOOT-001")) await validateBootBaseline(baseline);
    if (shouldRunStory("MRT-BOOT-006")) await validateDisposal(baseline);
    if (shouldRunStory("MRT-HAR-001")) await validateGateMatrix(baseline);
    return;
  }
  const reason = errorMessage(baselineFailure);
  for (const [storyId, evidenceClass] of [
    ["MRT-HAR-001", "LIVE-ELECTRON+STATIC"],
    ["MRT-HAR-002", "LIVE-ELECTRON+STATIC"],
    ["MRT-BOOT-001", "LIVE-ELECTRON+STATIC"],
    ["MRT-BOOT-006", "LIVE-ELECTRON+NODE-INTEGRATION"],
  ] as const) {
    if (!shouldRunStory(storyId)) continue;
    recorder.block(storyId, evidenceClass, `The fully gated baseline launch failed: ${reason}`);
  }
}

function shouldRunStory(storyId: string): boolean {
  return SELECTED_STORIES.size === 0 || SELECTED_STORIES.has(storyId);
}

async function launchBaseline(): Promise<BaselineLaunch> {
  const app = await launchPersistentE2EApp({
    userDataDir: USER_DATA_ROOT,
    seed: false,
    extraEnv: acceptanceEnvironment(),
  });
  activeApps.add(app);
  const logs = captureProcessLogs(app, "baseline");
  activeLogs.add(logs);
  const page = await acceptancePage(app, EVIDENCE_ROOT);
  let bridgeInfo = unwrap(await page.evaluate(() => window.runtimeAcceptanceAPI!.getBridgeInfo()));
  const identity = await processIdentity(app);
  const processProof = captureElectronProcessProof({
    launcherPid: launchedProcessPid(app),
    bridgePid: bridgeInfo.mainProcessPid,
    electronMainEvaluation: identity,
    exactSourceRoot: SOURCE_ROOT,
    runUserDataRoot: USER_DATA_ROOT,
  });
  expect(bridgeInfo.compileTimeGate).toBe(true);
  expect(bridgeInfo.backendIdentity).toEqual({ runtimeId: "copilot", origin: "copilot" });
  expect(processProof.proof).toEqual({
    bridgeProcessIsLive: true,
    bridgeProcessIsElectronMain: true,
    bridgeProcessDescendsFromLauncher: true,
    commandLineReferencesExactSource: true,
    commandLineReferencesRunUserData: true,
    commandLineReferencesConflictingSource: false,
    evaluatedAppPathMatchesExactSource: true,
  });
  const paths = unwrap(await page.evaluate(() => window.runtimeAcceptanceAPI!.getPaths()));
  for (const candidate of Object.values(paths)) expect(isInside(RUN_ROOT, candidate)).toBe(true);
  await expect
    .poll(async () => {
      const result = await page.evaluate(() => window.runtimeAcceptanceAPI!.getStatus());
      return result.success ? record(result.value).lifecycle : "bridge-error";
    })
    .toBe("running");
  bridgeInfo = unwrap(await page.evaluate(() => window.runtimeAcceptanceAPI!.getBridgeInfo()));
  return { app, page, logs, bridgeInfo, identity, processProof, paths };
}

async function validateHarnessFidelity(baseline: BaselineLaunch): Promise<void> {
  await recorder.capture("MRT-HAR-002", "LIVE-ELECTRON+STATIC", async () => {
    const selfTools = unwrap(
      await baseline.page.evaluate(() => window.runtimeAcceptanceAPI!.listRegisteredSelfTools()),
    );
    expect(selfTools.map((tool) => tool.name)).toEqual([
      "runtimeSearch",
      "runtimeInvoke",
      "runtimeExecuteTypeScript",
      "runtimeListExtensions",
      "runtimeInstallExtension",
      "runtimeUpdateExtension",
      "runtimeEnableExtension",
      "runtimeDisableExtension",
      "runtimeRemoveExtension",
    ]);
    expect(new Set(selfTools.map((tool) => tool.objectId)).size).toBe(9);

    const directSearch = unwrap(
      await baseline.page.evaluate(
        (scope) => window.runtimeAcceptanceAPI!.search({ ...scope, query: "code" }),
        SCOPE,
      ),
    );
    const selfToolSearch = unwrap(
      await baseline.page.evaluate(
        (scope) =>
          window.runtimeAcceptanceAPI!.invokeRegisteredSelfTool({
            name: "runtimeSearch",
            sessionId: scope.sessionId,
            toolCallId: "acceptance-self-tool-search",
            arguments: { query: "code" },
          }),
        SCOPE,
      ),
    );
    expect(record(directSearch).ok).toBe(true);
    const parsedSelfToolSearch = JSON.parse(selfToolSearch) as unknown;
    expect(record(parsedSelfToolSearch).ok).toBe(true);
    expect(parsedSelfToolSearch).toEqual(directSearch);

    const arbitrarySourceAttempt = await baseline.page.evaluate(
      (scope) =>
        window.runtimeAcceptanceAPI!.invokeRegisteredSelfTool({
          name: "runtimeExecuteTypeScript",
          sessionId: scope.sessionId,
          toolCallId: "acceptance-arbitrary-source",
          arguments: { source: "export default () => 1" },
        }),
      SCOPE,
    );
    expect(arbitrarySourceAttempt.success).toBe(false);
    const arbitraryExecutionControls = await baseline.page.evaluate(
      async (scope) =>
        await Promise.all(
          ["command", "modulePath", "outputPath"].map((key) =>
            window.runtimeAcceptanceAPI!.invokeRegisteredSelfTool({
              name: "runtimeExecuteTypeScript",
              sessionId: scope.sessionId,
              toolCallId: `acceptance-arbitrary-${key}`,
              arguments: {
                acceptanceProfile: "search-capability",
                idempotencyKey: `acceptance-arbitrary-${key}`,
                [key]: "C:\\not-allowlisted",
              },
            }),
          ),
        ),
      SCOPE,
    );
    expect(arbitraryExecutionControls.every((attempt) => !attempt.success)).toBe(true);
    const invalidFixtureProfile = await baseline.page.evaluate(async () => {
      return await window.runtimeAcceptanceAPI!.materializeExtensionFixture({
        // @ts-expect-error Acceptance verifies runtime rejection of an invalid fixture profile.
        profile: "arbitrary-fixture",
      });
    });
    expect(invalidFixtureProfile.success).toBe(false);

    const lifecycle = unwrap(
      await baseline.page.evaluate(() => window.runtimeAcceptanceAPI!.getLifecycleEvents()),
    );
    expect(lifecycle.filter((event) => event.type === "host.constructed")).toHaveLength(1);
    expect(lifecycle.filter((event) => event.type === "host.running")).toHaveLength(1);
    expect(lifecycle.filter((event) => event.type === "kernel.providers.inventory")).toHaveLength(
      1,
    );
    expect(lifecycle.filter((event) => event.type === "kernel.constructed")).toHaveLength(1);
    expect(
      lifecycle.filter((event) => event.type === "extension-manager.constructed"),
    ).toHaveLength(1);
    const bridgeRegistered = lifecycle.find(
      (event) => event.type === "acceptance.bridge.registered",
    );
    const registeredIds = record(record(bridgeRegistered?.details).instanceIds);
    expect({
      host: registeredIds.host,
      api: registeredIds.api,
      uiController: registeredIds.uiController,
      sessionManager: registeredIds.sessionManager,
      memoryManager: registeredIds.memoryManager,
      authority: registeredIds.authority,
    }).toEqual({
      host: baseline.bridgeInfo.instanceIds.host,
      api: baseline.bridgeInfo.instanceIds.api,
      uiController: baseline.bridgeInfo.instanceIds.uiController,
      sessionManager: baseline.bridgeInfo.instanceIds.sessionManager,
      memoryManager: baseline.bridgeInfo.instanceIds.memoryManager,
      authority: baseline.bridgeInfo.instanceIds.authority,
    });
    expect(
      record(lifecycle.find((event) => event.type === "kernel.constructed")?.details).objectId,
    ).toBe(baseline.bridgeInfo.instanceIds.kernel);
    expect(
      record(lifecycle.find((event) => event.type === "extension-manager.constructed")?.details)
        .objectId,
    ).toBe(baseline.bridgeInfo.instanceIds.extensionManager);
    const instanceIds = Object.values(baseline.bridgeInfo.instanceIds).filter(
      (value): value is string => typeof value === "string",
    );
    expect(new Set(instanceIds).size).toBe(instanceIds.length);
    expect(baseline.bridgeInfo.instanceCounts).toEqual({
      host: 1,
      api: 1,
      kernel: 1,
      extensionManager: 1,
      uiController: 1,
      sessionManager: 1,
      memoryManager: 1,
    });

    await baseline.page.screenshot({
      path: path.join(EVIDENCE_ROOT, "screenshots", "baseline-source.png"),
      fullPage: true,
    });
    return {
      context: baselineContext(baseline),
      actions: [
        "getBridgeInfo",
        "listRegisteredSelfTools",
        "direct runtime search",
        "registered runtimeSearch self-tool",
        "reject arbitrary TypeScript source",
        "inspect lifecycle identity",
      ],
      rawResultEnvelopes: {
        bridgeInfo: baseline.bridgeInfo,
        selfTools,
        directSearch,
        selfToolSearch,
        arbitrarySourceAttempt,
        arbitraryExecutionControls,
        invalidFixtureProfile,
        lifecycle,
      },
      assertions: {
        oneHostConstructed: true,
        oneHostRunning: true,
        oneKernelInventory: true,
        oneExtensionManager: true,
        everyProductionSingletonCountOne: true,
        productionBackendIdentity: true,
        productionSelfToolObjects: true,
        directAndSelfToolResultsIdentical: true,
        bridgeInstanceIdsMatchRegistration: true,
        arbitrarySourceRejected: true,
        arbitraryCommandsAndPathsRejected: true,
        fixtureProfilesAllowlisted: true,
      },
      proof: { bridgeInfo: baseline.bridgeInfo, lifecycle, processProof: baseline.processProof },
      supportingEvidence: [
        "static-gates.json",
        "api-audit.jsonl",
        "api-transcript.jsonl",
        "lifecycle.jsonl",
        "screenshots/baseline-source.png",
      ],
    };
  });
}

async function validateBootBaseline(baseline: BaselineLaunch): Promise<void> {
  await recorder.run("MRT-BOOT-001", "LIVE-ELECTRON+STATIC", async () => {
    const status = unwrap(
      await baseline.page.evaluate(() => window.runtimeAcceptanceAPI!.getStatus()),
    );
    expect(record(status).lifecycle).toBe("running");
    expect(record(status).runtimePackage).toMatchObject({
      name: "@marshal/runtime",
      version: "0.1.0",
      entrypoint: "dist/host.js",
    });

    const capabilityNames = [
      "marshal.agent.launch",
      "marshal.memory.store",
      "marshal.brain.launch",
      "ui.application.open",
      "code.index.status",
    ];
    const searches = await baseline.page.evaluate(
      async ({ scope, names }) =>
        await Promise.all(
          names.map((name) =>
            window.runtimeAcceptanceAPI!.search({ ...scope, name, detail: "full" }),
          ),
        ),
      { scope: SCOPE, names: capabilityNames },
    );
    for (const [index, envelope] of searches.entries()) {
      const result = requireOk(unwrap(envelope));
      expect(JSON.stringify(result.value)).toContain(capabilityNames[index]);
    }

    const extensions = requireOk(
      unwrap(
        await baseline.page.evaluate(
          (scope) => window.runtimeAcceptanceAPI!.listExtensions(scope),
          SCOPE,
        ),
      ),
    ).value;
    expect(
      extensions.find(
        (extension) => extension.identity === BUILTIN_AGENTIC_DEBUGGER_EXTENSION_IDENTITY,
      ),
    ).toBeUndefined();
    const debuggerSearchEnvelope = await baseline.page.evaluate(
      (scope) =>
        window.runtimeAcceptanceAPI!.search({
          ...scope,
          tags: ["agentic-debugger"],
          detail: "full",
          limit: 100,
        }),
      SCOPE,
    );
    const debuggerSearch = requireOk(unwrap(debuggerSearchEnvelope));
    expect(debuggerSearch.value.matches).toHaveLength(0);
    const debuggerUiResources = unwrap(
      await baseline.page.evaluate(
        (scope) => window.runtimeAcceptanceAPI!.listResources(scope),
        SCOPE,
      ),
    );
    expect(
      debuggerUiResources.find(
        (resource) => resource.uri === "runtime://debugger/ui/application/v1",
      ),
    ).toBeUndefined();

    const manifestPath = path.join(SOURCE_ROOT, ".marshal-runtime-packs", "manifest.json");
    const pinPath = path.join(
      SOURCE_ROOT,
      "electron",
      "marshal-runtime",
      "runtime-package-pin.generated.ts",
    );
    const manifest = readJson(manifestPath);
    const manifestPackages = array(manifest.packages).map((entry) => record(entry).name);
    expect(manifestPackages).toEqual(
      MARSHAL_RUNTIME_PACKAGE_PIN.packages.map((entry) => entry.name),
    );
    expect(MARSHAL_RUNTIME_PACKAGE_PIN.packages).toHaveLength(27);

    const directories = [
      baseline.paths.runtimeRoot,
      baseline.paths.workspaceRoot,
      baseline.paths.protectedResultsRoot,
      baseline.paths.worktreeRoot,
      baseline.paths.trustedExtensionRoot,
    ];
    const directorySecurity = directories.map(inspectDirectorySecurity);
    const directorySecurityArtifact = recorder.writeSupporting(
      "boot/mrt-boot-001-directory-security.json",
      directorySecurity,
    );
    expect(directorySecurity.every((entry) => entry.exists && entry.isDirectory)).toBe(true);
    expect(directorySecurity.filter((entry) => !entry.restricted)).toEqual([]);
    expect(
      directories.every((directory) => isInside(baseline.paths.marshalAppDataRoot, directory)),
    ).toBe(true);

    const buildHashes = {
      main: fileDigest(path.join(SOURCE_ROOT, "dist-electron", "main.js")),
      preload: fileDigest(
        path.join(SOURCE_ROOT, "dist-electron", "runtime-acceptance-preload.cjs"),
      ),
      renderer: treeDigest(path.join(SOURCE_ROOT, "dist")),
    };
    return {
      context: baselineContext(baseline),
      actions: [
        "getStatus",
        ...capabilityNames.map((name) => `search:${name}`),
        "confirm agentic debugger is not installed by default",
        "confirm agentic debugger capabilities are absent",
        "confirm agentic debugger UI resource is unpublished",
        "inspect runtime paths",
        "inspect package closure",
        "inspect directory ACL or mode",
      ],
      rawResultEnvelopes: {
        status,
        searches,
        extensions,
        debuggerSearchEnvelope,
        debuggerUiResources,
      },
      assertions: {
        running: true,
        runtimeMetadataPinned: true,
        packageClosureCountIs27: true,
        namedCapabilitiesDiscoverable: true,
        agenticDebuggerNotInstalledByDefault: true,
        agenticDebuggerCapabilitiesAbsent: true,
        agenticDebuggerUiResourceAbsent: true,
        directoriesCreated: true,
        directoriesRestricted: true,
        directoriesUnderIsolatedAppDataRoot: true,
      },
      proof: {
        status,
        searches,
        extensions,
        debuggerSearch,
        debuggerUiResources,
        paths: baseline.paths,
        directorySecurity,
        packageNames: manifestPackages,
        manifestSha256: fileDigest(manifestPath),
        generatedPinSha256: fileDigest(pinPath),
        buildHashes,
      },
      supportingEvidence: [
        directorySecurityArtifact,
        "static-gates.json",
        "supporting-commands/verify-marshal-runtime.json",
        "supporting-commands/normal-vite-build.json",
        "supporting-commands/acceptance-vite-build.json",
      ],
    };
  });
}

async function validateConcurrentStartup(): Promise<void> {
  await recorder.run("MRT-BOOT-002", "LIVE-ELECTRON", async () => {
    const launch = await launchAcceptanceCase({
      name: "boot-002-concurrent-startup",
      appRoot: SOURCE_ROOT,
      profile: "startup-delay",
    });
    const bridgeInfoBefore = unwrap(
      await launch.page.evaluate(() => window.runtimeAcceptanceAPI!.getBridgeInfo()),
    );
    const lifecycleBefore = unwrap(
      await launch.page.evaluate(() => window.runtimeAcceptanceAPI!.getLifecycleEvents()),
    );
    expect(lifecycleBefore.some((event) => event.type === "host.running")).toBe(false);
    expect(bridgeInfoBefore.instanceCounts.kernel).toBe(0);
    unwrap(
      await launch.page.evaluate(() =>
        window.runtimeAcceptanceAPI!.setAcceptancePermission("code.read", "allow"),
      ),
    );
    const concurrent = await launch.page.evaluate(async (scope) => {
      const api = window.runtimeAcceptanceAPI!;
      return await Promise.all([
        ...Array.from({ length: 8 }, () => api.getStatus()),
        ...Array.from({ length: 8 }, () => api.search({ ...scope, query: "code" })),
        ...Array.from({ length: 4 }, (_, index) =>
          api.invoke({
            ...scope,
            capability: "code.index.status",
            input: {},
            idempotencyKey: `acceptance-first-use-${index}`,
          }),
        ),
      ]);
    }, SCOPE);
    expect(concurrent).toHaveLength(20);
    for (const [index, envelope] of concurrent.entries()) {
      expect(envelope.success).toBe(true);
      if (!envelope.success) continue;
      if (index >= 8) expect(record(envelope.value).ok).toBe(true);
    }
    const finalStatus = unwrap(
      await launch.page.evaluate(() => window.runtimeAcceptanceAPI!.getStatus()),
    );
    expect(record(finalStatus).lifecycle).toBe("running");
    const lifecycle = unwrap(
      await launch.page.evaluate(() => window.runtimeAcceptanceAPI!.getLifecycleEvents()),
    );
    const counts = unwrap(
      await launch.page.evaluate(() => window.runtimeAcceptanceAPI!.getInvocationCounts()),
    );
    const bridgeInfoAfter = unwrap(
      await launch.page.evaluate(() => window.runtimeAcceptanceAPI!.getBridgeInfo()),
    );
    expect(lifecycle.filter((event) => event.type === "host.constructed")).toHaveLength(1);
    expect(lifecycle.filter((event) => event.type === "host.running")).toHaveLength(1);
    expect(lifecycle.filter((event) => event.type === "kernel.providers.inventory")).toHaveLength(
      1,
    );
    expect(
      lifecycle.some((event) => /duplicate-provider|duplicate-resource/.test(event.type)),
    ).toBe(false);
    expect(bridgeInfoAfter.instanceCounts.kernel).toBe(1);
    expect(bridgeInfoAfter.instanceCounts.extensionManager).toBe(1);
    const close = await closeAcceptanceApp({
      app: launch.app,
      logs: launch.logs,
      evidenceRoot: launch.prepared.evidenceRoot,
      fixtureIds: [],
      mode: "normal",
    });
    activeApps.delete(launch.app);
    activeLogs.delete(launch.logs);
    const artifact = recorder.writeSupporting("cases/boot-002.json", {
      bridgeInfoBefore,
      lifecycleBefore,
      concurrent,
      finalStatus,
      lifecycle,
      counts,
      bridgeInfoAfter,
      close,
    });
    return {
      context: {
        processId: launch.identity.pid,
        userDataDirectory: launch.identity.userData,
        appDataDirectory: launch.prepared.appDataRoot,
      },
      actions: ["issue 20 concurrent getStatus/search/invoke calls", "inspect lifecycle counts"],
      rawResultEnvelopes: concurrent,
      assertions: {
        callCountIs20: concurrent.length === 20,
        allBridgeCallsSucceeded: true,
        allRuntimeCallsSucceeded: true,
        oneHost: true,
        oneKernelInventory: true,
        callsIssuedBeforeHostRunning: true,
        oneExtensionManager: true,
        noDuplicateRegistrationFailure: true,
      },
      proof: {
        bridgeInfoBefore,
        lifecycleBefore,
        concurrent,
        finalStatus,
        lifecycle,
        counts,
        bridgeInfoAfter,
        close,
      },
      supportingEvidence: [
        artifact,
        "launches/boot-002-concurrent-startup/run/evidence/api-audit.jsonl",
        "launches/boot-002-concurrent-startup/run/evidence/api-transcript.jsonl",
        "launches/boot-002-concurrent-startup/run/evidence/lifecycle.jsonl",
      ],
    };
  });
}

async function validateDisposal(baseline: BaselineLaunch): Promise<void> {
  await recorder.run("MRT-BOOT-006", "LIVE-ELECTRON+NODE-INTEGRATION", async () => {
    const normalTypeScript = await exerciseTypeScriptWorker(baseline.page, "boot-006-normal");
    const normalFixture = await installFixture(baseline.page, "echo", "boot-006-normal");
    const normalClose = await closeAcceptanceApp({
      app: baseline.app,
      logs: baseline.logs,
      evidenceRoot: EVIDENCE_ROOT,
      fixtureIds: [normalFixture.fixtureId],
      mode: "normal",
    });
    activeApps.delete(baseline.app);
    activeLogs.delete(baseline.logs);

    const e2eLaunch = await launchAcceptanceCase({
      name: "boot-006-e2e-close",
      appRoot: SOURCE_ROOT,
    });
    const e2eTypeScript = await exerciseTypeScriptWorker(e2eLaunch.page, "boot-006-e2e");
    const e2eFixture = await installFixture(e2eLaunch.page, "echo", "boot-006-e2e");
    const e2eClose = await closeAcceptanceApp({
      app: e2eLaunch.app,
      logs: e2eLaunch.logs,
      evidenceRoot: e2eLaunch.prepared.evidenceRoot,
      fixtureIds: [e2eFixture.fixtureId],
      mode: "playwright",
    });
    activeApps.delete(e2eLaunch.app);
    activeLogs.delete(e2eLaunch.logs);

    for (const close of [normalClose, e2eClose]) {
      expect(close.fixtureDisposals.every(Boolean)).toBe(true);
      expect(close.lifecycleTypes).toEqual(
        expect.arrayContaining([
          "api.dispose.started",
          "api.dispose.completed",
          "host.dispose.started",
          "extension-manager.dispose.completed",
          "ui-controller.dispose.completed",
          "runtime-bindings.dispose.completed",
          "host.disposed",
        ]),
      );
      expect(close.aliveAfter).toEqual([]);
      expect(close.exitResult.code).toBe(0);
      expect(close.disposalOrder.apiBeforeHost).toBe(true);
      expect(close.disposalOrder.extensionsBeforeBindings).toBe(true);
    }
    return {
      context: baselineContext(baseline),
      actions: [
        "install echo fixture",
        "request normal Electron quit",
        "launch isolated acceptance app",
        "install second echo fixture",
        "close through Playwright fixture path",
      ],
      rawResultEnvelopes: { normalTypeScript, e2eTypeScript, normalClose, e2eClose },
      assertions: {
        bothFixtureDisposalsObserved: true,
        apiDisposedBeforeHost: true,
        extensionsDisposedBeforeBindings: true,
        uiControllerDisposed: true,
        bothProcessesExited: true,
        typeScriptWorkerExercisedBeforeBothCloses: true,
        noChildrenRemain: true,
      },
      proof: { normalClose, e2eClose },
      supportingEvidence: [
        "supporting-commands/runtime-host-support-tests.json",
        "supporting-disposal.json",
        "process-tree-normal-before.json",
        "process-tree-normal-after.json",
        "process-exit-normal.json",
        "launches/boot-006-e2e-close/run/evidence/process-tree-playwright-before.json",
        "launches/boot-006-e2e-close/run/evidence/process-tree-playwright-after.json",
        "launches/boot-006-e2e-close/run/evidence/process-exit-playwright.json",
      ],
    };
  });
}

async function validateGateMatrix(baseline: BaselineLaunch): Promise<void> {
  await recorder.capture("MRT-HAR-001", "LIVE-ELECTRON+STATIC", async () => {
    const gateMatrix = await captureGateMatrix();
    const gateMatrixArtifact = recorder.writeSupporting("gate-matrix.json", gateMatrix);
    const sourceCapabilitySearch = await baseline.page.evaluate((scope) => {
      return window.runtimeAcceptanceAPI!.search({
        ...scope,
        name: "code.index.status",
        detail: "full",
      });
    }, SCOPE);
    const sourceCapabilityResult = requireOk(unwrap(sourceCapabilitySearch));
    const sourceCapabilityNames = array(record(sourceCapabilityResult.value).matches).map((match) =>
      String(record(record(match).capability).name),
    );
    const unavailable = gateMatrix.filter((entry) => entry.tokenMode !== "wrong");
    const wrongToken = gateMatrix.find((entry) => entry.tokenMode === "wrong");
    expect(unavailable.every((entry) => entry.apiType === "undefined")).toBe(true);
    expect(unavailable.every((entry) => entry.acceptanceChannels.length === 0)).toBe(true);
    expect(wrongToken).toMatchObject({
      apiType: "object",
      bridgeProbe: {
        success: false,
        error: { code: "acceptance-token-invalid" },
      },
    });
    expect([...(wrongToken?.acceptanceChannels ?? [])].sort()).toEqual(
      expectedRuntimeAcceptanceChannels(),
    );
    expect(gateMatrix.every((entry) => entry.userDataIsolated)).toBe(true);
    expect(gateMatrix.every((entry) => entry.aliveAfter.length === 0)).toBe(true);
    expect(sourceCapabilityNames).toContain("code.index.status");
    return {
      context: baselineContext(baseline),
      actions: [...gateMatrix.map((entry) => entry.case), "search:code.index.status"],
      rawResultEnvelopes: {
        fullyGatedAcceptance: baseline.bridgeInfo,
        negativeCases: gateMatrix,
        sourceCapabilitySearch,
      },
      assertions: {
        normalAndPartialGateGlobalAbsent: true,
        normalAndPartialGateChannelsAbsent: true,
        perLaunchUserDataIsolated: true,
        fullyGatedAcceptancePresent: true,
        missingTokenUnavailable: true,
        wrongTokenRejected: true,
        allGateProcessesExited: true,
        sourceCapabilityDiscoverable: true,
      },
      proof: { gateMatrix, fullyGatedAcceptance: baseline.bridgeInfo, sourceCapabilityNames },
      supportingEvidence: ["static-gates.json", gateMatrixArtifact],
    };
  });
}

async function validatePackageTampering(): Promise<void> {
  await recorder.run("MRT-BOOT-003", "LIVE-ELECTRON", async () => {
    const authoritativeBefore = runtimePackageClosureDigest(path.join(SOURCE_ROOT, "node_modules"));
    const cases = await runSequential([
      () =>
        runPackageMutationCase(
          "boot-003-entrypoint-byte",
          "entrypoint-byte",
          "entrypoint-pin-mismatch",
        ),
      () =>
        runPackageMutationCase(
          "boot-003-unexpected-file",
          "add-unexpected-file",
          "package-content-pin-mismatch",
        ),
    ]);
    const authoritativeAfter = runtimePackageClosureDigest(path.join(SOURCE_ROOT, "node_modules"));
    const casesArtifact = recorder.writeSupporting("cases/boot-003.json", {
      authoritativeBefore,
      authoritativeAfter,
      cases,
    });
    expect(authoritativeAfter).toBe(authoritativeBefore);
    expect(cases.map((entry) => entry.startupError.code)).toEqual([
      "entrypoint-pin-mismatch",
      "package-content-pin-mismatch",
    ]);
    expect(cases.every((entry) => entry.lifecycle === "failed")).toBe(true);
    expect(cases.every((entry) => entry.searchErrorCode === "runtime-unavailable")).toBe(true);
    expect(cases.every((entry) => !entry.lifecycleTypes.includes("host.running"))).toBe(true);
    expect(cases.every((entry) => entry.aliveAfter.length === 0)).toBe(true);
    return {
      context: caseContext(cases[0]),
      actions: cases.map((entry) => entry.mutation),
      rawResultEnvelopes: cases,
      assertions: {
        entrypointTamperRejected: true,
        packageContentTamperRejected: true,
        runtimeNeverRunning: true,
        noCapabilityExecuted: true,
        authoritativePackagesUnchanged: true,
      },
      proof: { authoritativeBefore, authoritativeAfter, cases },
      supportingEvidence: [casesArtifact],
    };
  });
}

async function validatePackageLoaderFailures(): Promise<void> {
  await recorder.run("MRT-BOOT-004", "LIVE-ELECTRON", async () => {
    const authoritativeBefore = runtimePackageClosureDigest(path.join(SOURCE_ROOT, "node_modules"));
    const definitions = [
      ["package-root-junction", "package-missing"],
      ["package-missing", "package-missing"],
      ["manifest-name-drift", "package-pin-mismatch"],
      ["manifest-version-drift", "package-pin-mismatch"],
      ["entrypoint-junction", "entrypoint-denied"],
      ["entrypoint-missing", "entrypoint-missing"],
      ["module-load-failed", "module-load-failed"],
      ["invalid-runtime-module", "invalid-runtime-module"],
    ] as const;
    const cases = await runSequential(
      definitions.map(
        ([mutation, expected]) =>
          () =>
            runPackageMutationCase(`boot-004-${mutation}`, mutation, expected),
      ),
    );
    const authoritativeAfter = runtimePackageClosureDigest(path.join(SOURCE_ROOT, "node_modules"));
    const casesArtifact = recorder.writeSupporting("cases/boot-004.json", {
      authoritativeBefore,
      authoritativeAfter,
      cases,
    });
    expect(authoritativeAfter).toBe(authoritativeBefore);
    expect(cases.map((entry) => entry.startupError.code)).toEqual(
      definitions.map((entry) => entry[1]),
    );
    expect(cases.every((entry) => entry.lifecycle === "failed")).toBe(true);
    expect(cases.every((entry) => entry.searchErrorCode === "runtime-unavailable")).toBe(true);
    expect(cases.every((entry) => !entry.lifecycleTypes.includes("host.running"))).toBe(true);
    expect(cases.every((entry) => entry.aliveAfter.length === 0)).toBe(true);
    return {
      context: caseContext(cases[0]),
      actions: definitions.map(([mutation]) => mutation),
      rawResultEnvelopes: cases,
      assertions: {
        allExpectedLoaderCodesObserved: true,
        escapedPathsNotImported: true,
        noCapabilityRegistered: true,
        authoritativePackagesUnchanged: true,
        allProcessesExited: true,
      },
      proof: { authoritativeBefore, authoritativeAfter, cases },
      supportingEvidence: ["supporting-commands/runtime-host-support-tests.json", casesArtifact],
    };
  });
}

async function validateStartupFailures(): Promise<void> {
  await recorder.run("MRT-BOOT-007", "LIVE-ELECTRON", async () => {
    const deniedDirectories = [
      "workspaceRoot",
      "protectedResultsRoot",
      "worktreeRoot",
      "trustedExtensionRoot",
    ] as const;
    const denialCases = await runSequential(
      deniedDirectories.map(
        (directory) => () => runDirectoryDenialCase(`boot-007-deny-${directory}`, directory),
      ),
    );
    const preReadyQuit = await runPreReadyQuitCase();
    const casesArtifact = recorder.writeSupporting("cases/boot-007.json", {
      denialCases,
      preReadyQuit,
    });
    expect(denialCases.every((entry) => entry.lifecycle === "failed")).toBe(true);
    expect(denialCases.every((entry) => entry.searchErrorCode === "runtime-unavailable")).toBe(
      true,
    );
    expect(
      denialCases.every(
        (entry) =>
          !JSON.stringify({
            startupError: entry.startupError,
            search: entry.search,
          }).includes(entry.deniedPath),
      ),
    ).toBe(true);
    expect(denialCases.every((entry) => !entry.deniedDirectoryExists)).toBe(true);
    expect(denialCases.every((entry) => entry.deniedDirectoryContents.length === 0)).toBe(true);
    expect(denialCases.every((entry) => entry.aliveAfter.length === 0)).toBe(true);
    expect(preReadyQuit.lifecycleTypes).toContain("acceptance.pre-ready-quit.requested");
    expect(preReadyQuit.processLifecycleTypes).toContain("app.before-quit");
    expect(preReadyQuit.quitCalledBeforeReady).toBe(true);
    expect(preReadyQuit.lifecycleTypes).not.toContain("host.start.requested");
    expect(preReadyQuit.lifecycleTypes).not.toContain("host.running");
    expect(preReadyQuit.processLifecycleTypes).not.toContain("process.unhandledRejection");
    expect(preReadyQuit.pid).toBe(preReadyQuit.spawnedPid);
    expect(preReadyQuit.lifecyclePid).toBe(preReadyQuit.spawnedPid);
    expect(preReadyQuit.mainProcessIsElectron).toBe(true);
    expect(preReadyQuit.aliveAfter).toEqual([]);
    return {
      context: caseContext(denialCases[0]),
      actions: [
        ...deniedDirectories.map((directory) => `deny:${directory}`),
        "request pre-ready quit",
      ],
      rawResultEnvelopes: { denialCases, preReadyQuit },
      assertions: {
        everyDirectoryFailureSanitized: true,
        runtimeFailedClosed: true,
        shellRemainedDiagnosable: true,
        noDeniedDirectoryUsed: true,
        preReadyQuitRequestedBeforeReady: true,
        preReadyQuitDidNotStartRuntimeHost: true,
        preReadyQuitHadNoUnhandledRejection: true,
        noWorkersRemain: true,
      },
      proof: { denialCases, preReadyQuit },
      supportingEvidence: [casesArtifact],
    };
  });
}

async function validateDisposalAggregation(): Promise<void> {
  await recorder.run("MRT-BOOT-008", "LIVE-ELECTRON+NODE-INTEGRATION", async () => {
    const launch = await launchAcceptanceCase({
      name: "boot-008-disposal-aggregation",
      appRoot: SOURCE_ROOT,
      profile: "disposal-aggregation",
    });
    const fixtures = await Promise.all([
      installFixture(launch.page, "disposal-failure", "boot-008-a"),
      installFixture(launch.page, "disposal-failure", "boot-008-b"),
    ]);
    const close = await closeAcceptanceApp({
      app: launch.app,
      logs: launch.logs,
      evidenceRoot: launch.prepared.evidenceRoot,
      fixtureIds: fixtures.map((fixture) => fixture.fixtureId),
      mode: "playwright",
    });
    activeApps.delete(launch.app);
    activeLogs.delete(launch.logs);
    const casesArtifact = recorder.writeSupporting("cases/boot-008.json", {
      fixtures,
      close,
    });
    expect(close.fixtureDisposals).toEqual([true, true]);
    expect(close.lifecycleTypes).toEqual(
      expect.arrayContaining([
        "extension-manager.dispose.failed",
        "ui-controller.dispose.completed",
        "runtime-bindings.dispose.failed",
        "acceptance.provider.dispose.attempted",
        "host.dispose.failed",
        "host.disposed",
      ]),
    );
    expect(close.aliveAfter).toEqual([]);
    expect(close.exitResult.code).toBe(0);
    const supporting = readJson(path.join(EVIDENCE_ROOT, "supporting-disposal.json"));
    expect(record(supporting.postDisposeMutations).install).toBe("MANAGER_DISPOSED");
    expect(supporting.allPostDisposeMutationsRejected).toBe(true);
    return {
      context: {
        processId: launch.identity.pid,
        userDataDirectory: launch.identity.userData,
        appDataDirectory: launch.prepared.appDataRoot,
      },
      actions: [
        "launch with finite provider-disposal profile",
        "install two disposal-failure extensions",
        "close Electron",
        "inspect aggregate disposal diagnostics",
        "inspect post-dispose manager result",
      ],
      rawResultEnvelopes: { fixtures, close, supporting },
      assertions: {
        bothExtensionDisposalsAttempted: true,
        providerDisposalAttempted: true,
        extensionAndBindingErrorsAggregated: true,
        uiDisposalContinued: true,
        processExited: true,
        managerRejectsPostDisposeMutation: true,
      },
      proof: { fixtures, close, supporting },
      supportingEvidence: [
        "supporting-disposal.json",
        "supporting-commands/runtime-host-support-tests.json",
        "launches/boot-008-disposal-aggregation/run/evidence/process-tree-playwright-before.json",
        "launches/boot-008-disposal-aggregation/run/evidence/process-tree-playwright-after.json",
        "launches/boot-008-disposal-aggregation/run/evidence/process-exit-playwright.json",
        casesArtifact,
      ],
    };
  });
}

async function captureGateMatrix(): Promise<readonly GateMatrixResult[]> {
  const cases = [
    {
      name: "normal-neither-runtime-gate",
      appRoot: NORMAL_SOURCE_ROOT,
      e2e: false,
      acceptance: false,
    },
    { name: "normal-e2e-only", appRoot: NORMAL_SOURCE_ROOT, e2e: true, acceptance: false },
    {
      name: "normal-acceptance-only",
      appRoot: NORMAL_SOURCE_ROOT,
      e2e: false,
      acceptance: true,
    },
    {
      name: "normal-both-runtime-gates",
      appRoot: NORMAL_SOURCE_ROOT,
      e2e: true,
      acceptance: true,
    },
    { name: "acceptance-e2e-only", appRoot: SOURCE_ROOT, e2e: true, acceptance: false },
    {
      name: "acceptance-acceptance-only",
      appRoot: SOURCE_ROOT,
      e2e: false,
      acceptance: true,
    },
    {
      name: "acceptance-missing-token",
      appRoot: SOURCE_ROOT,
      e2e: true,
      acceptance: true,
      tokenMode: "missing",
    },
    {
      name: "acceptance-wrong-token",
      appRoot: SOURCE_ROOT,
      e2e: true,
      acceptance: true,
      tokenMode: "wrong",
    },
  ] as const;
  return await runSequential(
    cases.map((entry) => async () => {
      const isolatedRoot = path.join(EVIDENCE_ROOT, "gate-matrix", entry.name);
      const explicitUserData = path.join(isolatedRoot, "electron-user-data");
      const env = definedEnvironment(process.env);
      delete env.MARSHAL_E2E;
      delete env.MARSHAL_RUNTIME_ACCEPTANCE;
      delete env.MARSHAL_RUNTIME_ACCEPTANCE_PROFILE;
      delete env.MARSHAL_RUNTIME_ACCEPTANCE_TOKEN;
      delete env.MARSHAL_RUNTIME_ACCEPTANCE_PRELOAD_TOKEN;
      env.APPDATA = path.join(isolatedRoot, "app-data");
      env.LOCALAPPDATA = path.join(isolatedRoot, "local-app-data");
      env.MARSHAL_DEV_DATA_DIR = path.join(isolatedRoot, "marshal-app-data");
      env.TEMP = path.join(isolatedRoot, "temp");
      env.TMP = env.TEMP;
      env.HOME = path.join(isolatedRoot, "home");
      env.USERPROFILE = env.HOME;
      env.MARSHAL_RUNTIME_ACCEPTANCE_RUN_ROOT = isolatedRoot;
      env.MARSHAL_RUNTIME_ACCEPTANCE_EVIDENCE_ROOT = path.join(isolatedRoot, "evidence");
      if (entry.e2e) env.MARSHAL_E2E = "1";
      if (entry.acceptance) env.MARSHAL_RUNTIME_ACCEPTANCE = "1";
      const tokenMode = "tokenMode" in entry ? entry.tokenMode : "valid";
      if (tokenMode !== "missing") {
        env.MARSHAL_RUNTIME_ACCEPTANCE_TOKEN = requiredEnvironment(
          "MARSHAL_RUNTIME_ACCEPTANCE_TOKEN",
        );
      }
      if (tokenMode === "wrong") {
        env.MARSHAL_RUNTIME_ACCEPTANCE_PRELOAD_TOKEN = "wrong-acceptance-token";
      }
      for (const directory of [
        env.APPDATA,
        env.LOCALAPPDATA,
        env.MARSHAL_DEV_DATA_DIR,
        env.TEMP,
        env.HOME,
        explicitUserData,
      ]) {
        fs.mkdirSync(directory, { recursive: true });
      }
      if (entry.e2e) seedIsolatedE2EData(env.TEMP);

      const app = await _electron.launch({
        args: [`--user-data-dir=${explicitUserData}`, entry.appRoot],
        cwd: entry.appRoot,
        env,
      });
      activeApps.add(app);
      const logs = captureProcessLogs(app, `gate-${entry.name}`);
      activeLogs.add(logs);
      const page = await app.firstWindow();
      const apiType = await page.evaluate(() => typeof window.runtimeAcceptanceAPI);
      const identity = await processIdentity(app);
      const bridgeProbe =
        apiType === "object"
          ? await page.evaluate(() => window.runtimeAcceptanceAPI!.getBridgeInfo())
          : null;
      const acceptanceChannels = await app.evaluate(({ ipcMain }) => {
        const handlers = Reflect.get(ipcMain, "_invokeHandlers");
        return handlers instanceof Map
          ? [...handlers.keys()].filter(
              (channel): channel is string =>
                typeof channel === "string" && channel.startsWith("runtime-acceptance:"),
            )
          : [];
      });
      const close = await closeAcceptanceApp({
        app,
        logs,
        evidenceRoot: isolatedRoot,
        fixtureIds: [],
        mode: "playwright",
      });
      activeApps.delete(app);
      activeLogs.delete(logs);
      return {
        case: entry.name,
        appRoot: entry.appRoot,
        pid: identity.pid,
        appPath: identity.appPath,
        userData: identity.userData,
        apiType,
        bridgeProbe,
        acceptanceChannels,
        e2eGate: entry.e2e,
        acceptanceGate: entry.acceptance,
        tokenMode,
        aliveAfter: close.aliveAfter,
        userDataIsolated:
          isInside(isolatedRoot, identity.userData) &&
          !normalizePathText(identity.userData).includes(normalizePathText(".marshal-dev")),
      };
    }),
  );
}

function expectedRuntimeAcceptanceChannels(): readonly string[] {
  const source = fs.readFileSync(path.join(SOURCE_ROOT, "common", "runtime-acceptance.ts"), "utf8");
  return [
    ...new Set(
      [...source.matchAll(/"(runtime-acceptance:[^"]+)"/g)]
        .map((match) => match[1])
        .filter((channel): channel is string => typeof channel === "string"),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

async function runPackageMutationCase(
  name: string,
  mutation: RuntimePackageMutation,
  expectedCode: string,
): Promise<PackageFailureResult> {
  const prepared = prepareAcceptanceCase(name, materializeSourceApp(name, true));
  const mutationProof = mutateRuntimePackages(prepared.appRoot, mutation);
  const launch = await launchPreparedCase(prepared);
  const search = unwrap(
    await launch.page.evaluate(
      (scope) => window.runtimeAcceptanceAPI!.search({ ...scope, query: "" }),
      SCOPE,
    ),
  );
  const status = unwrap(await launch.page.evaluate(() => window.runtimeAcceptanceAPI!.getStatus()));
  const startupError = unwrap(
    await launch.page.evaluate(() => window.runtimeAcceptanceAPI!.getStartupError()),
  );
  const lifecycle = unwrap(
    await launch.page.evaluate(() => window.runtimeAcceptanceAPI!.getLifecycleEvents()),
  );
  await launch.page.screenshot({
    path: path.join(prepared.evidenceRoot, "responsive-shell.png"),
    fullPage: true,
  });
  const close = await closeAcceptanceApp({
    app: launch.app,
    logs: launch.logs,
    evidenceRoot: prepared.evidenceRoot,
    fixtureIds: [],
    mode: "playwright",
  });
  activeApps.delete(launch.app);
  activeLogs.delete(launch.logs);
  return {
    name,
    mutation,
    expectedCode,
    appRoot: prepared.appRoot,
    runRoot: prepared.runRoot,
    pid: launch.identity.pid,
    userData: launch.identity.userData,
    mutationProof,
    startupError: startupError ?? { code: "missing", message: "Missing startup error." },
    lifecycle: String(record(status).lifecycle),
    lifecycleTypes: lifecycle.map((event) => event.type),
    search,
    searchErrorCode: productErrorCode(search),
    aliveAfter: close.aliveAfter,
  };
}

function mutateRuntimePackages(
  appRoot: string,
  mutation: RuntimePackageMutation,
): Readonly<Record<string, unknown>> {
  const nodeModulesRoot = path.join(appRoot, "node_modules");
  const companion = MARSHAL_RUNTIME_PACKAGE_PIN.packages[0];
  const runtime = MARSHAL_RUNTIME_PACKAGE_PIN.packages.find(
    (entry) => entry.name === "@marshal/runtime",
  );
  if (!runtime) throw new Error("Generated runtime pin is missing @marshal/runtime.");
  const targetPin =
    mutation === "module-load-failed" || mutation === "invalid-runtime-module"
      ? runtime
      : companion;
  const packageRoot = path.join(nodeModulesRoot, ...targetPin.name.split("/"));
  const entrypoint = path.join(packageRoot, targetPin.entrypoint);
  let mutatedEntrypoint = entrypoint;
  const manifestPath = path.join(packageRoot, "package.json");
  const before = {
    packageDigest: packageContentDigest(packageRoot),
    entrySha256: fileDigest(entrypoint),
  };

  if (mutation === "entrypoint-byte") {
    fs.appendFileSync(entrypoint, "\n// acceptance tamper\n");
  } else if (mutation === "add-unexpected-file") {
    fs.writeFileSync(path.join(packageRoot, "unexpected.txt"), "unexpected");
  } else if (mutation === "package-root-junction") {
    const outside = path.join(path.dirname(appRoot), "outside-package");
    fs.cpSync(packageRoot, outside, { recursive: true });
    fs.rmSync(packageRoot, { recursive: true, force: true });
    linkDirectory(outside, packageRoot);
  } else if (mutation === "package-missing") {
    fs.rmSync(packageRoot, { recursive: true, force: true });
  } else if (mutation === "manifest-name-drift") {
    const manifest = readJson(manifestPath);
    writeJsonFile(manifestPath, { ...manifest, name: `${String(manifest.name)}.changed` });
  } else if (mutation === "manifest-version-drift") {
    const manifest = readJson(manifestPath);
    writeJsonFile(manifestPath, { ...manifest, version: "99.0.0" });
  } else if (mutation === "entrypoint-junction") {
    const entryDirectory = path.dirname(entrypoint);
    const outside = path.join(path.dirname(appRoot), "outside-entrypoint");
    fs.mkdirSync(outside, { recursive: true });
    fs.copyFileSync(entrypoint, path.join(outside, path.basename(entrypoint)));
    fs.rmSync(entryDirectory, { recursive: true, force: true });
    linkDirectory(outside, entryDirectory);
  } else if (mutation === "entrypoint-missing") {
    fs.rmSync(entrypoint, { force: true });
  } else if (mutation === "module-load-failed") {
    mutatedEntrypoint = path.join(packageRoot, "dist", "acceptance-loader.js");
    fs.writeFileSync(mutatedEntrypoint, "export const broken = ;\n");
    patchBuiltRuntimePin(appRoot, packageRoot, runtime, mutatedEntrypoint);
  } else {
    mutatedEntrypoint = path.join(packageRoot, "dist", "acceptance-loader.js");
    fs.writeFileSync(mutatedEntrypoint, "export const acceptanceInvalidRuntimeModule = true;\n");
    patchBuiltRuntimePin(appRoot, packageRoot, runtime, mutatedEntrypoint);
  }

  return {
    targetPackage: targetPin.name,
    packageRoot,
    entrypoint: mutatedEntrypoint,
    before,
    after: {
      packageExists: fs.existsSync(packageRoot),
      packageDigest: fs.existsSync(packageRoot) ? packageContentDigest(packageRoot) : null,
      entrySha256: fs.existsSync(mutatedEntrypoint) ? fileDigest(mutatedEntrypoint) : null,
    },
  };
}

async function runDirectoryDenialCase(
  name: string,
  deniedDirectory: keyof Pick<
    RuntimeAcceptancePaths,
    "workspaceRoot" | "protectedResultsRoot" | "worktreeRoot" | "trustedExtensionRoot"
  >,
): Promise<DirectoryDenialResult> {
  const prepared = prepareAcceptanceCase(name, materializeSourceApp(name, false));
  const expectedPaths = acceptancePathsForRun(prepared.runRoot, prepared);
  const deniedPath = expectedPaths[deniedDirectory];
  const startupDirectories = [
    expectedPaths.workspaceRoot,
    expectedPaths.protectedResultsRoot,
    expectedPaths.worktreeRoot,
    expectedPaths.trustedExtensionRoot,
  ];
  for (const directory of startupDirectories) {
    if (directory !== deniedPath) fs.mkdirSync(directory, { recursive: true });
  }
  fs.rmSync(deniedPath, { recursive: true, force: true });
  const deniedParent = path.dirname(deniedPath);
  fs.mkdirSync(deniedParent, { recursive: true });
  const denial = denyDirectoryCreation(deniedParent, deniedPath);
  let launch: AcceptanceLaunch | null = null;
  try {
    launch = await launchPreparedCase(prepared);
    const search = unwrap(
      await launch.page.evaluate(
        (scope) => window.runtimeAcceptanceAPI!.search({ ...scope, query: "" }),
        SCOPE,
      ),
    );
    const status = unwrap(
      await launch.page.evaluate(() => window.runtimeAcceptanceAPI!.getStatus()),
    );
    const startupError = unwrap(
      await launch.page.evaluate(() => window.runtimeAcceptanceAPI!.getStartupError()),
    );
    await launch.page.screenshot({
      path: path.join(prepared.evidenceRoot, "responsive-shell.png"),
      fullPage: true,
    });
    const close = await closeAcceptanceApp({
      app: launch.app,
      logs: launch.logs,
      evidenceRoot: prepared.evidenceRoot,
      fixtureIds: [],
      mode: "playwright",
    });
    activeApps.delete(launch.app);
    activeLogs.delete(launch.logs);
    launch = null;
    denial.restore();
    return {
      name,
      deniedDirectory,
      deniedPath,
      denial: denial.proof,
      pid: close.pid,
      userData: prepared.userDataRoot,
      lifecycle: String(record(status).lifecycle),
      startupError: startupError ?? { code: "missing", message: "Missing startup error." },
      search,
      searchErrorCode: productErrorCode(search),
      deniedDirectoryExists: fs.existsSync(deniedPath),
      deniedDirectoryContents:
        fs.existsSync(deniedPath) && fs.statSync(deniedPath).isDirectory()
          ? fs.readdirSync(deniedPath)
          : [],
      aliveAfter: close.aliveAfter,
    };
  } finally {
    if (launch) {
      await launch.app.close().catch(() => undefined);
      await launch.logs.close().catch(() => undefined);
      activeApps.delete(launch.app);
      activeLogs.delete(launch.logs);
    }
    denial.restore();
  }
}

async function runPreReadyQuitCase(): Promise<PreReadyQuitResult> {
  const name = "boot-007-pre-ready-quit";
  const prepared = prepareAcceptanceCase(name, materializeSourceApp(name, false), "pre-ready-quit");
  const child = spawn(
    electronExecutablePath(),
    [`--user-data-dir=${prepared.userDataRoot}`, prepared.appRoot],
    {
      cwd: prepared.appRoot,
      env: { ...process.env, ...prepared.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  activeSpawnedProcesses.add(child);
  const spawnedPid = child.pid;
  if (!spawnedPid) throw new Error("Direct Electron launch did not return a process ID.");
  const logs = captureChildProcessLogs(child, name, prepared.evidenceRoot);
  activeLogs.add(logs);
  const mainProcess = await waitForProcessRecord(spawnedPid, child, 5_000);
  const processTableBeforeExit = captureProcessTable();
  const processTreeBeforeExit = processDescendants(spawnedPid, processTableBeforeExit);
  let exitResult: { readonly code: number | null; readonly signal: NodeJS.Signals | null };
  try {
    exitResult = await waitForChildExit(child, 30_000);
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    activeSpawnedProcesses.delete(child);
    await logs.close();
    activeLogs.delete(logs);
  }
  await waitForPidsToExit(
    processTreeBeforeExit.map((entry) => entry.pid),
    10_000,
  );
  const lifecycle = readJsonLines(path.join(prepared.evidenceRoot, "lifecycle.jsonl"));
  const processLifecycle = readJsonLines(
    path.join(prepared.appDataRoot, "marshal-process-lifecycle.jsonl"),
  );
  const quitCalled = processLifecycle.find(
    (entry) => String(record(entry).event) === "app.quit.called",
  );
  const lifecycleChildPids = processLifecycle
    .map((entry) => Number(record(record(entry).details).watchdogPid))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  const observedPids = [
    ...new Set([...processTreeBeforeExit.map((entry) => entry.pid), ...lifecycleChildPids]),
  ];
  const observedProcesses = [
    ...processTreeBeforeExit,
    ...processTableBeforeExit.filter((entry) => lifecycleChildPids.includes(entry.pid)),
  ];
  await waitForPidsToExit(observedPids, 10_000);
  const created = lifecycle.find(
    (entry) => String(record(entry).type) === "acceptance.harness.created",
  );
  const lifecyclePid = Number(record(record(created).details).pid);
  if (!Number.isSafeInteger(lifecyclePid) || lifecyclePid <= 0) {
    throw new Error("Pre-ready quit evidence did not identify the Electron main process.");
  }
  const processTableAfter = captureProcessTable();
  const aliveAfter = processTableAfter.filter((entry) =>
    observedProcesses.some((observed) => sameProcessInstance(observed, entry)),
  );
  return {
    name,
    pid: lifecyclePid,
    spawnedPid,
    lifecyclePid,
    mainProcess,
    mainProcessIsElectron:
      mainProcess !== null &&
      isElectronProcess(mainProcess) &&
      normalizePathText(mainProcess.commandLine).includes(normalizePathText(prepared.appRoot)) &&
      normalizePathText(mainProcess.commandLine).includes(normalizePathText(prepared.userDataRoot)),
    quitCalledBeforeReady: record(quitCalled).details
      ? record(record(quitCalled).details).appReady === false
      : false,
    exitResult,
    lifecycleTypes: lifecycle.map((entry) => String(record(entry).type)),
    processLifecycleTypes: processLifecycle.map((entry) => String(record(entry).event)),
    observedPids,
    aliveAfter,
  };
}

function electronExecutablePath(): string {
  const packageRoot = path.join(SOURCE_ROOT, "node_modules", "electron");
  const relativePath = fs.readFileSync(path.join(packageRoot, "path.txt"), "utf8").trim();
  const executable = path.resolve(packageRoot, "dist", relativePath);
  if (!fs.existsSync(executable)) {
    throw new Error(`Electron executable is unavailable: ${executable}`);
  }
  return executable;
}

async function waitForProcessRecord(
  pid: number,
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<ProcessRecord | null> {
  return await waitForProcessRecordUntil(pid, child, Date.now() + timeoutMs);
}

async function waitForProcessRecordUntil(
  pid: number,
  child: ReturnType<typeof spawn>,
  deadline: number,
): Promise<ProcessRecord | null> {
  const processRecord = captureProcessTable().find((entry) => entry.pid === pid);
  if (processRecord) return processRecord;
  if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) {
    return null;
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
  return await waitForProcessRecordUntil(pid, child, deadline);
}

async function launchAcceptanceCase(options: {
  readonly name: string;
  readonly appRoot: string;
  readonly profile?: RuntimeAcceptanceLaunchProfile;
}): Promise<AcceptanceLaunch> {
  return await launchPreparedCase(
    prepareAcceptanceCase(options.name, options.appRoot, options.profile),
  );
}

function prepareAcceptanceCase(
  name: string,
  appRoot: string,
  profile: RuntimeAcceptanceLaunchProfile = "default",
): PreparedAcceptanceCase {
  const caseRoot = path.join(EVIDENCE_ROOT, "launches", name);
  const runRoot = path.join(caseRoot, "run");
  const evidenceRoot = path.join(runRoot, "evidence");
  const tempRoot = path.join(runRoot, "temp");
  const userDataRoot = path.join(runRoot, "electron-user-data");
  const appDataRoot = path.join(tempRoot, path.basename(E2E_DATA_DIR));
  for (const directory of [caseRoot, runRoot, evidenceRoot, tempRoot, userDataRoot]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  seedIsolatedE2EData(tempRoot);
  restrictDirectoryToCurrentUser(appDataRoot);
  const env = {
    ...definedEnvironment(process.env),
    APPDATA: path.join(runRoot, "app-data"),
    LOCALAPPDATA: path.join(runRoot, "local-app-data"),
    TEMP: tempRoot,
    TMP: tempRoot,
    MARSHAL_E2E: "1",
    MARSHAL_E2E_WORKER: process.env.TEST_WORKER_INDEX ?? "0",
    MARSHAL_RUNTIME_ACCEPTANCE: "1",
    MARSHAL_RUNTIME_ACCEPTANCE_PROFILE: profile,
    MARSHAL_RUNTIME_ACCEPTANCE_RUN_ROOT: runRoot,
    MARSHAL_RUNTIME_ACCEPTANCE_EVIDENCE_ROOT: evidenceRoot,
  };
  fs.mkdirSync(env.APPDATA, { recursive: true });
  fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
  return {
    name,
    caseRoot,
    runRoot,
    evidenceRoot,
    tempRoot,
    userDataRoot,
    appDataRoot,
    appRoot,
    env,
  };
}

async function launchPreparedCase(prepared: PreparedAcceptanceCase): Promise<AcceptanceLaunch> {
  const app = await _electron.launch({
    args: [`--user-data-dir=${prepared.userDataRoot}`, prepared.appRoot],
    cwd: prepared.appRoot,
    env: prepared.env,
  });
  activeApps.add(app);
  const logs = captureProcessLogs(app, prepared.name, prepared.evidenceRoot);
  activeLogs.add(logs);
  const page = await acceptancePage(app, prepared.evidenceRoot);
  const identity = await processIdentity(app);
  return { app, page, logs, identity, prepared };
}

function materializeSourceApp(name: string, isolateRuntimePackages: boolean): string {
  const appRoot = path.join(EVIDENCE_ROOT, "source-apps", name);
  fs.rmSync(appRoot, { recursive: true, force: true });
  fs.mkdirSync(appRoot, { recursive: true });
  for (const entry of fs.readdirSync(SOURCE_ROOT, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist-electron") continue;
    const source = path.join(SOURCE_ROOT, entry.name);
    const target = path.join(appRoot, entry.name);
    if (entry.isDirectory()) linkDirectory(source, target);
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), target);
    else fs.copyFileSync(source, target);
  }
  fs.cpSync(path.join(SOURCE_ROOT, "dist-electron"), path.join(appRoot, "dist-electron"), {
    recursive: true,
  });
  const sourceNodeModules = path.join(SOURCE_ROOT, "node_modules");
  const targetNodeModules = path.join(appRoot, "node_modules");
  if (!isolateRuntimePackages) {
    linkDirectory(sourceNodeModules, targetNodeModules);
    return appRoot;
  }
  fs.mkdirSync(targetNodeModules, { recursive: true });
  for (const entry of fs.readdirSync(sourceNodeModules, { withFileTypes: true })) {
    const source = path.join(sourceNodeModules, entry.name);
    const target = path.join(targetNodeModules, entry.name);
    if (entry.name === "@marshal") {
      fs.cpSync(source, target, { recursive: true, dereference: true });
    } else if (fs.statSync(source).isDirectory()) {
      linkDirectory(source, target);
    } else {
      fs.copyFileSync(source, target);
    }
  }
  return appRoot;
}

async function installFixture(
  page: Page,
  profile: "echo" | "disposal-failure",
  key: string,
): Promise<RuntimeAcceptanceFixture> {
  const fixture = unwrap(
    await page.evaluate(
      (fixtureProfile) =>
        window.runtimeAcceptanceAPI!.materializeExtensionFixture({
          profile: fixtureProfile,
          version: "1.0.0",
        }),
      profile,
    ),
  );
  unwrap(
    await page.evaluate(
      (permission) => window.runtimeAcceptanceAPI!.setAcceptancePermission(permission, "allow"),
      `marshal.tool.invoke:${fixture.capabilityNames[0]}`,
    ),
  );
  const installed = unwrap(
    await page.evaluate(
      ({ scope, fixtureId, idempotencyKey }) =>
        window.runtimeAcceptanceAPI!.installExtension({
          ...scope,
          fixtureId,
          idempotencyKey,
        }),
      { scope: SCOPE, fixtureId: fixture.fixtureId, idempotencyKey: key },
    ),
  );
  requireOk(installed);
  return fixture;
}

async function exerciseTypeScriptWorker(page: Page, key: string): Promise<unknown> {
  unwrap(
    await page.evaluate(() =>
      window.runtimeAcceptanceAPI!.setAcceptancePermission("code.read", "allow"),
    ),
  );
  const result = unwrap(
    await page.evaluate(
      ({ scope, idempotencyKey }) =>
        window.runtimeAcceptanceAPI!.executeTypeScript({
          ...scope,
          profile: "search-capability",
          input: { query: "code" },
          idempotencyKey,
        }),
      { scope: SCOPE, idempotencyKey: `acceptance-${key}-typescript` },
    ),
  );
  requireOk(result);
  return result;
}

async function closeAcceptanceApp(options: {
  readonly app: ElectronApplication;
  readonly logs: ProcessLogs;
  readonly evidenceRoot: string;
  readonly fixtureIds: readonly string[];
  readonly mode: "normal" | "playwright";
}): Promise<CloseProof> {
  const launcherPid = launchedProcessPid(options.app);
  const mainIdentity = await processIdentity(options.app);
  const pid = mainIdentity.pid;
  const before = captureProcessTable();
  const processTreeBefore = [
    ...before.filter((entry) => entry.pid === pid),
    ...processDescendants(pid, before),
  ];
  const exit = waitForChildExit(options.app.process(), 30_000);
  if (options.mode === "normal") {
    await options.app.evaluate(({ app }) => app.quit()).catch(() => undefined);
  } else {
    await options.app.close();
  }
  const exitResult = await exit;
  await options.logs.close();
  await waitForPidsToExit(
    processTreeBefore.map((entry) => entry.pid),
    10_000,
  );
  const after = captureProcessTable();
  const processTreeAfter = after.filter((entry) =>
    processTreeBefore.some((beforeEntry) => sameProcessInstance(beforeEntry, entry)),
  );
  const lifecycle = readJsonLines(path.join(options.evidenceRoot, "lifecycle.jsonl"));
  const fixtureEvents = readJsonLines(path.join(options.evidenceRoot, "fixture-events.jsonl"));
  const lifecycleTypes = lifecycle.map((entry) => String(record(entry).type));
  const fixtureDisposals = options.fixtureIds.map((fixtureId) =>
    fixtureEvents.some(
      (entry) =>
        record(entry).fixture === `fixture:${fixtureId}` && record(entry).event === "dispose",
    ),
  );
  writeJsonFile(path.join(options.evidenceRoot, `process-tree-${options.mode}-before.json`), {
    rootPid: pid,
    processes: processTreeBefore,
  });
  writeJsonFile(path.join(options.evidenceRoot, `process-tree-${options.mode}-after.json`), {
    rootPid: pid,
    processes: processTreeAfter,
  });
  writeJsonFile(path.join(options.evidenceRoot, `process-exit-${options.mode}.json`), exitResult);
  return {
    mode: options.mode,
    pid,
    launcherPid,
    mainIdentity,
    processTreeBefore,
    processTreeAfter,
    exitResult,
    aliveAfter: processTreeAfter,
    lifecycleTypes,
    fixtureDisposals,
    disposalOrder: {
      apiBeforeHost:
        lifecycleTypes.indexOf("api.dispose.completed") >= 0 &&
        lifecycleTypes.indexOf("api.dispose.completed") <
          lifecycleTypes.indexOf("host.dispose.started"),
      extensionsBeforeBindings:
        Math.max(
          lifecycleTypes.indexOf("extension-manager.dispose.completed"),
          lifecycleTypes.indexOf("extension-manager.dispose.failed"),
        ) <
        Math.max(
          lifecycleTypes.indexOf("runtime-bindings.dispose.completed"),
          lifecycleTypes.indexOf("runtime-bindings.dispose.failed"),
        ),
    },
    lifecycle,
    fixtureEvents,
  };
}

async function acceptancePage(app: ElectronApplication, evidenceRoot: string): Promise<Page> {
  const page = await app.firstWindow();
  page.on("console", (message) => {
    fs.appendFileSync(
      path.join(evidenceRoot, "renderer-console.jsonl"),
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        type: message.type(),
        text: message.text().slice(0, 2_000),
      })}\n`,
    );
  });
  await page.waitForFunction(
    () => typeof window.runtimeAcceptanceAPI?.getBridgeInfo === "function",
  );
  return page;
}

function acceptanceEnvironment(): Readonly<Record<string, string>> {
  return {
    MARSHAL_RUNTIME_ACCEPTANCE: "1",
    MARSHAL_RUNTIME_ACCEPTANCE_TOKEN: requiredEnvironment("MARSHAL_RUNTIME_ACCEPTANCE_TOKEN"),
    MARSHAL_RUNTIME_ACCEPTANCE_PROFILE: "default",
    MARSHAL_RUNTIME_ACCEPTANCE_RUN_ROOT: RUN_ROOT,
    MARSHAL_RUNTIME_ACCEPTANCE_EVIDENCE_ROOT: EVIDENCE_ROOT,
  };
}

function patchBuiltRuntimePin(
  appRoot: string,
  runtimePackageRoot: string,
  runtimePin: (typeof MARSHAL_RUNTIME_PACKAGE_PIN.packages)[number],
  entrypoint: string,
): void {
  const relativeEntrypoint = path
    .relative(runtimePackageRoot, entrypoint)
    .split(path.sep)
    .join("/");
  const newEntrySha256 = fileDigest(entrypoint);
  const newContentSha256 = packageContentDigest(runtimePackageRoot);
  const mainPath = path.join(appRoot, "dist-electron", "main.js");
  const source = fs.readFileSync(mainPath, "utf8");
  if (
    !source.includes(runtimePin.entrypoint) ||
    !source.includes(runtimePin.entrySha256) ||
    !source.includes(runtimePin.contentSha256)
  ) {
    throw new Error("Acceptance source bundle did not contain the generated runtime pin.");
  }
  fs.writeFileSync(
    mainPath,
    source
      .replaceAll(runtimePin.entrypoint, relativeEntrypoint)
      .replaceAll(runtimePin.entrySha256, newEntrySha256)
      .replaceAll(runtimePin.contentSha256, newContentSha256),
  );
}

function acceptancePathsForRun(
  runRoot: string,
  prepared: PreparedAcceptanceCase,
): RuntimeAcceptancePaths {
  return {
    runRoot,
    evidenceRoot: prepared.evidenceRoot,
    electronUserDataRoot: prepared.userDataRoot,
    marshalAppDataRoot: prepared.appDataRoot,
    runtimeRoot: path.join(prepared.appDataRoot, "marshal-runtime"),
    workspaceRoot: path.join(prepared.appDataRoot, "marshal-runtime", "workspace"),
    protectedResultsRoot: path.join(prepared.appDataRoot, "marshal-runtime", "protected-results"),
    worktreeRoot: path.join(prepared.appDataRoot, "marshal-runtime", "worktrees"),
    trustedExtensionRoot: path.join(prepared.appDataRoot, "marshal-runtime", "extensions"),
  };
}

function denyDirectoryCreation(directory: string, deniedPath: string): DenialControl {
  if (process.platform !== "win32") {
    const originalMode = fs.statSync(directory).mode & 0o777;
    fs.chmodSync(directory, 0o500);
    let restored = false;
    return {
      proof: {
        platform: process.platform,
        path: directory,
        deniedPath,
        mode: "500",
        deniedOperation: "create-subdirectory",
      },
      restore() {
        if (restored) return;
        restored = true;
        fs.chmodSync(directory, originalMode);
      },
    };
  }
  const identity = commandOutput("whoami", []).trim();
  const rule = `${identity}:(AD)`;
  const apply = spawnSync("icacls.exe", [directory, "/deny", rule], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (apply.status !== 0) {
    throw new Error(`Unable to deny startup directory access: ${apply.stderr || apply.stdout}`);
  }
  let restored = false;
  return {
    proof: {
      platform: process.platform,
      path: directory,
      deniedPath,
      identity,
      rule,
      deniedOperation: "create-subdirectory",
      stdout: apply.stdout.trim(),
    },
    restore() {
      if (restored) return;
      restored = true;
      const remove = spawnSync("icacls.exe", [directory, "/remove:d", identity], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (remove.status !== 0) {
        throw new Error(
          `Unable to restore startup directory access: ${remove.stderr || remove.stdout}`,
        );
      }
    },
  };
}

function inspectDirectorySecurity(directory: string): Readonly<Record<string, unknown>> & {
  readonly exists: boolean;
  readonly isDirectory: boolean;
  readonly restricted: boolean;
} {
  const exists = fs.existsSync(directory);
  const isDirectory = exists && fs.statSync(directory).isDirectory();
  if (!exists || !isDirectory) return { path: directory, exists, isDirectory, restricted: false };
  if (process.platform !== "win32") {
    const mode = fs.statSync(directory).mode & 0o777;
    return { path: directory, exists, isDirectory, mode, restricted: mode === 0o700 };
  }
  const script = [
    "$securityModule = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'",
    "Import-Module -Name $securityModule -ErrorAction Stop",
    `$acl = Get-Acl -LiteralPath ${powershellLiteral(directory)}`,
    "$access = @($acl.Access | ForEach-Object {",
    "  [ordered]@{ identity = $_.IdentityReference.Value; rights = $_.FileSystemRights.ToString(); type = $_.AccessControlType.ToString(); inherited = [bool]$_.IsInherited }",
    "})",
    "[ordered]@{ owner = $acl.Owner.ToString(); access = $access } | ConvertTo-Json -Compress -Depth 4",
  ].join("\n");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        PSModulePath:
          process.env.PSModulePath ??
          path.join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "Modules",
          ),
      },
    },
  );
  if (result.status !== 0) {
    return {
      path: directory,
      exists,
      isDirectory,
      restricted: false,
      error: result.stderr || result.stdout,
    };
  }
  const acl = record(readJsonText(result.stdout));
  const access = array(acl.access);
  const owner = typeof acl.owner === "string" ? acl.owner.trim() : "";
  const broadAccess = access.some((entry) => {
    const accessRule = record(entry);
    return (
      accessRule.type === "Allow" &&
      /(^|\\)(Everyone|Users|Authenticated Users)$/i.test(
        typeof accessRule.identity === "string" ? accessRule.identity : "",
      )
    );
  });
  return {
    path: directory,
    exists,
    isDirectory,
    restricted: owner.length > 0 && access.length > 0 && !broadAccess,
    acl,
  };
}

function restrictDirectoryToCurrentUser(directory: string): void {
  if (process.platform !== "win32") {
    fs.chmodSync(directory, 0o700);
    return;
  }
  const identity = commandOutput("whoami", []).trim();
  const result = spawnSync(
    "icacls.exe",
    [directory, "/inheritance:r", "/grant:r", `${identity}:(OI)(CI)F`],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(
      `Unable to restrict acceptance app-data ACL: ${result.stderr || result.stdout}`,
    );
  }
}

function runtimePackageClosureDigest(nodeModulesRoot: string): string {
  const entries = MARSHAL_RUNTIME_PACKAGE_PIN.packages.map((entry) => ({
    name: entry.name,
    digest: packageContentDigest(path.join(nodeModulesRoot, ...entry.name.split("/"))),
  }));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function packageContentDigest(packageRoot: string): string {
  const hash = createHash("sha256");
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  visit(packageRoot);
  for (const filePath of files.sort((left, right) => left.localeCompare(right))) {
    hash.update(path.relative(packageRoot, filePath).split(path.sep).join("/"));
    hash.update("\0");
    hash.update(
      path.basename(filePath) === "package.json"
        ? stableJson(readJson(filePath))
        : fs.readFileSync(filePath),
    );
    hash.update("\0");
  }
  return hash.digest("hex");
}

function treeDigest(root: string): string {
  const hash = createHash("sha256");
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  visit(root);
  for (const filePath of files.sort()) {
    hash.update(path.relative(root, filePath).split(path.sep).join("/"));
    hash.update("\0");
    hash.update(fs.readFileSync(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

function seedIsolatedE2EData(tempRoot: string): void {
  const target = path.join(tempRoot, path.basename(E2E_DATA_DIR));
  if (!fs.existsSync(ISOLATED_E2E_SEED_ROOT)) {
    throw new Error("The pristine isolated E2E seed is unavailable.");
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(ISOLATED_E2E_SEED_ROOT, target, { recursive: true });
}

function linkDirectory(source: string, target: string): void {
  fs.symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
}

interface ElectronMainIdentity {
  readonly pid: number;
  readonly ppid: number;
  readonly execPath: string;
  readonly versions: NodeJS.ProcessVersions;
  readonly appPath: string;
  readonly userData: string;
  readonly isPackaged: boolean;
}

interface ProcessRecord {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  readonly executablePath: string | null;
  readonly commandLine: string;
  readonly creationDate?: string | null;
}

interface ProcessLogs {
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly mainLogPath: string;
  close(): Promise<void>;
}

interface BaselineLaunch {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly logs: ProcessLogs;
  readonly bridgeInfo: RuntimeAcceptanceBridgeInfo;
  readonly identity: ElectronMainIdentity;
  readonly processProof: ElectronProcessProof;
  readonly paths: RuntimeAcceptancePaths;
}

interface ElectronProcessProof {
  readonly capturedAt: string;
  readonly launcherPid: number;
  readonly bridgeReportedMainPid: number;
  readonly exactSourceRoot: string;
  readonly runUserDataRoot: string;
  readonly electronMainEvaluation: ElectronMainIdentity;
  readonly bridgeLineage: readonly ProcessRecord[];
  readonly launchedProcessTree: readonly ProcessRecord[];
  readonly proof: {
    readonly bridgeProcessIsLive: boolean;
    readonly bridgeProcessIsElectronMain: boolean;
    readonly bridgeProcessDescendsFromLauncher: boolean;
    readonly commandLineReferencesExactSource: boolean;
    readonly commandLineReferencesRunUserData: boolean;
    readonly commandLineReferencesConflictingSource: boolean;
    readonly evaluatedAppPathMatchesExactSource: boolean;
  };
}

interface PreparedAcceptanceCase {
  readonly name: string;
  readonly caseRoot: string;
  readonly runRoot: string;
  readonly evidenceRoot: string;
  readonly tempRoot: string;
  readonly userDataRoot: string;
  readonly appDataRoot: string;
  readonly appRoot: string;
  readonly env: Readonly<Record<string, string>>;
}

interface AcceptanceLaunch {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly logs: ProcessLogs;
  readonly identity: ElectronMainIdentity;
  readonly prepared: PreparedAcceptanceCase;
}

type RuntimePackageMutation =
  | "entrypoint-byte"
  | "add-unexpected-file"
  | "package-root-junction"
  | "package-missing"
  | "manifest-name-drift"
  | "manifest-version-drift"
  | "entrypoint-junction"
  | "entrypoint-missing"
  | "module-load-failed"
  | "invalid-runtime-module";

interface PackageFailureResult {
  readonly name: string;
  readonly mutation: RuntimePackageMutation;
  readonly expectedCode: string;
  readonly appRoot: string;
  readonly runRoot: string;
  readonly pid: number;
  readonly userData: string;
  readonly mutationProof: Readonly<Record<string, unknown>>;
  readonly startupError: { readonly code: string; readonly message: string };
  readonly lifecycle: string;
  readonly lifecycleTypes: readonly string[];
  readonly search: unknown;
  readonly searchErrorCode: string | null;
  readonly aliveAfter: readonly ProcessRecord[];
}

interface DirectoryDenialResult {
  readonly name: string;
  readonly deniedDirectory: string;
  readonly deniedPath: string;
  readonly denial: Readonly<Record<string, unknown>>;
  readonly pid: number;
  readonly userData: string;
  readonly lifecycle: string;
  readonly startupError: { readonly code: string; readonly message: string };
  readonly search: unknown;
  readonly searchErrorCode: string | null;
  readonly deniedDirectoryExists: boolean;
  readonly deniedDirectoryContents: readonly string[];
  readonly aliveAfter: readonly ProcessRecord[];
}

interface PreReadyQuitResult {
  readonly name: string;
  readonly pid: number;
  readonly spawnedPid: number;
  readonly lifecyclePid: number;
  readonly mainProcess: ProcessRecord | null;
  readonly mainProcessIsElectron: boolean;
  readonly quitCalledBeforeReady: boolean;
  readonly exitResult: { readonly code: number | null; readonly signal: NodeJS.Signals | null };
  readonly lifecycleTypes: readonly string[];
  readonly processLifecycleTypes: readonly string[];
  readonly observedPids: readonly number[];
  readonly aliveAfter: readonly ProcessRecord[];
}

interface CloseProof {
  readonly mode: "normal" | "playwright";
  readonly pid: number;
  readonly launcherPid: number;
  readonly mainIdentity: ElectronMainIdentity;
  readonly processTreeBefore: readonly ProcessRecord[];
  readonly processTreeAfter: readonly ProcessRecord[];
  readonly exitResult: { readonly code: number | null; readonly signal: NodeJS.Signals | null };
  readonly aliveAfter: readonly ProcessRecord[];
  readonly lifecycleTypes: readonly string[];
  readonly fixtureDisposals: readonly boolean[];
  readonly disposalOrder: {
    readonly apiBeforeHost: boolean;
    readonly extensionsBeforeBindings: boolean;
  };
  readonly lifecycle: readonly unknown[];
  readonly fixtureEvents: readonly unknown[];
}

interface GateMatrixResult {
  readonly case: string;
  readonly appRoot: string;
  readonly pid: number;
  readonly appPath: string;
  readonly userData: string;
  readonly apiType: string;
  readonly acceptanceChannels: readonly string[];
  readonly e2eGate: boolean;
  readonly acceptanceGate: boolean;
  readonly tokenMode: "valid" | "missing" | "wrong";
  readonly bridgeProbe: unknown;
  readonly aliveAfter: readonly ProcessRecord[];
  readonly userDataIsolated: boolean;
}

interface DenialControl {
  readonly proof: Readonly<Record<string, unknown>>;
  restore(): void;
}

async function processIdentity(app: ElectronApplication): Promise<ElectronMainIdentity> {
  return await app.evaluate(({ app: electronApp }) => ({
    pid: process.pid,
    ppid: process.ppid,
    execPath: process.execPath,
    versions: process.versions,
    appPath: electronApp.getAppPath(),
    userData: electronApp.getPath("userData"),
    isPackaged: electronApp.isPackaged,
  }));
}

function launchedProcessPid(app: ElectronApplication): number {
  const pid = app.process().pid;
  if (pid === undefined) throw new Error("Playwright Electron launcher did not expose a PID.");
  return pid;
}

function captureElectronProcessProof(input: {
  readonly launcherPid: number;
  readonly bridgePid: number;
  readonly electronMainEvaluation: ElectronMainIdentity;
  readonly exactSourceRoot: string;
  readonly runUserDataRoot: string;
}): ElectronProcessProof {
  const processes = captureProcessTable();
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const bridgeProcess = byPid.get(input.bridgePid);
  const bridgeLineage = processLineage(input.bridgePid, byPid);
  const launchedProcessTree = processDescendants(input.launcherPid, processes);
  const launcherIndex = bridgeLineage.findIndex((entry) => entry.pid === input.launcherPid);
  const launchedLineage =
    launcherIndex === -1 ? bridgeLineage : bridgeLineage.slice(0, launcherIndex + 1);
  const relatedCommandLines = launchedLineage.map((entry) => entry.commandLine);
  const conflictingSourceRoot =
    process.platform === "win32" ? path.resolve("Q:\\src\\marshal") : null;
  return {
    capturedAt: new Date().toISOString(),
    launcherPid: input.launcherPid,
    bridgeReportedMainPid: input.bridgePid,
    exactSourceRoot: input.exactSourceRoot,
    runUserDataRoot: input.runUserDataRoot,
    electronMainEvaluation: input.electronMainEvaluation,
    bridgeLineage,
    launchedProcessTree,
    proof: {
      bridgeProcessIsLive: bridgeProcess !== undefined && isProcessAlive(input.bridgePid),
      bridgeProcessIsElectronMain:
        bridgeProcess !== undefined &&
        isElectronProcess(bridgeProcess) &&
        !/(?:^|\s)--type(?:=|\s)/i.test(bridgeProcess.commandLine),
      bridgeProcessDescendsFromLauncher:
        input.bridgePid === input.launcherPid ||
        bridgeLineage.some((entry) => entry.pid === input.launcherPid),
      commandLineReferencesExactSource: relatedCommandLines.some((commandLine) =>
        commandLineReferencesPath(commandLine, input.exactSourceRoot),
      ),
      commandLineReferencesRunUserData: relatedCommandLines.some((commandLine) =>
        commandLineReferencesPath(commandLine, input.runUserDataRoot),
      ),
      commandLineReferencesConflictingSource:
        conflictingSourceRoot !== null &&
        !pathsEqual(conflictingSourceRoot, input.exactSourceRoot) &&
        relatedCommandLines.some((commandLine) =>
          commandLineReferencesPath(commandLine, conflictingSourceRoot),
        ),
      evaluatedAppPathMatchesExactSource: pathsEqual(
        input.electronMainEvaluation.appPath,
        input.exactSourceRoot,
      ),
    },
  };
}

function captureProcessTable(): readonly ProcessRecord[] {
  if (process.platform === "win32") return captureWindowsProcessTable();
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,comm=,args="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Unable to capture process table: ${result.stderr || result.error?.message}`);
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      name: match[3],
      executablePath: match[3],
      commandLine: match[4],
      creationDate: null,
    }));
}

function captureWindowsProcessTable(): readonly ProcessRecord[] {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "function Encode([string]$value) {",
    "  [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value))",
    "}",
    "Get-CimInstance Win32_Process | ForEach-Object {",
    "  $name = Encode ([string]$_.Name)",
    "  $executablePath = Encode $(if ($null -eq $_.ExecutablePath) { '' } else { [string]$_.ExecutablePath })",
    "  $commandLine = Encode $(if ($null -eq $_.CommandLine) { '' } else { [string]$_.CommandLine })",
    "  $creationDate = Encode $(if ($null -eq $_.CreationDate) { '' } else { $_.CreationDate.ToUniversalTime().ToString('o') })",
    '  "$([int]$_.ProcessId)`t$([int]$_.ParentProcessId)`t$name`t$executablePath`t$commandLine`t$creationDate"',
    "}",
  ].join("\n");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(
      `Unable to capture Windows process table: ${result.stderr || result.error?.message}`,
    );
  }
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .filter((fields) => fields.length === 6)
    .map(([pid, ppid, name, executablePath, commandLine, creationDate]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      name: decodeBase64Text(name),
      executablePath: executablePath ? decodeBase64Text(executablePath) : null,
      commandLine: decodeBase64Text(commandLine),
      creationDate: creationDate ? decodeBase64Text(creationDate) : null,
    }));
}

function decodeBase64Text(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

function processLineage(
  pid: number,
  byPid: ReadonlyMap<number, ProcessRecord>,
): readonly ProcessRecord[] {
  const lineage: ProcessRecord[] = [];
  const visited = new Set<number>();
  let current = byPid.get(pid);
  while (current && !visited.has(current.pid)) {
    lineage.push(current);
    visited.add(current.pid);
    current = byPid.get(current.ppid);
  }
  return lineage;
}

function processDescendants(
  rootPid: number,
  processes: readonly ProcessRecord[],
): readonly ProcessRecord[] {
  const descendants: ProcessRecord[] = [];
  const pending = [rootPid];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const pid = pending.shift();
    if (pid === undefined || visited.has(pid)) continue;
    visited.add(pid);
    const current = processes.find((entry) => entry.pid === pid);
    if (current) descendants.push(current);
    for (const child of processes) {
      if (child.ppid === pid) pending.push(child.pid);
    }
  }
  return descendants;
}

function sameProcessInstance(before: ProcessRecord, after: ProcessRecord): boolean {
  if (before.pid !== after.pid) return false;
  if (before.creationDate && after.creationDate) return before.creationDate === after.creationDate;
  return (
    before.name === after.name &&
    before.executablePath === after.executablePath &&
    before.commandLine === after.commandLine
  );
}

async function waitForPidsToExit(pids: readonly number[], timeoutMs: number): Promise<void> {
  await waitForPidsUntil(pids, Date.now() + timeoutMs);
}

async function waitForPidsUntil(pids: readonly number[], deadline: number): Promise<void> {
  if (pids.every((pid) => !isProcessAlive(pid)) || Date.now() >= deadline) return;
  await new Promise((resolve) => setTimeout(resolve, 100));
  await waitForPidsUntil(pids, deadline);
}

function waitForChildExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error(`Electron process ${child.pid ?? "unknown"} did not exit in time.`));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function captureProcessLogs(
  app: ElectronApplication,
  name: string,
  evidenceRoot = EVIDENCE_ROOT,
): ProcessLogs {
  return captureChildProcessLogs(app.process(), name, evidenceRoot);
}

function captureChildProcessLogs(
  child: Pick<ReturnType<typeof spawn>, "stdout" | "stderr">,
  name: string,
  evidenceRoot = EVIDENCE_ROOT,
): ProcessLogs {
  const stdoutPath = path.join(evidenceRoot, `${name}-stdout.log`);
  const stderrPath = path.join(evidenceRoot, `${name}-stderr.log`);
  const mainLogPath = path.join(evidenceRoot, "main-process.log");
  const stdout = fs.createWriteStream(stdoutPath, {
    flags: "a",
  });
  const stderr = fs.createWriteStream(stderrPath, {
    flags: "a",
  });
  const main = fs.createWriteStream(mainLogPath, { flags: "a" });
  child.stdout?.pipe(stdout);
  child.stderr?.pipe(stderr);
  child.stdout?.pipe(main, { end: false });
  child.stderr?.pipe(main, { end: false });
  let closed = false;
  return {
    stdoutPath,
    stderrPath,
    mainLogPath,
    async close() {
      if (closed) return;
      closed = true;
      child.stdout?.unpipe(main);
      child.stderr?.unpipe(main);
      await Promise.all([
        new Promise<void>((resolve) => stdout.end(resolve)),
        new Promise<void>((resolve) => stderr.end(resolve)),
        new Promise<void>((resolve) => main.end(resolve)),
      ]);
    },
  };
}

function isElectronProcess(entry: ProcessRecord): boolean {
  const executable = entry.executablePath ?? entry.name;
  return (
    path.basename(executable).toLowerCase() ===
    (process.platform === "win32" ? "electron.exe" : "electron")
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function commandLineReferencesPath(commandLine: string, candidate: string): boolean {
  return normalizePathText(commandLine).includes(normalizePathText(candidate));
}

function pathsEqual(left: string, right: string): boolean {
  return normalizePathText(path.resolve(left)) === normalizePathText(path.resolve(right));
}

function normalizePathText(value: string): string {
  const normalized = value.replaceAll("/", "\\").replaceAll("\\\\", "\\");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function definedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function productErrorCode(value: unknown): string | null {
  const result = record(value);
  const error = record(result.error);
  return result.ok === false && typeof error.code === "string" ? error.code : null;
}

function baselineContext(baseline: BaselineLaunch) {
  return {
    processId: baseline.identity.pid,
    userDataDirectory: baseline.identity.userData,
    appDataDirectory: baseline.paths.marshalAppDataRoot,
  };
}

function caseContext(value: PackageFailureResult | DirectoryDenialResult) {
  return {
    processId: value.pid,
    userDataDirectory: value.userData,
  };
}

function countBy(values: readonly string[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

async function runSequential<T>(actions: readonly (() => Promise<T>)[]): Promise<readonly T[]> {
  return actions.reduce(
    (pending, action) => pending.then(async (results) => [...results, await action()]),
    Promise.resolve<readonly T[]>([]),
  );
}

function readJsonLines(filePath: string): readonly unknown[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).map(readJsonText);
}

function readJson(filePath: string): Record<string, unknown> {
  return record(readJsonText(fs.readFileSync(filePath, "utf8")));
}

function readJsonText(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function fileDigest(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function commandOutput(command: string, args: readonly string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function unwrap<T>(result: RuntimeAcceptanceResult<T>): T {
  if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function requiredPath(name: string): string {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return path.resolve(value);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set.`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}
