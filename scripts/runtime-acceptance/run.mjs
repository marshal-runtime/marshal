import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getCopilotCliConfigPath } from "../../electron/backend/copilot/cli-paths.mjs";
import { buildStoryMap, parseRuntimeAcceptanceContract } from "./contract.mjs";
import { resolveRuntimePlatformRoot, runStaticGates } from "./static-gates.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const options = parseArgs(process.argv.slice(2));
const SOURCE_ROOT = path.resolve(options.sourceRoot ?? path.resolve(__dirname, "..", ".."));
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runsRoot = path.resolve(
  options.outputRoot ??
    process.env.MARSHAL_RUNTIME_ACCEPTANCE_RUNS_ROOT ??
    path.join(os.tmpdir(), "marshal-runtime-live-runs"),
);
const runRoot = path.join(runsRoot, runId);
const snapshotRoot = path.join(runRoot, "source-snapshot");
const normalSourceRoot = path.join(runRoot, "normal-source-app");
const packagedSourceRoot = path.join(runRoot, "packaged-source-app");
const evidenceRoot = path.join(runRoot, "evidence");
const logsRoot = path.join(evidenceRoot, "supporting-commands");
const tempRoot = path.join(runRoot, "temp");
const homeRoot = path.join(runRoot, "home");
const appDataRoot = path.join(runRoot, "app-data");
const localAppDataRoot = path.join(runRoot, "local-app-data");
const contractRelative = path.join(
  "scripts",
  "runtime-acceptance",
  "marshal-runtime-live-user-stories.md",
);
const platformRoot = resolveRuntimePlatformRoot({ repoRoot: SOURCE_ROOT });
const bugLedgerSeedPath = process.env.MARSHAL_RUNTIME_ACCEPTANCE_BUG_LEDGER?.trim()
  ? path.resolve(process.env.MARSHAL_RUNTIME_ACCEPTANCE_BUG_LEDGER)
  : null;
const acceptanceToken = randomBytes(32).toString("hex");
const boundedHostCluster = new Set([
  "MRT-HAR-001",
  "MRT-HAR-002",
  "MRT-BOOT-001",
  "MRT-BOOT-002",
  "MRT-BOOT-003",
  "MRT-BOOT-004",
  "MRT-BOOT-005",
  "MRT-BOOT-006",
  "MRT-BOOT-007",
  "MRT-BOOT-008",
]);
const extensionCluster = new Set(
  Array.from({ length: 13 }, (_, index) => `MRT-EXT-${String(index + 1).padStart(3, "0")}`),
);
const uiApiContextCluster = new Set([
  ...Array.from({ length: 11 }, (_, index) => `MRT-UI-${String(index + 1).padStart(3, "0")}`),
  "MRT-API-001",
  "MRT-API-002",
  "MRT-CTX-001",
  "MRT-CTX-002",
]);
const typescriptLegacyCluster = new Set([
  "MRT-TS-001",
  "MRT-TS-002",
  "MRT-TS-003",
  "MRT-TS-004",
  "MRT-LEG-001",
]);
const runtimeClosureCluster = new Set([
  ...boundedHostCluster,
  ...typescriptLegacyCluster,
  "MRT-UI-002",
]);
const agentMemoryBrainProviderRecoveryCluster = new Set([
  ...Array.from({ length: 8 }, (_, index) => `MRT-AGT-${String(index + 1).padStart(3, "0")}`),
  ...Array.from({ length: 7 }, (_, index) => `MRT-MEM-${String(index + 1).padStart(3, "0")}`),
  ...Array.from({ length: 5 }, (_, index) => `MRT-BRN-${String(index + 1).padStart(3, "0")}`),
  "MRT-REC-001",
  "MRT-REC-002",
]);

for (const directory of [
  runRoot,
  snapshotRoot,
  evidenceRoot,
  logsRoot,
  tempRoot,
  homeRoot,
  appDataRoot,
  localAppDataRoot,
]) {
  fs.mkdirSync(directory, { recursive: true });
}

const runEnvironment = {
  ...process.env,
  TEMP: tempRoot,
  TMP: tempRoot,
  HOME: homeRoot,
  USERPROFILE: homeRoot,
  APPDATA: appDataRoot,
  LOCALAPPDATA: localAppDataRoot,
  TEST_WORKER_INDEX: "0",
  MARSHAL_RUNTIME_ACCEPTANCE_BUILD: "1",
  MARSHAL_RUNTIME_ACCEPTANCE: "1",
  MARSHAL_RUNTIME_ACCEPTANCE_TOKEN: acceptanceToken,
  MARSHAL_RUNTIME_ACCEPTANCE_NODE_EXECUTABLE: process.execPath,
  MARSHAL_RUNTIME_ACCEPTANCE_RUN_ROOT: runRoot,
  MARSHAL_RUNTIME_ACCEPTANCE_EVIDENCE_ROOT: evidenceRoot,
  MARSHAL_RUNTIME_ACCEPTANCE_NORMAL_SOURCE_ROOT: normalSourceRoot,
  MARSHAL_RUNTIME_ACCEPTANCE_STORIES: options.stories.join(","),
  PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(evidenceRoot, "playwright-report"),
};

const bugs = bugLedgerSeedPath ? loadBugLedger(bugLedgerSeedPath) : [];
const seededBugIds = new Set(bugs.map((bug) => bug.id));
const commandRecords = [];
let failure = null;
let authoritativeBefore = null;
let authoritativeUnchanged = false;
let sourceSnapshotUnchanged = false;
let snapshot = null;
let sourceBefore = null;
let storyMap = null;
let runPassed = false;
let finalFailure = null;

