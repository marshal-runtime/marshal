import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const MARSHAL_RUNTIME_EXTENSIONS_ROOT_ENV = "MARSHAL_RUNTIME_EXTENSIONS_ROOT";
export const USER_LIBRARY_DIRNAME = "Marshal Runtime";
export const USER_EXTENSIONS_DIRNAME = "extensions";
export const WINDOWS_DOCUMENTS_DIRNAME = "Documents";
export const RUNTIME_EXTENSION_MANIFEST_FILENAME = "runtime-extension.json";
export const RUNTIME_EXTENSION_ENTRYPOINT = "dist/index.cjs";
export const RUNTIME_EXTENSION_MODULE_FORMAT = "commonjs-bundle-v1";
export const RUNTIME_EXTENSION_SCHEMA_VERSION = 1;
export const EXTENSION_IDENTITY_PATTERN = /^@[a-z0-9-]+\/[a-z0-9-]+$/;
export const EXTENSION_STUB_SOURCE = "module.exports = { activate() { return {}; } };\n";
export const NODE_MODULES_DIRNAME = "node_modules";
export const GIT_URL_PATTERN = /^(?:git@|https?:\/\/|ssh:\/\/|git:\/\/)/i;
export const GIT_SUFFIX = ".git";
export const VITEST_ENV = "VITEST";
export const VITEST_TRUE = "true";
export const LOCAL_CLI_BIN_DIR = path.join(".local", "bin");
export const WINDOWS_CLI_BIN_DIR = path.join("AppData", "Local", "Marshal", "bin");
export const MARSHAL_CLI_NAME = "marshal";
export const MARSHAL_WINDOWS_CLI_NAME = "marshal.cmd";
export const PACKAGED_CLI_DIRNAME = "cli";
export const PACKAGED_CLI_FILENAME = "marshal-cli.mjs";
export const DEFAULT_NODE_BIN = "node";

export function parseExtensionIdentity(value) {
  const identity = value?.trim();
  if (!identity || !EXTENSION_IDENTITY_PATTERN.test(identity)) {
    throw new Error("Provide an extension identity like @acme/hello.");
  }
  return identity;
}

export function extensionDirectoryName(identity) {
  return identity.slice(1).replace("/", "-");
}

export function isGitExtensionSource(value) {
  const source = value?.trim() ?? "";
  if (!source) return false;
  return GIT_URL_PATTERN.test(source) || source.endsWith(GIT_SUFFIX);
}

export function gitCloneDirectoryName(source) {
  const trimmed = source.trim().replace(/\/+$/, "");
  const base = path.basename(trimmed, GIT_SUFFIX);
  if (!base || base === "." || base === "..") {
    throw new Error("The git repository URL does not include a usable directory name.");
  }
  return base;
}

/** Resolves the user-visible extension library. macOS/Linux: ~/Marshal Runtime/extensions. Windows: Documents\\Marshal Runtime\\extensions. */
export function defaultUserExtensionLibraryRoot(options = {}) {
  const env = options.env ?? process.env;
  const configured = env[MARSHAL_RUNTIME_EXTENSIONS_ROOT_ENV]?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error(`${MARSHAL_RUNTIME_EXTENSIONS_ROOT_ENV} must be an absolute directory.`);
    }
    return path.resolve(configured);
  }
  if (
    !Object.hasOwn(options, "homedir") &&
    (env[VITEST_ENV] === VITEST_TRUE || process.env[VITEST_ENV] === VITEST_TRUE)
  ) {
    return null;
  }
  const homedir = options.homedir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return path.join(
      options.documentsDir ?? path.join(homedir, WINDOWS_DOCUMENTS_DIRNAME),
      USER_LIBRARY_DIRNAME,
      USER_EXTENSIONS_DIRNAME,
    );
  }
  return path.join(homedir, USER_LIBRARY_DIRNAME, USER_EXTENSIONS_DIRNAME);
}

export function defaultCliShimPath({ platform = process.platform, homedir = os.homedir() } = {}) {
  if (platform === "win32") {
    return path.join(homedir, WINDOWS_CLI_BIN_DIR, MARSHAL_WINDOWS_CLI_NAME);
  }
  return path.join(homedir, LOCAL_CLI_BIN_DIR, MARSHAL_CLI_NAME);
}

async function readExtensionIdentity(packageRoot) {
  const manifestPath = path.join(packageRoot, RUNTIME_EXTENSION_MANIFEST_FILENAME);
  const raw = await readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || typeof parsed.identity !== "string") {
    throw new Error(`Extension at ${packageRoot} is missing runtime-extension.json identity.`);
  }
  return parseExtensionIdentity(parsed.identity);
}

async function assertDestinationAvailable(destination) {
  if (existsSync(destination)) {
    throw new Error(`Extension already exists at ${destination}`);
  }
}

