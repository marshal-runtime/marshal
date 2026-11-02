import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkArrayLength, checkStringSize, IPC_LIMITS } from "./ipc-limits";

describe("checkStringSize", () => {
  it("returns null when string is within limit", () => {
    expect(checkStringSize("hello", 10, "Test")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(checkStringSize("", 10, "Test")).toBeNull();
  });

  it("returns null when string is exactly at limit", () => {
    expect(checkStringSize("ab", 2, "Test")).toBeNull();
  });

  it("returns error when string exceeds limit", () => {
    const result = checkStringSize("abc", 2, "Test data");
    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("Test data exceeds"),
    });
  });

  it("formats MB limits in human-readable form", () => {
    const result = checkStringSize("x".repeat(11), 10 * 1024 * 1024, "Payload");
    // String is 11 chars, limit is 10 MB — passes because 11 < 10MB
    expect(result).toBeNull();

    const big = "x".repeat(10 * 1024 * 1024 + 1);
    const rejected = checkStringSize(big, 10 * 1024 * 1024, "Payload");
    expect(rejected).not.toBeNull();
    expect(rejected!.error).toContain("10 MB");
  });

  it("formats KB limits in human-readable form", () => {
    const result = checkStringSize("x".repeat(1025), 1024, "Small");
    expect(result).not.toBeNull();
    expect(result!.error).toContain("1 KB");
  });

  it("rounds non-aligned sizes cleanly", () => {
    // 1_500_000 bytes → ~1.43 MB, should round to "1 MB" not "1.430511..."
    const result = checkStringSize("x".repeat(1_500_001), 1_500_000, "Test");
    expect(result).not.toBeNull();
    expect(result!.error).toBe("Test exceeds 1 MB limit");
  });

  it("logs a warning on rejection", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkStringSize("abc", 2, "MyLabel");
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[IpcLimits:SF-4]"),
      expect.stringContaining("MyLabel rejected"),
    );
    spy.mockRestore();
  });
});

describe("checkArrayLength", () => {
  it("returns null when array is within limit", () => {
    expect(checkArrayLength([1, 2, 3], 5, "Items")).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(checkArrayLength([], 5, "Items")).toBeNull();
  });

  it("returns null when array is exactly at limit", () => {
    expect(checkArrayLength([1, 2], 2, "Items")).toBeNull();
  });

  it("returns error when array exceeds limit", () => {
    const result = checkArrayLength([1, 2, 3], 2, "Messages");
    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("Messages: 3 items exceeds 2 limit"),
    });
  });

  it("logs a warning on rejection", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkArrayLength([1, 2, 3], 2, "Batch");
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[IpcLimits:SF-4]"),
      expect.stringContaining("Batch rejected"),
    );
    spy.mockRestore();
  });
});

