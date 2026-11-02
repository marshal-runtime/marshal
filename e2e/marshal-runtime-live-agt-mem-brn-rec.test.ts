import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type ElectronApplication, type Page } from "@playwright/test";

import type {
  RuntimeAcceptanceBridgeInfo,
  RuntimeAcceptancePaths,
} from "../common/runtime-acceptance";
import { E2E_DATA_DIR } from "../electron/mock-mode";
import { launchPersistentE2EApp, seedTestData } from "./marshal-fixtures";
import { runAgentMemoryBrainScenarios } from "./runtime-acceptance/agent-scenarios";
import {
  LiveStoryRecorder,
  RuntimeAcceptanceClient,
  array,
  output,
  record,
  requireOk,
  resultErrorCode,
} from "./runtime-acceptance/harness";

process.env.MARSHAL_E2E_WORKSPACE_CANCELLATION = "1";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN_ROOT = requiredPath("MARSHAL_RUNTIME_ACCEPTANCE_RUN_ROOT");
const EVIDENCE_ROOT = requiredPath("MARSHAL_RUNTIME_ACCEPTANCE_EVIDENCE_ROOT");
const USER_DATA_ROOT = path.join(RUN_ROOT, "electron-user-data-agt-mem-brn-rec");
const REC002_RUN_ROOT = path.join(RUN_ROOT, "rec-002");
const REC002_EVIDENCE_ROOT = path.join(REC002_RUN_ROOT, "evidence");
const REC002_TEMP_ROOT = path.join(REC002_RUN_ROOT, "temp");
const REC002_APP_DATA_ROOT = path.join(REC002_TEMP_ROOT, path.basename(E2E_DATA_DIR));
const REC002_USER_DATA_ROOT = path.join(REC002_RUN_ROOT, "electron-user-data");
const SCOPE = { sessionId: "e2e-fresh", workspaceName: "marshal" } as const;
const REC_EXTENSION_IDENTITY = "acceptance.rec001.runtime-ui";
const REC_APPLICATION_ID = "acceptance-rec001-application";
const REC_EXTENSION_KEY = "rec001-extension-install";
const REC_UI_KEY = "rec001-ui-open";
const REC_MEMORY_KEY = "rec001-memory-store";
const SELECTED_STORIES = new Set(
  (process.env.MARSHAL_RUNTIME_ACCEPTANCE_STORIES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const CAMPAIGN_STORIES = [
  ...Array.from({ length: 8 }, (_, index) => `MRT-AGT-${String(index + 1).padStart(3, "0")}`),
  ...Array.from({ length: 7 }, (_, index) => `MRT-MEM-${String(index + 1).padStart(3, "0")}`),
  ...Array.from({ length: 5 }, (_, index) => `MRT-BRN-${String(index + 1).padStart(3, "0")}`),
  "MRT-REC-001",
  "MRT-REC-002",
] as const;

interface ProcessRecord {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  readonly executablePath: string | null;
  readonly commandLine: string;
}

interface ElectronIdentity {
  readonly pid: number;
  readonly ppid: number;
  readonly execPath: string;
  readonly appPath: string;
  readonly userData: string;
  readonly isPackaged: boolean;
}

interface ProcessProof {
  readonly capturedAt: string;
  readonly launcherPid: number;
  readonly mainPid: number;
  readonly appRoot: string;
  readonly userDataRoot: string;
  readonly electronIdentity: ElectronIdentity;
  readonly rendererIdentity: Readonly<Record<string, unknown>>;
  readonly backendIdentity: unknown;
  readonly lineage: readonly ProcessRecord[];
  readonly processTree: readonly ProcessRecord[];
  readonly assertions: {
    readonly mainIsLive: boolean;
    readonly mainDescendsFromLauncher: boolean;
    readonly commandLineReferencesAppRoot: boolean;
    readonly commandLineReferencesUserData: boolean;
    readonly commandLineExcludesForbiddenSource: boolean;
    readonly evaluatedAppPathMatches: boolean;
    readonly rendererBridgePresent: boolean;
  };
}

interface ProcessAudit {
  readonly processProof: ProcessProof;
  readonly lifecycleEvents: readonly Record<string, unknown>[];
  readonly hiddenErrors: readonly string[];
  readonly leakedPids: readonly number[];
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

interface LaunchResult {
  readonly name: string;
  readonly startedAt: string;
  readonly appRoot: string;
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly client: RuntimeAcceptanceClient;
  readonly paths: RuntimeAcceptancePaths;
  readonly bridge: RuntimeAcceptanceBridgeInfo;
  readonly recorder: LiveStoryRecorder;
  readonly logs: ProcessLogs;
  readonly processProof: ProcessProof;
}

interface ProcessLogs {
  readonly stdoutPath: string;
  readonly stderrPath: string;
  close(): Promise<void>;
}

interface RecoveryState {
  readonly scenarios: Awaited<ReturnType<typeof runAgentMemoryBrainScenarios>>;
  readonly memoryFact: string;
  readonly extensionIdentity: string;
  readonly applicationId: string;
  readonly uiInstanceId: string;
  readonly userDataRoot: string;
  readonly appDataRoot: string;
  readonly runtimeStatus: unknown;
  readonly codeIndexStatus: unknown;
}

test("runs the bounded live AGT/MEM/BRN/PRV/REC campaign", async () => {
  test.setTimeout(20 * 60_000);
  await expect(runCampaign()).resolves.toBeUndefined();
});

async function runCampaign(): Promise<void> {
  seedTestData();
  if (storySelected("MRT-REC-002")) {
    fs.mkdirSync(REC002_TEMP_ROOT, { recursive: true });
    fs.rmSync(REC002_APP_DATA_ROOT, { recursive: true, force: true });
    fs.cpSync(E2E_DATA_DIR, REC002_APP_DATA_ROOT, { recursive: true });
  }

  const first = await launchApp({
    name: "agt-mem-brn-rec-first",
    userDataRoot: USER_DATA_ROOT,
    seed: false,
  });
  let scenarioState: Awaited<ReturnType<typeof runAgentMemoryBrainScenarios>>;
  let recoveryState: RecoveryState | undefined;
  try {
    scenarioState = await runAgentMemoryBrainScenarios({
      client: first.client,
      recorder: first.recorder,
      phase: "pre-restart",
      storyIds: SELECTED_STORIES.size > 0 ? SELECTED_STORIES : undefined,
    });
    if (storySelected("MRT-REC-001")) {
      recoveryState = await prepareRecoveryState(first, scenarioState);
      first.recorder.writeSupporting("stories/MRT-REC-001-before.json", {
        recoveryState,
        processProof: first.processProof,
        sessions: {
          agent: await first.client.value("readSession", scenarioState.durableAgentId),
          brain: await first.client.value("readSession", scenarioState.durableBrainId),
        },
        memories: await first.client.value("readMemories"),
        extensions: await first.client.value("listExtensions", SCOPE),
        ui: await first.client.ui("getSnapshot", SCOPE),
      });
    }
  } finally {
    first.recorder.finalize();
    await closeAndAudit(first, "processes/agt-mem-brn-rec-first.json");
  }

  const restartStories = new Set(["MRT-AGT-007", "MRT-MEM-006", "MRT-BRN-005", "MRT-REC-001"]);
  if ([...restartStories].some(storySelected)) {
    const second = await launchApp({
      name: "agt-mem-brn-rec-restart",
      userDataRoot: USER_DATA_ROOT,
      seed: false,
    });
    try {
      if (recoveryState) await recordRecoveryStory(second, recoveryState);
      await runAgentMemoryBrainScenarios({
        client: second.client,
        recorder: second.recorder,
        phase: "post-restart",
        priorState: scenarioState,
        storyIds: SELECTED_STORIES.size > 0 ? SELECTED_STORIES : undefined,
      });
      second.recorder.finalize();
    } finally {
      await closeAndAudit(second, "processes/agt-mem-brn-rec-restart.json");
    }
  }

  if (storySelected("MRT-REC-002")) {
    await runCorruptPackageRecovery();
  }

  const finalResults = readJson(path.join(EVIDENCE_ROOT, "stories", "live-story-results.json"));
  const expectedStories =
    SELECTED_STORIES.size === 0
      ? CAMPAIGN_STORIES
      : CAMPAIGN_STORIES.filter((storyId) => SELECTED_STORIES.has(storyId));
  const expectedStoryIds = new Set(expectedStories);
  const selected = array(record(finalResults).stories)
    .map((entry) => record(entry))
    .filter((entry) => expectedStoryIds.has(String(entry.id)));
  expect(
    selected.map((entry) => entry.id).sort((a, b) => String(a).localeCompare(String(b))),
  ).toEqual([...expectedStories].sort((a, b) => a.localeCompare(b)));
  expect(selected.every((entry) => entry.status === "PASS")).toBe(true);
}

function storySelected(storyId: string): boolean {
  return SELECTED_STORIES.size === 0 || SELECTED_STORIES.has(storyId);
}

async function prepareRecoveryState(
  launch: LaunchResult,
  scenarios: Awaited<ReturnType<typeof runAgentMemoryBrainScenarios>>,
): Promise<RecoveryState> {
  const fixture = record(
    await launch.client.value("materializeExtensionFixture", {
      profile: "ui-application",
      identity: REC_EXTENSION_IDENTITY,
      uiApplicationId: REC_APPLICATION_ID,
    }),
  );
  requireOk(
    await launch.client.value("installExtension", {
      ...SCOPE,
      fixtureId: requiredString(fixture.fixtureId, "fixtureId"),
      idempotencyKey: REC_EXTENSION_KEY,
    }),
  );
  const owner = {
    ...SCOPE,
    extensionId: REC_EXTENSION_IDENTITY,
    applicationId: REC_APPLICATION_ID,
  };
  const opened = ipcValue(
    await launch.client.ui("open", {
      ...owner,
      surface: "panel",
      content: { kind: "text", text: "REC-001 process-memory UI instance" },
      idempotencyKey: REC_UI_KEY,
    }),
  );
  const uiInstanceId = requiredString(record(opened.instance).instanceId, "uiInstanceId");
  const memoryFact = `REC-001 idempotency reset fact ${Date.now()}`;
  const stored = requireOk(
    await launch.client.invoke(
      "marshal.memory.store",
      { fact: memoryFact, category: "fact" },
      REC_MEMORY_KEY,
    ),
  );
  expect(record(output(stored)).deduplicated).toBe(false);
  const runtimeStatus = await launch.client.value("getStatus");
  await launch.client.value("setAcceptancePermission", "code.read", "allow");
  const codeIndexStatus = requireOk(
    await launch.client.invoke("code.index.status", {}, unique("rec001-code-index-before")),
  );
  return {
    scenarios,
    memoryFact,
    extensionIdentity: REC_EXTENSION_IDENTITY,
    applicationId: REC_APPLICATION_ID,
    uiInstanceId,
    userDataRoot: launch.paths.electronUserDataRoot,
    appDataRoot: launch.paths.marshalAppDataRoot,
    runtimeStatus,
    codeIndexStatus,
  };
}

async function recordRecoveryStory(launch: LaunchResult, state: RecoveryState): Promise<void> {
  await launch.recorder.run("MRT-REC-001", "LIVE-ELECTRON", async () => {
    expect(launch.paths.electronUserDataRoot).toBe(state.userDataRoot);
    expect(launch.paths.marshalAppDataRoot).toBe(state.appDataRoot);
    const runtimeStatus = record(await launch.client.value("getStatus"));
    expect(runtimeStatus.lifecycle).toBe("running");
    const codeIndexStatus = requireOk(
      await launch.client.invoke("code.index.status", {}, unique("rec001-code-index-after")),
    );

    const agent = requireOk(
      await launch.client.invoke(
        "marshal.agent.get",
        { agentId: state.scenarios.durableAgentId },
        unique("rec001-agent"),
      ),
    );
    const brain = requireOk(
      await launch.client.invoke("marshal.brain.get", {}, unique("rec001-brain")),
    );
    const recall = requireOk(
      await launch.client.invoke(
        "marshal.memory.recall",
        { query: state.memoryFact, limit: 20 },
        unique("rec001-memory-recall"),
      ),
    );
    expect(record(output(agent).agent).id).toBe(state.scenarios.durableAgentId);
    expect(record(output(brain).agent).id).toBe(state.scenarios.durableBrainId);
    expect(
      array(output(recall).memories).some((entry) =>
        String(record(entry).fact).includes(state.memoryFact),
      ),
    ).toBe(true);

    const extensionsBeforeReinstall = requireOk(await launch.client.value("listExtensions", SCOPE));
    expect(
      array(record(extensionsBeforeReinstall).value).some(
        (entry) => record(entry).identity === state.extensionIdentity,
      ),
    ).toBe(false);
    const uiBeforeReopen = ipcValue(await launch.client.ui("getSnapshot", SCOPE));
    expect(array(uiBeforeReopen.instances)).toHaveLength(0);

    const replayedStore = requireOk(
      await launch.client.invoke(
        "marshal.memory.store",
        { fact: state.memoryFact, category: "fact" },
        REC_MEMORY_KEY,
      ),
    );
    expect(record(output(replayedStore)).deduplicated).toBe(true);

    const replayFixture = record(
      await launch.client.value("materializeExtensionFixture", {
        profile: "ui-application",
        identity: state.extensionIdentity,
        uiApplicationId: state.applicationId,
      }),
    );
    requireOk(
      await launch.client.value("installExtension", {
        ...SCOPE,
        fixtureId: requiredString(replayFixture.fixtureId, "replayFixtureId"),
        idempotencyKey: REC_EXTENSION_KEY,
      }),
    );
    const extensionsAfterReinstall = requireOk(await launch.client.value("listExtensions", SCOPE));
    expect(
      array(record(extensionsAfterReinstall).value).some(
        (entry) => record(entry).identity === state.extensionIdentity,
      ),
    ).toBe(true);
    const reopened = ipcValue(
      await launch.client.ui("open", {
        ...SCOPE,
        extensionId: state.extensionIdentity,
        applicationId: state.applicationId,
        surface: "panel",
        content: { kind: "text", text: "REC-001 idempotency cache reset" },
        idempotencyKey: REC_UI_KEY,
      }),
    );
    const reopenedInstanceId = requiredString(
      record(reopened.instance).instanceId,
      "reopenedInstanceId",
    );
    expect(reopenedInstanceId).toBe(state.uiInstanceId);
    expect(record(record(reopened.instance).content).text).toBe("REC-001 idempotency cache reset");

    return {
      actions: [
        "close-first-process-cleanly",
        "relaunch-with-identical-user-data-and-app-data-roots",
        "re-query-runtime-code-index-agent-brain-memory-extension-ui",
        "reuse-settled-api-and-ui-idempotency-keys",
      ],
      proof: {
        runtimeStatus,
        codeIndexStatus,
        agent,
        brain,
        recall,
        extensionsBeforeReinstall,
        uiBeforeReopen,
        replayedStore,
        extensionsAfterReinstall,
        reopened,
      },
      assertions: {
        preservedUserDataRoot: launch.paths.electronUserDataRoot === state.userDataRoot,
        preservedAppDataRoot: launch.paths.marshalAppDataRoot === state.appDataRoot,
        runtimeRestarted: runtimeStatus.lifecycle === "running",
        codeIndexRestarted: record(codeIndexStatus).ok === true,
        ordinaryAgentRecovered: record(output(agent).agent).id === state.scenarios.durableAgentId,
        brainRecovered: record(output(brain).agent).id === state.scenarios.durableBrainId,
        memoryRecovered: true,
        extensionWasEphemeral: true,
        uiWasEphemeral: true,
        apiIdempotencyCacheReset: record(output(replayedStore)).deduplicated === true,
        uiIdempotencyCacheReset:
          reopenedInstanceId === state.uiInstanceId &&
          record(record(reopened.instance).content).text === "REC-001 idempotency cache reset",
      },
      supportingEvidence: [
        "stories/MRT-REC-001-before.json",
        "processes/agt-mem-brn-rec-first.json",
        "processes/agt-mem-brn-rec-restart.json",
      ],
    };
  });
}

async function runCorruptPackageRecovery(): Promise<void> {
  const appRoot = materializeSourceApp("rec-002-isolated-app");
  const entrypoint = runtimeEntrypoint(appRoot);
  const pristine = fs.readFileSync(entrypoint);
  const pristineSha256 = sha256(pristine);
  fs.appendFileSync(entrypoint, "\n// MRT-REC-002 deliberate package corruption\n");
  const corruptSha256 = fileSha256(entrypoint);
  if (corruptSha256 === pristineSha256) {
    throw new Error("REC-002 package corruption did not change the runtime entrypoint digest.");
  }

  fs.mkdirSync(REC002_EVIDENCE_ROOT, { recursive: true });
  let corruptEvidence: Record<string, unknown>;
  let corrupt: LaunchResult | undefined;
  try {
    corrupt = await launchApp({
      name: "rec-002-corrupt",
      userDataRoot: REC002_USER_DATA_ROOT,
      seed: false,
      appRoot,
      runRoot: REC002_RUN_ROOT,
      evidenceRoot: REC002_EVIDENCE_ROOT,
      tempRoot: REC002_TEMP_ROOT,
    });
    const status = record(await corrupt.client.value("getStatus"));
    const startupError = await corrupt.client.value("getStartupError");
    const search = await corrupt.client.search({ name: "code.index.status" });
    const extensions = await corrupt.client.value("listExtensions", SCOPE);
    const ui = ipcValue(await corrupt.client.ui("getSnapshot", SCOPE));
    const trustedExtensions = treeManifest(corrupt.paths.trustedExtensionRoot);
    expect(status.lifecycle).toBe("failed");
    expect(startupError).not.toBeNull();
    expect(resultErrorCode(search)).toBe("runtime-unavailable");
    expect(array(ui.instances)).toHaveLength(0);
    expect(trustedExtensions).toEqual([]);
    corruptEvidence = {
      status,
      startupError,
      search,
      extensions,
      ui,
      trustedExtensions,
      paths: corrupt.paths,
      processProof: corrupt.processProof,
    };
    writeJson(path.join(EVIDENCE_ROOT, "stories", "MRT-REC-002-corrupt-launch.json"), {
      pristineSha256,
      corruptSha256,
      ...corruptEvidence,
    });
  } finally {
    try {
      if (corrupt) {
        await closeAndAudit(corrupt, "processes/rec-002-corrupt.json");
      }
    } finally {
      fs.writeFileSync(entrypoint, pristine);
    }
  }

  const restoredSha256 = fileSha256(entrypoint);
  if (restoredSha256 !== pristineSha256) {
    throw new Error("REC-002 isolated runtime entrypoint was not restored byte-for-byte.");
  }

  const restored = await launchApp({
    name: "rec-002-restored",
    userDataRoot: REC002_USER_DATA_ROOT,
    seed: false,
    appRoot,
    runRoot: REC002_RUN_ROOT,
    evidenceRoot: REC002_EVIDENCE_ROOT,
    tempRoot: REC002_TEMP_ROOT,
  });
  try {
    await restored.recorder.run("MRT-REC-002", "LIVE-ELECTRON", async () => {
      const status = record(await restored.client.value("getStatus"));
      const startupError = await restored.client.value("getStartupError");
      await restored.client.value("setAcceptancePermission", "code.read", "allow");
      const search = requireOk(
        await restored.client.search({ name: "code.index.status", detail: "full" }),
      );
      const invoke = requireOk(
        await restored.client.invoke("code.index.status", {}, unique("rec002-restored-status")),
      );
      const extensions = requireOk(await restored.client.value("listExtensions", SCOPE));
      const ui = ipcValue(await restored.client.ui("getSnapshot", SCOPE));
      expect(status.lifecycle).toBe("running");
      expect(startupError).toBeNull();
      expect(array(record(search).value).length).toBeGreaterThanOrEqual(0);
      expect(record(invoke).ok).toBe(true);
      const extensionIdentities = array(record(extensions).value).map((entry) =>
        String(record(entry).identity),
      );
      expect(extensionIdentities).toEqual([]);
      expect(array(ui.instances)).toHaveLength(0);
      expect(restored.paths.electronUserDataRoot).toBe(REC002_USER_DATA_ROOT);
      expect(restored.paths.marshalAppDataRoot).toBe(REC002_APP_DATA_ROOT);

      return {
        proof: {
          pristineSha256,
          corruptSha256,
          restoredSha256,
          corruptEvidence,
          status,
          startupError,
          search,
          invoke,
          extensions,
          ui,
          restoredProcessProof: restored.processProof,
        },
        assertions: {
          corruptionWasReal: corruptSha256 !== pristineSha256,
          restoredByteForByte: restoredSha256 === pristineSha256,
          preservedUserDataRoot: restored.paths.electronUserDataRoot === REC002_USER_DATA_ROOT,
          preservedAppDataRoot: restored.paths.marshalAppDataRoot === REC002_APP_DATA_ROOT,
          cleanRuntimeStart: status.lifecycle === "running",
          startupErrorCleared: startupError === null,
          searchWorked: record(search).ok === true,
          invokeWorked: record(invoke).ok === true,
          noTrustedExtensionResidue: extensionIdentities.length === 0,
          noRuntimeUiResidue: array(ui.instances).length === 0,
        },
        supportingEvidence: [
          "stories/MRT-REC-002-corrupt-launch.json",
          "processes/rec-002-corrupt.json",
          "processes/rec-002-restored.json",
        ],
      };
    });
    restored.recorder.finalize();
  } finally {
    await closeAndAudit(restored, "processes/rec-002-restored.json");
  }
}

async function launchApp(options: {
  readonly name: string;
  readonly userDataRoot: string;
  readonly seed: boolean;
  readonly appRoot?: string;
  readonly runRoot?: string;
  readonly evidenceRoot?: string;
  readonly tempRoot?: string;
}): Promise<LaunchResult> {
  const startedAt = new Date().toISOString();
  const appRoot = path.resolve(options.appRoot ?? SOURCE_ROOT);
  const app = await launchPersistentE2EApp({
    userDataDir: options.userDataRoot,
    seed: options.seed,
    appRoot,
    extraEnv: {
      ...acceptanceEnvironment(options.runRoot ?? RUN_ROOT, options.evidenceRoot ?? EVIDENCE_ROOT),
      ...(options.tempRoot ? { TEMP: options.tempRoot, TMP: options.tempRoot } : {}),
    },
  });
  const logs = captureProcessLogs(app, options.name);
  const page = await app.firstWindow();
  await page.waitForFunction(
    () => typeof window.runtimeAcceptanceAPI?.getBridgeInfo === "function",
    undefined,
    { timeout: 30_000 },
  );
  await page.locator('[data-testid="chat-panel"]').waitFor({ timeout: 30_000 });
  const client = new RuntimeAcceptanceClient(app, page, SCOPE);
  const bridge = await client.value("getBridgeInfo");
  const paths = await client.value("getPaths");
  const processProof = await captureProcessProof({
    app,
    page,
    bridge,
    appRoot,
    userDataRoot: options.userDataRoot,
  });
  if (Object.values(processProof.assertions).some((value) => !value)) {
    throw new Error(`Electron process identity proof failed: ${JSON.stringify(processProof)}`);
  }
  const recorder = new LiveStoryRecorder(EVIDENCE_ROOT, {
    processId: bridge.mainProcessPid,
    userDataDirectory: paths.electronUserDataRoot,
    appDataDirectory: paths.marshalAppDataRoot,
  });
  return {
    name: options.name,
    startedAt,
    appRoot,
    app,
    page,
    client,
    paths,
    bridge,
    recorder,
    logs,
    processProof,
  };
}

async function closeAndAudit(launch: LaunchResult, relativeEvidencePath: string): Promise<void> {
  const trackedPids = launch.processProof.processTree.map((entry) => entry.pid);
  let closeError: unknown;
  try {
    await launch.app.close();
  } catch (error) {
    closeError = error;
  } finally {
    await launch.logs.close();
  }
  await waitForPidsToExit(trackedPids, 20_000);
  const leakedPids = trackedPids.filter(isProcessAlive);
  const lifecycleEvents = readJsonLines(
    path.join(launch.paths.marshalAppDataRoot, "marshal-process-lifecycle.jsonl"),
  ).filter((entry) => String(entry.timestamp) >= launch.startedAt);
  const lifecycleHiddenErrors = lifecycleEvents
    .filter((entry) =>
      /^process\.(?:uncaughtException|unhandledRejection)/.test(String(entry.event)),
    )
    .map((entry) => String(entry.event));
  const stdout = readText(launch.logs.stdoutPath);
  const stderr = readText(launch.logs.stderrPath);
  const logHiddenErrors = [stdout, stderr]
    .flatMap(
      (text) =>
        text.match(
          /(?:UnhandledPromiseRejection|ERR_UNHANDLED_REJECTION|uncaught exception|unhandled rejection|FATAL ERROR)/gi,
        ) ?? [],
    )
    .map(String);
  const hiddenErrors = [...lifecycleHiddenErrors, ...logHiddenErrors];
  const audit: ProcessAudit = {
    processProof: launch.processProof,
    lifecycleEvents,
    hiddenErrors,
    leakedPids,
    stdoutPath: normalizeEvidencePath(launch.logs.stdoutPath),
    stderrPath: normalizeEvidencePath(launch.logs.stderrPath),
  };
  writeJson(path.join(EVIDENCE_ROOT, relativeEvidencePath), audit);
  if (closeError) throw closeError;
  expect(leakedPids).toEqual([]);
  expect(hiddenErrors).toEqual([]);
}

async function captureProcessProof(input: {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly bridge: RuntimeAcceptanceBridgeInfo;
  readonly appRoot: string;
  readonly userDataRoot: string;
}): Promise<ProcessProof> {
  const launcherPid = requiredNumber(input.app.process().pid, "launcherPid");
  const electronIdentity = await input.app.evaluate(({ app }) => ({
    pid: process.pid,
    ppid: process.ppid,
    execPath: process.execPath,
    appPath: app.getAppPath(),
    userData: app.getPath("userData"),
    isPackaged: app.isPackaged,
  }));
  const rendererIdentity = await input.page.evaluate(() => ({
    location: window.location.href,
    userAgent: navigator.userAgent,
    runtimeAcceptanceBridgePresent:
      typeof window.runtimeAcceptanceAPI?.getBridgeInfo === "function",
    runtimeUiBridgePresent: typeof window.runtimeUiAPI?.getSnapshot === "function",
  }));
  const processes = captureProcessTable();
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const fullLineage = processLineage(input.bridge.mainProcessPid, byPid);
  const launcherIndex = fullLineage.findIndex((entry) => entry.pid === launcherPid);
  const lineage = launcherIndex === -1 ? fullLineage : fullLineage.slice(0, launcherIndex + 1);
  const processTree = processDescendants(launcherPid, processes);
  const commandLines = lineage.map((entry) => entry.commandLine);
  const forbiddenSource = path.resolve("Q:\\src\\marshal");
  return {
    capturedAt: new Date().toISOString(),
    launcherPid,
    mainPid: input.bridge.mainProcessPid,
    appRoot: input.appRoot,
    userDataRoot: input.userDataRoot,
    electronIdentity,
    rendererIdentity,
    backendIdentity: input.bridge.backendIdentity,
    lineage,
    processTree,
    assertions: {
      mainIsLive:
        byPid.has(input.bridge.mainProcessPid) && isProcessAlive(input.bridge.mainProcessPid),
      mainDescendsFromLauncher:
        input.bridge.mainProcessPid === launcherPid ||
        lineage.some((entry) => entry.pid === launcherPid),
      commandLineReferencesAppRoot: commandLines.some((value) =>
        commandLineReferencesPath(value, input.appRoot),
      ),
      commandLineReferencesUserData: commandLines.some((value) =>
        commandLineReferencesPath(value, input.userDataRoot),
      ),
      commandLineExcludesForbiddenSource:
        !pathsEqual(forbiddenSource, input.appRoot) &&
        !commandLines.some((value) => commandLineReferencesPath(value, forbiddenSource)),
      evaluatedAppPathMatches: pathsEqual(electronIdentity.appPath, input.appRoot),
      rendererBridgePresent:
        rendererIdentity.runtimeAcceptanceBridgePresent && rendererIdentity.runtimeUiBridgePresent,
    },
  };
}

function materializeSourceApp(name: string): string {
  const appRoot = path.join(RUN_ROOT, "source-apps", name);
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

function runtimeEntrypoint(appRoot: string): string {
  const manifest = record(readJson(path.join(appRoot, ".marshal-runtime-packs", "manifest.json")));
  const runtime = record(manifest.runtime);
  return path.join(
    appRoot,
    "node_modules",
    ...requiredString(runtime.name, "runtime.name").split("/"),
    requiredString(runtime.entrypoint, "runtime.entrypoint"),
  );
}

function captureProcessTable(): readonly ProcessRecord[] {
  if (process.platform === "win32") {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$items = @(Get-CimInstance Win32_Process | ForEach-Object {",
      "  [ordered]@{",
      "    pid = [int]$_.ProcessId",
      "    ppid = [int]$_.ParentProcessId",
      "    name = [string]$_.Name",
      "    executablePathBase64 = if ($null -eq $_.ExecutablePath) { $null } else { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_.ExecutablePath)) }",
      "    commandLineBase64 = if ($null -eq $_.CommandLine) { '' } else { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_.CommandLine)) }",
      "  }",
      "})",
      "ConvertTo-Json -Compress -Depth 3 -InputObject $items",
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
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed)) throw new Error("Windows process table did not return an array.");
    return parsed.map((entry) => {
      const value = record(entry);
      return {
        pid: Number(value.pid),
        ppid: Number(value.ppid),
        name: typeof value.name === "string" ? value.name : "",
        executablePath:
          typeof value.executablePathBase64 === "string"
            ? Buffer.from(value.executablePathBase64, "base64").toString("utf8")
            : null,
        commandLine:
          typeof value.commandLineBase64 === "string"
            ? Buffer.from(value.commandLineBase64, "base64").toString("utf8")
            : "",
      };
    });
  }
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
    }));
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

async function waitForPidsToExit(pids: readonly number[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await waitForPidsUntil(pids, deadline);
}

async function waitForPidsUntil(pids: readonly number[], deadline: number): Promise<void> {
  if (Date.now() >= deadline || !pids.some(isProcessAlive)) return;
  await new Promise((resolve) => setTimeout(resolve, 100));
  await waitForPidsUntil(pids, deadline);
}

function captureProcessLogs(app: ElectronApplication, name: string): ProcessLogs {
  const directory = path.join(EVIDENCE_ROOT, "processes");
  fs.mkdirSync(directory, { recursive: true });
  const stdoutPath = path.join(directory, `${name}-stdout.log`);
  const stderrPath = path.join(directory, `${name}-stderr.log`);
  const stdout = fs.createWriteStream(stdoutPath, { flags: "a" });
  const stderr = fs.createWriteStream(stderrPath, { flags: "a" });
  const processStdout = app.process().stdout;
  const processStderr = app.process().stderr;
  processStdout?.pipe(stdout);
  processStderr?.pipe(stderr);
  return {
    stdoutPath,
    stderrPath,
    async close() {
      processStdout?.unpipe(stdout);
      processStderr?.unpipe(stderr);
      await Promise.all([
        new Promise<void>((resolve) => stdout.end(resolve)),
        new Promise<void>((resolve) => stderr.end(resolve)),
      ]);
    },
  };
}

function ipcValue(value: unknown): Record<string, unknown> {
  const envelope = record(value);
  if (envelope.success !== true) {
    const error = record(envelope.error);
    throw new Error(`${String(error.code)}: ${String(error.message)}`);
  }
  return record(envelope.value);
}

function treeManifest(root: string): readonly string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else files.push(path.relative(root, target).split(path.sep).join("/"));
    }
  };
  visit(root);
  return files.sort();
}

function readJsonLines(filePath: string): readonly Record<string, unknown>[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => record(JSON.parse(line) as unknown));
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function readText(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function fileSha256(filePath: string): string {
  return sha256(fs.readFileSync(filePath));
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function linkDirectory(source: string, target: string): void {
  fs.symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
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

function normalizeEvidencePath(value: string): string {
  return path.relative(EVIDENCE_ROOT, value).split(path.sep).join("/");
}

function acceptanceEnvironment(
  runRoot: string,
  evidenceRoot: string,
): Readonly<Record<string, string>> {
  return {
    MARSHAL_RUNTIME_ACCEPTANCE: "1",
    MARSHAL_RUNTIME_ACCEPTANCE_TOKEN: requiredEnvironment("MARSHAL_RUNTIME_ACCEPTANCE_TOKEN"),
    MARSHAL_RUNTIME_ACCEPTANCE_PROFILE: "default",
    MARSHAL_RUNTIME_ACCEPTANCE_RUN_ROOT: runRoot,
    MARSHAL_RUNTIME_ACCEPTANCE_EVIDENCE_ROOT: evidenceRoot,
  };
}

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function requiredPath(name: string): string {
  const value = requiredEnvironment(name);
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return path.resolve(value);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return value;
}
