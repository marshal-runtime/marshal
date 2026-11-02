/**
 * In-app updater install path: asset-name validation, code-signature
 * verification and the platform-specific install (DMG/NSIS). Checking and
 * downloading live in the update provider (electron/updater/endpoint-provider.ts).
 */

import { execFileSync } from "child_process";
import { existsSync, readdirSync, rmSync } from "fs";
import { platform, tmpdir } from "os";
import { join, resolve as resolvePath, sep } from "path";

import { createLogger } from "../common/marshal-logger";
import { makeUpdaterError, updaterErrors } from "../common/telemetry/errors/marshal-index";
import { sendErrorTelemetry } from "./telemetry-errors";
import { spawnUpdateProgress } from "./update-progress";

export class UpdaterError extends Error {
  constructor(
    public readonly code: "auth" | "not-found" | "rate-limit" | "api" | "signature",
    message: string,
    public readonly ssoUrl?: string,
  ) {
    super(message);
    this.name = "UpdaterError";
  }
}

export type UpdateChannel = "stable" | "beta";

const IS_WINDOWS = platform() === "win32";
const IS_MAC = platform() === "darwin";

// Build-time pins for the privately owned release identities. Subject-prefix
// and Apple Team ID verification survive certificate renewal while rejecting a
// validly signed installer from another publisher.
const EXPECTED_MAC_TEAM_ID =
  typeof __EXPECTED_MACOS_TEAM_ID__ === "string"
    ? __EXPECTED_MACOS_TEAM_ID__
    : "UNCONFIGURED_MACOS_TEAM";
const EXPECTED_WINDOWS_PUBLISHER =
  typeof __EXPECTED_WINDOWS_SIGNER_SUBJECT__ === "string"
    ? __EXPECTED_WINDOWS_SIGNER_SUBJECT__
    : "UNCONFIGURED_WINDOWS_SIGNER";
const EXPECTED_MAC_TEAM_IDS = [EXPECTED_MAC_TEAM_ID];
const EXPECTED_WINDOWS_PUBLISHERS = [EXPECTED_WINDOWS_PUBLISHER];
const log = createLogger("Updater");

/**
 * Reject any assetName that is not a flat filename inside the update temp dir.
 * Path separators, parent-directory refs, absolute paths, and null bytes would
 * let a renderer-compromised caller write anywhere the user-mode process can
 * reach (e.g. %APPDATA%\…\Startup\p.exe).
 */
export function validateAssetName(assetName: string): string {
  if (
    assetName === "" ||
    assetName === "." ||
    assetName === ".." ||
    assetName.includes("/") ||
    assetName.includes("\\") ||
    assetName.includes("\0") ||
    // Windows NTFS Alternate Data Streams: `Setup.exe:Zone.Identifier` stays
    // inside the download dir but lets a compromised renderer strip / forge
    // the mark-of-the-web on the installer. `:` is also illegal in filenames
    // on Windows for any other use.
    assetName.includes(":")
  ) {
    throw new Error(
      `Refused: assetName must be a flat filename (got: ${JSON.stringify(assetName)})`,
    );
  }
  const downloadDir = resolvePath(join(tmpdir(), "marshal-update"));
  const resolved = resolvePath(downloadDir, assetName);
  // Both sides come from the same tmpdir() + path.resolve, so case and
  // separators are guaranteed consistent — no .toLowerCase() needed.
  if (!resolved.startsWith(downloadDir + sep)) {
    throw new Error(`Refused: assetName escapes download dir`);
  }
  return resolved;
}

/**
 * Install a downloaded update.
 * macOS: mount DMG, verify code signature, copy .app to /Applications, unmount
 * Windows: verify Authenticode signature, queue NSIS installer for restart
 */
export async function installUpdate(filePath: string): Promise<void> {
  validateUpdatePath(filePath);
  try {
    if (IS_MAC) {
      await installMacDMG(filePath);
    } else if (IS_WINDOWS) {
      await installWindowsNSIS(filePath);
    } else {
      throw new Error(`Unsupported platform: ${platform()}`);
    }
  } catch (err) {
    // Single point of INSTALL_FAILED telemetry. Skip when the cause is a
    // signature failure — `verifyMacSignature` / `verifyWindowsSignature`
    // emit SIGNATURE_VERIFY_FAILED themselves before throwing UpdaterError
    // with code "signature", and dual-emission would double-count.
    if (!(err instanceof UpdaterError && err.code === "signature")) {
      sendErrorTelemetry(makeUpdaterError(updaterErrors.INSTALL_FAILED), err);
    }
    throw err;
  }
}