describe("IPC_LIMITS constants", () => {
  it("has expected size limits", () => {
    expect(IPC_LIMITS.IMAGE_BASE64_BYTES).toBe(20 * 1024 * 1024);
    expect(IPC_LIMITS.JSON_IMPORT_BYTES).toBe(5 * 1024 * 1024);
    expect(IPC_LIMITS.FILE_CONTENT_BYTES).toBe(10 * 1024 * 1024);
    expect(IPC_LIMITS.TEXT_MESSAGE_BYTES).toBe(1 * 1024 * 1024);
  });

  it("has expected array limits", () => {
    expect(IPC_LIMITS.ARRAY_MAX_LENGTH).toBe(10_000);
    expect(IPC_LIMITS.MESSAGES_MAX_LENGTH).toBe(5_000);
  });

  it("has expected MIME allowlist", () => {
    expect(IPC_LIMITS.ALLOWED_IMAGE_MIMES.has("image/png")).toBe(true);
    expect(IPC_LIMITS.ALLOWED_IMAGE_MIMES.has("image/jpeg")).toBe(true);
    expect(IPC_LIMITS.ALLOWED_IMAGE_MIMES.has("image/gif")).toBe(true);
    expect(IPC_LIMITS.ALLOWED_IMAGE_MIMES.has("image/webp")).toBe(true);
    expect(IPC_LIMITS.ALLOWED_IMAGE_MIMES.has("image/bmp")).toBe(true);
    expect(IPC_LIMITS.ALLOWED_IMAGE_MIMES.has("image/heic")).toBe(true);
    expect(IPC_LIMITS.ALLOWED_IMAGE_MIMES.has("image/heif")).toBe(true);
    expect(IPC_LIMITS.ALLOWED_IMAGE_MIMES.has("image/svg+xml")).toBe(false); // XSS vector
    expect(IPC_LIMITS.ALLOWED_IMAGE_MIMES.has("application/pdf")).toBe(false);
    expect(IPC_LIMITS.ALLOWED_IMAGE_MIMES.has("text/html")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Handler-level integration tests: verify normal payloads pass through the
// new size/length checks and that oversized payloads are rejected before
// reaching downstream logic.
// ---------------------------------------------------------------------------

/**
 * Helper: register handlers via a fake ipcHandle and return a Map of
 * channel → handler so tests can call them directly.
 */
function collectHandlers(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic test harness
  registerFn: (deps: any) => unknown,
  deps: Record<string, unknown>,
): Map<string, (...args: unknown[]) => unknown> {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcHandle = (channel: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(channel, handler);
  };
  registerFn({ ...deps, ipcHandle });
  return handlers;
}

async function callHandler(
  handlers: Map<string, (...args: unknown[]) => unknown>,
  channel: string,
  ...args: unknown[]
): Promise<{ success: boolean; error?: string; path?: string }> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test harness: IPC handlers always return this shape
  return (await handler({}, ...args)) as { success: boolean; error?: string; path?: string };
}

describe("copilot:saveImage — size and MIME limits", () => {
  // Inline mock: we only need to verify the check runs before Buffer.from/writeFile.
  // Mock fs and app so the handler doesn't touch real disk.
  const mockMkdir = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const mockWriteFile = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const mockUnlink = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const mockExecFile =
    vi.fn<
      (
        cmd: string,
        args: string[],
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => void
    >();

  let handlers: Map<string, (...args: unknown[]) => unknown>;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      default: { promises: { mkdir: mockMkdir, writeFile: mockWriteFile, unlink: mockUnlink } },
      promises: { mkdir: mockMkdir, writeFile: mockWriteFile, unlink: mockUnlink },
    }));
    vi.doMock("node:child_process", () => ({
      execFile: mockExecFile,
    }));
    vi.doMock("electron", () => ({
      app: { getPath: () => "/tmp" },
      shell: { openExternal: vi.fn<() => void>() },
    }));
    const { registerCopilotHandlers } = await import("./copilot-ipc");
    handlers = collectHandlers(registerCopilotHandlers, {
      sessionManager: {
        getCurrentSessionId: () => "s1",
        sendMessage: vi.fn<() => void>(),
      },
      powerManager: { markBusy: vi.fn<() => void>(), markIdle: vi.fn<() => void>() },
      getWindow: () => null,
    });
    mockMkdir.mockClear();
    mockWriteFile.mockClear();
    mockUnlink.mockClear();
    mockExecFile.mockReset();
    // Default: execFile callback signals success
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        cb(null, "", "");
      },
    );
  });

  it("accepts a normal-sized PNG image", async () => {
    // 1x1 transparent PNG as base64 (~90 chars)
    const tinyPng =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMBAQApds4LAAAAASUVORK5CYII=";
    const result = await callHandler(handlers, "copilot:saveImage", tinyPng, "image/png");
    expect(result.success).toBe(true);
    expect(mockWriteFile).toHaveBeenCalled();
  });

  it("rejects oversized base64 data", async () => {
    const huge = "A".repeat(IPC_LIMITS.IMAGE_BASE64_BYTES + 1);
    const result = await callHandler(handlers, "copilot:saveImage", huge, "image/png");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Image data exceeds");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("rejects unsupported MIME type", async () => {
    const result = await callHandler(handlers, "copilot:saveImage", "abc", "application/pdf");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unsupported image type");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("rejects SVG MIME type (XSS vector)", async () => {
    const result = await callHandler(handlers, "copilot:saveImage", "abc", "image/svg+xml");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unsupported image type");
  });

  it("converts HEIC to JPEG via sips on macOS", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      const result = await callHandler(handlers, "copilot:saveImage", "abc", "image/heic");
      expect(result.success).toBe(true);
      expect(result.path).toMatch(/\.jpg$/);
      expect(mockExecFile).toHaveBeenCalledWith(
        "sips",
        expect.arrayContaining(["-s", "format", "jpeg"]),
        expect.any(Function),
      );
      expect(mockUnlink).toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("rejects HEIC on non-macOS platforms with a clear error", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const result = await callHandler(handlers, "copilot:saveImage", "abc", "image/heif");
      expect(result.success).toBe(false);
      expect(result.error).toContain("only supported on macOS");
      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("reports a clean error and cleans up if sips fails", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    mockExecFile.mockImplementationOnce(
      (
        _cmd: string,
        _args: string[],
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        cb(new Error("sips not found"), "", "");
      },
    );
    try {
      const result = await callHandler(handlers, "copilot:saveImage", "abc", "image/heic");
      expect(result.success).toBe(false);
      expect(result.error).toContain("HEIC conversion failed");
      const unlinkPaths = mockUnlink.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(unlinkPaths.some((p) => /\.heic$/i.test(p))).toBe(true);
      expect(unlinkPaths.some((p) => /\.jpg$/i.test(p))).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });
});

