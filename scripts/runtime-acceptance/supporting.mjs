import fs from "node:fs";
import path from "node:path";

import {
  LocalRuntimeExtensionPackageLoader,
  RuntimeExtensionManager,
  computeRuntimeExtensionIntegrity,
} from "@marshal/runtime/extensions";

const evidenceRoot = process.env.MARSHAL_RUNTIME_ACCEPTANCE_EVIDENCE_ROOT;
if (!evidenceRoot || !path.isAbsolute(evidenceRoot)) {
  throw new Error("MARSHAL_RUNTIME_ACCEPTANCE_EVIDENCE_ROOT must be an absolute path.");
}

const workRoot = path.join(evidenceRoot, "supporting-extension-contracts-work");
fs.rmSync(workRoot, { recursive: true, force: true });
fs.mkdirSync(workRoot, { recursive: true });

try {
  const loaderCodes = captureLoaderCodes(workRoot);
  const managerContracts = await captureManagerContracts(workRoot);
  const result = {
    capturedAt: new Date().toISOString(),
    loaderCodes,
    ...managerContracts,
  };
  fs.writeFileSync(
    path.join(evidenceRoot, "supporting-disposal.json"),
    JSON.stringify(result, null, 2),
  );
  fs.writeFileSync(
    path.join(evidenceRoot, "supporting-extension-contracts.json"),
    JSON.stringify(result, null, 2),
  );
} finally {
  fs.rmSync(workRoot, { recursive: true, force: true });
}

