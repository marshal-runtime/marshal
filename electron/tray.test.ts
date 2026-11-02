import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted() initializes variables BEFORE the vi.mock() factory runs (which is hoisted).
// Using vi.fn(impl) rather than vi.fn().mockImplementation(impl) so that
// vi.clearAllMocks() (which resets mockImplementation) doesn't break them.
const { trayStub, menuStub, nativeImageStub } = vi.hoisted(() => ({
  trayStub: {
    setToolTip: vi.fn<(tooltip: string) => void>(),
    setContextMenu: vi.fn<(menu: unknown) => void>(),
    setImage: vi.fn<(image: unknown) => void>(),
    on: vi.fn<(event: string, handler: () => void) => void>(),
    destroy: vi.fn<() => void>(),
  },
  menuStub: {} as Record<string, unknown>,
  nativeImageStub: {
    setTemplateImage: vi.fn<() => void>(),
    isEmpty: vi.fn<() => boolean>(() => false),
  },
}));

vi.mock("electron", () => ({
  // Vitest 4 requires a regular function (not arrow) for constructors used with `new`
  Tray: vi.fn<() => typeof trayStub>(function () {
    return trayStub;
  }),
  Menu: { buildFromTemplate: vi.fn<() => typeof menuStub>(() => menuStub) },
  app: { focus: vi.fn<() => void>() },
  nativeImage: { createFromPath: vi.fn<() => typeof nativeImageStub>(() => nativeImageStub) },
}));

import { Tray, Menu, app, nativeImage } from "electron";
import type { BrowserWindow, MenuItemConstructorOptions } from "electron";

import { testDouble } from "./testing/harness";
import { TrayManager } from "./tray";

const PUBLIC_DIR = "/fake/public";
const mockQuit = vi.fn<() => void>();

function createMockWin(overrides: Record<string, unknown> = {}) {
  return testDouble<
    BrowserWindow & {
      isMinimized: ReturnType<typeof vi.fn<() => boolean>>;
      isVisible: ReturnType<typeof vi.fn<() => boolean>>;
      restore: ReturnType<typeof vi.fn<() => void>>;
      show: ReturnType<typeof vi.fn<() => void>>;
      focus: ReturnType<typeof vi.fn<() => void>>;
      hide: ReturnType<typeof vi.fn<() => void>>;
      setSkipTaskbar: ReturnType<typeof vi.fn<(skip: boolean) => void>>;
      setAlwaysOnTop: ReturnType<typeof vi.fn<(flag: boolean) => void>>;
    }
  >({
    isMinimized: vi.fn<() => boolean>().mockReturnValue(false),
    isVisible: vi.fn<() => boolean>().mockReturnValue(true),
    restore: vi.fn<() => void>(),
    show: vi.fn<() => void>(),
    focus: vi.fn<() => void>(),
    hide: vi.fn<() => void>(),
    setSkipTaskbar: vi.fn<(skip: boolean) => void>(),
    setAlwaysOnTop: vi.fn<(flag: boolean) => void>(),
    ...overrides,
  });
}

let trayMgr: TrayManager;
let mockWin: ReturnType<typeof createMockWin>;

beforeEach(() => {
  vi.clearAllMocks();
  trayMgr = new TrayManager();
  mockWin = createMockWin();
});

