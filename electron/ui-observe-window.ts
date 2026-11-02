import { randomUUID } from "node:crypto";

import { BrowserWindow, ipcMain } from "electron";

import type { UiObserveRenderRequest, UiObserveWindowHandle } from "./ui-observe";

/** True phone presentation dimensions — the remote client's tested viewport. */
const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;
const DESKTOP_VIEWPORT = { width: 1280, height: 800 } as const;
const READY_TIMEOUT_MS = 20_000;
const FULL_PAGE_MAX_HEIGHT = 4_000;

// Observer windows are first-class renderers (standard preload, real IPC
// authority), but their activations must never steal the user's desktop pane:
// runtime-ui-ipc treats these webContents like remote clients for focus
// origin (observe-not-follow, defect M2 semantics).
const observerWebContents = new Set<number>();
export function isObserverWebContents(id: number): boolean {
  return observerWebContents.has(id);
}

export interface UiObserveWindowOptions {
  readonly preloadPath: string;
  readonly devServerUrl?: string;
  /** Grants the window's webContents access to the app's IPC surface. */
  readonly authorizeIpcWebContents: (webContentsId: number) => () => void;
  /** Closes a runtime-ui instance the observer harness CREATED (session-scoped
   *  mounts, M3) so observer instances never accumulate in the requester's
   *  scope. Mirror observations of pre-existing instances are never closed. */
  readonly closeObservedInstance?: (target: {
    readonly scope: UiObserveRenderRequest["scope"];
    readonly extensionId: string;
    readonly applicationId: string;
    readonly instanceId: string;
  }) => Promise<void>;
}

function observeQuery(request: UiObserveRenderRequest, marker: string): string {
  const params = new URLSearchParams({
    mode: request.mode,
    viewport: request.viewport,
    observer: marker,
  });
  if (request.extensionId) params.set("extensionId", request.extensionId);
  if (request.applicationId) params.set("applicationId", request.applicationId);
  if (request.instanceId) params.set("instanceId", request.instanceId);
  if (request.scope.sessionId) params.set("sessionId", request.scope.sessionId);
  if (request.scope.applicationScope)
    params.set("applicationScope", request.scope.applicationScope);
  params.set("workspaceName", request.scope.workspaceName);
  if (request.surface) params.set("surface", request.surface);
  return params.toString();
}

/**
 * Opens the observe harness (observe.html → src/observe/main.tsx) in a hidden
 * window at the requested viewport and resolves once the packaged UI reports
 * readiness (bridge onReady / error state / gate — whatever the harness
 * actually shows; error states are honest observations too). The returned
 * handle captures on demand and stays alive until destroyed (interactive
 * sessions attach to it over CDP by the unique URL marker).
 */
