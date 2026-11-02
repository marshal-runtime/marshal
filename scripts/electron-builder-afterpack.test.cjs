const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const afterPack = require("./marshal-electron-builder-afterpack.cjs");

const {
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
} = afterPack._test;

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-afterpack-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "fixture");
}

function createBaileysStage0Fixture(projectDir, bundleContents = "stage0-bundle") {
  const sourceDir = path.join(projectDir, "dist-baileys-stage0");
  const bundlePath = path.join(sourceDir, "baileys-stage0-sidecar.mjs");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(bundlePath, bundleContents);
  const sha256 = crypto.createHash("sha256").update(bundleContents).digest("hex");
  writeJson(path.join(sourceDir, "baileys-stage0-manifest.json"), {
    schemaVersion: 1,
    bundle: {
      fileName: "baileys-stage0-sidecar.mjs",
      format: "esm",
      target: "node24",
      byteLength: Buffer.byteLength(bundleContents),
      sha256,
    },
    bridge: {
      packageName: "whatsapp-rust-bridge",
      packageVersion: "0.5.4",
      assetMode: "embedded-base64-wasm",
      externalAssets: [],
    },
  });
  return { bundlePath, sha256 };
}

function createWhatsAppSidecarFixture(projectDir, bundleContents = "whatsapp-bundle") {
  const sourceDir = path.join(projectDir, "dist-whatsapp-sidecar");
  const bundlePath = path.join(sourceDir, "whatsapp-sidecar.mjs");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(bundlePath, bundleContents);
  const sha256 = crypto.createHash("sha256").update(bundleContents).digest("hex");
  writeJson(path.join(sourceDir, "whatsapp-sidecar-manifest.json"), {
    schemaVersion: 1,
    bundle: {
      fileName: "whatsapp-sidecar.mjs",
      format: "esm",
      target: "node24",
      byteLength: Buffer.byteLength(bundleContents),
      sha256,
    },
    protocol: {
      schemaVersion: 1,
      autoConnect: false,
      authPersistence: "parent-rpc",
    },
    bridge: {
      packageName: "whatsapp-rust-bridge",
      packageVersion: "0.5.4",
      assetMode: "embedded-base64-wasm",
      externalAssets: [],
    },
  });
  return { bundlePath, sha256 };
}

function createRuntimeFixture(nodeModulesDir, spec) {
  const rootPackageDir = path.join(nodeModulesDir, packageNameToPath(spec.rootPackageName));
  const nativePackageDir = path.join(nodeModulesDir, packageNameToPath(spec.nativePackageName));
  const rootVersion = spec.expectedRootVersion ?? "1.2.3";
  const nativeVersion =
    spec.id === "codex"
      ? `${rootVersion}-${spec.nativePackageEntry.slice("codex-".length)}`
      : rootVersion;

  writeJson(path.join(rootPackageDir, "package.json"), {
    name: spec.rootManifestName,
    version: rootVersion,
    optionalDependencies: {
      [spec.nativePackageName]:
        spec.id === "codex" ? `npm:${spec.nativeManifestName}@${nativeVersion}` : nativeVersion,
    },
  });
  for (const relativePath of spec.rootRequiredFiles) {
    writeFile(path.join(rootPackageDir, relativePath));
  }

  writeJson(path.join(nativePackageDir, "package.json"), {
    name: spec.nativeManifestName,
    version: nativeVersion,
  });
  for (const relativePath of spec.nativeRequiredFiles) {
    writeFile(path.join(nativePackageDir, relativePath));
  }
  writeFile(path.join(nativePackageDir, spec.executableRelativePath));
}

