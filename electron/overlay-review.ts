import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  LoadedRuntimeExtensionPackage,
  RuntimeExtensionActivation,
} from "@marshal/runtime/extensions";
import { app, type BrowserWindow } from "electron";

import type {
  IpcHandler,
  IpcInvokeMap,
  OverlayReviewComposerAttachment,
  OverlayReviewLaunchRequest,
  OverlayReviewTarget,
  OverlayReviewSubmittedEvent,
} from "../common/marshal-ipc-contract";
import { createLogger } from "../common/marshal-logger";
import { transcribeAudio } from "./transcribe/transcribe";

export interface OverlayReviewPayload {
  target: OverlayReviewTarget;
  markdown: string;
}

export interface OverlayReviewAttachment {
  name: string;
  mimeType: string;
  dataUrl: string;
  kind: OverlayReviewComposerAttachment["kind"];
  ref?: string | number;
}

export interface OverlayReviewVoiceClip {
  audioBase64: string;
  mimeType: string;
  durationMs: number;
}

export interface OverlayReviewController {
  enable(): Promise<void>;
  destroy(): void;
  show(context?: { sessionId?: string; sessionTitle?: string }): Promise<void>;
}

export interface OverlayReviewOptions {
  hooks: {
    onSubmitReview: (payload: OverlayReviewPayload) => void | Promise<void>;
    transcribe?: (clip: OverlayReviewVoiceClip) => string | Promise<string>;
    onError?: (err: { message: string; cause?: unknown }) => void;
  };
  toggleShortcut?: string | false;
  host?: { appName?: string; appVersion?: string; context?: Record<string, unknown> };
}

export interface OverlayReviewRuntime {
  createOverlay(options: OverlayReviewOptions): OverlayReviewController;
  reviewToAttachments(payload: OverlayReviewPayload): {
    attachments: OverlayReviewAttachment[];
    summaryMarkdown: string;
  };
}

export interface OverlayReviewDeps {
  ipcHandle: <C extends keyof IpcInvokeMap>(channel: C, handler: IpcHandler<C>) => void;
  getWindow: () => BrowserWindow | null;
  appVersion: string;
  loadRuntime?: (entry: string) => Promise<OverlayReviewRuntime>;
}

export interface OverlayReviewPackageHost {
  launch: (request: OverlayReviewLaunchRequest) => Promise<void>;
  activatePackage: (packageRoot: string) => Promise<() => Promise<void>>;
  destroy: () => void;
}

const log = createLogger("OverlayReview");
const OVERLAY_REVIEW_MAIN_ENTRYPOINT = path.join("dist", "main", "index.js");

function overlayReviewEntry(packageRoot: string): string {
  return path.join(packageRoot, OVERLAY_REVIEW_MAIN_ENTRYPOINT);
}

async function loadOverlayReviewRuntime(entry: string): Promise<OverlayReviewRuntime> {
  if (!existsSync(entry)) {
    throw new Error(`Overlay review extension is not installed at ${entry}`);
  }
  const runtime: unknown = await import(pathToFileURL(entry).href);
  if (!isOverlayReviewRuntime(runtime)) {
    throw new Error(`Overlay review extension at ${entry} did not export the expected API.`);
  }
  return runtime;
}

function isOverlayReviewRuntime(value: unknown): value is OverlayReviewRuntime {
  if (typeof value !== "object" || value === null) return false;
  return (
    typeof Reflect.get(value, "createOverlay") === "function" &&
    typeof Reflect.get(value, "reviewToAttachments") === "function"
  );
}

function decodeBase64DataUrl(dataUrl: string, fallbackMimeType: string): Buffer {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma < 0) {
    throw new Error("Review attachment is not a data URL");
  }

  const meta = dataUrl.slice("data:".length, comma).toLowerCase();
  if (!meta.split(";").includes("base64")) {
    throw new Error("Review attachment data URL is not base64 encoded");
  }

  const mimeType = meta.split(";")[0] || fallbackMimeType;
  if (mimeType !== fallbackMimeType.toLowerCase()) {
    log.warn(`Review attachment MIME mismatch: ${fallbackMimeType} vs ${mimeType}`);
  }

  return Buffer.from(dataUrl.slice(comma + 1), "base64");
}