async function installMacDMG(dmgPath: string): Promise<void> {
  log.info("Mounting DMG...");
  const mountOutput = execFileSync(
    "hdiutil",
    ["attach", dmgPath, "-nobrowse", "-noverify", "-readonly", "-plist"],
    {
      encoding: "utf-8",
    },
  );

  // Parse mount point from plist output
  const mountPointMatch = mountOutput.match(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/);
  if (!mountPointMatch) throw new Error("Failed to parse DMG mount point");
  const mountPoint = mountPointMatch[1];

  try {
    // Find .app in mount point
    const entries = readdirSync(mountPoint);
    const appName = entries.find((e) => e.endsWith(".app"));
    if (!appName) throw new Error(`No .app found in DMG at ${mountPoint}`);

    const srcApp = join(mountPoint, appName);

    // Verify code signature before copying to /Applications
    verifyMacSignature(srcApp);

    const destApp = join("/Applications", appName);

    log.info(`Copying ${appName} to /Applications...`);
    // Remove existing app first to avoid merge issues
    if (existsSync(destApp)) {
      rmSync(destApp, { recursive: true, force: true });
    }
    execFileSync("cp", ["-R", srcApp, "/Applications/"], { stdio: "pipe" });

    // Gatekeeper validates the signed app — no need to strip quarantine

    log.info("Installation complete");
  } finally {
    // Always unmount
    try {
      execFileSync("hdiutil", ["detach", mountPoint, "-quiet"], { stdio: "pipe" });
    } catch {
      /* best effort */
    }
  }

  // Clean up DMG
  try {
    rmSync(dmgPath);
  } catch {
    /* best effort */
  }
}

async function installWindowsNSIS(exePath: string): Promise<void> {
  // On Windows, the installer can't overwrite locked files while Marshal is running.
  // We validate the file exists and verify its Authenticode signature — actual install happens at restart.
  if (!existsSync(exePath)) throw new Error(`Installer not found: ${exePath}`);
  verifyWindowsSignature(exePath);
  log.info("Windows installer ready — will run on restart");
}

// --- Signature verification ---

/** Verify macOS code signature using codesign. Throws UpdaterError on failure. */
export function verifyMacSignature(appPath: string): void {
  log.info(`Verifying code signature: ${appPath}`);
  try {
    const teamRequirement = EXPECTED_MAC_TEAM_IDS.map(
      (teamId) => `certificate leaf[subject.OU] = "${teamId}"`,
    ).join(" or ");
    execFileSync(
      "codesign",
      [
        "--verify",
        "--deep",
        "--strict",
        "-R",
        // The leading "=" tells `codesign -R` the argument is a literal
        // requirement string, not a path to a requirement file. Without it,
        // codesign open(2)s the requirement text as a file and aborts with
        // "No such file or directory / invalid requirement specification"
        // before ever inspecting the signature.
        `=anchor apple generic and (${teamRequirement})`,
        appPath,
      ],
      { stdio: "pipe" },
    );
  } catch (err) {
    const stderr = err instanceof Error && "stderr" in err ? String(err.stderr) : String(err);
    const wrapped = new UpdaterError(
      "signature",
      `Code signature verification failed for ${appPath}: ${stderr}`,
    );
    sendErrorTelemetry(makeUpdaterError(updaterErrors.SIGNATURE_VERIFY_FAILED), wrapped);
    throw wrapped;
  }
  log.info("Code signature verified");
}

