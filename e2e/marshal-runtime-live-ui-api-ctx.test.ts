import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { expect, test, type ElectronApplication, type Page } from "@playwright/test";

import type {
  RuntimeAcceptanceBridgeInfo,
  RuntimeAcceptancePaths,
} from "../common/runtime-acceptance";
import { RUNTIME_SELF_TOOL_NAMES } from "../electron/marshal-runtime/runtime-self-tools";
import { E2E_DATA_DIR } from "../electron/mock-mode";
import { launchPersistentE2EApp, seedTestData } from "./marshal-fixtures";
import {
  runApiContextScenarios,
  type RuntimeStartupFailureProof,
} from "./runtime-acceptance/core-scenarios";
import { LiveStoryRecorder, RuntimeAcceptanceClient, record } from "./runtime-acceptance/harness";
import { runUiScenarios } from "./runtime-acceptance/ui-scenarios";

const RUN_ROOT = requiredPath("MARSHAL_RUNTIME_ACCEPTANCE_RUN_ROOT");
const EVIDENCE_ROOT = requiredPath("MARSHAL_RUNTIME_ACCEPTANCE_EVIDENCE_ROOT");
const PRIMARY_USER_DATA_ROOT = path.join(RUN_ROOT, "electron-user-data-ui-api-ctx");
const CAPACITY_USER_DATA_ROOT = path.join(RUN_ROOT, "electron-user-data-ui-capacity");
const PRISTINE_E2E_DATA_ROOT = path.join(RUN_ROOT, "fixtures", "pristine-e2e-data");
const SCOPE = { sessionId: "e2e-fresh", workspaceName: "marshal" } as const;
const UI_STORIES = new Set(
  Array.from({ length: 11 }, (_, index) => `MRT-UI-${String(index + 1).padStart(3, "0")}`),
);
const API_CONTEXT_STORIES = new Set(["MRT-API-001", "MRT-API-002", "MRT-CTX-001", "MRT-CTX-002"]);
const SELECTED_STORIES = new Set(
  (process.env.MARSHAL_RUNTIME_ACCEPTANCE_STORIES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const activeApps = new Set<ElectronApplication>();
const lifecycleLogPaths = new Set<string>();
const processLifecycleOffsets = new Map<string, number>();
const closeResults: CloseResult[] = [];
let launchSequence = 0;

test.afterEach(async () => {
  await Promise.allSettled([...activeApps].map((app) => app.close()));
  activeApps.clear();
});

test("runs the bounded live UI API and context campaign", async () => {
  test.setTimeout(45 * 60_000);
  await runCampaign();
  expect(closeResults.length).toBeGreaterThan(0);
});

async function runCampaign(): Promise<void> {
  process.env.MARSHAL_E2E_WORKSPACE_CANCELLATION = "1";

  seedTestData();
  fs.rmSync(PRISTINE_E2E_DATA_ROOT, { recursive: true, force: true });
  fs.cpSync(E2E_DATA_DIR, PRISTINE_E2E_DATA_ROOT, { recursive: true });
  let current = await launchApp("ui-api-ctx-initial", PRIMARY_USER_DATA_ROOT, false);
  const uiRecorder = current.recorder;
  const uiStoryIds = selectedFrom(UI_STORIES, "MRT-UI-006");
  if (uiStoryIds.size > 0) {
    await runUiScenarios({
      app: current.app,
      page: current.page,
      recorder: uiRecorder,
      evidenceRoot: EVIDENCE_ROOT,
      storyIds: uiStoryIds,
      restartElectronApp: async (app) => {
        if (app !== current.app) throw new Error("Runtime UI restart app identity drifted.");
        const userDataDir = current.paths.electronUserDataRoot;
        closeResults.push(await closeLaunch(current));
        current = await launchApp(`ui-api-ctx-restart-${++launchSequence}`, userDataDir, false);
        return { app: current.app, page: current.page, userDataDir };
      },
    });
    uiRecorder.finalize();
  }

  const apiContextStoryIds = selectedFrom(API_CONTEXT_STORIES);
  if (apiContextStoryIds.size > 0) {
    await runApiContextScenarios({
      client: current.client,
      page: current.page,
      recorder: current.recorder,
      storyIds: apiContextStoryIds,
      runRuntimeStartupFailure: apiContextStoryIds.has("MRT-API-001")
        ? runRuntimeStartupFailure
        : undefined,
    });
    current.recorder.finalize();
  }

  closeResults.push(await closeLaunch(current));

  if (shouldRun("MRT-UI-006")) {
    const capacity = await launchApp("ui-capacity", CAPACITY_USER_DATA_ROOT, true);
    try {
      await runUiScenarios({
        app: capacity.app,
        page: capacity.page,
        recorder: capacity.recorder,
        evidenceRoot: EVIDENCE_ROOT,
        storyIds: new Set(["MRT-UI-006"]),
      });
      capacity.recorder.finalize();
    } finally {
      closeResults.push(await closeLaunch(capacity));
    }
  }

  const lifecycleAudit = auditLifecycleEvidence();
  fs.writeFileSync(
    path.join(EVIDENCE_ROOT, "ui-api-ctx-lifecycle-audit.json"),
    JSON.stringify({ ...lifecycleAudit, closeResults }, null, 2),
  );
  expect(closeResults.every((result) => result.aliveAfter.length === 0)).toBe(true);
  expect(lifecycleAudit.hiddenFailures).toEqual([]);
}

async function runRuntimeStartupFailure(): Promise<RuntimeStartupFailureProof> {
  const isolatedTemp = path.join(RUN_ROOT, "temp", "api-001-startup-failure");
  const isolatedWorker = process.env.TEST_WORKER_INDEX ?? "0";
  const isolatedData = path.join(isolatedTemp, `marshal-e2e-data-${isolatedWorker}`);
  fs.rmSync(isolatedTemp, { recursive: true, force: true });
  fs.mkdirSync(isolatedTemp, { recursive: true });
  fs.cpSync(PRISTINE_E2E_DATA_ROOT, isolatedData, { recursive: true });
  const failure = await launchApp(
    "api-001-startup-failure",
    path.join(RUN_ROOT, "electron-user-data-api-001-startup-failure"),
    false,
    {
      TEMP: isolatedTemp,
      TMP: isolatedTemp,
      MARSHAL_RUNTIME_ACCEPTANCE_PROFILE: "runtime-startup-failure",
    },
  );
  try {
    const status = await failure.client.value("getStatus");
    const startupError = await failure.client.value("getStartupError");
    const selfTools = await failure.client.value("listRegisteredSelfTools");
    const ordinarySelfTools = await failure.client.value("listOrdinarySelfTools", SCOPE.sessionId);
    const fixture = await failure.client.value("materializeExtensionFixture", {
      profile: "echo",
    });
    const argumentsByTool: Readonly<Record<string, unknown>> = {
      runtimeSearch: { query: "marshal" },
      runtimeInvoke: {
        capability: "marshal.session.context",
        idempotencyKey: unique("api-001-failure-invoke"),
      },
      runtimeExecuteTypeScript: {
        acceptanceProfile: "search-capability",
        idempotencyKey: unique("api-001-failure-typescript"),
      },
      runtimeListExtensions: {},
      runtimeInstallExtension: {
        fixtureId: fixture.fixtureId,
        idempotencyKey: unique("api-001-failure-install"),
      },
      runtimeUpdateExtension: {
        identity: fixture.identity,
        fixtureId: fixture.fixtureId,
        idempotencyKey: unique("api-001-failure-update"),
      },
      runtimeEnableExtension: {
        identity: fixture.identity,
        idempotencyKey: unique("api-001-failure-enable"),
      },
      runtimeDisableExtension: {
        identity: fixture.identity,
        idempotencyKey: unique("api-001-failure-disable"),
      },
      runtimeRemoveExtension: {
        identity: fixture.identity,
        idempotencyKey: unique("api-001-failure-remove"),
      },
    };
    const runtimeResults = Object.fromEntries(
      await Promise.all(
        RUNTIME_SELF_TOOL_NAMES.map(async (name) => {
          const raw = await failure.client.value("invokeRegisteredSelfTool", {
            name,
            sessionId: SCOPE.sessionId,
            toolCallId: unique(`api-001-failure-${name}`),
            arguments: argumentsByTool[name],
          });
          return [name, JSON.parse(raw) as unknown] as const;
        }),
      ),
    );
    return {
      lifecycle: status.lifecycle,
      startupErrorCode: startupError?.code ?? null,
      selfTools,
      runtimeResults,
      ordinarySelfTools,
    };
  } finally {
    closeResults.push(await closeLaunch(failure));
  }
}

interface Launch {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly client: RuntimeAcceptanceClient;
  readonly recorder: LiveStoryRecorder;
  readonly bridgeInfo: RuntimeAcceptanceBridgeInfo;
  readonly paths: RuntimeAcceptancePaths;
  readonly label: string;
  readonly stdout: fs.WriteStream;
  readonly stderr: fs.WriteStream;
  readonly lifecycleStartLine: number;
  readonly processLifecycleStartLine: number;
}

interface CloseResult {
  readonly label: string;
  readonly pid: number;
  readonly lifecycleTypes: readonly string[];
  readonly aliveAfter: readonly number[];
}

async function launchApp(
  label: string,
  userDataDir: string,
  seed: boolean,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<Launch> {
  const app = await launchPersistentE2EApp({
    userDataDir,
    seed,
    extraEnv: {
      MARSHAL_RUNTIME_ACCEPTANCE: "1",
      MARSHAL_RUNTIME_ACCEPTANCE_PROFILE: "default",
      MARSHAL_RUNTIME_ACCEPTANCE_RUN_ROOT: RUN_ROOT,
      MARSHAL_RUNTIME_ACCEPTANCE_EVIDENCE_ROOT: EVIDENCE_ROOT,
      ...extraEnv,
    },
  });
  activeApps.add(app);
  const stdout = fs.createWriteStream(path.join(EVIDENCE_ROOT, `${label}-stdout.log`), {
    flags: "a",
  });
  const stderr = fs.createWriteStream(path.join(EVIDENCE_ROOT, `${label}-stderr.log`), {
    flags: "a",
  });
  app.process().stdout?.pipe(stdout);
  app.process().stderr?.pipe(stderr);
  const page = await app.firstWindow();
  await page.waitForFunction(
    () => typeof window.runtimeAcceptanceAPI?.getBridgeInfo === "function",
  );
  const client = new RuntimeAcceptanceClient(app, page, SCOPE);
  const bridgeInfo = await client.value("getBridgeInfo");
  const paths = await client.value("getPaths");
  const processLifecyclePath = path.join(
    paths.marshalAppDataRoot,
    "marshal-process-lifecycle.jsonl",
  );
  const processLifecycleStartLine = seed
    ? 0
    : (processLifecycleOffsets.get(processLifecyclePath) ?? 0);
  if (seed) processLifecycleOffsets.set(processLifecyclePath, 0);
  const lifecycleStartLine = readJsonLines(path.join(EVIDENCE_ROOT, "lifecycle.jsonl")).length;
  const launcherPid = app.process().pid;
  if (launcherPid === undefined) throw new Error(`Electron launcher PID is unavailable: ${label}`);
  const launchProcessTree = [launcherPid, ...processDescendantIds(launcherPid)];
  expect(launchProcessTree).toContain(bridgeInfo.mainProcessPid);
  expect(bridgeInfo.backendIdentity).toEqual({ runtimeId: "copilot", origin: "copilot" });
  appendProcessEvidence({ label, launcherPid, launchProcessTree, bridgeInfo, paths });
  return {
    app,
    page,
    client,
    recorder: new LiveStoryRecorder(EVIDENCE_ROOT, {
      processId: bridgeInfo.mainProcessPid,
      userDataDirectory: paths.electronUserDataRoot,
      appDataDirectory: paths.marshalAppDataRoot,
    }),
    bridgeInfo,
    paths,
    label,
    stdout,
    stderr,
    lifecycleStartLine,
    processLifecycleStartLine,
  };
}

async function closeLaunch(campaign: Launch): Promise<CloseResult> {
  const pid = campaign.bridgeInfo.mainProcessPid;
  const descendants = processDescendantIds(pid);
  const exited = waitForExit(campaign.app.process());
  await campaign.app.evaluate(({ app }) => app.quit()).catch(() => undefined);
  await Promise.race([exited, delay(10_000)]);
  if (isProcessAlive(pid)) {
    await campaign.app.close().catch(() => undefined);
    await Promise.race([exited, delay(10_000)]);
  }
  activeApps.delete(campaign.app);
  await Promise.all([
    new Promise<void>((resolve) => campaign.stdout.end(resolve)),
    new Promise<void>((resolve) => campaign.stderr.end(resolve)),
  ]);
  await waitForPidsToExit(descendants, 10_000);
  const sourceLifecyclePath = path.join(
    campaign.paths.marshalAppDataRoot,
    "marshal-process-lifecycle.jsonl",
  );
  const lifecycleSnapshotPath = path.join(
    EVIDENCE_ROOT,
    `${campaign.label}-process-lifecycle.jsonl`,
  );
  const allProcessLifecycleEntries = readJsonLines(sourceLifecyclePath);
  const processLifecycleEntries = allProcessLifecycleEntries.slice(
    campaign.processLifecycleStartLine,
  );
  processLifecycleOffsets.set(sourceLifecyclePath, allProcessLifecycleEntries.length);
  fs.writeFileSync(
    lifecycleSnapshotPath,
    processLifecycleEntries.map((entry) => JSON.stringify(entry)).join("\n") +
      (processLifecycleEntries.length > 0 ? "\n" : ""),
  );
  lifecycleLogPaths.add(lifecycleSnapshotPath);
  const lifecycleTypes = readJsonLines(path.join(EVIDENCE_ROOT, "lifecycle.jsonl"))
    .slice(campaign.lifecycleStartLine)
    .map((entry) => String(record(entry).type));
  const result = {
    label: campaign.label,
    pid,
    lifecycleTypes,
    aliveAfter: [pid, ...descendants].filter(isProcessAlive),
  };
  appendProcessEvidence({ event: "closed", ...result });
  return result;
}

function auditLifecycleEvidence(): {
  readonly hiddenFailures: readonly string[];
  readonly processEvents: readonly unknown[];
} {
  const processEvents = [...lifecycleLogPaths].flatMap((filePath) =>
    readJsonLines(filePath).map((entry) => ({ ...record(entry), filePath })),
  );
  const hiddenFailures = processEvents
    .filter((entry) =>
      ["process.unhandledRejection", "process.uncaughtException"].includes(
        String(record(entry).event),
      ),
    )
    .map((entry) => JSON.stringify(entry));
  for (const file of fs.readdirSync(EVIDENCE_ROOT).filter((name) => name.endsWith("-stderr.log"))) {
    const contents = fs.readFileSync(path.join(EVIDENCE_ROOT, file), "utf8");
    if (/UnhandledPromiseRejection|uncaught exception/i.test(contents)) {
      hiddenFailures.push(`${file}: hidden unhandled failure`);
    }
  }
  return { hiddenFailures, processEvents };
}

function selectedFrom(source: ReadonlySet<string>, excluded?: string): Set<string> {
  return new Set(
    [...source].filter(
      (storyId) =>
        storyId !== excluded && (SELECTED_STORIES.size === 0 || SELECTED_STORIES.has(storyId)),
    ),
  );
}

function shouldRun(storyId: string): boolean {
  return SELECTED_STORIES.size === 0 || SELECTED_STORIES.has(storyId);
}

function appendProcessEvidence(value: unknown): void {
  fs.appendFileSync(
    path.join(EVIDENCE_ROOT, "ui-api-ctx-processes.jsonl"),
    `${JSON.stringify(value)}\n`,
  );
}

function processDescendantIds(rootPid: number): readonly number[] {
  if (process.platform !== "win32") return [];
  const script = [
    "$all=Get-CimInstance Win32_Process",
    `$root=${rootPid}`,
    "$ids=[System.Collections.Generic.HashSet[int]]::new()",
    "[void]$ids.Add($root)",
    "do {",
    "  $before=$ids.Count",
    "  foreach($process in $all){if($ids.Contains([int]$process.ParentProcessId)){[void]$ids.Add([int]$process.ProcessId)}}",
    "} while($ids.Count -gt $before)",
    "$ids | Where-Object { $_ -ne $root } | Sort-Object | ConvertTo-Json -Compress",
  ].join(";");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) throw new Error(`Process observation failed: ${result.stderr}`);
  const parsed: unknown = result.stdout.trim() ? JSON.parse(result.stdout) : [];
  return (Array.isArray(parsed) ? parsed : [parsed]).map(Number).filter(Number.isSafeInteger);
}

function waitForExit(process: ReturnType<ElectronApplication["process"]>): Promise<void> {
  if (process.exitCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => process.once("exit", () => resolve()));
}

async function waitForPidsToExit(pids: readonly number[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(isProcessAlive) && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- process exit is polled until the bounded deadline
    await delay(100);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readJsonLines(filePath: string): readonly Record<string, unknown>[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line): unknown => JSON.parse(line))
    .filter(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function requiredPath(name: string): string {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return path.resolve(value);
}