try {
  authoritativeBefore = captureAuthoritativeState();
  writeJson(path.join(evidenceRoot, "authoritative-state-before.json"), authoritativeBefore);
  snapshot = copySourceSnapshot(SOURCE_ROOT, snapshotRoot);
  linkDependencies(SOURCE_ROOT, snapshotRoot);
  sourceBefore = sourceManifest(snapshotRoot, snapshot);
  writeJson(path.join(evidenceRoot, "source-manifest-before.json"), sourceBefore);
  writeJson(path.join(evidenceRoot, "environment.json"), {
    runId,
    sourceRoot: SOURCE_ROOT,
    snapshotRoot,
    runRoot,
    evidenceRoot,
    homeRoot,
    appDataRoot,
    localAppDataRoot,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    pnpm: commandOutput(pnpmCommand(), ["--version"], SOURCE_ROOT),
    git: commandOutput("git", ["--version"], SOURCE_ROOT),
    hostHead: authoritativeBefore.host.head,
    platformHead: authoritativeBefore.platform?.head ?? null,
    platformRoot,
    mode: options.mode,
    selectedStories: options.stories,
    bugLedgerSeedPath,
    acceptanceTokenSha256: createHash("sha256").update(acceptanceToken).digest("hex"),
  });

  const stories = parseRuntimeAcceptanceContract(path.join(snapshotRoot, contractRelative));
  storyMap = buildStoryMap(stories);
  writeJson(path.join(evidenceRoot, "story-map.json"), storyMap);
  writeJson(
    path.join(evidenceRoot, "story-ledger.initial.json"),
    ledger(storyMap, {}, options.stories),
  );

  {
    runCommand(
      "verify-marshal-runtime",
      process.execPath,
      ["scripts/prepare-marshal-runtime.mjs", "--verify", "--installed"],
      snapshotRoot,
      runEnvironment,
    );
    runCommand(
      "normal-vite-build",
      process.execPath,
      [path.join(SOURCE_ROOT, "node_modules", "vite", "bin", "vite.js"), "build"],
      snapshotRoot,
      {
        ...runEnvironment,
        MARSHAL_RUNTIME_ACCEPTANCE_BUILD: "0",
      },
    );
    const normalDistRoot = path.join(runRoot, "normal-dist-electron");
    fs.cpSync(path.join(snapshotRoot, "dist-electron"), normalDistRoot, { recursive: true });
    copyBuiltSourceApp(snapshotRoot, normalSourceRoot, snapshot);
    const staticResult = runStaticGates({
      repoRoot: snapshotRoot,
      normalDistRoot,
      normalRendererRoot: path.join(snapshotRoot, "dist"),
      runRoot,
      platformRoot,
    });
    writeJson(path.join(evidenceRoot, "static-gates.json"), staticResult);
    if (!staticResult.pass) throw new Error("Marshal Runtime static gates failed.");
  }

  if (options.mode === "source" || options.mode === "host" || options.mode === "all") {
    runCommand(
      "runtime-host-support-tests",
      process.execPath,
      [
        path.join(SOURCE_ROOT, "node_modules", "vitest", "vitest.mjs"),
        "run",
        "--project",
        "node",
        "electron/marshal-runtime/host.test.ts",
        "electron/marshal-runtime/runtime-package-loader.test.ts",
        "electron/marshal-runtime/extensions.integration.test.ts",
        "electron/marshal-runtime/agentic-debugger-extension.integration.test.ts",
        "electron/marshal-runtime/providers.test.ts",
        "electron/marshal-runtime/production-adapter.test.ts",
        "electron/marshal-runtime/ui-controller.test.ts",
        "electron/marshal-runtime/api.integration.test.ts",
        "electron/marshal-runtime/agent-provider.test.ts",
        "electron/filesystem-memory-store.test.ts",
      ],
      snapshotRoot,
      runEnvironment,
    );
    runCommand(
      "runtime-session-metadata-regression",
      process.execPath,
      [
        path.join(SOURCE_ROOT, "node_modules", "vitest", "vitest.mjs"),
        "run",
        "--project",
        "node",
        "electron/sessions.test.ts",
        "-t",
        "preserves reasoning effort and runtime agent role in the session index",
      ],
      snapshotRoot,
      runEnvironment,
    );
    runCommand(
      "runtime-disposal-supporting-evidence",
      process.execPath,
      ["scripts/runtime-acceptance/supporting.mjs"],
      snapshotRoot,
      runEnvironment,
    );
    runCommand(
      "acceptance-vite-build",
      process.execPath,
      [path.join(SOURCE_ROOT, "node_modules", "vite", "bin", "vite.js"), "build"],
      snapshotRoot,
      runEnvironment,
    );
    assertAcceptanceBuild(snapshotRoot);
    const playwrightFiles = selectPlaywrightFiles(options.stories);
    if (playwrightFiles.length > 0) {
      runCommand(
        "live-electron-playwright",
        process.execPath,
        [
          path.join(SOURCE_ROOT, "node_modules", "@playwright", "test", "cli.js"),
          "test",
          ...playwrightFiles,
          "--project=electron",
          "--workers=1",
          "--retries=0",
          "--reporter=list",
          "--output",
          path.join(evidenceRoot, "playwright-artifacts"),
        ],
        snapshotRoot,
        runEnvironment,
      );
    }
  }

  if (options.mode === "platform" || options.mode === "all") {
    const platformRunRoot = path.join(evidenceRoot, "platform");
    const platformArgs = [
      path.join(platformRoot, "scripts", "platform-acceptance.mjs"),
      "--run-root",
      platformRunRoot,
      "--host-worktree",
      SOURCE_ROOT,
      "--contract",
      path.join(SOURCE_ROOT, contractRelative),
      "--session-id",
      process.env.COPILOT_SESSION_ID ?? runId,
    ];
    if (process.env.MARSHAL_RUNTIME_PLATFORM_PNPM_SEED_STORE?.trim()) {
      platformArgs.push(
        "--pnpm-seed-store",
        path.resolve(process.env.MARSHAL_RUNTIME_PLATFORM_PNPM_SEED_STORE),
      );
    }
    runCommand(
      "platform-acceptance",
      process.execPath,
      platformArgs,
      platformRoot,
      runEnvironment,
      [0, 1, 2],
    );
    if (!fs.existsSync(path.join(platformRunRoot, "story-ledger.json"))) {
      throw new Error("Platform acceptance exited without a story ledger.");
    }
  }

  if (
    options.mode === "packaged" ||
    ((options.mode === "host" || options.mode === "all") &&
      (options.stories.length === 0 ||
        options.stories.some((story) => story === "MRT-HAR-001" || story === "MRT-BOOT-005")))
  ) {
    runPackagedIfAvailable(snapshotRoot, runEnvironment);
  }

  const liveResults = readJsonIfPresent(
    path.join(evidenceRoot, "stories", "live-story-results.json"),
  );
  const staticResult = readJsonIfPresent(path.join(evidenceRoot, "static-gates.json"));
  const platformResult = readJsonIfPresent(
    path.join(evidenceRoot, "platform", "story-ledger.json"),
  );
  const packagedResult = readJsonIfPresent(path.join(evidenceRoot, "packaged-result.json"));
  const statuses = collectStatuses(liveResults, staticResult, platformResult, packagedResult);
  applySourceDeferredStatuses(statuses, options.mode, liveResults, staticResult, packagedResult);
  materializeDirectStoryRecords({
    storyMap,
    selectedStories: options.stories,
    statuses,
    liveResults,
    staticResult,
    platformResult,
    packagedResult,
  });
  writeJson(
    path.join(evidenceRoot, "story-ledger.final.json"),
    ledger(storyMap, statuses, options.stories),
  );
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  const productBugs = readJsonIfPresent(path.join(evidenceRoot, "product-bugs.json"));
  if (Array.isArray(productBugs)) bugs.push(...productBugs);
  const platformBugs = readJsonIfPresent(path.join(evidenceRoot, "platform", "bug-ledger.json"));
  if (Array.isArray(platformBugs?.bugs)) {
    for (const bug of platformBugs.bugs) {
      if (!bugs.some((candidate) => candidate.id === bug.id)) bugs.push(bug);
    }
  }

  if (storyMap && !fs.existsSync(path.join(evidenceRoot, "story-ledger.final.json"))) {
    const liveResults = readJsonIfPresent(
      path.join(evidenceRoot, "stories", "live-story-results.json"),
    );
    const staticResult = readJsonIfPresent(path.join(evidenceRoot, "static-gates.json"));
    const platformResult = readJsonIfPresent(
      path.join(evidenceRoot, "platform", "story-ledger.json"),
    );
    const packagedResult = readJsonIfPresent(path.join(evidenceRoot, "packaged-result.json"));
    const statuses = collectStatuses(liveResults, staticResult, platformResult, packagedResult);
    applySourceDeferredStatuses(statuses, options.mode, liveResults, staticResult, packagedResult);
    materializeDirectStoryRecords({
      storyMap,
      selectedStories: options.stories,
      statuses,
      liveResults,
      staticResult,
      platformResult,
      packagedResult,
    });
    writeJson(
      path.join(evidenceRoot, "story-ledger.final.json"),
      ledger(storyMap, statuses, options.stories),
    );
  }

  if (snapshot && sourceBefore) {
    try {
      const sourceAfter = sourceManifest(snapshotRoot, snapshot);
      writeJson(path.join(evidenceRoot, "source-manifest-after.json"), sourceAfter);
      sourceSnapshotUnchanged = sourceBefore.digest === sourceAfter.digest;
      if (!sourceSnapshotUnchanged) {
        recordHarnessFailure("Immutable source snapshot changed during the acceptance run.");
      }
    } catch (error) {
      recordHarnessFailure(`Failed to capture source after-state: ${errorMessage(error)}`);
    }
  }

  if (authoritativeBefore) {
    try {
      const authoritativeAfter = captureAuthoritativeState();
      writeJson(path.join(evidenceRoot, "authoritative-state-after.json"), authoritativeAfter);
      authoritativeUnchanged =
        JSON.stringify(authoritativeBefore) === JSON.stringify(authoritativeAfter);
      if (!authoritativeUnchanged) {
        recordHarnessFailure("An authoritative worktree changed during the acceptance run.");
      }
    } catch (error) {
      recordHarnessFailure(`Failed to capture authoritative after-state: ${errorMessage(error)}`);
    }
  }

  const finalLedger = readJsonIfPresent(path.join(evidenceRoot, "story-ledger.final.json"));
  const storyCounts = countStatuses(finalLedger?.stories ?? []);
  const failedStories = unacceptableStories(finalLedger?.stories ?? [], options);
  const failedCommands = commandRecords.filter((command) => !command.accepted);
  reconcileSeededBugs(bugs, seededBugIds, finalLedger, runId);
  if (failure) recordHarnessBug(failure);
  writeJson(path.join(evidenceRoot, "bugs.json"), bugs);
  runPassed =
    !failure &&
    authoritativeUnchanged &&
    sourceSnapshotUnchanged &&
    failedCommands.length === 0 &&
    failedStories.length === 0;
  finalFailure =
    failure ??
    (failedStories.length > 0
      ? `${failedStories.length} selected story result(s) were not accepted.`
      : null);
  writeJson(path.join(evidenceRoot, "run-result.json"), {
    runId,
    status: runPassed ? "COMPLETED" : "FAILED",
    pass: runPassed,
    failure: finalFailure,
    mode: options.mode,
    selectedStories: options.stories,
    runRoot,
    evidenceRoot,
    authoritativeUnchanged,
    authoritativeRuntimeUnchanged: authoritativeUnchanged,
    sourceSnapshotUnchanged,
    commands: commandRecords,
    failedCommandCount: failedCommands.length,
    failedStoryCount: failedStories.length,
    failedStories,
    storyCounts,
  });
}