/** Verify Windows Authenticode signature using PowerShell. Throws UpdaterError on failure. */
export function verifyWindowsSignature(exePath: string): void {
  log.info(`Verifying Authenticode signature: ${exePath}`);
  try {
    // PowerShell single-quoted strings are literal — no $ or backtick
    // expansion — so escaping embedded single quotes (PS convention: '')
    // is sufficient. The path is already constrained to <tmp>/marshal-update/*.exe
    // by validateUpdatePath, so attacker-controlled metacharacters can't
    // reach here, but the escape is defensive in depth.
    const safePath = exePath.replace(/'/g, "''");
    const publisherChecks = EXPECTED_WINDOWS_PUBLISHERS.map((publisher) => {
      const safePublisher = publisher.replace(/'/g, "''");
      return `$sig.SignerCertificate.Subject.StartsWith('${safePublisher}', [System.StringComparison]::OrdinalIgnoreCase)`;
    }).join(" -or ");
    const psCommand =
      `$sig = Get-AuthenticodeSignature '${safePath}'; ` +
      `if ($sig.Status -ne 'Valid') { Write-Error "Signature status: $($sig.Status)"; exit 1 } ` +
      `if (-not (${publisherChecks})) { ` +
      `Write-Error "Signature publisher mismatch: $($sig.SignerCertificate.Subject)"; exit 1 }`;
    // Pin PSModulePath to the Windows PowerShell 5.1 system dirs. powershell.exe must autoload
    // Microsoft.PowerShell.Security to resolve Get-AuthenticodeSignature; on machines that also
    // have PowerShell 7 installed, an inherited PSModulePath orders PS7's module dirs first, and
    // autoload picks the PS7 .psd1 which then fails to load under PS5 (TypeData conflict). The
    // same pin is applied in the post-exit bat script's re-verify step — see update-progress.ts.
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const pinnedPSModulePath = [
      `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\Modules`,
      `${programFiles}\\WindowsPowerShell\\Modules`,
    ].join(";");
    const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", psCommand], {
      encoding: "utf-8",
      stdio: "pipe",
      env: { ...process.env, PSModulePath: pinnedPSModulePath },
    });
    log.info("Authenticode signature verified", output.trim());
  } catch (err) {
    const stderr = err instanceof Error && "stderr" in err ? String(err.stderr) : String(err);
    const wrapped = new UpdaterError(
      "signature",
      `Authenticode signature verification failed for ${exePath}: ${stderr}`,
    );
    sendErrorTelemetry(makeUpdaterError(updaterErrors.SIGNATURE_VERIFY_FAILED), wrapped);
    throw wrapped;
  }
}

// --- Helpers ---

export function getAssetName(version: string, archOverride?: string): string {
  const a = archOverride ?? process.arch;
  if (IS_MAC) return `Marshal-Mac-${version}-${a}-Installer.dmg`;
  if (IS_WINDOWS) return `Marshal-Windows-${version}-${a}-Setup.exe`;
  return `Marshal-Linux-${version}.AppImage`;
}

/** Compare semver strings. Returns true if remote is newer than local. */
export function isNewer(remote: string, local: string): boolean {
  const r = remote.split(".").map(Number);
  const l = local.split(".").map(Number);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const rv = r[i] || 0;
    const lv = l[i] || 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

/** Validate that a file path is in the expected update temp directory */
export function validateUpdatePath(filePath: string): void {
  const expectedDir = join(tmpdir(), "marshal-update") + sep;
  const resolved = join(filePath); // normalize
  // Windows filesystem is case-insensitive; tmpdir() may return canonical
  // casing while the staged path picks up different casing (8.3 short-name
  // expansion, USERPROFILE differences). Compare lowercased on Windows to
  // avoid rejecting legitimate updates.
  const prefixMatches = IS_WINDOWS
    ? resolved.toLowerCase().startsWith(expectedDir.toLowerCase())
    : resolved.startsWith(expectedDir);
  if (!prefixMatches) {
    throw new Error(`Invalid update path: ${filePath} (expected in ${expectedDir})`);
  }
  const ext = IS_MAC ? ".dmg" : IS_WINDOWS ? ".exe" : ".AppImage";
  if (!resolved.endsWith(ext)) {
    throw new Error(`Invalid update file extension: expected ${ext}`);
  }
}

/**
 * Validate the staged path, verify the Authenticode signature against the
 * pinned publisher, then launch the installer. Single chokepoint for invoking
 * the downloaded binary on Windows. The oxlint no-restricted-imports rule on
 * "./update-progress" ensures no other call site can reach spawnUpdateProgress
 * directly.
 *
 * macOS does NOT route through this function — signature verification runs
 * during installMacDMG() at install time, before the .app is copied to
 * /Applications. The Windows install flow is asymmetric because NSIS can't
 * overwrite locked files while Marshal is running, so verification has to
 * happen at restart-time instead.
 */
export async function verifyAndLaunch(installerPath: string, appExePath: string): Promise<void> {
  if (!IS_WINDOWS) {
    throw new UpdaterError("signature", `verifyAndLaunch is Windows-only; called on ${platform()}`);
  }
  validateUpdatePath(installerPath);
  verifyWindowsSignature(installerPath);
  // The boolean return (ready-signal received within 10s) is intentionally
  // discarded — matches the pre-existing call site behavior in update-ipc.ts.
  // Timeout handling is a separate concern tracked outside this PR.
  await spawnUpdateProgress(installerPath, appExePath);
}
