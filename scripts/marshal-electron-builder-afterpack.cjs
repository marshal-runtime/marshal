// electron-builder afterPack hook — removes cross-platform binaries from the
// packaged app. With pnpm's supportedArchitectures config, ALL platform variants
// are installed locally (needed for dev), but only the target platform's binaries
// should ship in the installer.
const fs = require("fs");
const path = require("path");
const crypto = require("node:crypto");
const { spawnSync } = require("child_process");

// electron-builder arch enum → Node.js arch string
const ARCH_MAP = { 1: "x64", 3: "arm64", 2: "ia32" };

const PLATFORM_MAP = { win32: "win32", darwin: "darwin", linux: "linux" };

const SUPPORTED_RUNTIME_ARCHES = new Set(["x64", "arm64"]);
const MARSHAL_RUNTIME_PACKAGE_SCOPES = new Set(["@agentic-browser", "@marshal"]);
const BAILEYS_STAGE0_PACKAGE_ENV = "MARSHAL_BAILEYS_STAGE0_PACKAGE";
const BAILEYS_STAGE0_OUTPUT_DIR = "dist-baileys-stage0";
const BAILEYS_STAGE0_RESOURCE_DIR = "baileys-stage0";
const BAILEYS_STAGE0_BUNDLE = "baileys-stage0-sidecar.mjs";
const BAILEYS_STAGE0_MANIFEST = "baileys-stage0-manifest.json";
const WHATSAPP_SIDECAR_PACKAGE_ENV = "MARSHAL_WHATSAPP_SIDECAR_PACKAGE";
const WHATSAPP_SIDECAR_OUTPUT_DIR = "dist-whatsapp-sidecar";
const WHATSAPP_SIDECAR_RESOURCE_DIR = "whatsapp-sidecar";
const WHATSAPP_SIDECAR_BUNDLE = "whatsapp-sidecar.mjs";
const WHATSAPP_SIDECAR_MANIFEST = "whatsapp-sidecar-manifest.json";
const CLAUDE_AGENT_SDK_VERSION = "0.3.302";
const CLAUDE_NATIVE_PACKAGE_ENTRIES = [
  "claude-agent-sdk-darwin-arm64",
  "claude-agent-sdk-darwin-x64",
  "claude-agent-sdk-linux-arm64",
  "claude-agent-sdk-linux-arm64-musl",
  "claude-agent-sdk-linux-x64",
  "claude-agent-sdk-linux-x64-musl",
  "claude-agent-sdk-win32-arm64",
  "claude-agent-sdk-win32-x64",
];
const CODEX_NATIVE_PACKAGE_ENTRIES = [
  "codex-darwin-arm64",
  "codex-darwin-x64",
  "codex-linux-arm64",
  "codex-linux-x64",
  "codex-win32-arm64",
  "codex-win32-x64",
];
const CODEX_TARGET_TRIPLES = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-x64": "x86_64-unknown-linux-musl",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "win32-x64": "x86_64-pc-windows-msvc",
};

function removeEntries(dir, shouldKeep, label) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (shouldKeep(entry)) continue;
    const fullPath = path.join(dir, entry);
    if (!fs.statSync(fullPath).isDirectory()) continue;
    fs.rmSync(fullPath, { recursive: true, force: true });
    console.log(`  afterPack: removed ${label}/${entry}`);
  }
}

function copyPackageIfMissing(projectDir, unpackedNodeModules, packagePath) {
  const source = path.join(projectDir, "node_modules", packagePath);
  const destination = path.join(unpackedNodeModules, packagePath);
  if (fs.existsSync(path.join(destination, "package.json"))) return;
  if (!fs.existsSync(source)) {
    throw new Error(`afterPack: required runtime package source is missing: ${source}.`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, force: true, dereference: true });
  console.log(`  afterPack: copied ${packagePath} into app.asar.unpacked/node_modules`);
}

function packageNameToPath(packageName) {
  return path.join(...packageName.split("/"));
}

