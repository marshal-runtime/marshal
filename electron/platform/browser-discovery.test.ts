import { execSync } from "child_process";
import { lstatSync } from "fs";
import { platform } from "os";

import { describe, it, expect, vi, beforeEach } from "vitest";

import { testDouble } from "../testing/harness";

vi.mock("fs", () => ({
  lstatSync: vi.fn<typeof lstatSync>(),
}));

vi.mock("os", () => ({
  platform: vi.fn<() => string>(() => "win32"),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn<(command: string) => string | Buffer>(),
}));

const mockedLstat = vi.mocked(lstatSync);
const mockedPlatform = vi.mocked(platform);
const mockedExecSync = vi.mocked(execSync);

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.MARSHAL_BROWSER_PATH;
  delete process.env.MARSHAL_BROWSER_CHANNEL;
});

describe("detectBrowser", () => {
  async function load() {
    vi.resetModules();
    return import("./browser-discovery");
  }

  it("returns env var override with default msedge channel", async () => {
    process.env.MARSHAL_BROWSER_PATH = "/custom/edge";
    const { detectBrowser } = await load();
    expect(detectBrowser()).toEqual({ path: "/custom/edge", channel: "msedge" });
  });

  it("returns env var override with custom channel", async () => {
    process.env.MARSHAL_BROWSER_PATH = "/usr/bin/google-chrome";
    process.env.MARSHAL_BROWSER_CHANNEL = "chrome";
    const { detectBrowser } = await load();
    expect(detectBrowser()).toEqual({ path: "/usr/bin/google-chrome", channel: "chrome" });
  });

  it("returns Edge Stable on Windows when present", async () => {
    mockedPlatform.mockReturnValue("win32");
    mockedLstat.mockImplementation((p) => {
      if (p === "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe") {
        return testDouble<ReturnType<typeof lstatSync>>({});
      }
      throw new Error("ENOENT");
    });
    const { detectBrowser } = await load();
    const result = detectBrowser();
    expect(result.path).toBe("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");
    expect(result.channel).toBe("msedge");
  });

  it("falls through to Edge Beta when Stable is missing", async () => {
    mockedPlatform.mockReturnValue("win32");
    mockedLstat.mockImplementation((p) => {
      if (String(p).includes("Edge Beta")) return testDouble<ReturnType<typeof lstatSync>>({});
      throw new Error("ENOENT");
    });
    const { detectBrowser } = await load();
    const result = detectBrowser();
    expect(result.path).toContain("Edge Beta");
    expect(result.channel).toBe("msedge-beta");
  });

  it("falls through to Edge Dev when Stable and Beta are missing", async () => {
    mockedPlatform.mockReturnValue("win32");
    mockedLstat.mockImplementation((p) => {
      if (String(p).includes("Edge Dev")) return testDouble<ReturnType<typeof lstatSync>>({});
      throw new Error("ENOENT");
    });
    const { detectBrowser } = await load();
    const result = detectBrowser();
    expect(result.path).toContain("Edge Dev");
    expect(result.channel).toBe("msedge-dev");
  });

  it("falls through to Chrome when no Edge variant is found", async () => {
    mockedPlatform.mockReturnValue("win32");
    mockedLstat.mockImplementation((p) => {
      if (String(p).includes("Chrome")) return testDouble<ReturnType<typeof lstatSync>>({});
      throw new Error("ENOENT");
    });
    const { detectBrowser } = await load();
    const result = detectBrowser();
    expect(result.path).toContain("Chrome");
    expect(result.channel).toBe("chrome");
  });

  it("returns first candidate when nothing is found", async () => {
    mockedPlatform.mockReturnValue("win32");
    mockedLstat.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const { detectBrowser } = await load();
    const result = detectBrowser();
    expect(result.path).toBe("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");
    expect(result.channel).toBe("msedge");
  });

  it("returns macOS Edge Beta path", async () => {
    mockedPlatform.mockReturnValue("darwin");
    mockedLstat.mockImplementation((p) => {
      if (String(p).includes("Edge Beta")) return testDouble<ReturnType<typeof lstatSync>>({});
      throw new Error("ENOENT");
    });
    const { detectBrowser } = await load();
    const result = detectBrowser();
    expect(result.path).toBe(
      "/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta",
    );
    expect(result.channel).toBe("msedge-beta");
  });

  it("returns Linux edge-dev path", async () => {
    mockedPlatform.mockReturnValue("linux");
    mockedLstat.mockImplementation((p) => {
      if (p === "/usr/bin/microsoft-edge-dev") return testDouble<ReturnType<typeof lstatSync>>({});
      throw new Error("ENOENT");
    });
    const { detectBrowser } = await load();
    const result = detectBrowser();
    expect(result.path).toBe("/usr/bin/microsoft-edge-dev");
    expect(result.channel).toBe("msedge-dev");
  });
});

