import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(repoRoot, "dist-baileys-stage0");
const sidecarFileName = "baileys-stage0-sidecar.mjs";
const sidecarPath = path.join(outputDir, sidecarFileName);
const probePath = path.join(outputDir, "baileys-stage0-probe.mjs");
const optionalModuleStubs = new Map([
  [
    "sharp",
    `module.exports = function unavailableSharp() {
      throw new Error("sharp is disabled in the Baileys Stage 0 fingerprint sidecar");
    };`,
  ],
  [
    "jimp",
    `module.exports = {
      Jimp: class UnavailableJimp {
        constructor() {
          throw new Error("jimp is disabled in the Baileys Stage 0 fingerprint sidecar");
        }
      },
      ResizeStrategy: { BILINEAR: "bilinear" },
    };`,
  ],
  [
    "audio-decode",
    `module.exports = async function unavailableAudioDecode() {
      throw new Error("audio-decode is disabled in the Baileys Stage 0 fingerprint sidecar");
    };`,
  ],
  [
    "link-preview-js",
    `module.exports = {
      getLinkPreview: async function unavailableLinkPreview() {
        throw new Error("link-preview-js is disabled in the Baileys Stage 0 fingerprint sidecar");
      },
    };`,
  ],
  [
    "bufferutil",
    `module.exports = {
      mask() {
        throw new Error("bufferutil is disabled in the Baileys Stage 0 fingerprint sidecar");
      },
      unmask() {
        throw new Error("bufferutil is disabled in the Baileys Stage 0 fingerprint sidecar");
      },
    };`,
  ],
  [
    "utf-8-validate",
    `module.exports = function unavailableUtf8Validate() {
      throw new Error("utf-8-validate is disabled in the Baileys Stage 0 fingerprint sidecar");
    };`,
  ],
]);

const optionalModuleStubPlugin = {
  name: "baileys-stage0-optional-module-stubs",
  setup(buildContext) {
    buildContext.onResolve(
      { filter: /^(sharp|jimp|audio-decode|link-preview-js|bufferutil|utf-8-validate)$/ },
      ({ path: importPath }) => ({
        path: importPath,
        namespace: "baileys-stage0-optional-module",
      }),
    );
    buildContext.onLoad(
      { filter: /.*/, namespace: "baileys-stage0-optional-module" },
      ({ path: importPath }) => ({
        contents: optionalModuleStubs.get(importPath),
        loader: "js",
      }),
    );
  },
};

const packageExpectations = [
  {
    name: "baileys",
    version: "7.0.0-rc14",
    license: "MIT",
    gitHead: "7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a",
    lockIntegrity:
      "sha512-pewtrljhWx5JTUBvvkXZz1fL3JPiwzjBsnhx/DWf2LWBx1cZNH7J/sF22xDehba5mySWUQU4a1Pwt7lWARUxaA==",
    manifestSha256: "55dd58bf3944a426e2e72f397464a2ef9173f54ae7cbca4082cac743a4a5c178",
    licenseSha256: "0d814b3b15ae28401c32d3d0042c9537f1216be765850fdb36ad507a3cc90aa4",
  },
  {
    name: "libsignal",
    version: "6.0.0",
    license: "GPL-3.0",
    lockIntegrity:
      "sha512-d/5V3YFtDljbFMufz4ncyUYGYhJl+vzAe+c2EFFBQ6bz1h8Q3IOMEGXYMzlibU60I+e8GagMMpji18iez3P1hA==",
    manifestSha256: "9407c8a9a4f54466991621250af3df24b639948218683b80293c21bfcabc7050",
    licenseSha256: "c61f12da7cdad526bdcbed47a4c0a603e60dbbfdaf8b66933cd088e9132c303f",
  },
  {
    name: "whatsapp-rust-bridge",
    version: "0.5.4",
    license: "MIT",
    lockIntegrity:
      "sha512-yYO1qSs0Fe7tGtnxOFHomocUD6IZtoAgmA4oDFyGIRZ67D3QZk3w7swA6XXFXNQngiyrg2k7tul6IrM3eUFh7A==",
    manifestSha256: "dd6026167866c0c5cc6a0089e989dbfc2a3ea6e7b6fa77385010ba64eb9ffa8f",
    distSha256: "13586c5d558b7a683f1aa5678dadf8cbe664182fbc63608d294c9a5c7378e206",
  },
];

function packageRoot(packageName) {
  return path.join(repoRoot, "node_modules", ...packageName.split("/"));
}

