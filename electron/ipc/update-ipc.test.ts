import { beforeEach, describe, expect, it, vi } from "vitest";

function mainFrameEvent(): unknown {
  const frame = {};
  return { senderFrame: frame, sender: { mainFrame: frame } };
}

// Hoisted so vi.mock factories can see them.
const {
  mockCheckForUpdate,
  mockGetVersion,
  mockVerifyAndLaunch,
  mockAppExit,
  mockAppRelaunch,
  mockAppGetPath,
} = vi.hoisted(() => ({
  mockCheckForUpdate: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  mockGetVersion: vi.fn<() => string>(() => "0.0.0"),
  mockVerifyAndLaunch: vi.fn<(installerPath: string, appExePath: string) => Promise<void>>(),
  mockAppExit: vi.fn<(code: number) => void>(),
  mockAppRelaunch: vi.fn<() => void>(),
  mockAppGetPath: vi.fn<(name: string) => string>(() => "C:\\Marshal\\Marshal.exe"),
}));

vi.mock("electron", () => ({
  app: {
    getVersion: mockGetVersion,
    exit: mockAppExit,
    relaunch: mockAppRelaunch,
    getPath: mockAppGetPath,
  },
}));

vi.mock("../updater", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../updater")>();
  return { ...actual, verifyAndLaunch: mockVerifyAndLaunch };
});

vi.mock("../updater/select", () => ({
  selectUpdateProvider: vi.fn<() => IUpdateProvider>(
    () =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- minimal provider stub
      ({ checkForUpdate: mockCheckForUpdate }) as unknown as IUpdateProvider,
  ),
}));

import type { IUpdateProvider, MinimumVersionResult } from "../platform/updates/ports";
import { selectUpdateProvider } from "../updater/select";
import { registerUpdateHandlers } from "./update-ipc";

type CheckHandler = (event: unknown) => Promise<{ success: boolean; error?: string }>;

function setup(updateChannelBeta: boolean | undefined) {
  let handler: CheckHandler | undefined;

  const ipcHandle = vi.fn<(channel: string, fn: CheckHandler) => void>((channel, fn) => {
    if (channel === "update:check") handler = fn;
  });

  const settingsManager = {
    get: vi.fn<() => { updateChannelBeta: boolean | undefined }>(() => ({ updateChannelBeta })),
  };

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only: partial deps
  registerUpdateHandlers({
    getWindow: () => null,
    ipcHandle,
    settingsManager,
  } as unknown as Parameters<typeof registerUpdateHandlers>[0]);

  return { invoke: (event: unknown = mainFrameEvent()) => handler!(event), settingsManager };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckForUpdate.mockResolvedValue({
    upToDate: true,
    currentVersion: "0.0.0",
    channel: "stable",
  });
});