function isMarshalRuntimePackageName(packageName) {
  if (typeof packageName !== "string") return false;
  const parts = packageName.split("/");
  return parts.length === 2 && MARSHAL_RUNTIME_PACKAGE_SCOPES.has(parts[0]) && parts[1].length > 0;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

function packageContentDigest(packageRoot) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  visit(packageRoot);
  files.sort((left, right) => left.localeCompare(right));

  const hash = crypto.createHash("sha256");
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

function prunePackageManagerBinDirectories(root) {
  if (!fs.existsSync(root)) return;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const target = path.join(directory, entry.name);
      if (entry.name === ".bin" && path.basename(directory) === "node_modules") {
        fs.rmSync(target, { recursive: true, force: true });
        continue;
      }
      visit(target);
    }
  };
  visit(root);
}

function stageAndVerifyMarshalRuntimePackages(projectDir, unpackedNodeModules) {
  const pinManifestPath = path.join(projectDir, ".marshal-runtime-packs", "manifest.json");
  if (!fs.existsSync(pinManifestPath)) {
    throw new Error(`afterPack: Marshal Runtime pin manifest is missing: ${pinManifestPath}.`);
  }
  const pinManifest = JSON.parse(fs.readFileSync(pinManifestPath, "utf8"));
  if (pinManifest.schemaVersion !== 3 || !Array.isArray(pinManifest.packages)) {
    throw new Error("afterPack: Marshal Runtime pin manifest is invalid.");
  }
  const extensionManifestPath = path.join(projectDir, ".marshal-runtime-packs", "extensions.json");
  if (!fs.existsSync(extensionManifestPath)) {
    throw new Error(
      `afterPack: Marshal Runtime extension pin manifest is missing: ${extensionManifestPath}.`,
    );
  }
  const extensionManifest = JSON.parse(fs.readFileSync(extensionManifestPath, "utf8"));
  if (
    extensionManifest.schemaVersion !== 1 ||
    !Array.isArray(extensionManifest.extensions) ||
    extensionManifest.extensions.length === 0
  ) {
    throw new Error("afterPack: Marshal Runtime extension pin manifest is invalid.");
  }
  const browserManifestPath = path.join(
    projectDir,
    ".marshal-runtime-packs",
    "agentic-browser-extension.json",
  );
  if (!fs.existsSync(browserManifestPath)) {
    throw new Error(
      `afterPack: agentic browser extension pin manifest is missing: ${browserManifestPath}.`,
    );
  }
  const browserManifest = JSON.parse(fs.readFileSync(browserManifestPath, "utf8"));
  if (
    browserManifest.schemaVersion !== 1 ||
    typeof browserManifest.extension !== "object" ||
    browserManifest.extension === null
  ) {
    throw new Error("afterPack: agentic browser extension pin manifest is invalid.");
  }
  const automationManifestPath = path.join(
    projectDir,
    ".marshal-runtime-packs",
    "agentic-browser-automation-extension.json",
  );
  if (!fs.existsSync(automationManifestPath)) {
    throw new Error(
      `afterPack: agentic browser automation extension pin manifest is missing: ${automationManifestPath}.`,
    );
  }
  const automationManifest = JSON.parse(fs.readFileSync(automationManifestPath, "utf8"));
  if (
    automationManifest.schemaVersion !== 1 ||
    typeof automationManifest.extension !== "object" ||
    automationManifest.extension === null
  ) {
    throw new Error("afterPack: agentic browser automation extension pin manifest is invalid.");
  }
  const overlayManifestPath = path.join(
    projectDir,
    ".marshal-runtime-packs",
    "overlay-review-extension.json",
  );
  if (!fs.existsSync(overlayManifestPath)) {
    throw new Error(
      `afterPack: overlay review extension pin manifest is missing: ${overlayManifestPath}.`,
    );
  }
  const overlayManifest = JSON.parse(fs.readFileSync(overlayManifestPath, "utf8"));
  if (
    overlayManifest.schemaVersion !== 1 ||
    typeof overlayManifest.extension !== "object" ||
    overlayManifest.extension === null
  ) {
    throw new Error("afterPack: overlay review extension pin manifest is invalid.");
  }
  const packagePins = [
    ...pinManifest.packages,
    ...extensionManifest.extensions,
    browserManifest.extension,
    automationManifest.extension,
    overlayManifest.extension,
  ];
  if (new Set(packagePins.map((packagePin) => packagePin.name)).size !== packagePins.length) {
    throw new Error("afterPack: Marshal Runtime package pins contain a duplicate identity.");
  }

  for (const packagePin of packagePins) {
    if (!isMarshalRuntimePackageName(packagePin.name)) {
      throw new Error("afterPack: Marshal Runtime pin manifest contains an invalid package name.");
    }
    const packagePath = packageNameToPath(packagePin.name);
    const source = path.join(projectDir, "node_modules", packagePath);
    const destination = path.join(unpackedNodeModules, packagePath);
    if (!fs.existsSync(source)) {
      throw new Error(`afterPack: pinned Marshal Runtime package is missing: ${source}.`);
    }

    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true, force: true, dereference: true });
    prunePackageManagerBinDirectories(destination);

    const packageManifest = JSON.parse(
      fs.readFileSync(path.join(destination, "package.json"), "utf8"),
    );
    if (
      packageManifest.name !== packagePin.name ||
      packageManifest.version !== packagePin.version
    ) {
      throw new Error(`afterPack: pinned ${packagePin.name} package identity changed.`);
    }
    const entrypoint = path.resolve(destination, packagePin.entrypoint);
    const relativeEntrypoint = path.relative(destination, entrypoint);
    if (
      !relativeEntrypoint ||
      relativeEntrypoint.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeEntrypoint) ||
      !fs.statSync(entrypoint).isFile()
    ) {
      throw new Error(`afterPack: pinned ${packagePin.name} entrypoint is invalid.`);
    }
    const entryDigest = crypto
      .createHash("sha256")
      .update(fs.readFileSync(entrypoint))
      .digest("hex");
    if (entryDigest !== packagePin.entrySha256) {
      throw new Error(`afterPack: pinned ${packagePin.name} entrypoint integrity mismatch.`);
    }
    if (packageContentDigest(destination) !== packagePin.contentSha256) {
      throw new Error(`afterPack: pinned ${packagePin.name} package integrity mismatch.`);
    }
    console.log(`  afterPack: restored and verified pinned ${packagePin.name}`);
  }
}