process.stdout.write(
  `${JSON.stringify({ runId, runRoot, evidenceRoot, failure: finalFailure }, null, 2)}\n`,
);
if (!runPassed) process.exitCode = 1;

function parseArgs(args) {
  let mode = "source";
  let stories = [];
  let sourceRoot = null;
  let outputRoot = null;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--mode" && args[index + 1]) mode = args[++index];
    if (args[index] === "--source-root" && args[index + 1]) sourceRoot = args[++index];
    if (args[index] === "--output-root" && args[index + 1]) outputRoot = args[++index];
    if (args[index] === "--stories" && args[index + 1]) {
      stories = args[++index]
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    }
  }
  if (!["source", "static", "platform", "packaged", "host", "all"].includes(mode)) {
    throw new Error(`Unsupported acceptance mode: ${mode}`);
  }
  return { mode, stories, sourceRoot, outputRoot };
}

function selectPlaywrightFiles(stories) {
  const selected = stories.length > 0 ? stories : [...runtimeClosureCluster];
  const files = [];
  if (selected.some((story) => boundedHostCluster.has(story) && story !== "MRT-BOOT-005")) {
    files.push("e2e/marshal-runtime-live.test.ts");
  }
  if (selected.some((story) => typescriptLegacyCluster.has(story))) {
    files.push("e2e/marshal-runtime-live-stories.test.ts");
  }
  if (selected.some((story) => extensionCluster.has(story))) {
    files.push("e2e/marshal-runtime-live-ext.test.ts");
  }
  if (selected.some((story) => uiApiContextCluster.has(story))) {
    files.push("e2e/marshal-runtime-live-ui-api-ctx.test.ts");
  }
  if (selected.some((story) => agentMemoryBrainProviderRecoveryCluster.has(story))) {
    files.push("e2e/marshal-runtime-live-agt-mem-brn-rec.test.ts");
  }
  if (selected.some((story) => /^MRT-(KRN|PUI)-/.test(story))) {
    files.push("e2e/marshal-runtime-live-actors.test.ts");
  }
  return [...new Set(files)];
}

