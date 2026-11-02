import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { getRawHeader } from "@electron/asar";
import { chromium } from "playwright";

import { findPackagedStartupFailure } from "./packaged-smoke-lifecycle.mjs";
import { resolvePackagedLifecycleRoot } from "./packaged-smoke-paths.mjs";
import { buildCaptureDescendantsScript, buildQueryProcessScript } from "./process-lineage.mjs";
import {
  buildAcceptanceSignatures,
  flattenAsarHeader,
  listFiles,
  scanShippingPaths,
} from "./shipping-scan.mjs";
import { readSourceCapabilityNames } from "./source-capability-evidence.mjs";

const executablePath = path.resolve(requiredArgument("--executable"));
const evidenceRoot = path.resolve(requiredArgument("--evidence-root"));
const builderRoot = path.resolve(requiredArgument("--builder-root"));
const authConfigPath = path.resolve(requiredArgument("--auth-config"));
const sourceCapabilityEvidencePath = path.resolve(requiredArgument("--source-capability-evidence"));
const packageRoot = path.dirname(executablePath);
const resourcesRoot = path.join(packageRoot, "resources");
const asarPath = path.join(resourcesRoot, "app.asar");
const unpackedRoot = path.join(resourcesRoot, "app.asar.unpacked");
const runtimeManifestPath = path.join(builderRoot, ".marshal-runtime-packs", "manifest.json");
const builderConfigPath = path.join(builderRoot, "electron-builder.json5");
const signatures = buildAcceptanceSignatures(builderRoot);
const expectedAcceptanceChannels = signatures
  .filter((signature) => signature.kind === "channel")
  .map((signature) => signature.value)
  .sort((left, right) => left.localeCompare(right));

fs.mkdirSync(evidenceRoot, { recursive: true });