describe("update:restart — verifyAndLaunch envelope bridging", () => {
  type RestartHandler = (
    event: unknown,
    installerPath?: string,
  ) => Promise<{ success: boolean; error?: string }>;

  // process.platform is read-only by default; override + restore so the
  // Windows-branch test runs deterministically on any host (mac CI included).
  const originalPlatform = process.platform;
  function setPlatform(p: NodeJS.Platform) {
    Object.defineProperty(process, "platform", { value: p, configurable: true });
  }
  function restorePlatform() {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }

  function captureRestart(): RestartHandler {
    let restart: RestartHandler | undefined;
    const ipcHandle = vi.fn<(channel: string, fn: RestartHandler) => void>((channel, fn) => {
      if (channel === "update:restart") restart = fn;
    });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only: partial deps
    registerUpdateHandlers({
      getWindow: () => null,
      ipcHandle,
      settingsManager: { get: () => ({ updateChannelBeta: false }) },
    } as unknown as Parameters<typeof registerUpdateHandlers>[0]);
    if (!restart) throw new Error("update:restart handler was not registered");
    return restart;
  }

  // The security-critical bridge: a future refactor that rethrows from the
  // catch, drops the try/catch, or calls app.exit on the failure path would
  // silently re-open the signature-verification bypass. Renderer-side tests can't catch this
  // because they mock the envelope directly.
  it("Windows + verifyAndLaunch throws → returns {success:false, error} and does NOT exit", async () => {
    setPlatform("win32");
    try {
      mockVerifyAndLaunch.mockRejectedValueOnce(
        new Error("Authenticode signature verification failed: Signature publisher mismatch"),
      );

      const restart = captureRestart();
      const result = await restart(
        mainFrameEvent(),
        "C:\\Users\\u\\AppData\\Local\\Temp\\marshal-update\\Setup.exe",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("publisher mismatch");
      expect(mockVerifyAndLaunch).toHaveBeenCalledWith(
        "C:\\Users\\u\\AppData\\Local\\Temp\\marshal-update\\Setup.exe",
        "C:\\Marshal\\Marshal.exe",
      );
      expect(mockAppExit).not.toHaveBeenCalled();
      expect(mockAppRelaunch).not.toHaveBeenCalled();
    } finally {
      restorePlatform();
    }
  });

  it("Windows + verifyAndLaunch resolves → calls app.exit(0) and reports success", async () => {
    setPlatform("win32");
    try {
      mockVerifyAndLaunch.mockResolvedValueOnce(undefined);

      const restart = captureRestart();
      const result = await restart(
        mainFrameEvent(),
        "C:\\Users\\u\\AppData\\Local\\Temp\\marshal-update\\Setup.exe",
      );

      expect(result.success).toBe(true);
      expect(mockAppExit).toHaveBeenCalledWith(0);
      expect(mockAppRelaunch).not.toHaveBeenCalled();
    } finally {
      restorePlatform();
    }
  });

  it("non-Windows or no installerPath → relaunch path, verifyAndLaunch not called", async () => {
    setPlatform("darwin");
    try {
      const restart = captureRestart();
      const result = await restart(mainFrameEvent());

      expect(result.success).toBe(true);
      expect(mockVerifyAndLaunch).not.toHaveBeenCalled();
      expect(mockAppRelaunch).toHaveBeenCalledTimes(1);
      expect(mockAppExit).toHaveBeenCalledWith(0);
    } finally {
      restorePlatform();
    }
  });
});

describe("update:check — channel resolution from settings", () => {
  it("passes 'beta' to checkForUpdate when updateChannelBeta is true", async () => {
    const { invoke } = setup(true);
    await invoke();
    expect(mockCheckForUpdate).toHaveBeenCalledWith({ currentVersion: "0.0.0", channel: "beta" });
  });

  it("passes 'stable' to checkForUpdate when updateChannelBeta is false", async () => {
    const { invoke } = setup(false);
    await invoke();
    expect(mockCheckForUpdate).toHaveBeenCalledWith({ currentVersion: "0.0.0", channel: "stable" });
  });

  it("passes 'stable' to checkForUpdate when updateChannelBeta is undefined", async () => {
    // Pre-channels users have no field on disk; default must be stable.
    const { invoke } = setup(undefined);
    await invoke();
    expect(mockCheckForUpdate).toHaveBeenCalledWith({ currentVersion: "0.0.0", channel: "stable" });
  });
});

describe("update:check-minimum — provider dispatch + fail-open envelope", () => {
  // The handler is a 9-line wrapper around the active provider's
  // checkMinimumVersion. The provider fails open internally; the handler's
  // catch is the "second net" (see update-ipc.ts comment) that pins the
  // Big Red Button contract at the IPC boundary: a future provider refactor
  // that bubbles an exception must NOT brick the app.
  //
  // Provider-agnostic by design: the endpoint-provider checkMinimumVersion
  // semantics (server-authoritative blocked + version fail-open) have 10
  // direct tests in endpoint-provider.test.ts. These tests pin the handler
  // dispatch + envelope independently of provider choice.
  type CheckMinHandler = (event: unknown) => Promise<{
    success: boolean;
    blocked?: boolean;
    minimumVersion?: string;
    currentVersion?: string;
    error?: string;
  }>;

  function setupCheckMin() {
    let handler: CheckMinHandler | undefined;
    const ipcHandle = vi.fn<(channel: string, fn: unknown) => void>((channel, fn) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test harness captures arbitrary handler shapes
      if (channel === "update:check-minimum") handler = fn as CheckMinHandler;
    });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only: partial deps
    registerUpdateHandlers({
      getWindow: () => null,
      ipcHandle,
      settingsManager: { get: () => ({ updateChannelBeta: false }) },
    } as unknown as Parameters<typeof registerUpdateHandlers>[0]);
    if (!handler) throw new Error("update:check-minimum handler was not registered");
    return handler;
  }

  function withFakeProvider(
    checkMinimumVersion: (currentVersion: string) => Promise<MinimumVersionResult>,
  ) {
    const stub = {
      checkMinimumVersion: vi.fn<IUpdateProvider["checkMinimumVersion"]>(checkMinimumVersion),
    };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- intentional: minimal IUpdateProvider stub, only checkMinimumVersion is exercised
    vi.mocked(selectUpdateProvider).mockReturnValueOnce(stub as unknown as IUpdateProvider);
    return stub;
  }

  it("dispatches to the active provider with the result of app.getVersion()", async () => {
    mockGetVersion.mockReturnValueOnce("0.0.123");
    const stub = withFakeProvider(async () => ({
      blocked: false,
      minimumVersion: "0.0.100",
      currentVersion: "0.0.123",
    }));

    const invoke = setupCheckMin();
    await invoke(mainFrameEvent());

    expect(stub.checkMinimumVersion).toHaveBeenCalledTimes(1);
    expect(stub.checkMinimumVersion).toHaveBeenCalledWith("0.0.123");
  });

  it("passes through the provider's MinimumVersionResult verbatim when blocked=true (Big Red Button)", async () => {
    withFakeProvider(async () => ({
      blocked: true,
      minimumVersion: "1.0.0",
      currentVersion: "0.0.1",
    }));

    const invoke = setupCheckMin();
    const result = await invoke(mainFrameEvent());

    expect(result).toEqual({
      success: true,
      blocked: true,
      minimumVersion: "1.0.0",
      currentVersion: "0.0.1",
    });
  });

  it("passes through the provider's MinimumVersionResult verbatim when blocked=false", async () => {
    withFakeProvider(async () => ({
      blocked: false,
      minimumVersion: "0.5.0",
      currentVersion: "1.0.0",
    }));

    const invoke = setupCheckMin();
    const result = await invoke(mainFrameEvent());

    expect(result).toEqual({
      success: true,
      blocked: false,
      minimumVersion: "0.5.0",
      currentVersion: "1.0.0",
    });
  });

  it("fail-open envelope: provider throws → returns {success:true, blocked:false, error} (never bricks the app)", async () => {
    withFakeProvider(async () => {
      throw new Error("upstream provider exploded");
    });

    const invoke = setupCheckMin();
    const result = await invoke(mainFrameEvent());

    expect(result.success).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.error).toContain("upstream provider exploded");
    expect(result.minimumVersion).toBeUndefined();
  });

  it("fail-open envelope: provider throws a non-Error → stringifies into the error field", async () => {
    withFakeProvider(async () => {
      // eslint-disable-next-line no-throw-literal -- intentional: cover String(error) branch
      throw "string-shaped failure";
    });

    const invoke = setupCheckMin();
    const result = await invoke(mainFrameEvent());

    expect(result.success).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.error).toContain("string-shaped failure");
  });
});
