import * as fs from "fs";

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs");

const mockLoginItemSettings = (openAtLogin: boolean) => ({
  openAtLogin,
  openAsHidden: false,
  wasOpenedAtLogin: false,
  wasOpenedAsHidden: false,
  restoreState: false,
  executableWillLaunchAtLogin: false,
  launchItems: [],
  status: "not-registered" as const,
});

let loginItemState = false;

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn<(name: string) => string>(() => "/tmp/test-userdata"),
    isPackaged: true,
    setLoginItemSettings: vi.fn<(settings: { openAtLogin: boolean }) => void>((settings) => {
      loginItemState = settings.openAtLogin;
    }),
    getLoginItemSettings: vi.fn<() => ReturnType<typeof mockLoginItemSettings>>(() =>
      mockLoginItemSettings(loginItemState),
    ),
  },
}));

const mockedFs = vi.mocked(fs);

beforeEach(() => {
  vi.clearAllMocks();
  loginItemState = false;
  // Restore default mock implementations (clearAllMocks only clears call history)
  vi.mocked(app.setLoginItemSettings).mockImplementation((settings) => {
    loginItemState = !!settings.openAtLogin;
  });
  vi.mocked(app.getLoginItemSettings).mockImplementation(() =>
    mockLoginItemSettings(loginItemState),
  );
  mockedFs.writeFileSync.mockImplementation(() => {});
});

import { app } from "electron";

import { BackgroundServiceManager, LoginItemError } from "./background-service-manager";

