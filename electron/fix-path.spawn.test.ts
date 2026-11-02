import { spawnSync } from "node:child_process";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Symptom exercises a POSIX `/bin/echo` + colon-delimited PATH. Skip on
// Windows where `echo` is a cmd.exe builtin (no binary on disk) and the
// fix doesn't apply (applyShellPathFix is a no-op on win32 anyway).
const describePosix = process.platform === "win32" ? describe.skip : describe;

// Symptom-level test for the GUI-launch PATH bug. Lives in its own file because
// it must NOT mock `node:child_process` — we want a real `spawnSync` to
// observe the ENOENT/success transition that drives the bug.
//
// `execFileSync` (used inside applyShellPathFix to invoke $SHELL) is replaced
// with a vi.fn that returns a synthetic PATH; that's the only mock seam.

const execFileSyncMock = vi.fn<(...args: unknown[]) => string>();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  };
});

vi.mock("../common/marshal-logger", () => ({
  createLogger: () => ({
    info: vi.fn<(msg: string) => void>(),
    warn: vi.fn<(msg: string) => void>(),
    error: vi.fn<(msg: string) => void>(),
    debug: vi.fn<(msg: string) => void>(),
  }),
}));

vi.mock("./marshal-value-sanitization", () => ({
  sanitizeForTelemetry: (v: unknown) => String(v),
}));

describePosix("applyShellPathFix — bare-command spawn symptom", () => {
  const originalPlatform = process.platform;
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    execFileSyncMock.mockReset();
    process.env = { ...originalEnv };
    process.env.SHELL = "/bin/zsh";
    Object.defineProperty(process, "platform", { value: "darwin" });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    process.env = originalEnv;
  });

  it("flips spawn from ENOENT to success once PATH is fixed", async () => {
    // /bin is on every macOS / Linux runner; /nonexistent is not. We pass
    // env: { PATH } explicitly so spawnSync uses our pinned value, not the
    // outer process PATH (which Vitest itself populates).
    process.env.PATH = "/nonexistent";

    // Pin PATH explicitly via spawn options so the assertion doesn't depend
    // on the runner's outer env. We pass a full env (process.env-derived)
    // because TypeScript's augmented ProcessEnv requires several non-PATH
    // keys to be present.
    const env = { ...process.env, PATH: process.env.PATH };
    const before = spawnSync("echo", ["hi"], { env });
    expect(before.error && (before.error as NodeJS.ErrnoException).code).toBe("ENOENT");

    execFileSyncMock.mockReturnValue("/bin:/usr/bin\n");
    const { applyShellPathFix } = await import("./fix-path");
    applyShellPathFix();

    const envAfter = { ...process.env, PATH: process.env.PATH };
    const after = spawnSync("echo", ["hi"], { env: envAfter });
    expect(after.status).toBe(0);
    expect(after.stdout?.toString().trim()).toBe("hi");
  });
});
