// Provenance-preserving overlay for the retained @marshal/agent-runtime-host
// archive: replaces ONLY the compositionCatalog artifacts (see
// .marshal-runtime-packs/overlays/agent-runtime-host-composition/) on top of
// the retained marshal-host-7 bytes, mirroring the swarm agentGuidance overlay
// in scripts/prepare-marshal-runtime.mjs. The base archive's other content
// exists in no clean commit and is never rebuilt here. Verification stays with
// `node scripts/prepare-marshal-runtime.mjs --verify [--installed]`, which this
// script's manifest/pin updates must satisfy unchanged.
//
// Usage: node scripts/overlay-agent-runtime-host-composition.mjs
// Idempotent: always overlays from the pinned base archive; identical inputs
// produce identical archive bytes.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packRoot = path.join(repositoryRoot, ".marshal-runtime-packs");
const archivesDirectory = path.join(packRoot, "archives");
const overlayRoot = path.join(packRoot, "overlays", "agent-runtime-host-composition");
const manifestPath = path.join(packRoot, "manifest.json");
const generatedPinPath = path.join(
  repositoryRoot,
  "electron",
  "marshal-runtime",
  "runtime-package-pin.generated.ts",
);

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  return sha256(await fsp.readFile(filePath));
}

// Mirrors stableJson in prepare-marshal-runtime.mjs (package.json content digest).
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

