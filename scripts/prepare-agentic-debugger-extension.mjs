import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectRuntimeExtensionPackageFiles } from "./runtime-extension-package-files.mjs";

const EXTENSION_PACKAGE = "@marshal/agentic-debugger-extension";
const EXTENSION_VERSION = "1.0.0";
const EXTENSION_ENTRYPOINT = "dist/runtime-extension.cjs";
const EXTENSION_UI_ENTRYPOINT = "dist/ui/index.mjs";
const EXTENSION_UI_STYLESHEET = "dist/ui/index.css";
const EXTENSION_UI_TYPES = "dist/types/ui/index.d.ts";
const EXTENSION_NATIVE_ENTRYPOINT = "dist/runtime/native-host.mjs";
const EXTENSION_NATIVE_TYPES = "dist/types/runtime/native-host.d.ts";
const EXTENSION_SERVICE_ID = "@marshal/agentic-debugger:debugger";
const EXTENSION_SOURCE_COMMIT = "88d719bbff54b4bc3cf60603cca8332480c08a8c";
const EXTENSION_ARCHIVE = "marshal-agentic-debugger-extension-1.0.0-marshal-host-1.tgz";
const EXTENSION_INTEGRITY_DOMAIN = "marshal-runtime-extension-package-v1";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const packRoot = path.join(repositoryRoot, ".marshal-runtime-packs");
const archivesDirectory = path.join(packRoot, "archives");
const manifestPath = path.join(packRoot, "extensions.json");
const generatedPinPath = path.join(
  repositoryRoot,
  "electron",
  "marshal-runtime",
  "agentic-debugger-extension-pin.generated.ts",
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

function run(command, args, cwd, options = {}) {
  const npmEntrypoint = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  const useNpmEntrypoint =
    process.platform === "win32" && command === "npm" && fs.existsSync(npmEntrypoint);
  const executable = useNpmEntrypoint ? process.execPath : command;
  const commandArgs = useNpmEntrypoint ? [npmEntrypoint, ...args] : args;
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

async function packageContentDigest(packageRoot) {
  const hash = createHash("sha256");
  const files = await collectRuntimeExtensionPackageFiles(packageRoot);
  files.sort((left, right) => left.localeCompare(right));
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

function unsigned64(value) {
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

async function runtimeExtensionIntegrity(packageRoot) {
  const hash = createHash("sha256");
  hash.update(EXTENSION_INTEGRITY_DOMAIN, "utf8");
  hash.update(Buffer.from([0]));
  for (const filePath of await collectRuntimeExtensionPackageFiles(packageRoot)) {
    const relativePath = path.relative(packageRoot, filePath).replaceAll(path.sep, "/");
    const relativeBytes = Buffer.from(relativePath, "utf8");
    const fileBytes = await fsp.readFile(filePath);
    hash.update(Buffer.from([0x46]));
    hash.update(unsigned64(relativeBytes.length));
    hash.update(relativeBytes);
    hash.update(unsigned64(fileBytes.length));
    hash.update(fileBytes);
  }
  return {
    algorithm: "sha256",
    domain: EXTENSION_INTEGRITY_DOMAIN,
    value: hash.digest("hex"),
  };
}

function sourceArgument() {
  const inline = process.argv.find((argument) => argument.startsWith("--source="));
  if (inline) return inline.slice("--source=".length);
  const index = process.argv.indexOf("--source");
  return index >= 0 ? process.argv[index + 1] : process.env.MARSHAL_AGENTIC_DEBUGGER_SOURCE;
}

function generatedPinSource(manifest) {
  const [extension] = manifest.extensions;
  const pin = {
    name: extension.name,
    version: extension.version,
    entrypoint: extension.entrypoint,
    entrySha256: extension.entrySha256,
    contentSha256: extension.contentSha256,
    integrity: extension.integrity,
  };
  return `// Generated by scripts/prepare-agentic-debugger-extension.mjs. Do not edit.
export const AGENTIC_DEBUGGER_EXTENSION_PIN = Object.freeze(${typescriptLiteral(pin)} as const);

export const AGENTIC_DEBUGGER_EXTENSION_SOURCE_ATTESTATION = Object.freeze(${typescriptLiteral(
    manifest.source,
  )} as const);
`;
}

async function extractArchive(archivePath, prefix) {
  const extractRoot = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
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
  if (unsafe) {
    await fsp.rm(extractRoot, { recursive: true, force: true });
    throw new Error(`Runtime extension archive contains unsafe path ${unsafe}.`);
  }
  run("tar", ["-xf", archivePath, "-C", extractRoot], repositoryRoot);
  return { extractRoot, packageRoot: path.join(extractRoot, "package") };
}

async function inspectPackage(packageRoot) {
  const packageManifest = await readJson(path.join(packageRoot, "package.json"));
  const extensionManifest = await readJson(path.join(packageRoot, "runtime-extension.json"));
  if (
    packageManifest.name !== EXTENSION_PACKAGE ||
    packageManifest.version !== EXTENSION_VERSION ||
    packageManifest.type !== "commonjs" ||
    packageManifest.main !== EXTENSION_ENTRYPOINT ||
    packageManifest.exports?.["./ui"]?.import !== `./${EXTENSION_UI_ENTRYPOINT}` ||
    packageManifest.exports?.["./ui"]?.types !== `./${EXTENSION_UI_TYPES}` ||
    packageManifest.exports?.["./ui/styles.css"]?.default !== `./${EXTENSION_UI_STYLESHEET}` ||
    packageManifest.exports?.["./native"]?.import !== `./${EXTENSION_NATIVE_ENTRYPOINT}` ||
    packageManifest.exports?.["./native"]?.types !== `./${EXTENSION_NATIVE_TYPES}`
  ) {
    throw new Error("Agentic debugger package metadata is invalid.");
  }
  if (
    extensionManifest.schemaVersion !== 1 ||
    extensionManifest.identity !== EXTENSION_PACKAGE ||
    extensionManifest.version !== EXTENSION_VERSION ||
    extensionManifest.entrypoint !== EXTENSION_ENTRYPOINT ||
    extensionManifest.moduleFormat !== "commonjs-bundle-v1" ||
    extensionManifest.provides?.services?.some(
      (service) => service.id === EXTENSION_SERVICE_ID && service.version === EXTENSION_VERSION,
    ) !== true
  ) {
    throw new Error("Agentic debugger runtime extension manifest is invalid.");
  }
  await Promise.all([
    fsp.access(path.join(packageRoot, EXTENSION_NATIVE_ENTRYPOINT)),
    fsp.access(path.join(packageRoot, EXTENSION_NATIVE_TYPES)),
  ]);
  return {
    name: EXTENSION_PACKAGE,
    version: EXTENSION_VERSION,
    entrypoint: EXTENSION_ENTRYPOINT,
    entrySha256: await sha256File(path.join(packageRoot, EXTENSION_ENTRYPOINT)),
    contentSha256: await packageContentDigest(packageRoot),
    integrity: await runtimeExtensionIntegrity(packageRoot),
  };
}

async function verifyPackage(packageRoot, expected, label) {
  const actual = await inspectPackage(packageRoot);
  for (const field of ["name", "version", "entrypoint", "entrySha256", "contentSha256"]) {
    if (actual[field] !== expected[field]) {
      throw new Error(`${label} ${field} does not match the pinned extension.`);
    }
  }
  if (
    actual.integrity.algorithm !== expected.integrity?.algorithm ||
    actual.integrity.domain !== expected.integrity?.domain ||
    actual.integrity.value !== expected.integrity?.value
  ) {
    throw new Error(`${label} runtime extension integrity does not match the pin.`);
  }
}

async function verifyArtifacts({ installed }) {
  const manifest = await readJson(manifestPath);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.source?.commit !== EXTENSION_SOURCE_COMMIT ||
    !/^[a-f0-9]{40,64}$/.test(manifest.source?.tree ?? "") ||
    !/^[a-f0-9]{64}$/.test(manifest.source?.archiveSha256 ?? "") ||
    !Array.isArray(manifest.extensions) ||
    manifest.extensions.length !== 1
  ) {
    throw new Error("Agentic debugger extension pin manifest is invalid.");
  }
  const [extension] = manifest.extensions;
  if (
    extension.name !== EXTENSION_PACKAGE ||
    extension.version !== EXTENSION_VERSION ||
    extension.entrypoint !== EXTENSION_ENTRYPOINT ||
    extension.archive !== EXTENSION_ARCHIVE
  ) {
    throw new Error("Agentic debugger extension pin is invalid.");
  }

  const archivePath = path.join(archivesDirectory, extension.archive);
  if ((await sha256File(archivePath)) !== extension.archiveSha256) {
    throw new Error("Agentic debugger extension archive integrity mismatch.");
  }
  const extracted = await extractArchive(archivePath, "marshal-agentic-debugger-verify-");
  try {
    await verifyPackage(extracted.packageRoot, extension, "Archived package");
  } finally {
    await fsp.rm(extracted.extractRoot, { recursive: true, force: true });
  }

  const expectedPin = generatedPinSource(manifest);
  if ((await fsp.readFile(generatedPinPath, "utf8")) !== expectedPin) {
    throw new Error("Generated agentic debugger extension pin does not match its manifest.");
  }

  const expectedReference = `file:.marshal-runtime-packs/archives/${EXTENSION_ARCHIVE}`;
  const hostManifest = await readJson(path.join(repositoryRoot, "package.json"));
  if (hostManifest.dependencies?.[EXTENSION_PACKAGE] !== expectedReference) {
    throw new Error(`Marshal host must pin ${EXTENSION_PACKAGE} to ${expectedReference}.`);
  }
  if (installed) {
    const lockSource = await fsp.readFile(path.join(repositoryRoot, "pnpm-lock.yaml"), "utf8");
    if (!lockSource.includes(expectedReference)) {
      throw new Error("Marshal lockfile is missing the agentic debugger extension archive.");
    }
    await verifyPackage(
      path.join(repositoryRoot, "node_modules", ...EXTENSION_PACKAGE.split("/")),
      extension,
      "Installed package",
    );
  }
  process.stdout.write(
    `Verified ${EXTENSION_PACKAGE}@${EXTENSION_VERSION} from ${EXTENSION_SOURCE_COMMIT}.\n`,
  );
}

async function prepare(sourceRoot) {
  const resolvedSourceRoot = path.resolve(sourceRoot);
  const sourceCommit = run("git", ["rev-parse", "HEAD"], resolvedSourceRoot, { capture: true });
  if (sourceCommit !== EXTENSION_SOURCE_COMMIT) {
    throw new Error(
      `Agentic debugger source must be ${EXTENSION_SOURCE_COMMIT}; received ${sourceCommit}.`,
    );
  }
  const sourceTree = run("git", ["rev-parse", `${sourceCommit}^{tree}`], resolvedSourceRoot, {
    capture: true,
  });
  const sourceCommitTimestamp = run(
    "git",
    ["show", "-s", "--format=%ct", sourceCommit],
    resolvedSourceRoot,
    { capture: true },
  );
  const workRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "marshal-agentic-debugger-pack-"));
  try {
    const sourceArchive = path.join(workRoot, "source.tar");
    const stagedSource = path.join(workRoot, "source");
    await fsp.mkdir(stagedSource);
    run(
      "git",
      ["archive", "--format=tar", `--output=${sourceArchive}`, sourceCommit],
      resolvedSourceRoot,
    );
    run("tar", ["-xf", sourceArchive, "-C", stagedSource], repositoryRoot);
    const buildEnvironment = {
      ...process.env,
      SOURCE_DATE_EPOCH: sourceCommitTimestamp,
    };
    run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], stagedSource, {
      capture: true,
      env: buildEnvironment,
    });
    run("npm", ["run", "build"], stagedSource, {
      capture: true,
      env: buildEnvironment,
    });

    const sourcePackageManifest = await readJson(path.join(stagedSource, "package.json"));
    if (
      sourcePackageManifest.name !== EXTENSION_PACKAGE ||
      sourcePackageManifest.version !== EXTENSION_VERSION ||
      sourcePackageManifest.type !== "commonjs" ||
      sourcePackageManifest.main !== EXTENSION_ENTRYPOINT
    ) {
      throw new Error("Agentic debugger source package metadata is invalid.");
    }

    const firstPackRoot = path.join(workRoot, "pack-one");
    const secondPackRoot = path.join(workRoot, "pack-two");
    await Promise.all([
      fsp.mkdir(firstPackRoot, { recursive: true }),
      fsp.mkdir(secondPackRoot, { recursive: true }),
    ]);
    run("npm", ["pack", "--ignore-scripts", "--pack-destination", firstPackRoot], stagedSource, {
      capture: true,
      env: buildEnvironment,
    });
    run("npm", ["pack", "--ignore-scripts", "--pack-destination", secondPackRoot], stagedSource, {
      capture: true,
      env: buildEnvironment,
    });
    const upstreamArchive = "marshal-agentic-debugger-extension-1.0.0.tgz";
    const firstArchive = path.join(firstPackRoot, upstreamArchive);
    const secondArchive = path.join(secondPackRoot, upstreamArchive);
    const firstDigest = await sha256File(firstArchive);
    if (firstDigest !== (await sha256File(secondArchive))) {
      throw new Error("Agentic debugger npm archive is not deterministic.");
    }

    await fsp.mkdir(archivesDirectory, { recursive: true });
    const archivePath = path.join(archivesDirectory, EXTENSION_ARCHIVE);
    await fsp.copyFile(firstArchive, archivePath);
    const extracted = await extractArchive(archivePath, "marshal-agentic-debugger-inspect-");
    let packageMetadata;
    try {
      packageMetadata = await inspectPackage(extracted.packageRoot);
    } finally {
      await fsp.rm(extracted.extractRoot, { recursive: true, force: true });
    }
    const manifest = {
      schemaVersion: 1,
      source: {
        commit: sourceCommit,
        tree: sourceTree,
        archiveSha256: await sha256File(sourceArchive),
      },
      extensions: [
        {
          ...packageMetadata,
          archive: EXTENSION_ARCHIVE,
          archiveSha256: firstDigest,
        },
      ],
    };
    await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await fsp.mkdir(path.dirname(generatedPinPath), { recursive: true });
    await fsp.writeFile(generatedPinPath, generatedPinSource(manifest), "utf8");
  } finally {
    await fsp.rm(workRoot, { recursive: true, force: true });
  }
}

if (process.argv.includes("--verify")) {
  await verifyArtifacts({ installed: process.argv.includes("--installed") });
} else {
  const sourceRoot = sourceArgument();
  if (!sourceRoot) {
    throw new Error(
      "Provide --source <path> or MARSHAL_AGENTIC_DEBUGGER_SOURCE for the debugger source.",
    );
  }
  await prepare(sourceRoot);
}
