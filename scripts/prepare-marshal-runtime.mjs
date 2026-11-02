import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyFirstPartyExtensionCatalogPins } from "./first-party-extension-catalog-pins.mjs";

const RUNTIME_PACKAGE = "@marshal/runtime";
const RUNTIME_ENTRYPOINT = "dist/host.js";
const SWARM_PACKAGE = "@marshal/swarm";
const SWARM_ENTRYPOINT = "dist/extension.cjs";
const HOST_PACKAGE_ROOTS = Object.freeze([RUNTIME_PACKAGE]);
const PACKAGE_SCOPE = "@marshal/";
const WORKSPACE_PACKAGE_SCOPES = Object.freeze([PACKAGE_SCOPE, "@quillstone/"]);
const PACKAGING_REVISION = "marshal-host-58";
const RUNTIME_SWARM_EXPORT = Object.freeze({
  types: "./dist/swarm.d.ts",
  default: "./dist/swarm.js",
});
const PRODUCTION_SWARM_SOURCE = path.join("electron", "main.ts");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..");
const packRoot = path.join(repositoryRoot, ".marshal-runtime-packs");
const archivesDirectory = path.join(packRoot, "archives");
const manifestPath = path.join(packRoot, "manifest.json");
const generatedPinPath = path.join(
  repositoryRoot,
  "electron",
  "marshal-runtime",
  "runtime-package-pin.generated.ts",
);
const firstPartyCatalogPath = path.join(
  repositoryRoot,
  "electron",
  "marshal-runtime",
  "first-party-extension-catalog.ts",
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  return sha256(await fsp.readFile(filePath));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

function typescriptLiteral(value, depth = 0) {
  const indentation = "  ".repeat(depth);
  const childIndentation = "  ".repeat(depth + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value
      .map((child) => `${childIndentation}${typescriptLiteral(child, depth + 1)},`)
      .join("\n")}\n${indentation}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    return `{\n${entries
      .map(([key, child]) => {
        const property = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
        return `${childIndentation}${property}: ${typescriptLiteral(child, depth + 1)},`;
      })
      .join("\n")}\n${indentation}}`;
  }
  return JSON.stringify(value);
}

function readSourceArgument() {
  const inline = process.argv.find((argument) => argument.startsWith("--source="));
  if (inline) return inline.slice("--source=".length);
  const index = process.argv.indexOf("--source");
  return index >= 0 ? process.argv[index + 1] : process.env.MARSHAL_RUNTIME_SOURCE;
}

function readSwarmSourceArgument() {
  const inline = process.argv.find((argument) => argument.startsWith("--swarm-source="));
  if (inline) return inline.slice("--swarm-source=".length);
  const index = process.argv.indexOf("--swarm-source");
  return index >= 0 ? process.argv[index + 1] : process.env.MARSHAL_SWARM_SOURCE;
}

function runtimeOnlyMode() {
  return process.argv.includes("--runtime-only");
}

function rebuildOnlySet() {
  const inline = process.argv.find((argument) => argument.startsWith("--rebuild-only="));
  const index = process.argv.indexOf("--rebuild-only");
  const raw = inline
    ? inline.slice("--rebuild-only=".length)
    : index >= 0
      ? process.argv[index + 1]
      : undefined;
  if (raw === undefined) return undefined;
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) {
    throw new Error("--rebuild-only requires a comma-separated list of package names.");
  }
  return new Set(names);
}

function swarmGuidanceSourceArgument() {
  const inline = process.argv.find((argument) => argument.startsWith("--swarm-guidance-from="));
  const index = process.argv.indexOf("--swarm-guidance-from");
  return inline
    ? inline.slice("--swarm-guidance-from=".length)
    : index >= 0
      ? process.argv[index + 1]
      : undefined;
}

// Swarm-only rebuild: every runtime package archive is retained byte-for-byte
// and ONLY @marshal/swarm is rebuilt from the given workspace (the inverse of
// --rebuild-only, which rebuilds runtime packages and retains swarm).
function rebuildSwarmFromArgument() {
  const inline = process.argv.find((argument) => argument.startsWith("--rebuild-swarm-from="));
  if (inline) return inline.slice("--rebuild-swarm-from=".length);
  const index = process.argv.indexOf("--rebuild-swarm-from");
  return index >= 0 ? process.argv[index + 1] : undefined;
}

// The @marshal/runtime link target for the swarm-only rebuild. The swarm build
// resolves types AND any inlined values through this link, so byte-faithful
// rebuilds must pass the same runtime workspace the retained swarm archive was
// originally built against — not the retained archive's narrower dist surface.
function swarmRuntimeLinkArgument() {
  const inline = process.argv.find((argument) => argument.startsWith("--swarm-runtime-link="));
  if (inline) return inline.slice("--swarm-runtime-link=".length);
  const index = process.argv.indexOf("--swarm-runtime-link");
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function run(command, args, cwd, options = {}) {
  const corepackPnpmEntrypoint = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "corepack",
    "dist",
    "pnpm.js",
  );
  const pnpmEntrypoint =
    process.platform === "win32" && command === "pnpm"
      ? (process.env.npm_execpath ??
        (fs.existsSync(corepackPnpmEntrypoint) ? corepackPnpmEntrypoint : undefined))
      : undefined;
  const executable = pnpmEntrypoint ? process.execPath : command;
  const commandArgs = pnpmEntrypoint ? [pnpmEntrypoint, ...args] : args;
  const result = spawnSync(executable, commandArgs, {
    cwd,
    encoding: options.capture ? "utf8" : undefined,
    env: options.env ?? process.env,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    const spawnError = result.error ? ` ${result.error.message}` : "";
    const detail = options.capture
      ? `\n${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd()
      : "";
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}.${spawnError}${detail}`,
    );
  }
  return options.capture ? (result.stdout ?? "").trim() : "";
}

async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

async function loadWorkspacePackages(sourceRoot) {
  const packagesRoot = path.join(sourceRoot, "packages");
  const entries = await fsp.readdir(packagesRoot, { withFileTypes: true });
  const packages = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packageRoot = path.join(packagesRoot, entry.name);
    const packageJsonPath = path.join(packageRoot, "package.json");
    if (!fs.existsSync(packageJsonPath)) continue;
    const manifest = await readJson(packageJsonPath);
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") continue;
    packages.set(manifest.name, { manifest, packageRoot });
  }
  return packages;
}

function productionClosure(packages) {
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  const visit = (packageName) => {
    if (visited.has(packageName)) return;
    if (visiting.has(packageName)) {
      throw new Error(`Runtime package dependency cycle includes ${packageName}.`);
    }
    const entry = packages.get(packageName);
    if (!entry) throw new Error(`Runtime workspace package is missing: ${packageName}.`);
    visiting.add(packageName);
    for (const [dependencyName, version] of Object.entries(entry.manifest.dependencies ?? {})) {
      if (typeof version === "string" && version.startsWith("workspace:")) {
        if (!WORKSPACE_PACKAGE_SCOPES.some((scope) => dependencyName.startsWith(scope))) {
          throw new Error(`Unexpected workspace dependency ${dependencyName} from ${packageName}.`);
        }
        visit(dependencyName);
      }
    }
    visiting.delete(packageName);
    visited.add(packageName);
    ordered.push(packageName);
  };
  for (const packageName of HOST_PACKAGE_ROOTS) visit(packageName);
  return ordered;
}

async function collectFiles(root, predicate = () => true) {
  const files = [];
  const visit = async (directory) => {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile() && predicate(target)) {
        files.push(target);
      }
    }
  };
  if (fs.existsSync(root)) await visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function manifestDependency(manifest, packageName) {
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    if (manifest[field]?.[packageName] !== undefined) return `${field}.${packageName}`;
  }
  if (manifest.pnpm?.overrides?.[packageName] !== undefined) {
    return `pnpm.overrides.${packageName}`;
  }
  return null;
}