test("selects the official Claude and Codex packages for every supported target", () => {
  const cases = [
    ["win32", 1, "x64", "x86_64-pc-windows-msvc", ".exe"],
    ["win32", 3, "arm64", "aarch64-pc-windows-msvc", ".exe"],
    ["darwin", 1, "x64", "x86_64-apple-darwin", ""],
    ["darwin", 3, "arm64", "aarch64-apple-darwin", ""],
    ["linux", 1, "x64", "x86_64-unknown-linux-musl", ""],
    ["linux", 3, "arm64", "aarch64-unknown-linux-musl", ""],
  ];

  for (const [platformName, electronBuilderArch, arch, codexTargetTriple, suffix] of cases) {
    const target = resolveBuildTarget(platformName, electronBuilderArch);
    assert.deepEqual(target, { platform: platformName, arch });

    const specs = getLocalRuntimePackageSpecs(target.platform, target.arch);
    const claude = specs.find((spec) => spec.id === "claude");
    const codex = specs.find((spec) => spec.id === "codex");

    assert.equal(
      claude.nativePackageName,
      `@anthropic-ai/claude-agent-sdk-${platformName}-${arch}`,
    );
    assert.equal(claude.executableRelativePath, `claude${suffix}`);
    assert.equal(claude.nativePackageName.includes("-musl"), false);

    assert.equal(codex.nativePackageName, `@openai/codex-${platformName}-${arch}`);
    assert.equal(codex.targetTriple, codexTargetTriple);
    assert.equal(
      codex.executableRelativePath,
      path.join("vendor", codexTargetTriple, "bin", `codex${suffix}`),
    );
  }
});

test("stages target runtime packages and prunes only known non-target native packages", (t) => {
  const tempDir = createTempDir(t);
  const projectNodeModules = path.join(tempDir, "project", "node_modules");
  const unpackedNodeModules = path.join(tempDir, "packaged", "node_modules");
  const specs = getLocalRuntimePackageSpecs("win32", "x64");

  for (const spec of specs) {
    createRuntimeFixture(projectNodeModules, spec);
  }

  const preservedPackages = [
    path.join(unpackedNodeModules, "@anthropic-ai", "sdk", "package.json"),
    path.join(unpackedNodeModules, "@openai", "codex-sdk", "package.json"),
  ];
  for (const manifest of preservedPackages) {
    writeJson(manifest, { name: path.basename(path.dirname(manifest)), version: "1.0.0" });
  }
  writeJson(
    path.join(
      unpackedNodeModules,
      "@anthropic-ai",
      "claude-agent-sdk-linux-x64-musl",
      "package.json",
    ),
    { name: "@anthropic-ai/claude-agent-sdk-linux-x64-musl", version: "0.3.276" },
  );
  writeJson(path.join(unpackedNodeModules, "@openai", "codex-linux-x64", "package.json"), {
    name: "@openai/codex",
    version: "1.2.3-linux-x64",
  });

  stageAndVerifyLocalRuntimePackages(path.join(tempDir, "project"), unpackedNodeModules, specs);
  pruneLocalRuntimeNativePackages(unpackedNodeModules, specs);

  for (const spec of specs) {
    assert.equal(
      fs.existsSync(
        path.join(unpackedNodeModules, packageNameToPath(spec.rootPackageName), "package.json"),
      ),
      true,
    );
    assert.equal(
      fs.existsSync(
        path.join(unpackedNodeModules, packageNameToPath(spec.nativePackageName), "package.json"),
      ),
      true,
    );
  }
  assert.equal(
    fs.existsSync(
      path.join(unpackedNodeModules, "@anthropic-ai", "claude-agent-sdk-linux-x64-musl"),
    ),
    false,
  );
  assert.equal(fs.existsSync(path.join(unpackedNodeModules, "@openai", "codex-linux-x64")), false);
  for (const manifest of preservedPackages) {
    assert.equal(fs.existsSync(manifest), true);
  }
});

