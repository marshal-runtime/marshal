import * as fs from "node:fs";
import path from "node:path";

import type { BrowserWindow, Rectangle } from "electron";
import { screen } from "electron";

import { createLogger } from "../common/marshal-logger";
import { getAppDataDir } from "./app-paths";
import { secureMkdirSync, secureWriteFileSync } from "./platform-security";

const log = createLogger("WindowState");

export const STATE_FILENAME = "marshal-window-state.json";

export const MIN_WIDTH = 480;
export const MIN_HEIGHT = 360;
const DEFAULT_WIDTH = 900;
const DEFAULT_HEIGHT = 900;

export interface WindowState {
  bounds: Rectangle;
  isMaximized: boolean;
}

function getStatePath(): string {
  return path.join(getAppDataDir(), STATE_FILENAME);
}

function isFiniteInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

function parseState(raw: string): WindowState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown; // SF-4: app-written local file; narrowed via isRecord + isFiniteInt below
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const b = parsed.bounds;
  if (
    !isRecord(b) ||
    !isFiniteInt(b.x) ||
    !isFiniteInt(b.y) ||
    !isFiniteInt(b.width) ||
    !isFiniteInt(b.height)
  ) {
    return null;
  }
  return {
    bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
    isMaximized: parsed.isMaximized === true,
  };
}

/** Read saved window state from disk, or null if missing/corrupt. */
export function loadWindowState(): WindowState | null {
  const file = getStatePath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
      log.warn("Failed to read window state:", err);
    }
    return null;
  }
  return parseState(raw);
}

/**
 * Returns bounds that fit within at least one currently-connected display, or
 * null if the saved bounds are off-screen (e.g. external monitor disconnected).
 * Requires the Electron app to be ready (uses `screen`).
 */
export function pickValidBounds(state: WindowState | null): Rectangle | null {
  if (!state) return null;
  const { bounds } = state;
  if (bounds.width < MIN_WIDTH || bounds.height < MIN_HEIGHT) return null;

  const displays = screen.getAllDisplays();
  // Window is valid if its top-left lies within some display's work area and
  // there's at least 100px of overlap so the title bar is grabbable.
  const visible = displays.some((d) => {
    const a = d.workArea;
    const overlapX = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x);
    const overlapY = Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y);
    return overlapX >= 100 && overlapY >= 100;
  });
  return visible ? bounds : null;
}

/** Default bounds when no saved state is usable. */
export function getDefaultBounds(): { width: number; height: number } {
  return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
}

function writeState(state: WindowState): void {
  const file = getStatePath();
  try {
    secureMkdirSync(path.dirname(file), 0o700);
    secureWriteFileSync(file, JSON.stringify(state), { mode: 0o600 });
  } catch (err) {
    log.warn("Failed to persist window state:", err);
  }
}

/**
 * Wire up listeners that persist `win`'s bounds + maximized state.
 * Writes are debounced for resize/move; immediate for maximize/unmaximize/
 * leave-full-screen/close.
 *
 * Main window only — chat popouts and other transient windows use defaults.
 *
 * Skips writes while fullscreen: getNormalBounds() can be stale on macOS
 * fullscreen, and we don't restore fullscreen on relaunch anyway.
 *
 * Returns a `detach()` to remove the listeners — call from the `closed`
 * handler to match the cleanup convention used by other main-window listeners.
 */
export function attachWindowStateTracking(win: BrowserWindow): () => void {
  let timer: NodeJS.Timeout | null = null;

  const snapshot = (): WindowState => ({
    bounds: win.getNormalBounds(),
    isMaximized: win.isMaximized(),
  });

  const saveNow = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (win.isDestroyed()) return;
    // Don't capture fullscreen bounds — we don't restore fullscreen, and on
    // macOS getNormalBounds() can be stale while in fullscreen.
    if (win.isFullScreen()) return;
    writeState(snapshot());
  };

  const saveDebounced = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!win.isDestroyed() && !win.isFullScreen()) writeState(snapshot());
    }, 500);
  };

  win.on("resize", saveDebounced);
  win.on("move", saveDebounced);
  win.on("maximize", saveNow);
  win.on("unmaximize", saveNow);
  win.on("leave-full-screen", saveNow);
  win.on("close", saveNow);

  return () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    win.removeListener("resize", saveDebounced);
    win.removeListener("move", saveDebounced);
    win.removeListener("maximize", saveNow);
    win.removeListener("unmaximize", saveNow);
    win.removeListener("leave-full-screen", saveNow);
    win.removeListener("close", saveNow);
  };
}