function captureLoaderCodes(root) {
  const allowedRoot = path.join(root, "allowed");
  const outsideRoot = path.join(root, "outside");
  fs.mkdirSync(allowedRoot, { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });
  const loader = new LocalRuntimeExtensionPackageLoader({ allowedRoots: [allowedRoot] });
  const results = {};

  results.INVALID_LOADER_ROOT = captureCode(
    () => new LocalRuntimeExtensionPackageLoader({ allowedRoots: [] }),
    "INVALID_LOADER_ROOT",
  );
  results.INVALID_REQUEST = captureCode(() => loader.load(null), "INVALID_REQUEST");

  const invalidIntegrity = packageFixture(allowedRoot, "invalid-integrity");
  results.INVALID_INTEGRITY = captureCode(
    () =>
      loader.load({
        packageRoot: invalidIntegrity,
        integrity: { ...computeRuntimeExtensionIntegrity(invalidIntegrity), value: "invalid" },
      }),
    "INVALID_INTEGRITY",
  );
  results.SOURCE_UNAVAILABLE = captureCode(
    () =>
      loader.load({
        packageRoot: path.join(allowedRoot, "missing"),
        integrity: validDigest(),
      }),
    "SOURCE_UNAVAILABLE",
  );

  const outside = packageFixture(outsideRoot, "outside-root");
  results.ROOT_NOT_ALLOWED = captureCode(
    () =>
      loader.load({ packageRoot: outside, integrity: computeRuntimeExtensionIntegrity(outside) }),
    "ROOT_NOT_ALLOWED",
  );

  const unsafe = packageFixture(allowedRoot, "unsafe-tree");
  const unsafeTarget = path.join(root, "unsafe-target");
  fs.mkdirSync(unsafeTarget, { recursive: true });
  fs.writeFileSync(path.join(unsafeTarget, "outside.txt"), "outside");
  fs.symlinkSync(unsafeTarget, path.join(unsafe, "linked"), "junction");
  results.UNSAFE_PACKAGE_TREE = captureCode(
    () => loader.load({ packageRoot: unsafe, integrity: validDigest() }),
    "UNSAFE_PACKAGE_TREE",
  );

  const limited = packageFixture(allowedRoot, "file-limit");
  for (let index = 0; index < 2_046; index += 1) {
    fs.writeFileSync(path.join(limited, `limit-${index}.txt`), "");
  }
  results.PACKAGE_LIMIT_EXCEEDED = captureCode(
    () => loader.load({ packageRoot: limited, integrity: validDigest() }),
    "PACKAGE_LIMIT_EXCEEDED",
  );

  const mismatched = packageFixture(allowedRoot, "integrity-mismatch");
  results.INTEGRITY_MISMATCH = captureCode(
    () => loader.load({ packageRoot: mismatched, integrity: validDigest() }),
    "INTEGRITY_MISMATCH",
  );

  results.INVALID_MANIFEST = loaderMutation(
    allowedRoot,
    loader,
    "invalid-manifest",
    (packageRoot) => fs.writeFileSync(path.join(packageRoot, "runtime-extension.json"), "{}"),
    "INVALID_MANIFEST",
  );
  results.IDENTITY_MISMATCH = loaderMutation(
    allowedRoot,
    loader,
    "identity-mismatch",
    (packageRoot) => {
      const manifest = readJson(path.join(packageRoot, "runtime-extension.json"));
      writeJson(path.join(packageRoot, "runtime-extension.json"), {
        ...manifest,
        identity: "acceptance.changed",
      });
    },
    "IDENTITY_MISMATCH",
  );
  results.VERSION_MISMATCH = loaderMutation(
    allowedRoot,
    loader,
    "version-mismatch",
    (packageRoot) => {
      const manifest = readJson(path.join(packageRoot, "runtime-extension.json"));
      writeJson(path.join(packageRoot, "runtime-extension.json"), {
        ...manifest,
        version: "2.0.0",
      });
    },
    "VERSION_MISMATCH",
  );
  results.INVALID_ENTRYPOINT = loaderMutation(
    allowedRoot,
    loader,
    "invalid-entrypoint",
    (packageRoot) => {
      const manifest = readJson(path.join(packageRoot, "runtime-extension.json"));
      const packageJson = readJson(path.join(packageRoot, "package.json"));
      writeJson(path.join(packageRoot, "runtime-extension.json"), {
        ...manifest,
        entrypoint: "missing.cjs",
      });
      writeJson(path.join(packageRoot, "package.json"), {
        ...packageJson,
        main: "missing.cjs",
      });
    },
    "INVALID_ENTRYPOINT",
  );
  results.UNSUPPORTED_MODULE_FORMAT = loaderMutation(
    allowedRoot,
    loader,
    "unsupported-format",
    (packageRoot) => {
      const packageJson = readJson(path.join(packageRoot, "package.json"));
      writeJson(path.join(packageRoot, "package.json"), { ...packageJson, type: "module" });
    },
    "UNSUPPORTED_MODULE_FORMAT",
  );
  results.UNSUPPORTED_MODULE_DEPENDENCY = loaderMutation(
    allowedRoot,
    loader,
    "unsupported-dependency",
    (packageRoot) =>
      fs.writeFileSync(path.join(packageRoot, "index.cjs"), 'require("not-injected");'),
    "UNSUPPORTED_MODULE_DEPENDENCY",
  );
  results.UNSUPPORTED_MODULE_SHAPE = loaderMutation(
    allowedRoot,
    loader,
    "unsupported-shape",
    (packageRoot) => fs.writeFileSync(path.join(packageRoot, "index.cjs"), "module.exports={};"),
    "UNSUPPORTED_MODULE_SHAPE",
  );
  results.MODULE_LOAD_FAILED = loaderMutation(
    allowedRoot,
    loader,
    "module-load-failed",
    (packageRoot) =>
      fs.writeFileSync(path.join(packageRoot, "index.cjs"), 'throw new Error("load failed");'),
    "MODULE_LOAD_FAILED",
  );
  const cancelled = packageFixture(allowedRoot, "cancelled");
  results.CANCELLED = captureCode(
    () =>
      loader.load(
        { packageRoot: cancelled, integrity: computeRuntimeExtensionIntegrity(cancelled) },
        { aborted: true },
      ),
    "CANCELLED",
  );
  return results;
}

