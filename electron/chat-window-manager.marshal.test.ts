// Marshal-owned test
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatWindowManager } from "./chat-window-manager";

const ipcHandleMocks = vi.hoisted(() => ({
  authorizeIpcWebContents: vi.fn<(id: number) => () => void>(),
}));

// Capture every mock BrowserWindow created during the test for assertions.
type MockWin = {
  loadURL: ReturnType<typeof vi.fn>;
  loadFile: ReturnType<typeof vi.fn>;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  once: (event: string, handler: (...args: unknown[]) => void) => void;
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setMenuBarVisibility: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  webContents: {
    id: number;
    send: ReturnType<typeof vi.fn>;
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
    on: (event: string, handler: (...args: unknown[]) => void) => void;
    _emit: (event: string, ...args: unknown[]) => void;
  };
  _emit: (event: string, ...args: unknown[]) => void;
  _ctorOpts: unknown;
};

const createdWindows: MockWin[] = [];

function makeWindow(opts: unknown): MockWin {
  const id = createdWindows.length + 1;
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const wcHandlers = new Map<string, (...args: unknown[]) => void>();
  const win: MockWin = {
    loadURL: vi.fn<(url: string) => Promise<void>>(() => Promise.resolve()),
    loadFile: vi.fn<(path: string, opts?: unknown) => Promise<void>>(() => Promise.resolve()),
    on: (event: string, handler: () => void) => {
      handlers.set(event, handler);
    },
    once: (event: string, handler: () => void) => {
      handlers.set(event, handler);
    },
    show: vi.fn<() => void>(),
    focus: vi.fn<() => void>(),
    close: vi.fn<() => void>(),
    setMenuBarVisibility: vi.fn<(v: boolean) => void>(),
    isDestroyed: vi.fn<() => boolean>(() => false),
    webContents: {
      id,
      send: vi.fn<(channel: string, ...args: unknown[]) => void>(),
      setWindowOpenHandler: vi.fn<(handler: (details: { url: string }) => unknown) => void>(),
      on: (event: string, handler: (...args: unknown[]) => void) => {
        wcHandlers.set(event, handler);
      },
      _emit: (event: string, ...args: unknown[]) => {
        wcHandlers.get(event)?.(...args);
      },
    },
    _emit: (event: string, ...args: unknown[]) => {
      handlers.get(event)?.(...args);
    },
    _ctorOpts: opts,
  };
  createdWindows.push(win);
  return win;
}

// Mock display used for drop-location clamping tests. Tests can reassign
// `mockWorkArea` to simulate different monitors / DPI scaling.
let mockWorkArea = { x: 0, y: 0, width: 1920, height: 1080 };

vi.mock("electron", () => ({
  BrowserWindow: vi.fn<(opts: unknown) => MockWin>().mockImplementation(function (
    this: unknown,
    opts: unknown,
  ) {
    return makeWindow(opts);
  }),
  screen: {
    getDisplayMatching: vi.fn<() => { workArea: typeof mockWorkArea }>(() => ({
      workArea: mockWorkArea,
    })),
  },
}));

vi.mock("./ipc/ipc-handle", () => ({
  authorizeIpcWebContents: ipcHandleMocks.authorizeIpcWebContents,
}));

const openExternalSafeMock = vi.fn<(url: string) => void>();
vi.mock("./open-external", () => ({
  openExternalSafe: (url: string) => openExternalSafeMock(url),
}));

vi.mock("./theme", () => ({ useMacVibrancy: false, resolveThemeBg: () => "#F8F8FB" }));

// Access the mocked module to mutate `useMacVibrancy` in per-test setup.
// vitest mocks expose live-bindable named exports, so changing the property
// on the module object is visible to code that imported it.
import * as themeMod from "./theme";
const themeMock = themeMod as { useMacVibrancy: boolean };

function makeManager(overrides: Partial<ConstructorParameters<typeof ChatWindowManager>[0]> = {}) {
  return new ChatWindowManager({
    preloadPath: "/preload.cjs",
    devServerUrl: undefined,
    rendererDist: "/dist",
    getMainWindow: () => null,
    ...overrides,
  });
}

