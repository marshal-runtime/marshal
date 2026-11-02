import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const execFileSyncMock = vi.fn<(...args: unknown[]) => string>();
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

const loggerInfo = vi.fn<(msg: string) => void>();
const loggerWarn = vi.fn<(msg: string) => void>();
vi.mock("../common/marshal-logger", () => ({
  createLogger: () => ({
    info: loggerInfo,
    warn: loggerWarn,
    error: vi.fn<(msg: string) => void>(),
    debug: vi.fn<(msg: string) => void>(),
  }),
}));

vi.mock("./marshal-value-sanitization", () => ({
  sanitizeForTelemetry: (v: unknown) => String(v),
}));

describe("applyShellPathFix", () => {
  const originalPlatform = process.platform;
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    execFileSyncMock.mockReset();
    loggerInfo.mockReset();
    loggerWarn.mockReset();
    process.env = { ...originalEnv };
    process.env.SHELL = "/bin/zsh";
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    process.env = originalEnv;
  });

  function setPlatform(p: NodeJS.Platform) {
    Object.defineProperty(process, "platform", { value: p });
  }

  it("no-ops on win32", async () => {
    setPlatform("win32");
    const { applyShellPathFix } = await import("./fix-path");
    applyShellPathFix();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("calls execFileSync on darwin and prepends resolved PATH", async () => {
    setPlatform("darwin");
    process.env.PATH = "/usr/bin:/bin";
    execFileSyncMock.mockReturnValue("/opt/homebrew/bin:/usr/local/bin\n");
    const { applyShellPathFix } = await import("./fix-path");
    applyShellPathFix();
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(process.env.PATH).toBe("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
  });

  it("calls execFileSync on linux", async () => {
    setPlatform("linux");
    process.env.PATH = "/usr/bin";
    execFileSyncMock.mockReturnValue("/home/me/.local/bin:/usr/local/bin\n");
    const { applyShellPathFix } = await import("./fix-path");
    applyShellPathFix();
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(process.env.PATH).toBe("/home/me/.local/bin:/usr/local/bin:/usr/bin");
  });

  it("skips when MARSHAL_E2E=1", async () => {
    setPlatform("darwin");
    process.env.MARSHAL_E2E = "1";
    const { applyShellPathFix } = await import("./fix-path");
    applyShellPathFix();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("warns and leaves PATH unchanged when execFileSync throws", async () => {
    setPlatform("darwin");
    process.env.PATH = "/usr/bin";
    execFileSyncMock.mockImplementation(() => {
      throw new Error("shell exec failed");
    });
    const { applyShellPathFix } = await import("./fix-path");
    expect(() => applyShellPathFix()).not.toThrow();
    expect(process.env.PATH).toBe("/usr/bin");
    expect(loggerWarn).toHaveBeenCalled();
  });

  it("warns and leaves PATH unchanged when SHELL env var is missing", async () => {
    setPlatform("darwin");
    delete process.env.SHELL;
    process.env.PATH = "/usr/bin";
    const { applyShellPathFix } = await import("./fix-path");
    applyShellPathFix();
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(process.env.PATH).toBe("/usr/bin");
    expect(loggerWarn).toHaveBeenCalled();
  });

  it("warns and leaves PATH unchanged when shell returns empty output", async () => {
    setPlatform("darwin");
    process.env.PATH = "/usr/bin";
    execFileSyncMock.mockReturnValue("\n");
    const { applyShellPathFix } = await import("./fix-path");
    applyShellPathFix();
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(process.env.PATH).toBe("/usr/bin");
    expect(loggerWarn).toHaveBeenCalled();
  });

  it("rejects fish-style space-separated output and leaves PATH unchanged", async () => {
    setPlatform("darwin");
    process.env.PATH = "/usr/bin:/bin";
    // Fish prints unquoted $PATH as a space-separated list — no colons.
    // Our quoted command (`echo "$PATH"`) flattens to colon-delimited, but
    // a misconfigured shell or non-fish user-defined output could still
    // produce space-separated content. Validate that we degrade safely.
    execFileSyncMock.mockReturnValue("/opt/homebrew/bin /usr/local/bin /usr/bin\n");
    const { applyShellPathFix } = await import("./fix-path");
    applyShellPathFix();
    expect(process.env.PATH).toBe("/usr/bin:/bin");
    expect(loggerWarn).toHaveBeenCalled();
  });

  it('accepts fish output of `echo "$PATH"` (colon-delimited)', async () => {
    setPlatform("darwin");
    process.env.PATH = "/usr/bin:/bin";
    // Real fish behavior with quoted $PATH: list flattens to colon-delimited,
    // matching bash/zsh. Verified empirically with fish 4.7.1.
    execFileSyncMock.mockReturnValue("/opt/homebrew/bin:/usr/local/bin:/usr/bin\n");
    const { applyShellPathFix } = await import("./fix-path");
    applyShellPathFix();
    expect(process.env.PATH).toBe("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/usr/bin:/bin");
  });

  it("strips ANSI/OSC escape sequences (zsh under iTerm emits OSC-1337 inline)", async () => {
    setPlatform("darwin");
    process.env.PATH = "/usr/bin";
    // Reproduction of real zsh-under-iTerm output: an OSC-1337 sequence
    // (\x1b]1337;...\x07) prefixes the PATH on the same line.
    execFileSyncMock.mockReturnValue(
      "\x1b]1337;RemoteHost=user@host\x07\x1b]1337;CurrentDir=/x\x07/opt/homebrew/bin:/usr/bin\n",
    );
    const { applyShellPathFix } = await import("./fix-path");
    applyShellPathFix();
    expect(process.env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/usr/bin");
  });

  it("uses the last non-empty line so dotfile banners don't pollute PATH", async () => {
    setPlatform("darwin");
    process.env.PATH = "/usr/bin";
    // Banner on first line, real PATH on last line.
    execFileSyncMock.mockReturnValue(
      "Welcome to oh-my-zsh!\n[nvm] loading default version\n/opt/homebrew/bin:/usr/local/bin\n",
    );
    const { applyShellPathFix } = await import("./fix-path");
    applyShellPathFix();
    expect(process.env.PATH).toBe("/opt/homebrew/bin:/usr/local/bin:/usr/bin");
  });

  it("logs PATH before and after at info level", async () => {
    setPlatform("darwin");
    process.env.PATH = "/usr/bin:/bin";
    execFileSyncMock.mockReturnValue("/opt/homebrew/bin:/usr/bin:/bin\n");
    const { applyShellPathFix } = await import("./fix-path");
    applyShellPathFix();
    const calls = loggerInfo.mock.calls.map((c) => c.join(" "));
    expect(calls.some((c) => c.includes("PATH before"))).toBe(true);
    expect(calls.some((c) => c.includes("PATH after"))).toBe(true);
  });

  it("is idempotent across repeated calls", async () => {
    setPlatform("darwin");
    process.env.PATH = "/usr/bin:/bin";
    execFileSyncMock.mockReturnValue("/opt/homebrew/bin:/usr/local/bin\n");
    const { applyShellPathFix } = await import("./fix-path");
    applyShellPathFix();
    applyShellPathFix();
    applyShellPathFix();
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(process.env.PATH).toBe("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
  });

  it("sets PATH to shell PATH alone when before is undefined", async () => {
    setPlatform("darwin");
    delete process.env.PATH;
    execFileSyncMock.mockReturnValue("/opt/homebrew/bin:/usr/bin\n");
    const { applyShellPathFix } = await import("./fix-path");
    applyShellPathFix();
    expect(process.env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
  });
});