function resolveBuildTarget(electronPlatformName, electronBuilderArch) {
  const platform = PLATFORM_MAP[electronPlatformName];
  const arch = ARCH_MAP[electronBuilderArch];
  if (!platform || !SUPPORTED_RUNTIME_ARCHES.has(arch)) {
    throw new Error(
      `afterPack: unsupported Electron packaging target ${electronPlatformName}-${String(
        electronBuilderArch,
      )}. Supported targets are win32, darwin, and linux on x64 or arm64.`,
    );
  }
  return { platform, arch };
}

function getLocalRuntimePackageSpecs(platform, arch) {
  if (!PLATFORM_MAP[platform] || !SUPPORTED_RUNTIME_ARCHES.has(arch)) {
    throw new Error(`afterPack: unsupported local runtime target ${platform}-${arch}.`);
  }

  const codexTargetTriple = CODEX_TARGET_TRIPLES[`${platform}-${arch}`];
  if (!codexTargetTriple) {
    throw new Error(`afterPack: missing Codex target triple for ${platform}-${arch}.`);
  }

  const executableSuffix = platform === "win32" ? ".exe" : "";
  const claudeNativePackageName = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  const codexNativePackageName = `@openai/codex-${platform}-${arch}`;

  return [
    {
      id: "claude",
      label: "Claude",
      scope: "@anthropic-ai",
      rootPackageName: "@anthropic-ai/claude-agent-sdk",
      rootManifestName: "@anthropic-ai/claude-agent-sdk",
      expectedRootVersion: CLAUDE_AGENT_SDK_VERSION,
      rootRequiredFiles: ["sdk.mjs"],
      nativePackageName: claudeNativePackageName,
      nativePackageEntry: `claude-agent-sdk-${platform}-${arch}`,
      nativeManifestName: claudeNativePackageName,
      nativePackageEntries: CLAUDE_NATIVE_PACKAGE_ENTRIES,
      executableRelativePath: `claude${executableSuffix}`,
      nativeRequiredFiles: [],
    },
    {
      id: "codex",
      label: "Codex",
      scope: "@openai",
      rootPackageName: "@openai/codex",
      rootManifestName: "@openai/codex",
      rootRequiredFiles: [path.join("bin", "codex.js")],
      nativePackageName: codexNativePackageName,
      nativePackageEntry: `codex-${platform}-${arch}`,
      nativeManifestName: "@openai/codex",
      nativePackageEntries: CODEX_NATIVE_PACKAGE_ENTRIES,
      executableRelativePath: path.join(
        "vendor",
        codexTargetTriple,
        "bin",
        `codex${executableSuffix}`,
      ),
      nativeRequiredFiles: [path.join("vendor", codexTargetTriple, "codex-package.json")],
      targetTriple: codexTargetTriple,
    },
  ];
}

