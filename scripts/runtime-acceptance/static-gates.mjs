import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildStoryMap, parseRuntimeAcceptanceContract } from "./contract.mjs";
import { buildAcceptanceSignatures, scanShippingPaths } from "./shipping-scan.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const RUNTIME_SWARM_EXPORT = Object.freeze({
  types: "./dist/swarm.d.ts",
  default: "./dist/swarm.js",
});
const HOST_SWARM_IMPORT_PATTERN =
  /(?:\bfrom\s+|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)["'](?:@marshal\/runtime\/swarm|@marshal\/swarm)["']/i;
const DEFAULT_SWARM_CAPABILITY_PATTERN =
  /\b(?:name|id)\s*:\s*["'][^"']*swarm[^"']*["']|\btags\s*:\s*\[[^\]]*["']swarm["']/i;

export function resolveRuntimePlatformRoot(options = {}) {
  if (options.platformRoot !== undefined && options.platformRoot !== null) {
    return path.resolve(options.platformRoot);
  }
  const envPlatformRoot =
    options.envPlatformRoot === undefined
      ? process.env.MARSHAL_RUNTIME_PLATFORM_ROOT
      : options.envPlatformRoot;
  if (envPlatformRoot !== undefined && envPlatformRoot !== null) {
    return path.resolve(envPlatformRoot);
  }

  const repoRoot = path.resolve(options.repoRoot ?? REPO_ROOT);
  const repoParent = path.dirname(repoRoot);
  const primaryCandidate = path.join(repoParent, "marshal-runtime", "marshal-agent-runtime");
  const worktreeCandidate = path.join(path.dirname(repoParent), "marshal-agent-runtime");
  const candidates =
    path.basename(repoParent) === ".marshal-worktrees"
      ? [worktreeCandidate, primaryCandidate]
      : [primaryCandidate, worktreeCandidate];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

export function runStaticGates(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? REPO_ROOT);
  const normalDistRoot = options.normalDistRoot
    ? path.resolve(options.normalDistRoot)
    : path.join(repoRoot, "dist-electron");
  const normalRendererRoot = options.normalRendererRoot
    ? path.resolve(options.normalRendererRoot)
    : path.join(repoRoot, "dist");
  const runRoot = options.runRoot ? path.resolve(options.runRoot) : null;
  const platformRoot = resolveRuntimePlatformRoot({
    repoRoot,
    platformRoot: options.platformRoot,
  });
  const contractPath = path.join(
    repoRoot,
    "scripts",
    "runtime-acceptance",
    "marshal-runtime-live-user-stories.md",
  );
  const stories = parseRuntimeAcceptanceContract(contractPath);
  const storyMap = buildStoryMap(stories);
  const checks = [];

  check(checks, "contract.story-count", stories.length === 76, { actual: stories.length });
  check(
    checks,
    "contract.every-story-mapped",
    storyMap.every((story) => story.automatedPaths.length > 0),
    {
      unmapped: storyMap
        .filter((story) => story.automatedPaths.length === 0)
        .map((story) => story.id),
    },
  );

  const contractSource = fs.readFileSync(
    path.join(repoRoot, "common", "runtime-acceptance.ts"),
    "utf8",
  );
  const channels = [...contractSource.matchAll(/"runtime-acceptance:([^"]+)"/g)].map(
    (match) => match[1],
  );
  check(checks, "bridge.finite-channel-count", new Set(channels).size === 29, {
    channels: [...new Set(channels)].sort(),
  });

  const preloadSource = fs.readFileSync(
    path.join(repoRoot, "electron", "runtime-acceptance-preload.cjs"),
    "utf8",
  );
  check(
    checks,
    "bridge.preload-finite-surface",
    !/\beval\s*\(|new Function|child_process|spawn\s*\(|exec\s*\(/.test(preloadSource),
    {},
  );
  check(
    checks,
    "bridge.token-authenticated",
    preloadSource.includes("MARSHAL_RUNTIME_ACCEPTANCE_TOKEN") &&
      preloadSource.includes("MARSHAL_RUNTIME_ACCEPTANCE_PRELOAD_TOKEN"),
    {},
  );
  const bridgeSource = fs.readFileSync(
    path.join(repoRoot, "electron", "runtime-acceptance", "main.ts"),
    "utf8",
  );
  check(
    checks,
    "bridge.no-arbitrary-command-module-path",
    !/^import .*node:child_process/m.test(bridgeSource) &&
      !/new Function|\beval\s*\(/.test(bridgeSource) &&
      bridgeSource.includes("timingSafeEqual") &&
      bridgeSource.includes("acceptance-token-invalid") &&
      bridgeSource.includes("do not accept source code") &&
      bridgeSource.includes("do not accept package roots"),
    {},
  );
  check(
    checks,
    "bridge.fixture-surface-is-finite",
    contractSource.includes('readonly action: "create-agent"') &&
      contractSource.includes('readonly action: "configure-memory-backing"') &&
      contractSource.includes('readonly action: "agent-outbox"') &&
      preloadSource.includes("fixture: (request)") &&
      bridgeSource.includes("private async runFixture") &&
      !bridgeSource.includes("fixture.command") &&
      !bridgeSource.includes("fixture.modulePath"),
    {},
  );

  const mainSource = fs.readFileSync(path.join(repoRoot, "electron", "main.ts"), "utf8");
  check(
    checks,
    "bridge.compile-time-gated",
    mainSource.includes("__MARSHAL_RUNTIME_ACCEPTANCE_BUILD__") &&
      mainSource.includes("RuntimeAcceptanceHarness.create"),
    {},
  );
  const builderSource = fs.readFileSync(path.join(repoRoot, "electron-builder.json5"), "utf8");
  check(
    checks,
    "bridge.builder-excludes-preload",
    builderSource.includes("!dist-electron/runtime-acceptance-preload.cjs"),
    {},
  );

  const acceptanceSignatures = buildAcceptanceSignatures(repoRoot);
  const normalScan = scanShippingPaths(
    [
      { label: "normal-main-preload", path: normalDistRoot },
      { label: "normal-renderer", path: normalRendererRoot },
    ],
    acceptanceSignatures,
  );
  check(checks, "normal-build.bridge-markers-absent", normalScan.hits.length === 0, {
    signatureCount: acceptanceSignatures.length,
    fileCount: normalScan.fileCount,
    matches: normalScan.hits,
  });
  check(
    checks,
    "normal-build.acceptance-preload-absent",
    !fs.existsSync(path.join(normalDistRoot, "runtime-acceptance-preload.cjs")),
    {},
  );

  const manifestPath = path.join(repoRoot, ".marshal-runtime-packs", "manifest.json");
  const pinPath = path.join(
    repoRoot,
    "electron",
    "marshal-runtime",
    "runtime-package-pin.generated.ts",
  );
  check(checks, "provenance.manifest-present", fs.existsSync(manifestPath), {
    sha256: fileDigest(manifestPath),
  });
  check(checks, "provenance.generated-pin-present", fs.existsSync(pinPath), {
    sha256: fileDigest(pinPath),
  });
  for (const packageName of ["@marshal/runtime", "@marshal/agent-runtime-code-intelligence"]) {
    const packagePath = path.join(repoRoot, "node_modules", ...packageName.split("/"));
    check(checks, `provenance.installed.${packageName}`, fs.existsSync(packagePath), {
      packagePath,
    });
  }

  const provenance = inspectRuntimeProvenance(repoRoot, platformRoot, runRoot);
  check(checks, "provenance.closure-consistent", provenance.pass, provenance);
  const negativeVariants = runRoot ? runNegativeVerificationVariants(repoRoot, runRoot) : [];
  check(
    checks,
    "provenance.negative-variants-fail-closed",
    negativeVariants.length === 14 && negativeVariants.every((variant) => variant.pass),
    { variants: negativeVariants },
  );

  const swarmBoundary = inspectPortableSwarmBoundary(repoRoot);
  check(
    checks,
    "swarm.standalone-extension-production-composition",
    swarmBoundary.pass,
    swarmBoundary,
  );

  const marshalBoundary = inspectMarshalDesktopBoundary(repoRoot);
  check(checks, "marshal.desktop-boundary", marshalBoundary.pass, marshalBoundary);

  return {
    generatedAt: new Date().toISOString(),
    repoRoot,
    normalDistRoot,
    pass: checks.every((entry) => entry.pass),
    checks,
    storyMap,
    storyResults: [
      {
        id: "MRT-PRV-001",
        status: provenance.pass ? "PASS" : "FAIL",
        evidence: ["static-gates.json"],
      },
      {
        id: "MRT-PRV-002",
        status:
          negativeVariants.length === 14 && negativeVariants.every((variant) => variant.pass)
            ? "PASS"
            : runRoot
              ? "FAIL"
              : "NOT RUN",
        evidence: ["static-gates.json"],
      },
      {
        id: "MRT-LEG-001",
        status: swarmBoundary.pass ? "EVIDENCE_CAPTURED" : "FAIL",
        evidence: ["static-gates.json"],
      },
      {
        id: "MRT-LEG-002",
        status: swarmBoundary.pass ? "PASS" : "FAIL",
        evidence: ["static-gates.json"],
      },
    ],
  };
}

function check(checks, id, pass, details) {
  checks.push({ id, pass, details });
}

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  visit(root);
  return files;
}

function fileDigest(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function inspectRuntimeProvenance(repoRoot, platformRoot, runRoot) {
  const manifestPath = path.join(repoRoot, ".marshal-runtime-packs", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const generatedPinPath = path.join(
    repoRoot,
    "electron",
    "marshal-runtime",
    "runtime-package-pin.generated.ts",
  );
  const generatedPinSource = fs.readFileSync(generatedPinPath, "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const lockSource = fs.readFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "utf8");
  const extractRoot = fs.mkdtempSync(
    path.join(runRoot ? path.resolve(runRoot) : os.tmpdir(), "marshal-runtime-provenance-"),
  );
  const packages = manifest.packages.map((entry) => {
    const archivePath = path.join(repoRoot, ".marshal-runtime-packs", "archives", entry.archive);
    const packageRoot = path.join(repoRoot, "node_modules", ...entry.name.split("/"));
    const extractedRoot = path.join(extractRoot, entry.name.replaceAll("/", "__"));
    fs.mkdirSync(extractedRoot, { recursive: true });
    const extract = spawnSync("tar", ["-xf", archivePath, "-C", extractedRoot], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    const expectedReference = `file:.marshal-runtime-packs/archives/${entry.archive}`;
    const packageReference =
      packageJson.dependencies?.[entry.name] ?? packageJson.pnpm?.overrides?.[entry.name] ?? null;
    return {
      name: entry.name,
      version: entry.version,
      archive: entry.archive,
      packagingRevision: /-marshal-host-\d+\.tgz$/.test(entry.archive),
      archiveSha256: fileDigest(archivePath),
      expectedArchiveSha256: entry.archiveSha256,
      entrySha256: fileDigest(path.join(packageRoot, entry.entrypoint)),
      expectedEntrySha256: entry.entrySha256,
      installedContentSha256: packageContentDigest(packageRoot),
      archiveContentSha256:
        extract.status === 0
          ? packageContentDigest(path.join(extractedRoot, "package"))
          : `tar-failed:${extract.status}`,
      expectedContentSha256: entry.contentSha256,
      packageManifest: JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")),
      packageReference,
      expectedReference,
      lockfileReferencePresent: lockSource.includes(expectedReference),
      generatedPinPresent:
        generatedPinSource.includes(`name: "${entry.name}"`) &&
        generatedPinSource.includes(`version: "${entry.version}"`) &&
        generatedPinSource.includes(`entrySha256: "${entry.entrySha256}"`) &&
        generatedPinSource.includes(`contentSha256: "${entry.contentSha256}"`),
    };
  });
  try {
    const platformAttestation = inspectSourceAttestation(
      platformRoot,
      manifest.packages.filter((entry) => entry.name !== "@marshal/swarm"),
      manifest.source,
    );
    const swarmAttestation = inspectSourceAttestation(
      path.join(path.dirname(platformRoot), "marshal-swarm"),
      manifest.packages.filter((entry) => entry.name === "@marshal/swarm"),
      manifest.swarm?.source,
    );
    const verification = spawnSync(
      process.execPath,
      ["scripts/prepare-marshal-runtime.mjs", "--verify", "--installed"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env,
          HTTP_PROXY: "http://127.0.0.1:1",
          HTTPS_PROXY: "http://127.0.0.1:1",
          NO_PROXY: "",
          npm_config_offline: "true",
        },
      },
    );
    const runtimeLockLines = lockSource
      .split(/\r?\n/)
      .filter((line) => /@(marshal|quillstone)\//.test(line));
    const registryFallbackLines = runtimeLockLines.filter((line) =>
      /(?:https?:\/\/|registry\.npmjs|npm:)/i.test(line),
    );
    const pinAttestationPresent =
      generatedPinSource.includes(`commit: "${manifest.source.commit}"`) &&
      generatedPinSource.includes(`dirtyDiffSha256: "${manifest.source.dirtyDiffSha256}"`) &&
      generatedPinSource.includes(`sourceTreeSha256: "${manifest.source.sourceTreeSha256}"`);
    const packageNames = manifest.packages.map((entry) => entry.name);
    const pass =
      manifest.schemaVersion === 3 &&
      manifest.runtime?.name === "@marshal/runtime" &&
      manifest.runtime?.version === "0.1.0" &&
      manifest.runtime?.entrypoint === "dist/host.js" &&
      manifest.packages.length === 16 &&
      new Set(packageNames).size === 16 &&
      packageNames.every((name) => /^@marshal\//.test(name)) &&
      packageNames.includes("@marshal/agent-runtime-code-intelligence") &&
      !packageNames.includes("@marshal/holographic-memory") &&
      packages.every(
        (entry) =>
          entry.packagingRevision &&
          entry.archiveSha256 === entry.expectedArchiveSha256 &&
          entry.entrySha256 === entry.expectedEntrySha256 &&
          entry.installedContentSha256 === entry.expectedContentSha256 &&
          entry.archiveContentSha256 === entry.expectedContentSha256 &&
          entry.packageManifest.name === entry.name &&
          entry.packageManifest.version === entry.version &&
          entry.packageReference === entry.expectedReference &&
          entry.lockfileReferencePresent &&
          entry.generatedPinPresent,
      ) &&
      pinAttestationPresent &&
      platformAttestation.pass &&
      swarmAttestation.pass &&
      registryFallbackLines.length === 0 &&
      verification.status === 0;
    return {
      pass,
      schemaVersion: manifest.schemaVersion,
      runtime: manifest.runtime,
      source: manifest.source,
      packageCount: manifest.packages.length,
      packageNames,
      packages,
      pinAttestationPresent,
      platformAttestation,
      swarmAttestation,
      registryFallbackLines,
      offlineVerification: {
        exitCode: verification.status,
        stdout: sanitizeOutput(verification.stdout ?? "", repoRoot),
        stderr: sanitizeOutput(verification.stderr ?? "", repoRoot),
      },
    };
  } finally {
    fs.rmSync(extractRoot, { recursive: true, force: true });
  }
}

function runNegativeVerificationVariants(repoRoot, runRoot) {
  const variantsRoot = path.join(runRoot, "provenance-negative-variants");
  fs.rmSync(variantsRoot, { recursive: true, force: true });
  fs.mkdirSync(variantsRoot, { recursive: true });
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, ".marshal-runtime-packs", "manifest.json"), "utf8"),
  );
  const firstPackage = manifest.packages[0];
  const runtimePackage = manifest.packages.find((entry) => entry.name === "@marshal/runtime");
  if (!runtimePackage) throw new Error("Runtime package is missing from the generated manifest.");
  const cases = [
    {
      id: "missing-archive",
      expected: "ENOENT",
      mutate(root) {
        fs.rmSync(path.join(root, ".marshal-runtime-packs", "archives", firstPackage.archive));
      },
    },
    {
      id: "changed-archive",
      expected: "archive integrity mismatch",
      mutate(root) {
        fs.appendFileSync(
          path.join(root, ".marshal-runtime-packs", "archives", firstPackage.archive),
          "changed",
        );
      },
    },
    {
      id: "changed-installed-entrypoint",
      expected: "entrypoint does not match",
      mutate(root) {
        fs.appendFileSync(
          path.join(root, "node_modules", ...firstPackage.name.split("/"), firstPackage.entrypoint),
          "changed",
        );
      },
    },
    {
      id: "added-installed-file",
      expected: "contents do not match",
      mutate(root) {
        fs.writeFileSync(
          path.join(root, "node_modules", ...firstPackage.name.split("/"), "unexpected.txt"),
          "unexpected",
        );
      },
    },
    {
      id: "package-name-drift",
      expected: "does not match the generated package pin",
      mutate(root) {
        const packagePath = path.join(
          root,
          "node_modules",
          ...firstPackage.name.split("/"),
          "package.json",
        );
        const packageManifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
        fs.writeFileSync(
          packagePath,
          JSON.stringify({ ...packageManifest, name: `${packageManifest.name}-changed` }),
        );
      },
    },
    {
      id: "package-version-drift",
      expected: "does not match the generated package pin",
      mutate(root) {
        const packagePath = path.join(
          root,
          "node_modules",
          ...firstPackage.name.split("/"),
          "package.json",
        );
        const packageManifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
        fs.writeFileSync(packagePath, JSON.stringify({ ...packageManifest, version: "99.0.0" }));
      },
    },
    {
      id: "missing-pin-entry",
      expected: "generated marshal runtime package pin does not match",
      mutate(root) {
        const pinPath = path.join(
          root,
          "electron",
          "marshal-runtime",
          "runtime-package-pin.generated.ts",
        );
        const source = fs.readFileSync(pinPath, "utf8");
        const pattern = new RegExp(
          `    \\{\\r?\\n      name: "${escapeRegExp(firstPackage.name)}",[\\s\\S]*?    \\},\\r?\\n`,
        );
        const changed = source.replace(pattern, "");
        if (changed === source) throw new Error("Unable to remove the generated pin entry.");
        fs.writeFileSync(pinPath, changed);
      },
    },
    {
      id: "missing-swarm-export",
      expected: "./swarm export is missing or invalid",
      mutate(root) {
        const packagePath = path.join(
          root,
          "node_modules",
          ...runtimePackage.name.split("/"),
          "package.json",
        );
        const packageManifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
        delete packageManifest.exports["./swarm"];
        fs.writeFileSync(packagePath, JSON.stringify(packageManifest));
      },
    },
    {
      id: "missing-swarm-entry-file",
      expected: "./swarm public subpath import failed",
      mutate(root) {
        fs.rmSync(
          path.join(root, "node_modules", ...runtimePackage.name.split("/"), "dist", "swarm.js"),
        );
      },
    },
    {
      id: "missing-installed-swarm-package",
      expected: "Installed @marshal/swarm package is missing",
      mutate(root) {
        const packageRoot = path.join(root, "node_modules", "@marshal", "swarm");
        fs.rmSync(packageRoot, { recursive: true, force: true });
      },
    },
    {
      id: "missing-swarm-lock-entry",
      expected: "Marshal lockfile is missing the pinned @marshal/swarm archive",
      mutate(root) {
        const lockPath = path.join(root, "pnpm-lock.yaml");
        const source = fs.readFileSync(lockPath, "utf8");
        fs.writeFileSync(
          lockPath,
          source.replaceAll(
            "file:.marshal-runtime-packs/archives/marshal-swarm-",
            "file:missing-swarm-",
          ),
        );
      },
    },
    {
      id: "missing-swarm-host-dependency",
      expected: "Marshal host must pin @marshal/swarm",
      mutate(root) {
        const packagePath = path.join(root, "package.json");
        const packageManifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
        delete packageManifest.dependencies["@marshal/swarm"];
        fs.writeFileSync(packagePath, JSON.stringify(packageManifest));
      },
    },
    {
      id: "missing-production-swarm-import",
      expected: "Marshal production startup must load the Swarm Runtime extension.",
      mutate(root) {
        const sourcePath = path.join(root, "electron", "main.ts");
        const source = fs.readFileSync(sourcePath, "utf8");
        fs.writeFileSync(
          sourcePath,
          source.replace("resolveSwarmExtensionPackage", "resolveMissingSwarmExtensionPackage"),
        );
      },
    },
    {
      id: "missing-production-swarm-composition",
      expected:
        "Marshal production startup must load Swarm as a Runtime extension, not compose createSwarmSource.",
      mutate(root) {
        const sourcePath = path.join(root, "electron", "main.ts");
        const source = fs.readFileSync(sourcePath, "utf8");
        fs.writeFileSync(
          sourcePath,
          source.replace(
            "additionalProviderSources: [",
            "additionalProviderSources: [createSwarmSource({}),",
          ),
        );
      },
    },
  ];
  const authoritativeBefore = verificationFixtureDigest(repoRoot, manifest);
  return cases.map((variant) => {
    const root = path.join(variantsRoot, variant.id);
    copyVerificationFixture(repoRoot, root, manifest);
    const beforeMutationSha256 = verificationFixtureDigest(root, manifest);
    variant.mutate(root);
    const afterMutationSha256 = verificationFixtureDigest(root, manifest);
    const verification = spawnSync(
      process.execPath,
      ["scripts/prepare-marshal-runtime.mjs", "--verify", "--installed"],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    const pnpm = pnpmInvocation(["run", "prebuild"]);
    const prebuild = spawnSync(pnpm.command, pnpm.args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    const verificationOutput = `${verification.stdout ?? ""}\n${
      verification.stderr ?? ""
    }`.toLowerCase();
    const prebuildOutput = `${prebuild.stdout ?? ""}\n${prebuild.stderr ?? ""}`.toLowerCase();
    const authoritativeAfter = verificationFixtureDigest(repoRoot, manifest);
    const laterBuildArtifacts = ["dist-electron", "release"].filter((relative) =>
      fs.existsSync(path.join(root, relative)),
    );
    return {
      id: variant.id,
      exitCode: verification.status,
      prebuildExitCode: prebuild.status,
      expected: variant.expected,
      pass:
        verification.status !== 0 &&
        prebuild.status !== 0 &&
        verificationOutput.includes(variant.expected.toLowerCase()) &&
        prebuildOutput.includes(variant.expected.toLowerCase()) &&
        beforeMutationSha256 !== afterMutationSha256 &&
        authoritativeBefore === authoritativeAfter &&
        laterBuildArtifacts.length === 0,
      beforeMutationSha256,
      afterMutationSha256,
      authoritativeBefore,
      authoritativeAfter,
      laterBuildArtifacts,
      verification: {
        stdout: sanitizeOutput(verification.stdout ?? "", root).slice(0, 4_000),
        stderr: sanitizeOutput(verification.stderr ?? "", root).slice(0, 4_000),
      },
      prebuild: {
        stdout: sanitizeOutput(prebuild.stdout ?? "", root).slice(0, 4_000),
        stderr: sanitizeOutput(prebuild.stderr ?? "", root).slice(0, 4_000),
      },
    };
  });
}

function copyVerificationFixture(repoRoot, targetRoot, manifest) {
  for (const relative of [
    path.join("scripts", "prepare-marshal-runtime.mjs"),
    path.join("scripts", "first-party-extension-catalog-pins.mjs"),
    path.join("electron", "main.ts"),
    path.join("electron", "marshal-runtime", "runtime-package-pin.generated.ts"),
    path.join("electron", "marshal-runtime", "first-party-extension-catalog.ts"),
    "package.json",
    "pnpm-lock.yaml",
  ]) {
    const target = path.join(targetRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, relative), target);
  }
  fs.cpSync(
    path.join(repoRoot, ".marshal-runtime-packs"),
    path.join(targetRoot, ".marshal-runtime-packs"),
    { recursive: true },
  );
  for (const entry of manifest.packages) {
    const source = path.join(repoRoot, "node_modules", ...entry.name.split("/"));
    const target = path.join(targetRoot, "node_modules", ...entry.name.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true, dereference: true });
  }
  fs.cpSync(
    path.join(repoRoot, "node_modules", "esbuild"),
    path.join(targetRoot, "node_modules", "esbuild"),
    {
      recursive: true,
      dereference: true,
    },
  );
}

function inspectSourceAttestation(sourceRoot, packageEntries, expectedSource) {
  if (!fs.existsSync(sourceRoot)) {
    return { pass: false, sourceRoot, reason: "Source root is missing." };
  }
  const packageByName = new Map();
  const packagesRoot = path.join(sourceRoot, "packages");
  for (const entry of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageRoot = path.join(packagesRoot, entry.name);
    const packagePath = path.join(packageRoot, "package.json");
    if (!fs.existsSync(packagePath)) continue;
    const packageManifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    packageByName.set(packageManifest.name, packageRoot);
  }
  const selectedRoots = packageEntries
    .map((entry) => packageByName.get(entry.name))
    .filter((value) => typeof value === "string");
  const commit = commandOutput("git", ["rev-parse", "HEAD"], sourceRoot);
  const dirtyDiff = commandOutput(
    "git",
    [
      "diff",
      "--binary",
      "HEAD",
      "--",
      ...selectedRoots.map((root) => path.relative(sourceRoot, root)),
    ],
    sourceRoot,
  );
  const treeFiles = [path.join(sourceRoot, "pnpm-lock.yaml")];
  for (const packageRoot of selectedRoots) {
    treeFiles.push(path.join(packageRoot, "package.json"));
    treeFiles.push(...listFiles(path.join(packageRoot, "src")));
  }
  const sourceTreeSha256 = digestRelativeFiles(sourceRoot, treeFiles);
  const dirtyDiffSha256 = createHash("sha256").update(dirtyDiff).digest("hex");
  return {
    pass:
      selectedRoots.length === packageEntries.length &&
      Boolean(expectedSource) &&
      commit === expectedSource.commit &&
      dirtyDiffSha256 === expectedSource.dirtyDiffSha256 &&
      sourceTreeSha256 === expectedSource.sourceTreeSha256,
    sourceRoot,
    packageCount: selectedRoots.length,
    commit,
    expectedCommit: expectedSource?.commit,
    dirtyDiffSha256,
    expectedDirtyDiffSha256: expectedSource?.dirtyDiffSha256,
    sourceTreeSha256,
    expectedSourceTreeSha256: expectedSource?.sourceTreeSha256,
  };
}

function packageContentDigest(packageRoot) {
  const files = listFiles(packageRoot)
    .filter(
      (filePath) => !path.relative(packageRoot, filePath).split(path.sep).includes("node_modules"),
    )
    .sort((left, right) => left.localeCompare(right));
  const hash = createHash("sha256");
  for (const filePath of files) {
    hash.update(path.relative(packageRoot, filePath).replaceAll(path.sep, "/"));
    hash.update("\0");
    hash.update(
      path.basename(filePath) === "package.json"
        ? stableJson(JSON.parse(fs.readFileSync(filePath, "utf8")))
        : fs.readFileSync(filePath),
    );
    hash.update("\0");
  }
  return hash.digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

function digestRelativeFiles(root, files) {
  const hash = createHash("sha256");
  for (const filePath of [...files].sort((left, right) => left.localeCompare(right))) {
    hash.update(path.relative(root, filePath).replaceAll(path.sep, "/"));
    hash.update("\0");
    hash.update(fs.readFileSync(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function verificationFixtureDigest(root, manifest) {
  const files = [
    path.join(root, "scripts", "prepare-marshal-runtime.mjs"),
    path.join(root, "electron", "marshal-runtime", "runtime-package-pin.generated.ts"),
    path.join(root, "package.json"),
    path.join(root, "pnpm-lock.yaml"),
    path.join(root, ".marshal-runtime-packs", "manifest.json"),
    ...manifest.packages.map((entry) =>
      path.join(root, ".marshal-runtime-packs", "archives", entry.archive),
    ),
  ];
  for (const entry of manifest.packages) {
    files.push(...listFiles(path.join(root, "node_modules", ...entry.name.split("/"))));
  }
  files.push(...listFiles(path.join(root, "node_modules", "@marshal", "swarm")));
  for (const relative of ["common", "electron", "src"]) {
    files.push(...listFiles(path.join(root, relative)));
  }
  return digestRelativeFiles(
    root,
    files.filter((filePath) => fs.existsSync(filePath)),
  );
}

function commandOutput(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function pnpmInvocation(args) {
  if (process.platform !== "win32") return { command: "pnpm", args };
  const corepackEntrypoint = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "corepack",
    "dist",
    "pnpm.js",
  );
  const entrypoint =
    process.env.npm_execpath ?? (fs.existsSync(corepackEntrypoint) ? corepackEntrypoint : null);
  if (!entrypoint) throw new Error("Unable to resolve the pnpm entrypoint.");
  return { command: process.execPath, args: [entrypoint, ...args] };
}

function sanitizeOutput(value, root) {
  return value.replaceAll(root, "<variant-root>");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inspectPortableSwarmBoundary(repoRoot) {
  const runtimeRoot = path.join(repoRoot, "node_modules", "@marshal", "runtime");
  const runtimeManifest = JSON.parse(
    fs.readFileSync(path.join(runtimeRoot, "package.json"), "utf8"),
  );
  const hostProductionMatches = [];
  for (const root of [
    path.join(repoRoot, "common"),
    path.join(repoRoot, "electron"),
    path.join(repoRoot, "src"),
  ]) {
    for (const filePath of listFiles(root)) {
      const relative = path.relative(repoRoot, filePath).replaceAll("\\", "/");
      if (!isProductionSource(relative)) continue;
      const source = fs.readFileSync(filePath, "utf8");
      if (HOST_SWARM_IMPORT_PATTERN.test(source)) {
        hostProductionMatches.push({ file: relative, kind: "import" });
      }

      if (DEFAULT_SWARM_CAPABILITY_PATTERN.test(source)) {
        hostProductionMatches.push({ file: relative, kind: "default-capability" });
      }
    }
  }
  const archiveRoot = path.join(repoRoot, ".marshal-runtime-packs", "archives");
  const archives = fs
    .readdirSync(archiveRoot)
    .filter((name) => name.endsWith(".tgz"))
    .sort()
    .map((name) => inspectSwarmArchive(path.join(archiveRoot, name), repoRoot));
  const packageManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const packManifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, ".marshal-runtime-packs", "manifest.json"), "utf8"),
  );
  const lockSource = fs.readFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "utf8");
  const extensionReferences = [
    ...["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
      .filter((field) => packageManifest[field]?.["@marshal/swarm"] !== undefined)
      .map((field) => `package.json:${field}`),
    ...(packageManifest.pnpm?.overrides?.["@marshal/swarm"] !== undefined
      ? ["package.json:pnpm.overrides"]
      : []),
    ...(/(?:^|[\s'"])@marshal\/swarm(?:@|:|[\s'"])|packages[\\/]swarm/i.test(lockSource)
      ? ["pnpm-lock.yaml"]
      : []),
    ...(packManifest.packages.some((entry) => entry.name === "@marshal/swarm")
      ? [".marshal-runtime-packs/manifest.json"]
      : []),
    ...(fs.existsSync(path.join(repoRoot, "node_modules", "@marshal", "swarm"))
      ? ["node_modules/@marshal/swarm"]
      : []),
    ...(fs.existsSync(path.join(repoRoot, "packages", "swarm")) ? ["packages/swarm"] : []),
  ];
  const esmProbe = runSwarmImportProbe(repoRoot, false);
  const commonjsProbe = runSwarmImportProbe(repoRoot, true);
  const probes = [esmProbe, commonjsProbe];
  const expectedExport =
    stableJson(runtimeManifest.exports?.["./swarm"]) === stableJson(RUNTIME_SWARM_EXPORT);
  const importsPass = probes.every(
    (probe) =>
      probe.status === 0 &&
      probe.value?.createSwarmSource === "function" &&
      probe.value?.activationExports.length === 0 &&
      probe.value?.mainSwarmExports.length === 0,
  );
  return {
    pass:
      expectedExport &&
      Boolean(runtimeManifest.exports?.["./extensions"]) &&
      importsPass &&
      hostProductionMatches.some((match) => match.kind === "import") &&
      extensionReferences.includes("package.json:dependencies") &&
      extensionReferences.includes("package.json:pnpm.overrides") &&
      extensionReferences.includes("pnpm-lock.yaml") &&
      extensionReferences.includes(".marshal-runtime-packs/manifest.json") &&
      extensionReferences.includes("node_modules/@marshal/swarm") &&
      !extensionReferences.includes("packages/swarm") &&
      archives.filter(
        (archive) =>
          archive.packageName === "@marshal/swarm" &&
          `file:${archive.path}` === packageManifest.dependencies?.["@marshal/swarm"],
      ).length === 1 &&
      archives.every((archive) => archive.externalDependency === null),
    runtimeExports: runtimeManifest.exports,
    expectedExport,
    probes,
    hostProductionMatches,
    archives,
    extensionReferences,
  };
}

export function inspectMarshalDesktopBoundary(repoRoot) {
  const mainSource = fs.readFileSync(path.join(repoRoot, "electron", "main.ts"), "utf8");
  const symbolSource = fs.readFileSync(
    path.join(repoRoot, "electron", "marshal-runtime", "service-symbols.ts"),
    "utf8",
  );
  const hostSource = fs.readFileSync(
    path.join(repoRoot, "electron", "marshal-runtime", "host.ts"),
    "utf8",
  );
  const swarmSource = fs.readFileSync(
    path.join(repoRoot, "electron", "marshal-runtime", "swarm-production.ts"),
    "utf8",
  );
  const runtimeUiSource = fs.readFileSync(
    path.join(repoRoot, "electron", "ipc", "runtime-ui-ipc.ts"),
    "utf8",
  );
  const runtimeExtensionsSource = fs.readFileSync(
    path.join(repoRoot, "electron", "ipc", "runtime-extensions-ipc.ts"),
    "utf8",
  );
  const tokenKeys = [
    "@marshal/marshal:authority",
    "@marshal/marshal:catalog",
    "@marshal/marshal:agents",
    "@marshal/marshal:brain",
    "@marshal/marshal:memory",
    "@marshal/marshal:memory-provider-registry",
    "@marshal/marshal:browser.execution",
    "@marshal/marshal:ui.delivery",
    "@marshal/marshal:ui.review",
  ];
  const tokenFactoryCount = (symbolSource.match(/createRuntimeServiceToken</g) ?? []).length;
  const runtimeExtensionRegistrationCount = (
    mainSource.match(/registerRuntimeExtensionsHandlers\(\{/g) ?? []
  ).length;
  const containerName = "marshalRuntimeServiceContainer";
  const containerCreationCount = (mainSource.match(/createRuntimeServiceContainer\(\)/g) ?? [])
    .length;
  const containerReferences = (mainSource.match(new RegExp(`\\b${containerName}\\b`, "g")) ?? [])
    .length;
  const productionRegistryMatches = [];
  for (const root of [path.join(repoRoot, "electron"), path.join(repoRoot, "src")]) {
    for (const filePath of listFiles(root)) {
      const relative = path.relative(repoRoot, filePath).replaceAll("\\", "/");
      if (!isProductionSource(relative)) continue;
      const source = fs.readFileSync(filePath, "utf8");
      if (
        /(?:ui-placement-registry|extensions\/registry|extensions\\registry)/.test(source) ||
        /\b(?:registerPlacement|registerApplication|ExtensionRegistry)\b/.test(source)
      ) {
        productionRegistryMatches.push(relative);
      }
    }
  }
  const builderSource = fs.readFileSync(path.join(repoRoot, "electron-builder.json5"), "utf8");
  const packageSource = fs.readFileSync(path.join(repoRoot, "package.json"), "utf8");
  const lockSource = fs.readFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "utf8");
  const archiveRoot = path.join(repoRoot, ".marshal-runtime-packs", "archives");
  const runtimeArchive = fs.existsSync(archiveRoot)
    ? fs
        .readdirSync(archiveRoot)
        .find((name) => name.startsWith("marshal-runtime-") && name.endsWith(".tgz"))
    : undefined;
  const swarmArchive = fs.existsSync(archiveRoot)
    ? fs
        .readdirSync(archiveRoot)
        .find((name) => name.startsWith("marshal-swarm-") && name.endsWith(".tgz"))
    : undefined;
  const packageInputsPresent =
    packageSource.includes('"@marshal/runtime": "file:.marshal-runtime-packs/archives/') &&
    packageSource.includes('"@marshal/swarm": "file:.marshal-runtime-packs/archives/') &&
    lockSource.includes("file:.marshal-runtime-packs/archives/marshal-runtime-") &&
    lockSource.includes("file:.marshal-runtime-packs/archives/marshal-swarm-") &&
    builderSource.includes('"node_modules/@marshal/**/*"') &&
    builderSource.includes('"node_modules/@quillstone/**/*"') &&
    Boolean(runtimeArchive && swarmArchive);
  const pass =
    tokenFactoryCount === tokenKeys.length &&
    tokenKeys.every((key) => symbolSource.includes(`"${key}"`)) &&
    !symbolSource.includes("function createMarshalServiceToken") &&
    runtimeExtensionRegistrationCount === 1 &&
    containerCreationCount === 1 &&
    containerReferences >= 5 &&
    !hostSource.includes("createRuntimeServiceContainer()") &&
    !swarmSource.includes("createRuntimeServiceContainer()") &&
    !runtimeUiSource.includes("ui-placement-registry") &&
    runtimeExtensionsSource.includes("RUNTIME_EXTENSION_CATALOG_SERVICE") &&
    runtimeExtensionsSource.includes("serviceContainer.get") &&
    runtimeUiSource.includes("RUNTIME_EXTENSION_UI_PUBLICATION_SERVICE") &&
    runtimeUiSource.includes("serviceContainer.get") &&
    productionRegistryMatches.length === 0 &&
    packageInputsPresent;
  return {
    pass,
    tokenFactoryCount,
    tokenKeys,
    runtimeExtensionRegistrationCount,
    containerCreationCount,
    containerReferences,
    productionRegistryMatches,
    packageInputsPresent,
    runtimeArchive,
    swarmArchive,
  };
}

function inspectSwarmArchive(archivePath, repoRoot) {
  const listing = spawnSync("tar", ["-tf", archivePath], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (listing.status !== 0) {
    return {
      path: path.relative(repoRoot, archivePath).replaceAll("\\", "/"),
      sha256: fileDigest(archivePath),
      entryCount: 0,
      entries: [],
      packageName: null,
      externalDependency: "archive-list-failed",
    };
  }
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
  const packageJson = spawnSync("tar", ["-xOf", archivePath, "package/package.json"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const manifest = packageJson.status === 0 ? JSON.parse(packageJson.stdout) : null;
  const externalDependency = manifest
    ? (["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].find(
        (field) => manifest[field]?.["@marshal/swarm"] !== undefined,
      ) ?? null)
    : "package-json-extract-failed";
  return {
    path: path.relative(repoRoot, archivePath).replaceAll("\\", "/"),
    sha256: fileDigest(archivePath),
    entryCount: entries.length,
    entries,
    packageName: manifest?.name ?? null,
    externalDependency,
  };
}

function isProductionSource(relative) {
  const normalized = relative.replaceAll("\\", "/");
  return (
    /\.(?:[cm]?js|tsx?)$/.test(normalized) &&
    !/(?:^|\/)(?:__tests__|e2e|test|tests)(?:\/|$)/.test(normalized) &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(normalized)
  );
}

function runSwarmImportProbe(repoRoot, commonjs) {
  const body = `const [swarm, main, standalone] = await Promise.all([
    import("@marshal/runtime/swarm"),
    import("@marshal/runtime"),
    import("@marshal/swarm"),
  ]);
  process.stdout.write(JSON.stringify({
    createSwarmSource: typeof standalone.createSwarmSource,
    activationExports: Object.keys(swarm).filter((name) =>
      /(?:activate|activation|extension|kernel|provider|register)/i.test(name)
    ),
    mainSwarmExports: Object.keys(main).filter((name) => /swarm/i.test(name)),
  }));`;
  const source = commonjs
    ? `(async () => { ${body} })().catch((error) => { console.error(error); process.exit(1); });`
    : body;
  const result = spawnSync(
    process.execPath,
    commonjs ? ["--eval", source] : ["--input-type=module", "--eval", source],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return {
    kind: commonjs ? "commonjs-dynamic-import" : "esm",
    status: result.status,
    value: result.status === 0 ? JSON.parse(result.stdout) : null,
    stderr: result.stderr.trim(),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outputIndex = process.argv.indexOf("--output");
  const outputPath =
    outputIndex >= 0 && process.argv[outputIndex + 1]
      ? path.resolve(process.argv[outputIndex + 1])
      : null;
  const result = runStaticGates();
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  if (!result.pass) process.exitCode = 1;
}