describe("copilot:send — size limits", () => {
  // Reuses the same copilot handler setup
  let handlers: Map<string, (...args: unknown[]) => unknown>;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      default: {
        promises: { mkdir: vi.fn<() => Promise<void>>(), writeFile: vi.fn<() => Promise<void>>() },
      },
    }));
    vi.doMock("electron", () => ({
      app: { getPath: () => "/tmp" },
      shell: { openExternal: vi.fn<() => void>() },
    }));
    const { registerCopilotHandlers } = await import("./copilot-ipc");
    handlers = collectHandlers(registerCopilotHandlers, {
      sessionManager: {
        getCurrentSessionId: () => "s1",
        sendMessage: vi.fn<() => void>(),
      },
      powerManager: { markBusy: vi.fn<() => void>(), markIdle: vi.fn<() => void>() },
      getWindow: () => null,
    });
  });

  it("rejects oversized message", async () => {
    const huge = "x".repeat(IPC_LIMITS.TEXT_MESSAGE_BYTES + 1);
    const result = await callHandler(handlers, "copilot:send", huge);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Message exceeds");
  });
});

describe("settings:save — size limits", () => {
  let handlers: Map<string, (...args: unknown[]) => unknown>;
  const mockSave = vi.fn<() => void>();

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("electron", () => ({
      shell: { openPath: vi.fn<() => void>() },
    }));
    vi.doMock("../theme", () => ({ useMacVibrancy: false }));
    vi.doMock("../app-paths", () => ({ getAppDataDir: () => "/tmp" }));
    const { registerSettingsHandlers } = await import("./settings-ipc");
    handlers = collectHandlers(registerSettingsHandlers, {
      settingsManager: { save: mockSave, get: () => ({}) },
      getRuntimeSelection: () => ({
        requestedRuntimeId: "copilot",
        runtimeId: "copilot",
      }),
      switchRuntime: vi.fn<
        (runtimeId: string) => Promise<{
          selection: {
            requestedRuntimeId: string;
            runtimeId: string;
          };
          requiresRestart: boolean;
        }>
      >(async () => ({
        selection: {
          requestedRuntimeId: "copilot",
          runtimeId: "copilot",
        },
        requiresRestart: false,
      })),
      getWindow: () => null,
      sessionManager: {
        getCurrentSessionId: () => null,
        getWorkspaceDir: () => "/tmp",
        setInterceptFileChooser: vi.fn<() => void>(),
      },
      backgroundService: { get: () => ({}) },
      showHideShortcutController: {
        getStatus: () => ({
          enabled: true,
          accelerator: "CommandOrControl+Shift+K",
          registered: true,
          error: null,
        }),
      },
      resolveThemeBg: () => "#000",
    });
    mockSave.mockClear();
  });

  it("accepts a normal settings object", async () => {
    const settings = { theme: "dark" };
    const result = await callHandler(handlers, "settings:save", settings);
    expect(result.success).toBe(true);
    expect(mockSave).toHaveBeenCalledOnce();
  });

  it("rejects an absurdly large settings object", async () => {
    const settings = { theme: "dark", junk: "x".repeat(IPC_LIMITS.JSON_IMPORT_BYTES) };
    const result = await callHandler(handlers, "settings:save", settings);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Settings exceeds");
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("returns show/hide shortcut registration status", async () => {
    const result = await callHandler(handlers, "settings:getShowHideShortcutStatus");

    expect(result).toEqual({
      success: true,
      status: {
        enabled: true,
        accelerator: "CommandOrControl+Shift+K",
        registered: true,
        error: null,
      },
    });
  });
});