function readPackageManifest(packageDir, label) {
  const packageJsonPath = path.join(packageDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(
      `afterPack: required ${label} package manifest is missing: ${packageJsonPath}.`,
    );
  }
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  } catch (error) {
    throw new Error(`afterPack: failed to parse ${label} package manifest: ${packageJsonPath}.`, {
      cause: error,
    });
  }
}

function verifyRequiredFile(packageDir, relativePath, label) {
  const filePath = path.join(packageDir, relativePath);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`afterPack: required ${label} file is missing: ${filePath}.`);
  }
  return filePath;
}

function verifyLocalRuntimePackage(unpackedNodeModules, spec) {
  const rootPackageDir = path.join(unpackedNodeModules, packageNameToPath(spec.rootPackageName));
  const nativePackageDir = path.join(
    unpackedNodeModules,
    packageNameToPath(spec.nativePackageName),
  );
  const rootManifest = readPackageManifest(rootPackageDir, `${spec.label} root`);
  const nativeManifest = readPackageManifest(nativePackageDir, `${spec.label} native`);

  if (rootManifest.name !== spec.rootManifestName) {
    throw new Error(
      `afterPack: ${spec.label} root package name mismatch: expected ${spec.rootManifestName}, ` +
        `found ${String(rootManifest.name)}.`,
    );
  }
  if (spec.expectedRootVersion && rootManifest.version !== spec.expectedRootVersion) {
    throw new Error(
      `afterPack: ${spec.label} root package version mismatch: expected ` +
        `${spec.expectedRootVersion}, found ${String(rootManifest.version)}.`,
    );
  }
  if (nativeManifest.name !== spec.nativeManifestName) {
    throw new Error(
      `afterPack: ${spec.label} native package name mismatch: expected ` +
        `${spec.nativeManifestName}, found ${String(nativeManifest.name)}.`,
    );
  }
  if (typeof nativeManifest.version !== "string" || !nativeManifest.version) {
    throw new Error(`afterPack: ${spec.label} native package does not declare a version.`);
  }

  const optionalDependency = rootManifest.optionalDependencies?.[spec.nativePackageName];
  const acceptedOptionalDependencies = new Set([
    nativeManifest.version,
    `npm:${nativeManifest.name}@${nativeManifest.version}`,
  ]);
  if (!acceptedOptionalDependencies.has(optionalDependency)) {
    throw new Error(
      `afterPack: ${spec.label} optional dependency ${spec.nativePackageName} does not match ` +
        `the staged native package version ${nativeManifest.version}. Found ${String(
          optionalDependency,
        )}.`,
    );
  }

  for (const requiredFile of spec.rootRequiredFiles) {
    verifyRequiredFile(rootPackageDir, requiredFile, `${spec.label} root package`);
  }
  for (const requiredFile of spec.nativeRequiredFiles) {
    verifyRequiredFile(nativePackageDir, requiredFile, `${spec.label} native package`);
  }
  const executablePath = verifyRequiredFile(
    nativePackageDir,
    spec.executableRelativePath,
    `${spec.label} executable`,
  );
  console.log(`  afterPack: verified ${spec.nativePackageName}/${spec.executableRelativePath}`);
  return executablePath;
}

function stageAndVerifyLocalRuntimePackages(projectDir, unpackedNodeModules, specs) {
  for (const spec of specs) {
    copyPackageIfMissing(projectDir, unpackedNodeModules, packageNameToPath(spec.rootPackageName));
    copyPackageIfMissing(
      projectDir,
      unpackedNodeModules,
      packageNameToPath(spec.nativePackageName),
    );
    verifyLocalRuntimePackage(unpackedNodeModules, spec);
  }
}

