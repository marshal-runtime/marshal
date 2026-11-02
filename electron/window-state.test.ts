import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { testDouble } from "./testing/harness/test-double";
import { attachWindowStateTracking, loadWindowState, pickValidBounds } from "./window-state";

const { mockDisplays } = vi.hoisted(() => ({
  mockDisplays: vi.fn<
    () => Array<{ workArea: { x: number; y: number; width: number; height: number } }>
  >(() => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => os.tmpdir(),
  },
  screen: { getAllDisplays: mockDisplays },
}));

vi.mock("./mock-mode", () => ({
  isMockMode: () => false,
  E2E_DATA_DIR: "/tmp/e2e",
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "m-window-state-test-"));
  vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
  // .marshal-dev (dev mode) — see app-paths.getAppDataDir
  fs.mkdirSync(path.join(tmpDir, ".marshal-dev"), { recursive: true });
  mockDisplays.mockReturnValue([{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("window-state", () => {
  it("returns null when no state file exists", () => {
    expect(loadWindowState()).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    fs.writeFileSync(path.join(tmpDir, ".marshal-dev", "marshal-window-state.json"), "{not json");
    expect(loadWindowState()).toBeNull();
  });

  it("returns null when bounds fields are missing or non-integer", () => {
    const file = path.join(tmpDir, ".marshal-dev", "marshal-window-state.json");
    fs.writeFileSync(file, JSON.stringify({ bounds: { x: 0, y: 0, width: 100 } }));
    expect(loadWindowState()).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ bounds: { x: 0.5, y: 0, width: 100, height: 100 } }));
    expect(loadWindowState()).toBeNull();
  });

  it("loads valid state with defaulted maximized flag", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".marshal-dev", "marshal-window-state.json"),
      JSON.stringify({
        bounds: { x: 100, y: 200, width: 1200, height: 800 },
        isMaximized: true,
      }),
    );
    expect(loadWindowState()).toEqual({
      bounds: { x: 100, y: 200, width: 1200, height: 800 },
      isMaximized: true,
    });
  });

  it("defaults isMaximized to false when missing or non-boolean", () => {
    const file = path.join(tmpDir, ".marshal-dev", "marshal-window-state.json");
    fs.writeFileSync(file, JSON.stringify({ bounds: { x: 0, y: 0, width: 1200, height: 800 } }));
    expect(loadWindowState()?.isMaximized).toBe(false);
    fs.writeFileSync(
      file,
      JSON.stringify({
        bounds: { x: 0, y: 0, width: 1200, height: 800 },
        isMaximized: "yes",
      }),
    );
    expect(loadWindowState()?.isMaximized).toBe(false);
  });

  it("pickValidBounds: null state -> null", () => {
    expect(pickValidBounds(null)).toBeNull();
  });

  it("pickValidBounds: rejects sub-minimum sizes", () => {
    expect(
      pickValidBounds({
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        isMaximized: false,
      }),
    ).toBeNull();
  });

  it("pickValidBounds: accepts bounds inside a connected display", () => {
    const bounds = { x: 100, y: 100, width: 1200, height: 800 };
    expect(pickValidBounds({ bounds, isMaximized: false })).toEqual(bounds);
  });

  it("pickValidBounds: rejects bounds entirely off-screen (disconnected monitor)", () => {
    expect(
      pickValidBounds({
        bounds: { x: 3000, y: 0, width: 1200, height: 800 },
        isMaximized: false,
      }),
    ).toBeNull();
  });

  it("pickValidBounds: rejects bounds with <100px overlap (title bar ungrabbable)", () => {
    expect(
      pickValidBounds({
        bounds: { x: -1150, y: -750, width: 1200, height: 800 },
        isMaximized: false,
      }),
    ).toBeNull();
  });

  it("pickValidBounds: accepts bounds that fit a secondary display", () => {
    mockDisplays.mockReturnValue([
      { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
      { workArea: { x: 1920, y: 0, width: 1920, height: 1080 } },
    ]);
    const bounds = { x: 2100, y: 100, width: 1200, height: 800 };
    expect(pickValidBounds({ bounds, isMaximized: false })).toEqual(bounds);
  });
});

interface FakeWin {
  on: (event: string, handler: () => void) => FakeWin;
  getNormalBounds: () => { x: number; y: number; width: number; height: number };
  isMaximized: () => boolean;
  isFullScreen: () => boolean;
  isDestroyed: () => boolean;
}

