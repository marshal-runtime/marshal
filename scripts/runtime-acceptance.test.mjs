import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildStoryMap, parseRuntimeAcceptanceContract } from "./runtime-acceptance/contract.mjs";
import { findPackagedStartupFailure } from "./runtime-acceptance/packaged-smoke-lifecycle.mjs";
import { resolvePackagedLifecycleRoot } from "./runtime-acceptance/packaged-smoke-paths.mjs";
import {
  buildCaptureDescendantsScript,
  buildQueryProcessScript,
} from "./runtime-acceptance/process-lineage.mjs";
import {
  buildAcceptanceSignatures,
  flattenAsarHeader,
  scanShippingPaths,
} from "./runtime-acceptance/shipping-scan.mjs";
import { readSourceCapabilityNames } from "./runtime-acceptance/source-capability-evidence.mjs";
import {
  inspectMarshalDesktopBoundary,
  resolveRuntimePlatformRoot,
  runStaticGates,
} from "./runtime-acceptance/static-gates.mjs";

const root = path.resolve(import.meta.dirname, "..");
const contractPath = path.join(
  root,
  "scripts",
  "runtime-acceptance",
  "marshal-runtime-live-user-stories.md",
);

test("maps all 76 reviewed Marshal Runtime stories to evidence paths", () => {
  const stories = parseRuntimeAcceptanceContract(contractPath);
  const storyMap = buildStoryMap(stories);
  assert.equal(stories.length, 76);
  assert.equal(new Set(stories.map((story) => story.id)).size, 76);
  assert.equal(
    storyMap.every((story) => story.automatedPaths.length > 0),
    true,
  );
});

test("runtime platform root discovery preserves overrides and canonical local layouts", (context) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-platform-root-"));
  context.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));

  const primaryRepoRoot = path.join(workspaceRoot, "marshal");
  const primaryCandidate = path.join(workspaceRoot, "marshal-runtime", "marshal-agent-runtime");
  assert.equal(
    resolveRuntimePlatformRoot({
      repoRoot: primaryRepoRoot,
      envPlatformRoot: null,
    }),
    primaryCandidate,
  );

  fs.mkdirSync(primaryCandidate, { recursive: true });
  assert.equal(
    resolveRuntimePlatformRoot({
      repoRoot: primaryRepoRoot,
      envPlatformRoot: null,
    }),
    primaryCandidate,
  );

  const worktreeRepoRoot = path.join(
    workspaceRoot,
    "runtime-parent",
    ".marshal-worktrees",
    "app-worktree",
  );
  const worktreeCandidate = path.join(workspaceRoot, "runtime-parent", "marshal-agent-runtime");
  fs.mkdirSync(worktreeCandidate, { recursive: true });
  assert.equal(
    resolveRuntimePlatformRoot({
      repoRoot: worktreeRepoRoot,
      envPlatformRoot: null,
    }),
    worktreeCandidate,
  );

  const envPlatformRoot = path.join(workspaceRoot, "environment-override");
  const explicitPlatformRoot = path.join(workspaceRoot, "explicit-override");
  assert.equal(
    resolveRuntimePlatformRoot({
      repoRoot: primaryRepoRoot,
      envPlatformRoot,
    }),
    envPlatformRoot,
  );
  assert.equal(
    resolveRuntimePlatformRoot({
      repoRoot: primaryRepoRoot,
      platformRoot: explicitPlatformRoot,
      envPlatformRoot,
    }),
    explicitPlatformRoot,
  );

  const acceptanceRunner = fs.readFileSync(
    path.join(root, "scripts", "runtime-acceptance", "run.mjs"),
    "utf8",
  );
  assert.match(acceptanceRunner, /resolveRuntimePlatformRoot\(\{ repoRoot: SOURCE_ROOT \}\)/);
  assert.doesNotMatch(acceptanceRunner, /runtime-platform-rebuild-20260814/);
});

