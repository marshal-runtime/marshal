/**
 * EndpointUpdateProvider — consumes the configured update-check endpoint
 * (UPDATE_ENDPOINT_BASE_URL; empty disables checks). Unauthenticated; the server does platform/arch selection + version
 * comparison and returns one flat response covering check + force-update + beta.
 * One cached GET (5-min TTL = the response's max-age) serves all three reads.
 *
 * Signature verification (the trust anchor) and the install path are UNCHANGED and
 * reused from ../updater. This provider only adds the endpoint call, a download-host
 * allowlist, and SHA-256 integrity.
 */
import { createWriteStream, existsSync, mkdirSync, rmSync } from "fs";
import { dirname } from "path";

import { APP_NAME } from "../../common/marshal-constants";
import { createLogger } from "../../common/marshal-logger";
import { makeUpdaterError, updaterErrors } from "../../common/telemetry/errors/marshal-index";
import { getNetFetch } from "../marshal-net-fetch";
import type {
  IUpdateProvider,
  MinimumVersionResult,
  UpdateChannel,
  UpdateCheckResult,
} from "../platform/updates/ports";
import { sendErrorTelemetry } from "../telemetry-errors";
import { UpdaterError, isNewer, validateAssetName } from "../updater";
import {
  UPDATE_ENDPOINT_BASE_URL,
  UpdateCheckResponseSchema,
  validateAssetForCurrentPlatform,
  validateEndpointDownloadUrl,
  verifyDownloadSha256,
  type UpdateCheckResponse,
} from "./update-check-schema";

// `{ timestamps: true }` adds `[HH:MM:SS.mmm]` prefixes to console output for
// this tag and any child loggers. Updater failures are usually diagnosed from
// disk logs after the fact, where stalled-vs-failed-vs-slow is impossible to
// distinguish without timestamps interleaved with other tags' output.
const log = createLogger("UpdaterEndpoint", { timestamps: true });
const fetchImpl = getNetFetch();
const UA = `${APP_NAME}-App-Updater`;

// Threshold for "this took a suspicious amount of time" warn in fetchResponse.
// 15s is the AbortSignal.timeout deadline below; anything past 10s is worth a
// row in the log without being a failure.
const MANIFEST_SLOW_THRESHOLD_MS = 10_000;

// Asset-download timeouts. The Mac coworker incident in May 2026 surfaced a
// download that completed in the UI but produced no actionable signal at the
// failure points; the previous design had no AbortSignal at all on the asset
// fetch because the natural fixed-deadline timeout (e.g., 15 s) would kill a
// real-world 100 MB install on corp VPN / cold CDN edge.
//
// The two-tier design splits "is the socket dead" from "is this download
// pathologically long":
//   * STALL: 2 min of zero bytes received → abort. Slow-but-working
//     downloads aren't punished; truly hung sockets do not wait forever.
//   * CEILING: 10 min overall → abort. Even an extremely slow but live
//     connection is cut off so the renderer's spinner can't be stuck for
//     hours. A 200 MB installer at 300 KB/s finishes in ~11 min — pick a
//     ceiling that comfortably covers real-world worst-case but stops
//     runaway streams.
//
// No automatic in-process retry: the user retries via the existing
// "Download & Install" action in the global notice rail. The previous spike's
// auto-retry was dropped after review (silent retries hide real outages).
const DOWNLOAD_STALL_TIMEOUT_MS = 2 * 60 * 1000;
const DOWNLOAD_OVERALL_TIMEOUT_MS = 10 * 60 * 1000;

// Module-level so the per-invocation provider instances (selectUpdateProvider() builds a fresh
// one per IPC call) share the last check response — this lets downloadUpdate recover the sha256
// from the preceding check without round-tripping the hash through the renderer.
let endpointCache: { key: string; at: number; resp: UpdateCheckResponse | "notfound" } | null =
  null;
const CACHE_TTL_MS = 5 * 60 * 1000; // matches the endpoint's Cache-Control max-age

