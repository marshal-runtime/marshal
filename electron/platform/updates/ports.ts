/**
 * Update-provider abstraction; `selectUpdateProvider()` builds one per IPC
 * invocation. The interface declares only methods every provider can implement
 * (CLAUDE.md backend-abstraction rule 3) — no provider-specific optionals.
 */
import type { UpdateChannel } from "../../updater";

export type { UpdateChannel } from "../../updater";

export interface UpdateCheckResult {
  upToDate: boolean;
  currentVersion: string;
  latestVersion?: string;
  /** Installer download URL. */
  downloadUrl?: string;
  assetName?: string;
  releaseUrl?: string;
  channel: UpdateChannel;
  sha256?: string;
}

export interface MinimumVersionResult {
  blocked: boolean;
  minimumVersion: string;
  currentVersion: string;
}

export interface IUpdateProvider {
  /** For validation/logging only — never branch behavior on it (rule 2). */
  readonly origin: "endpoint";
  /**
   * Acquire any credentials the provider needs before subsequent calls; the endpoint path is
   * unauthenticated and resolves immediately. Throws `UpdaterError` on failure. IPC callers
   * invoke this before `checkForUpdate` so auth status is reported separately from the check.
   * `onDeviceCode` lets an interactive provider surface a device-flow code to the renderer.
   */
  authenticate(opts: {
    onDeviceCode?: (info: { userCode: string; verificationUri: string }) => void;
  }): Promise<{ ok: true }>;
  checkForUpdate(params: {
    currentVersion: string;
    channel: UpdateChannel;
  }): Promise<UpdateCheckResult>;
  downloadUpdate(args: {
    url: string;
    assetName: string;
    onProgress?: (percent: number) => void;
  }): Promise<string>;
  checkMinimumVersion(currentVersion: string): Promise<MinimumVersionResult>;
}