test("restores pinned Marshal Runtime packages and extensions after filtering", (t) => {
  const tempDir = createTempDir(t);
  const projectDir = path.join(tempDir, "project");
  const sourcePackage = path.join(projectDir, "node_modules", "@marshal", "runtime");
  const unpackedNodeModules = path.join(tempDir, "packaged", "node_modules");
  const packagedPackage = path.join(unpackedNodeModules, "@marshal", "runtime");
  const entrypoint = path.join(sourcePackage, "dist", "host.js");
  const debuggerPackage = path.join(
    projectDir,
    "node_modules",
    "@marshal",
    "agentic-debugger-extension",
  );
  const packagedDebugger = path.join(unpackedNodeModules, "@marshal", "agentic-debugger-extension");
  const debuggerEntrypoint = path.join(debuggerPackage, "dist", "runtime-extension.cjs");
  const browserPackage = path.join(
    projectDir,
    "node_modules",
    "@agentic-browser",
    "marshal-runtime-extension",
  );
  const packagedBrowser = path.join(
    unpackedNodeModules,
    "@agentic-browser",
    "marshal-runtime-extension",
  );
  const browserEntrypoint = path.join(browserPackage, "dist", "runtime.cjs");
  const automationPackage = path.join(
    projectDir,
    "node_modules",
    "@agentic-browser",
    "automation-extension",
  );
  const packagedAutomation = path.join(
    unpackedNodeModules,
    "@agentic-browser",
    "automation-extension",
  );
  const automationEntrypoint = path.join(automationPackage, "dist", "runtime.cjs");
  const overlayPackage = path.join(projectDir, "node_modules", "@marshal", "overlay-review");
  const packagedOverlay = path.join(unpackedNodeModules, "@marshal", "overlay-review");
  const overlayEntrypoint = path.join(overlayPackage, "dist", "extension", "runtime.cjs");

  writeJson(path.join(overlayPackage, "package.json"), {
    name: "@marshal/overlay-review",
    version: "0.1.0",
    type: "commonjs",
    main: "dist/extension/runtime.cjs",
  });
  fs.writeFileSync(path.join(overlayPackage, "README.md"), "pinned package documentation\n");
  fs.mkdirSync(path.dirname(overlayEntrypoint), { recursive: true });
  fs.writeFileSync(overlayEntrypoint, "module.exports = { activate() { return {}; } };\n");
  writeJson(path.join(packagedOverlay, "package.json"), {
    name: "@marshal/overlay-review",
    version: "0.0.0-filtered",
  });

  writeJson(path.join(sourcePackage, "package.json"), {
    name: "@marshal/runtime",
    version: "0.1.0",
    main: "dist/host.js",
    types: "dist/host.d.ts",
  });
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.writeFileSync(entrypoint, "export const createAgentRuntime = () => undefined;\n");
  fs.writeFileSync(path.join(sourcePackage, "README.md"), "pinned package documentation\n");
  fs.writeFileSync(path.join(sourcePackage, "dist", "host.d.ts"), "export {};\n");
  writeJson(path.join(debuggerPackage, "package.json"), {
    name: "@marshal/agentic-debugger-extension",
    version: "1.0.0",
    type: "commonjs",
    main: "dist/runtime-extension.cjs",
  });
  writeJson(path.join(debuggerPackage, "runtime-extension.json"), {
    schemaVersion: 1,
    identity: "@marshal/agentic-debugger-extension",
    version: "1.0.0",
    entrypoint: "dist/runtime-extension.cjs",
    moduleFormat: "commonjs-bundle-v1",
  });
  fs.mkdirSync(path.dirname(debuggerEntrypoint), { recursive: true });
  fs.writeFileSync(debuggerEntrypoint, "module.exports = { activate() { return {}; } };\n");
  writeJson(path.join(browserPackage, "package.json"), {
    name: "@agentic-browser/marshal-runtime-extension",
    version: "0.1.0",
    type: "commonjs",
    main: "dist/runtime.cjs",
  });
  writeJson(path.join(browserPackage, "runtime-extension.json"), {
    schemaVersion: 1,
    identity: "@agentic-browser/marshal-runtime-extension",
    version: "0.1.0",
    entrypoint: "dist/runtime.cjs",
    moduleFormat: "commonjs-bundle-v1",
  });
  fs.mkdirSync(path.dirname(browserEntrypoint), { recursive: true });
  fs.writeFileSync(browserEntrypoint, "module.exports = { activate() { return {}; } };\n");
  writeJson(path.join(automationPackage, "package.json"), {
    name: "@agentic-browser/automation-extension",
    version: "0.1.0",
    type: "commonjs",
    main: "dist/runtime.cjs",
  });
  writeJson(path.join(automationPackage, "runtime-extension.json"), {
    schemaVersion: 1,
    identity: "@agentic-browser/automation-extension",
    version: "0.1.0",
    entrypoint: "dist/runtime.cjs",
    moduleFormat: "commonjs-bundle-v1",
  });
  fs.mkdirSync(path.dirname(automationEntrypoint), { recursive: true });
  fs.writeFileSync(automationEntrypoint, "module.exports = { activate() { return {}; } };\n");

  writeJson(path.join(packagedPackage, "package.json"), {
    name: "@marshal/runtime",
    version: "0.1.0",
    main: "dist/host.js",
  });
  writeFile(path.join(packagedPackage, "dist", "host.js"));
  writeJson(path.join(packagedDebugger, "package.json"), {
    name: "@marshal/agentic-debugger-extension",
    version: "0.0.0-filtered",
  });
  writeFile(path.join(sourcePackage, "node_modules", ".bin", "tsc"));

  writeJson(path.join(projectDir, ".marshal-runtime-packs", "manifest.json"), {
    schemaVersion: 3,
    packages: [
      {
        name: "@marshal/runtime",
        version: "0.1.0",
        entrypoint: "dist/host.js",
        entrySha256: crypto.createHash("sha256").update(fs.readFileSync(entrypoint)).digest("hex"),
        contentSha256: packageContentDigest(sourcePackage),
      },
    ],
  });
  writeJson(path.join(projectDir, ".marshal-runtime-packs", "extensions.json"), {
    schemaVersion: 1,
    extensions: [
      {
        name: "@marshal/agentic-debugger-extension",
        version: "1.0.0",
        entrypoint: "dist/runtime-extension.cjs",
        entrySha256: crypto
          .createHash("sha256")
          .update(fs.readFileSync(debuggerEntrypoint))
          .digest("hex"),
        contentSha256: packageContentDigest(debuggerPackage),
      },
    ],
  });
  writeJson(path.join(projectDir, ".marshal-runtime-packs", "agentic-browser-extension.json"), {
    schemaVersion: 1,
    extension: {
      name: "@agentic-browser/marshal-runtime-extension",
      version: "0.1.0",
      entrypoint: "dist/runtime.cjs",
      entrySha256: crypto
        .createHash("sha256")
        .update(fs.readFileSync(browserEntrypoint))
        .digest("hex"),
      contentSha256: packageContentDigest(browserPackage),
    },
  });
  writeJson(
    path.join(projectDir, ".marshal-runtime-packs", "agentic-browser-automation-extension.json"),
    {
      schemaVersion: 1,
      extension: {
        name: "@agentic-browser/automation-extension",
        version: "0.1.0",
        entrypoint: "dist/runtime.cjs",
        entrySha256: crypto
          .createHash("sha256")
          .update(fs.readFileSync(automationEntrypoint))
          .digest("hex"),
        contentSha256: packageContentDigest(automationPackage),
      },
    },
  );
  writeJson(path.join(projectDir, ".marshal-runtime-packs", "overlay-review-extension.json"), {
    schemaVersion: 1,
    extension: {
      name: "@marshal/overlay-review",
      version: "0.1.0",
      entrypoint: "dist/extension/runtime.cjs",
      entrySha256: crypto
        .createHash("sha256")
        .update(fs.readFileSync(overlayEntrypoint))
        .digest("hex"),
      contentSha256: packageContentDigest(overlayPackage),
    },
  });
  stageAndVerifyMarshalRuntimePackages(projectDir, unpackedNodeModules);

  assert.equal(
    fs.readFileSync(path.join(packagedPackage, "README.md"), "utf8"),
    "pinned package documentation\n",
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(packagedPackage, "package.json"), "utf8")),
    {
      name: "@marshal/runtime",
      version: "0.1.0",
      main: "dist/host.js",
      types: "dist/host.d.ts",
    },
  );
  assert.equal(packageContentDigest(packagedPackage), packageContentDigest(sourcePackage));
  assert.equal(fs.existsSync(path.join(packagedPackage, "node_modules", ".bin")), false);
  assert.equal(packageContentDigest(packagedDebugger), packageContentDigest(debuggerPackage));
  assert.equal(packageContentDigest(packagedBrowser), packageContentDigest(browserPackage));
  assert.equal(packageContentDigest(packagedAutomation), packageContentDigest(automationPackage));
  assert.equal(packageContentDigest(packagedOverlay), packageContentDigest(overlayPackage));
});

