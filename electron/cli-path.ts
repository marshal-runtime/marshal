import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { createLogger } from "../common/marshal-logger";

const log = createLogger("CliPath");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Get the path to the bundled Copilot CLI for the current platform
 */
export function getBundledCliPath(): string {
  const platform = process.platform;
  const arch = process.arch;

  // Map to package names
  let packageName: string;
  if (platform === "darwin" && arch === "arm64") {
    packageName = "@github/copilot-darwin-arm64";
  } else if (platform === "darwin" && arch === "x64") {
    packageName = "@github/copilot-darwin-x64";
  } else if (platform === "win32" && arch === "x64") {
    packageName = "@github/copilot-win32-x64";
  } else if (platform === "win32" && arch === "arm64") {
    packageName = "@github/copilot-win32-arm64";
  } else if (platform === "linux" && arch === "x64") {
    packageName = "@github/copilot-linux-x64";
  } else if (platform === "linux" && arch === "arm64") {
    packageName = "@github/copilot-linux-arm64";
  } else {
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
  }

  const flatRel = path.join(packageName, "copilot");
  const possiblePaths = [
    // Packaged: standalone binary
    path.join(process.resourcesPath || "", "app.asar.unpacked", "node_modules", flatRel),
    // Dev mode: relative to dist-electron (when __dirname is in dist-electron)
    path.join(__dirname, "..", "node_modules", flatRel),
    // Dev mode alternative: check if we're in the project root
    path.join(process.cwd(), "node_modules", flatRel),
  ];

  // On Windows, append .exe
  const suffix = platform === "win32" ? ".exe" : "";

  for (const basePath of possiblePaths) {
    const fullPath = basePath + suffix;
    // Make sure we're not inside an asar archive (can't execute from there)
    if (fullPath.includes(".asar/") || fullPath.includes(".asar\\")) {
      continue;
    }
    if (fs.existsSync(fullPath)) {
      log.info("Found Copilot CLI at:", fullPath);
      return fullPath;
    }
  }

  throw new Error(
    `Copilot CLI not found. Searched:\n${possiblePaths.map((p) => "  - " + p + suffix).join("\n")}`,
  );
}

/**
 * Try to get a GitHub token from the gh CLI if it's installed and authenticated
 */
export function tryGetGhToken(): string | null {
  try {
    const token = execSync("gh auth token", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (token && (token.startsWith("gho_") || token.startsWith("ghp_"))) {
      log.info("Found existing gh CLI token");
      return token;
    }
    return null;
  } catch {
    // gh not installed or not authenticated
    return null;
  }
}
