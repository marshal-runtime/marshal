import path from "node:path";

import type { RuntimeCompositionRegistry } from "@marshal/runtime";
import {
  computeRuntimeExtensionIntegrity,
  type LoadedRuntimeExtensionPackage,
  type RuntimeExtensionConfiguration,
  type RuntimeExtensionInstallRequest,
  type RuntimeExtensionPackageLoader,
} from "@marshal/runtime/extensions";

import {
  adaptOverlayReviewExtensionPackage,
  type OverlayReviewPackageHost,
} from "../overlay-review";
import { adaptAgenticBrowserExtensionPackage } from "./agentic-browser-runtime-host";
import { adaptAgenticDebuggerExtensionPackage } from "./agentic-debugger-runtime-host";
import { runtimeNodeModulesRoot, type RuntimePackageLocation } from "./runtime-package-loader";

const INTEGRITY_DOMAIN = "marshal-runtime-extension-package-v1";

export interface FirstPartyExtensionCatalogManifestEntry {
  readonly identity: string;
  readonly version: string;
  readonly packageName: string;
  readonly bundledLocation: readonly string[];
  readonly hostComposition?: "agentic-debugger-host-adapter";
  readonly integrity: {
    readonly algorithm: "sha256";
    readonly domain: typeof INTEGRITY_DOMAIN;
    readonly value: string;
  };
}

export interface ResolvedFirstPartyExtension {
  readonly identity: string;
  readonly version: string;
  readonly request: RuntimeExtensionInstallRequest;
  readonly configuration?: RuntimeExtensionConfiguration;
  readonly hostComposition?: FirstPartyExtensionCatalogManifestEntry["hostComposition"];
}

/**
 * The single source of truth for extensions shipped with Marshal. Entries are
 * immutable release data: identity, version, package location, and package
 * integrity all change together when a bundled archive is refreshed.
 */
export const FIRST_PARTY_EXTENSION_CATALOG: readonly FirstPartyExtensionCatalogManifestEntry[] =
  Object.freeze([
    Object.freeze({
      identity: "@agentic-browser/automation-extension",
      version: "0.1.0",
      packageName: "@agentic-browser/automation-extension",
      bundledLocation: Object.freeze(["@agentic-browser", "automation-extension"]),
      integrity: Object.freeze({
        algorithm: "sha256" as const,
        domain: INTEGRITY_DOMAIN,
        value: "075ab45eb5d160a355cd804c2afb9da61a76bb247b65884105d35ce809692421",
      }),
    }),
    Object.freeze({
      identity: "@agentic-browser/marshal-runtime-extension",
      version: "0.1.0",
      packageName: "@agentic-browser/marshal-runtime-extension",
      bundledLocation: Object.freeze(["@agentic-browser", "marshal-runtime-extension"]),
      integrity: Object.freeze({
        algorithm: "sha256" as const,
        domain: INTEGRITY_DOMAIN,
        value: "3b1933539519157d07a00ea7f042435f2e1ff654ea4c3ab303a9e728a0a7ac1d",
      }),
    }),
    Object.freeze({
      identity: "@marshal/agentic-debugger-extension",
      version: "1.0.0",
      packageName: "@marshal/agentic-debugger-extension",
      bundledLocation: Object.freeze(["@marshal", "agentic-debugger-extension"]),
      hostComposition: "agentic-debugger-host-adapter" as const,
      integrity: Object.freeze({
        algorithm: "sha256" as const,
        domain: INTEGRITY_DOMAIN,
        value: "957c338554af1c4c1aa86d2fede7fcc88fbe19f433d4d54ce0eb7ff177487189",
      }),
    }),
    Object.freeze({
      identity: "@marshal/swarm",
      version: "0.1.0",
      packageName: "@marshal/swarm",
      bundledLocation: Object.freeze(["@marshal", "swarm"]),
      integrity: Object.freeze({
        algorithm: "sha256" as const,
        domain: INTEGRITY_DOMAIN,
        value: "77a4795d80e95c859ff8f790b4034723c759765aae41cf1523bae0cdf37e3ce5",
      }),
    }),
    Object.freeze({
      identity: "@marshal/overlay-review",
      version: "0.1.0",
      packageName: "@marshal/overlay-review",
      bundledLocation: Object.freeze(["@marshal", "overlay-review"]),
      integrity: Object.freeze({
        algorithm: "sha256" as const,
        domain: INTEGRITY_DOMAIN,
        value: "16dd029c7aa33e84bb42fd0717c3c9c3eee691d9b72447f71d0be3ed4dbddf7a",
      }),
    }),
  ]);

export function resolveFirstPartyExtensionCatalog(options: {
  readonly location: RuntimePackageLocation;
  readonly runsDirectory: string;
}): readonly ResolvedFirstPartyExtension[] {
  if (!path.isAbsolute(options.runsDirectory)) {
    throw new Error("The first-party extension runs directory must be absolute.");
  }
  const nodeModulesRoot = runtimeNodeModulesRoot(options.location);
  return FIRST_PARTY_EXTENSION_CATALOG.map((entry) => {
    const packageRoot = path.join(nodeModulesRoot, ...entry.bundledLocation);
    const actual = computeRuntimeExtensionIntegrity(packageRoot);
    if (
      actual.algorithm !== entry.integrity.algorithm ||
      actual.domain !== entry.integrity.domain ||
      actual.value !== entry.integrity.value
    ) {
      throw new Error(
        `Bundled first-party extension ${entry.identity} failed integrity validation.`,
      );
    }
    return Object.freeze({
      identity: entry.identity,
      version: entry.version,
      request: Object.freeze({ packageRoot, integrity: entry.integrity }),
      ...(entry.hostComposition ? { hostComposition: entry.hostComposition } : {}),
      ...(entry.identity === "@marshal/swarm"
        ? { configuration: Object.freeze({ runsDirectory: options.runsDirectory }) }
        : {}),
    });
  });
}

type PackageAdapter = (
  loaded: LoadedRuntimeExtensionPackage,
) => LoadedRuntimeExtensionPackage | Promise<LoadedRuntimeExtensionPackage>;

/** Applies catalog-declared host bridges without adding identity branches to the host. */
export function createFirstPartyExtensionPackageLoader(options: {
  readonly loader: RuntimeExtensionPackageLoader;
  readonly compositionRegistry: RuntimeCompositionRegistry;
  readonly overlayReview?: OverlayReviewPackageHost;
}): RuntimeExtensionPackageLoader {
  const adapters = new Map<string, PackageAdapter>([
    ["@agentic-browser/marshal-runtime-extension", adaptAgenticBrowserExtensionPackage],
    [
      "@marshal/agentic-debugger-extension",
      (loaded) => adaptAgenticDebuggerExtensionPackage(loaded, options.compositionRegistry),
    ],
    ...(options.overlayReview
      ? ([
          [
            "@marshal/overlay-review",
            (loaded: LoadedRuntimeExtensionPackage) =>
              adaptOverlayReviewExtensionPackage(loaded, options.overlayReview!),
          ],
        ] as const)
      : []),
  ]);
  return {
    async load(request, signal) {
      const loaded = await options.loader.load(request, signal);
      const adapter = adapters.get(loaded.metadata.manifest.identity);
      return adapter ? adapter(loaded) : loaded;
    },
  };
}
