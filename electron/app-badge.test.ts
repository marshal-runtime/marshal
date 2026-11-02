import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Electron stubs ──────────────────────────────────────────────────────────

const { appStub, nativeImageStub } = vi.hoisted(() => ({
  appStub: {
    dock: {
      setIcon: vi.fn<(image: unknown) => void>(),
    },
  },
  nativeImageStub: {
    createFromPath: vi.fn<(path: string) => unknown>(() => ({ fake: "nativeImage" })),
  },
}));

const { isDevModeMock } = vi.hoisted(() => ({
  isDevModeMock: vi.fn<() => boolean>(() => false),
}));

vi.mock("electron", () => ({
  app: appStub,
  nativeImage: nativeImageStub,
}));

vi.mock("./app-paths", () => ({
  isDevMode: isDevModeMock,
}));

import type { BrowserWindow } from "electron";

import { getAppMode, applyAppBadge, applyWindowTitle } from "./app-badge";
import { testDouble } from "./testing/harness";
import type { TrayManager } from "./tray";

// ── Test helpers ────────────────────────────────────────────────────────────

function createMockWin() {
  return testDouble<BrowserWindow>({
    setTitle: vi.fn<(title: string) => void>(),
    setIcon: vi.fn<(icon: unknown) => void>(),
    setOverlayIcon: vi.fn<(overlay: unknown, description: string) => void>(),
    isVisible: vi.fn<() => boolean>().mockReturnValue(true),
    isDestroyed: vi.fn<() => boolean>().mockReturnValue(false),
    once: vi.fn<(event: string, cb: () => void) => BrowserWindow>(),
  });
}

function createMockTrayManager() {
  return testDouble<TrayManager>({
    updateIcon: vi.fn<(publicDir: string, mode: string, tooltip: string) => void>(),
  });
}

const PUBLIC_DIR = "/fake/public";

// ── getAppMode ──────────────────────────────────────────────────────────────

describe("getAppMode()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns "dev" when isDevMode() is true, regardless of beta list', () => {
    isDevModeMock.mockReturnValue(true);
    expect(getAppMode("0.22.97", ["0.22.97"])).toBe("dev");
    expect(getAppMode("0.22.97", [])).toBe("dev");
  });

  it('returns "beta" when version is in the beta list', () => {
    isDevModeMock.mockReturnValue(false);
    expect(getAppMode("0.22.97", ["0.22.96", "0.22.97", "0.22.98"])).toBe("beta");
  });

  it('returns "release" when version is not in the beta list', () => {
    isDevModeMock.mockReturnValue(false);
    expect(getAppMode("0.22.97", ["0.22.96", "0.22.98"])).toBe("release");
  });

  it('returns "release" when beta list is empty', () => {
    isDevModeMock.mockReturnValue(false);
    expect(getAppMode("0.22.97", [])).toBe("release");
  });
});

// ── applyAppBadge — window title ────────────────────────────────────────────

describe("applyAppBadge() — window title", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets title to "Marshal (Dev)" for dev mode', () => {
    const win = createMockWin();
    const tray = createMockTrayManager();
    applyAppBadge("dev", win, tray, PUBLIC_DIR);
    expect(win.setTitle).toHaveBeenCalledWith("Marshal (Dev)");
  });

  it('sets title to "Marshal (Beta)" for beta mode', () => {
    const win = createMockWin();
    const tray = createMockTrayManager();
    applyAppBadge("beta", win, tray, PUBLIC_DIR);
    expect(win.setTitle).toHaveBeenCalledWith("Marshal (Beta)");
  });

  it('sets title to "Marshal" for release mode', () => {
    const win = createMockWin();
    const tray = createMockTrayManager();
    applyAppBadge("release", win, tray, PUBLIC_DIR);
    expect(win.setTitle).toHaveBeenCalledWith("Marshal");
  });
});

describe("applyWindowTitle()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates only the native window title for beta mode", () => {
    const win = createMockWin();
    applyWindowTitle("beta", win);
    expect(win.setTitle).toHaveBeenCalledWith("Marshal (Beta)");
    expect(win.setIcon).not.toHaveBeenCalled();
    expect(win.setOverlayIcon).not.toHaveBeenCalled();
    expect(nativeImageStub.createFromPath).not.toHaveBeenCalled();
  });
});

// ── applyAppBadge — tray ────────────────────────────────────────────────────

