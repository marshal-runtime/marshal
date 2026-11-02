import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export interface ClaudeExecutableResolutionOptions {
  isPackaged?: boolean;
  resourcesPath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  existsSync?: (candidate: string) => boolean;
}

function packageName(platform: NodeJS.Platform, arch: string): string {
  if (
    (platform !== "darwin" && platform !== "linux" && platform !== "win32") ||
    (arch !== "arm64" && arch !== "x64")
  ) {
    throw new Error(`Unsupported Claude Agent SDK platform: ${platform}-${arch}`);
  }
  return `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
}

export function resolveInstalledClaudeExecutable(
  options: Pick<ClaudeExecutableResolutionOptions, "platform" | "arch" | "existsSync"> = {},
): string {
  const platform = options.platform ?? process.platform;
  const sdkPackage = packageName(platform, options.arch ?? process.arch);
  const packageJson = createRequire(import.meta.url).resolve(`${sdkPackage}/package.json`);
  const executable = path.join(
    path.dirname(packageJson),
    platform === "win32" ? "claude.exe" : "claude",
  );
  if (!(options.existsSync ?? fs.existsSync)(executable)) {
    throw new Error(`Installed Claude executable not found: ${executable}`);
  }
  return executable;
}

export function resolvePackagedClaudeExecutable(
  options: ClaudeExecutableResolutionOptions = {},
): string | undefined {
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  const isPackaged =
    options.isPackaged ??
    (!process.env.VITE_DEV_SERVER_URL && typeof resourcesPath === "string" && resourcesPath !== "");
  if (!isPackaged) return undefined;
  if (!resourcesPath) {
    throw new Error("Packaged Claude runtime requires process.resourcesPath");
  }

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const sdkPackage = packageName(platform, arch);
  const packageRoot = path.join(resourcesPath, "app.asar.unpacked", "node_modules", sdkPackage);
  const flatExecutable = path.join(packageRoot, platform === "win32" ? "claude.exe" : "claude");
  const candidates =
    platform === "darwin"
      ? [path.join(packageRoot, "claude.app", "Contents", "MacOS", "claude"), flatExecutable]
      : [flatExecutable];
  const existsSync = options.existsSync ?? fs.existsSync;
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    `Packaged Claude executable not found. Searched:\n${candidates
      .map((candidate) => `  - ${candidate}`)
      .join("\n")}`,
  );
}

export function resolveClaudeExecutablePath(
  explicitPath: string | undefined,
  options?: ClaudeExecutableResolutionOptions,
): string | undefined {
  return explicitPath ?? resolvePackagedClaudeExecutable(options);
}