async function captureManagerContracts(root) {
  const disposalEvents = [];
  const manager = new RuntimeExtensionManager({
    kernel: fakeKernel(),
    loader: fakeLoader((identity) => ({
      dispose() {
        disposalEvents.push(identity);
        throw new Error(`dispose failed: ${identity}`);
      },
    })),
    activationContext: {
      principal: { id: "runtime-acceptance", kind: "agent" },
      identity: { harnessId: "runtime-acceptance" },
    },
  });
  await manager.install(fakeRequest(root, "dispose-a"));
  await manager.install(fakeRequest(root, "dispose-b"));
  let aggregate;
  try {
    await manager.dispose();
    aggregate = { code: null, causeCount: 0 };
  } catch (error) {
    aggregate = {
      code: errorCode(error),
      causeCount: error?.cause instanceof AggregateError ? error.cause.errors.length : 0,
    };
  }
  const postDispose = {};
  for (const [name, action] of Object.entries({
    install: () => manager.install(fakeRequest(root, "post-install")),
    update: () => manager.update("acceptance.dispose-a", fakeRequest(root, "post-update")),
    enable: () => manager.enable("acceptance.dispose-a"),
    disable: () => manager.disable("acceptance.dispose-a"),
    remove: () => manager.remove("acceptance.dispose-a"),
  })) {
    postDispose[name] = await captureAsyncCode(action);
  }
  await manager.dispose();

  let collisionMode = "unique";
  const resourceManager = new RuntimeExtensionManager({
    kernel: fakeKernel(),
    loader: fakeLoader((identity) => ({
      resourceProviders: [
        {
          listResources() {
            return [
              {
                uri:
                  collisionMode === "duplicate"
                    ? "runtime://acceptance/shared"
                    : `runtime://acceptance/${identity}`,
                name: identity,
              },
            ];
          },
          readResource(uri) {
            return { uri, text: identity };
          },
        },
      ],
    })),
    activationContext: {
      principal: { id: "runtime-acceptance", kind: "agent" },
      identity: { harnessId: "runtime-acceptance" },
    },
  });
  await resourceManager.install(fakeRequest(root, "resource-a"));
  await resourceManager.install(fakeRequest(root, "resource-b"));
  collisionMode = "duplicate";
  const aggregateListCode = await captureAsyncCode(() =>
    resourceManager.resources.listResources({ principal: { id: "test", kind: "agent" } }),
  );
  const aggregateReadCode = await captureAsyncCode(() =>
    resourceManager.resources.readResource("runtime://acceptance/shared", {
      principal: { id: "test", kind: "agent" },
    }),
  );
  collisionMode = "unique";
  await resourceManager.dispose();

  return {
    managerDisposedTwiceWithoutError: true,
    aggregateDisposalFailureCode: aggregate.code,
    aggregateDisposalFailureCount: aggregate.causeCount,
    disposalEvents,
    postDisposeMutations: postDispose,
    allPostDisposeMutationsRejected: Object.values(postDispose).every(
      (code) => code === "MANAGER_DISPOSED",
    ),
    aggregateResourceListCode: aggregateListCode,
    aggregateResourceReadCode: aggregateReadCode,
  };
}

function packageFixture(root, name) {
  const packageRoot = path.join(root, name);
  fs.mkdirSync(packageRoot, { recursive: true });
  writeJson(path.join(packageRoot, "package.json"), {
    name: `acceptance.${name}`,
    version: "1.0.0",
    type: "commonjs",
    main: "index.cjs",
  });
  writeJson(path.join(packageRoot, "runtime-extension.json"), {
    schemaVersion: 1,
    identity: `acceptance.${name}`,
    version: "1.0.0",
    entrypoint: "index.cjs",
    moduleFormat: "commonjs-bundle-v1",
  });
  fs.writeFileSync(path.join(packageRoot, "index.cjs"), "module.exports={activate(){return {}}};");
  return packageRoot;
}

function loaderMutation(root, loader, name, mutate, expected) {
  const packageRoot = packageFixture(root, name);
  mutate(packageRoot);
  return captureCode(
    () =>
      loader.load({
        packageRoot,
        integrity: computeRuntimeExtensionIntegrity(packageRoot),
      }),
    expected,
  );
}

function fakeKernel() {
  const registration = {
    async replace() {
      return registration;
    },
    dispose() {},
    snapshot: {
      providerIds: [],
      catalogProviderIds: [],
    },
  };
  return {
    async registerContributions() {
      return registration;
    },
  };
}

function fakeLoader(activation) {
  return {
    load(request) {
      const name = path.basename(request.packageRoot);
      const identity = `acceptance.${name}`;
      return {
        metadata: {
          manifest: {
            schemaVersion: 1,
            identity,
            version: "1.0.0",
            entrypoint: "index.cjs",
            moduleFormat: "commonjs-bundle-v1",
          },
          integrity: validDigest(),
          canonicalRoot: request.packageRoot,
          fileCount: 3,
          totalBytes: 1,
        },
        module: {
          activate() {
            return activation(identity);
          },
        },
      };
    },
  };
}

function fakeRequest(root, name) {
  return {
    packageRoot: path.join(root, name),
    integrity: validDigest(),
  };
}

function validDigest() {
  return {
    algorithm: "sha256",
    domain: "marshal-runtime-extension-package-v1",
    value: "0".repeat(64),
  };
}

function captureCode(action, expected) {
  try {
    action();
    throw new Error(`Expected ${expected}.`);
  } catch (error) {
    const code = errorCode(error);
    if (code !== expected) throw error;
    return code;
  }
}

async function captureAsyncCode(action) {
  try {
    await action();
    return null;
  } catch (error) {
    return errorCode(error);
  }
}

function errorCode(error) {
  return error && typeof error === "object" && typeof error.code === "string" ? error.code : null;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value));
}