describe("getDefaultEdgeChannel", () => {
  async function load() {
    vi.resetModules();
    return import("./browser-discovery");
  }

  it("returns msedge-beta when Windows registry has MSEdgeBHTML", async () => {
    mockedPlatform.mockReturnValue("win32");
    mockedExecSync.mockReturnValue("    ProgId    REG_SZ    MSEdgeBHTML\r\n");
    const { getDefaultEdgeChannel } = await load();
    expect(getDefaultEdgeChannel()).toBe("msedge-beta");
  });

  it("returns msedge-dev when Windows registry has MSEdgeDHTML", async () => {
    mockedPlatform.mockReturnValue("win32");
    mockedExecSync.mockReturnValue("    ProgId    REG_SZ    MSEdgeDHTML\r\n");
    const { getDefaultEdgeChannel } = await load();
    expect(getDefaultEdgeChannel()).toBe("msedge-dev");
  });

  it("returns msedge when Windows registry has MSEdgeHTM", async () => {
    mockedPlatform.mockReturnValue("win32");
    mockedExecSync.mockReturnValue("    ProgId    REG_SZ    MSEdgeHTM\r\n");
    const { getDefaultEdgeChannel } = await load();
    expect(getDefaultEdgeChannel()).toBe("msedge");
  });

  it("returns null when default is Firefox on Windows", async () => {
    mockedPlatform.mockReturnValue("win32");
    mockedExecSync.mockReturnValue("    ProgId    REG_SZ    FirefoxURL-308046B0AF4A39CB\r\n");
    const { getDefaultEdgeChannel } = await load();
    expect(getDefaultEdgeChannel()).toBeNull();
  });

  it("returns null when registry query fails", async () => {
    mockedPlatform.mockReturnValue("win32");
    mockedExecSync.mockImplementation(() => {
      throw new Error("Command failed");
    });
    const { getDefaultEdgeChannel } = await load();
    expect(getDefaultEdgeChannel()).toBeNull();
  });

  it("returns msedge-beta on macOS when default is Edge Beta", async () => {
    mockedPlatform.mockReturnValue("darwin");
    mockedExecSync.mockReturnValue("/Applications/Microsoft Edge Beta.app\n");
    const { getDefaultEdgeChannel } = await load();
    expect(getDefaultEdgeChannel()).toBe("msedge-beta");
  });

  it("returns null on macOS when default is Safari", async () => {
    mockedPlatform.mockReturnValue("darwin");
    mockedExecSync.mockReturnValue("/Applications/Safari.app\n");
    const { getDefaultEdgeChannel } = await load();
    expect(getDefaultEdgeChannel()).toBeNull();
  });

  it("returns msedge-dev on Linux when xdg-settings returns edge-dev", async () => {
    mockedPlatform.mockReturnValue("linux");
    mockedExecSync.mockReturnValue("microsoft-edge-dev.desktop\n");
    const { getDefaultEdgeChannel } = await load();
    expect(getDefaultEdgeChannel()).toBe("msedge-dev");
  });
});

describe("detectBrowser prefers system default", () => {
  async function load() {
    vi.resetModules();
    return import("./browser-discovery");
  }

  it("prefers Edge Beta when it is the system default over Stable", async () => {
    mockedPlatform.mockReturnValue("win32");
    // Default browser is Edge Beta
    mockedExecSync.mockReturnValue("    ProgId    REG_SZ    MSEdgeBHTML\r\n");
    // Both Stable and Beta are installed
    mockedLstat.mockImplementation((p) => {
      if (String(p).includes("Edge\\Application") || String(p).includes("Edge Beta"))
        return testDouble<ReturnType<typeof lstatSync>>({});
      throw new Error("ENOENT");
    });
    const { detectBrowser } = await load();
    const result = detectBrowser();
    expect(result.channel).toBe("msedge-beta");
    expect(result.path).toContain("Edge Beta");
  });

  it("tries all paths for preferred channel (non-x86 Beta)", async () => {
    mockedPlatform.mockReturnValue("win32");
    // Default browser is Edge Beta
    mockedExecSync.mockReturnValue("    ProgId    REG_SZ    MSEdgeBHTML\r\n");
    // Beta only installed at non-x86 path (Program Files, not Program Files (x86))
    mockedLstat.mockImplementation((p) => {
      if (p === "C:\\Program Files\\Microsoft\\Edge Beta\\Application\\msedge.exe")
        return testDouble<ReturnType<typeof lstatSync>>({});
      if (String(p).includes("Edge\\Application"))
        return testDouble<ReturnType<typeof lstatSync>>({});
      throw new Error("ENOENT");
    });
    const { detectBrowser } = await load();
    const result = detectBrowser();
    expect(result.channel).toBe("msedge-beta");
    expect(result.path).toBe("C:\\Program Files\\Microsoft\\Edge Beta\\Application\\msedge.exe");
  });

  it("falls back to Stable when default detection fails", async () => {
    mockedPlatform.mockReturnValue("win32");
    mockedExecSync.mockImplementation(() => {
      throw new Error("Command failed");
    });
    mockedLstat.mockImplementation((p) => {
      if (String(p).includes("Edge\\Application"))
        return testDouble<ReturnType<typeof lstatSync>>({});
      throw new Error("ENOENT");
    });
    const { detectBrowser } = await load();
    const result = detectBrowser();
    expect(result.channel).toBe("msedge");
  });

  it("falls back to Stable when default is non-Edge", async () => {
    mockedPlatform.mockReturnValue("win32");
    mockedExecSync.mockReturnValue("    ProgId    REG_SZ    FirefoxURL-308046B0AF4A39CB\r\n");
    mockedLstat.mockImplementation((p) => {
      if (String(p).includes("Edge\\Application"))
        return testDouble<ReturnType<typeof lstatSync>>({});
      throw new Error("ENOENT");
    });
    const { detectBrowser } = await load();
    const result = detectBrowser();
    expect(result.channel).toBe("msedge");
  });
});