test("removes package-manager command shims recursively from staged packages", (t) => {
  const root = createTempDir(t);
  writeFile(path.join(root, "node_modules", ".bin", "top-level"));
  writeFile(path.join(root, "node_modules", "dependency", "node_modules", ".bin", "nested"));
  writeFile(path.join(root, "node_modules", "dependency", "index.js"));

  prunePackageManagerBinDirectories(root);

  assert.equal(fs.existsSync(path.join(root, "node_modules", ".bin")), false);
  assert.equal(
    fs.existsSync(path.join(root, "node_modules", "dependency", "node_modules", ".bin")),
    false,
  );
  assert.equal(fs.existsSync(path.join(root, "node_modules", "dependency", "index.js")), true);
});

test("fails verification when a runtime manifest, marker, or executable is missing", async (t) => {
  await t.test("missing package.json", () => {
    const tempDir = createTempDir(t);
    const unpackedNodeModules = path.join(tempDir, "node_modules");
    const [claude] = getLocalRuntimePackageSpecs("win32", "x64");
    createRuntimeFixture(unpackedNodeModules, claude);
    fs.rmSync(
      path.join(unpackedNodeModules, packageNameToPath(claude.nativePackageName), "package.json"),
    );

    assert.throws(
      () => verifyLocalRuntimePackage(unpackedNodeModules, claude),
      /Claude native package manifest is missing/,
    );
  });

  await t.test("missing Claude executable", () => {
    const tempDir = createTempDir(t);
    const unpackedNodeModules = path.join(tempDir, "node_modules");
    const [claude] = getLocalRuntimePackageSpecs("win32", "x64");
    createRuntimeFixture(unpackedNodeModules, claude);
    fs.rmSync(
      path.join(
        unpackedNodeModules,
        packageNameToPath(claude.nativePackageName),
        claude.executableRelativePath,
      ),
    );

    assert.throws(
      () => verifyLocalRuntimePackage(unpackedNodeModules, claude),
      /required Claude executable file is missing/,
    );
  });

  await t.test("missing Codex package marker", () => {
    const tempDir = createTempDir(t);
    const unpackedNodeModules = path.join(tempDir, "node_modules");
    const codex = getLocalRuntimePackageSpecs("linux", "arm64").find((spec) => spec.id === "codex");
    createRuntimeFixture(unpackedNodeModules, codex);
    fs.rmSync(
      path.join(
        unpackedNodeModules,
        packageNameToPath(codex.nativePackageName),
        codex.nativeRequiredFiles[0],
      ),
    );

    assert.throws(
      () => verifyLocalRuntimePackage(unpackedNodeModules, codex),
      /required Codex native package file is missing/,
    );
  });
});