function assertSwarmDependencyAbsent(manifest, label) {
  if (manifest.name === SWARM_PACKAGE) {
    throw new Error(
      `Standalone ${SWARM_PACKAGE} cannot be part of the Runtime workspace: ${label}.`,
    );
  }
  const dependency = manifestDependency(manifest, SWARM_PACKAGE);
  if (dependency) {
    throw new Error(`Runtime package ${label} unexpectedly declares ${dependency}.`);
  }
}

function assertSwarmPackageManifest(manifest, label) {
  if (
    manifest.name !== SWARM_PACKAGE ||
    manifest.version !== "0.1.0" ||
    manifest.main !== SWARM_ENTRYPOINT ||
    manifest.dependencies?.[RUNTIME_PACKAGE] !== "0.1.0"
  ) {
    throw new Error(`Standalone ${SWARM_PACKAGE} manifest is invalid: ${label}.`);
  }
  const firstPartyDependencies = Object.keys(manifest.dependencies ?? {}).filter((name) =>
    name.startsWith(PACKAGE_SCOPE),
  );
  if (firstPartyDependencies.length !== 1 || firstPartyDependencies[0] !== RUNTIME_PACKAGE) {
    throw new Error(
      `Standalone ${SWARM_PACKAGE} must depend only on exact ${RUNTIME_PACKAGE}@0.1.0.`,
    );
  }
}

async function assertRuntimeSwarmSurface(packageRoot, manifest, { checkImports, checkMain }) {
  if (stableJson(manifest.exports?.["./swarm"]) !== stableJson(RUNTIME_SWARM_EXPORT)) {
    throw new Error("Marshal Runtime ./swarm export is missing or invalid.");
  }

  if (checkImports) {
    let probe;
    try {
      probe = JSON.parse(
        run(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            `const [swarm, main] = await Promise.all([
              import("@marshal/runtime/swarm"),
              import("@marshal/runtime"),
            ]);
            process.stdout.write(JSON.stringify({
              activationExports: Object.keys(swarm).filter((name) =>
                /(?:activate|activation|extension|kernel|provider|register)/i.test(name)
              ),
              mainSwarmExports: Object.keys(main).filter((name) => /swarm/i.test(name)),
            }));`,
          ],
          packageRoot,
          { capture: true },
        ),
      );
    } catch (error) {
      throw new Error("Marshal Runtime ./swarm public subpath import failed.", { cause: error });
    }
    if (probe.activationExports.length > 0) {
      throw new Error(
        `Marshal Runtime ./swarm exposes activation exports: ${probe.activationExports.join(", ")}.`,
      );
    }
    if (checkMain && probe.mainSwarmExports.length > 0) {
      throw new Error(
        `Marshal Runtime main entry re-exports swarm: ${probe.mainSwarmExports.join(", ")}.`,
      );
    }
  }
}

function isProductionSource(relative) {
  const normalized = relative.replaceAll(path.sep, "/");
  return (
    /\.(?:[cm]?js|tsx?)$/.test(normalized) &&
    !/(?:^|\/)(?:__tests__|e2e|test|tests)(?:\/|$)/.test(normalized) &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(normalized)
  );
}

