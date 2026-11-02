/**
 * Shared vi.mock factories for electron/sessions* tests.
 *
 * Usage (hoist-aware pattern — required because vi.mock is hoisted above all
 * regular imports, so the factories must themselves be loaded via vi.hoisted):
 *
 * ```ts
 * import { vi } from "vitest";
 * const m = await vi.hoisted(async () => await import("./test-helpers/session-test-mocks"));
 * vi.mock("fs", m.fsFactory);
 * vi.mock("child_process", m.childProcessFactory);
 * vi.mock("electron", m.electronFactory);
 * vi.mock("@github/copilot-sdk", m.copilotSdkFactory);
 * vi.mock("./skills", m.skillsFactory);
 * vi.mock("./cli-path", m.cliPathFactory);
 * vi.mock("./safe-storage-file");
 * ```
 *
 * Each factory is a pure function returning the mock module shape. Tests can
 * still spy or re-arrange mocks via `vi.mocked(fs)` after the mock is installed.
 */
import * as os from "os";
import * as path from "path";

import { vi } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */

type FsModule = typeof import("fs");

/**
 * Default fs mock. `promises.readFile` resolves to `undefined` (Vitest's
 * default vi.fn() return) — tests that exercise reachable read paths should
 * override explicitly, e.g. `vi.mocked(fs.promises).readFile.mockResolvedValue("...")`.
 * `promises.mkdir` / `promises.writeFile` resolve to `undefined` by default so
 * code paths that await them don't throw.
 *
 * Not yet stubbed — add here if a sessions* test ever reaches them:
 *   fs.promises.chmod / appendFile / realpath / unlink / stat / readdir
 * (all present in electron/platform-security.ts and electron/main.ts but
 * not on any path reachable by the current sessions* test suite).
 */
export const fsFactory = () => {
  const resolvePath = (target: unknown) => String(target);
  const realpathSync = Object.assign(vi.fn(resolvePath), { native: vi.fn(resolvePath) });
  const fns = {
    existsSync: vi.fn<FsModule["existsSync"]>(() => false),
    mkdirSync: vi.fn<FsModule["mkdirSync"]>(),
    readFileSync: vi.fn<FsModule["readFileSync"]>(),
    writeFileSync: vi.fn<FsModule["writeFileSync"]>(),
    unlinkSync: vi.fn<FsModule["unlinkSync"]>(),
    rmSync: vi.fn<FsModule["rmSync"]>(),
    renameSync: vi.fn<FsModule["renameSync"]>(),
    statSync: vi.fn(() => ({
      isDirectory: () => true,
      isFile: () => false,
      dev: 1n,
      ino: 1n,
      birthtimeNs: 1n,
    })),
    realpathSync,
    readdirSync: vi.fn<FsModule["readdirSync"]>(() => []),
    accessSync: vi.fn<FsModule["accessSync"]>(),
    chmodSync: vi.fn<FsModule["chmodSync"]>(),
    constants: { X_OK: 1 },
    promises: {
      readFile: vi.fn<FsModule["promises"]["readFile"]>(),
      mkdir: vi.fn<FsModule["promises"]["mkdir"]>().mockResolvedValue(undefined),
      writeFile: vi.fn<FsModule["promises"]["writeFile"]>().mockResolvedValue(undefined),
    },
  };
  return { default: fns, ...fns };
};

export const childProcessFactory = () => ({
  spawn: vi.fn<typeof import("child_process").spawn>(),
  execFile: vi.fn<typeof import("child_process").execFile>(),
  execFileSync: vi.fn((file: string) =>
    file.endsWith("whoami.exe")
      ? '"TEST\\user","S-1-5-21-100-200-300-400"\r\n'
      : "Successfully processed 1 files; Failed processing 0 files\r\n",
  ),
});

export const electronFactory = () => ({
  app: {
    isPackaged: false,
    getVersion: () => "0.0.0-test",
    getPath: vi.fn<(name: string) => string>((name: string) => {
      if (name === "temp") return os.tmpdir();
      if (name === "home") return os.homedir();
      if (name === "userData") return path.join(os.tmpdir(), "test-userdata");
      return path.join(os.tmpdir(), "mock");
    }),
  },
  Notification: vi.fn<() => { show: () => void; on: () => void }>().mockImplementation(() => ({
    show: vi.fn<() => void>(),
    on: vi.fn<() => void>(),
  })),
  shell: {
    openExternal: vi.fn<() => void>(),
  },
});

export const copilotSdkFactory = () => ({
  CopilotClient: vi.fn<() => void>(),
  CopilotSession: vi.fn<() => void>(),
  RuntimeConnection: {
    forStdio: vi.fn((options: { path?: string } = {}) => ({ kind: "stdio", ...options })),
  },
});

export const skillsFactory = () => ({
  getSkillsForSystemPrompt: vi.fn<() => string>(() => ""),
  createSkillCatalog: vi.fn(() => ({
    list: vi.fn<() => []>(() => []),
    getInstructions: vi.fn<() => null>(() => null),
    formatForSystemPrompt: vi.fn<() => string>(() => ""),
  })),
});

export const repositoryCustomizationsFactory = () => {
  const loadAgents = vi.fn<
    (
      repoRoot?: string,
    ) => { name: string; path: string; description: string; instructions: string }[]
  >(() => []);
  const getAgent = vi.fn<
    (
      repoRoot: string | undefined,
      p: string,
    ) => { name: string; path: string; description: string; instructions: string } | null
  >(() => null);
  const getPrompt = vi.fn<() => string>(() => "");
  const getSkillRoots = vi.fn<() => []>(() => []);
  return {
    loadGitHubRepositoryAgents: loadAgents,
    loadRepositoryAgents: loadAgents,
    getGitHubRepositoryAgentByPath: getAgent,
    getRepositoryAgentByPath: getAgent,
    getGitHubRepositoryCustomizationsForSystemPrompt: getPrompt,
    getRepositoryCustomizationsForSystemPrompt: getPrompt,
    getGitHubSkillProviderRoots: getSkillRoots,
    getRepositorySkillProviderRoots: getSkillRoots,
  };
};

export const cliPathFactory = () => ({
  getBundledCliPath: vi.fn<() => string>(() => "/mock/copilot"),
});

export const sessionArchiveFactory = () => ({
  ReadOnlySessionArchive: class {
    dispose(): void {}
    loadMessages(): never[] {
      return [];
    }
    loadMessagesTail() {
      return { messages: [], total: 0, hasMore: false };
    }
    countMessages(): number {
      return 0;
    }
    loadMetadata(): null {
      return null;
    }
  },
});
