import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { secureMkdirSync, secureWriteFileSync } from "../platform-security";
import { WorkflowInstallError } from "./errors";

const esmRequire = createRequire(import.meta.url);

export interface WorkflowCompilerPaths {
  readonly appPackageRoot: string;
  readonly appNodeModules: string;
  readonly workflowSdkEntry: string;
}

function findAppPackageRoot(startDir: string): string {
  let dir = startDir;
  while (true) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new WorkflowInstallError(
        "COMPILE_FAILED",
        `Unable to locate app package root from ${startDir}`,
      );
    }
    dir = parent;
  }
}

export function resolveWorkflowCompilerPaths(
  startDir = path.dirname(fileURLToPath(import.meta.url)),
): WorkflowCompilerPaths {
  const appPackageRoot = findAppPackageRoot(startDir);
  const appNodeModules =
    path.basename(appPackageRoot) === "app.asar"
      ? path.join(`${appPackageRoot}.unpacked`, "node_modules")
      : path.join(appPackageRoot, "node_modules");

  return {
    appPackageRoot,
    appNodeModules,
    workflowSdkEntry: path.join(appPackageRoot, "packages", "workflow-sdk", "src", "index.ts"),
  };
}

function createAppPackageResolverPlugin(workflowSdkEntry: string): import("esbuild").Plugin {
  return {
    name: "app-package-resolver",
    setup(build) {
      // Marshal identity: workflow sources import the published package name.
      build.onResolve({ filter: /^@marshal\/workflow-sdk$/ }, () => ({
        path: "index.ts",
        namespace: "marshal-workflow-sdk",
      }));
      build.onLoad({ filter: /^index\.ts$/, namespace: "marshal-workflow-sdk" }, () => ({
        contents: fs.readFileSync(workflowSdkEntry, "utf-8"),
        loader: "ts",
        resolveDir: path.dirname(workflowSdkEntry),
      }));
    },
  };
}

function createRendererRuntimePlugin(): import("esbuild").Plugin {
  return {
    name: "workflow-renderer-runtime",
    setup(build) {
      build.onResolve({ filter: /^react$/ }, () => ({
        path: "react.ts",
        namespace: "workflow-renderer-runtime",
      }));
      // Marshal identity: renderer sources import the published package name.
      build.onResolve({ filter: /^@marshal\/workflow-sdk$/ }, () => ({
        path: "workflow-sdk.ts",
        namespace: "workflow-renderer-runtime",
      }));
      build.onLoad({ filter: /^react\.ts$/, namespace: "workflow-renderer-runtime" }, () => ({
        loader: "ts",
        contents: `
const React = globalThis.__workflowRendererReact;
if (!React) throw new Error("Workflow renderer React runtime is not installed");
export default React;
export const Fragment = React.Fragment;
export const createElement = React.createElement;
export const memo = React.memo;
export const useCallback = React.useCallback;
export const useEffect = React.useEffect;
export const useMemo = React.useMemo;
export const useRef = React.useRef;
export const useState = React.useState;
`,
      }));
      build.onLoad(
        { filter: /^workflow-sdk\.ts$/, namespace: "workflow-renderer-runtime" },
        () => ({
          loader: "ts",
          contents: `
export function defineRenderer(spec) {
  if (!spec || typeof spec.workflowId !== "string" || typeof spec.render !== "function") {
    throw new TypeError("defineRenderer requires workflowId and render");
  }
  return Object.freeze({ ...spec });
}
export function defineCommandCenter(spec) {
  if (!spec || typeof spec.workflowId !== "string" || typeof spec.render !== "function") {
    throw new TypeError("defineCommandCenter requires workflowId and render");
  }
  return Object.freeze({ ...spec });
}
`,
        }),
      );
    },
  };
}

function esbuildNativePackageName(platform = process.platform, arch = process.arch): string | null {
  const supported = new Set([
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-arm64",
    "win32-x64",
  ]);
  const name = `${platform}-${arch}`;
  return supported.has(name) ? name : null;
}

function esbuildNativeBinaryRelativePath(platform = process.platform): string {
  return platform === "win32" ? "esbuild.exe" : path.join("bin", "esbuild");
}

export function resolveEsbuildNativeBinaryPath(
  paths: WorkflowCompilerPaths,
  platform = process.platform,
  arch = process.arch,
): string | null {
  const packageName = esbuildNativePackageName(platform, arch);
  if (!packageName) return null;
  return path.join(
    paths.appPackageRoot,
    "node_modules",
    "@esbuild",
    packageName,
    esbuildNativeBinaryRelativePath(platform),
  );
}