// ---------------------------------------------------------------------------
describe("TrayManager.init()", () => {
  it.skipIf(process.platform !== "darwin")(
    "creates a Tray with a template nativeImage on macOS",
    () => {
      trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);
      expect(nativeImage.createFromPath).toHaveBeenCalledWith(
        expect.stringContaining("marshal-tray-template"),
      );
      expect(nativeImageStub.setTemplateImage).toHaveBeenCalledWith(true);
      expect(Tray).toHaveBeenCalledWith(nativeImageStub);
    },
  );

  it.skipIf(process.platform === "darwin")(
    "creates a Tray with a string icon path on non-macOS",
    () => {
      trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);
      expect(Tray).toHaveBeenCalledWith(expect.stringContaining("marshal-app-icon"));
    },
  );

  it('sets an initial tooltip containing "Marshal"', () => {
    trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);
    expect(trayStub.setToolTip).toHaveBeenCalledWith(expect.stringContaining("Marshal"));
  });

  it("builds and sets an initial context menu", () => {
    trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);
    expect(Menu.buildFromTemplate).toHaveBeenCalled();
    expect(trayStub.setContextMenu).toHaveBeenCalledWith(menuStub);
  });

  it("registers a click handler on Windows", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);
    expect(trayStub.on).toHaveBeenCalledWith("click", expect.any(Function));
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("does not register a click handler on macOS", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);
    expect(trayStub.on).not.toHaveBeenCalledWith("click", expect.any(Function));
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("destroys the previous tray when init() is called again", () => {
    trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);
    expect(trayStub.destroy).not.toHaveBeenCalled();

    // Simulate the macOS Dock-click flow: window re-created → init() called again
    trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);
    expect(trayStub.destroy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
describe("TrayManager.setStatus()", () => {
  it("updates tooltip to show the running label", () => {
    trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);
    vi.clearAllMocks();
    trayMgr.setStatus("running", "Automation running...");
    expect(trayStub.setToolTip).toHaveBeenCalledWith("Marshal — Automation running...");
  });

  it("updates tooltip to show the idle label", () => {
    trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);
    vi.clearAllMocks();
    trayMgr.setStatus("idle", "Idle");
    expect(trayStub.setToolTip).toHaveBeenCalledWith("Marshal — Idle");
  });

  it("rebuilds context menu on each status change", () => {
    trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);
    vi.clearAllMocks();
    trayMgr.setStatus("running", "Heartbeat running...");
    trayMgr.setStatus("idle", "Idle");
    expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(2);
  });

  it("does not throw when called before init()", () => {
    const uninit = new TrayManager();
    expect(() => uninit.setStatus("running", "test")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe("TrayManager.showWindow()", () => {
  it("calls show() and focus() on the window", () => {
    trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);
    trayMgr.showWindow();
    expect(mockWin.show).toHaveBeenCalled();
    expect(mockWin.focus).toHaveBeenCalled();
  });

  it("sets skipTaskbar to false", () => {
    trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);
    trayMgr.showWindow();
    expect(mockWin.setSkipTaskbar).toHaveBeenCalledWith(false);
  });

  it("calls setSkipTaskbar(false) before show() so Windows grants focus", () => {
    const order: string[] = [];
    mockWin.setSkipTaskbar.mockImplementation((v: boolean) => {
      if (!v) order.push("setSkipTaskbar");
    });
    mockWin.show.mockImplementation(() => {
      order.push("show");
    });
    trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);
    trayMgr.showWindow();
    expect(order.indexOf("setSkipTaskbar")).toBeLessThan(order.indexOf("show"));
  });

  it("calls app.focus({ steal: true }) on Windows to claim foreground rights", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);
    trayMgr.showWindow();
    expect(app.focus).toHaveBeenCalledWith({ steal: true });
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("calls restore() before show() for minimized windows", () => {
    mockWin.isMinimized.mockReturnValue(true);
    trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);
    trayMgr.showWindow();
    expect(mockWin.restore).toHaveBeenCalled();
    expect(mockWin.show).toHaveBeenCalled();
  });

  it("does not call restore() when window is not minimized", () => {
    trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);
    trayMgr.showWindow();
    expect(mockWin.restore).not.toHaveBeenCalled();
  });

  it("does not throw when called before init()", () => {
    const uninit = new TrayManager();
    expect(() => uninit.showWindow()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe("TrayManager Windows tray-click toggle", () => {
  it("hides visible window and sets skipTaskbar on click", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);

    const clickHandler = trayStub.on.mock.calls.find((c) => c[0] === "click")?.[1] as
      | (() => void)
      | undefined;
    expect(clickHandler).toBeDefined();

    mockWin.isVisible.mockReturnValue(true);
    mockWin.isMinimized.mockReturnValue(false);
    clickHandler!();

    expect(mockWin.hide).toHaveBeenCalled();
    expect(mockWin.setSkipTaskbar).toHaveBeenCalledWith(true);
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("shows hidden window on click", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);

    const clickHandler = trayStub.on.mock.calls.find((c) => c[0] === "click")?.[1] as
      | (() => void)
      | undefined;
    mockWin.isVisible.mockReturnValue(false);
    clickHandler!();

    expect(mockWin.show).toHaveBeenCalled();
    expect(mockWin.focus).toHaveBeenCalled();
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });
});

// ---------------------------------------------------------------------------
describe("TrayManager context menu — Quit action", () => {
  it("calls onQuit when the Quit menu item is clicked", () => {
    trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- accessing mock call args
    const template = vi
      .mocked(Menu.buildFromTemplate)
      .mock.calls.at(-1)?.[0] as MenuItemConstructorOptions[];
    const quitItem = template?.find((item) => item.label === "Quit Marshal");
    expect(quitItem).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- extracting click handler from menu item
    (quitItem!.click as () => void)();
    expect(mockQuit).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("TrayManager.destroy()", () => {
  it("calls destroy() on the underlying Tray instance", () => {
    trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);
    trayMgr.destroy();
    expect(trayStub.destroy).toHaveBeenCalled();
  });

  it("is safe to call when tray was never initialized", () => {
    expect(() => trayMgr.destroy()).not.toThrow();
  });

  it("is safe to call multiple times", () => {
    trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);
    trayMgr.destroy();
    expect(() => trayMgr.destroy()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe("TrayManager.updateIcon()", () => {
  it("does not throw when called before init()", () => {
    const uninit = new TrayManager();
    expect(() => uninit.updateIcon(PUBLIC_DIR, "dev", "tooltip")).not.toThrow();
  });

  it("updates the tooltip", () => {
    trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);
    vi.clearAllMocks();
    trayMgr.updateIcon(PUBLIC_DIR, "dev", "Marshal (Dev) — AI Assistant");
    expect(trayStub.setToolTip).toHaveBeenCalledWith("Marshal (Dev) — AI Assistant");
  });

  it("calls setImage on the tray", () => {
    trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);
    vi.clearAllMocks();
    trayMgr.updateIcon(PUBLIC_DIR, "dev", "tooltip");
    expect(trayStub.setImage).toHaveBeenCalled();
  });

  it.skipIf(process.platform !== "darwin")(
    "loads badged template image for dev mode on macOS",
    () => {
      trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);
      vi.clearAllMocks();
      trayMgr.updateIcon(PUBLIC_DIR, "dev", "tooltip");
      expect(nativeImage.createFromPath).toHaveBeenCalledWith(
        expect.stringContaining("marshal-tray-template-dev.png"),
      );
      // Badged variants are NOT marked as template images (colors would be lost)
      expect(nativeImageStub.setTemplateImage).toHaveBeenCalledWith(false);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "loads badged template image for beta mode on macOS",
    () => {
      trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);
      vi.clearAllMocks();
      trayMgr.updateIcon(PUBLIC_DIR, "beta", "tooltip");
      expect(nativeImage.createFromPath).toHaveBeenCalledWith(
        expect.stringContaining("marshal-tray-template-beta.png"),
      );
      expect(nativeImageStub.setTemplateImage).toHaveBeenCalledWith(false);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "loads stock template image for release mode on macOS and marks as template",
    () => {
      trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);
      vi.clearAllMocks();
      trayMgr.updateIcon(PUBLIC_DIR, "release", "tooltip");
      expect(nativeImage.createFromPath).toHaveBeenCalledWith(
        expect.stringContaining("marshal-tray-template.png"),
      );
      expect(nativeImageStub.setTemplateImage).toHaveBeenCalledWith(true);
    },
  );

  it.skipIf(process.platform === "darwin")(
    "loads badged PNG icon for dev mode on non-macOS",
    () => {
      trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);
      vi.clearAllMocks();
      trayMgr.updateIcon(PUBLIC_DIR, "dev", "tooltip");
      expect(trayStub.setImage).toHaveBeenCalledWith(
        expect.stringContaining("marshal-tray-icon-dev.png"),
      );
    },
  );

  it.skipIf(process.platform === "darwin")(
    "loads stock .ico icon for release mode on non-macOS",
    () => {
      trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);
      vi.clearAllMocks();
      trayMgr.updateIcon(PUBLIC_DIR, "release", "tooltip");
      expect(trayStub.setImage).toHaveBeenCalledWith(
        expect.stringContaining("marshal-app-icon.ico"),
      );
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "keeps current tray icon when badge image is empty on macOS",
    () => {
      trayMgr.init(mockWin, PUBLIC_DIR, mockQuit);
      vi.clearAllMocks();
      nativeImageStub.isEmpty.mockReturnValue(true);
      trayMgr.updateIcon(PUBLIC_DIR, "dev", "Marshal (Dev)");
      // Should not call setImage but should still update tooltip
      expect(trayStub.setImage).not.toHaveBeenCalled();
      expect(trayStub.setToolTip).toHaveBeenCalledWith("Marshal (Dev)");
      nativeImageStub.isEmpty.mockReturnValue(false);
    },
  );
});
