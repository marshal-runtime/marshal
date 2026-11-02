import type { MidgardError, TelemetryCallbacks } from "../types";
import { defineFamily } from "./marshal-define-family";

// Persisted local telemetry family name; keep stable for historical log analysis.
const family = defineFamily("marshal-updater");

// APPEND-ONLY. Existing enum values are stable persisted codes. Never reorder,
// renumber, or delete members; renaming is safe because the numeric code stays.
//
// Code 0 was intentionally left as a generic catch-all for the rare branch
// where the failure isn't yet classified; production paths must prefer a
// specific code so local event slices stay meaningful.
export enum updaterErrors {
  // -- Manifest fetch (update-check endpoint) --
  /** AbortSignal.timeout fired before headers arrived. */
  MANIFEST_TIMEOUT,
  /** fetch() rejected: DNS, TLS, connection refused. NOT a server-side response. */
  MANIFEST_NETWORK_ERROR,
  /** Server returned 5xx, or any other non-2xx that isn't 400/404. */
  MANIFEST_SERVER_ERROR,
  /** Server returned 400 — request params rejected (config bug; repeats every check). */
  MANIFEST_BAD_REQUEST,
  /** Response parsed as JSON but failed zod schema validation. */
  MANIFEST_SCHEMA_INVALID,
  // -- Pre-download validation --
  /** Cross-platform asset name guard rejected what the server claimed. */
  ASSET_NAME_REJECTED,
  /** Download URL host not on the allowlist (security event). */
  DOWNLOAD_HOST_REJECTED,
  // -- Asset download --
  /**
   * AbortController fired — either the 2-minute per-chunk stall timeout or the
   * 10-minute overall ceiling. Don't split these; the paired diagnostic log
   * line already carries elapsed-ms for local forensics.
   */
  DOWNLOAD_TIMEOUT,
  /** Server returned non-2xx for the asset download (or 302 to a rejected host). */
  DOWNLOAD_RESPONSE_FAILED,
  /** Reader threw mid-stream — network drop, server reset, disk write failed. */
  DOWNLOAD_STREAM_FAILED,
  /** Downloaded bytes don't match the catalog's sha256 (security event). */
  DOWNLOAD_SHA256_MISMATCH,
  // -- Install --
  /** Authenticode / codesign rejected the installer (security event). */
  SIGNATURE_VERIFY_FAILED,
  /** NSIS exited non-zero / hdiutil failed / .app copy failed. */
  INSTALL_FAILED,
  // -- Auxiliary --
  /**
   * Periodic GitHub-provider beta-status probe failed. GitHub-only by design —
   * the endpoint update provider has no Beta channel and short-circuits before
   * this can fire.
   */
  GITHUB_BETA_REFRESH_FAILED,
}

export function makeUpdaterError(code: updaterErrors): MidgardError {
  return { family, code };
}

export function registerUpdaterErrors(callbacks: TelemetryCallbacks): void {
  callbacks.registerErrors(family, updaterErrors);
}
