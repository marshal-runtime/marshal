import { existsSync } from "node:fs";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const MARSHAL_RUNTIME_LOCAL_ENV = "MARSHAL_RUNTIME_LOCAL";
export const MARSHAL_RUNTIME_SOURCE_ENV = "MARSHAL_RUNTIME_SOURCE";
export const MARSHAL_RUNTIME_EXTENSIONS_ROOT_ENV = "MARSHAL_RUNTIME_EXTENSIONS_ROOT";
export const MARSHAL_RUNTIME_LOCAL_FLAG_VALUE = "1";
export const DEFAULT_LOCAL_RUNTIME_DIRNAME = "marshal-agent-runtime";
export const RUNTIME_PACKAGE_SUBPATH = path.join("packages", "runtime");
export const RUNTIME_PACKAGE_MANIFEST_RELATIVE = path.join("packages", "runtime", "package.json");
export const RUNTIME_EXTENSIONS_DIRNAME = "extensions";
export const USER_LIBRARY_DIRNAME = "Marshal Runtime";
export const WINDOWS_DOCUMENTS_DIRNAME = "Documents";
export const VITEST_ENV = "VITEST";
export const VITEST_TRUE = "true";
export const LOCAL_CLI_BIN_DIR = path.join(".local", "bin");
export const WINDOWS_CLI_BIN_DIR = path.join("AppData", "Local", "Marshal", "bin");
export const MARSHAL_CLI_NAME = "marshal";
export const MARSHAL_WINDOWS_CLI_NAME = "marshal.cmd";
export const PACKAGED_CLI_DIRNAME = "cli";
export const PACKAGED_CLI_FILENAME = "marshal-cli.mjs";
export const DEFAULT_NODE_BIN = "node";

export type MarshalRuntimeProcessEnv = Readonly<Record<string, string | undefined>>;

export interface MarshalRuntimeAppLocation {
  readonly isPackaged: boolean;
  readonly appPath: string;
  readonly resourcesPath?: string;
}

export interface MarshalRuntimeLocalSource {
  readonly root: string;
  readonly packageRoot: string;
}

function trimEnv(env: MarshalRuntimeProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value || undefined;
}

/** Returns true when unpackaged Marshal should load the local runtime workspace. */
export function isLocalMarshalRuntimeEnabled(
  location: MarshalRuntimeAppLocation,
  env: MarshalRuntimeProcessEnv = process.env,
): boolean {
  return (
    !location.isPackaged &&
    trimEnv(env, MARSHAL_RUNTIME_LOCAL_ENV) === MARSHAL_RUNTIME_LOCAL_FLAG_VALUE
  );
}

/** Returns true when a directory looks like a marshal-agent-runtime workspace. */
export function isMarshalRuntimeWorkspace(root: string): boolean {
  return existsSync(path.join(root, RUNTIME_PACKAGE_MANIFEST_RELATIVE));
}

/** Resolves the sibling marshal-agent-runtime checkout next to the Marshal app. */
export function defaultLocalMarshalRuntimeRoot(appPath: string): string {
  return path.resolve(appPath, "..", DEFAULT_LOCAL_RUNTIME_DIRNAME);
}

function requireAbsoluteDirectory(value: string, envName: string): string {
  if (!path.isAbsolute(value)) {
    throw new Error(`${envName} must be an absolute directory.`);
  }
  return path.resolve(value);
}

export interface UserExtensionLibraryOptions {
  readonly env?: MarshalRuntimeProcessEnv;
  readonly homedir?: string;
  readonly documentsDir?: string;
  readonly platform?: NodeJS.Platform;
}

/** Resolves the user-visible extension library. macOS/Linux: ~/Marshal Runtime/extensions. Windows: Documents\\Marshal Runtime\\extensions. */
export function defaultUserExtensionLibraryRoot(
  options: UserExtensionLibraryOptions = {},
): string | null {
  const env = options.env ?? process.env;
  const configured = trimEnv(env, MARSHAL_RUNTIME_EXTENSIONS_ROOT_ENV);
  if (configured) return requireAbsoluteDirectory(configured, MARSHAL_RUNTIME_EXTENSIONS_ROOT_ENV);
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
      RUNTIME_EXTENSIONS_DIRNAME,
    );
  }
  return path.join(homedir, USER_LIBRARY_DIRNAME, RUNTIME_EXTENSIONS_DIRNAME);
}

/** Resolves ~/.local/bin/marshal or the Windows AppData shim path. */
export function defaultCliShimPath({
  platform = process.platform,
  homedir = os.homedir(),
}: {
  platform?: NodeJS.Platform;
  homedir?: string;
} = {}): string {
  if (platform === "win32") {
    return path.join(homedir, WINDOWS_CLI_BIN_DIR, MARSHAL_WINDOWS_CLI_NAME);
  }
  return path.join(homedir, LOCAL_CLI_BIN_DIR, MARSHAL_CLI_NAME);
}

/** Resolves the packaged extraResources copy of the marshal CLI. */
export function packagedMarshalCliPath(resourcesPath: string): string {
  return path.join(resourcesPath, PACKAGED_CLI_DIRNAME, PACKAGED_CLI_FILENAME);
}