export function createObserverWindowOpener(options: UiObserveWindowOptions) {
  return async (request: UiObserveRenderRequest): Promise<UiObserveWindowHandle> => {
    const viewport = request.viewport === "mobile" ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT;
    const marker = `ui-observe-${randomUUID()}`;
    const window = new BrowserWindow({
      show: false,
      width: viewport.width,
      height: viewport.height,
      useContentSize: true,
      webPreferences: {
        preload: options.preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    const webContentsId = window.webContents.id;
    observerWebContents.add(webContentsId);
    const deauthorize = options.authorizeIpcWebContents(webContentsId);
    let destroyed = false;
    let createdInstanceId: string | null = null;
    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      observerWebContents.delete(webContentsId);
      deauthorize();
      if (!window.isDestroyed()) window.destroy();
      if (createdInstanceId && request.extensionId && request.applicationId) {
        void options
          .closeObservedInstance?.({
            scope: request.scope,
            extensionId: request.extensionId,
            applicationId: request.applicationId,
            instanceId: createdInstanceId,
          })
          .catch(() => undefined);
      }
    };
    // The harness writes its terminal presentation to
    // document.documentElement.dataset.observeState (preparing → rendered |
    // error). A capture of the "preparing" shell is a lie — the first live
    // demo returned exactly that — so both open and capture verify the state
    // and fail loudly instead.
    const observeState = async (): Promise<string> => {
      if (window.isDestroyed()) return "destroyed";
      const state = (await window.webContents
        .executeJavaScript("document.documentElement.dataset.observeState ?? 'preparing'", true)
        .catch(() => "unknown")) as unknown;
      return typeof state === "string" ? state : "unknown";
    };
    const requireSettled = async (): Promise<void> => {
      const state = await observeState();
      if (state !== "rendered" && state !== "error")
        throw Object.assign(
          new Error(
            `The observer never rendered the application (state: ${state}); a capture would show only the loading shell. ` +
              "The target may be failing to mount — check the app on a real client.",
          ),
          { code: "failed_precondition" },
        );
    };
    try {
      const ready = new Promise<void>((resolve) => {
        const listener = (event: Electron.IpcMainEvent, info?: unknown) => {
          if (event.sender.id !== webContentsId) return;
          if (
            typeof info === "object" &&
            info !== null &&
            (info as { created?: unknown }).created === true &&
            typeof (info as { instanceId?: unknown }).instanceId === "string"
          ) {
            // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- assertion is guarded by the surrounding logic; a typed guard is lint debt
            createdInstanceId = (info as { instanceId: string }).instanceId;
          }
          ipcMain.removeListener("ui-observe:ready", listener);
          resolve();
        };
        ipcMain.on("ui-observe:ready", listener);
        setTimeout(() => {
          ipcMain.removeListener("ui-observe:ready", listener);
          resolve();
        }, READY_TIMEOUT_MS).unref?.();
      });
      const query = observeQuery(request, marker);
      await (options.devServerUrl
        ? window.loadURL(`${options.devServerUrl}/observe.html?${query}`)
        : window.loadURL(`marshal://app/observe.html?${query}`));
      await ready;
      await requireSettled();
    } catch (error) {
      destroy();
      throw error;
    }
    return {
      webContentsId,
      urlMarker: marker,
      width: viewport.width,
      height: viewport.height,
      async capture({ settleMs, fullPage }) {
        if (destroyed || window.isDestroyed())
          throw Object.assign(new Error("The observer window is closed."), {
            code: "unavailable",
          });
        if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
        // Re-verify at capture time: a stuck observer must never masquerade
        // as a successful capture.
        await requireSettled();
        if (fullPage) {
          const contentHeight = (await window.webContents
            .executeJavaScript("document.documentElement.scrollHeight", true)
            .catch(() => viewport.height)) as unknown;
          const height = Math.min(
            FULL_PAGE_MAX_HEIGHT,
            Math.max(viewport.height, Number(contentHeight) || viewport.height),
          );
          window.setContentSize(viewport.width, Math.ceil(height));
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
        const image = await window.webContents.capturePage();
        const size = image.getSize();
        return {
          pngBase64: image.toPNG().toString("base64"),
          width: size.width,
          height: size.height,
        };
      },
      destroy,
    };
  };
}

/** One-shot capture: open, capture once, destroy. */
export function createUiObserveRenderer(options: UiObserveWindowOptions) {
  const open = createObserverWindowOpener(options);
  return async (
    request: UiObserveRenderRequest,
  ): Promise<{ pngBase64: string; width: number; height: number }> => {
    const handle = await open(request);
    try {
      return await handle.capture({ settleMs: request.settleMs, fullPage: request.fullPage });
    } finally {
      handle.destroy();
    }
  };
}

/**
 * Resolves the observer window's page target on the app's remote-debugging
 * port by its unique URL marker. Matching on the marker means the resolved
 * target can only ever be the observer's own hidden window — never the user's.
 */
export function createCdpTargetResolver(debugPort: number) {
  return async (urlMarker: string): Promise<string | null> => {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) return null;
      // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- assertion is guarded by the surrounding logic; a typed guard is lint debt
      const targets = (await response.json()) as ReadonlyArray<{
        readonly id?: string;
        readonly url?: string;
        readonly type?: string;
      }>;
      const target = targets.find(
        (candidate) =>
          candidate.type === "page" &&
          typeof candidate.url === "string" &&
          candidate.url.includes(`observer=${urlMarker}`) &&
          typeof candidate.id === "string",
      );
      return target?.id ?? null;
    } catch {
      return null;
    }
  };
}