const checks = [];
const launches = [];
let result;
try {
  requiredFile(executablePath);
  requiredFile(asarPath);
  requiredFile(runtimeManifestPath);
  requiredFile(builderConfigPath);
  requiredFile(authConfigPath);
  requiredFile(sourceCapabilityEvidencePath);

  const runtimeManifest = readJson(runtimeManifestPath);
  const sourceCapabilityEvidence = readJson(sourceCapabilityEvidencePath);
  const sourceCapabilityNames = readSourceCapabilityNames(sourceCapabilityEvidence);
  const expectedPackages = runtimeManifest.packages
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  recordCheck("runtime-manifest.declares-27-packages", expectedPackages.length === 27, {
    packageCount: expectedPackages.length,
    packages: expectedPackages,
  });
  recordCheck(
    "runtime-manifest.uses-current-intelligence-closure",
    expectedPackages.includes("@marshal/agent-runtime-code-intelligence") &&
      !expectedPackages.includes("@marshal/holographic-memory"),
    { packages: expectedPackages },
  );

  const builderConfig = fs.readFileSync(builderConfigPath, "utf8");
  recordCheck(
    "builder.files-includes-marshal-packages",
    builderConfig.includes('"node_modules/@marshal/**/*"'),
    {},
  );
  recordCheck(
    "builder.asar-unpack-includes-marshal-packages",
    builderConfig.includes('"node_modules/@marshal/**"'),
    {},
  );
  recordCheck(
    "builder.excludes-acceptance-preload",
    builderConfig.includes('"!dist-electron/runtime-acceptance-preload.cjs"'),
    {},
  );

  const entries = flattenAsarHeader(getRawHeader(asarPath).header);
  const asarListing = inspectAsarEntries(entries);
  writeJson(path.join(evidenceRoot, "asar-listing.json"), asarListing);
  recordCheck("asar.acceptance-entry-absent", asarListing.forbiddenEntries.length === 0, {
    forbiddenEntries: asarListing.forbiddenEntries,
  });
  recordCheck(
    "asar.runtime-packages-marked-unpacked",
    asarListing.runtimePackageFiles.length > 0 &&
      asarListing.runtimePackageFiles.every((entry) => entry.unpacked),
    {
      fileCount: asarListing.runtimePackageFiles.length,
      packedEntries: asarListing.runtimePackageFiles.filter((entry) => !entry.unpacked),
    },
  );
  const requiredRuntimeDependencyFiles = [
    "node_modules/which/package.json",
    "node_modules/isexe/index.js",
  ];
  const missingRuntimeDependencyFiles = requiredRuntimeDependencyFiles.filter(
    (requiredPath) => !asarListing.entries.includes(requiredPath),
  );
  recordCheck(
    "asar.cross-spawn-runtime-dependencies-present",
    missingRuntimeDependencyFiles.length === 0,
    { requiredRuntimeDependencyFiles, missingRuntimeDependencyFiles },
  );

  const archiveScan = scanAsarPackedEntries(entries);
  const builderInputScan = scanShippingPaths(
    [
      { label: "builder-renderer", path: path.join(builderRoot, "dist") },
      { label: "builder-electron", path: path.join(builderRoot, "dist-electron") },
      {
        label: "builder-runtime-packages",
        path: path.join(builderRoot, "node_modules", "@marshal"),
      },
    ],
    signatures,
  );
  const unpackedScan = scanShippingPaths(
    [{ label: "app.asar.unpacked", path: unpackedRoot }],
    signatures,
  );
  const packagedFileScan = scanShippingPaths(
    [{ label: "packaged-files", path: packageRoot }],
    signatures,
  );
  const scans = {
    signatureCount: signatures.length,
    signatures,
    builderInputs: builderInputScan,
    appAsar: archiveScan,
    appAsarUnpacked: unpackedScan,
    packagedFiles: packagedFileScan,
  };
  writeJson(path.join(evidenceRoot, "acceptance-signature-scans.json"), scans);
  for (const [name, scan] of Object.entries({
    builderInputs: builderInputScan,
    appAsar: archiveScan,
    appAsarUnpacked: unpackedScan,
    packagedFiles: packagedFileScan,
  })) {
    recordCheck(`shipping-scan.${name}.clean`, scan.hits.length === 0, {
      fileCount: scan.fileCount,
      hits: scan.hits,
    });
  }

  const unpackedPackageInventory = expectedPackages.map((name) => {
    const packagePath = path.join(unpackedRoot, "node_modules", ...name.split("/"));
    return {
      name,
      relativePath: normalizePath(path.relative(resourcesRoot, packagePath)),
      present: fs.existsSync(packagePath),
      packageJsonPresent: fs.existsSync(path.join(packagePath, "package.json")),
      fileCount: fs.existsSync(packagePath) ? listFiles(packagePath).length : 0,
    };
  });
  writeJson(path.join(evidenceRoot, "runtime-package-inventory.json"), unpackedPackageInventory);
  recordCheck(
    "unpacked-runtime.all-27-packages-present",
    unpackedPackageInventory.every(
      (entry) => entry.present && entry.packageJsonPresent && entry.fileCount > 0,
    ),
    { packages: unpackedPackageInventory },
  );

  writeJson(path.join(evidenceRoot, "packaged-file-listing.json"), {
    root: packageRoot,
    files: listFiles(packageRoot).map((filePath) => {
      const stat = fs.statSync(filePath);
      return {
        path: normalizePath(path.relative(packageRoot, filePath)),
        size: stat.size,
      };
    }),
  });

  const artifactIdentity = {
    executable: fileIdentity(executablePath),
    appAsar: fileIdentity(asarPath),
    runtimeManifest: fileIdentity(runtimeManifestPath),
    packageRoot,
    resourcesRoot,
  };
  writeJson(path.join(evidenceRoot, "artifact-identity.json"), artifactIdentity);

  for (const entry of [
    { name: "packaged-neither-runtime-gate", e2e: false, acceptance: false },
    { name: "packaged-e2e-only", e2e: true, acceptance: false },
    { name: "packaged-acceptance-only", e2e: false, acceptance: true },
    { name: "packaged-both-runtime-gates", e2e: true, acceptance: true },
  ]) {
    launches.push(await runCase(entry, expectedPackages));
  }
  launches.push(
    await runCase(
      {
        name: "packaged-authenticated-production-agent",
        e2e: false,
        acceptance: false,
        authenticated: true,
        port: 9223,
      },
      expectedPackages,
    ),
  );

  const failedLaunches = launches.filter((launch) => launch.status !== "PASS");
  recordCheck("launches.all-pass", failedLaunches.length === 0, { failedLaunches });

  const realLaunch = launches.find(
    (launch) => launch.case === "packaged-authenticated-production-agent",
  );
  const packagedCapabilityNames = [realLaunch?.agentEvidence?.capability?.requested].filter(
    (name) => typeof name === "string",
  );
  const capabilityComparison = {
    generatedAt: new Date().toISOString(),
    sourceEvidence: fileIdentity(sourceCapabilityEvidencePath),
    sourceCapabilityNames,
    packagedCapabilityNames,
    matching:
      sourceCapabilityNames.includes("code.index.status") &&
      packagedCapabilityNames.includes("code.index.status"),
  };
  writeJson(
    path.join(evidenceRoot, "source-packaged-capability-comparison.json"),
    capabilityComparison,
  );
  recordCheck(
    "production-agent.source-packaged-capability-names-match",
    capabilityComparison.matching,
    capabilityComparison,
  );
  recordCheck(
    "production-agent.authenticated",
    realLaunch?.agentEvidence?.backendProof?.authStatus === "authenticated",
    { backendProof: realLaunch?.agentEvidence?.backendProof ?? null },
  );
  recordCheck(
    "production-agent.invoked-runtime-capability",
    realLaunch?.agentEvidence?.capability?.requested === "code.index.status" &&
      realLaunch?.agentEvidence?.capability?.invocationSucceeded === true &&
      toolNameMatches(realLaunch?.agentEvidence?.capability?.searchedBy, "runtimeSearch") &&
      toolNameMatches(realLaunch?.agentEvidence?.capability?.invokedBy, "runtimeInvoke"),
    { capability: realLaunch?.agentEvidence?.capability ?? null },
  );

  const status = checks.every((check) => check.pass) ? "PASS" : "FAIL";
  result = {
    generatedAt: new Date().toISOString(),
    status,
    executablePath,
    packageRoot,
    resourcesRoot,
    asarPath,
    checks,
    artifactIdentity,
    launches,
    stories: [
      {
        id: "MRT-HAR-001",
        status:
          checksForPrefixPass("shipping-scan.") && checksForPrefixPass("launches.")
            ? "EVIDENCE_CAPTURED"
            : "FAIL",
        evidence: [
          "packaged/packaged-smoke.json",
          "packaged/acceptance-signature-scans.json",
          "packaged/asar-listing.json",
        ],
      },
      {
        id: "MRT-BOOT-005",
        status:
          checksForPrefixPass("runtime-manifest.") &&
          checksForPrefixPass("builder.") &&
          checksForPrefixPass("unpacked-runtime.") &&
          checksForPrefixPass("production-agent.") &&
          realLaunch?.runtimeEvidence?.pass === true
            ? "PASS"
            : "FAIL",
        evidence: [
          "packaged/packaged-smoke.json",
          "packaged/runtime-package-inventory.json",
          "packaged/source-packaged-capability-comparison.json",
          "packaged/packaged-authenticated-production-agent/e2e-real/runtime-story-results.json",
          "packaged/packaged-authenticated-production-agent/process-lineage-after-agent.json",
        ],
      },
    ],
  };
} catch (error) {
  result = {
    generatedAt: new Date().toISOString(),
    status: "FAIL",
    executablePath,
    packageRoot,
    resourcesRoot,
    asarPath,
    checks,
    launches,
    error: errorMessage(error),
    stories: [
      { id: "MRT-HAR-001", status: "FAIL", evidence: ["packaged/packaged-smoke.json"] },
      { id: "MRT-BOOT-005", status: "FAIL", evidence: ["packaged/packaged-smoke.json"] },
    ],
  };
}