describe("workspace:writeFile — size limits", () => {
  let handlers: Map<string, (...args: unknown[]) => unknown>;
  const mockWriteFileSync = vi.fn<() => void>();

  beforeEach(async () => {
    vi.resetModules();
    const handlersMap = new Map<string, (...args: unknown[]) => unknown>();
    vi.doMock("fs", () => ({
      default: {
        writeFileSync: mockWriteFileSync,
        statSync: vi.fn<() => object>(() => ({ isDirectory: () => true })),
        existsSync: vi.fn<() => boolean>(() => true),
        readdirSync: vi.fn<() => never[]>(() => []),
        mkdirSync: vi.fn<() => void>(),
        watch: vi.fn<() => { close: () => void; unref: () => void }>(() => ({
          close: () => {},
          unref: () => {},
        })),
      },
      writeFileSync: mockWriteFileSync,
      existsSync: vi.fn<() => boolean>(() => true),
      mkdirSync: vi.fn<() => void>(),
      watch: vi.fn<() => { close: () => void; unref: () => void }>(() => ({
        close: () => {},
        unref: () => {},
      })),
    }));
    vi.doMock("electron", () => ({
      app: { getPath: () => "/tmp", once: vi.fn<() => void>() },
      BrowserWindow: { getAllWindows: () => [] },
      dialog: {},
      shell: {},
    }));
    vi.doMock("./ipc-handle", () => ({
      createIpcHandle: () => (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlersMap.set(channel, handler);
      },
    }));
    vi.doMock("../workspace-store", () => ({
      SCRATCHPAD_WORKSPACE_NAME: "Scratchpad",
      getWorkspaceRoot: () => "/tmp/workspace",
      getWorkspaceRegistry: () => ({}),
      getWorkspaceUIState: () => ({ expandedPaths: {} }),
      listRegisteredWorkspaces: () => [
        {
          name: "Scratchpad",
          path: "/tmp/workspace/Scratchpad",
          origin: "scratchpad",
          identity: { version: 1, device: "1", inode: "1", birthtimeNs: "1" },
          external: false,
        },
      ],
      reconcileActiveWorkspace: vi.fn<() => void>(),
      registerExistingWorkspace: vi.fn<() => void>(),
      registerManagedWorkspace: vi.fn<() => void>(),
      resolveRegisteredWorkspace: vi.fn<() => undefined>(),
      validateWorkspaceName: () => null,
      addWorkspaceEntry: vi.fn<() => void>(),
      deleteWorkspaceEntry: vi.fn<() => void>(),
      renameWorkspaceEntry: vi.fn<() => void>(),
      setActiveWorkspace: vi.fn<() => void>(),
      setExpandedPaths: vi.fn<() => void>(),
      setSelectedFile: vi.fn<() => boolean>(() => true),
    }));
    const mod = await import("./workspace-ipc");
    mod.registerWorkspaceHandlers("/tmp/workspace");
    handlers = handlersMap;
    mockWriteFileSync.mockClear();
  });

  it("rejects oversized file content before writing", async () => {
    const huge = "x".repeat(IPC_LIMITS.FILE_CONTENT_BYTES + 1);
    const result = await callHandler(
      handlers,
      "workspace:writeFile",
      "/tmp/workspace/test.txt",
      huge,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("File content exceeds");
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });
});

describe("automations:import — size limits", () => {
  let handlers: Map<string, (...args: unknown[]) => unknown>;
  const mockImportAutomations = vi.fn<() => Promise<object[]>>(() =>
    Promise.resolve([{ id: "wf-1", name: "test" }]),
  );

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("electron", () => ({
      app: { isPackaged: false, getAppPath: () => "/mock", getPath: () => "/mock" },
      dialog: {},
    }));
    const { registerAutomationsHandlers } = await import("./automations-ipc");
    const fakeBackend = {
      origin: "copilot" as const,
      automation: {
        listAutomations: vi.fn<() => Promise<never[]>>(() => Promise.resolve([])),
        importAutomations: mockImportAutomations,
      },
    };
    const sharedDeps = {
      sessionManager: {
        addEventListener: vi.fn<() => () => void>(() => () => {}),
        getBackendProvider: () => fakeBackend,
      },
      getWindow: () => ({ webContents: { send: vi.fn<() => void>() } }),
    };
    handlers = collectHandlers(registerAutomationsHandlers, sharedDeps);
    mockImportAutomations.mockClear();
  });

  it("accepts normal-sized automation JSON and calls importAutomations", async () => {
    const json = JSON.stringify([{ name: "test", steps: [], schedule: {} }]);
    const result = await callHandler(handlers, "automations:import", json);
    expect(result.success).toBe(true);
    expect(mockImportAutomations).toHaveBeenCalledOnce();
  });

  it("rejects oversized automation JSON before parsing", async () => {
    const huge = "x".repeat(IPC_LIMITS.JSON_IMPORT_BYTES + 1);
    const result = await callHandler(handlers, "automations:import", huge);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Automation import exceeds");
    expect(mockImportAutomations).not.toHaveBeenCalled();
  });
});