test("acceptance static gates validate bridge confinement and portable swarm boundary", (context) => {
  const emptyNormalDist = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-static-gate-"));
  context.after(() => fs.rmSync(emptyNormalDist, { recursive: true, force: true }));
  const result = runStaticGates({
    repoRoot: root,
    normalDistRoot: emptyNormalDist,
    normalRendererRoot: emptyNormalDist,
  });
  assert.equal(
    result.checks.find((check) => check.id === "bridge.finite-channel-count")?.pass,
    true,
  );
  assert.equal(
    result.checks.find((check) => check.id === "bridge.preload-finite-surface")?.pass,
    true,
  );
  assert.equal(
    result.checks.find((check) => check.id === "bridge.token-authenticated")?.pass,
    true,
  );
  assert.equal(
    result.checks.find((check) => check.id === "bridge.no-arbitrary-command-module-path")?.pass,
    true,
  );
  const swarmBoundary = result.checks.find(
    (check) => check.id === "swarm.standalone-extension-production-composition",
  );
  assert.equal(swarmBoundary?.pass, true);
  assert.equal(
    swarmBoundary?.details.probes.every(
      (probe) =>
        probe.status === 0 &&
        probe.value.activationExports.length === 0 &&
        probe.value.mainSwarmExports.length === 0,
    ),
    true,
  );
  const marshalBoundary = result.checks.find((check) => check.id === "marshal.desktop-boundary");
  assert.equal(marshalBoundary?.pass, true);
});

test("Marshal desktop boundary inspection reports the required ownership invariants", () => {
  const result = inspectMarshalDesktopBoundary(root);
  assert.equal(result.tokenFactoryCount, 11);
  assert.deepEqual(result.tokenKeys, [
    "@marshal/marshal:authority",
    "@marshal/marshal:catalog",
    "@marshal/marshal:agents",
    "@marshal/marshal:brain",
    "@marshal/marshal:memory",
    "@marshal/marshal:memory-provider-registry",
    "@marshal/marshal:browser.execution",
    "@marshal/marshal:ui.delivery",
    "@marshal/marshal:ui.review",
    "@marshal/marshal:cloud.identity",
    "@marshal/marshal:cloud.tokens",
  ]);
  assert.equal(result.runtimeExtensionRegistrationCount, 1);
  assert.equal(result.containerCreationCount, 1);
  assert.equal(result.productionRegistryMatches.length, 0);
  assert.equal(result.packageInputsPresent, true);
});

test("shipping scan finds derived acceptance signatures across binary chunk boundaries", (context) => {
  const scanRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-shipping-scan-"));
  context.after(() => fs.rmSync(scanRoot, { recursive: true, force: true }));
  const signatures = buildAcceptanceSignatures(root);
  const marker = signatures.find((entry) => entry.value === "runtimeAcceptanceAPI");
  assert.ok(marker);
  const filePath = path.join(scanRoot, "bundle.bin");
  fs.writeFileSync(
    filePath,
    Buffer.concat([
      Buffer.alloc(1024 * 1024 - 4, 0x61),
      Buffer.from(marker.value),
      Buffer.from("tail"),
    ]),
  );

  const result = scanShippingPaths([{ label: "fixture", path: scanRoot }], signatures);
  assert.equal(result.fileCount, 1);
  assert.deepEqual(
    result.hits.filter((hit) => hit.value === marker.value),
    [{ root: "fixture", file: "bundle.bin", ...marker }],
  );
});

test("ASAR header flattening preserves unpacked package file metadata", () => {
  const entries = flattenAsarHeader({
    files: {
      "main.js": { size: 10, unpacked: false },
      node_modules: {
        files: {
          "@marshal": {
            files: {
              runtime: {
                files: {
                  "package.json": { size: 20, unpacked: true },
                },
              },
            },
          },
        },
      },
    },
  });
  assert.deepEqual(entries, [
    { path: "main.js", type: "file", size: 10, unpacked: false },
    { path: "node_modules", type: "directory", unpacked: false },
    { path: "node_modules/@marshal", type: "directory", unpacked: false },
    { path: "node_modules/@marshal/runtime", type: "directory", unpacked: false },
    {
      path: "node_modules/@marshal/runtime/package.json",
      type: "file",
      size: 20,
      unpacked: true,
    },
  ]);
});