describe("BackgroundServiceManager", () => {
  let bsm: BackgroundServiceManager;

  beforeEach(() => {
    bsm = new BackgroundServiceManager();
  });

  describe("load()", () => {
    it("returns defaults when no settings file exists", () => {
      mockedFs.readFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      const settings = bsm.load();
      expect(settings.enabled).toBe(false);
      expect(settings.runOnStartup).toBe(false);
      expect(settings.hideOnLaunch).toBe(false);
    });

    it("returns persisted settings when file exists", () => {
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({ enabled: true, runOnStartup: true, hideOnLaunch: true }),
      );
      const settings = bsm.load();
      expect(settings.enabled).toBe(true);
      expect(settings.runOnStartup).toBe(true);
      expect(settings.hideOnLaunch).toBe(true);
    });

    it("merges partial file with defaults (missing keys use default values)", () => {
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({ enabled: true }));
      const settings = bsm.load();
      expect(settings.enabled).toBe(true);
      expect(settings.runOnStartup).toBe(false); // default
      expect(settings.hideOnLaunch).toBe(false); // default
    });

    it("handles malformed JSON gracefully by returning defaults", () => {
      mockedFs.readFileSync.mockReturnValue("not-json");
      const settings = bsm.load();
      expect(settings.enabled).toBe(false);
    });

    it("returns a copy so internal state cannot be mutated", () => {
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({ enabled: true }));
      const s1 = bsm.load();
      s1.enabled = false;
      const s2 = bsm.get();
      expect(s2.enabled).toBe(true); // internal state unchanged
    });

    it("re-applies setLoginItemSettings on load when runOnStartup=true (packaged)", () => {
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({ runOnStartup: true }));
      bsm.load();
      expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
    });

    it("clears login item on load when runOnStartup=false (packaged)", () => {
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({ runOnStartup: false }));
      bsm.load();
      expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false });
    });

    it("clears login item on load when no settings file / defaults (packaged)", () => {
      mockedFs.readFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      bsm.load();
      expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false });
    });

    it("skips setLoginItemSettings on load when app is not packaged", () => {
      const originalIsPackaged = app.isPackaged;
      try {
        Object.defineProperty(app, "isPackaged", { value: false, configurable: true });
        mockedFs.readFileSync.mockReturnValue(JSON.stringify({ runOnStartup: true }));
        bsm.load();
        expect(app.setLoginItemSettings).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(app, "isPackaged", {
          value: originalIsPackaged,
          configurable: true,
        });
      }
    });
  });

  describe("save()", () => {
    it("persists settings to background-service.json", () => {
      let writtenPath = "";
      let writtenContent = "";
      mockedFs.writeFileSync.mockImplementation((p, content) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test always passes string
        writtenPath = p as string;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test always passes string
        writtenContent = content as string;
      });
      bsm.save({ enabled: true });
      expect(writtenPath).toContain("background-service.json");
      expect(writtenContent).toContain('"enabled": true');
    });

    it("returns updated settings", () => {
      const settings = bsm.save({ enabled: true, hideOnLaunch: true });
      expect(settings.enabled).toBe(true);
      expect(settings.hideOnLaunch).toBe(true);
    });

    it("merges partial updates with existing settings", () => {
      bsm.save({ enabled: true });
      const settings = bsm.save({ runOnStartup: true });
      expect(settings.enabled).toBe(true); // preserved
      expect(settings.runOnStartup).toBe(true); // updated
    });

    it("calls app.setLoginItemSettings when runOnStartup is set to true", () => {
      bsm.save({ runOnStartup: true });
      expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
    });

    it("calls app.setLoginItemSettings when runOnStartup is set to false", () => {
      bsm.save({ runOnStartup: false });
      expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false });
    });

    it("does NOT call app.setLoginItemSettings when runOnStartup is not in the update", () => {
      bsm.save({ enabled: true });
      expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    });

    it("does NOT call app.setLoginItemSettings for hideOnLaunch or enabled changes", () => {
      bsm.save({ hideOnLaunch: true });
      bsm.save({ enabled: true });
      expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    });

    it("skips setLoginItemSettings in save() when app is not packaged", () => {
      const originalIsPackaged = app.isPackaged;
      Object.defineProperty(app, "isPackaged", { value: false, configurable: true });
      try {
        bsm.save({ runOnStartup: true });
        expect(app.setLoginItemSettings).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(app, "isPackaged", {
          value: originalIsPackaged,
          configurable: true,
        });
      }
    });

    it("emits changed with the updated settings payload", () => {
      const listener =
        vi.fn<
          (settings: { enabled: boolean; runOnStartup: boolean; hideOnLaunch: boolean }) => void
        >();
      bsm.on("changed", listener);

      bsm.save({ enabled: true, hideOnLaunch: true });

      expect(listener).toHaveBeenCalledWith({
        enabled: true,
        runOnStartup: false,
        hideOnLaunch: true,
      });
    });

    it("reverts runOnStartup and throws LoginItemError when OS rejects registration", () => {
      // Simulate OS rejecting the registration (setLoginItemSettings succeeds but
      // getLoginItemSettings returns a different value)
      vi.mocked(app.setLoginItemSettings).mockImplementation(() => {
        // no-op: don't actually update the tracked state
      });
      vi.mocked(app.getLoginItemSettings).mockImplementation(() => mockLoginItemSettings(false));

      expect(() => bsm.save({ runOnStartup: true })).toThrow(LoginItemError);
      // Setting should be reverted to match OS state
      expect(bsm.get().runOnStartup).toBe(false);
    });

    it("reverts runOnStartup to prior value when setLoginItemSettings throws (false → true)", () => {
      vi.mocked(app.setLoginItemSettings).mockImplementation(() => {
        throw new Error("OS error");
      });

      expect(() => bsm.save({ runOnStartup: true })).toThrow(LoginItemError);
      expect(bsm.get().runOnStartup).toBe(false);
    });

    it("reverts runOnStartup to prior value when setLoginItemSettings throws (true → false)", () => {
      // First set runOnStartup=true successfully
      bsm.save({ runOnStartup: true });
      expect(bsm.get().runOnStartup).toBe(true);

      // Now make setLoginItemSettings throw when trying to disable
      vi.mocked(app.setLoginItemSettings).mockImplementation(() => {
        throw new Error("OS error");
      });

      expect(() => bsm.save({ runOnStartup: false })).toThrow(LoginItemError);
      // Should revert to true (the prior value), not false
      expect(bsm.get().runOnStartup).toBe(true);
    });
  });

  describe("get()", () => {
    it("returns a copy of current settings", () => {
      bsm.save({ enabled: true });
      const s1 = bsm.get();
      const s2 = bsm.get();
      expect(s1).toEqual(s2);
      expect(s1).not.toBe(s2); // different object references
    });
  });

  describe("isEnabled()", () => {
    it("returns false by default", () => {
      expect(bsm.isEnabled()).toBe(false);
    });

    it("returns true after save({ enabled: true })", () => {
      bsm.save({ enabled: true });
      expect(bsm.isEnabled()).toBe(true);
    });

    it("returns false after save({ enabled: false })", () => {
      bsm.save({ enabled: true });
      bsm.save({ enabled: false });
      expect(bsm.isEnabled()).toBe(false);
    });
  });

  describe("shouldHideOnLaunch()", () => {
    it("returns false by default", () => {
      expect(bsm.shouldHideOnLaunch()).toBe(false);
    });

    it("returns false when enabled=false even if hideOnLaunch=true", () => {
      bsm.save({ enabled: false, hideOnLaunch: true });
      expect(bsm.shouldHideOnLaunch()).toBe(false);
    });

    it("returns false when enabled=true but hideOnLaunch=false", () => {
      bsm.save({ enabled: true, hideOnLaunch: false });
      expect(bsm.shouldHideOnLaunch()).toBe(false);
    });

    it("returns true when both enabled=true and hideOnLaunch=true", () => {
      bsm.save({ enabled: true, hideOnLaunch: true });
      expect(bsm.shouldHideOnLaunch()).toBe(true);
    });
  });
});
