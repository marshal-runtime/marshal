/**
 * Wire contract + client-side validation for the Lobster Runtime update-check
 * endpoint.
 *
 * The endpoint is unauthenticated, so the client re-pins the download host,
 * enforces https + no-credentials, and verifies SHA-256 when supplied — the
 * pinned code signature (in ../updater) remains the real trust anchor.
 */
import { createHash } from "crypto";
import { createReadStream } from "fs";

import { z } from "zod";

/**
 * Base URL is a COMPILED CONSTANT, never remotely delivered — a config mishap
 * must not be able to brick installs. Empty means no update endpoint is
 * configured: checks report up-to-date without touching the network.
 */
export const UPDATE_ENDPOINT_BASE_URL: string = "";

// Installer download hosts. The private publisher signature pinned in ../updater is the trust anchor; this allowlist
// is defense-in-depth and is intentionally minimal — every entry expands the surface for a
// downloadUrl-injection attack against a tampered manifest, so additions must be tied to a host
// the server actually serves from. Entries with a leading "." match subdomains via suffix; entries
// without it require an exact host match.
const ALLOWED_DOWNLOAD_HOST_SUFFIXES: readonly string[] = [];

export const UpdateCheckResponseSchema = z
  .object({
    upToDate: z.boolean(),
    latestVersion: z.string().regex(/^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/i),
    minimumVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    blocked: z.boolean(),
    channel: z.enum(["stable", "beta"]),
    downloadUrl: z.string().url().optional(),
    assetName: z.string().optional(),
    releaseUrl: z.string().url().optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
  })
  .strip();
export type UpdateCheckResponse = z.infer<typeof UpdateCheckResponseSchema>;

/**
 * True when `urlStr` is an allowed, https, credential-free download URL whose pathname terminates
 * in the supplied `assetName` (when provided).
 *
 * The pathname check defeats a manifest-tampering escalation: a compromised endpoint could pair
 * `assetName: "Marshal-Windows-9.9.9-x64-Setup.exe"` with `downloadUrl: ".../old-1.0.0-Setup.exe"`.
 * Both files can be signed by the same private release identity, so signature verification passes; the user gets a
 * silent version downgrade. Pinning the trailing pathname segment against `assetName` forces them
 * to agree.
 */
export function isDownloadHostAllowed(
  urlStr: string,
  assetName?: string,
  allowedHosts: readonly string[] = ALLOWED_DOWNLOAD_HOST_SUFFIXES,
): boolean {
  const parsed = URL.parse(urlStr);
  if (parsed === null) return false;
  if (parsed.username || parsed.password || parsed.hash) return false;
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  const hostOk = allowedHosts.some((s) => (s.startsWith(".") ? host.endsWith(s) : host === s));
  if (!hostOk) return false;
  if (assetName && !parsed.pathname.endsWith(`/${assetName}`)) return false;
  return true;
}

export function validateEndpointDownloadUrl(
  urlStr: string,
  assetName?: string,
  allowedHosts: readonly string[] = ALLOWED_DOWNLOAD_HOST_SUFFIXES,
): void {
  if (!isDownloadHostAllowed(urlStr, assetName, allowedHosts)) {
    throw new Error(`Refused: downloadUrl is not an allowed https host`);
  }
}

/**
 * Confirm a server-returned `assetName` matches the requesting platform's expected file extension,
 * carries the request's `process.arch` (Mac/Windows), and pins the same `latestVersion` the
 * manifest advertised.
 *
 * Background: the GitHub provider reconstructs the asset name client-side via getAssetName(), so
 * it can never drift from the requesting platform. The decoupled-update provider trusts the
 * server-supplied name, which means a single manifest typo (e.g. an x64 .dmg URL returned to an
 * arm64 request) would pass schema parse + the same-Team-ID signature verify and only surface at
 * relaunch as a "Bad CPU type in executable" crash — far too late to diagnose cleanly. This is the
 * equivalent client-side guard.
 *
 * Substring checks are token-bounded by literal hyphens in the asset-name template (`-${version}-`
 * + `-${arch}-`), so "x64" can't satisfy a request for "arm64" and "1.0.0" can't satisfy
 * "1.0.0.1". Product-name prefix is intentionally NOT pinned because the same provider serves both
 * Marshal-* prod assets and MarshalDev-* dev/staging assets.
 */
export function validateAssetForCurrentPlatform(assetName: string, latestVersion: string): void {
  if (process.platform === "darwin") {
    const needle = `-${latestVersion}-${process.arch}-`;
    if (!assetName.includes(needle) || !assetName.endsWith(".dmg")) {
      throw new Error(
        `Asset name mismatch: expected darwin-${process.arch} v${latestVersion} (…${needle}…*.dmg), got ${assetName}`,
      );
    }
    return;
  }
  if (process.platform === "win32") {
    const needle = `-${latestVersion}-${process.arch}-`;
    if (!assetName.includes(needle) || !assetName.endsWith(".exe")) {
      throw new Error(
        `Asset name mismatch: expected win32-${process.arch} v${latestVersion} (…${needle}…*.exe), got ${assetName}`,
      );
    }
    return;
  }
  if (process.platform === "linux") {
    // Linux asset template is `…-${version}.AppImage` with no arch segment (one binary per arch is
    // shipped via separate manifest cells, not via asset-name disambiguation).
    const needle = `-${latestVersion}.AppImage`;
    if (!assetName.endsWith(needle)) {
      throw new Error(
        `Asset name mismatch: expected linux v${latestVersion} (…${needle}), got ${assetName}`,
      );
    }
    return;
  }
  // No installer pipeline exists for other platforms; nothing useful to check here.
}

/** Stream-hash the staged file and compare to the expected hex digest (case-insensitive). */
export async function verifyDownloadSha256(filePath: string, expected: string): Promise<void> {
  const actual = await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`SHA-256 mismatch (expected ${expected}, got ${actual})`);
  }
}