writeJson(path.join(evidenceRoot, "packaged-smoke.json"), result);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.status !== "PASS") process.exitCode = 1;

async function runCase(entry, expectedPackages) {
  const caseRoot = path.join(evidenceRoot, entry.name);
  const homeRoot = path.join(caseRoot, "home");
  const appData = path.join(caseRoot, "app-data");
  const localAppData = path.join(caseRoot, "local-app-data");
  const userData = path.join(caseRoot, "electron-user-data");
  const temp = path.join(caseRoot, "temp");
  const profileRoot = path.join(homeRoot, ".marshal");
  const workspaceRoot = path.join(caseRoot, "workspace");
  const lifecycleRoot = resolvePackagedLifecycleRoot({
    e2e: entry.e2e,
    profileRoot,
    tempRoot: temp,
    workerIndex: process.env.TEST_WORKER_INDEX ?? process.env.MARSHAL_E2E_WORKER,
  });
  for (const directory of [
    homeRoot,
    appData,
    localAppData,
    userData,
    temp,
    profileRoot,
    workspaceRoot,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  writeJson(path.join(profileRoot, "marshal-settings.json"), { workspaceDir: workspaceRoot });

  let authSourceBefore = null;
  if (entry.authenticated) {
    authSourceBefore = fileIdentity(authConfigPath, false);
    fs.copyFileSync(authConfigPath, path.join(profileRoot, "config.json"));
  }
  const profileBefore = directoryManifest(homeRoot);
  writeJson(path.join(caseRoot, "profile-manifest-before.json"), profileBefore);

  const port = entry.port ?? (await availablePort());
  if (entry.port) await assertPortFree(entry.port);
  const env = {
    ...process.env,
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: temp,
    TMP: temp,
  };
  delete env.MARSHAL_E2E;
  delete env.MARSHAL_RUNTIME_ACCEPTANCE;
  delete env.MARSHAL_RUNTIME_ACCEPTANCE_BUILD;
  delete env.MARSHAL_RUNTIME_ACCEPTANCE_TOKEN;
  delete env.MARSHAL_RUNTIME_ACCEPTANCE_PRELOAD_TOKEN;
  if (entry.e2e) env.MARSHAL_E2E = "1";
  if (entry.acceptance) env.MARSHAL_RUNTIME_ACCEPTANCE = "1";

  const stdoutPath = path.join(caseRoot, "stdout.log");
  const stderrPath = path.join(caseRoot, "stderr.log");
  const stdout = fs.createWriteStream(stdoutPath);
  const stderr = fs.createWriteStream(stderrPath);
  const child = spawn(
    executablePath,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`],
    {
      cwd: packageRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);

  let browser;
  let page;
  let caseResult = {
    case: entry.name,
    status: "FAIL",
    launcherPid: child.pid,
    executablePath,
    userData,
    homeRoot,
    remoteDebuggingPort: port,
  };
  const observedLineage = new Map();
  try {
    const debugIdentity = await waitForEndpoint(port, child);
    browser = await chromium.connectOverCDP(debugIdentity.webSocketDebuggerUrl);
    page = await firstPage(browser, child);
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);

    const globals = await page.evaluate(() => ({
      runtimeAcceptanceApiType: typeof window.runtimeAcceptanceAPI,
      acceptanceNamedGlobals: Object.getOwnPropertyNames(window)
        .filter((name) => /acceptance/i.test(name))
        .sort(),
    }));
    if (
      globals.runtimeAcceptanceApiType !== "undefined" ||
      globals.acceptanceNamedGlobals.includes("runtimeAcceptanceAPI")
    ) {
      throw new Error(`${entry.name} exposed runtimeAcceptanceAPI.`);
    }

    const lifecycle = await waitForLifecycle(lifecycleRoot, child);
    const ipcInventory = collectIpcInventory(lifecycle);
    if (ipcInventory.count !== ipcInventory.channels.length) {
      throw new Error(
        `${entry.name} IPC inventory count mismatch: ${ipcInventory.count} vs ${ipcInventory.channels.length}.`,
      );
    }
    const acceptanceIpcChannels = ipcInventory.channels.filter((channel) =>
      channel.startsWith("runtime-acceptance:"),
    );
    if (acceptanceIpcChannels.length > 0) {
      throw new Error(`${entry.name} registered acceptance IPC handlers.`);
    }
    for (const expectedChannel of expectedAcceptanceChannels) {
      if (ipcInventory.channels.includes(expectedChannel)) {
        throw new Error(`${entry.name} registered ${expectedChannel}.`);
      }
    }

    const runtimeEvidence = inspectRuntimeLifecycle(lifecycle, expectedPackages);
    if (!runtimeEvidence.pass) {
      throw new Error(
        `${entry.name} runtime package lifecycle evidence failed: ${runtimeEvidence.failures.join(
          "; ",
        )}`,
      );
    }

    const lineageBeforeAgent = captureDescendants(child.pid);
    rememberLineage(observedLineage, lineageBeforeAgent);
    writeJson(path.join(caseRoot, "process-lineage-startup.json"), lineageBeforeAgent);
    const debugPortOwner = queryDebugPortOwner(port);
    if (!lineageBeforeAgent.some((processEntry) => processEntry.pid === debugPortOwner)) {
      throw new Error(
        `${entry.name} debug port ${port} owner ${debugPortOwner} was not in the launched process tree.`,
      );
    }

    let agentEvidence = null;
    if (entry.authenticated) {
      const realResultsRoot = path.join(caseRoot, "e2e-real");
      fs.mkdirSync(realResultsRoot, { recursive: true });
      const runnerResult = spawnSync(
        process.execPath,
        [
          path.join(builderRoot, "e2e-real", "marshal-runner.mjs"),
          "--suite",
          "99-marshal-runtime",
          "--port",
          String(port),
          "--results-dir",
          realResultsRoot,
        ],
        {
          cwd: builderRoot,
          env,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
        },
      );
      fs.writeFileSync(path.join(realResultsRoot, "runner.stdout.log"), runnerResult.stdout ?? "");
      fs.writeFileSync(path.join(realResultsRoot, "runner.stderr.log"), runnerResult.stderr ?? "");
      writeJson(path.join(realResultsRoot, "runner-result.json"), {
        exitCode: runnerResult.status,
        signal: runnerResult.signal,
      });
      if (runnerResult.status !== 0) {
        throw new Error(`Suite 99 failed with exit code ${runnerResult.status}.`);
      }
      agentEvidence = readJson(path.join(realResultsRoot, "runtime-story-results.json"));
      if (
        agentEvidence?.backendProof?.authStatus !== "authenticated" ||
        agentEvidence?.capability?.requested !== "code.index.status" ||
        agentEvidence?.capability?.invocationSucceeded !== true
      ) {
        throw new Error("Suite 99 did not produce authenticated runtime invocation evidence.");
      }
    }

    const lineageAfterAgent = captureDescendants(child.pid);
    rememberLineage(observedLineage, lineageAfterAgent);
    writeJson(path.join(caseRoot, "process-lineage-after-agent.json"), lineageAfterAgent);
    await page.screenshot({ path: path.join(caseRoot, "window.png"), fullPage: true });

    caseResult = {
      ...caseResult,
      status: "PASS",
      debugIdentity: {
        browser: debugIdentity.browser,
        protocolVersion: debugIdentity.protocolVersion,
        targetCount: debugIdentity.targets.length,
        targets: debugIdentity.targets.map((target) => ({
          id: target.id,
          title: target.title,
          type: target.type,
          url: target.url,
        })),
        owningPid: debugPortOwner,
      },
      globals,
      ipcInventory,
      runtimeEvidence,
      agentEvidence,
      processLineage: lineageAfterAgent,
    };
  } catch (error) {
    caseResult = { ...caseResult, status: "FAIL", error: errorMessage(error) };
  } finally {
    await page?.close({ runBeforeUnload: true }).catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await waitForExit(child, 15_000);
    let cleanupError = null;
    if (child.exitCode === null) {
      const finalLineage = captureDescendants(child.pid);
      rememberLineage(observedLineage, finalLineage);
      try {
        await stopProvenProcessTree(child, [...observedLineage.values()]);
      } catch (error) {
        cleanupError = errorMessage(error);
      }
    }
    await waitForExit(child, 5_000);
    const leakedProcesses = livingObservedProcesses([...observedLineage.values()]);
    await Promise.all([
      new Promise((resolve) => stdout.end(resolve)),
      new Promise((resolve) => stderr.end(resolve)),
    ]);

    const profileAfter = directoryManifest(homeRoot);
    writeJson(path.join(caseRoot, "profile-manifest-after.json"), profileAfter);
    const lifecycle = readLifecycle(lifecycleRoot);
    writeJson(path.join(caseRoot, "process-lifecycle.json"), lifecycle);
    const hiddenErrors = scanHiddenErrors(lifecycle, stdoutPath, stderrPath);
    writeJson(path.join(caseRoot, "hidden-error-scan.json"), hiddenErrors);

    let authSourceUnchanged = null;
    if (entry.authenticated && authSourceBefore) {
      const authSourceAfter = fileIdentity(authConfigPath, false);
      authSourceUnchanged =
        authSourceBefore.sha256 === authSourceAfter.sha256 &&
        authSourceBefore.size === authSourceAfter.size &&
        authSourceBefore.mtimeMs === authSourceAfter.mtimeMs;
      writeJson(path.join(caseRoot, "auth-source-before-after.json"), {
        source: "GitHub Copilot CLI config",
        before: authSourceBefore,
        after: authSourceAfter,
        unchanged: authSourceUnchanged,
      });
    }

    const cleanup = {
      launcherExitCode: child.exitCode,
      launcherSignal: child.signalCode,
      observedProcessCount: observedLineage.size,
      leakedProcesses,
      descendantsLeaked: leakedProcesses.length > 0,
      authSourceUnchanged,
      profileBeforeDigest: profileBefore.digest,
      profileAfterDigest: profileAfter.digest,
      criticalHiddenErrors: hiddenErrors.critical,
      cleanupError,
    };
    writeJson(path.join(caseRoot, "cleanup.json"), cleanup);
    caseResult = { ...caseResult, cleanup };
    if (
      cleanup.descendantsLeaked ||
      cleanup.criticalHiddenErrors.length > 0 ||
      cleanup.authSourceUnchanged === false ||
      cleanup.cleanupError !== null
    ) {
      caseResult.status = "FAIL";
      caseResult.error ??= "Packaged process cleanup or hidden-error validation failed.";
    }
  }
  writeJson(path.join(caseRoot, "case-result.json"), caseResult);
  return caseResult;
}

function inspectAsarEntries(entries) {
  const forbiddenEntries = entries
    .map((entry) => entry.path)
    .filter((entry) => /runtime-acceptance/i.test(entry));
  const runtimePackageFiles = entries.filter(
    (entry) =>
      entry.type === "file" &&
      /^node_modules\/@(marshal|quillstone)\//.test(entry.path.toLowerCase()),
  );
  return {
    archiveEntryCount: entries.length,
    entries: entries.map((entry) => entry.path),
    forbiddenEntries,
    runtimePackageFiles,
  };
}

function scanAsarPackedEntries(entries) {
  const rawScan = scanShippingPaths([{ label: "app.asar", path: asarPath }], signatures);
  return {
    ...rawScan,
    logicalPackedFileCount: entries.filter((entry) => entry.type === "file" && !entry.unpacked)
      .length,
  };
}

function inspectRuntimeLifecycle(events, expectedPackages) {
  const verified = events.find((entry) => entry.event === "marshal-runtime.packages.verified");
  const loading = events.find((entry) => entry.event === "marshal-runtime.module.loading");
  const loaded = events.find((entry) => entry.event === "marshal-runtime.module.loaded");
  const running = events.find((entry) => entry.event === "marshal-runtime.host.running");
  const packageRootValue = verified?.details?.packageRoot;
  const packages = Array.isArray(verified?.details?.packages) ? verified.details.packages : [];
  const packageNames = packages
    .map((entry) => entry?.name)
    .filter((name) => typeof name === "string")
    .sort((left, right) => left.localeCompare(right));
  const modulePaths = [loading?.details?.modulePath, loaded?.details?.modulePath].filter(
    (value) => typeof value === "string",
  );
  const failures = [];
  if (verified?.details?.isPackaged !== true) failures.push("verified event was not packaged");
  if (packageRootValue !== "app.asar.unpacked/node_modules") {
    failures.push(`unexpected package root ${String(packageRootValue)}`);
  }
  if (JSON.stringify(packageNames) !== JSON.stringify(expectedPackages)) {
    failures.push("verified package names did not match the 27-package manifest");
  }
  if (
    packages.some(
      (entry) =>
        typeof entry?.entrypoint !== "string" ||
        !/^app\.asar\.unpacked\/node_modules\/@(marshal|quillstone)\//.test(entry.entrypoint),
    )
  ) {
    failures.push("one or more verified package entrypoints were outside app.asar.unpacked");
  }
  if (
    modulePaths.length !== 2 ||
    modulePaths.some(
      (modulePath) => !modulePath.startsWith("app.asar.unpacked/node_modules/@marshal/runtime/"),
    )
  ) {
    failures.push("runtime module loading paths were not exclusively unpacked");
  }
  if (running?.details?.lifecycle !== "running")
    failures.push("runtime host did not reach running");
  return {
    pass: failures.length === 0,
    failures,
    verifiedPackages: verified ?? null,
    moduleLoading: loading ?? null,
    moduleLoaded: loaded ?? null,
    hostRunning: running ?? null,
  };
}

function collectIpcInventory(events) {
  const summary = events.findLast((entry) => entry.event === "ipc.handlers.registered");
  const batches = events.filter((entry) => entry.event === "ipc.handlers.registered.batch");
  const channels = [
    ...new Set(
      batches.flatMap((entry) =>
        Array.isArray(entry.details?.channels) ? entry.details.channels : [],
      ),
    ),
  ]
    .filter((channel) => typeof channel === "string")
    .sort((left, right) => left.localeCompare(right));
  return {
    count: typeof summary?.details?.count === "number" ? summary.details.count : -1,
    batchCount: typeof summary?.details?.batchCount === "number" ? summary.details.batchCount : -1,
    channels,
  };
}

async function waitForLifecycle(profileRoot, child) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Packaged process exited before startup completed: ${child.exitCode}`);
    }
    const events = readLifecycle(profileRoot);
    const startupFailure = findPackagedStartupFailure(events);
    if (startupFailure) {
      throw new Error(
        `Packaged startup failed at ${startupFailure.event}: ${JSON.stringify(startupFailure.details ?? {})}`,
      );
    }
    const eventNames = new Set(events.map((entry) => entry.event));
    if (
      eventNames.has("marshal-runtime.packages.verified") &&
      eventNames.has("marshal-runtime.module.loaded") &&
      eventNames.has("marshal-runtime.host.running") &&
      eventNames.has("ipc.handlers.registered")
    ) {
      return events;
    }
    await sleep(250);
  }
  throw new Error("Timed out waiting for packaged runtime and IPC lifecycle evidence.");
}