describe("skills:import-contents — size limits", () => {
  let handlers: Map<string, (...args: unknown[]) => unknown>;
  const mockAddSkill = vi.fn<() => object>(() => ({ id: "s1", name: "test" }));
  const mockSaveSkills = vi.fn<() => void>();

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({ default: { existsSync: vi.fn<() => boolean>(() => true) } }));
    vi.doMock("electron", () => ({
      dialog: { showOpenDialog: vi.fn<() => void>(), showSaveDialog: vi.fn<() => void>() },
      shell: { openPath: vi.fn<() => void>() },
    }));
    vi.doMock("../../common/foundation/skills/skill-sanitization", () => ({
      sanitizeSkillContent: vi.fn<() => object>(() => ({
        description: "d",
        instructions: "i",
        warnings: [],
      })),
    }));
    vi.doMock("../foundation/markdown/skill-markdown", () => ({
      parseSkillMarkdown: vi.fn<() => object>(() => ({
        name: "test",
        description: "d",
        instructions: "i",
      })),
    }));
    vi.doMock("../marshal-net-fetch", () => ({ getNetFetch: () => vi.fn<() => void>() }));
    vi.doMock("../skills", () => ({
      loadSkills: vi.fn<() => never[]>(() => []),
      addSkill: mockAddSkill,
      updateSkill: vi.fn<() => void>(),
      deleteSkill: vi.fn<() => void>(),
      getSkillContent: vi.fn<() => string>(() => ""),
      localSkillDir: vi.fn<() => string>(() => "/tmp/skills"),
      validateSkillName: vi.fn<() => null>(() => null),
      registerLocalSkill: vi.fn<() => void>(),
      createSkillCache: vi.fn<() => object>(() => ({
        localSkills: [],
        existingNames: new Set(),
      })),
      saveSkills: mockSaveSkills,
    }));
    vi.doMock("../app-paths", () => ({ getAppDataDir: () => "/tmp" }));
    const { registerSkillsHandlers } = await import("./skills-ipc");
    handlers = collectHandlers(registerSkillsHandlers, {
      sessionManager: {
        getCurrentSessionId: () => null,
        refreshSession: vi.fn<() => Promise<void>>(),
      },
      getWindow: () => null,
      ipcHandle: undefined, // collectHandlers provides this
    });
    mockAddSkill.mockClear();
    mockSaveSkills.mockClear();
  });

  it("rejects oversized skill content per file before parsing", async () => {
    const huge = "x".repeat(IPC_LIMITS.JSON_IMPORT_BYTES + 1);
    const handler = handlers.get("skills:import-contents")!;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test: batch handler returns extended shape
    const result = (await handler({}, [{ content: huge, fileName: "big.md" }])) as {
      success: boolean;
      errors: Array<{ error: string }>;
    };
    expect(result.success).toBe(false);
    expect(result.errors[0].error).toContain("Skill content exceeds");
    expect(mockAddSkill).not.toHaveBeenCalled();
  });
});