function safeFileName(name: string, fallback: string): string {
  const invalidChars = '<>:"/\\|?*';
  let baseName = "";
  for (const char of path.basename(name)) {
    baseName += char.charCodeAt(0) < 32 || invalidChars.includes(char) ? "-" : char;
  }
  baseName = baseName.trim();
  return baseName || fallback;
}

async function persistReviewAttachments(
  attachments: readonly OverlayReviewAttachment[],
): Promise<{ attachments: OverlayReviewComposerAttachment[]; dir: string }> {
  const dir = path.join(app.getPath("temp"), "marshal-overlay-reviews", randomUUID());
  await mkdir(dir, { recursive: true });

  const persisted = await Promise.all(
    attachments.map(async (attachment, i): Promise<OverlayReviewComposerAttachment> => {
      const fallback = `review-attachment-${i + 1}.bin`;
      const fileName = `${String(i + 1).padStart(2, "0")}-${safeFileName(attachment.name, fallback)}`;
      const filePath = path.join(dir, fileName);
      const buffer = decodeBase64DataUrl(attachment.dataUrl, attachment.mimeType);
      await writeFile(filePath, buffer);
      return {
        name: attachment.name,
        mimeType: attachment.mimeType,
        path: filePath,
        kind: attachment.kind,
      };
    }),
  );
  return { attachments: persisted, dir };
}

interface PendingReview {
  event: OverlayReviewSubmittedEvent;
  /** Temp dir holding this review's attachment files (removed if it expires unclaimed). */
  dir: string;
  createdAt: number;
}

/** Buffered reviews keyed by target sessionId, delivered when that session's
 * composer claims them (handles the case where it was not mounted at submit). */
const PENDING_TTL_MS = 30 * 60 * 1000;
const PENDING_MAX = 24;

async function removeDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    log.warn(`Failed to clean up review temp dir ${dir}:`, err);
  }
}

/** Drop expired entries (deleting their temp files) and enforce a global cap. */
function sweepPending(pending: Map<string, PendingReview[]>): void {
  const now = Date.now();
  const survivors: PendingReview[] = [];
  for (const [sessionId, list] of pending) {
    const kept: PendingReview[] = [];
    for (const entry of list) {
      if (now - entry.createdAt > PENDING_TTL_MS) void removeDir(entry.dir);
      else kept.push(entry);
    }
    if (kept.length) {
      pending.set(sessionId, kept);
      survivors.push(...kept);
    } else {
      pending.delete(sessionId);
    }
  }
  if (survivors.length <= PENDING_MAX) return;
  survivors.sort((a, b) => a.createdAt - b.createdAt);
  for (const stale of survivors.slice(0, survivors.length - PENDING_MAX)) {
    void removeDir(stale.dir);
    for (const [sessionId, list] of pending) {
      const idx = list.indexOf(stale);
      if (idx < 0) continue;
      list.splice(idx, 1);
      if (!list.length) pending.delete(sessionId);
      break;
    }
  }
}