test(
  "Windows process-lineage scripts execute and identify the current process",
  { skip: process.platform !== "win32" },
  () => {
    const capture = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-Command", buildCaptureDescendantsScript(process.pid)],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(capture.status, 0, capture.stderr);
    const captured = JSON.parse(capture.stdout);
    const entries = Array.isArray(captured) ? captured : [captured];
    assert.ok(entries.some((entry) => entry.pid === process.pid));
    assert.match(buildCaptureDescendantsScript(process.pid), /CreationDate -ge \$rootCreationDate/);

    const query = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-Command", buildQueryProcessScript(process.pid)],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(query.status, 0, query.stderr);
    const processEntry = JSON.parse(query.stdout);
    assert.equal(path.resolve(processEntry.executablePath), path.resolve(process.execPath));
    assert.match(processEntry.creationDate, /^\d{4}-\d{2}-\d{2}T/);
  },
);

test("packaging declares cross-spawn runtime dependencies as production inputs", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.dependencies.which, "2.0.2");
  assert.equal(manifest.dependencies.isexe, "2.0.0");

  const builderConfig = fs.readFileSync(path.join(root, "electron-builder.json5"), "utf8");
  assert.match(builderConfig, /"node_modules\/which\/\*\*\/\*"/);
  assert.match(builderConfig, /"node_modules\/isexe\/\*\*\/\*"/);
});

test("packaged smoke requires a source-to-packaged capability comparison", () => {
  const packagedSmoke = fs.readFileSync(
    path.join(root, "scripts", "runtime-acceptance", "packaged-smoke.mjs"),
    "utf8",
  );
  assert.match(packagedSmoke, /--source-capability-evidence/);
  assert.match(packagedSmoke, /source-packaged-capability-comparison\.json/);
  assert.match(packagedSmoke, /source-packaged-capability-names-match/);
});

test("packaged smoke accepts source-only HAR discovery evidence", () => {
  assert.deepEqual(
    readSourceCapabilityNames({
      stableId: "MRT-HAR-001",
      status: "EVIDENCE_CAPTURED",
      assertions: { sourceCapabilityDiscoverable: true },
      proof: { sourceCapabilityNames: ["code.index.status"] },
    }),
    ["code.index.status"],
  );
  assert.throws(
    () =>
      readSourceCapabilityNames({
        stableId: "MRT-HAR-001",
        status: "BLOCKED",
        assertions: { sourceCapabilityDiscoverable: true },
        proof: { sourceCapabilityNames: ["code.index.status"] },
      }),
    /did not prove code\.index\.status discovery/,
  );
});

test("packaged smoke reads mock lifecycle evidence from the isolated E2E data root", () => {
  assert.equal(
    resolvePackagedLifecycleRoot({
      e2e: true,
      profileRoot: "Q:\\case\\home\\.marshal",
      tempRoot: "Q:\\case\\temp",
      workerIndex: undefined,
    }),
    path.join("Q:\\case\\temp", "marshal-e2e-data"),
  );
  assert.equal(
    resolvePackagedLifecycleRoot({
      e2e: true,
      profileRoot: "Q:\\case\\home\\.marshal",
      tempRoot: "Q:\\case\\temp",
      workerIndex: "0",
    }),
    path.join("Q:\\case\\temp", "marshal-e2e-data-0"),
  );
  assert.equal(
    resolvePackagedLifecycleRoot({
      e2e: false,
      profileRoot: "Q:\\case\\home\\.marshal",
      tempRoot: "Q:\\case\\temp",
      workerIndex: "0",
    }),
    "Q:\\case\\home\\.marshal",
  );
});

test("packaged smoke fails fast on explicit runtime startup failure evidence", () => {
  assert.deepEqual(
    findPackagedStartupFailure([
      { event: "main.module.loaded" },
      {
        event: "marshal-runtime.host.failed",
        details: { error: { code: "package-content-pin-mismatch" } },
      },
    ]),
    {
      event: "marshal-runtime.host.failed",
      details: { error: { code: "package-content-pin-mismatch" } },
    },
  );
  assert.equal(
    findPackagedStartupFailure([
      { event: "main.module.loaded" },
      { event: "marshal-runtime.host.running" },
    ]),
    null,
  );
});