/**
 * Hostname + pathname only — strips the query string (which carries version,
 * platform, arch) so logs are URL-safe. We log those dimensions explicitly
 * elsewhere; the URL label is just for visual orientation in disk logs.
 */
function urlLabel(u: string): string {
  try {
    const parsed = new URL(u);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return u.substring(0, 80);
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

export class EndpointUpdateProvider implements IUpdateProvider {
  readonly origin = "endpoint" as const;

  async authenticate(_opts: {
    onDeviceCode?: (info: { userCode: string; verificationUri: string }) => void;
  }): Promise<{ ok: true }> {
    // No-op: the endpoint path is unauthenticated. Implemented for IUpdateProvider symmetry.
    return { ok: true };
  }

  /**
   * `op` distinguishes the operator-visible code path. `checkMinimumVersion`
   * fails open by catching everything and returning safe defaults; if it
   * fires telemetry the dashboard inflates with non-user-visible failures
   * (this runs on a 4-hour cadence). Pass `op="minimumVersion"` to silence
   * telemetry while still emitting console + disk logs for forensics.
   */
  private async fetchResponse(
    version: string,
    channel: UpdateChannel,
    op: "check" | "minimumVersion",
  ): Promise<UpdateCheckResponse | "notfound"> {
    if (!UPDATE_ENDPOINT_BASE_URL) {
      log.info(`no update endpoint configured (${op}); treating as up-to-date`);
      return "notfound";
    }
    const key = `${version}|${channel}`;
    const cached = endpointCache;
    if (cached && cached.key === key && Date.now() - cached.at < CACHE_TTL_MS) {
      log.info(
        `manifest cache hit (${op}, platform=${process.platform}, arch=${process.arch}, version=${version}, channel=${channel}, age=${Date.now() - cached.at}ms)`,
      );
      return cached.resp;
    }
    const base = UPDATE_ENDPOINT_BASE_URL;
    // The endpoint rejects non-numeric prerelease versions; send dotted-numeric only.
    const numericVersion = version.replace(/-.*$/, "");
    const url =
      `${base}/v1/marshal/updates/check` +
      `?platform=${encodeURIComponent(process.platform)}` +
      `&arch=${encodeURIComponent(process.arch)}` +
      `&version=${encodeURIComponent(numericVersion)}` +
      `&channel=${encodeURIComponent(channel)}`;
    log.info(
      `manifest check → ${urlLabel(url)} starting (${op}, platform=${process.platform}, arch=${process.arch}, version=${numericVersion}, channel=${channel})`,
    );
    const startMs = Date.now();
    let resp: Response;
    try {
      resp = await fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": UA },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      const elapsed = Date.now() - startMs;
      const timedOut = isAbortError(err);
      log.error(
        `🔴 manifest check ${timedOut ? "TIMED OUT" : "FAILED"} after ${elapsed}ms (${op}):`,
        err,
      );
      if (op === "check") {
        sendErrorTelemetry(
          makeUpdaterError(
            timedOut ? updaterErrors.MANIFEST_TIMEOUT : updaterErrors.MANIFEST_NETWORK_ERROR,
          ),
          err,
        );
      }
      throw err;
    }
    const elapsed = Date.now() - startMs;
    if (elapsed > MANIFEST_SLOW_THRESHOLD_MS) {
      log.warn(
        `⚠️ manifest check took ${elapsed}ms (>${MANIFEST_SLOW_THRESHOLD_MS}ms) — server slow or near timeout`,
      );
    }
    if (resp.status === 404) {
      log.info(`manifest check → 404 in ${elapsed}ms (treating as up-to-date)`);
      endpointCache = { key, at: Date.now(), resp: "notfound" };
      return "notfound";
    }
    if (resp.status === 400) {
      log.error(
        `🔴 manifest check → 400 in ${elapsed}ms (request param rejected — config bug, will repeat every check)`,
      );
      const err = new UpdaterError("api", "Update check rejected the request parameters (400)");
      if (op === "check") {
        sendErrorTelemetry(makeUpdaterError(updaterErrors.MANIFEST_BAD_REQUEST), err);
      }
      throw err;
    }
    if (!resp.ok) {
      log.error(`🔴 manifest check → ${resp.status} ${resp.statusText} in ${elapsed}ms`);
      const err = new UpdaterError("api", `Update check failed: ${resp.status} ${resp.statusText}`);
      if (op === "check") {
        sendErrorTelemetry(makeUpdaterError(updaterErrors.MANIFEST_SERVER_ERROR), err);
      }
      throw err;
    }
    const data: unknown = await resp.json();
    const parsed = UpdateCheckResponseSchema.safeParse(data);
    if (!parsed.success) {
      // Format Zod errors as `path: message` joined with "; " — drops the per-issue `received`
      // value that Zod's default error.message embeds. Today the schema fields are all system
      // values (versions, booleans, https URLs) where the received value is harmless to log, but
      // future fields (telemetry ids, user-scoped tokens) could leak through this surface if we
      // ever expand the response shape. Path + message is enough to diagnose a schema drift.
      const issueSummary = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      log.error(
        `🔴 manifest schema validation failed in ${Date.now() - startMs}ms: ${issueSummary}`,
      );
      const err = new UpdaterError(
        "api",
        `Update check response failed validation: ${issueSummary}`,
      );
      if (op === "check") {
        sendErrorTelemetry(makeUpdaterError(updaterErrors.MANIFEST_SCHEMA_INVALID), err);
      }
      throw err;
    }
    log.info(
      `manifest check → 200 in ${elapsed}ms (latestVersion=${parsed.data.latestVersion}, channel=${parsed.data.channel}, upToDate=${parsed.data.upToDate}, blocked=${parsed.data.blocked})`,
    );
    endpointCache = { key, at: Date.now(), resp: parsed.data };
    return parsed.data;
  }

  async checkForUpdate(params: {
    currentVersion: string;
    channel: UpdateChannel;
  }): Promise<UpdateCheckResult> {
    const { currentVersion } = params;
    // The endpoint serves only the stable channel; a persisted `updateChannelBeta = true` can
    // still arrive from update-ipc.ts, so pin to "stable" to match the contract, parallel to
    // checkMinimumVersion below.
    const channel: UpdateChannel = "stable";
    let r: UpdateCheckResponse | "notfound";
    try {
      r = await this.fetchResponse(currentVersion, channel, "check");
    } catch (err) {
      if (err instanceof UpdaterError) throw err;
      throw new UpdaterError("api", err instanceof Error ? err.message : String(err));
    }
    if (r === "notfound") {
      return { upToDate: true, currentVersion, channel };
    }
    // Strict-newer only: never offer the same or an older version. Rollback / re-install of the
    // running build is not a product capability, and a stale/misconfigured manifest must not be
    // inferred as an "update".
    const offersNewer = isNewer(r.latestVersion, currentVersion);
    if (!r.upToDate && !offersNewer) {
      log.warn(
        `server offered a non-newer version (latest=${r.latestVersion}, current=${currentVersion}); treating as up-to-date`,
      );
    }
    const upToDate = r.upToDate || !offersNewer;
    // Pin the server-supplied assetName to this platform/arch/version before exposing it.
    if (!upToDate && r.assetName) {
      try {
        validateAssetForCurrentPlatform(r.assetName, r.latestVersion);
      } catch (err) {
        log.error(
          `🔴 asset name rejected (assetName=${r.assetName}, latestVersion=${r.latestVersion}, platform=${process.platform}, arch=${process.arch}):`,
          err,
        );
        const wrapped = new UpdaterError("api", err instanceof Error ? err.message : String(err));
        sendErrorTelemetry(makeUpdaterError(updaterErrors.ASSET_NAME_REJECTED), wrapped);
        throw wrapped;
      }
    }
    return {
      upToDate,
      currentVersion,
      latestVersion: r.latestVersion,
      downloadUrl: upToDate ? undefined : r.downloadUrl,
      assetName: upToDate ? undefined : r.assetName,
      // `releaseUrl` is intentionally returned even when up-to-date so the renderer can offer a
      // "what's in my current build" link from the up-to-date state. The download-side fields
      // (downloadUrl / assetName / sha256) are gated because they only make sense in the
      // "an upgrade is available" branch.
      releaseUrl: r.releaseUrl,
      channel: r.channel,
      sha256: upToDate ? undefined : r.sha256,
    };
  }

  async downloadUpdate(args: {
    url: string;
    assetName: string;
    onProgress?: (percent: number) => void;
  }): Promise<string> {
    const { url, assetName, onProgress } = args;
    const filePath = validateAssetName(assetName);
    const expectedSha = this.expectedSha256For(assetName);
    // Pin host (allowlist + https + no creds) AND that the URL pathname terminates in `assetName`
    // BEFORE any side effect. The pathname check stops a compromised manifest from pairing a
    // current-version assetName with an older binary carrying the same private publisher signature
    // pass; user gets a silent version downgrade).
    try {
      validateEndpointDownloadUrl(url, assetName);
    } catch (err) {
      log.error(`🔴 download host rejected (${urlLabel(url)}):`, err);
      sendErrorTelemetry(makeUpdaterError(updaterErrors.DOWNLOAD_HOST_REJECTED), err);
      throw err;
    }

    mkdirSync(dirname(filePath), { recursive: true });
    if (existsSync(filePath)) rmSync(filePath);
    log.info(`download starting → ${urlLabel(url)} (assetName=${assetName})`);
    const downloadStartMs = Date.now();

    // Two-tier abort, set up here so the AbortSignal is wired through BOTH
    // the initial fetch and the redirect-follow-up below. Timers don't fire
    // until they expire (2 min stall / 10 min overall); the actual cleanup
    // happens in the read loop's try/catch + the success path further down.
    //
    // STALL: 2 min of zero bytes received → abort. Slow-but-working downloads
    //        aren't punished; truly hung sockets do not wait forever.
    // CEILING: 10 min overall → abort. Even an extremely slow but live
    //          connection is cut off so the renderer's spinner can't be
    //          stuck for hours.
    //
    // No automatic in-process retry: the user retries via "Download & Install"
    // in the global notice rail. The previous spike's auto-retry was dropped after
    // review (silent retries hide real outages).
    const downloadController = new AbortController();
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const overallTimer = setTimeout(() => {
      downloadController.abort(
        new Error(`Download exceeded ${DOWNLOAD_OVERALL_TIMEOUT_MS / 60_000} min ceiling`),
      );
    }, DOWNLOAD_OVERALL_TIMEOUT_MS);
    const resetStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        downloadController.abort(
          new Error(`Download stalled: no bytes received in ${DOWNLOAD_STALL_TIMEOUT_MS / 1000}s`),
        );
      }, DOWNLOAD_STALL_TIMEOUT_MS);
    };
    const clearDownloadTimers = () => {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
      clearTimeout(overallTimer);
    };
    resetStallTimer();

    try {
      return await this.downloadStream({
        url,
        filePath,
        assetName,
        expectedSha,
        downloadStartMs,
        controller: downloadController,
        resetStallTimer,
        onProgress,
      });
    } finally {
      clearDownloadTimers();
    }
  }

  private async downloadStream(args: {
    url: string;
    filePath: string;
    assetName: string;
    expectedSha: string | undefined;
    downloadStartMs: number;
    controller: AbortController;
    resetStallTimer: () => void;
    onProgress?: (percent: number) => void;
  }): Promise<string> {
    const {
      url,
      filePath,
      assetName,
      expectedSha,
      downloadStartMs,
      controller,
      resetStallTimer,
      onProgress,
    } = args;

    // No auth token is ever attached, so following a same-origin CDN redirect is safe.
    // Download-host responses are terminal in practice; the redirect arm below stays
    // as defense-in-depth and re-pins the host via the no-redirect follow-up fetch.
    let resp = await fetchImpl(url, {
      headers: { "User-Agent": UA },
      redirect: "manual",
      signal: controller.signal,
    });
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("Location");
      if (!location) {
        log.error(
          `🔴 download response → ${resp.status} redirect with no Location header after ${Date.now() - downloadStartMs}ms`,
        );
        const err = new UpdaterError("api", "Asset download: redirect with no Location header");
        sendErrorTelemetry(makeUpdaterError(updaterErrors.DOWNLOAD_RESPONSE_FAILED), err);
        throw err;
      }
      if (!URL.parse(location)) {
        log.error(
          `🔴 download response → ${resp.status} redirect Location not absolute after ${Date.now() - downloadStartMs}ms`,
        );
        const err = new UpdaterError(
          "api",
          "Asset download: redirect Location is not an absolute URL",
        );
        sendErrorTelemetry(makeUpdaterError(updaterErrors.DOWNLOAD_RESPONSE_FAILED), err);
        throw err;
      }
      try {
        validateEndpointDownloadUrl(location, assetName);
      } catch (err) {
        log.error(`🔴 download redirect host rejected (${urlLabel(location)}):`, err);
        sendErrorTelemetry(makeUpdaterError(updaterErrors.DOWNLOAD_HOST_REJECTED), err);
        throw err;
      }
      log.info(`download redirected → ${urlLabel(location)}`);
      resp = await fetchImpl(location, {
        headers: { "User-Agent": UA },
        redirect: "error",
        signal: controller.signal,
      });
    }
    if (!resp.ok) {
      log.error(
        `🔴 download response → ${resp.status} ${resp.statusText} after ${Date.now() - downloadStartMs}ms`,
      );
      const err = new UpdaterError(
        "api",
        `Asset download failed: ${resp.status} ${resp.statusText}`,
      );
      sendErrorTelemetry(makeUpdaterError(updaterErrors.DOWNLOAD_RESPONSE_FAILED), err);
      throw err;
    }

    const totalBytes = parseInt(resp.headers.get("content-length") || "0", 10);
    const body = resp.body;
    if (!body) {
      log.error(`🔴 download response had no body after ${Date.now() - downloadStartMs}ms`);
      const err = new Error("No response body");
      sendErrorTelemetry(makeUpdaterError(updaterErrors.DOWNLOAD_RESPONSE_FAILED), err);
      throw err;
    }

    const writer = createWriteStream(filePath);
    let downloadedBytes = 0;
    let writeError: Error | null = null;
    writer.on("error", (err) => {
      writeError = err;
    });

    // Periodic progress logging — every ~10 MB so a 100 MB installer produces
    // ~10 rows of progress evidence in disk logs (enough to spot stalls in
    // hindsight without flooding the file).
    const PROGRESS_LOG_INTERVAL_MB = 10;
    let lastLoggedMB = 0;

    const reader = body.getReader();
    try {
      while (true) {
        if (writeError) throw writeError;
        // eslint-disable-next-line no-await-in-loop -- sequential file write
        const { done, value } = await reader.read();
        if (done) break;
        // Reset on each chunk so a slow-but-progressing download isn't punished.
        // The stall fires only when 2 min elapse with no `value` at all.
        resetStallTimer();
        writer.write(Buffer.from(value));
        downloadedBytes += value.byteLength;
        if (totalBytes > 0) onProgress?.(Math.round((downloadedBytes / totalBytes) * 100));
        const currentMB = Math.floor(downloadedBytes / 1024 / 1024);
        if (currentMB >= lastLoggedMB + PROGRESS_LOG_INTERVAL_MB) {
          lastLoggedMB = currentMB;
          const pct = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : -1;
          log.info(
            `download progress → ${pct >= 0 ? `${pct}% (` : "("}${currentMB} MB${totalBytes > 0 ? ` / ${Math.round(totalBytes / 1024 / 1024)} MB` : ""}) in ${Date.now() - downloadStartMs}ms`,
          );
        }
      }
    } catch (err) {
      writer.destroy();
      try {
        rmSync(filePath);
      } catch {
        /* best effort */
      }
      const elapsed = Date.now() - downloadStartMs;
      const receivedMB = Math.round(downloadedBytes / 1024 / 1024);
      const totalMB = totalBytes > 0 ? Math.round(totalBytes / 1024 / 1024) : 0;
      const ofTotal = totalMB > 0 ? ` of ${totalMB} MB` : "";
      log.error(
        `🔴 download FAILED after ${elapsed}ms (received ${receivedMB} MB${ofTotal}):`,
        err,
      );
      // Reader catch combines two operationally-distinct cases: AbortError
      // (controller fired — stall or overall timeout) vs everything else
      // (network drop, server reset, disk write failed). Split into two
      // codes so the dashboard can distinguish "downloads are timing out
      // mid-stream" from "downloads are erroring out".
      sendErrorTelemetry(
        makeUpdaterError(
          isAbortError(err) ? updaterErrors.DOWNLOAD_TIMEOUT : updaterErrors.DOWNLOAD_STREAM_FAILED,
        ),
        err,
      );
      throw err;
    }

    // Finalize + verify: each phase has its own try/catch so the failure code stays
    // accurate to the operation that ran, but both share a cleanup helper that wipes
    // the partial file. Pre-refactor, a writer.end() rejection (disk-full mid-flush)
    // left a partial binary on disk with no telemetry — only the next call's existsSync
    // would clean it up.
    const cleanupPartial = () => {
      try {
        rmSync(filePath);
      } catch {
        /* best effort */
      }
    };

    try {
      await new Promise<void>((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
        writer.end();
      });
    } catch (err) {
      cleanupPartial();
      log.error(
        `🔴 download finalize FAILED for ${assetName} after ${Date.now() - downloadStartMs}ms:`,
        err,
      );
      sendErrorTelemetry(makeUpdaterError(updaterErrors.DOWNLOAD_STREAM_FAILED), err);
      throw err;
    }

    if (expectedSha) {
      try {
        await verifyDownloadSha256(filePath, expectedSha);
      } catch (err) {
        cleanupPartial();
        log.error(
          `🔴 sha256 verification FAILED for ${assetName} after ${Date.now() - downloadStartMs}ms:`,
          err,
        );
        sendErrorTelemetry(makeUpdaterError(updaterErrors.DOWNLOAD_SHA256_MISMATCH), err);
        throw err;
      }
      log.info("SHA-256 verified");
    } else {
      log.warn("No sha256 in response — relying on signature verification only");
    }
    const elapsed = Date.now() - downloadStartMs;
    const sizeMB = Math.round(downloadedBytes / 1024 / 1024);
    const throughputMBs =
      elapsed > 0 ? Math.round((downloadedBytes / 1024 / 1024 / elapsed) * 1000) : 0;
    log.info(
      `download complete → ${assetName} (${sizeMB} MB in ${elapsed}ms, ~${throughputMBs} MB/s)`,
    );
    return filePath;
  }

  private expectedSha256For(assetName: string): string | undefined {
    const r = endpointCache?.resp;
    if (r && r !== "notfound" && r.assetName === assetName) return r.sha256;
    return undefined;
  }

  async checkMinimumVersion(currentVersion: string): Promise<MinimumVersionResult> {
    try {
      const r = await this.fetchResponse(currentVersion, "stable", "minimumVersion");
      if (r === "notfound") return { blocked: false, minimumVersion: "0.0.0", currentVersion };
      return { blocked: r.blocked, minimumVersion: r.minimumVersion, currentVersion };
    } catch {
      return { blocked: false, minimumVersion: "0.0.0", currentVersion };
    }
  }
}