test("does not stage the Baileys Stage 0 sidecar without the explicit package gate", (t) => {
  const tempDir = createTempDir(t);
  const resourcesDir = path.join(tempDir, "packaged", "resources");
  const staleFile = path.join(resourcesDir, "baileys-stage0", "stale.mjs");
  writeFile(staleFile);

  const result = stageBaileysStage0Artifact(path.join(tempDir, "project"), resourcesDir, {});

  assert.equal(result.staged, false);
  assert.equal(fs.existsSync(path.dirname(staleFile)), false);
});

test("stages and verifies the opt-in Baileys Stage 0 sidecar", (t) => {
  const tempDir = createTempDir(t);
  const projectDir = path.join(tempDir, "project");
  const resourcesDir = path.join(tempDir, "packaged", "resources");
  const fixture = createBaileysStage0Fixture(projectDir);

  const result = stageBaileysStage0Artifact(projectDir, resourcesDir, {
    MARSHAL_BAILEYS_STAGE0_PACKAGE: "1",
  });

  assert.equal(result.staged, true);
  assert.equal(result.sha256, fixture.sha256);
  assert.equal(
    fs.readFileSync(
      path.join(resourcesDir, "baileys-stage0", "baileys-stage0-sidecar.mjs"),
      "utf8",
    ),
    "stage0-bundle",
  );
  assert.equal(
    fs.existsSync(path.join(resourcesDir, "baileys-stage0", "baileys-stage0-manifest.json")),
    true,
  );
});