function pruneLocalRuntimeNativePackages(unpackedNodeModules, specs) {
  for (const spec of specs) {
    const knownNativePackages = new Set(spec.nativePackageEntries);
    removeEntries(
      path.join(unpackedNodeModules, spec.scope),
      (entry) => !knownNativePackages.has(entry) || entry === spec.nativePackageEntry,
      spec.scope,
    );
  }
}

function verifyCopilotPlatformPackage(unpackedNodeModules, packageName) {
  const packageDir = path.join(unpackedNodeModules, "@github", packageName);
  const packageJsonPath = path.join(packageDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`afterPack: required Copilot CLI package is missing: ${packageJsonPath}.`);
  }
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const binary = Object.values(packageJson.bin || {})[0];
  if (typeof binary !== "string" || !binary.trim()) {
    throw new Error(`afterPack: ${packageName} does not declare a CLI binary.`);
  }
  const binaryPath = path.join(packageDir, binary);
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`afterPack: required Copilot CLI binary is missing: ${binaryPath}.`);
  }
  console.log(`  afterPack: verified ${packageName}/${binary}`);
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function stageBaileysStage0Artifact(projectDir, resourcesDir, env = process.env) {
  const destinationDir = path.join(resourcesDir, BAILEYS_STAGE0_RESOURCE_DIR);
  if (env[BAILEYS_STAGE0_PACKAGE_ENV] !== "1") {
    fs.rmSync(destinationDir, { recursive: true, force: true });
    return { staged: false, destinationDir };
  }

  const sourceDir = path.join(projectDir, BAILEYS_STAGE0_OUTPUT_DIR);
  const sourceBundle = path.join(sourceDir, BAILEYS_STAGE0_BUNDLE);
  const sourceManifest = path.join(sourceDir, BAILEYS_STAGE0_MANIFEST);
  if (!fs.existsSync(sourceBundle) || !fs.statSync(sourceBundle).isFile()) {
    throw new Error(
      `afterPack: Baileys Stage 0 bundle is missing: ${sourceBundle}. ` +
        `Run pnpm build:baileys-stage0 before opt-in packaging.`,
    );
  }
  if (!fs.existsSync(sourceManifest) || !fs.statSync(sourceManifest).isFile()) {
    throw new Error(`afterPack: Baileys Stage 0 manifest is missing: ${sourceManifest}.`);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(sourceManifest, "utf8"));
  } catch (error) {
    throw new Error(`afterPack: failed to parse Baileys Stage 0 manifest: ${sourceManifest}.`, {
      cause: error,
    });
  }
  if (
    manifest?.schemaVersion !== 1 ||
    manifest?.bundle?.fileName !== BAILEYS_STAGE0_BUNDLE ||
    manifest?.bundle?.format !== "esm" ||
    typeof manifest?.bundle?.sha256 !== "string" ||
    manifest?.bridge?.packageVersion !== "0.5.4" ||
    manifest?.bridge?.assetMode !== "embedded-base64-wasm" ||
    !Array.isArray(manifest?.bridge?.externalAssets) ||
    manifest.bridge.externalAssets.length !== 0
  ) {
    throw new Error("afterPack: Baileys Stage 0 manifest does not match the approved schema.");
  }
  const bundleHash = sha256File(sourceBundle);
  if (bundleHash !== manifest.bundle.sha256) {
    throw new Error(
      `afterPack: Baileys Stage 0 bundle hash mismatch: expected ${manifest.bundle.sha256}, ` +
        `found ${bundleHash}.`,
    );
  }

  fs.rmSync(destinationDir, { recursive: true, force: true });
  fs.mkdirSync(destinationDir, { recursive: true });
  fs.copyFileSync(sourceBundle, path.join(destinationDir, BAILEYS_STAGE0_BUNDLE));
  fs.copyFileSync(sourceManifest, path.join(destinationDir, BAILEYS_STAGE0_MANIFEST));
  console.log(
    `  afterPack: staged opt-in Baileys Stage 0 sidecar (${manifest.bundle.sha256.slice(0, 12)})`,
  );
  return { staged: true, destinationDir, sha256: bundleHash };
}