function makeFakeWin(
  opts: {
    bounds?: { x: number; y: number; width: number; height: number };
    maximized?: boolean;
    fullScreen?: boolean;
    destroyed?: boolean;
  } = {},
): {
  win: FakeWin;
  handlers: Map<string, () => void>;
  setDestroyed: (d: boolean) => void;
  setFullScreen: (f: boolean) => void;
  setMaximized: (m: boolean) => void;
  setBounds: (b: { x: number; y: number; width: number; height: number }) => void;
} {
  const handlers = new Map<string, () => void>();
  let destroyed = opts.destroyed ?? false;
  let fullScreen = opts.fullScreen ?? false;
  let maximized = opts.maximized ?? false;
  let bounds = opts.bounds ?? { x: 100, y: 100, width: 1200, height: 800 };
  const win: FakeWin = {
    on: (event, handler) => {
      handlers.set(event, handler);
      return win;
    },
    getNormalBounds: () => bounds,
    isMaximized: () => maximized,
    isFullScreen: () => fullScreen,
    isDestroyed: () => destroyed,
  };
  return {
    win,
    handlers,
    setDestroyed: (d) => (destroyed = d),
    setFullScreen: (f) => (fullScreen = f),
    setMaximized: (m) => (maximized = m),
    setBounds: (b) => (bounds = b),
  };
}

function readState(): Record<string, unknown> | null {
  const file = path.join(tmpDir, ".marshal-dev", "marshal-window-state.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

describe("attachWindowStateTracking", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces resize and move into a single write after 500ms", () => {
    const { win, handlers } = makeFakeWin();
    attachWindowStateTracking(testDouble<BrowserWindow>(win));

    handlers.get("resize")!();
    vi.advanceTimersByTime(200);
    expect(readState()).toBeNull();
    handlers.get("move")!();
    vi.advanceTimersByTime(200);
    expect(readState()).toBeNull(); // timer was reset by move
    vi.advanceTimersByTime(300);
    // Round-trip through loadWindowState so parseState validates what writeState produced.
    expect(loadWindowState()).toEqual({
      bounds: { x: 100, y: 100, width: 1200, height: 800 },
      isMaximized: false,
    });
  });

  it("captures bounds at fire time, not at listener registration", () => {
    const { win, handlers, setBounds } = makeFakeWin();
    attachWindowStateTracking(testDouble<BrowserWindow>(win));

    handlers.get("resize")!();
    setBounds({ x: 50, y: 60, width: 1400, height: 900 });
    vi.advanceTimersByTime(500);
    expect(loadWindowState()).toEqual({
      bounds: { x: 50, y: 60, width: 1400, height: 900 },
      isMaximized: false,
    });
  });

  it("writes immediately on maximize / unmaximize / leave-full-screen / close, with correct content", () => {
    const { win, handlers, setMaximized } = makeFakeWin();
    attachWindowStateTracking(testDouble<BrowserWindow>(win));
    const file = path.join(tmpDir, ".marshal-dev", "marshal-window-state.json");
    const fullState = {
      bounds: { x: 100, y: 100, width: 1200, height: 800 },
      isMaximized: false,
    };

    setMaximized(true);
    handlers.get("maximize")!();
    expect(readState()).toEqual({ ...fullState, isMaximized: true });

    fs.rmSync(file, { force: true });
    setMaximized(false);
    handlers.get("unmaximize")!();
    expect(readState()).toEqual(fullState);

    fs.rmSync(file, { force: true });
    handlers.get("leave-full-screen")!();
    expect(readState()).toEqual(fullState);

    fs.rmSync(file, { force: true });
    handlers.get("close")!();
    expect(readState()).toEqual(fullState);
  });

  it("close cancels a pending debounced resize (single write)", () => {
    const { win, handlers } = makeFakeWin();
    attachWindowStateTracking(testDouble<BrowserWindow>(win));

    handlers.get("resize")!();
    handlers.get("close")!();
    expect(readState()).not.toBeNull();
    fs.rmSync(path.join(tmpDir, ".marshal-dev", "marshal-window-state.json"));
    vi.advanceTimersByTime(1000);
    expect(readState()).toBeNull();
  });

  it("skips snapshot when window is destroyed", () => {
    const { win, handlers, setDestroyed } = makeFakeWin();
    attachWindowStateTracking(testDouble<BrowserWindow>(win));

    setDestroyed(true);
    handlers.get("close")!();
    expect(readState()).toBeNull();

    handlers.get("resize")!();
    vi.advanceTimersByTime(1000);
    expect(readState()).toBeNull();
  });

  it("does not write while window is fullscreen (avoids saving stale bounds)", () => {
    const { win, handlers, setFullScreen } = makeFakeWin();
    attachWindowStateTracking(testDouble<BrowserWindow>(win));

    setFullScreen(true);
    handlers.get("close")!();
    expect(readState()).toBeNull();

    handlers.get("resize")!();
    vi.advanceTimersByTime(1000);
    expect(readState()).toBeNull();
  });
});
