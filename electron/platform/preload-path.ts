import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { APP_NAME } from "../../common/marshal-constants";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve a preload script to a real filesystem path in both dev and packaged builds.
 *
 * Preload scripts must live on the real filesystem (not inside the ASAR archive)
 * because Electron requires a concrete file path for BrowserWindow.webPreferences.preload.
 *
 * Resolution order (first existing non-ASAR match wins):
 *  1. resources/<fileName>           — extraResources copy (packaged)
 *  2. resources/app.asar.unpacked/…  — asarUnpack extraction (packaged)
 *  3. dist-electron/<fileName>       — dev mode (vite copies .cjs files here)
 *  4. ../dist-electron/<fileName>    — dev mode fallback
 *
 * Security: we intentionally do NOT fall back to copying preload scripts into
 * user-writable locations (e.g. userData / %APPDATA%). A preload script running
 * in a writable directory could be replaced by an attacker to gain code execution
 * in the BrowserWindow context.
 */
/**
 * Returns true if the path points inside the ASAR archive (not the unpacked directory).
 * `app.asar/file` and `app.asar\file` are inside the archive.
 * `app.asar.unpacked/file` is on the real filesystem and should NOT be rejected.
 *
 * Uses path-segment matching so a fileName containing ".asar.unpacked" can't
 * trick the check into allowing a path that's actually inside the archive.
 */
export function isInsideAsar(filePath: string): boolean {
  // Match ".asar" as a path segment boundary (followed by / or \),
  // but exclude ".asar.unpacked" as a segment.
  return /[\\/]app\.asar[\\/]/.test(filePath) && !/[\\/]app\.asar\.unpacked[\\/]/.test(filePath);
}

export function resolveLooseFilePath(fileName: string): string {
  const candidates = [
    path.join(process.resourcesPath || "", fileName),
    path.join(process.resourcesPath || "", "app.asar.unpacked", "dist-electron", fileName),
    path.join(__dirname, fileName),
    path.join(__dirname, "..", "dist-electron", fileName),
  ];

  const found =
    candidates.find((candidate) => {
      try {
        return !isInsideAsar(candidate) && fs.existsSync(candidate);
      } catch {
        return false;
      }
    }) || "";

  if (found) {
    return found;
  }

  // No trusted candidate found — fail loudly instead of copying to a writable location.
  const tried = candidates.map((c) => `  - ${c}`).join("\n");
  throw new Error(
    `[${APP_NAME}] Could not resolve ${fileName} on the real filesystem.\n` +
      `Tried:\n${tried}\n` +
      `Ensure the file is listed in asarUnpack or extraResources in electron-builder.json5.`,
  );
}