function copySourceSnapshot(sourceRoot, targetRoot) {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: sourceRoot, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(result.stderr.toString("utf8"));
  const listedFiles = result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((relative) => !relative.startsWith("node_modules/"));
  const files = [];
  const deletions = [];
  for (const relative of listedFiles) {
    const source = path.join(sourceRoot, relative);
    if (!fs.existsSync(source)) {
      deletions.push(relative);
      continue;
    }
    const target = path.join(targetRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.lstatSync(source).isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(source), target);
    } else {
      fs.copyFileSync(source, target);
    }
    files.push(relative);
  }
  return { files, deletions };
}

function linkDependencies(sourceRoot, targetRoot) {
  const source = path.join(sourceRoot, "node_modules");
  const target = path.join(targetRoot, "node_modules");
  fs.symlinkSync(source, target, "junction");
}

function copyBuiltSourceApp(sourceRoot, targetRoot, snapshot) {
  fs.mkdirSync(targetRoot, { recursive: true });
  for (const relative of snapshot.files) {
    const source = path.join(sourceRoot, relative);
    if (!fs.existsSync(source)) continue;
    const target = path.join(targetRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.lstatSync(source).isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(source), target);
    } else {
      fs.copyFileSync(source, target);
    }
  }
  for (const directory of ["dist", "dist-electron"]) {
    const target = path.join(targetRoot, directory);
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(path.join(sourceRoot, directory), target, { recursive: true });
  }
  linkDependencies(SOURCE_ROOT, targetRoot);
}

function copyPackagingInputs(sourceRoot, targetRoot) {
  const copied = [];
  for (const relative of ["node-bin", "workspace"]) {
    const source = path.join(sourceRoot, relative);
    if (!fs.existsSync(source)) continue;
    const target = path.join(targetRoot, relative);
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(source, target, { recursive: true, dereference: true });
    copied.push({
      path: relative.split(path.sep).join("/"),
      fileCount: listFilesRecursive(target).length,
      digest: directoryDigest(target),
    });
  }
  if (!copied.some((entry) => entry.path === "node-bin")) {
    throw new Error("The bundled Node packaging input was unavailable.");
  }
  return { generatedAt: new Date().toISOString(), copied };
}