async function collectFiles(root) {
  const files = [];
  const visit = async (directory) => {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  if (fs.existsSync(root)) await visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

// Mirrors packageContentDigest in prepare-marshal-runtime.mjs.
async function packageContentDigest(packageRoot) {
  const hash = createHash("sha256");
  const files = (await collectFiles(packageRoot)).filter(
    (filePath) => !path.relative(packageRoot, filePath).split(path.sep).includes("node_modules"),
  );
  for (const filePath of files) {
    hash.update(path.relative(packageRoot, filePath).replaceAll(path.sep, "/"));
    hash.update("\0");
    hash.update(
      path.basename(filePath) === "package.json"
        ? stableJson(JSON.parse(await fsp.readFile(filePath, "utf8")))
        : await fsp.readFile(filePath),
    );
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

const provenance = await readJson(path.join(overlayRoot, "provenance.json"));
const baseArchivePath = path.join(archivesDirectory, provenance.baseArchive);
const baseDigest = await sha256File(baseArchivePath);
if (baseDigest !== provenance.baseArchiveSha256) {
  throw new Error(`Base archive integrity mismatch: ${provenance.baseArchive}.`);
}

const extractRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "marshal-host-composition-overlay-"));
const checkRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "marshal-host-composition-check-"));
try {
  run("tar", ["-xf", baseArchivePath, "-C", extractRoot], repositoryRoot);
  const packageRoot = path.join(extractRoot, "package");

  const overlayFiles = provenance.files;
  const overlaidHashes = {};
  for (const relative of overlayFiles) {
    // Vendored copies carry a .vendored suffix so repo lint hooks never treat
    // this foreign package source as project code.
    const source = path.join(overlayRoot, `${relative}.vendored`);
    const target = path.join(packageRoot, relative);
    if (!fs.existsSync(source)) throw new Error(`Overlay file missing: ${relative}.`);
    if (!fs.existsSync(target)) throw new Error(`Base archive has no ${relative} to replace.`);
    const originalStat = await fsp.stat(target);
    await fsp.copyFile(source, target);
    // Deterministic output: pin replaced files to the base entry's mtime so
    // only content differs (same approach as the swarm guidance overlay).
    await fsp.utimes(target, originalStat.atime, originalStat.mtime);
    overlaidHashes[relative] = await sha256File(target);
  }

  const overlayArchiveName = `${provenance.baseArchive.slice(0, -".tgz".length)}-composition-${provenance.source.commit.slice(0, 7)}.tgz`;
  const overlayArchivePath = path.join(archivesDirectory, overlayArchiveName);
  // Byte-reproducible repack: directory mtimes are extraction-time (tar only
  // preserves file mtimes), so pin every directory to the base package.json
  // mtime, and feed tar an explicitly sorted member list instead of relying on
  // readdir order.
  const anchorStat = await fsp.stat(path.join(packageRoot, "package.json"));
  const pinDirectories = async (directory) => {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await pinDirectories(path.join(directory, entry.name));
    }
    await fsp.utimes(directory, anchorStat.atime, anchorStat.mtime);
  };
  await pinDirectories(packageRoot);
  const collectEntries = async (directory) => {
    const entries = [];
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      entries.push(target);
      if (entry.isDirectory()) entries.push(...(await collectEntries(target)));
    }
    return entries;
  };
  const memberList = [
    "package",
    ...(await collectEntries(packageRoot))
      .map((file) =>
        path.join("package", path.relative(packageRoot, file)).replaceAll(path.sep, "/"),
      )
      .sort((left, right) => left.localeCompare(right)),
  ];
  const memberListPath = path.join(extractRoot, "members.txt");
  await fsp.writeFile(memberListPath, `${memberList.join("\n")}\n`, "utf8");
  run(
    "tar",
    [
      "--no-mac-metadata",
      "--options",
      "gzip:!timestamp",
      "--no-recursion",
      "-czf",
      overlayArchivePath,
      "-C",
      extractRoot,
      "-T",
      memberListPath,
    ],
    repositoryRoot,
  );

  // Regression self-check: exactly the overlay files may differ from the base
  // archive; nothing else changes, appears, or disappears.
  run("tar", ["-xf", baseArchivePath, "-C", checkRoot], repositoryRoot);
  const basePackageRoot = path.join(checkRoot, "package");
  const baseFiles = await collectFiles(basePackageRoot);
  const overlaidFiles = await collectFiles(packageRoot);
  const relativeOf = (root, files) => files.map((file) => path.relative(root, file));
  const baseRelative = relativeOf(basePackageRoot, baseFiles);
  const overlaidRelative = relativeOf(packageRoot, overlaidFiles);
  if (JSON.stringify(baseRelative) !== JSON.stringify(overlaidRelative)) {
    throw new Error("Overlay changed the archive file set; refusing to continue.");
  }
  const expectedDiff = new Set(overlayFiles.map((relative) => relative.replaceAll("/", path.sep)));
  for (const relative of baseRelative) {
    const same =
      (await sha256File(path.join(basePackageRoot, relative))) ===
      (await sha256File(path.join(packageRoot, relative)));
    if (!same && !expectedDiff.has(relative)) {
      throw new Error(`Unexpected overlay delta in ${relative}; refusing to continue.`);
    }
    if (same && expectedDiff.has(relative)) {
      throw new Error(`Expected overlay delta missing in ${relative}.`);
    }
  }

  const manifest = await readJson(manifestPath);
  const entry = (manifest.packages ?? []).find(
    (candidate) => candidate.name === provenance.package,
  );
  if (!entry) throw new Error(`Manifest has no ${provenance.package} entry.`);
  const previousContentSha256 = entry.contentSha256;

  const entryDigest = await sha256File(path.join(packageRoot, entry.entrypoint));
  if (entryDigest !== entry.entrySha256) {
    throw new Error("Overlay must not change the package entrypoint digest.");
  }

  entry.archive = overlayArchiveName;
  entry.archiveSha256 = await sha256File(overlayArchivePath);
  entry.contentSha256 = await packageContentDigest(packageRoot);
  entry.compositionOverlay = {
    baseArchive: provenance.baseArchive,
    baseArchiveSha256: provenance.baseArchiveSha256,
    source: provenance.source,
    files: overlaidHashes,
  };
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  // The generated pin lists {name, version, entrypoint, entrySha256,
  // contentSha256}; only the host contentSha256 changes, so a digest swap keeps
  // the file byte-equal to what prepare-marshal-runtime.mjs --verify expects.
  const pinSource = await fsp.readFile(generatedPinPath, "utf8");
  if (!pinSource.includes(previousContentSha256)) {
    if (!pinSource.includes(entry.contentSha256)) {
      throw new Error("Generated pin has neither the previous nor the new host content digest.");
    }
  } else {
    await fsp.writeFile(
      generatedPinPath,
      pinSource.replace(previousContentSha256, entry.contentSha256),
      "utf8",
    );
  }

  // Point the host dependency at the overlay archive.
  const hostManifestPath = path.join(repositoryRoot, "package.json");
  const hostManifest = await fsp.readFile(hostManifestPath, "utf8");
  const baseReference = `file:.marshal-runtime-packs/archives/${provenance.baseArchive}`;
  const overlayReference = `file:.marshal-runtime-packs/archives/${overlayArchiveName}`;
  if (hostManifest.includes(baseReference)) {
    await fsp.writeFile(
      hostManifestPath,
      hostManifest.replace(baseReference, overlayReference),
      "utf8",
    );
  } else if (!hostManifest.includes(overlayReference)) {
    throw new Error("package.json references neither the base nor the overlay archive.");
  }

  process.stdout.write(
    `Overlaid ${provenance.package}: ${overlayArchiveName}\n` +
      `  archiveSha256 ${entry.archiveSha256}\n` +
      `  contentSha256 ${entry.contentSha256}\n` +
      "Run `pnpm install` to re-resolve the lockfile, then " +
      "`node scripts/prepare-marshal-runtime.mjs --verify --installed`.\n",
  );
} finally {
  await fsp.rm(extractRoot, { recursive: true, force: true });
  await fsp.rm(checkRoot, { recursive: true, force: true });
}