function stageWhatsAppSidecarArtifact(projectDir, resourcesDir, env = process.env) {
  const destinationDir = path.join(resourcesDir, WHATSAPP_SIDECAR_RESOURCE_DIR);
  if (env[WHATSAPP_SIDECAR_PACKAGE_ENV] !== "1") {
    fs.rmSync(destinationDir, { recursive: true, force: true });
    return { staged: false, destinationDir };
  }

  const sourceDir = path.join(projectDir, WHATSAPP_SIDECAR_OUTPUT_DIR);
  const sourceBundle = path.join(sourceDir, WHATSAPP_SIDECAR_BUNDLE);
  const sourceManifest = path.join(sourceDir, WHATSAPP_SIDECAR_MANIFEST);
  if (!fs.existsSync(sourceBundle) || !fs.statSync(sourceBundle).isFile()) {
    throw new Error(
      `afterPack: WhatsApp sidecar bundle is missing: ${sourceBundle}. ` +
        `Run pnpm build:whatsapp-sidecar before opt-in packaging.`,
    );
  }
  if (!fs.existsSync(sourceManifest) || !fs.statSync(sourceManifest).isFile()) {
    throw new Error(`afterPack: WhatsApp sidecar manifest is missing: ${sourceManifest}.`);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(sourceManifest, "utf8"));
  } catch (error) {
    throw new Error(`afterPack: failed to parse WhatsApp sidecar manifest: ${sourceManifest}.`, {
      cause: error,
    });
  }
  if (
    manifest?.schemaVersion !== 1 ||
    manifest?.bundle?.fileName !== WHATSAPP_SIDECAR_BUNDLE ||
    manifest?.bundle?.format !== "esm" ||
    typeof manifest?.bundle?.sha256 !== "string" ||
    manifest?.protocol?.schemaVersion !== 1 ||
    manifest?.protocol?.autoConnect !== false ||
    manifest?.protocol?.authPersistence !== "parent-rpc" ||
    manifest?.bridge?.packageVersion !== "0.5.4" ||
    manifest?.bridge?.assetMode !== "embedded-base64-wasm" ||
    !Array.isArray(manifest?.bridge?.externalAssets) ||
    manifest.bridge.externalAssets.length !== 0
  ) {
    throw new Error("afterPack: WhatsApp sidecar manifest does not match the approved schema.");
  }
  const bundleHash = sha256File(sourceBundle);
  if (bundleHash !== manifest.bundle.sha256) {
    throw new Error(
      `afterPack: WhatsApp sidecar bundle hash mismatch: expected ${manifest.bundle.sha256}, ` +
        `found ${bundleHash}.`,
    );
  }

  fs.rmSync(destinationDir, { recursive: true, force: true });
  fs.mkdirSync(destinationDir, { recursive: true });
  fs.copyFileSync(sourceBundle, path.join(destinationDir, WHATSAPP_SIDECAR_BUNDLE));
  fs.copyFileSync(sourceManifest, path.join(destinationDir, WHATSAPP_SIDECAR_MANIFEST));
  console.log(
    `  afterPack: staged opt-in WhatsApp sidecar (${manifest.bundle.sha256.slice(0, 12)})`,
  );
  return { staged: true, destinationDir, sha256: bundleHash };
}