function listFilesRecursive(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) files.push(target);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function directoryDigest(root) {
  const hash = createHash("sha256");
  for (const filePath of listFilesRecursive(root)) {
    hash.update(path.relative(root, filePath).split(path.sep).join("/"));
    hash.update("\0");
    hash.update(fs.readFileSync(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function sourceManifest(root, snapshot) {
  const entries = snapshot.files
    .filter((relative) => fs.existsSync(path.join(root, relative)))
    .map((relative) => ({
      path: relative.split(path.sep).join("/"),
      sha256: createHash("sha256")
        .update(fs.readFileSync(path.join(root, relative)))
        .digest("hex"),
    }));
  const digest = createHash("sha256")
    .update(JSON.stringify({ entries, deletions: snapshot.deletions }))
    .digest("hex");
  return {
    generatedAt: new Date().toISOString(),
    digest,
    entries,
    deletions: snapshot.deletions,
  };
}

function captureAuthoritativeState() {
  return {
    host: gitState(SOURCE_ROOT),
    platform: fs.existsSync(platformRoot) ? gitState(platformRoot) : null,
  };
}

function gitState(root) {
  return {
    root,
    head: commandOutput("git", ["rev-parse", "HEAD"], root),
    status: commandOutput("git", ["status", "--short"], root),
    diffStat: commandOutput("git", ["diff", "--stat"], root),
  };
}

function commandOutput(command, args, cwd) {
  const invocation = resolveInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function runCommand(name, command, args, cwd, env, acceptedExitCodes = [0]) {
  const startedAt = new Date().toISOString();
  const invocation = resolveInvocation(command, args, env);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    shell: process.platform === "win32" && invocation.command.toLowerCase().endsWith(".bat"),
  });
  const record = {
    name,
    command,
    args,
    cwd,
    startedAt,
    completedAt: new Date().toISOString(),
    exitCode: result.status,
    signal: result.signal,
    accepted: acceptedExitCodes.includes(result.status),
    stdoutPath: path.join(logsRoot, `${name}.stdout.log`),
    stderrPath: path.join(logsRoot, `${name}.stderr.log`),
  };
  commandRecords.push(record);
  writeJson(path.join(logsRoot, `${name}.json`), record);
  fs.writeFileSync(path.join(logsRoot, `${name}.stdout.log`), result.stdout ?? "");
  fs.writeFileSync(path.join(logsRoot, `${name}.stderr.log`), result.stderr ?? "");
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (!acceptedExitCodes.includes(result.status)) {
    throw new Error(`${name} failed with exit code ${result.status}.`);
  }
}

function assertAcceptanceBuild(root) {
  const preload = path.join(root, "dist-electron", "runtime-acceptance-preload.cjs");
  const main = path.join(root, "dist-electron", "main.js");
  if (!fs.existsSync(preload)) throw new Error("Acceptance preload was not emitted.");
  if (!fs.readFileSync(main, "utf8").includes("acceptance.harness.created")) {
    throw new Error("Acceptance main bundle marker was not emitted.");
  }
}

function runPackagedIfAvailable(root, env) {
  try {
    copyBuiltSourceApp(root, packagedSourceRoot, snapshot);
    const packagingInputs = copyPackagingInputs(SOURCE_ROOT, packagedSourceRoot);
    writeJson(path.join(evidenceRoot, "packaging-inputs.json"), packagingInputs);
    const packagedEnvironment = {
      ...env,
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      MARSHAL_RUNTIME_ACCEPTANCE_BUILD: "0",
    };
    for (const variable of [
      "MARSHAL_E2E",
      "MARSHAL_RUNTIME_ACCEPTANCE",
      "MARSHAL_RUNTIME_ACCEPTANCE_TOKEN",
      "MARSHAL_RUNTIME_ACCEPTANCE_PRELOAD_TOKEN",
      "MARSHAL_RUNTIME_ACCEPTANCE_NODE_EXECUTABLE",
      "MARSHAL_RUNTIME_ACCEPTANCE_RUN_ROOT",
      "MARSHAL_RUNTIME_ACCEPTANCE_EVIDENCE_ROOT",
      "MARSHAL_RUNTIME_ACCEPTANCE_NORMAL_SOURCE_ROOT",
      "MARSHAL_RUNTIME_ACCEPTANCE_STORIES",
    ]) {
      delete packagedEnvironment[variable];
    }
    runCommand(
      "packaged-prebuild",
      pnpmCommand(),
      ["run", "prebuild"],
      packagedSourceRoot,
      packagedEnvironment,
    );
    runCommand(
      "packaged-vite-build",
      process.execPath,
      [path.join(SOURCE_ROOT, "node_modules", "vite", "bin", "vite.js"), "build"],
      packagedSourceRoot,
      packagedEnvironment,
    );
    runCommand(
      "packaged-electron-builder",
      process.execPath,
      [path.join(SOURCE_ROOT, "node_modules", "electron-builder", "out", "cli", "cli.js"), "--dir"],
      packagedSourceRoot,
      packagedEnvironment,
    );
    const executablePath = findPackagedExecutable(path.join(packagedSourceRoot, "release"));
    runCommand(
      "packaged-fuse-check",
      process.execPath,
      ["scripts/marshal-verify-fuses.cjs", executablePath],
      packagedSourceRoot,
      packagedEnvironment,
    );
    const configuredAuthConfigPath = process.env.MARSHAL_RUNTIME_ACCEPTANCE_AUTH_CONFIG?.trim();
    const authConfigPath = configuredAuthConfigPath
      ? path.resolve(configuredAuthConfigPath)
      : getCopilotCliConfigPath();
    if (!fs.existsSync(authConfigPath)) {
      throw new Error("Authenticated production backend config was not available.");
    }
    const freshSourceCapabilityEvidencePath = path.join(
      evidenceRoot,
      "stories",
      "MRT-HAR-001.json",
    );
    const sourceCapabilityEvidencePath = fs.existsSync(freshSourceCapabilityEvidencePath)
      ? freshSourceCapabilityEvidencePath
      : process.env.MARSHAL_RUNTIME_ACCEPTANCE_SOURCE_CAPABILITY_EVIDENCE?.trim();
    if (!sourceCapabilityEvidencePath || !fs.existsSync(sourceCapabilityEvidencePath)) {
      throw new Error("Authoritative source capability evidence was not available.");
    }
    runCommand(
      "packaged-smoke",
      process.execPath,
      [
        "scripts/runtime-acceptance/packaged-smoke.mjs",
        "--executable",
        executablePath,
        "--evidence-root",
        path.join(evidenceRoot, "packaged"),
        "--builder-root",
        packagedSourceRoot,
        "--auth-config",
        authConfigPath,
        "--source-capability-evidence",
        path.resolve(sourceCapabilityEvidencePath),
      ],
      root,
      packagedEnvironment,
    );
    const smoke = readJsonIfPresent(path.join(evidenceRoot, "packaged", "packaged-smoke.json"));
    writeJson(path.join(evidenceRoot, "packaged-result.json"), {
      status: smoke?.status === "PASS" ? "PASS" : "FAIL",
      executablePath,
      smoke,
    });
    const realBackend = smoke?.launches?.find(
      (launch) => launch.case === "packaged-authenticated-production-agent",
    );
    writeJson(path.join(evidenceRoot, "real-backend-result.json"), {
      status:
        realBackend?.status === "PASS" &&
        realBackend?.agentEvidence?.backendProof?.authStatus === "authenticated" &&
        realBackend?.agentEvidence?.capability?.invocationSucceeded === true
          ? "PASS"
          : "FAIL",
      evidence:
        "packaged/packaged-authenticated-production-agent/e2e-real/runtime-story-results.json",
      backendProof: realBackend?.agentEvidence?.backendProof ?? null,
      capability: realBackend?.agentEvidence?.capability ?? null,
    });
  } catch (error) {
    writeJson(path.join(evidenceRoot, "packaged-result.json"), {
      status: "FAIL",
      reason: errorMessage(error),
    });
    writeJson(path.join(evidenceRoot, "real-backend-result.json"), {
      status: "FAIL",
      reason: errorMessage(error),
    });
  }
}

function findPackagedExecutable(releaseRoot) {
  const candidates = [];
  const pending = [releaseRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || !fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.name.toLowerCase() === "marshal.exe") candidates.push(absolute);
    }
  }
  if (candidates.length !== 1) {
    throw new Error(`Expected one packaged Marshal.exe, found ${candidates.length}.`);
  }
  return candidates[0];
}

function collectStatuses(liveResults, staticResult, platformResult, packagedResult) {
  const statuses = Object.fromEntries(
    (liveResults?.stories ?? [])
      .filter((story) => ["PASS", "FAIL", "BLOCKED"].includes(story.status))
      .map((story) => [story.id, story]),
  );
  for (const result of staticResult?.storyResults ?? []) {
    if (!["PASS", "FAIL", "BLOCKED"].includes(result.status)) continue;
    if (!statuses[result.id] || statuses[result.id].status === "BLOCKED") {
      statuses[result.id] = result;
    }
  }
  for (const result of platformResult?.stories ?? []) {
    if (!["PASS", "FAIL", "BLOCKED"].includes(result.contractStatus)) continue;
    const status = result.contractStatus;
    if (!statuses[result.id] || status === "FAIL") {
      statuses[result.id] = {
        id: result.id,
        status,
        evidence: [`platform/${result.artifact}`],
      };
    }
  }
  const harnessResult = (liveResults?.stories ?? []).find(
    (story) => story.id === "MRT-HAR-002" && story.status === "EVIDENCE_CAPTURED",
  );
  if (harnessResult && staticResult?.pass) {
    statuses["MRT-HAR-002"] = {
      id: "MRT-HAR-002",
      status: "PASS",
      evidence: [...new Set([...harnessResult.evidence, "static-gates.json"])],
    };
  }
  const packagedHarnessResult = packagedResult?.smoke?.stories?.find(
    (story) => story.id === "MRT-HAR-001" && story.status === "EVIDENCE_CAPTURED",
  );
  const sourceHarnessResult = (liveResults?.stories ?? []).find(
    (story) => story.id === "MRT-HAR-001" && story.status === "EVIDENCE_CAPTURED",
  );
  if (packagedHarnessResult && sourceHarnessResult && staticResult?.pass) {
    statuses["MRT-HAR-001"] = {
      id: "MRT-HAR-001",
      status: "PASS",
      evidence: [
        ...new Set([
          ...sourceHarnessResult.evidence,
          ...packagedHarnessResult.evidence,
          "static-gates.json",
          "packaged-result.json",
        ]),
      ],
    };
  } else if (packagedResult?.status === "BLOCKED") {
    statuses["MRT-HAR-001"] = {
      id: "MRT-HAR-001",
      status: "BLOCKED",
      reason: packagedResult.reason,
      evidence: ["packaged-result.json"],
    };
  } else if (packagedResult?.status === "FAIL") {
    statuses["MRT-HAR-001"] = {
      id: "MRT-HAR-001",
      status: "FAIL",
      reason: packagedResult.reason ?? "Packaged confinement validation failed.",
      evidence: ["packaged-result.json"],
    };
  }
  const packagedBootResult = packagedResult?.smoke?.stories?.find(
    (story) => story.id === "MRT-BOOT-005",
  );
  if (packagedBootResult?.status === "PASS") {
    statuses["MRT-BOOT-005"] = {
      id: "MRT-BOOT-005",
      status: "PASS",
      evidence: [
        ...new Set([
          ...packagedBootResult.evidence,
          "packaged-result.json",
          "real-backend-result.json",
        ]),
      ],
    };
  } else if (packagedResult?.status === "FAIL") {
    statuses["MRT-BOOT-005"] = {
      id: "MRT-BOOT-005",
      status: "FAIL",
      reason: packagedResult.reason ?? "Packaged runtime validation failed.",
      evidence: ["packaged-result.json", "real-backend-result.json"],
    };
  }
  const portableSwarmLiveResult = (liveResults?.stories ?? []).find(
    (story) => story.id === "MRT-LEG-001" && story.status === "EVIDENCE_CAPTURED",
  );
  const portableSwarmPlatformResult = (platformResult?.stories ?? []).find(
    (story) => story.id === "MRT-LEG-001" && story.runtimeSideStatus === "PASS",
  );
  if (portableSwarmLiveResult && portableSwarmPlatformResult && staticResult?.pass) {
    statuses["MRT-LEG-001"] = {
      id: "MRT-LEG-001",
      status: "PASS",
      evidence: [
        ...new Set([
          ...portableSwarmLiveResult.evidence,
          "static-gates.json",
          `platform/${portableSwarmPlatformResult.artifact}`,
        ]),
      ],
    };
  }
  return statuses;
}

function materializeDirectStoryRecords({
  storyMap,
  selectedStories,
  statuses,
  staticResult,
  platformResult,
  packagedResult,
}) {
  const selected = new Set(selectedStories);
  const contracts = new Map(storyMap.map((story) => [story.id, story]));
  const storiesRoot = path.join(evidenceRoot, "stories");
  fs.mkdirSync(storiesRoot, { recursive: true });

  if (selected.has("MRT-PRV-001") && statuses["MRT-PRV-001"]?.status === "PASS") {
    const provenance = staticCheckDetails(staticResult, "provenance.closure-consistent");
    const assertions = {
      manifestPinInstalledAndLockAgree:
        provenance.pass === true &&
        provenance.packageCount === 16 &&
        provenance.packages.every(
          (entry) =>
            entry.packagingRevision === true &&
            entry.packageManifest?.name === entry.name &&
            entry.packageManifest?.version === entry.version &&
            entry.packageReference === entry.expectedReference &&
            entry.lockfileReferencePresent === true &&
            entry.generatedPinPresent === true,
        ),
      platformSourceAttestationMatches: provenance.platformAttestation?.pass === true,
      everyArchiveEntrypointAndContentDigestMatches: provenance.packages.every(
        (entry) =>
          entry.archiveSha256 === entry.expectedArchiveSha256 &&
          entry.entrySha256 === entry.expectedEntrySha256 &&
          entry.installedContentSha256 === entry.expectedContentSha256 &&
          entry.archiveContentSha256 === entry.expectedContentSha256,
      ),
      noMarshalRegistryOrNetworkFallback: provenance.registryFallbackLines?.length === 0,
      offlineVerificationPassed: provenance.offlineVerification?.exitCode === 0,
    };
    writeDirectStoryRecord("MRT-PRV-001", contracts, {
      assertions,
      actions: [
        "verify installed Marshal Runtime closure offline",
        "independently recompute archive, entrypoint, content, dirty-diff, and source-tree hashes",
        "compare manifest, generated pin, installed packages, and lockfile resolution",
      ],
      proof: provenance,
      supportingEvidence: [
        "static-gates.json",
        "source-manifest-before.json",
        "source-manifest-after.json",
        "authoritative-state-before.json",
        "authoritative-state-after.json",
        "supporting-commands/verify-marshal-runtime.stdout.log",
        "supporting-commands/verify-marshal-runtime.stderr.log",
      ],
    });
  }

  if (selected.has("MRT-PRV-002") && statuses["MRT-PRV-002"]?.status === "PASS") {
    const variants =
      staticCheckDetails(staticResult, "provenance.negative-variants-fail-closed").variants ?? [];
    const assertions = {
      allEightMutationsExecuted: variants.length === 8,
      everyVerifyFailedWithMatchingSanitizedReason: variants.every(
        (variant) => variant.exitCode !== 0 && variant.pass === true,
      ),
      everyPrebuildStoppedBeforeBuild: variants.every(
        (variant) => variant.prebuildExitCode !== 0 && variant.laterBuildArtifacts.length === 0,
      ),
      authoritativeInputsStayedUnchanged: variants.every(
        (variant) => variant.authoritativeBefore === variant.authoritativeAfter,
      ),
      everyDisposableFixtureActuallyChanged: variants.every(
        (variant) => variant.beforeMutationSha256 !== variant.afterMutationSha256,
      ),
    };
    writeDirectStoryRecord("MRT-PRV-002", contracts, {
      assertions,
      actions: variants.map((variant) => `mutate disposable closure: ${variant.id}`),
      proof: { variants },
      supportingEvidence: [
        "static-gates.json",
        "source-manifest-before.json",
        "source-manifest-after.json",
        "authoritative-state-before.json",
        "authoritative-state-after.json",
      ],
    });
  }

  if (selected.has("MRT-HAR-001") && statuses["MRT-HAR-001"]?.status === "PASS") {
    const sourcePath = path.join(storiesRoot, "MRT-HAR-001.json");
    const source = readJsonIfPresent(sourcePath);
    const packagedStory = packagedResult?.smoke?.stories?.find(
      (story) => story.id === "MRT-HAR-001",
    );
    if (source?.status === "EVIDENCE_CAPTURED" && packagedStory?.status === "EVIDENCE_CAPTURED") {
      const sourceComponentPath = path.join(storiesRoot, "components", "MRT-HAR-001-source.json");
      writeJson(sourceComponentPath, source);
      const packagedChecks = packagedResult.smoke.checks ?? [];
      const staticChecks = staticResult?.checks ?? [];
      const normalBuildChecks = staticChecks.filter((entry) =>
        entry.id.startsWith("normal-build."),
      );
      const shippingScanChecks = packagedChecks.filter((entry) =>
        entry.id.startsWith("shipping-scan."),
      );
      const archiveAbsenceChecks = packagedChecks.filter(
        (entry) =>
          entry.id === "builder.excludes-acceptance-preload" ||
          entry.id === "asar.acceptance-entry-absent",
      );
      const assertions = {
        normalAndPartialSourceCasesExposeNoAcceptanceSurface:
          source.assertions?.normalAndPartialGateGlobalAbsent === true &&
          source.assertions?.normalAndPartialGateChannelsAbsent === true &&
          source.assertions?.missingTokenUnavailable === true &&
          source.assertions?.wrongTokenRejected === true &&
          source.assertions?.allGateProcessesExited === true,
        fullyGatedUnpackagedAcceptanceSourceExposesBridge:
          source.proof?.fullyGatedAcceptance?.compileTimeGate === true &&
          source.proof?.fullyGatedAcceptance?.runtimeGates?.tokenAuthenticated === true,
        packagedCasesExposeNoAcceptanceSurface:
          packagedResult.smoke.launches?.every(
            (launch) =>
              launch.status === "PASS" &&
              launch.globals?.runtimeAcceptanceApiType === "undefined" &&
              launch.ipcInventory?.channels?.every(
                (channel) => !channel.startsWith("runtime-acceptance:"),
              ),
          ) === true,
        normalBuildContainsNoAcceptanceMarkers:
          normalBuildChecks.length > 0 && normalBuildChecks.every((entry) => entry.pass === true),
        packagedShippingSurfacesContainNoAcceptanceMarkers:
          shippingScanChecks.length === 4 &&
          shippingScanChecks.every((entry) => entry.pass === true),
        packagedAsarAndUnpackedArchivesExcludeAcceptancePreload:
          archiveAbsenceChecks.length === 2 &&
          archiveAbsenceChecks.every((entry) => entry.pass === true),
      };
      writeDirectStoryRecord("MRT-HAR-001", contracts, {
        assertions,
        context: {
          processId: source.processId,
          userDataDirectory: source.userDataDirectory,
          appDataDirectory: source.appDataDirectory,
        },
        actions: [...(source.actions ?? []), "inspect and launch shipping-equivalent package"],
        proof: {
          source: source.proof,
          packaged: packagedResult.smoke,
          staticChecks: staticChecks.filter(
            (entry) =>
              entry.id.startsWith("bridge.") ||
              entry.id.startsWith("normal-build.") ||
              entry.id.startsWith("contract."),
          ),
        },
        supportingEvidence: [
          "stories/components/MRT-HAR-001-source.json",
          ...(packagedStory.evidence ?? []),
          "packaged-result.json",
          "static-gates.json",
        ],
      });
    }
  }

  if (selected.has("MRT-BOOT-005") && statuses["MRT-BOOT-005"]?.status === "PASS") {
    const smoke = packagedResult?.smoke;
    const packagedStory = smoke?.stories?.find((story) => story.id === "MRT-BOOT-005");
    const realLaunch = smoke?.launches?.find(
      (launch) => launch.case === "packaged-authenticated-production-agent",
    );
    const check = (id) => smoke?.checks?.find((entry) => entry.id === id)?.pass === true;
    if (packagedStory?.status === "PASS" && realLaunch?.status === "PASS") {
      const loadedModulePaths = [
        realLaunch.runtimeEvidence?.moduleLoading?.details?.modulePath,
        ...(realLaunch.runtimeEvidence?.verifiedPackages?.details?.packages ?? []).map(
          (entry) => entry.entrypoint,
        ),
      ].filter((entry) => typeof entry === "string");
      const assertions = {
        allRuntimePackagesLoadFromAsarUnpacked:
          check("unpacked-runtime.all-27-packages-present") &&
          loadedModulePaths.length === 28 &&
          loadedModulePaths.every((modulePath) =>
            /app\.asar\.unpacked\/node_modules\/@(marshal|quillstone)\//.test(
              modulePath.toLowerCase().replaceAll("\\", "/"),
            ),
          ),
        builderIncludesMarshalPackages:
          check("builder.files-includes-marshal-packages") &&
          check("builder.asar-unpack-includes-marshal-packages"),
        packagedHostReachedRunning: realLaunch.runtimeEvidence?.pass === true,
        signedInProductRuntimeSearchAndInvokeSucceeded:
          check("production-agent.authenticated") &&
          check("production-agent.invoked-runtime-capability") &&
          realLaunch.agentEvidence?.capability?.invocationSucceeded === true,
        sourceAndPackagedCapabilityNamesMatch: check(
          "production-agent.source-packaged-capability-names-match",
        ),
        noAcceptancePreloadGlobalOrChannel:
          realLaunch.globals?.runtimeAcceptanceApiType === "undefined" &&
          realLaunch.ipcInventory?.channels?.every(
            (channel) => !channel.startsWith("runtime-acceptance:"),
          ) === true &&
          check("builder.excludes-acceptance-preload") &&
          check("asar.acceptance-entry-absent"),
      };
      writeDirectStoryRecord("MRT-BOOT-005", contracts, {
        assertions,
        context: {
          processId: realLaunch.launcherPid,
          userDataDirectory: realLaunch.userData,
          appDataDirectory: realLaunch.homeRoot,
        },
        actions: [
          "build shipping-equivalent packaged Marshal",
          "launch with fresh user-data and debug port",
          "inspect bridge and IPC absence",
          "run signed-in production runtime search and invoke through the normal UI",
        ],
        proof: {
          executablePath: smoke.executablePath,
          resourcesRoot: smoke.resourcesRoot,
          packageRoot: smoke.packageRoot,
          checks: smoke.checks,
          realLaunch,
        },
        supportingEvidence: [
          ...(packagedStory.evidence ?? []),
          "packaged-result.json",
          "real-backend-result.json",
        ],
      });
    }
  }

  const platformDirectStoryIds = new Set([
    "MRT-KRN-001",
    "MRT-KRN-002",
    "MRT-KRN-003",
    "MRT-PUI-001",
    "MRT-PUI-002",
    "MRT-PUI-003",
    "MRT-PUI-004",
    "MRT-PUI-005",
    "MRT-LEG-002",
  ]);
  for (const storyId of platformDirectStoryIds) {
    if (!selected.has(storyId) || statuses[storyId]?.status !== "PASS") continue;
    const platformEntry = platformResult?.stories?.find((story) => story.id === storyId);
    const platformPath = platformEntry?.artifact
      ? path.join(evidenceRoot, "platform", platformEntry.artifact)
      : null;
    const platformStory = platformPath ? readJsonIfPresent(platformPath) : null;
    if (
      platformEntry?.runtimeSideStatus === "PASS" &&
      platformEntry.contractStatus === "PASS" &&
      platformStory
    ) {
      const assertions = Object.fromEntries(
        (platformStory.assertions ?? []).map((assertion) => [
          assertion.name,
          assertion.passed === true,
        ]),
      );
      if (Object.keys(assertions).length === 0) {
        throw new Error(`Platform story ${storyId} has no direct assertions.`);
      }
      writeDirectStoryRecord(storyId, contracts, {
        assertions,
        context: {
          processId: platformStory.mainPid,
          userDataDirectory: null,
          appDataDirectory: null,
        },
        actions: platformStory.exactActions ?? [],
        proof: platformStory,
        supportingEvidence: [`platform/${platformEntry.artifact}`],
      });
    }
  }
}