describe("ChatWindowManager", () => {
  beforeEach(() => {
    createdWindows.length = 0;
    vi.clearAllMocks();
    openExternalSafeMock.mockClear();
    themeMock.useMacVibrancy = false;
    mockWorkArea = { x: 0, y: 0, width: 1920, height: 1080 };
    ipcHandleMocks.authorizeIpcWebContents.mockReset();
    ipcHandleMocks.authorizeIpcWebContents.mockReturnValue(vi.fn<() => void>());
  });

  it("creates a new BrowserWindow with sandboxed webPreferences for a fresh sessionId", () => {
    const manager = makeManager();
    const result = manager.open("session-1");

    expect(result).toEqual({ success: true, alreadyOpen: false });
    expect(createdWindows).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only narrowing of mock ctor opts
    const opts = createdWindows[0]._ctorOpts as {
      webPreferences: { contextIsolation: boolean; nodeIntegration: boolean; sandbox: boolean };
    };
    expect(opts.webPreferences.contextIsolation).toBe(true);
    expect(opts.webPreferences.nodeIntegration).toBe(false);
    expect(opts.webPreferences.sandbox).toBe(true);
  });

  it("applies native window branding when a popout opens", () => {
    const applyWindowBranding = vi.fn<(win: unknown) => void>();
    const manager = makeManager({ applyWindowBranding });

    manager.open("session-1");

    expect(applyWindowBranding).toHaveBeenCalledWith(createdWindows[0]);
  });

  it("prevents renderer title updates from overwriting native popout branding", () => {
    const applyWindowTitle = vi.fn<(win: unknown) => void>();
    const manager = makeManager({ applyWindowTitle });
    manager.open("session-1");
    const event = { preventDefault: vi.fn<() => void>() };

    createdWindows[0]._emit("page-title-updated", event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(applyWindowTitle).toHaveBeenCalledWith(createdWindows[0]);
  });

  it("reapplies native window branding to open popouts", () => {
    const applyWindowBranding = vi.fn<(win: unknown) => void>();
    const manager = makeManager({ applyWindowBranding });
    manager.open("session-1");
    applyWindowBranding.mockClear();

    manager.applyWindowBrandingToPopouts();

    expect(applyWindowBranding).toHaveBeenCalledWith(createdWindows[0]);
  });

  it("loads the dev server URL with a popout query param when running with Vite", () => {
    const manager = makeManager({ devServerUrl: "http://localhost:5173" });
    manager.open("session-abc");

    expect(createdWindows[0].loadURL).toHaveBeenCalledWith(
      "http://localhost:5173/?popout=session-abc",
    );
    expect(createdWindows[0].loadFile).not.toHaveBeenCalled();
  });

  it("loads the packaged index.html with the popout query param in production", () => {
    const manager = makeManager({ devServerUrl: undefined, rendererDist: "/app/dist" });
    manager.open("session-xyz");

    expect(createdWindows[0].loadURL).toHaveBeenCalledWith(
      "marshal://app/index.html?popout=session-xyz",
    );
    expect(createdWindows[0].loadFile).not.toHaveBeenCalled();
  });

  it("URL-encodes session ids with reserved characters in production", () => {
    const manager = makeManager({ devServerUrl: undefined, rendererDist: "/app/dist" });
    manager.open("a/b?c=d");

    expect(createdWindows[0].loadURL).toHaveBeenCalledWith(
      "marshal://app/index.html?popout=a%2Fb%3Fc%3Dd",
    );
    expect(createdWindows[0].loadFile).not.toHaveBeenCalled();
  });

  it("URL-encodes session ids that contain reserved characters", () => {
    const manager = makeManager({ devServerUrl: "http://localhost:5173" });
    manager.open("a/b?c=d");

    expect(createdWindows[0].loadURL).toHaveBeenCalledWith(
      "http://localhost:5173/?popout=a%2Fb%3Fc%3Dd",
    );
  });

  it("focuses the existing popout instead of creating a duplicate when the same session is opened twice", () => {
    const manager = makeManager();
    const first = manager.open("session-1");
    const second = manager.open("session-1");

    expect(first).toEqual({ success: true, alreadyOpen: false });
    expect(second).toEqual({ success: true, alreadyOpen: true });
    expect(createdWindows).toHaveLength(1);
    expect(createdWindows[0].show).toHaveBeenCalledOnce();
    expect(createdWindows[0].focus).toHaveBeenCalledOnce();
  });

  it("creates a fresh popout after the previous one was closed", () => {
    const manager = makeManager();
    manager.open("session-1");
    createdWindows[0]._emit("closed");

    manager.open("session-1");

    expect(createdWindows).toHaveLength(2);
  });

  it("authorizes popout IPC while the window is open and deauthorizes it on close", () => {
    const deauthorize = vi.fn<() => void>();
    ipcHandleMocks.authorizeIpcWebContents.mockReturnValueOnce(deauthorize);
    const manager = makeManager();

    manager.open("session-1");

    expect(ipcHandleMocks.authorizeIpcWebContents).toHaveBeenCalledWith(
      createdWindows[0].webContents.id,
    );
    expect(deauthorize).not.toHaveBeenCalled();

    createdWindows[0]._emit("closed");

    expect(deauthorize).toHaveBeenCalledOnce();
  });

  it("treats a destroyed-but-not-yet-cleaned-up popout as gone and creates a new window", () => {
    const manager = makeManager();
    manager.open("session-1");
    createdWindows[0].isDestroyed.mockReturnValue(true);

    const result = manager.open("session-1");

    expect(result).toEqual({ success: true, alreadyOpen: false });
    expect(createdWindows).toHaveLength(2);
  });

  it("broadcasts to the main window and every open popout", () => {
    const mainWebContents = { send: vi.fn<(channel: string, ...args: unknown[]) => void>() };
    const mainWin = { isDestroyed: () => false, webContents: mainWebContents };
    const manager = makeManager({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion -- test stub
      getMainWindow: () => mainWin as any,
    });
    manager.open("session-1");
    manager.open("session-2");

    manager.broadcast("session:view", { sessionId: "session-1", view: "snapshot" });

    expect(mainWebContents.send).toHaveBeenCalledWith("session:view", {
      sessionId: "session-1",
      view: "snapshot",
    });
    expect(createdWindows[0].webContents.send).toHaveBeenCalledWith("session:view", {
      sessionId: "session-1",
      view: "snapshot",
    });
    expect(createdWindows[1].webContents.send).toHaveBeenCalledWith("session:view", {
      sessionId: "session-1",
      view: "snapshot",
    });
  });

  it("skips the main window in broadcast when it is missing or destroyed", () => {
    const manager = makeManager({ getMainWindow: () => null });
    manager.open("session-1");

    expect(() => manager.broadcast("session:view", {})).not.toThrow();
    expect(createdWindows[0].webContents.send).toHaveBeenCalledWith("session:view", {});
  });

  it("skips destroyed popouts during broadcast", () => {
    const manager = makeManager();
    manager.open("session-1");
    manager.open("session-2");
    createdWindows[0].isDestroyed.mockReturnValue(true);

    manager.broadcast("sessions:list-changed");

    expect(createdWindows[0].webContents.send).not.toHaveBeenCalled();
    expect(createdWindows[1].webContents.send).toHaveBeenCalledWith("sessions:list-changed");
  });

  it("closes every tracked popout on closeAll() and clears tracking state", () => {
    const manager = makeManager();
    manager.open("session-1");
    manager.open("session-2");

    manager.closeAll();

    expect(createdWindows[0].close).toHaveBeenCalledOnce();
    expect(createdWindows[1].close).toHaveBeenCalledOnce();

    // After closeAll, opening session-1 again must create a fresh window.
    manager.open("session-1");
    expect(createdWindows).toHaveLength(3);
  });

  it("skips already-destroyed popouts on closeAll() rather than throwing", () => {
    const manager = makeManager();
    manager.open("session-1");
    createdWindows[0].isDestroyed.mockReturnValue(true);

    expect(() => manager.closeAll()).not.toThrow();
    expect(createdWindows[0].close).not.toHaveBeenCalled();
  });

  describe("window chrome (shared header with main window)", () => {
    const originalPlatform = process.platform;

    it("creates frameless popouts on Windows so the renderer's <Header /> draws the titlebar", () => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        const manager = makeManager();
        manager.open("session-1");

        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only narrowing
        const opts = createdWindows[0]._ctorOpts as { frame?: boolean; thickFrame?: boolean };
        expect(opts.frame).toBe(false);
        expect(opts.thickFrame).toBe(true);
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      }
    });

    it("uses hiddenInset titlebar on macOS so the shared <Header /> sits flush with traffic lights", () => {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      try {
        const manager = makeManager();
        manager.open("session-1");

        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only narrowing
        const opts = createdWindows[0]._ctorOpts as {
          titleBarStyle?: string;
          trafficLightPosition?: { x: number; y: number };
          frame?: boolean;
        };
        expect(opts.titleBarStyle).toBe("hiddenInset");
        expect(opts.trafficLightPosition).toEqual({ x: 16, y: 17 });
        expect(opts.frame).toBeUndefined();
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      }
    });

    it("broadcasts maximized-changed to the popout's own webContents when it maximizes", () => {
      const manager = makeManager();
      manager.open("session-1");
      const win = createdWindows[0];
      // Mock state: simulate "now maximized".
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only narrowing
      const wMutable = win as unknown as { isMaximized: () => boolean };
      wMutable.isMaximized = () => true;

      win._emit("maximize");

      expect(win.webContents.send).toHaveBeenCalledWith("window-controls:maximized-changed", true);
    });

    it("broadcasts maximized-changed=false when the popout unmaximizes", () => {
      const manager = makeManager();
      manager.open("session-1");
      const win = createdWindows[0];
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only narrowing
      const wMutable = win as unknown as { isMaximized: () => boolean };
      wMutable.isMaximized = () => false;

      win._emit("unmaximize");

      expect(win.webContents.send).toHaveBeenCalledWith("window-controls:maximized-changed", false);
    });

    it("broadcasts fullscreen-changed=true to the popout when it enters full screen", () => {
      const manager = makeManager();
      manager.open("session-1");
      const win = createdWindows[0];
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only narrowing
      const wMutable = win as unknown as { isFullScreen: () => boolean };
      wMutable.isFullScreen = () => true;

      win._emit("enter-full-screen");

      expect(win.webContents.send).toHaveBeenCalledWith("window-controls:fullscreen-changed", true);
    });

    it("broadcasts fullscreen-changed=false when the popout leaves full screen", () => {
      const manager = makeManager();
      manager.open("session-1");
      const win = createdWindows[0];
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only narrowing
      const wMutable = win as unknown as { isFullScreen: () => boolean };
      wMutable.isFullScreen = () => false;

      win._emit("leave-full-screen");

      expect(win.webContents.send).toHaveBeenCalledWith(
        "window-controls:fullscreen-changed",
        false,
      );
    });

    it("does not broadcast window-control events to a destroyed popout", () => {
      const manager = makeManager();
      manager.open("session-1");
      const win = createdWindows[0];
      win.isDestroyed.mockReturnValue(true);

      win._emit("maximize");
      win._emit("enter-full-screen");

      expect(win.webContents.send).not.toHaveBeenCalled();
    });
  });

  describe("navigation guards (chat-message links must open externally)", () => {
    it("denies child windows opened by anchors / window.open and routes the URL externally", () => {
      const manager = makeManager();
      manager.open("session-1");
      const win = createdWindows[0];

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrow mock handler arg for assertion
      const calls = win.webContents.setWindowOpenHandler.mock.calls as unknown as Array<
        [(details: { url: string }) => { action: string }]
      >;
      const handler = calls[0]?.[0];
      const result = handler?.({ url: "https://example.com" });

      expect(result).toEqual({ action: "deny" });
      expect(openExternalSafeMock).toHaveBeenCalledWith("https://example.com");
    });

    it("intercepts in-place navigation (markdown link clicks) and opens it externally instead", () => {
      const manager = makeManager();
      manager.open("session-1");
      const win = createdWindows[0];

      const event = { preventDefault: vi.fn<() => void>() };
      win.webContents._emit("will-navigate", event, "https://example.com");

      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(openExternalSafeMock).toHaveBeenCalledWith("https://example.com");
    });

    it("allows Vite dev-server reloads through (HMR full-reload fallback)", () => {
      const manager = makeManager({ devServerUrl: "http://localhost:5173" });
      manager.open("session-1");
      const win = createdWindows[0];

      const event = { preventDefault: vi.fn<() => void>() };
      win.webContents._emit("will-navigate", event, "http://localhost:5173/?popout=session-1");

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(openExternalSafeMock).not.toHaveBeenCalled();
    });

    it("blocks dev-server-looking URLs on sibling ports", () => {
      const manager = makeManager({ devServerUrl: "http://localhost:5173" });
      manager.open("session-1");
      const win = createdWindows[0];

      const event = { preventDefault: vi.fn<() => void>() };
      win.webContents._emit("will-navigate", event, "http://localhost:51730/?popout=session-1");

      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(openExternalSafeMock).toHaveBeenCalledWith("http://localhost:51730/?popout=session-1");
    });
  });

  describe("drop-location positioning (drag-to-popout)", () => {
    it("constructs the popout near the drop coords (offset to avoid the cursor) when bounds are provided", () => {
      const manager = makeManager();
      // Drop at (600, 100) on a 1920x1080 display fits a 720x800 window
      // without clamping — the bare math wins and we get drop - cursor offset.
      manager.open("session-1", { x: 600, y: 100 });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only narrowing
      const opts = createdWindows[0]._ctorOpts as { x?: number; y?: number };
      // Drop coords minus the documented cursor offset (40, 20).
      expect(opts.x).toBe(560);
      expect(opts.y).toBe(80);
    });

    it("does not set x/y when bounds are omitted (overflow menu uses OS-default placement)", () => {
      const manager = makeManager();
      manager.open("session-1");

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only narrowing
      const opts = createdWindows[0]._ctorOpts as { x?: number; y?: number };
      expect(opts.x).toBeUndefined();
      expect(opts.y).toBeUndefined();
    });

    it("clamps to the display right edge when the drop is past the workArea", () => {
      mockWorkArea = { x: 0, y: 0, width: 1920, height: 1080 };
      const manager = makeManager();
      // Drop way to the right of the display. Without clamping the window's x
      // would land off-screen; clamped, it should sit flush against the right
      // edge minus its own width (720).
      manager.open("session-1", { x: 99999, y: 200 });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only narrowing
      const opts = createdWindows[0]._ctorOpts as { x?: number; y?: number };
      expect(opts.x).toBe(1920 - 720);
      expect(opts.y).toBe(180);
    });

    it("clamps to the display origin when the drop is to the left/above the workArea", () => {
      mockWorkArea = { x: 100, y: 50, width: 1920, height: 1080 };
      const manager = makeManager();
      // Drop just inside the workArea origin. With the (40, 20) cursor offset
      // the bare math would put the window at (60, 30) — below the workArea
      // origin — so clamping pins it to (100, 50).
      manager.open("session-1", { x: 110, y: 60 });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only narrowing
      const opts = createdWindows[0]._ctorOpts as { x?: number; y?: number };
      expect(opts.x).toBe(100);
      expect(opts.y).toBe(50);
    });
  });

  describe("macOS vibrancy (docs/architecture/14-marshal-macos-vibrancy.md)", () => {
    it("sets vibrancy BrowserWindow options on macOS", () => {
      themeMock.useMacVibrancy = true;
      const manager = makeManager();
      manager.open("session-1");

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only narrowing
      const opts = createdWindows[0]._ctorOpts as {
        transparent?: boolean;
        vibrancy?: string;
        visualEffectState?: string;
      };
      expect(opts.transparent).toBe(false);
      expect(opts.vibrancy).toBe("under-window");
      expect(opts.visualEffectState).toBe("followWindow");
    });

    it("does not set vibrancy options on non-macOS platforms", () => {
      themeMock.useMacVibrancy = false;
      const manager = makeManager();
      manager.open("session-1");

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only narrowing
      const opts = createdWindows[0]._ctorOpts as {
        transparent?: boolean;
        vibrancy?: string;
        visualEffectState?: string;
      };
      expect(opts.transparent).toBe(false);
      expect(opts.vibrancy).toBeUndefined();
      expect(opts.visualEffectState).toBeUndefined();
    });
  });
});
