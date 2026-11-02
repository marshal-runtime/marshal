import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { testDouble } from "../../testing/harness/test-double";
import { createClaudeClientFactory, createTrackedClaudeSpawner } from "./client-factory";
import { DEFAULT_CLAUDE_CONFIG_DIR } from "./environment";
import { ClaudeProcessRegistry } from "./process-registry";
import type { ClaudeSdkFacade } from "./sdk-facade";

const mocks = vi.hoisted(() => ({
  loadClaudeSdk: vi.fn<() => Promise<ClaudeSdkFacade>>(),
  resolveClaudeExecutablePath:
    vi.fn<
      (
        explicitPath: string | undefined,
        options?: { isPackaged?: boolean; resourcesPath?: string },
      ) => string | undefined
    >(),
}));

vi.mock("./sdk-facade", () => ({
  loadClaudeSdk: mocks.loadClaudeSdk,
}));
vi.mock("./executable-path", () => ({
  resolveClaudeExecutablePath: mocks.resolveClaudeExecutablePath,
}));

describe("createClaudeClientFactory", () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    mocks.loadClaudeSdk.mockResolvedValue(testDouble<ClaudeSdkFacade>({}));
    mocks.resolveClaudeExecutablePath.mockReturnValue(
      String.raw`C:\Marshal\resources\app.asar.unpacked\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe`,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
  });

  it("uses the adapter resolver as the default executable path", async () => {
    const client = await createClaudeClientFactory({
      env: {},
      configDir: DEFAULT_CLAUDE_CONFIG_DIR,
      isPackaged: false,
      resourcesPath: String.raw`C:\electron\resources`,
    })(String.raw`C:\workspace`);

    expect(mocks.resolveClaudeExecutablePath).toHaveBeenCalledWith(undefined, {
      isPackaged: false,
      resourcesPath: String.raw`C:\electron\resources`,
    });
    const configuration = Reflect.get(client, "configuration");
    if (typeof configuration !== "object" || configuration === null) {
      throw new Error("Claude client configuration was not retained");
    }
    expect(Reflect.get(configuration, "pathToClaudeCodeExecutable")).toBe(
      String.raw`C:\Marshal\resources\app.asar.unpacked\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe`,
    );
  });
});

describe("createTrackedClaudeSpawner", () => {
  it("registers production and custom spawned processes for force-kill fallback", () => {
    const resumeStderr = vi.fn<() => void>();
    const process = testDouble<SpawnedProcess>({
      killed: false,
      exitCode: null,
      kill: vi.fn<SpawnedProcess["kill"]>(() => true),
      once: vi.fn<SpawnedProcess["once"]>(),
    });
    Reflect.set(process, "pid", 4242);
    Reflect.set(process, "stderr", { resume: resumeStderr });
    const spawnProcess = vi.fn<(options: SpawnOptions) => SpawnedProcess>(() => process);
    const registry = new ClaudeProcessRegistry();
    const trackedSpawn = createTrackedClaudeSpawner(registry, spawnProcess);
    const options = testDouble<SpawnOptions>({
      command: "claude",
      args: ["--session-id=session-4242", "--print"],
      env: {},
      signal: new AbortController().signal,
    });

    expect(trackedSpawn(options)).toBe(process);
    expect(spawnProcess).toHaveBeenCalledWith(options);
    expect(resumeStderr).toHaveBeenCalledOnce();
    expect(registry.first()?.pid).toBe(4242);

    expect(registry.forceKillSession("another-session")).toEqual([]);
    expect(process.kill).not.toHaveBeenCalled();
    expect(registry.forceKillSession("session-4242")).toEqual([]);
    expect(process.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