function readLifecycle(profileRoot) {
  const lifecyclePath = path.join(profileRoot, "marshal-process-lifecycle.jsonl");
  if (!fs.existsSync(lifecyclePath)) return [];
  return fs
    .readFileSync(lifecyclePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function scanHiddenErrors(lifecycle, stdoutPath, stderrPath) {
  const criticalEvents = new Set([
    "process.uncaughtException",
    "process.unhandledRejection",
    "main.startup.failed",
    "main-window.render-process-gone",
  ]);
  const critical = lifecycle
    .filter((entry) => criticalEvents.has(entry.event))
    .map((entry) => ({ event: entry.event, details: entry.details }));
  const textMatches = [];
  for (const [stream, filePath] of [
    ["stdout", stdoutPath],
    ["stderr", stderrPath],
  ]) {
    const lines = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").split(/\r?\n/) : [];
    for (const line of lines) {
      if (/\b(?:fatal|uncaught|unhandled|ERR_MODULE_NOT_FOUND)\b/i.test(line)) {
        textMatches.push({ stream, line: line.slice(0, 1000) });
      }
    }
  }
  return { critical, textMatches };
}

async function availablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (port === null) reject(new Error("Failed to allocate a loopback port."));
        else resolve(port);
      });
    });
  });
}

async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => reject(new Error(`Debug port ${port} is already in use.`)));
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}