test("fails opt-in Baileys Stage 0 staging when artifacts are missing or changed", async (t) => {
  await t.test("missing artifact", () => {
    const tempDir = createTempDir(t);
    assert.throws(
      () =>
        stageBaileysStage0Artifact(path.join(tempDir, "project"), path.join(tempDir, "resources"), {
          MARSHAL_BAILEYS_STAGE0_PACKAGE: "1",
        }),
      /Baileys Stage 0 bundle is missing/,
    );
  });

  await t.test("hash mismatch", () => {
    const tempDir = createTempDir(t);
    const projectDir = path.join(tempDir, "project");
    const fixture = createBaileysStage0Fixture(projectDir);
    fs.appendFileSync(fixture.bundlePath, "-changed");
    assert.throws(
      () =>
        stageBaileysStage0Artifact(projectDir, path.join(tempDir, "resources"), {
          MARSHAL_BAILEYS_STAGE0_PACKAGE: "1",
        }),
      /bundle hash mismatch/,
    );
  });
});

test("does not stage the WhatsApp connection sidecar without the explicit package gate", (t) => {
  const tempDir = createTempDir(t);
  const resourcesDir = path.join(tempDir, "packaged", "resources");
  const staleFile = path.join(resourcesDir, "whatsapp-sidecar", "stale.mjs");
  writeFile(staleFile);

  const result = stageWhatsAppSidecarArtifact(path.join(tempDir, "project"), resourcesDir, {});

  assert.equal(result.staged, false);
  assert.equal(fs.existsSync(path.dirname(staleFile)), false);
});

test("stages and verifies the opt-in WhatsApp connection sidecar", (t) => {
  const tempDir = createTempDir(t);
  const projectDir = path.join(tempDir, "project");
  const resourcesDir = path.join(tempDir, "packaged", "resources");
  const fixture = createWhatsAppSidecarFixture(projectDir);

  const result = stageWhatsAppSidecarArtifact(projectDir, resourcesDir, {
    MARSHAL_WHATSAPP_SIDECAR_PACKAGE: "1",
  });

  assert.equal(result.staged, true);
  assert.equal(result.sha256, fixture.sha256);
  assert.equal(
    fs.existsSync(path.join(resourcesDir, "whatsapp-sidecar", "whatsapp-sidecar.mjs")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(resourcesDir, "whatsapp-sidecar", "whatsapp-sidecar-manifest.json")),
    true,
  );
});

test("fails opt-in WhatsApp connection sidecar staging when artifacts are missing or changed", async (t) => {
  await t.test("missing artifact", () => {
    const tempDir = createTempDir(t);
    assert.throws(
      () =>
        stageWhatsAppSidecarArtifact(
          path.join(tempDir, "project"),
          path.join(tempDir, "resources"),
          {
            MARSHAL_WHATSAPP_SIDECAR_PACKAGE: "1",
          },
        ),
      /WhatsApp sidecar bundle is missing/,
    );
  });

  await t.test("hash mismatch", () => {
    const tempDir = createTempDir(t);
    const projectDir = path.join(tempDir, "project");
    const fixture = createWhatsAppSidecarFixture(projectDir);
    fs.appendFileSync(fixture.bundlePath, "-changed");
    assert.throws(
      () =>
        stageWhatsAppSidecarArtifact(projectDir, path.join(tempDir, "resources"), {
          MARSHAL_WHATSAPP_SIDECAR_PACKAGE: "1",
        }),
      /bundle hash mismatch/,
    );
  });
});
