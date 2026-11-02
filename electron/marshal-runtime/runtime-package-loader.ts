import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { writeProcessLifecycleEventSync } from "../process-lifecycle-diagnostics";
import type { MarshalRuntimeModule, MarshalRuntimePackageMetadata } from "./contracts";
import { resolveLocalMarshalRuntimeSource, type MarshalRuntimeProcessEnv } from "./local-source";
import { MARSHAL_RUNTIME_PACKAGE_PIN } from "./runtime-package-pin.generated";

const RUNTIME_PACKAGE_NAME = "@marshal/runtime";
const RUNTIME_ENTRYPOINT = "dist/host.js";

export type RuntimePackageLoadErrorCode =
  | "package-missing"
  | "invalid-package-manifest"
  | "entrypoint-missing"
  | "module-load-failed"
  | "invalid-runtime-module";

export class RuntimePackageLoadError extends Error {
  constructor(
    readonly code: RuntimePackageLoadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RuntimePackageLoadError";
  }
}

export interface RuntimePackageLocation {
  readonly isPackaged: boolean;
  readonly appPath: string;
  readonly resourcesPath: string;
}

export interface MarshalRuntimePackageLoader {
  load(): Promise<MarshalRuntimeModule>;
  metadata(): MarshalRuntimePackageMetadata;
}

interface RuntimePackageManifest {
  readonly name: string;
  readonly version: string;
}

export function runtimeNodeModulesRoot(location: RuntimePackageLocation): string {
  return location.isPackaged
    ? path.join(location.resourcesPath, "app.asar.unpacked", "node_modules")
    : path.join(location.appPath, "node_modules");
}

function readManifest(filePath: string): RuntimePackageManifest {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    throw new RuntimePackageLoadError(
      "invalid-package-manifest",
      "The Marshal Runtime package manifest could not be read.",
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Reflect.get(value, "name") !== RUNTIME_PACKAGE_NAME ||
    typeof Reflect.get(value, "version") !== "string" ||
    !Reflect.get(value, "version").trim()
  ) {
    throw new RuntimePackageLoadError(
      "invalid-package-manifest",
      "The Marshal Runtime package manifest is invalid.",
    );
  }
  return {
    name: RUNTIME_PACKAGE_NAME,
    version: Reflect.get(value, "version"),
  };
}

function isMarshalRuntimeModule(value: unknown): value is MarshalRuntimeModule {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "createAgentRuntime") === "function" &&
    typeof Reflect.get(value, "createRuntimeBuiltinsSource") === "function" &&
    typeof Reflect.get(value, "createRuntimeNativeExtensionDiscoveryService") === "function"
  );
}

interface ResolvedRuntimePackage {
  readonly entryPath: string;
  readonly metadata: MarshalRuntimePackageMetadata;
  readonly localSource: boolean;
}

export class PinnedMarshalRuntimePackageLoader implements MarshalRuntimePackageLoader {
  private loading: Promise<MarshalRuntimeModule> | null = null;
  private resolvedPackage: ResolvedRuntimePackage | null = null;

  constructor(
    private readonly options: {
      readonly location: RuntimePackageLocation;
      readonly env?: MarshalRuntimeProcessEnv;
      readonly importModule?: (url: string) => Promise<unknown>;
      readonly diagnostics?: (event: string, details: Readonly<Record<string, unknown>>) => void;
    },
  ) {}

  load(): Promise<MarshalRuntimeModule> {
    this.loading ??= this.loadOnce();
    return this.loading;
  }

  metadata(): MarshalRuntimePackageMetadata {
    return this.resolvePackage().metadata;
  }

  private async loadOnce(): Promise<MarshalRuntimeModule> {
    const emitDiagnostic = this.options.diagnostics ?? writeProcessLifecycleEventSync;
    const { entryPath, metadata, localSource } = this.resolvePackage();
    emitDiagnostic("marshal-runtime.module.loading", {
      name: metadata.name,
      modulePath: relativeToRuntimeBase(this.options.location, entryPath),
      localSource,
    });

    let moduleExports: unknown;
    try {
      moduleExports = await (
        this.options.importModule ?? ((url) => import(/* @vite-ignore */ url))
      )(pathToFileURL(entryPath).href);
    } catch {
      throw new RuntimePackageLoadError(
        "module-load-failed",
        "The @marshal/runtime module could not be loaded.",
      );
    }
    if (!isMarshalRuntimeModule(moduleExports)) {
      throw new RuntimePackageLoadError(
        "invalid-runtime-module",
        "The @marshal/runtime module does not export the required host factories.",
      );
    }
    emitDiagnostic("marshal-runtime.module.loaded", {
      name: metadata.name,
      modulePath: relativeToRuntimeBase(this.options.location, entryPath),
    });
    return moduleExports;
  }

  private resolvePackage(): ResolvedRuntimePackage {
    if (this.resolvedPackage) return this.resolvedPackage;

    const localSource = resolveLocalMarshalRuntimeSource(
      this.options.location,
      this.options.env ?? process.env,
    );
    let packageRoot: string;
    if (localSource) {
      try {
        packageRoot = fs.realpathSync(localSource.packageRoot);
      } catch {
        throw new RuntimePackageLoadError(
          "package-missing",
          "The local @marshal/runtime package is unavailable.",
        );
      }
    } else {
      const declaredPackageRoot = path.join(
        runtimeNodeModulesRoot(this.options.location),
        ...RUNTIME_PACKAGE_NAME.split("/"),
      );
      try {
        packageRoot = fs.realpathSync(declaredPackageRoot);
      } catch {
        throw new RuntimePackageLoadError(
          "package-missing",
          "The @marshal/runtime package is unavailable.",
        );
      }
    }

    const manifest = readManifest(path.join(packageRoot, "package.json"));
    let entryPath: string;
    try {
      entryPath = fs.realpathSync(path.join(packageRoot, RUNTIME_ENTRYPOINT));
      if (!fs.statSync(entryPath).isFile()) throw new Error("Runtime entrypoint is not a file.");
    } catch {
      throw new RuntimePackageLoadError(
        "entrypoint-missing",
        localSource
          ? `The local @marshal/runtime entrypoint is missing. Build the Runtime workspace at ${localSource.root}.`
          : "The @marshal/runtime entrypoint is unavailable or is not a file.",
      );
    }

    this.resolvedPackage = Object.freeze({
      entryPath,
      localSource: Boolean(localSource),
      metadata: Object.freeze({
        name: RUNTIME_PACKAGE_NAME,
        version: manifest.version,
        entrypoint: RUNTIME_ENTRYPOINT,
        entrySha256: localSource
          ? createHash("sha256").update(fs.readFileSync(entryPath)).digest("hex")
          : MARSHAL_RUNTIME_PACKAGE_PIN.entrySha256,
      }),
    });
    return this.resolvedPackage;
  }
}

function relativeToRuntimeBase(location: RuntimePackageLocation, target: string): string {
  const base = location.isPackaged ? location.resourcesPath : location.appPath;
  return path.relative(base, target).split(path.sep).join("/");
}