describe("applyAppBadge() — tray icon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls trayManager.updateIcon with mode and tooltip for dev", () => {
    const win = createMockWin();
    const tray = createMockTrayManager();
    applyAppBadge("dev", win, tray, PUBLIC_DIR);
    expect(tray.updateIcon).toHaveBeenCalledWith(PUBLIC_DIR, "dev", "Marshal (Dev) — AI Assistant");
  });

  it("calls trayManager.updateIcon with mode and tooltip for beta", () => {
    const win = createMockWin();
    const tray = createMockTrayManager();
    applyAppBadge("beta", win, tray, PUBLIC_DIR);
    expect(tray.updateIcon).toHaveBeenCalledWith(
      PUBLIC_DIR,
      "beta",
      "Marshal (Beta) — AI Assistant",
    );
  });

  it("calls trayManager.updateIcon with release tooltip", () => {
    const win = createMockWin();
    const tray = createMockTrayManager();
    applyAppBadge("release", win, tray, PUBLIC_DIR);
    expect(tray.updateIcon).toHaveBeenCalledWith(PUBLIC_DIR, "release", "Marshal — AI Assistant");
  });
});

// ── applyAppBadge — macOS dock ──────────────────────────────────────────────
// Platform-specific icon-surface tests follow the established convention in this file:
// they run only on matching developer platforms.

describe("applyAppBadge() — macOS dock icon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.skipIf(process.platform !== "darwin")(
    "sets dock icon to marshal-app-icon-dev.png for dev mode",
    () => {
      const win = createMockWin();
      const tray = createMockTrayManager();
      applyAppBadge("dev", win, tray, PUBLIC_DIR);
      expect(nativeImageStub.createFromPath).toHaveBeenCalledWith(
        expect.stringContaining("marshal-app-icon-dev.png"),
      );
      expect(appStub.dock.setIcon).toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "sets dock icon to marshal-app-icon-beta.png for beta mode",
    () => {
      const win = createMockWin();
      const tray = createMockTrayManager();
      applyAppBadge("beta", win, tray, PUBLIC_DIR);
      expect(nativeImageStub.createFromPath).toHaveBeenCalledWith(
        expect.stringContaining("marshal-app-icon-beta.png"),
      );
      expect(appStub.dock.setIcon).toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform !== "darwin")("restores stock dock icon for release mode", () => {
    const win = createMockWin();
    const tray = createMockTrayManager();
    applyAppBadge("release", win, tray, PUBLIC_DIR);
    expect(nativeImageStub.createFromPath).toHaveBeenCalledWith(
      expect.stringContaining("marshal-app-icon.png"),
    );
    expect(appStub.dock.setIcon).toHaveBeenCalled();
  });
});

// ── applyAppBadge — Windows icon surfaces ───────────────────────────────────