module.exports = async function afterPack(context) {
  const { platform, arch } = resolveBuildTarget(context.electronPlatformName, context.arch);
  // On macOS the app bundle nests resources under <AppName>.app/Contents/Resources/
  // On Windows/Linux the resources folder sits directly in appOutDir.
  const resourcesDir =
    context.electronPlatformName === "darwin"
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          "Contents",
          "Resources",
        )
      : path.join(context.appOutDir, "resources");
  const unpacked = path.join(resourcesDir, "app.asar.unpacked", "node_modules");
  const projectDir = context.packager.projectDir || path.join(__dirname, "..");

  stageAndVerifyMarshalRuntimePackages(projectDir, unpacked);
  stageBaileysStage0Artifact(projectDir, resourcesDir);
  stageWhatsAppSidecarArtifact(projectDir, resourcesDir);

  const localRuntimePackages = getLocalRuntimePackageSpecs(platform, arch);
  stageAndVerifyLocalRuntimePackages(projectDir, unpacked, localRuntimePackages);
  pruneLocalRuntimeNativePackages(unpacked, localRuntimePackages);

  // electron-builder's dependency walker can omit the SDK's platform package
  // even when pnpm materialized it as an optional dependency. Stage the exact
  // target package explicitly and fail packaging if its declared binary is absent.
  const keepCopilot = `copilot-${platform}-${arch}`;
  copyPackageIfMissing(projectDir, unpacked, path.join("@github", keepCopilot));
  verifyCopilotPlatformPackage(unpacked, keepCopilot);

  // Remove cross-platform @github/copilot-<platform>-<arch> packages (~640 MB saved)
  removeEntries(
    path.join(unpacked, "@github"),
    (entry) => !entry.startsWith("copilot-") || entry === "copilot-sdk" || entry === keepCopilot,
    "@github",
  );

  // Remove cross-platform @github/copilot/prebuilds — pty.node, keytar.node, conpty
  // binaries for non-target platform+arch (~2.5 MB saved). The SDK loads from
  // prebuilds/${process.platform}-${process.arch}/ at runtime.
  const keepPrebuilds = `${platform}-${arch}`;
  const prebuildsDir = path.join(unpacked, "@github", "copilot", "prebuilds");
  if (fs.existsSync(prebuildsDir)) {
    if (!fs.existsSync(path.join(prebuildsDir, keepPrebuilds))) {
      throw new Error(
        `afterPack: expected copilot/prebuilds/${keepPrebuilds} not found. ` +
          `The @github/copilot SDK may have changed its directory layout. ` +
          `Verify the prebuilds structure and update afterPack accordingly.`,
      );
    }
    removeEntries(prebuildsDir, (entry) => entry === keepPrebuilds, "copilot/prebuilds");
  }

  // Remove cross-platform @github/copilot/ripgrep binaries (~5 MB saved).
  // The SDK loads from ripgrep/bin/${process.platform}-${process.arch}/ at runtime.
  const keepRipgrep = `${platform}-${arch}`;
  const ripgrepBinDir = path.join(unpacked, "@github", "copilot", "ripgrep", "bin");
  if (fs.existsSync(ripgrepBinDir)) {
    if (!fs.existsSync(path.join(ripgrepBinDir, keepRipgrep))) {
      throw new Error(
        `afterPack: expected copilot/ripgrep/bin/${keepRipgrep} not found. ` +
          `The @github/copilot SDK may have changed its directory layout. ` +
          `Verify the ripgrep structure and update afterPack accordingly.`,
      );
    }
    removeEntries(ripgrepBinDir, (entry) => entry === keepRipgrep, "copilot/ripgrep/bin");
  }

  // Remove cross-platform esbuild binaries. The workflow compiler runs in the
  // packaged main process and esbuild's JS API spawns @esbuild/<platform>-<arch>.
  const keepEsbuild = `${platform}-${arch}`;
  copyPackageIfMissing(projectDir, unpacked, "esbuild");
  copyPackageIfMissing(projectDir, unpacked, path.join("@esbuild", keepEsbuild));
  const esbuildPackagesDir = path.join(unpacked, "@esbuild");
  if (fs.existsSync(esbuildPackagesDir)) {
    if (!fs.existsSync(path.join(esbuildPackagesDir, keepEsbuild))) {
      throw new Error(
        `afterPack: expected @esbuild/${keepEsbuild} not found. ` +
          `Repo-local workflow compilation requires esbuild in packaged builds.`,
      );
    }
    removeEntries(esbuildPackagesDir, (entry) => entry === keepEsbuild, "@esbuild");
  }

  // Sanity-check that the bundled Node binary landed in resources/node/.
  // extraResources copies node-bin/<platform>-<arch>/node[.exe] there at pack
  // time. If electron-builder.json5 was misconfigured (e.g. typo in the
  // extraResources entry) we want to know NOW, not when the first MCP server
  // fails to launch in prod.
  const bundledNodeDir = path.join(resourcesDir, "node");
  const expectedBundledNode =
    context.electronPlatformName === "win32"
      ? path.join(bundledNodeDir, "node.exe")
      : path.join(bundledNodeDir, "node");
  if (!fs.existsSync(expectedBundledNode)) {
    throw new Error(
      `afterPack: bundled Node not found at ${expectedBundledNode}. ` +
        `Confirm electron-builder.json5 extraResources copies ` +
        `node-bin/${PLATFORM_MAP[context.electronPlatformName]}-${ARCH_MAP[context.arch]}/ ` +
        `to resources/node/, and that the local node-bin/ directory was populated ` +
        `(pnpm:devPreinstall runs scripts/marshal-fetch-bundled-node.cjs).`,
    );
  }

  // Sanity-check Windows node-runner.exe location matches writeCliShim's path
  // math. The runner ships via win.extraFiles → app root (next to
  // Marshal.exe), and writeCliShim / buildMcpCommand resolve it as
  // dirname(resourcesPath)/node-runner.exe. If a future change moves it to
  // win.extraResources (so it lands under resources/), the spawn path silently
  // breaks — the prior incident shipped a signed installer where\n  // every MCP server failed with "node-runner.exe not found". Fail loud here
  // instead of in production.
  if (context.electronPlatformName === "win32") {
    const runnerAtAppRoot = path.join(context.appOutDir, "node-runner.exe");
    const runnerInResources = path.join(resourcesDir, "node-runner.exe");
    if (!fs.existsSync(runnerAtAppRoot)) {
      throw new Error(
        `afterPack: node-runner.exe not found at ${runnerAtAppRoot}. ` +
          `electron-builder.json5 win.extraFiles must copy sidecar/node-runner.exe ` +
          `to the app root (NOT extraResources). writeCliShim and buildMcpCommand ` +
          `compute the runner path relative to the app directory.`,
      );
    }
    if (fs.existsSync(runnerInResources)) {
      throw new Error(
        `afterPack: node-runner.exe must not exist at ${runnerInResources}. ` +
          `Both locations would conflict with writeCliShim's path resolution. ` +
          `Use win.extraFiles (app root) exclusively.`,
      );
    }
  }

  // Pin the bundled Node signer before electron-builder signs the bundle.
  if (context.electronPlatformName === "darwin") {
    const contentsDir = path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      "Contents",
    );
    verifyBundledNodeSigner(contentsDir);
  }
};