async function assertHostSwarmComposition(root) {
  const mainPath = path.join(root, PRODUCTION_SWARM_SOURCE);
  const mainSource = await fsp.readFile(mainPath, "utf8");
  if (/\bcreateSwarmSource\s*\(/.test(mainSource)) {
    throw new Error(
      "Marshal production startup must load Swarm as a Runtime extension, not compose createSwarmSource.",
    );
  }
  if (!/firstPartyExtensions:\s*resolveFirstPartyExtensionCatalog\s*\(/.test(mainSource)) {
    throw new Error(
      "Marshal production startup must load Swarm through the first-party extension catalog.",
    );
  }
  if (!/additionalProviderSources:\s*\[[\s\S]*runtimeProviderSources\(\)/.test(mainSource)) {
    throw new Error("Marshal production startup must preserve acceptance provider sources.");
  }
}

async function assertSwarmProductionOwnership(
  root,
  packageManifest,
  packManifest,
  { installed = false } = {},
) {
  const expectedArchive = packManifest.packages.find((entry) => entry.name === SWARM_PACKAGE);
  if (!expectedArchive) {
    throw new Error(`Standalone ${SWARM_PACKAGE} is missing from the pinned archive manifest.`);
  }
  const expectedReference = `file:.marshal-runtime-packs/archives/${expectedArchive.archive}`;
  if (packageManifest.dependencies?.[SWARM_PACKAGE] !== expectedReference) {
    throw new Error(`Marshal host must pin ${SWARM_PACKAGE} to ${expectedReference}.`);
  }
  if (packageManifest.pnpm?.overrides?.[SWARM_PACKAGE] !== expectedReference) {
    throw new Error(`Marshal host override must pin ${SWARM_PACKAGE} to ${expectedReference}.`);
  }
  const lockPath = path.join(root, "pnpm-lock.yaml");
  const lockSource = await fsp.readFile(lockPath, "utf8");
  if (installed && !lockSource.includes(expectedReference)) {
    throw new Error(`Marshal lockfile is missing the pinned ${SWARM_PACKAGE} archive.`);
  }
  const archivePath = path.join(
    root,
    ".marshal-runtime-packs",
    "archives",
    expectedArchive.archive,
  );
  if (!fs.existsSync(archivePath)) {
    throw new Error(`Pinned ${SWARM_PACKAGE} archive is missing.`);
  }
  if (installed) {
    const installedRoot = path.join(root, "node_modules", "@marshal", "swarm");
    if (!fs.existsSync(installedRoot)) {
      throw new Error(`Installed ${SWARM_PACKAGE} package is missing.`);
    }
    const installedManifest = await readJson(path.join(installedRoot, "package.json"));
    assertSwarmPackageManifest(installedManifest, "installed package");
  }
  await assertHostSwarmComposition(root);
}

function assertInstalledImportProbe(probe, label) {
  if (
    probe.createSwarmSource !== "function" ||
    probe.createRuntimeCodeIntelligenceBundle !== "function" ||
    probe.createRuntimeCodeIntelligenceService !== "function" ||
    probe.activationExports.length > 0 ||
    probe.mainSwarmExports.length > 0
  ) {
    throw new Error(`Installed Marshal Runtime ${label} import contract is invalid.`);
  }
}

function installedImportProbeSource({ commonjs }) {
  const body = `const [
    swarm,
    main,
    standalone,
    intelligence,
    runtimeService,
  ] = await Promise.all([
    import("@marshal/runtime/swarm"),
    import("@marshal/runtime"),
    import("@marshal/swarm"),
    import("@marshal/runtime/intelligence"),
    import("@marshal/agent-runtime-code-intelligence/runtime-service"),
  ]);
  const activationExports = Object.keys(swarm).filter((name) =>
    /(?:activate|activation|extension|kernel|provider|register)/i.test(name)
  );
  process.stdout.write(JSON.stringify({
    createSwarmSource: typeof standalone.createSwarmSource,
    createRuntimeCodeIntelligenceBundle: typeof intelligence.createRuntimeCodeIntelligenceBundle,
    createRuntimeCodeIntelligenceService:
      typeof runtimeService.createRuntimeCodeIntelligenceBundle,
    activationExports,
    mainSwarmExports: Object.keys(main).filter((name) => /swarm/i.test(name)),
  }));`;
  return commonjs
    ? `(async () => { ${body} })().catch((error) => { console.error(error); process.exit(1); });`
    : body;
}

function verifyInstalledConsumerImports() {
  const esm = JSON.parse(
    run(
      process.execPath,
      ["--input-type=module", "--eval", installedImportProbeSource({ commonjs: false })],
      repositoryRoot,
      { capture: true },
    ),
  );
  const commonjs = JSON.parse(
    run(
      process.execPath,
      ["--eval", installedImportProbeSource({ commonjs: true })],
      repositoryRoot,
      { capture: true },
    ),
  );
  assertInstalledImportProbe(esm, "ESM");
  assertInstalledImportProbe(commonjs, "CommonJS dynamic");
}

async function sourceTreeDigest(sourceRoot, packageEntries) {
  const files = [path.join(sourceRoot, "pnpm-lock.yaml")];
  for (const { packageRoot } of packageEntries) {
    files.push(path.join(packageRoot, "package.json"));
    files.push(...(await collectFiles(path.join(packageRoot, "src"))));
  }
  const hash = createHash("sha256");
  for (const filePath of files.sort((left, right) => left.localeCompare(right))) {
    hash.update(path.relative(sourceRoot, filePath).replaceAll(path.sep, "/"));
    hash.update("\0");
    hash.update(await fsp.readFile(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function packageContentDigest(packageRoot) {
  const hash = createHash("sha256");
  const files = await collectFiles(packageRoot, (filePath) => {
    return !path.relative(packageRoot, filePath).split(path.sep).includes("node_modules");
  });
  for (const filePath of files) {
    hash.update(path.relative(packageRoot, filePath).replaceAll(path.sep, "/"));
    hash.update("\0");
    hash.update(
      path.basename(filePath) === "package.json"
        ? stableJson(await readJson(filePath))
        : await fsp.readFile(filePath),
    );
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function packedContentDigest(archivePath) {
  const extractRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "marshal-runtime-pack-"));
  try {
    run("tar", ["-xf", archivePath, "-C", extractRoot], repositoryRoot);
    return await packageContentDigest(path.join(extractRoot, "package"));
  } finally {
    await fsp.rm(extractRoot, { recursive: true, force: true });
  }
}

async function stageRuntimeSwarmCompatibility(runtimeSourcePackageRoot, packages) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      "An existing verified Runtime archive is required to retain the standalone Swarm ABI.",
    );
  }
  const retainedManifest = await readJson(manifestPath);
  const retainedRuntime = retainedManifest.packages?.find(
    (entry) => entry.name === RUNTIME_PACKAGE,
  );
  if (!retainedRuntime) {
    throw new Error("The existing Runtime package manifest has no Runtime archive record.");
  }
  const retainedArchivePath = path.join(archivesDirectory, retainedRuntime.archive);
  await verifyArchive(retainedArchivePath, retainedRuntime.archiveSha256, RUNTIME_PACKAGE);

  const extractRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "marshal-runtime-compat-source-"));
  const overlayParent = await fsp.mkdtemp(path.join(os.tmpdir(), "marshal-runtime-overlay-"));
  const overlayRoot = path.join(overlayParent, "package");
  try {
    run("tar", ["-xf", retainedArchivePath, "-C", extractRoot], repositoryRoot);
    const retainedPackageRoot = path.join(extractRoot, "package");
    const retainedPackageManifest = await readJson(path.join(retainedPackageRoot, "package.json"));
    if (
      stableJson(retainedPackageManifest.exports?.["./swarm"]) !== stableJson(RUNTIME_SWARM_EXPORT)
    ) {
      throw new Error("The retained Runtime archive does not expose the required Swarm ABI.");
    }

    await fsp.cp(runtimeSourcePackageRoot, overlayRoot, {
      recursive: true,
      filter: (source) =>
        !path.relative(runtimeSourcePackageRoot, source).split(path.sep).includes("node_modules"),
    });
    const overlayDist = path.join(overlayRoot, "dist");
    const retainedDist = path.join(retainedPackageRoot, "dist");
    await fsp.cp(path.join(retainedDist, "swarm"), path.join(overlayDist, "swarm"), {
      recursive: true,
    });
    for (const extension of ["js", "js.map", "d.ts", "d.ts.map"]) {
      await fsp.copyFile(
        path.join(retainedDist, `swarm.${extension}`),
        path.join(overlayDist, `swarm.${extension}`),
      );
    }

    const overlayManifest = await readJson(path.join(overlayRoot, "package.json"));
    overlayManifest.exports = {
      ...overlayManifest.exports,
      "./swarm": RUNTIME_SWARM_EXPORT,
    };
    for (const [dependencyName, version] of Object.entries(overlayManifest.dependencies ?? {})) {
      if (typeof version === "string" && version.startsWith("workspace:")) {
        const dependency = packages.get(dependencyName);
        if (!dependency) {
          throw new Error(`Cannot resolve Runtime workspace dependency ${dependencyName}.`);
        }
        overlayManifest.dependencies[dependencyName] = dependency.manifest.version;
      }
    }
    await fsp.writeFile(
      path.join(overlayRoot, "package.json"),
      `${JSON.stringify(overlayManifest, null, 2)}\n`,
      "utf8",
    );

    const workspaceNodeModules = path.join(runtimeSourcePackageRoot, "node_modules");
    if (fs.existsSync(workspaceNodeModules)) {
      await fsp.symlink(workspaceNodeModules, path.join(overlayRoot, "node_modules"), "junction");
    }
    return {
      manifest: overlayManifest,
      packageRoot: overlayRoot,
      attestation: {
        sourceArchive: retainedRuntime.archive,
        sourceArchiveSha256: retainedRuntime.archiveSha256,
        sourceContentSha256: retainedRuntime.contentSha256,
      },
      cleanup: async () => {
        await fsp.rm(extractRoot, { recursive: true, force: true });
        await fsp.rm(overlayParent, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await fsp.rm(extractRoot, { recursive: true, force: true });
    await fsp.rm(overlayParent, { recursive: true, force: true });
    throw error;
  }
}

async function packedEntryDigest(archivePath, entrypoint) {
  const extractRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "marshal-runtime-entry-"));
  try {
    run("tar", ["-xf", archivePath, "-C", extractRoot], repositoryRoot);
    return await sha256File(path.join(extractRoot, "package", entrypoint));
  } finally {
    await fsp.rm(extractRoot, { recursive: true, force: true });
  }
}

function upstreamArchiveName(packageName, version) {
  return `${packageName.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
}

function packageEntrypoint(manifest) {
  if (manifest.name === RUNTIME_PACKAGE) return RUNTIME_ENTRYPOINT;
  if (typeof manifest.main === "string" && manifest.main.length > 0) return manifest.main;
  const rootExport =
    manifest.exports?.["."] ??
    (manifest.exports && typeof manifest.exports === "object"
      ? Object.entries(manifest.exports)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([, value]) => value)[0]
      : manifest.exports);
  const exported =
    typeof rootExport === "string"
      ? rootExport
      : ["default", "import", "require"]
          .map((condition) => rootExport?.[condition])
          .find((candidate) => typeof candidate === "string");
  if (typeof exported !== "string" || exported.length === 0) {
    throw new Error(`Runtime package ${manifest.name} has no package entrypoint.`);
  }
  return exported.replace(/^\.\//, "");
}

function archiveName(packageName, version) {
  return upstreamArchiveName(packageName, version).replace(/\.tgz$/, `-${PACKAGING_REVISION}.tgz`);
}

function generatedPinSource(manifest) {
  const packagePins = manifest.packages.map(
    ({ name, version, entrypoint, entrySha256, contentSha256 }) => ({
      name,
      version,
      entrypoint,
      entrySha256,
      contentSha256,
    }),
  );
  return `// Generated by scripts/prepare-marshal-runtime.mjs. Do not edit.
export const MARSHAL_RUNTIME_PACKAGE_PIN = Object.freeze(${typescriptLiteral({
    ...manifest.runtime,
    packages: packagePins,
  })} as const);

export const MARSHAL_RUNTIME_SOURCE_ATTESTATION = Object.freeze(${typescriptLiteral(
    manifest.source,
  )} as const);

export const MARSHAL_SWARM_SOURCE_ATTESTATION = Object.freeze(${typescriptLiteral(
    manifest.swarm.source,
  )} as const);
`;
}

async function writeGeneratedPin(manifest) {
  const source = generatedPinSource(manifest);
  await fsp.mkdir(path.dirname(generatedPinPath), { recursive: true });
  await fsp.writeFile(generatedPinPath, source, "utf8");
}

async function verifyArchive(archivePath, expectedSha256, expectedPackageName) {
  const digest = await sha256File(archivePath);
  if (digest !== expectedSha256) {
    throw new Error(`Runtime archive integrity mismatch: ${path.basename(archivePath)}.`);
  }
  const entries = run("tar", ["-tf", archivePath], repositoryRoot, { capture: true })
    .split(/\r?\n/)
    .filter(Boolean);
  const unsafe = entries.find((entry) => {
    const normalized = entry.replaceAll("\\", "/");
    return (
      normalized.startsWith("/") ||
      /^[a-z]:/i.test(normalized) ||
      normalized.split("/").includes("..")
    );
  });
  if (unsafe) throw new Error(`Runtime archive contains unsafe path ${unsafe}.`);

  const extractRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "marshal-runtime-verify-"));
  try {
    run("tar", ["-xf", archivePath, "-C", extractRoot], repositoryRoot);
    const packageRoot = path.join(extractRoot, "package");
    const packageManifest = await readJson(path.join(packageRoot, "package.json"));
    if (packageManifest.name !== expectedPackageName) {
      throw new Error(
        `Runtime archive package name mismatch: expected ${expectedPackageName}, received ${packageManifest.name}.`,
      );
    }
    if (expectedPackageName === SWARM_PACKAGE) {
      assertSwarmPackageManifest(packageManifest, `archive ${path.basename(archivePath)}`);
    } else {
      assertSwarmDependencyAbsent(packageManifest, `archive ${path.basename(archivePath)}`);
    }
    if (expectedPackageName === RUNTIME_PACKAGE) {
      await assertRuntimeSwarmSurface(packageRoot, packageManifest, {
        checkImports: false,
        checkMain: false,
      });
    }
  } finally {
    await fsp.rm(extractRoot, { recursive: true, force: true });
  }
}

async function loadRetainedSwarm() {
  const manifest = await readJson(manifestPath);
  // overlayReview is validated only when present: no schema-3 manifest this
  // script writes carries the record (marshal-host-7 and earlier predate it),
  // so requiring it made --runtime-only unusable against every committed
  // manifest while overlay-review ships as its own separately pinned archive.
  if (
    manifest.schemaVersion !== 3 ||
    manifest.runtime?.name !== RUNTIME_PACKAGE ||
    manifest.swarm?.name !== SWARM_PACKAGE ||
    (manifest.overlayReview !== undefined &&
      (manifest.overlayReview?.name !== "@marshal/overlay-review" ||
        typeof manifest.overlayReview?.source?.commit !== "string" ||
        manifest.overlayReview.source.commit.length !== 40 ||
        manifest.overlayReview.archiveSha256 !==
          manifest.packages?.find((entry) => entry.name === "@marshal/overlay-review")
            ?.archiveSha256))
  ) {
    throw new Error("Existing Marshal Runtime package manifest cannot retain Swarm.");
  }
  const swarmPackages = (manifest.packages ?? []).filter((entry) => entry.name === SWARM_PACKAGE);
  if (swarmPackages.length !== 1) {
    throw new Error(`Existing manifest must contain exactly one ${SWARM_PACKAGE} package record.`);
  }
  const packedSwarm = swarmPackages[0];
  const archivePath = path.join(archivesDirectory, packedSwarm.archive);
  const hostManifest = await readJson(path.join(repositoryRoot, "package.json"));
  await assertSwarmProductionOwnership(repositoryRoot, hostManifest, manifest);
  await verifyArchive(archivePath, packedSwarm.archiveSha256, SWARM_PACKAGE);
  if (
    (await packedEntryDigest(archivePath, packedSwarm.entrypoint)) !== packedSwarm.entrySha256 ||
    (await packedContentDigest(archivePath)) !== packedSwarm.contentSha256
  ) {
    throw new Error(`Existing ${SWARM_PACKAGE} archive does not match its package record.`);
  }
  return {
    source: manifest.swarm.source,
    // Carry the overlay provenance through plain retention: without this, any
    // repack run WITHOUT --swarm-guidance-from silently dropped
    // manifest.swarm.guidanceOverlay (worker had to restore it by hand on the
    // host-11 repack).
    ...(manifest.swarm.guidanceOverlay ? { guidanceOverlay: manifest.swarm.guidanceOverlay } : {}),
    package: packedSwarm,
  };
}

async function verifyArtifacts({ installed }) {
  const manifest = await readJson(manifestPath);
  if (
    manifest.schemaVersion !== 3 ||
    manifest.runtime?.name !== RUNTIME_PACKAGE ||
    manifest.swarm?.name !== SWARM_PACKAGE
  ) {
    throw new Error("Marshal Runtime package manifest is invalid.");
  }
  const hostManifest = await readJson(path.join(repositoryRoot, "package.json"));
  await assertSwarmProductionOwnership(repositoryRoot, hostManifest, manifest, { installed });
  for (const entry of manifest.packages ?? []) {
    await verifyArchive(
      path.join(archivesDirectory, entry.archive),
      entry.archiveSha256,
      entry.name,
    );
  }
  const expectedGeneratedPin = generatedPinSource(manifest);
  const actualGeneratedPin = await fsp.readFile(generatedPinPath, "utf8");
  if (actualGeneratedPin !== expectedGeneratedPin) {
    throw new Error("Generated Marshal Runtime package pin does not match the verified manifest.");
  }
  // pnpm-lock.yaml pins a sha512 for every file: tarball. A repack that reuses
  // an archive filename leaves the lock's integrity (and the installed copy)
  // on the OLD bytes silently — a fresh install then fails
  // ERR_PNPM_TARBALL_INTEGRITY while existing checkouts keep working. Verify
  // the lock against the actual archive bytes so the drift fails loudly here.
  const lockPath = path.join(repositoryRoot, "pnpm-lock.yaml");
  if (fs.existsSync(lockPath)) {
    const lock = await fsp.readFile(lockPath, "utf8");
    for (const entry of manifest.packages ?? []) {
      const match = lock.match(
        new RegExp(
          `\\{integrity: (sha512-[A-Za-z0-9+/=]+), tarball: file:\\.marshal-runtime-packs/archives/${entry.archive.replaceAll(".", "\\.")}\\}`,
        ),
      );
      if (!match) continue; // not a direct dependency; nothing pinned to check
      const digest = createHash("sha512")
        .update(await fsp.readFile(path.join(archivesDirectory, entry.archive)))
        .digest("base64");
      if (match[1] !== `sha512-${digest}`) {
        throw new Error(
          `pnpm-lock.yaml integrity for ${entry.archive} does not match the archive bytes; ` +
            "re-resolve the lock entry (fresh installs would fail ERR_PNPM_TARBALL_INTEGRITY).",
        );
      }
    }
  }
  // The hardcoded FIRST_PARTY_EXTENSION_CATALOG pins are only enforced against
  // installed copies at startup, so a repack that forgets to refresh the
  // catalog fails closed on the next fresh boot instead of here. Recompute each
  // pin from the actual archive bytes so the drift fails pack verification.
  const catalogPins = await verifyFirstPartyExtensionCatalogPins({
    catalogSource: await fsp.readFile(firstPartyCatalogPath, "utf8"),
    hostDependencies: hostManifest.dependencies,
    repositoryRoot,
    computeIntegrity: await loadRuntimeExtensionIntegrityCompute(),
  });
  if (installed) {
    for (const entry of manifest.packages) {
      const packageRoot = path.join(repositoryRoot, "node_modules", ...entry.name.split("/"));
      const packageManifest = await readJson(path.join(packageRoot, "package.json"));
      if (packageManifest.name !== entry.name || packageManifest.version !== entry.version) {
        throw new Error(`Installed ${entry.name} does not match the generated package pin.`);
      }
      if (entry.name === SWARM_PACKAGE) {
        assertSwarmPackageManifest(packageManifest, `installed ${entry.name}`);
      } else {
        assertSwarmDependencyAbsent(packageManifest, `installed ${entry.name}`);
      }
      if (entry.name === RUNTIME_PACKAGE) {
        await assertRuntimeSwarmSurface(packageRoot, packageManifest, {
          checkImports: true,
          checkMain: true,
        });
      }
      const entryDigest = await sha256File(path.join(packageRoot, entry.entrypoint));
      if (entryDigest !== entry.entrySha256) {
        throw new Error(
          `Installed ${entry.name} entrypoint does not match the generated package pin.`,
        );
      }
      const contentDigest = await packageContentDigest(packageRoot);
      if (contentDigest !== entry.contentSha256) {
        throw new Error(`Installed ${entry.name} contents do not match the generated package pin.`);
      }
    }
    verifyInstalledConsumerImports();
  }
  process.stdout.write(
    `Verified ${manifest.packages.length} Marshal Runtime package archives and ` +
      `${catalogPins} first-party extension catalog pins.\n`,
  );
}

async function loadRuntimeExtensionIntegrityCompute() {
  try {
    const extensions = await import("@marshal/runtime/extensions");
    return extensions.computeRuntimeExtensionIntegrity;
  } catch (error) {
    throw new Error(
      "Cannot load @marshal/runtime/extensions to verify first-party extension catalog pins; " +
        "install dependencies before running verification.",
      { cause: error },
    );
  }
}

/**
 * Build-artifact transform for the retained @marshal/swarm archive: inject the
 * committed agentGuidance manifest contribution into package/runtime-extension
 * .json WITHOUT rebuilding swarm from source (the shipped swarm content exists
 * in no clean commit — see the marshal-host-9 retention rationale). Everything
 * except that one file is verified byte-for-byte against the base archive, the
 * JSON delta is verified to be exactly the added agentGuidance field, and the
 * manifest records the base archive + guidance-source provenance.
 */
async function overlaySwarmGuidance(retainedSwarm, guidanceSourceRoot) {
  const sourceRoot = path.resolve(guidanceSourceRoot);
  const guidanceManifestPath = path.join(sourceRoot, "packages", "swarm", "runtime-extension.json");
  if (!fs.existsSync(guidanceManifestPath)) {
    throw new Error(
      `Swarm guidance source has no packages/swarm/runtime-extension.json: ${sourceRoot}.`,
    );
  }
  const dirty = run("git", ["status", "--porcelain"], sourceRoot, { capture: true });
  if (dirty.trim()) {
    throw new Error("Swarm guidance source worktree is dirty; commit the manifest first.");
  }
  const guidanceCommit = run("git", ["rev-parse", "HEAD"], sourceRoot, { capture: true });
  const guidanceManifest = await readJson(guidanceManifestPath);
  const agentGuidance = guidanceManifest.agentGuidance;
  if (!agentGuidance || typeof agentGuidance !== "object") {
    throw new Error("Swarm guidance manifest has no agentGuidance block.");
  }

  const baseEntry = retainedSwarm.package;
  const baseArchivePath = path.join(archivesDirectory, baseEntry.archive);
  const extractRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "marshal-swarm-overlay-"));
  try {
    run("tar", ["-xf", baseArchivePath, "-C", extractRoot], repositoryRoot);
    const extensionManifestPath = path.join(extractRoot, "package", "runtime-extension.json");
    const baseExtensionManifest = await readJson(extensionManifestPath);
    if (baseExtensionManifest.identity !== guidanceManifest.identity) {
      throw new Error(
        `Swarm guidance identity mismatch: archive ${baseExtensionManifest.identity} vs source ${guidanceManifest.identity}.`,
      );
    }
    if (baseExtensionManifest.agentGuidance !== undefined) {
      throw new Error("Retained swarm archive already carries agentGuidance.");
    }
    const overlaidManifest = { ...baseExtensionManifest, agentGuidance };
    const originalStat = await fsp.stat(extensionManifestPath);
    await fsp.writeFile(
      extensionManifestPath,
      `${JSON.stringify(overlaidManifest, null, 2)}\n`,
      "utf8",
    );
    // Deterministic output: keep every extracted mtime (tar preserved them) and
    // pin the rewritten file to its original mtime; sort members; strip the
    // gzip timestamp so identical inputs produce identical bytes.
    await fsp.utimes(extensionManifestPath, originalStat.atime, originalStat.mtime);
    const overlayArchiveName = `${baseEntry.archive.slice(0, -".tgz".length)}-guidance-${guidanceCommit.trim().slice(0, 7)}.tgz`;
    const overlayArchivePath = path.join(archivesDirectory, overlayArchiveName);
    run(
      "tar",
      [
        "--no-mac-metadata",
        "--options",
        "gzip:!timestamp",
        "-czf",
        overlayArchivePath,
        "-C",
        extractRoot,
        "package",
      ],
      repositoryRoot,
    );

    // Regression self-check: ONLY runtime-extension.json may differ, and its
    // JSON delta must be exactly the added agentGuidance field.
    const checkRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "marshal-swarm-overlay-check-"));
    try {
      const baseCheck = path.join(checkRoot, "base");
      const overlayCheck = path.join(checkRoot, "overlay");
      await fsp.mkdir(baseCheck);
      await fsp.mkdir(overlayCheck);
      run("tar", ["-xf", baseArchivePath, "-C", baseCheck], repositoryRoot);
      run("tar", ["-xf", overlayArchivePath, "-C", overlayCheck], repositoryRoot);
      const walk = async (root) => {
        const files = [];
        const visit = async (dir) => {
          for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) await visit(full);
            else files.push(path.relative(root, full));
          }
        };
        await visit(root);
        return files.sort();
      };
      const baseFiles = await walk(baseCheck);
      const overlayFiles = await walk(overlayCheck);
      if (JSON.stringify(baseFiles) !== JSON.stringify(overlayFiles)) {
        throw new Error("Swarm guidance overlay changed the archive file set.");
      }
      for (const file of baseFiles) {
        const baseDigest = await sha256File(path.join(baseCheck, file));
        const overlayDigest = await sha256File(path.join(overlayCheck, file));
        const isManifest = file === path.join("package", "runtime-extension.json");
        if (!isManifest && baseDigest !== overlayDigest) {
          throw new Error(
            `Swarm guidance overlay modified ${file}; only runtime-extension.json may change.`,
          );
        }
      }
      const baseJson = await readJson(path.join(baseCheck, "package", "runtime-extension.json"));
      const overlayJson = await readJson(
        path.join(overlayCheck, "package", "runtime-extension.json"),
      );
      const { agentGuidance: overlayGuidance, ...overlayRest } = overlayJson;
      if (
        stableJson(overlayRest) !== stableJson(baseJson) ||
        stableJson(overlayGuidance) !== stableJson(agentGuidance)
      ) {
        throw new Error(
          "Swarm guidance overlay JSON delta is not exactly the agentGuidance field.",
        );
      }
    } finally {
      await fsp.rm(checkRoot, { recursive: true, force: true });
    }

    return {
      package: {
        ...baseEntry,
        archive: overlayArchiveName,
        archiveSha256: await sha256File(overlayArchivePath),
        entrySha256: await packedEntryDigest(overlayArchivePath, baseEntry.entrypoint),
        contentSha256: await packedContentDigest(overlayArchivePath),
      },
      source: retainedSwarm.source,
      guidanceOverlay: {
        baseArchive: baseEntry.archive,
        baseArchiveSha256: baseEntry.archiveSha256,
        guidanceSource: {
          commit: guidanceCommit.trim(),
          manifestSha256: await sha256File(guidanceManifestPath),
        },
      },
    };
  } finally {
    await fsp.rm(extractRoot, { recursive: true, force: true });
  }
}

// Retain committed archives byte-for-byte for every package NOT named in
// --rebuild-only. Needed when the packaging source workspace cannot reproduce
// previously shipped package content (e.g. archives packed from a source
// snapshot that was never committed): only the packages the new source
// actually changed are rebuilt; everything else keeps its verified archive and
// records its original provenance under `retainedFrom`.
async function loadRetainedPackages(orderedNames, rebuildOnly, sourcePackages) {
  const manifest = await readJson(manifestPath);
  if (manifest.schemaVersion !== 3 || manifest.runtime?.name !== RUNTIME_PACKAGE) {
    throw new Error("Existing Marshal Runtime package manifest cannot retain packages.");
  }
  const retained = new Map();
  for (const name of orderedNames) {
    if (rebuildOnly.has(name) || name === SWARM_PACKAGE) continue;
    const entry = (manifest.packages ?? []).find((candidate) => candidate.name === name);
    if (!entry) {
      throw new Error(`Existing manifest has no ${name} record to retain.`);
    }
    if (entry.version !== sourcePackages.get(name)?.manifest.version) {
      throw new Error(`Retained ${name} version differs from the packaging source.`);
    }
    const archivePath = path.join(archivesDirectory, entry.archive);
    await verifyArchive(archivePath, entry.archiveSha256, name);
    if (
      (await packedEntryDigest(archivePath, entry.entrypoint)) !== entry.entrySha256 ||
      (await packedContentDigest(archivePath)) !== entry.contentSha256
    ) {
      throw new Error(`Existing ${name} archive does not match its package record.`);
    }
    retained.set(name, { entry, source: manifest.source });
  }
  return { retained, manifest };
}

/**
 * Runtime sources that take Quillstone as released tarballs (quillstone.lock.json + vendor/quillstone,
 * fetched by the source's scripts/fetch-quillstone.mjs) carry no @quillstone workspace packages.
 * Those tarballs are repacked verbatim under this packaging revision so the host pins them like the rest.
 */
async function loadExternalQuillstone(sourceRoot, closureManifests) {
  const lockPath = path.join(sourceRoot, "quillstone.lock.json");
  if (!fs.existsSync(lockPath)) return new Map();
  const lock = await readJson(lockPath);
  const available = new Map();
  for (const entry of lock.packages) {
    const file = path.join(sourceRoot, "vendor", "quillstone", entry.file);
    if (!fs.existsSync(file) || (await sha256File(file)) !== entry.sha256) {
      throw new Error(
        `Quillstone tarball ${entry.file} is missing or does not match quillstone.lock.json; run scripts/fetch-quillstone.mjs in ${sourceRoot}.`,
      );
    }
    available.set(entry.name, { name: entry.name, version: entry.version, file });
  }
  // Only what the production closure reaches is pinned: the lock also carries tools no host package imports.
  const external = new Map();
  const pending = closureManifests.flatMap((manifest) =>
    Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }),
  );
  while (pending.length > 0) {
    const name = pending.pop();
    if (!available.has(name) || external.has(name)) continue;
    const entry = available.get(name);
    external.set(name, entry);
    const tarballManifest = JSON.parse(
      run("tar", ["-xOf", entry.file, "package/package.json"], repositoryRoot, { capture: true }),
    );
    pending.push(
      ...Object.keys({ ...tarballManifest.dependencies, ...tarballManifest.optionalDependencies }),
    );
  }
  return new Map([...external].sort(([left], [right]) => left.localeCompare(right)));
}

async function preparePackages(
  sourceRoot,
  swarmSourceRoot,
  { runtimeOnly, rebuildOnly, swarmGuidanceFrom, rebuildSwarmOnly, swarmRuntimeLink },
) {
  const resolvedSourceRoot = path.resolve(sourceRoot);
  if (!fs.existsSync(path.join(resolvedSourceRoot, "pnpm-workspace.yaml"))) {
    throw new Error(`Marshal Runtime source is not a pnpm workspace: ${resolvedSourceRoot}.`);
  }
  let retainedSwarm = runtimeOnly ? await loadRetainedSwarm() : undefined;
  if (swarmGuidanceFrom) {
    if (!retainedSwarm && !rebuildSwarmOnly) {
      throw new Error(
        "--swarm-guidance-from requires --runtime-only (retained swarm archive) or --rebuild-swarm-from.",
      );
    }
    // In swarm-only rebuild mode the overlay applies to the freshly packed archive below.
    if (retainedSwarm) retainedSwarm = await overlaySwarmGuidance(retainedSwarm, swarmGuidanceFrom);
  }
  const resolvedSwarmSourceRoot = runtimeOnly ? undefined : path.resolve(swarmSourceRoot);
  if (
    resolvedSwarmSourceRoot &&
    !fs.existsSync(path.join(resolvedSwarmSourceRoot, "pnpm-workspace.yaml"))
  ) {
    throw new Error(`Marshal Swarm source is not a pnpm workspace: ${resolvedSwarmSourceRoot}.`);
  }
  const packages = await loadWorkspacePackages(resolvedSourceRoot);
  if (
    packages.has(SWARM_PACKAGE) ||
    fs.existsSync(path.join(resolvedSourceRoot, "packages", "swarm"))
  ) {
    throw new Error(`Standalone ${SWARM_PACKAGE} must remain external to the Runtime workspace.`);
  }
  const orderedNames = productionClosure(packages);
  const externalQuillstone = await loadExternalQuillstone(
    resolvedSourceRoot,
    orderedNames.map((name) => packages.get(name).manifest),
  );
  const packageEntries = orderedNames.map((name) => packages.get(name));
  const runtimeVersion = packages.get(RUNTIME_PACKAGE).manifest.version;
  const retention = rebuildOnly
    ? await loadRetainedPackages(orderedNames, rebuildOnly, packages)
    : rebuildSwarmOnly
      ? await loadRetainedPackages(orderedNames, new Set(), packages)
      : undefined;
  const retainedPackages = retention?.retained;
  const runtimeRetained = retainedPackages?.has(RUNTIME_PACKAGE) ?? false;
  if (retainedSwarm && retainedSwarm.package.dependencies?.[RUNTIME_PACKAGE] !== runtimeVersion) {
    throw new Error(`Retained ${SWARM_PACKAGE} requires a different ${RUNTIME_PACKAGE} version.`);
  }
  const swarmManifestPath = resolvedSwarmSourceRoot
    ? path.join(resolvedSwarmSourceRoot, "packages", "swarm", "package.json")
    : undefined;
  const swarmManifest = swarmManifestPath ? await readJson(swarmManifestPath) : undefined;
  if (swarmManifest) assertSwarmPackageManifest(swarmManifest, "source package");
  const swarmPackageEntry = swarmManifestPath
    ? {
        manifest: swarmManifest,
        packageRoot: path.dirname(swarmManifestPath),
      }
    : undefined;
  await assertHostSwarmComposition(repositoryRoot);
  const sourceCommit = run("git", ["rev-parse", "HEAD"], resolvedSourceRoot, { capture: true });
  const sourceCommitTimestamp = run(
    "git",
    ["show", "-s", "--format=%ct", sourceCommit],
    resolvedSourceRoot,
    { capture: true },
  );
  const dirtyDiff = run(
    "git",
    [
      "diff",
      "--binary",
      "HEAD",
      "--",
      ...packageEntries.map(({ packageRoot }) => path.relative(resolvedSourceRoot, packageRoot)),
    ],
    resolvedSourceRoot,
    { capture: true },
  );
  const treeDigest = await sourceTreeDigest(resolvedSourceRoot, packageEntries);
  const swarmSourceCommit = resolvedSwarmSourceRoot
    ? run("git", ["rev-parse", "HEAD"], resolvedSwarmSourceRoot, { capture: true })
    : undefined;
  const swarmSourceCommitTimestamp = resolvedSwarmSourceRoot
    ? run("git", ["show", "-s", "--format=%ct", swarmSourceCommit], resolvedSwarmSourceRoot, {
        capture: true,
      })
    : undefined;
  const swarmDirtyDiff = resolvedSwarmSourceRoot
    ? run(
        "git",
        [
          "diff",
          "--binary",
          "HEAD",
          "--",
          path.relative(resolvedSwarmSourceRoot, swarmPackageEntry.packageRoot),
        ],
        resolvedSwarmSourceRoot,
        { capture: true },
      )
    : undefined;
  const swarmTreeDigest = resolvedSwarmSourceRoot
    ? await sourceTreeDigest(resolvedSwarmSourceRoot, [swarmPackageEntry])
    : undefined;
  const buildEnv = { ...process.env, SOURCE_DATE_EPOCH: sourceCommitTimestamp };
  const swarmBuildEnv = resolvedSwarmSourceRoot
    ? { ...process.env, SOURCE_DATE_EPOCH: swarmSourceCommitTimestamp }
    : undefined;

  for (const { manifest, packageRoot } of packageEntries) {
    if (retainedPackages?.has(manifest.name)) continue;
    const distDirectory = path.join(packageRoot, "dist");
    if (fs.existsSync(distDirectory)) {
      await fsp.rm(distDirectory, { recursive: true, force: true });
    }
    run("pnpm", ["--filter", manifest.name, "run", "build"], resolvedSourceRoot, {
      env: buildEnv,
    });
  }
  const runtimeSourcePackageRoot = path.join(resolvedSourceRoot, "packages", "runtime");
  const runtimeCompatibility = runtimeRetained
    ? undefined
    : await stageRuntimeSwarmCompatibility(runtimeSourcePackageRoot, packages);
  const packPackageEntries = packageEntries
    .filter((entry) => !retainedPackages?.has(entry.manifest.name))
    .map((entry) =>
      entry.manifest.name === RUNTIME_PACKAGE && runtimeCompatibility
        ? runtimeCompatibility
        : entry,
    );
  try {
    for (const { manifest, packageRoot } of packPackageEntries) {
      assertSwarmDependencyAbsent(manifest, `source package ${manifest.name}`);
      if (manifest.name === RUNTIME_PACKAGE) {
        await assertRuntimeSwarmSurface(packageRoot, manifest, {
          checkImports: true,
          checkMain: true,
        });
      }
    }
    if (resolvedSwarmSourceRoot) {
      const swarmDistDirectory = path.join(swarmPackageEntry.packageRoot, "dist");
      if (fs.existsSync(swarmDistDirectory)) {
        await fsp.rm(swarmDistDirectory, { recursive: true, force: true });
      }
      // With every runtime archive retained (swarm-only rebuild) there is no
      // staged compatibility package — link the caller-supplied runtime root,
      // which must be the workspace the retained swarm archive was built against.
      const swarmBuildRuntime = runtimeCompatibility ?? {
        packageRoot: path.resolve(swarmRuntimeLink),
      };
      if (!fs.existsSync(path.join(swarmBuildRuntime.packageRoot, "package.json"))) {
        throw new Error(
          `--swarm-runtime-link is not a package root: ${swarmBuildRuntime.packageRoot}.`,
        );
      }
      const runtimeLinkPath = path.join(
        resolvedSwarmSourceRoot,
        "node_modules",
        ...RUNTIME_PACKAGE.split("/"),
      );
      let createdRuntimeLink = false;
      try {
        let usableRuntimeLink = false;
        try {
          usableRuntimeLink =
            (await fsp.realpath(runtimeLinkPath)) ===
            (await fsp.realpath(swarmBuildRuntime.packageRoot));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (!usableRuntimeLink) {
          let existingLink;
          try {
            existingLink = await fsp.lstat(runtimeLinkPath);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          if (existingLink && !existingLink.isSymbolicLink()) {
            throw new Error(`Cannot create Runtime link over ${runtimeLinkPath}.`);
          }
          if (existingLink) {
            await fsp.unlink(runtimeLinkPath);
          }
          await fsp.mkdir(path.dirname(runtimeLinkPath), { recursive: true });
          await fsp.symlink(swarmBuildRuntime.packageRoot, runtimeLinkPath, "junction");
          createdRuntimeLink = true;
        }
        run("pnpm", ["--filter", SWARM_PACKAGE, "run", "build"], resolvedSwarmSourceRoot, {
          env: swarmBuildEnv,
        });
      } finally {
        if (createdRuntimeLink) {
          await fsp.unlink(runtimeLinkPath);
        }
      }
    }

    await fsp.mkdir(archivesDirectory, { recursive: true });
    const retainedArchiveNames = new Set(
      [...(retainedPackages?.values() ?? [])].map(({ entry }) => entry.archive),
    );
    for (const entry of await fsp.readdir(archivesDirectory, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        entry.name.endsWith(`-${PACKAGING_REVISION}.tgz`) &&
        (!runtimeOnly ||
          (!entry.name.startsWith("marshal-swarm-") &&
            entry.name !== retainedSwarm.package.archive)) &&
        // Swarm-only rebuild: retained runtime archives of the current revision stay put.
        (!rebuildSwarmOnly || entry.name.startsWith("marshal-swarm-")) &&
        !retainedArchiveNames.has(entry.name)
      ) {
        await fsp.unlink(path.join(archivesDirectory, entry.name));
      }
    }

    const packedPackages = [];
    for (const { manifest, packageRoot } of packPackageEntries) {
      if (manifest.name === RUNTIME_PACKAGE) {
        run("pnpm", ["pack", "--pack-destination", archivesDirectory], packageRoot, {
          env: buildEnv,
        });
      } else {
        run(
          "pnpm",
          ["--filter", manifest.name, "pack", "--pack-destination", archivesDirectory],
          resolvedSourceRoot,
          { env: buildEnv },
        );
      }
      const archive = archiveName(manifest.name, manifest.version);
      const archivePath = path.join(archivesDirectory, archive);
      await fsp.rename(
        path.join(archivesDirectory, upstreamArchiveName(manifest.name, manifest.version)),
        archivePath,
      );
      const entrypoint = packageEntrypoint(manifest);
      const packed = {
        name: manifest.name,
        version: manifest.version,
        archive,
        archiveSha256: await sha256File(archivePath),
        entrypoint,
        entrySha256: await packedEntryDigest(archivePath, entrypoint),
        contentSha256: await packedContentDigest(archivePath),
        dependencies: Object.fromEntries(
          Object.entries(manifest.dependencies ?? {})
            .filter(([name]) => orderedNames.includes(name) || externalQuillstone.has(name))
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name]) => [
              name,
              packages.get(name)?.manifest.version ?? externalQuillstone.get(name).version,
            ]),
        ),
      };
      await verifyArchive(archivePath, packed.archiveSha256, manifest.name);
      packedPackages.push(packed);
    }
    for (const external of externalQuillstone.values()) {
      const archive = archiveName(external.name, external.version);
      const archivePath = path.join(archivesDirectory, archive);
      await fsp.copyFile(external.file, archivePath);
      const externalManifest = JSON.parse(
        run("tar", ["-xOf", archivePath, "package/package.json"], repositoryRoot, {
          capture: true,
        }),
      );
      if (
        externalManifest.name !== external.name ||
        externalManifest.version !== external.version
      ) {
        throw new Error(
          `Quillstone tarball ${external.file} is not ${external.name}@${external.version}.`,
        );
      }
      const entrypoint = packageEntrypoint(externalManifest);
      const packed = {
        name: external.name,
        version: external.version,
        archive,
        archiveSha256: await sha256File(archivePath),
        entrypoint,
        entrySha256: await packedEntryDigest(archivePath, entrypoint),
        contentSha256: await packedContentDigest(archivePath),
        dependencies: Object.fromEntries(
          Object.entries(externalManifest.dependencies ?? {})
            .filter(([name]) => externalQuillstone.has(name))
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name]) => [name, externalQuillstone.get(name).version]),
        ),
      };
      await verifyArchive(archivePath, packed.archiveSha256, external.name);
      packedPackages.push(packed);
    }
    let packedSwarm = retainedSwarm?.package;
    let freshGuidanceOverlay;
    if (resolvedSwarmSourceRoot) {
      run(
        "pnpm",
        ["--filter", SWARM_PACKAGE, "pack", "--pack-destination", archivesDirectory],
        resolvedSwarmSourceRoot,
        { env: swarmBuildEnv },
      );
      const swarmArchive = archiveName(SWARM_PACKAGE, swarmManifest.version);
      const swarmArchivePath = path.join(archivesDirectory, swarmArchive);
      await fsp.rename(
        path.join(archivesDirectory, upstreamArchiveName(SWARM_PACKAGE, swarmManifest.version)),
        swarmArchivePath,
      );
      packedSwarm = {
        name: SWARM_PACKAGE,
        version: swarmManifest.version,
        archive: swarmArchive,
        archiveSha256: await sha256File(swarmArchivePath),
        entrypoint: SWARM_ENTRYPOINT,
        entrySha256: await packedEntryDigest(swarmArchivePath, SWARM_ENTRYPOINT),
        contentSha256: await packedContentDigest(swarmArchivePath),
        dependencies: {
          [RUNTIME_PACKAGE]: runtimeVersion,
        },
      };
      await verifyArchive(swarmArchivePath, packedSwarm.archiveSha256, SWARM_PACKAGE);
      if (rebuildSwarmOnly && swarmGuidanceFrom) {
        // Same overlay contract as retained swarm: only runtime-extension.json
        // may change, and only by the added agentGuidance block.
        const overlaid = await overlaySwarmGuidance(
          {
            package: packedSwarm,
            source: {
              commit: swarmSourceCommit,
              dirtyDiffSha256: sha256(swarmDirtyDiff),
              sourceTreeSha256: swarmTreeDigest,
            },
          },
          swarmGuidanceFrom,
        );
        packedSwarm = overlaid.package;
        freshGuidanceOverlay = overlaid.guidanceOverlay;
      }
      if (rebuildSwarmOnly) {
        // The packed swarm must carry agentGuidance — natively from the source
        // manifest or via the overlay. A guidance-less archive would silently
        // regress the shipped prompt contract, so fail loudly here.
        const packedExtensionManifest = JSON.parse(
          run(
            "tar",
            [
              "-xOf",
              path.join(archivesDirectory, packedSwarm.archive),
              "package/runtime-extension.json",
            ],
            repositoryRoot,
            { capture: true },
          ),
        );
        if (
          !packedExtensionManifest.agentGuidance ||
          typeof packedExtensionManifest.agentGuidance !== "object"
        ) {
          throw new Error(
            "Swarm-only rebuild packed an archive without agentGuidance; pass --swarm-guidance-from or add agentGuidance to the swarm source runtime-extension.json.",
          );
        }
      }
    }
    if (!packedSwarm) {
      throw new Error(`No ${SWARM_PACKAGE} package is available for the Runtime manifest.`);
    }
    if (packedSwarm.dependencies?.[RUNTIME_PACKAGE] !== runtimeVersion) {
      throw new Error(`${SWARM_PACKAGE} requires a different ${RUNTIME_PACKAGE} version.`);
    }
    packedPackages.push(packedSwarm);
    if (retainedPackages) {
      for (const [, { entry, source }] of retainedPackages) {
        packedPackages.push({ ...entry, retainedFrom: entry.retainedFrom ?? source });
      }
    }

    const runtime = packedPackages.find((entry) => entry.name === RUNTIME_PACKAGE);
    const manifest = {
      schemaVersion: 3,
      source: {
        commit: sourceCommit,
        dirtyDiffSha256: sha256(dirtyDiff),
        sourceTreeSha256: treeDigest,
      },
      swarm: {
        name: SWARM_PACKAGE,
        source: retainedSwarm?.source ?? {
          commit: swarmSourceCommit,
          dirtyDiffSha256: sha256(swarmDirtyDiff),
          sourceTreeSha256: swarmTreeDigest,
        },
        ...(retainedSwarm?.guidanceOverlay
          ? { guidanceOverlay: retainedSwarm.guidanceOverlay }
          : freshGuidanceOverlay
            ? { guidanceOverlay: freshGuidanceOverlay }
            : {}),
      },
      runtime: {
        name: runtime.name,
        version: runtime.version,
        entrypoint: runtime.entrypoint,
        entrySha256: runtime.entrySha256,
        archiveSha256: runtime.archiveSha256,
        swarmCompatibility:
          runtimeCompatibility?.attestation ?? retention.manifest.runtime.swarmCompatibility,
      },
      packages: packedPackages.sort((left, right) => left.name.localeCompare(right.name)),
    };
    await fsp.mkdir(packRoot, { recursive: true });
    await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeGeneratedPin(manifest);
    await verifyArtifacts({ installed: false });
  } finally {
    await runtimeCompatibility?.cleanup();
  }
}

if (process.argv.includes("--verify")) {
  await verifyArtifacts({ installed: process.argv.includes("--installed") });
} else {
  const sourceRoot = readSourceArgument();
  const runtimeOnly = runtimeOnlyMode();
  const rebuildOnly = rebuildOnlySet();
  const rebuildSwarmFrom = rebuildSwarmFromArgument();
  if (rebuildSwarmFrom && (runtimeOnly || rebuildOnly)) {
    throw new Error(
      "--rebuild-swarm-from cannot be combined with --runtime-only or --rebuild-only.",
    );
  }
  const swarmRuntimeLink = swarmRuntimeLinkArgument();
  if (rebuildSwarmFrom && !swarmRuntimeLink) {
    throw new Error(
      "--rebuild-swarm-from requires --swarm-runtime-link <runtime package root the retained swarm was built against>.",
    );
  }
  if (swarmRuntimeLink && !rebuildSwarmFrom) {
    throw new Error("--swarm-runtime-link is only valid with --rebuild-swarm-from.");
  }
  const swarmSourceRoot = rebuildSwarmFrom ?? (runtimeOnly ? undefined : readSwarmSourceArgument());
  if (!sourceRoot) {
    throw new Error("Provide --source <path> or MARSHAL_RUNTIME_SOURCE for the Runtime workspace.");
  }
  if (!runtimeOnly && !swarmSourceRoot) {
    throw new Error(
      "Provide --swarm-source <path> or MARSHAL_SWARM_SOURCE for the Swarm workspace.",
    );
  }
  await preparePackages(sourceRoot, swarmSourceRoot, {
    runtimeOnly,
    rebuildOnly,
    rebuildSwarmOnly: Boolean(rebuildSwarmFrom),
    swarmRuntimeLink,
    swarmGuidanceFrom: swarmGuidanceSourceArgument(),
  });
}