export function registerOverlayReviewHandlers({
  ipcHandle,
  getWindow,
  appVersion,
  loadRuntime = loadOverlayReviewRuntime,
}: OverlayReviewDeps): OverlayReviewPackageHost {
  const activePackages: Array<{ readonly controller: OverlayReviewController }> = [];
  const pending = new Map<string, PendingReview[]>();

  const clearPending = (): void => {
    for (const list of pending.values()) {
      for (const entry of list) void removeDir(entry.dir);
    }
    pending.clear();
  };

  const launch = async (request: OverlayReviewLaunchRequest): Promise<void> => {
    const sessionId = request.sessionId.trim();
    if (!sessionId) {
      throw new Error("Cannot review the screen without an active chat session.");
    }

    const active = activePackages.at(-1);
    if (!active) {
      throw new Error("Overlay review is not enabled by an installed Runtime extension.");
    }
    await active.controller.show({
      sessionId,
      ...(request.sessionTitle?.trim() ? { sessionTitle: request.sessionTitle.trim() } : {}),
    });
  };

  ipcHandle("overlay-review:launch", async (_event, request) => {
    try {
      await launch(request);
      return { success: true };
    } catch (error) {
      log.error("Failed to launch overlay review:", error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcHandle("overlay-review:claim", async (_event, sessionId) => {
    const key = typeof sessionId === "string" ? sessionId.trim() : "";
    sweepPending(pending);
    const list = key ? (pending.get(key) ?? []) : [];
    pending.delete(key);
    // Ownership of the temp files transfers to the renderer (they become
    // composer attachments), so we do NOT delete their dirs here.
    return { reviews: list.map((entry) => entry.event) };
  });

  return {
    launch,
    activatePackage: async (packageRoot) => {
      const overlayReview = await loadRuntime(overlayReviewEntry(packageRoot));
      const controller = overlayReview.createOverlay({
        host: { appName: "Marshal", appVersion },
        toggleShortcut: false,
        hooks: {
          onSubmitReview: async (payload) => {
            if (!payload.target.sessionId) {
              throw new Error("Screen reviews must be launched from a chat session.");
            }

            const bundle = overlayReview.reviewToAttachments(payload);
            const { attachments: persisted, dir } = await persistReviewAttachments(
              bundle.attachments,
            );
            const event: OverlayReviewSubmittedEvent = {
              reviewId: randomUUID(),
              target: payload.target,
              attachments: persisted,
              summaryMarkdown: bundle.summaryMarkdown,
            };
            const sessionId = payload.target.sessionId;
            const list = pending.get(sessionId) ?? [];
            list.push({ event, dir, createdAt: Date.now() });
            pending.set(sessionId, list);
            sweepPending(pending);

            const win = getWindow();
            if (win && !win.isDestroyed()) {
              win.webContents.send("overlay-review:pending", { sessionId });
            }
          },
          transcribe: async (clip) => {
            const audio = Buffer.from(clip.audioBase64, "base64");
            return transcribeAudio(new Uint8Array(audio), { mimeType: clip.mimeType });
          },
          onError: (err) => {
            log.warn(`Overlay review error: ${err.message}`, err.cause);
            const win = getWindow();
            if (win && !win.isDestroyed()) {
              win.webContents.send("overlay-review:error", { message: err.message });
            }
          },
        },
      });
      try {
        await controller.enable();
      } catch (error) {
        controller.destroy();
        throw error;
      }
      const active = { controller };
      activePackages.push(active);
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        const index = activePackages.indexOf(active);
        if (index < 0) return;
        activePackages.splice(index, 1);
        controller.destroy();
        if (activePackages.length === 0) clearPending();
      };
    },
    destroy: () => {
      clearPending();
      for (const active of activePackages.splice(0).reverse()) {
        active.controller.destroy();
      }
    },
  };
}

export function adaptOverlayReviewExtensionPackage(
  loaded: LoadedRuntimeExtensionPackage,
  host: OverlayReviewPackageHost,
): LoadedRuntimeExtensionPackage {
  const activate = loaded.module.activate.bind(loaded.module);
  return {
    ...loaded,
    module: {
      activate: async (context) => {
        const release = await host.activatePackage(loaded.metadata.canonicalRoot);
        let activation: RuntimeExtensionActivation;
        try {
          activation = await activate(context);
        } catch (error) {
          await release();
          throw error;
        }
        return {
          ...activation,
          dispose: async () => {
            const failures: unknown[] = [];
            try {
              await activation.dispose?.();
            } catch (error) {
              failures.push(error);
            }
            try {
              await release();
            } catch (error) {
              failures.push(error);
            }
            if (failures.length > 0) {
              throw new AggregateError(
                failures,
                "Failed to dispose the Marshal overlay review extension.",
              );
            }
          },
        };
      },
    },
  };
}