/** Writes a PATH shim that runs the marshal CLI with the given Node binary. */
export async function installMarshalCliShim({
  cliPath,
  shimPath,
  platform = process.platform,
  nodePath = DEFAULT_NODE_BIN,
}: {
  cliPath: string;
  shimPath: string;
  platform?: NodeJS.Platform;
  nodePath?: string;
}): Promise<string> {
  const resolvedCli = path.resolve(cliPath);
  const resolvedShim = path.resolve(shimPath);
  const resolvedNode = nodePath === DEFAULT_NODE_BIN ? DEFAULT_NODE_BIN : path.resolve(nodePath);
  await mkdir(path.dirname(resolvedShim), { recursive: true });
  if (platform === "win32") {
    await writeFile(resolvedShim, `@echo off\r\n"${resolvedNode}" "${resolvedCli}" %*\r\n`, "utf8");
    return resolvedShim;
  }
  await writeFile(resolvedShim, `#!/bin/sh\nexec "${resolvedNode}" "${resolvedCli}" "$@"\n`, {
    encoding: "utf8",
    mode: 0o755,
  });
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
}: {
  isPackaged: boolean;
  resourcesPath: string;
  platform?: NodeJS.Platform;
  homedir?: string;
  nodePath?: string;
  install?: typeof installMarshalCliShim;
}): Promise<string | null> {
  if (!isPackaged) return null;
  return install({
    cliPath: packagedMarshalCliPath(resourcesPath),
    shimPath: defaultCliShimPath({ platform, homedir }),
    platform,
    nodePath,
  });
}

function localRuntimePackageRoot(sourceRoot: string): string {
  return path.join(sourceRoot, RUNTIME_PACKAGE_SUBPATH);
}

/** Resolves the local runtime workspace when MARSHAL_RUNTIME_LOCAL=1. */
export function resolveLocalMarshalRuntimeSource(
  location: MarshalRuntimeAppLocation,
  env: MarshalRuntimeProcessEnv = process.env,
): MarshalRuntimeLocalSource | null {
  if (!isLocalMarshalRuntimeEnabled(location, env)) return null;

  const configured = trimEnv(env, MARSHAL_RUNTIME_SOURCE_ENV);
  const root = configured
    ? requireAbsoluteDirectory(configured, MARSHAL_RUNTIME_SOURCE_ENV)
    : defaultLocalMarshalRuntimeRoot(location.appPath);
  if (!isMarshalRuntimeWorkspace(root)) {
    throw new Error(
      `MARSHAL_RUNTIME_LOCAL=1 requires a Marshal Runtime workspace at ${root} ` +
        `(set ${MARSHAL_RUNTIME_SOURCE_ENV} or clone ${DEFAULT_LOCAL_RUNTIME_DIRNAME} next to Marshal).`,
    );
  }
  return { root, packageRoot: localRuntimePackageRoot(root) };
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    path
      .normalize(value)
      .replace(/[\\/]+$/, "")
      .toLowerCase();
  return normalize(left) === normalize(right);
}

async function ensureRealDirectory(
  candidate: string,
  mkdirIfMissing: boolean,
): Promise<string | null> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(candidate);
  } catch (error) {
    const code = error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
    if (code !== "ENOENT") {
      throw new Error("The Marshal Runtime extension discovery root is unavailable.", {
        cause: error,
      });
    }
    if (!mkdirIfMissing) {
      throw new Error("The Marshal Runtime extension discovery root is unavailable.", {
        cause: error,
      });
    }
    try {
      await mkdir(candidate, { recursive: true });
    } catch (mkdirError) {
      const mkdirCode =
        mkdirError && typeof mkdirError === "object" ? Reflect.get(mkdirError, "code") : undefined;
      if (mkdirCode === "ENOENT") return null;
      if (mkdirCode !== "EEXIST") {
        throw new Error("The Marshal Runtime extension discovery root is unavailable.", {
          cause: mkdirError,
        });
      }
    }
    stat = await lstat(candidate);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("The Marshal Runtime extension discovery root must be a real directory.");
  }
  return realpath(candidate);
}

export interface RuntimeExtensionDiscoveryPaths {
  readonly homedir?: string;
  readonly documentsDir?: string;
  readonly platform?: NodeJS.Platform;
}

function localRuntimeExtensionRoot(
  location: MarshalRuntimeAppLocation,
  env: MarshalRuntimeProcessEnv,
): string | null {
  const local = resolveLocalMarshalRuntimeSource(location, env);
  return local ? path.join(local.root, RUNTIME_EXTENSIONS_DIRNAME) : null;
}

function uniqueDirectories(candidates: readonly string[]): string[] {
  const unique: string[] = [];
  candidates.forEach((candidate) => {
    if (!unique.some((existing) => samePath(existing, candidate))) unique.push(candidate);
  });
  return unique;
}

/** Resolves the user-visible extension library, plus the local runtime extras when enabled. */
export async function resolveRuntimeExtensionDiscoveryRoots(
  location: MarshalRuntimeAppLocation,
  trustedExtensionRoot: string,
  env: MarshalRuntimeProcessEnv = process.env,
  paths: RuntimeExtensionDiscoveryPaths = {},
): Promise<readonly string[]> {
  const configuredRoot = trimEnv(env, MARSHAL_RUNTIME_EXTENSIONS_ROOT_ENV);
  const libraryRoot = configuredRoot
    ? requireAbsoluteDirectory(configuredRoot, MARSHAL_RUNTIME_EXTENSIONS_ROOT_ENV)
    : defaultUserExtensionLibraryRoot({
        env,
        ...(Object.hasOwn(paths, "homedir") ? { homedir: paths.homedir } : {}),
        documentsDir: paths.documentsDir,
        platform: paths.platform,
      });
  const planned = uniqueDirectories(
    [libraryRoot, localRuntimeExtensionRoot(location, env)].filter(
      (candidate): candidate is string => Boolean(candidate),
    ),
  ).filter((candidate) => !samePath(candidate, trustedExtensionRoot));

  const resolved = (
    await Promise.all(
      planned.map((candidate) =>
        ensureRealDirectory(candidate, !configuredRoot || candidate !== libraryRoot),
      ),
    )
  ).filter((root): root is string => Boolean(root));
  return uniqueDirectories(resolved);
}