describe("applyAppBadge() — Windows icon surfaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.skipIf(process.platform !== "win32")("sets the canonical icon and dev overlay", () => {
    const win = createMockWin();
    const tray = createMockTrayManager();
    applyAppBadge("dev", win, tray, PUBLIC_DIR);
    expect(nativeImageStub.createFromPath).toHaveBeenCalledWith(
      expect.stringContaining("marshal-app-icon.ico"),
    );
    expect(win.setIcon).toHaveBeenCalledWith(nativeImageStub.createFromPath.mock.results[0].value);
    expect(win.setOverlayIcon).toHaveBeenCalledWith(expect.anything(), "Dev Build");
  });

  it.skipIf(process.platform !== "win32")("sets the canonical icon and beta overlay", () => {
    const win = createMockWin();
    const tray = createMockTrayManager();
    applyAppBadge("beta", win, tray, PUBLIC_DIR);
    expect(nativeImageStub.createFromPath).toHaveBeenCalledWith(
      expect.stringContaining("marshal-app-icon.ico"),
    );
    expect(win.setIcon).toHaveBeenCalledWith(nativeImageStub.createFromPath.mock.results[0].value);
    expect(win.setOverlayIcon).toHaveBeenCalledWith(expect.anything(), "Beta Build");
  });

  it.skipIf(process.platform !== "win32")(
    "restores stock icon and clears overlay for release",
    () => {
      const win = createMockWin();
      const tray = createMockTrayManager();
      applyAppBadge("release", win, tray, PUBLIC_DIR);
      expect(nativeImageStub.createFromPath).toHaveBeenCalledWith(
        expect.stringContaining("marshal-app-icon.ico"),
      );
      expect(win.setIcon).toHaveBeenCalledWith(
        nativeImageStub.createFromPath.mock.results[0].value,
      );
      expect(win.setOverlayIcon).toHaveBeenCalledWith(null, "");
    },
  );

  it.skipIf(process.platform !== "win32")(
    "defers overlay until window is shown when not yet visible",
    () => {
      vi.useFakeTimers();
      let capturedShowCb: (() => void) | undefined;
      const onceMock = vi
        .fn<(event: string, cb: () => void) => BrowserWindow>()
        .mockImplementation((_event, cb) => {
          capturedShowCb = cb;
          return null as unknown as BrowserWindow; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- test stub, return value unused
        });
      const win = testDouble<BrowserWindow>({
        setTitle: vi.fn<(title: string) => void>(),
        setIcon: vi.fn<(icon: unknown) => void>(),
        setOverlayIcon: vi.fn<(overlay: unknown, description: string) => void>(),
        isVisible: vi.fn<() => boolean>().mockReturnValue(false),
        isDestroyed: vi.fn<() => boolean>().mockReturnValue(false),
        once: onceMock,
      });
      const tray = createMockTrayManager();
      applyAppBadge("dev", win, tray, PUBLIC_DIR);

      // Overlay should NOT be set yet — window isn't visible
      expect(win.setOverlayIcon).not.toHaveBeenCalled();
      expect(win.once).toHaveBeenCalled();

      // Simulate the window becoming visible
      capturedShowCb!();
      vi.advanceTimersByTime(500);

      expect(nativeImageStub.createFromPath).toHaveBeenCalledWith(
        expect.stringContaining("marshal-app-icon-dev-overlay.png"),
      );
      expect(win.setOverlayIcon).toHaveBeenCalledWith(expect.anything(), "Dev Build");
      vi.useRealTimers();
    },
  );

  it.skipIf(process.platform !== "win32")(
    "does not stack duplicate deferred overlay handlers before first show",
    () => {
      vi.useFakeTimers();
      let capturedShowCb: (() => void) | undefined;
      const onceMock = vi
        .fn<(event: string, cb: () => void) => BrowserWindow>()
        .mockImplementation((_event, cb) => {
          capturedShowCb = cb;
          return null as unknown as BrowserWindow; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- test stub, return value unused
        });
      const win = testDouble<BrowserWindow>({
        setTitle: vi.fn<(title: string) => void>(),
        setIcon: vi.fn<(icon: unknown) => void>(),
        setOverlayIcon: vi.fn<(overlay: unknown, description: string) => void>(),
        isVisible: vi.fn<() => boolean>().mockReturnValue(false),
        isDestroyed: vi.fn<() => boolean>().mockReturnValue(false),
        once: onceMock,
      });
      const tray = createMockTrayManager();

      applyAppBadge("dev", win, tray, PUBLIC_DIR);
      applyAppBadge("dev", win, tray, PUBLIC_DIR);

      expect(win.once).toHaveBeenCalledOnce();
      capturedShowCb!();
      vi.advanceTimersByTime(500);
      expect(win.setOverlayIcon).toHaveBeenCalledOnce();
      vi.useRealTimers();
    },
  );

  it.skipIf(process.platform !== "win32")(
    "skips deferred overlay when the window is destroyed before the timer fires",
    () => {
      vi.useFakeTimers();
      let capturedShowCb: (() => void) | undefined;
      const onceMock = vi
        .fn<(event: string, cb: () => void) => BrowserWindow>()
        .mockImplementation((_event, cb) => {
          capturedShowCb = cb;
          return null as unknown as BrowserWindow; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- test stub, return value unused
        });
      const isDestroyedMock = vi.fn<() => boolean>().mockReturnValue(false);
      const win = testDouble<BrowserWindow>({
        setTitle: vi.fn<(title: string) => void>(),
        setIcon: vi.fn<(icon: unknown) => void>(),
        setOverlayIcon: vi.fn<(overlay: unknown, description: string) => void>(),
        isVisible: vi.fn<() => boolean>().mockReturnValue(false),
        isDestroyed: isDestroyedMock,
        once: onceMock,
      });
      const tray = createMockTrayManager();

      applyAppBadge("dev", win, tray, PUBLIC_DIR);
      capturedShowCb!();
      isDestroyedMock.mockReturnValue(true);
      vi.advanceTimersByTime(500);

      expect(win.setOverlayIcon).not.toHaveBeenCalled();
      vi.useRealTimers();
    },
  );
});