function skipCopyNoise(source) {
  return path.basename(source) !== NODE_MODULES_DIRNAME;
}

export async function addRuntimeExtensionFromFolder({ source, libraryRoot, copy = cp }) {
  const resolved = path.resolve(source);
  const stat = await lstat(resolved).catch(() => null);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("The local extension source must be a real directory.");
  }
  await readExtensionIdentity(resolved);
  const directoryName = path.basename(resolved);
  const destination = path.join(libraryRoot, directoryName);
  await mkdir(libraryRoot, { recursive: true });
  await assertDestinationAvailable(destination);
  await copy(resolved, destination, { recursive: true, filter: skipCopyNoise });
  return {
    identity: await readExtensionIdentity(destination),
    packageRoot: destination,
    source: "folder",
  };
}

export async function addRuntimeExtensionFromGit({
  source,
  libraryRoot,
  clone = cloneGitRepository,
}) {
  const directoryName = gitCloneDirectoryName(source);
  const destination = path.join(libraryRoot, directoryName);
  await mkdir(libraryRoot, { recursive: true });
  await assertDestinationAvailable(destination);
  await clone(source.trim(), destination);
  try {
    const identity = await readExtensionIdentity(destination);
    return { identity, packageRoot: destination, source: "git" };
  } catch (error) {
    throw new Error(
      `Cloned ${source} but it is not a Marshal Runtime extension (missing runtime-extension.json).`,
      { cause: error },
    );
  }
}

export async function addRuntimeExtension({ source, libraryRoot, copy, clone }) {
  if (isGitExtensionSource(source)) {
    return addRuntimeExtensionFromGit({ source, libraryRoot, clone });
  }
  return addRuntimeExtensionFromFolder({ source, libraryRoot, copy });
}

export async function createRuntimeExtensionStub({ identity: rawIdentity, libraryRoot }) {
  const identity = parseExtensionIdentity(rawIdentity);
  const packageRoot = path.join(libraryRoot, extensionDirectoryName(identity));
  await mkdir(libraryRoot, { recursive: true });
  await assertDestinationAvailable(packageRoot);
  await mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: identity,
        version: "0.1.0",
        type: "commonjs",
        main: RUNTIME_EXTENSION_ENTRYPOINT,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    path.join(packageRoot, RUNTIME_EXTENSION_MANIFEST_FILENAME),
    `${JSON.stringify(
      {
        schemaVersion: RUNTIME_EXTENSION_SCHEMA_VERSION,
        identity,
        version: "0.1.0",
        entrypoint: RUNTIME_EXTENSION_ENTRYPOINT,
        moduleFormat: RUNTIME_EXTENSION_MODULE_FORMAT,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    path.join(packageRoot, RUNTIME_EXTENSION_ENTRYPOINT),
    EXTENSION_STUB_SOURCE,
    "utf8",
  );
  return { identity, packageRoot };
}

export function packagedMarshalCliPath(resourcesPath) {
  return path.join(resourcesPath, PACKAGED_CLI_DIRNAME, PACKAGED_CLI_FILENAME);
}

export async function installMarshalCliShim({
  cliPath,
  shimPath,
  platform = process.platform,
  nodePath = DEFAULT_NODE_BIN,
}) {
  const resolvedCli = path.resolve(cliPath);
  const resolvedShim = path.resolve(shimPath);
  const resolvedNode = nodePath === DEFAULT_NODE_BIN ? DEFAULT_NODE_BIN : path.resolve(nodePath);
  await mkdir(path.dirname(resolvedShim), { recursive: true });
  if (platform === "win32") {
    await writeFile(resolvedShim, `@echo off\r\n"${resolvedNode}" "${resolvedCli}" %*\r\n`, "utf8");
    return resolvedShim;
  }
  const body = `#!/bin/sh\nexec "${resolvedNode}" "${resolvedCli}" "$@"\n`;
  await writeFile(resolvedShim, body, { encoding: "utf8", mode: 0o755 });
  return resolvedShim;
}

/** Writes ~/.local/bin/marshal (or the Windows equivalent) when the packaged app launches. */
export async function maybeInstallPackagedMarshalCli({
  isPackaged,
  resourcesPath,
  platform = process.platform,
  homedir = os.homedir(),
  nodePath = DEFAULT_NODE_BIN,
  install = installMarshalCliShim,
}) {
  if (!isPackaged) return null;
  return install({
    cliPath: packagedMarshalCliPath(resourcesPath),
    shimPath: defaultCliShimPath({ platform, homedir }),
    platform,
    nodePath,
  });
}

export function cloneGitRepository(url, destination) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["clone", "--", url, destination], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stderr = [];
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) {
        resolve(undefined);
        return;
      }
      reject(
        new Error(
          `git clone failed${stderr.length ? `: ${Buffer.concat(stderr).toString("utf8").trim()}` : ""}`,
        ),
      );
    });
  });
}