function staticCheckDetails(staticResult, id) {
  const check = staticResult?.checks?.find((entry) => entry.id === id);
  if (!check?.pass) throw new Error(`Static evidence check did not pass: ${id}`);
  return check.details;
}

function writeDirectStoryRecord(storyId, contracts, options) {
  const contract = contracts.get(storyId);
  if (!contract) throw new Error(`Missing contract for direct story record: ${storyId}`);
  const failed = Object.entries(options.assertions).filter(([, value]) => value !== true);
  if (failed.length > 0) {
    throw new Error(
      `Direct story record assertions failed for ${storyId}: ${failed
        .map(([name]) => name)
        .join(", ")}`,
    );
  }
  const now = new Date().toISOString();
  writeJson(path.join(evidenceRoot, "stories", `${storyId}.json`), {
    stableId: storyId,
    status: "PASS",
    startedAt: now,
    completedAt: now,
    evidenceClass: normalizeEvidenceClass(contract.evidenceClass),
    processId: options.context?.processId ?? process.pid,
    userDataDirectory: options.context?.userDataDirectory ?? null,
    appDataDirectory: options.context?.appDataDirectory ?? null,
    actions: options.actions,
    rawResultEnvelopes: options.proof,
    assertions: options.assertions,
    artifactLinks: options.supportingEvidence,
    proof: options.proof,
    supportingEvidence: options.supportingEvidence,
  });
}