function verifyBundledNodeSigner(contentsDir) {
  const bundledNodeBin = path.join(contentsDir, "Resources", "node", "node");
  if (!fs.existsSync(bundledNodeBin)) return;

  // --verbose=4 is required: -dv (--verbose=1) omits Authority lines on
  // macOS 15+ / Xcode 16+. Verify before any provider-specific signing changes
  // overwrite the upstream signature.
  const dv = spawnSync("codesign", ["--display", "--verbose=4", bundledNodeBin], {
    encoding: "utf8",
  });
  const dvOut = (dv.stdout || "") + (dv.stderr || "");
  const EXPECTED_TEAM = "HX7739G8FX";
  const EXPECTED_AUTHORITY = /OpenJS Foundation|Node\.js Foundation/i;
  if (!dvOut.includes(`TeamIdentifier=${EXPECTED_TEAM}`) || !EXPECTED_AUTHORITY.test(dvOut)) {
    throw new Error(
      `afterPack: bundled node signer mismatch. Expected TeamIdentifier=${EXPECTED_TEAM} ` +
        `+ Authority matching ${EXPECTED_AUTHORITY}. codesign --display --verbose=4:\n${dvOut}`,
    );
  }

  console.log(`  afterPack: pinned bundled node signer (TeamIdentifier=${EXPECTED_TEAM})`);
}

module.exports._test = {
  getLocalRuntimePackageSpecs,
  packageContentDigest,
  packageNameToPath,
  prunePackageManagerBinDirectories,
  pruneLocalRuntimeNativePackages,
  resolveBuildTarget,
  stageBaileysStage0Artifact,
  stageWhatsAppSidecarArtifact,
  stageAndVerifyLocalRuntimePackages,
  stageAndVerifyMarshalRuntimePackages,
  verifyLocalRuntimePackage,
};