export function extractEsbuildNativeBinaryForPackagedFallback(
  paths: WorkflowCompilerPaths,
  cacheRoot = path.join(os.homedir(), ".marshal", "workflow-compiler"),
  platform = process.platform,
  arch = process.arch,
): string | null {
  const nativeSource = resolveEsbuildNativeBinaryPath(paths, platform, arch);
  if (!nativeSource || !fs.existsSync(nativeSource)) return null;

  const bytes = fs.readFileSync(nativeSource);
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const packageName = esbuildNativePackageName(platform, arch) ?? `${platform}-${arch}`;
  const version = readEsbuildNativePackageVersion(paths, packageName) ?? "unknown";
  const cacheDir = path.join(cacheRoot, `${packageName}-${version}-${digest}`);
  const cachedBinary = path.join(cacheDir, path.basename(nativeSource));

  if (!fs.existsSync(cachedBinary)) {
    secureMkdirSync(cacheDir, 0o700);
    secureWriteFileSync(cachedBinary, bytes, { mode: 0o700 });
  }
  try {
    fs.chmodSync(cachedBinary, 0o700);
  } catch {
    /* best effort on Windows */
  }
  return cachedBinary;
}

function readEsbuildNativePackageVersion(
  paths: WorkflowCompilerPaths,
  packageName: string,
): string | null {
  try {
    // SF-4: package metadata is treated as unknown and read through Reflect after an object check.
    const packageJson: unknown = JSON.parse(
      fs.readFileSync(
        path.join(paths.appPackageRoot, "node_modules", "@esbuild", packageName, "package.json"),
        "utf-8",
      ),
    );
    if (typeof packageJson !== "object" || packageJson === null) return null;
    const version: unknown = Reflect.get(packageJson, "version");
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

function loadEsbuild(paths = resolveWorkflowCompilerPaths()): typeof import("esbuild") {
  const isPackagedAsar = path.basename(paths.appPackageRoot) === "app.asar";
  const loadFromUnpacked = () => {
    const requireFromUnpackedNodeModules = createRequire(
      path.join(paths.appNodeModules, "esbuild", "package.json"),
    );
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- dynamic CJS require boundary
    return requireFromUnpackedNodeModules("esbuild") as typeof import("esbuild");
  };

  if (isPackagedAsar) {
    try {
      return loadFromUnpacked();
    } catch (unpackedErr) {
      const extractedBinary = extractEsbuildNativeBinaryForPackagedFallback(paths);
      if (!extractedBinary) {
        const unpacked = formatEsbuildError(unpackedErr);
        const nativeSource =
          resolveEsbuildNativeBinaryPath(paths) ?? "(unsupported platform/architecture)";
        throw new WorkflowInstallError(
          "COMPILE_FAILED",
          `Unable to load packaged esbuild from ${paths.appNodeModules}; native binary was not available at ${nativeSource}: ${unpacked}`,
        );
      }
      process.env.ESBUILD_BINARY_PATH = extractedBinary;
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- dynamic CJS require boundary
        return esmRequire("esbuild") as typeof import("esbuild");
      } catch (asarErr) {
        const unpacked = formatEsbuildError(unpackedErr);
        const asar = formatEsbuildError(asarErr);
        const nativeSource =
          resolveEsbuildNativeBinaryPath(paths) ?? "(unsupported platform/architecture)";
        throw new WorkflowInstallError(
          "COMPILE_FAILED",
          `Unable to load esbuild from ${paths.appNodeModules}, extracted native binary ${nativeSource}, or app package: ${unpacked}; ${asar}`,
        );
      }
    }
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- dynamic CJS require boundary
    return esmRequire("esbuild") as typeof import("esbuild");
  } catch (primaryErr) {
    try {
      return loadFromUnpacked();
    } catch (fallbackErr) {
      const primary = formatEsbuildError(primaryErr);
      const fallback = formatEsbuildError(fallbackErr);
      throw new WorkflowInstallError(
        "COMPILE_FAILED",
        `Unable to load esbuild from app package or ${paths.appNodeModules}: ${primary}; ${fallback}`,
      );
    }
  }
}

function formatEsbuildError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Compile workflow.ts into CommonJS with the same settings for install and repo-local runs. */
export async function compileWithEsbuild(entry: string): Promise<string> {
  const resolvedEntry = path.resolve(entry);
  if (!fs.existsSync(resolvedEntry)) {
    throw new WorkflowInstallError(
      "MISSING_WORKFLOW_TS",
      `Workflow source not found: ${resolvedEntry}`,
    );
  }
  const paths = resolveWorkflowCompilerPaths();
  const esbuild = loadEsbuild(paths);
  try {
    const result = await esbuild.build({
      absWorkingDir: path.dirname(resolvedEntry),
      entryPoints: [resolvedEntry],
      bundle: true,
      platform: "node",
      target: "node20",
      format: "cjs",
      write: false,
      external: ["electron"],
      nodePaths: [path.join(path.dirname(resolvedEntry), "node_modules"), paths.appNodeModules],
      plugins: [createAppPackageResolverPlugin(paths.workflowSdkEntry)],
      logLevel: "silent",
    });
    const text = result.outputFiles?.[0]?.text;
    if (!text) {
      throw new WorkflowInstallError("COMPILE_FAILED", "esbuild produced no output");
    }
    return text;
  } catch (err) {
    if (err instanceof WorkflowInstallError) throw err;
    throw new WorkflowInstallError("COMPILE_FAILED", `esbuild failed: ${formatEsbuildError(err)}`);
  }
}

function rendererGlobalName(workflowId: string): string {
  const sanitized = workflowId.replace(/[^A-Za-z0-9_$]/g, "_");
  return `__workflowRenderer_${sanitized || "renderer"}`;
}

/** Compile renderer.tsx into a browser IIFE that registers a React component at load time. */
export async function compileRendererWithEsbuild(
  entry: string,
  workflowId: string,
  registerGlobal = "__workflowRendererRegister",
): Promise<string> {
  const paths = resolveWorkflowCompilerPaths();
  const esbuild = loadEsbuild(paths);
  const globalName = rendererGlobalName(workflowId);
  try {
    const result = await esbuild.build({
      absWorkingDir: path.dirname(entry),
      entryPoints: [entry],
      bundle: true,
      platform: "browser",
      target: "es2020",
      format: "iife",
      globalName,
      write: false,
      jsx: "transform",
      jsxFactory: "React.createElement",
      jsxFragment: "React.Fragment",
      plugins: [createRendererRuntimePlugin()],
      banner: {
        js: "var React = globalThis.__workflowRendererReact;",
      },
      footer: {
        // The IIFE assigns the module namespace to a top-level `var <globalName>`.
        // When this bundle is loaded as an ESM `blob:` module (the renderer's
        // `await import(blobUrl)` path), top-level `var` is MODULE-scoped, not on
        // globalThis — so reading `globalThis[globalName]` returns undefined and
        // nothing registers. Reference the lexical `<globalName>` binding
        // directly (it's in scope here), and fall back to the global for the
        // CJS/script path. Register the component the SDK shape exposes:
        // `default.render` (defineRenderer/defineCommandCenter) or a bare export.
        js: `;(function(){var mod=(typeof ${globalName}!=="undefined"?${globalName}:globalThis.${globalName});var d=mod&&mod.default;var candidate=(d&&d.render)?d.render:(d||(mod&&(mod.Renderer||mod.WsrLiveRenderer||mod.render)));if(typeof globalThis.${registerGlobal}==="function"&&candidate)globalThis.${registerGlobal}(${JSON.stringify(workflowId)},candidate);})();`,
      },
      logLevel: "silent",
    });
    const text = result.outputFiles?.[0]?.text;
    if (!text) {
      throw new WorkflowInstallError("COMPILE_FAILED", "esbuild produced no renderer output");
    }
    return text;
  } catch (err) {
    if (err instanceof WorkflowInstallError) throw err;
    throw new WorkflowInstallError(
      "COMPILE_FAILED",
      `renderer esbuild failed: ${formatEsbuildError(err)}`,
    );
  }
}

/**
 * Compile a workflow-level `command-center.tsx` into a browser IIFE that
 * registers its React component via `__workflowCommandCenterRegister`. Shares
 * the renderer runtime (React injection + SDK stub) so authoring is identical.
 */
export async function compileCommandCenterWithEsbuild(
  entry: string,
  workflowId: string,
): Promise<string> {
  return compileRendererWithEsbuild(entry, workflowId, "__workflowCommandCenterRegister");
}