function normalizeEvidenceClass(value) {
  const supported = [
    "LIVE-ELECTRON",
    "LIVE-REAL-BACKEND",
    "LIVE-PACKAGED",
    "NODE-INTEGRATION",
    "UNIT",
    "STATIC",
  ];
  const classes = supported.filter((candidate) => String(value).includes(candidate));
  return classes.length > 0 ? classes.join("+") : String(value).trim();
}

function applySourceDeferredStatuses(statuses, mode, liveResults, staticResult, packagedResult) {
  if (mode !== "source" || packagedResult) return;
  const sourceHarnessResult = (liveResults?.stories ?? []).find(
    (story) => story.id === "MRT-HAR-001" && story.status === "EVIDENCE_CAPTURED",
  );
  if (sourceHarnessResult && staticResult?.pass) {
    statuses["MRT-HAR-001"] = {
      id: "MRT-HAR-001",
      status: "BLOCKED",
      reason:
        "Source gate-matrix and static confinement criteria passed; packaged bridge absence remains assigned to the later packaged campaign.",
      evidence: [...new Set([...sourceHarnessResult.evidence, "static-gates.json"])],
    };
  }
  statuses["MRT-BOOT-005"] = {
    id: "MRT-BOOT-005",
    status: "BLOCKED",
    reason:
      "Packaged launch and authenticated real-backend evidence are assigned to the later packaged campaign.",
    evidence: ["static-gates.json"],
  };
}