async function sha256(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

async function readJsonObject(filePath) {
  const value = JSON.parse(await readFile(filePath, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected JSON object at ${filePath}`);
  }
  return value;
}

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(entryPath)));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

async function collectPackageEvidence() {
  const lock = (await readFile(path.join(repoRoot, "pnpm-lock.yaml"), "utf8")).replaceAll(
    "\r\n",
    "\n",
  );
  const evidence = [];
  for (const expectation of packageExpectations) {
    const root = packageRoot(expectation.name);
    const manifestPath = path.join(root, "package.json");
    const manifest = await readJsonObject(manifestPath);
    if (
      manifest.name !== expectation.name ||
      manifest.version !== expectation.version ||
      manifest.license !== expectation.license
    ) {
      throw new Error(`Unexpected ${expectation.name} package metadata`);
    }
    if ((await sha256(manifestPath)) !== expectation.manifestSha256) {
      throw new Error(`Unexpected ${expectation.name} package manifest hash`);
    }
    const lockNeedle =
      `${expectation.name}@${expectation.version}:\n` +
      `    resolution: {integrity: ${expectation.lockIntegrity}`;
    if (!lock.includes(lockNeedle)) {
      throw new Error(`Missing exact ${expectation.name} lock integrity`);
    }

    const licensePath = path.join(root, "LICENSE");
    if (expectation.licenseSha256) {
      if (!existsSync(licensePath) || (await sha256(licensePath)) !== expectation.licenseSha256) {
        throw new Error(`Unexpected ${expectation.name} license evidence`);
      }
    } else if (existsSync(licensePath)) {
      throw new Error(`${expectation.name} unexpectedly contains a LICENSE file`);
    }

    evidence.push({
      name: expectation.name,
      version: expectation.version,
      license: expectation.license,
      registryGitHead: expectation.gitHead ?? null,
      lockIntegrity: expectation.lockIntegrity,
      manifestSha256: expectation.manifestSha256,
      licenseFile: expectation.licenseSha256
        ? { present: true, sha256: expectation.licenseSha256 }
        : { present: false, sha256: null },
    });
  }

  if (!lock.includes("libsignal: 6.0.0") || !lock.includes("whatsapp-rust-bridge: 0.5.4")) {
    throw new Error("Baileys transitive dependency versions are not exact in pnpm-lock.yaml");
  }
  return evidence;
}

async function verifyBridgeAssets() {
  const root = packageRoot("whatsapp-rust-bridge");
  const wasmFiles = (await listFiles(root)).filter((filePath) => filePath.endsWith(".wasm"));
  if (wasmFiles.length > 0) {
    throw new Error(
      `whatsapp-rust-bridge unexpectedly contains external wasm: ${wasmFiles.join(", ")}`,
    );
  }
  const distPath = path.join(root, "dist", "index.js");
  const expectation = packageExpectations.find(({ name }) => name === "whatsapp-rust-bridge");
  if (!expectation || (await sha256(distPath)) !== expectation.distSha256) {
    throw new Error("whatsapp-rust-bridge dist hash does not match the approved Stage 0 baseline");
  }
  const source = await readFile(distPath, "utf8");
  if (!/[A-Za-z0-9+/]{4096,}={0,2}/.test(source)) {
    throw new Error("whatsapp-rust-bridge no longer contains an embedded base64 payload");
  }
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
const packageEvidence = await collectPackageEvidence();
await verifyBridgeAssets();

const sidecarBuild = await build({
  entryPoints: [path.join(repoRoot, "electron", "baileys-stage0", "sidecar", "main.ts")],
  outfile: sidecarPath,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  legalComments: "none",
  sourcemap: false,
  metafile: true,
  treeShaking: true,
  plugins: [optionalModuleStubPlugin],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
]);
const externalImports = [
  ...new Set(
    Object.values(sidecarBuild.metafile.outputs).flatMap((output) =>
      output.imports.filter(({ external }) => external).map(({ path: importPath }) => importPath),
    ),
  ),
].sort();
const unexpectedExternalImports = externalImports.filter((importPath) => !builtins.has(importPath));
if (unexpectedExternalImports.length > 0) {
  throw new Error(
    `Baileys Stage 0 bundle has non-builtin external imports: ${unexpectedExternalImports.join(", ")}`,
  );
}

const sidecarStat = await stat(sidecarPath);
const manifest = {
  schemaVersion: 1,
  bundle: {
    fileName: sidecarFileName,
    format: "esm",
    target: "node24",
    byteLength: sidecarStat.size,
    sha256: await sha256(sidecarPath),
  },
  source: {
    entryPoint: "electron/baileys-stage0/sidecar/main.ts",
    inputCount: Object.keys(sidecarBuild.metafile.inputs).length,
    inputs: Object.keys(sidecarBuild.metafile.inputs)
      .map((inputPath) => path.relative(repoRoot, path.resolve(repoRoot, inputPath)))
      .sort(),
    externalImports,
    failClosedOptionalModuleStubs: [...optionalModuleStubs.keys()].sort(),
  },
  bridge: {
    packageName: "whatsapp-rust-bridge",
    packageVersion: "0.5.4",
    assetMode: "embedded-base64-wasm",
    externalAssets: [],
  },
  packages: packageEvidence,
  releaseGates: ["libsignal-gpl-3.0", "whatsapp-terms", "rust-bridge-license-file"],
};
await writeFile(
  path.join(outputDir, "baileys-stage0-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

await build({
  entryPoints: [path.join(repoRoot, "electron", "baileys-stage0", "probe-cli.ts")],
  outfile: probePath,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  legalComments: "none",
  sourcemap: false,
});

console.log(
  `[build:baileys-stage0] ${sidecarFileName} ${sidecarStat.size} bytes sha256=${manifest.bundle.sha256}`,
);
console.log(
  `[build:baileys-stage0] bridge=${manifest.bridge.assetMode} externalAssets=${manifest.bridge.externalAssets.length}`,
);