async function waitForEndpoint(port, child) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Packaged process exited before CDP was ready: ${child.exitCode}`);
    }
    try {
      const [versionResponse, targetsResponse] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/json/version`),
        fetch(`http://127.0.0.1:${port}/json/list`),
      ]);
      if (versionResponse.ok && targetsResponse.ok) {
        const version = await versionResponse.json();
        const targets = await targetsResponse.json();
        if (typeof version.webSocketDebuggerUrl === "string" && Array.isArray(targets)) {
          return {
            webSocketDebuggerUrl: version.webSocketDebuggerUrl,
            browser: version.Browser ?? null,
            protocolVersion: version["Protocol-Version"] ?? null,
            targets,
          };
        }
      }
    } catch {
      // The loopback endpoint is expected to refuse connections while Electron starts.
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for packaged Electron on port ${port}.`);
}

async function firstPage(browser, child) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Packaged process exited before a window opened: ${child.exitCode}`);
    }
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages.find((candidate) => candidate.url() !== "about:blank") ?? pages[0];
    if (page) return page;
    await sleep(250);
  }
  throw new Error("Timed out waiting for the packaged renderer window.");
}

function captureDescendants(rootPid) {
  if (!Number.isInteger(rootPid)) return [];
  const script = buildCaptureDescendantsScript(rootPid);
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Failed to capture process lineage: ${result.stderr}`);
  }
  const value = result.stdout.trim();
  if (!value) return [];
  const parsed = JSON.parse(value);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
    ...entry,
    executablePath: entry.executablePath ? path.resolve(entry.executablePath) : null,
    underPackageRoot: entry.executablePath
      ? isPathInside(packageRoot, path.resolve(entry.executablePath))
      : false,
  }));
}

function queryDebugPortOwner(port) {
  const script = [
    `$entry = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction Stop`,
    "$entry | Select-Object -First 1 -ExpandProperty OwningProcess",
  ].join("\n");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`Failed to identify debug port owner: ${result.stderr}`);
  const pid = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isInteger(pid)) throw new Error(`Invalid debug port owner: ${result.stdout}`);
  return pid;
}

function rememberLineage(observed, entries) {
  for (const entry of entries) observed.set(`${entry.pid}:${entry.creationDate}`, entry);
}

async function stopProvenProcessTree(child, entries) {
  const live = livingObservedProcesses(entries);
  const unproven = live.filter((entry) => !entry.underPackageRoot);
  if (unproven.length > 0) {
    throw new Error(
      `Refusing to terminate unproven process descendants: ${unproven
        .map((entry) => `${entry.pid}:${entry.executablePath ?? "unknown"}`)
        .join(", ")}`,
    );
  }
  for (const entry of live.sort((left, right) => right.depth - left.depth)) {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Stop-Process -Id ${entry.pid} -Force -ErrorAction SilentlyContinue`,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    if (result.status !== 0) {
      throw new Error(`Failed to terminate proven process ${entry.pid}: ${result.stderr}`);
    }
  }
  await waitForExit(child, 5_000);
}