function ledger(stories, statuses, selectedStories) {
  const selected = new Set(selectedStories);
  return {
    generatedAt: new Date().toISOString(),
    contractStoryCount: stories.length,
    stories: stories.map((story) => {
      const result = statuses[story.id];
      if (selected.size > 0 && !selected.has(story.id)) {
        return { id: story.id, status: "NOT RUN", reason: "Not selected for this subset." };
      }
      return (
        result ?? {
          id: story.id,
          status: "NOT RUN",
          reason: "No complete evidence-gated execution was recorded by this run.",
        }
      );
    }),
  };
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function resolveInvocation(command, args, env = process.env) {
  if (process.platform !== "win32" || command.toLowerCase() !== "pnpm.cmd") {
    return { command, args };
  }
  const corepackEntrypoint = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "corepack",
    "dist",
    "pnpm.js",
  );
  const entrypoint =
    env.npm_execpath ?? (fs.existsSync(corepackEntrypoint) ? corepackEntrypoint : null);
  if (!entrypoint) throw new Error("Unable to resolve the pnpm entrypoint.");
  return { command: process.execPath, args: [entrypoint, ...args] };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadBugLedger(filePath) {
  const value = readJsonIfPresent(filePath);
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value.bugs)) return value.bugs;
  throw new Error(
    `Runtime acceptance bug ledger must be an array or a document with a bugs array: ${filePath}`,
  );
}

function countStatuses(stories) {
  const counts = {};
  for (const story of stories) {
    const status = typeof story?.status === "string" ? story.status : "UNKNOWN";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function unacceptableStories(stories, runOptions) {
  const selected = new Set(runOptions.stories);
  const assessed =
    selected.size > 0
      ? stories.filter((story) => selected.has(story.id))
      : stories.filter((story) => story.status !== "NOT RUN");
  return assessed.filter((story) => {
    if (story.status === "PASS") return false;
    return !(
      runOptions.mode === "source" &&
      story.status === "BLOCKED" &&
      (story.id === "MRT-HAR-001" || story.id === "MRT-BOOT-005")
    );
  });
}

function reconcileSeededBugs(allBugs, seedIds, finalLedger, fixedByRunId) {
  const verifiedStories = new Set(
    (finalLedger?.stories ?? [])
      .filter((story) => story.status === "PASS")
      .map((story) => story.id),
  );
  for (let index = 0; index < allBugs.length; index += 1) {
    const bug = allBugs[index];
    if (!seedIds.has(bug.id) || bug.status !== "open" || !verifiedStories.has(bug.storyId)) {
      continue;
    }
    allBugs[index] = {
      ...bug,
      status: "fixed",
      fixedAt: new Date().toISOString(),
      fixedByRunId,
    };
  }
}

function recordHarnessFailure(summary) {
  if (!failure) failure = summary;
  recordHarnessBug(summary);
}

function recordHarnessBug(summary) {
  if (bugs.some((bug) => bug.kind === "harness" && bug.summary === summary)) return;
  bugs.push({
    id: `HARNESS-${String(bugs.filter((bug) => bug.kind === "harness").length + 1).padStart(3, "0")}`,
    kind: "harness",
    status: "open",
    summary,
    capturedAt: new Date().toISOString(),
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