function livingObservedProcesses(entries) {
  return entries.filter((entry) => {
    const current = queryProcess(entry.pid);
    return (
      current !== null &&
      current.creationDate === entry.creationDate &&
      current.executablePath === entry.executablePath
    );
  });
}

function queryProcess(pid) {
  const script = buildQueryProcessScript(pid);
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  const parsed = JSON.parse(result.stdout);
  return {
    executablePath: parsed.executablePath ? path.resolve(parsed.executablePath) : null,
    creationDate: parsed.creationDate ?? null,
  };
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return;
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(timeoutMs)]);
}

function directoryManifest(root) {
  const files = listFiles(root).map((filePath) => {
    const stat = fs.statSync(filePath);
    return {
      path: normalizePath(path.relative(root, filePath)),
      size: stat.size,
      sha256: sha256File(filePath),
    };
  });
  return {
    root,
    fileCount: files.length,
    digest: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    files,
  };
}

function fileIdentity(filePath, includePath = true) {
  const stat = fs.statSync(filePath);
  return {
    ...(includePath ? { path: filePath } : {}),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: sha256File(filePath),
  };
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function recordCheck(id, pass, details) {
  checks.push({ id, pass, details });
}

function checksForPrefixPass(prefix) {
  const matching = checks.filter((check) => check.id.startsWith(prefix));
  return matching.length > 0 && matching.every((check) => check.pass);
}

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

function isPathInside(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function requiredFile(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`Required file not found: ${filePath}`);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing required ${name} argument.`);
  return value;
}

function toolNameMatches(actual, expected) {
  return (
    typeof actual === "string" &&
    (actual === expected || actual.endsWith(`.${expected}`) || actual.endsWith(`_${expected}`))
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
