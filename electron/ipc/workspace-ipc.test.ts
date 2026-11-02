import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const testPaths = await vi.hoisted(async () => {
  const pathModule = await import("node:path");
  const osModule = await import("node:os");
  const root = pathModule.join(osModule.tmpdir(), "copilot-test-workspace-ipc");
  return {
    root,
    appData: pathModule.join(root, "app-data"),
  };
});

const electronMocks = vi.hoisted(() => {
  const capturedHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return {
    capturedHandlers,
    appOnceCallbacks: [] as Array<() => void>,
    showOpenDialog: vi.fn<() => Promise<{ canceled: boolean; filePaths: string[] }>>(),
  };
});

vi.mock("electron", () => ({
  app: {
    once: vi.fn<(eventName: string, callback: () => void) => void>((eventName, callback) => {
      if (eventName === "will-quit") {
        electronMocks.appOnceCallbacks.push(callback);
      }
    }),
  },
  BrowserWindow: vi.fn<() => void>(),
  dialog: {
    showOpenDialog: electronMocks.showOpenDialog,
  },
  ipcMain: {
    handle: vi.fn<
      (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => void
    >((channel, handler) => {
      electronMocks.capturedHandlers.set(channel, handler);
    }),
  },
  shell: {
    showItemInFolder: vi.fn<(targetPath: string) => void>(),
    openPath: vi.fn<(targetPath: string) => Promise<string>>(),
  },
}));

vi.mock("../app-paths", () => ({
  getAppDataDir: () => testPaths.appData,
}));

vi.mock("../mock-mode", () => ({
  isMockMode: () => false,
}));

import { dialog } from "electron";

import type {
  MainSessionWorkspaceBinding,
  SessionRepositoryAgent,
} from "../../common/marshal-ipc-contract";
import {
  getE2EWorkspaceFixtureManifestPath,
  installE2EWorkspaceFixtures,
} from "../e2e-workspace-fixtures";
import { createRuntimeDocumentAccessStore } from "../security/runtime-document-access-store";
import { createWorkspacePathCapabilityStore } from "../security/workspace-path-capability-store";
import type { SessionManager } from "../sessions";
import {
  getWorkspaceRegistry,
  registerExistingWorkspace,
  saveWorkspaceStore,
  type loadWorkspaceStore,
} from "../workspace-store";
import { authorizeIpcWebContents } from "./ipc-handle";
import { isDirEntry, registerWorkspaceHandlers, sandboxed, validateName } from "./workspace-ipc";

type WorkspaceStore = ReturnType<typeof loadWorkspaceStore>;
type WorkspaceHandlerResult = {
  success: boolean;
  error?: string;
  folderPath?: string;
  folderToken?: string;
  importToken?: string;
  copied?: number;
  workspaces?: string[];
  workspaceBindings?: MainSessionWorkspaceBinding[];
  externalWorkspaces?: string[];
  agents?: SessionRepositoryAgent[];
  root?: string;
  content?: string;
  type?: string;
};

function isWorkspaceHandlerResult(value: unknown): value is WorkspaceHandlerResult {
  return typeof value === "object" && value !== null && "success" in value;
}

// ── isDirEntry() ──────────────────────────────────────────────────

describe("isDirEntry", () => {
  it("returns true for a regular directory", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
    const fakeDirent = {
      isDirectory: () => true,
      isSymbolicLink: () => false,
    } as fs.Dirent;
    expect(isDirEntry(fakeDirent)).toBe(true);
  });

  it("returns true for a symlink/junction", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
    const fakeDirent = {
      isDirectory: () => false,
      isSymbolicLink: () => true,
    } as fs.Dirent;
    expect(isDirEntry(fakeDirent)).toBe(true);
  });

  it("returns false for a regular file", () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial test double
    const fakeDirent = {
      isDirectory: () => false,
      isSymbolicLink: () => false,
    } as fs.Dirent;
    expect(isDirEntry(fakeDirent)).toBe(false);
  });
});

// ── sandboxed() ───────────────────────────────────────────────────

describe("sandboxed", () => {
  let tmpRoot: string;
  let workspaceDir: string;
  let scratchpadDir: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-test-"));
    workspaceDir = path.join(tmpRoot, "workspaces");
    fs.mkdirSync(workspaceDir, { recursive: true });
    scratchpadDir = path.join(workspaceDir, "Scratchpad");
    fs.mkdirSync(scratchpadDir, { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, "MyWorkspace"), { recursive: true });
    fs.mkdirSync(path.join(scratchpadDir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(scratchpadDir, "sub", "file.txt"), "test");
    fs.writeFileSync(path.join(workspaceDir, "MyWorkspace", "file.md"), "test");
    saveWorkspaceStore({
      version: 3,
      activeWorkspace: "Scratchpad",
      workspaces: {
        Scratchpad: { origin: "scratchpad", expandedPaths: [] },
      },
    } satisfies WorkspaceStore);
    registerExistingWorkspace("MyWorkspace", path.join(workspaceDir, "MyWorkspace"), workspaceDir);
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("allows a path inside the workspace", () => {
    const result = sandboxed(workspaceDir, path.join(workspaceDir, "MyWorkspace", "file.md"));
    expect(result).toHaveProperty("resolved");
    expect("error" in result).toBe(false);
  });

  it("allows the workspace root itself", () => {
    const result = sandboxed(workspaceDir, path.join(workspaceDir, "MyWorkspace"));
    expect(result).toHaveProperty("resolved");
  });

  it("blocks path traversal with ../", () => {
    const result = sandboxed(workspaceDir, path.join(workspaceDir, "..", "etc", "passwd"));
    expect(result).toHaveProperty("error");
    expect("resolved" in result).toBe(false);
  });

  it("blocks absolute paths outside workspace", () => {
    const result = sandboxed(workspaceDir, "/etc/passwd");
    expect(result).toHaveProperty("error");
  });

  it("blocks paths with trailing separator tricks", () => {
    const result = sandboxed(workspaceDir, path.join(workspaceDir, "..", ".."));
    expect(result).toHaveProperty("error");
  });

  it("returns the resolved absolute path on success", () => {
    const target = path.join(scratchpadDir, "sub", "file.txt");
    const result = sandboxed(workspaceDir, target);
    expect(result).toHaveProperty("resolved");
  });

  it("allows writing a new file (parent exists, file does not)", () => {
    const target = path.join(scratchpadDir, "sub", "newfile.txt");
    const result = sandboxed(workspaceDir, target);
    expect(result).toHaveProperty("resolved");
    expect("error" in result).toBe(false);
  });

  // ── Substring-prefix and traversal invariants ──

  it("handles workspace dir name as substring prefix (not just startsWith)", () => {
    const evilDir = path.join(tmpRoot, "workspaces-evil");
    fs.mkdirSync(evilDir, { recursive: true });
    fs.writeFileSync(path.join(evilDir, "file.txt"), "x");
    const result = sandboxed(workspaceDir, path.join(evilDir, "file.txt"));
    expect(result).toHaveProperty("error");
  });

  it("blocks substring-prefix attacks on external paths", () => {
    const extDir = path.join(tmpRoot, "ext");
    const evilDir = path.join(tmpRoot, "ext-evil");
    fs.mkdirSync(extDir, { recursive: true });
    fs.mkdirSync(evilDir, { recursive: true });
    fs.writeFileSync(path.join(evilDir, "secret.txt"), "x");
    registerExistingWorkspace("ExternalPrefix", extDir, workspaceDir);
    const result = sandboxed(workspaceDir, path.join(evilDir, "secret.txt"));
    expect(result).toHaveProperty("error");
  });

  it("blocks traversal out of external workspace root", () => {
    const extDir = path.join(tmpRoot, "ext-traverse");
    fs.mkdirSync(extDir, { recursive: true });
    registerExistingWorkspace("ExternalTraversal", extDir, workspaceDir);
    const result = sandboxed(workspaceDir, path.join(extDir, "..", "other-project", "secret.txt"));
    expect(result).toHaveProperty("error");
  });

  // ── Symlink escape tests ──

  it("blocks symlink pointing outside workspace", () => {
    const linkPath = path.join(scratchpadDir, "escape-link");
    try {
      fs.symlinkSync("/etc", linkPath);
      const result = sandboxed(workspaceDir, path.join(linkPath, "passwd"));
      expect(result).toHaveProperty("error");
    } finally {
      try {
        fs.unlinkSync(linkPath);
      } catch {
        /* cleanup */
      }
    }
  });

  it("blocks symlinked directory pointing outside workspace", () => {
    const linkPath = path.join(scratchpadDir, "home-link");
    const homeDir = os.homedir();
    try {
      fs.symlinkSync(homeDir, linkPath);
      const result = sandboxed(workspaceDir, path.join(linkPath, ".ssh"));
      expect(result).toHaveProperty("error");
    } finally {
      try {
        fs.unlinkSync(linkPath);
      } catch {
        /* cleanup */
      }
    }
  });

  it("allows symlink pointing within workspace", () => {
    const linkPath = path.join(scratchpadDir, "internal-link");
    try {
      fs.symlinkSync(path.join(scratchpadDir, "sub"), linkPath);
      const result = sandboxed(workspaceDir, path.join(linkPath, "file.txt"));
      expect(result).toHaveProperty("resolved");
      expect("error" in result).toBe(false);
    } finally {
      try {
        fs.unlinkSync(linkPath);
      } catch {
        /* cleanup */
      }
    }
  });

  // ── External workspace registry paths ──

  it("allows a path inside an external workspace root", () => {
    const extDir = path.join(tmpRoot, "external-ws");
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, "index.ts"), "test");
    registerExistingWorkspace("ExternalAllowed", extDir, workspaceDir);
    const target = path.join(extDir, "index.ts");
    const result = sandboxed(workspaceDir, target);
    expect(result).toHaveProperty("resolved");
    expect("error" in result).toBe(false);
  });

  it("blocks paths outside all roots even with registry", () => {
    const extDir = path.join(tmpRoot, "external-ws2");
    fs.mkdirSync(extDir, { recursive: true });
    registerExistingWorkspace("ExternalBlocked", extDir, workspaceDir);
    const result = sandboxed(workspaceDir, "/etc/passwd");
    expect(result).toHaveProperty("error");
  });

  it("allows Scratchpad but blocks an unregistered default-root child", () => {
    const inside = path.join(scratchpadDir, "sub", "file.txt");
    const unregistered = path.join(workspaceDir, "unregistered", "file.txt");
    fs.mkdirSync(path.dirname(unregistered), { recursive: true });
    fs.writeFileSync(unregistered, "hidden");
    expect(sandboxed(workspaceDir, inside)).toHaveProperty("resolved");
    expect(sandboxed(workspaceDir, unregistered)).toHaveProperty("error");
  });
});

// ── validateName() ────────────────────────────────────────────────

describe("validateName", () => {
  it("accepts a normal name", () => {
    expect(validateName("My Workspace")).toBeNull();
  });

  it("accepts names with spaces and numbers", () => {
    expect(validateName("Project 2024")).toBeNull();
  });

  it("accepts single character name", () => {
    expect(validateName("a")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(validateName("")).not.toBeNull();
  });

  it("rejects whitespace-only string", () => {
    expect(validateName("   ")).not.toBeNull();
  });

  it("rejects names starting with dot", () => {
    expect(validateName(".hidden")).not.toBeNull();
  });

  it("rejects .. (parent directory traversal)", () => {
    // '..' starts with '.' so validateName blocks it
    expect(validateName("..")).not.toBeNull();
  });

  it("rejects names with forward slash", () => {
    expect(validateName("sub/dir")).not.toBeNull();
  });

  it("rejects names with backslash", () => {
    expect(validateName("sub\\dir")).not.toBeNull();
  });

  it("rejects names with colon", () => {
    expect(validateName("C:")).not.toBeNull();
  });

  it("rejects names longer than 100 characters", () => {
    expect(validateName("a".repeat(101))).not.toBeNull();
  });

  it("accepts names exactly 100 characters", () => {
    expect(validateName("a".repeat(100))).toBeNull();
  });

  it("trims whitespace before checking", () => {
    // " .hidden " trims to ".hidden" which starts with dot
    expect(validateName(" .hidden ")).not.toBeNull();
  });

  it("accepts name with hyphens and underscores", () => {
    expect(validateName("my-workspace_v2")).toBeNull();
  });

  it("rejects prototype-sensitive names", () => {
    expect(validateName("__proto__")).toBe("Name is reserved");
    expect(validateName("constructor")).toBe("Name is reserved");
  });
});

// ── workspace path capabilities ────────────────────────────────────

describe("workspace path capabilities", () => {
  it("consumes directory tokens exactly once", () => {
    const capabilities = createWorkspacePathCapabilityStore();
    const token = capabilities.issue({
      kind: "directory",
      paths: ["C:\\workspaces\\project"],
      webContentsId: 1,
    });

    expect(
      capabilities.consume(token, {
        kind: "directory",
        webContentsId: 1,
      }),
    ).toEqual({
      kind: "directory",
      paths: ["C:\\workspaces\\project"],
      webContentsId: 1,
    });

    expect(
      capabilities.consume(token, {
        kind: "directory",
        webContentsId: 1,
      }),
    ).toEqual({ error: "Invalid or expired workspace path token" });
  });

  it("rejects tokens issued for another webContentsId", () => {
    const capabilities = createWorkspacePathCapabilityStore();
    const token = capabilities.issue({
      kind: "directory",
      paths: ["C:\\workspaces\\project"],
      webContentsId: 1,
    });

    expect(
      capabilities.consume(token, {
        kind: "directory",
        webContentsId: 2,
      }),
    ).toEqual({ error: "Invalid or expired workspace path token" });

    expect(
      capabilities.consume(token, {
        kind: "directory",
        webContentsId: 1,
      }),
    ).toEqual({
      kind: "directory",
      paths: ["C:\\workspaces\\project"],
      webContentsId: 1,
    });
  });

  it("rejects tokens issued for another kind without consuming them", () => {
    const capabilities = createWorkspacePathCapabilityStore();
    const token = capabilities.issue({
      kind: "external-files",
      paths: ["C:\\Downloads\\one.txt"],
      webContentsId: 1,
    });

    expect(
      capabilities.consume(token, {
        kind: "directory",
        webContentsId: 1,
      }),
    ).toEqual({ error: "Invalid or expired workspace path token" });

    expect(
      capabilities.consume(token, {
        kind: "external-files",
        webContentsId: 1,
      }),
    ).toEqual({
      kind: "external-files",
      paths: ["C:\\Downloads\\one.txt"],
      webContentsId: 1,
    });
  });

  it("expires stale tokens", () => {
    let now = 1_000;
    const capabilities = createWorkspacePathCapabilityStore({
      now: () => now,
      ttlMs: 100,
    });
    const token = capabilities.issue({
      kind: "directory",
      paths: ["C:\\workspaces\\project"],
      webContentsId: 1,
    });

    now += 101;

    expect(
      capabilities.consume(token, {
        kind: "directory",
        webContentsId: 1,
      }),
    ).toEqual({ error: "Invalid or expired workspace path token" });
  });

  it("supports external file import batch tokens as single-use", () => {
    const capabilities = createWorkspacePathCapabilityStore();
    const token = capabilities.issue({
      kind: "external-files",
      paths: ["C:\\Downloads\\one.txt", "C:\\Downloads\\two.txt"],
      webContentsId: 1,
    });

    expect(
      capabilities.consume(token, {
        kind: "external-files",
        webContentsId: 1,
      }),
    ).toEqual({
      kind: "external-files",
      paths: ["C:\\Downloads\\one.txt", "C:\\Downloads\\two.txt"],
      webContentsId: 1,
    });

    expect(
      capabilities.consume(token, {
        kind: "external-files",
        webContentsId: 1,
      }),
    ).toEqual({ error: "Invalid or expired workspace path token" });
  });

  it("evicts the oldest entries when maxEntries is exceeded", () => {
    const capabilities = createWorkspacePathCapabilityStore({ maxEntries: 2 });
    const oldestToken = capabilities.issue({
      kind: "directory",
      paths: ["C:\\workspaces\\oldest"],
      webContentsId: 1,
    });
    const middleToken = capabilities.issue({
      kind: "directory",
      paths: ["C:\\workspaces\\middle"],
      webContentsId: 1,
    });
    const newestToken = capabilities.issue({
      kind: "directory",
      paths: ["C:\\workspaces\\newest"],
      webContentsId: 1,
    });

    expect(
      capabilities.consume(oldestToken, {
        kind: "directory",
        webContentsId: 1,
      }),
    ).toEqual({ error: "Invalid or expired workspace path token" });
    expect(
      capabilities.consume(middleToken, {
        kind: "directory",
        webContentsId: 1,
      }),
    ).toEqual({
      kind: "directory",
      paths: ["C:\\workspaces\\middle"],
      webContentsId: 1,
    });
    expect(
      capabilities.consume(newestToken, {
        kind: "directory",
        webContentsId: 1,
      }),
    ).toEqual({
      kind: "directory",
      paths: ["C:\\workspaces\\newest"],
      webContentsId: 1,
    });
  });

  it("defensively copies issued and consumed paths arrays", () => {
    const capabilities = createWorkspacePathCapabilityStore();
    const paths = ["C:\\workspaces\\project"];
    const token = capabilities.issue({
      kind: "directory",
      paths,
      webContentsId: 1,
    });
    const secondToken = capabilities.issue({
      kind: "directory",
      paths,
      webContentsId: 1,
    });
    paths.push("C:\\workspaces\\mutated-after-issue");

    const consumed = capabilities.consume(token, {
      kind: "directory",
      webContentsId: 1,
    });

    expect(consumed).toEqual({
      kind: "directory",
      paths: ["C:\\workspaces\\project"],
      webContentsId: 1,
    });
    if ("error" in consumed) {
      throw new Error("Expected workspace path token to be valid");
    }
    consumed.paths.push("C:\\workspaces\\mutated-after-consume");

    expect(
      capabilities.consume(secondToken, {
        kind: "directory",
        webContentsId: 1,
      }),
    ).toEqual({
      kind: "directory",
      paths: ["C:\\workspaces\\project"],
      webContentsId: 1,
    });
  });
});

// ── Handler registration ──────────────────────────────────────────

describe("registerWorkspaceHandlers", () => {
  let workspaceDir: string;
  let externalDir: string;
  const senderDestroyedCallbacks = new Map<number, Array<() => void>>();
  const senderNavigationCallbacks = new Map<number, Array<() => void>>();

  function senderEvent(webContentsId: number) {
    const senderFrame = {};
    Object.assign(senderFrame, { top: senderFrame });
    return {
      sender: {
        id: webContentsId,
        mainFrame: senderFrame,
        once: (eventName: string, callback: () => void) => {
          const callbackMap =
            eventName === "destroyed"
              ? senderDestroyedCallbacks
              : eventName === "did-start-navigation"
                ? senderNavigationCallbacks
                : undefined;
          if (!callbackMap) return;
          const callbacks = callbackMap.get(webContentsId) ?? [];
          callbacks.push(callback);
          callbackMap.set(webContentsId, callbacks);
        },
      },
      senderFrame,
    };
  }

  function destroySender(webContentsId: number) {
    const callbacks = senderDestroyedCallbacks.get(webContentsId) ?? [];
    senderDestroyedCallbacks.delete(webContentsId);
    for (const callback of callbacks) callback();
  }

  function navigateSender(webContentsId: number) {
    const callbacks = senderNavigationCallbacks.get(webContentsId) ?? [];
    senderNavigationCallbacks.delete(webContentsId);
    for (const callback of callbacks) callback();
  }

  async function invokeWorkspaceHandler(
    channel:
      | "workspace:createWorkspace"
      | "workspace:deleteWorkspace"
      | "workspace:getRoot"
      | "workspace:listWorkspaces"
      | "workspace:listRepositoryAgents"
      | "workspace:pickFolder"
      | "workspace:readFile"
      | "workspace:renameWorkspace"
      | "workspace:registerExternalFileImportBridge"
      | "workspace:authorizeExternalFiles"
      | "workspace:copyExternalFiles",
    webContentsId: number,
    ...args: unknown[]
  ): Promise<WorkspaceHandlerResult> {
    const handler = electronMocks.capturedHandlers.get(channel);
    if (!handler) throw new Error(`Handler ${channel} was not registered`);
    const deauthorize = authorizeIpcWebContents(webContentsId);
    try {
      const result = await handler(senderEvent(webContentsId), ...args);
      if (!isWorkspaceHandlerResult(result)) {
        throw new Error(`Handler ${channel} returned an invalid result`);
      }
      return result;
    } finally {
      deauthorize();
    }
  }

  async function registerExternalFileImportBridge(
    webContentsId: number,
    bridgeToken = `bridge-token-${webContentsId}`,
  ): Promise<string> {
    const result = await invokeWorkspaceHandler(
      "workspace:registerExternalFileImportBridge",
      webContentsId,
      bridgeToken,
    );
    if (!result.success) throw new Error(result.error ?? "Failed to register bridge token");
    return bridgeToken;
  }

  async function authorizeExternalFiles(
    webContentsId: number,
    externalPaths: string[],
  ): Promise<WorkspaceHandlerResult> {
    const bridgeToken = await registerExternalFileImportBridge(webContentsId);
    return invokeWorkspaceHandler(
      "workspace:authorizeExternalFiles",
      webContentsId,
      bridgeToken,
      externalPaths,
    );
  }

  beforeEach(() => {
    fs.rmSync(testPaths.root, { recursive: true, force: true });
    fs.mkdirSync(testPaths.root, { recursive: true });
    workspaceDir = path.join(testPaths.root, "workspaces");
    externalDir = path.join(testPaths.root, "external-project");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(externalDir, { recursive: true });
    saveWorkspaceStore({
      version: 3,
      activeWorkspace: "Scratchpad",
      workspaces: {
        Scratchpad: { origin: "scratchpad", expandedPaths: [] },
      },
    } satisfies WorkspaceStore);
    electronMocks.capturedHandlers.clear();
    electronMocks.appOnceCallbacks.length = 0;
    electronMocks.showOpenDialog.mockReset();
    senderDestroyedCallbacks.clear();
    senderNavigationCallbacks.clear();
    registerWorkspaceHandlers(workspaceDir);
  });

  afterEach(() => {
    for (const callback of electronMocks.appOnceCallbacks.splice(0)) {
      callback();
    }
    fs.rmSync(testPaths.root, { recursive: true, force: true });
  });

  it("rejects external workspace creation when the second argument is a raw path", async () => {
    const result = await invokeWorkspaceHandler(
      "workspace:createWorkspace",
      1,
      "Raw External",
      externalDir,
    );

    expect(result).toEqual({
      success: false,
      error: "Invalid or expired workspace path token",
    });
    expect(getWorkspaceRegistry()).not.toHaveProperty("Raw External");
  });

  it("reads workspace files without a document capability", async () => {
    const workspaceFile = path.join(workspaceDir, "Scratchpad", "inside.md");
    fs.writeFileSync(workspaceFile, "# Inside");

    await expect(invokeWorkspaceHandler("workspace:readFile", 1, workspaceFile)).resolves.toEqual({
      success: true,
      type: "markdown",
      content: "# Inside",
    });
  });

  it("reads an outside file only through its exact runtime document capability", async () => {
    const externalFile = path.join(externalDir, "outside.md");
    const otherFile = path.join(externalDir, "other.md");
    fs.writeFileSync(externalFile, "# Outside");
    fs.writeFileSync(otherFile, "# Other");
    const documentAccess = createRuntimeDocumentAccessStore();
    const readCapability = documentAccess.issue(externalFile);
    electronMocks.capturedHandlers.clear();
    registerWorkspaceHandlers(workspaceDir, undefined, undefined, documentAccess);

    await expect(
      invokeWorkspaceHandler("workspace:readFile", 1, externalFile, readCapability),
    ).resolves.toEqual({
      success: true,
      type: "markdown",
      content: "# Outside",
    });
    await expect(
      invokeWorkspaceHandler("workspace:readFile", 1, otherFile, readCapability),
    ).resolves.toEqual({
      success: false,
      error: "File access is no longer available",
    });
  });

  it("returns a user-facing denial for an outside file without a capability", async () => {
    const externalFile = path.join(externalDir, "outside.md");
    fs.writeFileSync(externalFile, "# Outside");

    const result = await invokeWorkspaceHandler("workspace:readFile", 1, externalFile);

    expect(result).toEqual({
      success: false,
      error: "This location isn't available in the current workspace",
    });
  });

  it("lists repository agents through the session manager's canonical resolver", async () => {
    const listRepositoryAgentsForMainSession = vi
      .fn<(workspaceName: string) => SessionRepositoryAgent[]>()
      .mockReturnValue([
        {
          name: "Reviewer",
          path: ".github/agents/reviewer.agent.md",
          description: "Reviews changes",
          identity: {
            version: 1,
            normalizedPath: ".github/agents/reviewer.agent.md",
            declaredName: "Reviewer",
            contentDigest: "reviewer-v1",
          },
        },
      ]);
    registerWorkspaceHandlers(
      workspaceDir,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- focused IPC dependency double
      { listRepositoryAgentsForMainSession } as unknown as SessionManager,
    );

    const result = await invokeWorkspaceHandler("workspace:listRepositoryAgents", 1, "Project");

    expect(result).toEqual({
      success: true,
      agents: [
        {
          name: "Reviewer",
          path: ".github/agents/reviewer.agent.md",
          description: "Reviews changes",
          identity: {
            version: 1,
            normalizedPath: ".github/agents/reviewer.agent.md",
            declaredName: "Reviewer",
            contentDigest: "reviewer-v1",
          },
        },
      ],
    });
    expect(listRepositoryAgentsForMainSession).toHaveBeenCalledWith("Project");
  });

  it("creates an external workspace with a fresh folder picker token", async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [externalDir],
    });

    const pickResult = await invokeWorkspaceHandler("workspace:pickFolder", 1);
    expect(pickResult).toMatchObject({
      success: true,
      folderPath: path.resolve(externalDir),
    });
    expect(pickResult.folderToken).toEqual(expect.any(String));

    const createResult = await invokeWorkspaceHandler(
      "workspace:createWorkspace",
      1,
      "External Project",
      pickResult.folderToken,
    );

    expect(createResult).toEqual({ success: true });
    expect(getWorkspaceRegistry()["External Project"]?.externalPath).toBe(
      fs.realpathSync(externalDir),
    );
  });

  it("consumes a folder picker token even when later folder validation fails", async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [externalDir],
    });

    const pickResult = await invokeWorkspaceHandler("workspace:pickFolder", 1);
    const token = pickResult.folderToken;
    fs.rmSync(externalDir, { recursive: true, force: true });

    await expect(
      invokeWorkspaceHandler("workspace:createWorkspace", 1, "Deleted External", token),
    ).resolves.toEqual({
      success: false,
      error: "Selected folder does not exist",
    });

    await expect(
      invokeWorkspaceHandler("workspace:createWorkspace", 1, "Deleted External Retry", token),
    ).resolves.toEqual({
      success: false,
      error: "Invalid or expired workspace path token",
    });
    expect(getWorkspaceRegistry()).not.toHaveProperty("Deleted External");
    expect(getWorkspaceRegistry()).not.toHaveProperty("Deleted External Retry");
  });

  it("rejects a folder picker token after it has been used once", async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [externalDir],
    });
    const pickResult = await invokeWorkspaceHandler("workspace:pickFolder", 1);
    const token = pickResult.folderToken;

    expect(
      await invokeWorkspaceHandler("workspace:createWorkspace", 1, "External Project", token),
    ).toEqual({ success: true });

    const secondResult = await invokeWorkspaceHandler(
      "workspace:createWorkspace",
      1,
      "Second External",
      token,
    );
    expect(secondResult).toEqual({
      success: false,
      error: "Invalid or expired workspace path token",
    });
    expect(getWorkspaceRegistry()).not.toHaveProperty("Second External");
  });

  it("rejects a folder picker token minted for another webContentsId", async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [externalDir],
    });
    const pickResult = await invokeWorkspaceHandler("workspace:pickFolder", 1);

    const result = await invokeWorkspaceHandler(
      "workspace:createWorkspace",
      2,
      "Wrong Sender",
      pickResult.folderToken,
    );

    expect(result).toEqual({
      success: false,
      error: "Invalid or expired workspace path token",
    });
    expect(getWorkspaceRegistry()).not.toHaveProperty("Wrong Sender");
  });

  it("creates and registers a managed workspace without a folder picker token", async () => {
    const result = await invokeWorkspaceHandler("workspace:createWorkspace", 1, "Scratch Child");

    expect(result).toEqual({ success: true });
    expect(fs.existsSync(path.join(workspaceDir, "Scratch Child"))).toBe(true);
    expect(getWorkspaceRegistry()["Scratch Child"]).toMatchObject({
      origin: "user-created",
      identity: { version: 1 },
    });
    expect(
      await invokeWorkspaceHandler(
        "workspace:renameWorkspace",
        1,
        "Scratch Child",
        "Scratch Child",
      ),
    ).toEqual({ success: true });
    expect(getWorkspaceRegistry()).toHaveProperty("Scratch Child");
  });

  it("serializes UI workspace creation with rename and delete operations", async () => {
    const runWorkspaceLifecycleOperation = vi
      .fn<(operation: () => Promise<unknown>) => Promise<unknown>>()
      .mockImplementation(async (operation) => operation());
    registerWorkspaceHandlers(
      workspaceDir,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- focused IPC dependency double
      { runWorkspaceLifecycleOperation } as unknown as SessionManager,
    );

    await expect(
      invokeWorkspaceHandler("workspace:createWorkspace", 1, "Serialized Project"),
    ).resolves.toEqual({ success: true });
    expect(runWorkspaceLifecycleOperation).toHaveBeenCalledOnce();
    expect(getWorkspaceRegistry()["Serialized Project"]).toMatchObject({
      origin: "user-created",
    });
  });

  it("rejects getRoot for an unregistered directory even when it exists", async () => {
    fs.mkdirSync(path.join(workspaceDir, "marshal-final-evidence-review"), { recursive: true });

    const result = await invokeWorkspaceHandler(
      "workspace:getRoot",
      1,
      "marshal-final-evidence-review",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("unavailable");
  });

  it("keeps managed rename and delete operations consistent with the registry", async () => {
    expect(await invokeWorkspaceHandler("workspace:createWorkspace", 1, "Managed Project")).toEqual(
      { success: true },
    );

    expect(
      await invokeWorkspaceHandler(
        "workspace:renameWorkspace",
        1,
        "Managed Project",
        "Renamed Project",
      ),
    ).toEqual({ success: true });
    expect(fs.existsSync(path.join(workspaceDir, "Managed Project"))).toBe(false);
    expect(fs.existsSync(path.join(workspaceDir, "Renamed Project"))).toBe(true);
    expect(getWorkspaceRegistry()).not.toHaveProperty("Managed Project");
    expect(getWorkspaceRegistry()["Renamed Project"]).toMatchObject({
      origin: "user-created",
    });

    expect(await invokeWorkspaceHandler("workspace:deleteWorkspace", 1, "Renamed Project")).toEqual(
      { success: true },
    );
    expect(fs.existsSync(path.join(workspaceDir, "Renamed Project"))).toBe(false);
    expect(getWorkspaceRegistry()).not.toHaveProperty("Renamed Project");
  });

  it("enumerates manifest-backed fixture workspaces through the real IPC handler", async () => {
    const fixtureDir = path.join(testPaths.root, "fixtures", "Project");
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(
      getE2EWorkspaceFixtureManifestPath(testPaths.root),
      JSON.stringify({
        version: 1,
        externalWorkspaces: [{ name: "Project", relativePath: "fixtures/Project" }],
      }),
    );
    installE2EWorkspaceFixtures(workspaceDir, {
      enabled: true,
      dataDir: testPaths.root,
    });

    const result = await invokeWorkspaceHandler("workspace:listWorkspaces", 1);

    expect(result).toMatchObject({
      success: true,
      workspaces: ["Scratchpad", "Project"],
      externalWorkspaces: ["Project"],
    });
    expect(result.workspaceBindings).toEqual([
      expect.objectContaining({
        name: "Scratchpad",
        identity: expect.objectContaining({ version: 1 }),
      }),
      expect.objectContaining({
        name: "Project",
        identity: expect.objectContaining({ version: 1 }),
      }),
    ]);
  });

  it("lists only explicit roots and keeps generated folders and worktrees hidden", async () => {
    const visibleExternalDir = path.join(testPaths.root, "visible-external");
    const generatedWorktreeDir = path.join(
      testPaths.appData,
      "marshal-worktrees",
      "generated-worktree-12345678",
    );
    for (const name of [
      "1eacb6d6-8975-4093-beda-9ad72deac778",
      "agent",
      "marshal-final-evidence-review",
      "isolated-installed-data",
      "out",
      "TestResults",
    ]) {
      fs.mkdirSync(path.join(workspaceDir, name), { recursive: true });
    }
    fs.mkdirSync(visibleExternalDir, { recursive: true });
    fs.mkdirSync(generatedWorktreeDir, { recursive: true });
    registerExistingWorkspace("Visible External", visibleExternalDir, workspaceDir);

    const result = await invokeWorkspaceHandler("workspace:listWorkspaces", 1);

    expect(result).toMatchObject({
      success: true,
      workspaces: ["Scratchpad", "Visible External"],
      externalWorkspaces: ["Visible External"],
    });
    expect(result.workspaceBindings?.map((binding) => binding.name)).toEqual([
      "Scratchpad",
      "Visible External",
    ]);
    expect(result.workspaceBindings?.[0]?.identity).toMatchObject({
      version: 1,
      device: expect.any(String),
      inode: expect.any(String),
      birthtimeNs: expect.any(String),
    });
    expect(JSON.stringify(result.workspaceBindings)).not.toContain(workspaceDir);
    expect(fs.existsSync(path.join(workspaceDir, "marshal-final-evidence-review"))).toBe(true);
    expect(fs.existsSync(generatedWorktreeDir)).toBe(true);

    registerExistingWorkspace("Explicit Worktree", generatedWorktreeDir, workspaceDir);
    const explicitlyRegistered = await invokeWorkspaceHandler("workspace:listWorkspaces", 1);
    expect(explicitlyRegistered.workspaces).toEqual([
      "Scratchpad",
      "Explicit Worktree",
      "Visible External",
    ]);
  });

  it("rejects external file copy when the first argument is a raw path array", async () => {
    const sourceFile = path.join(externalDir, "raw-source.txt");
    fs.writeFileSync(sourceFile, "raw");
    const destDir = path.join(workspaceDir, "Scratchpad");

    const result = await invokeWorkspaceHandler(
      "workspace:copyExternalFiles",
      1,
      [sourceFile],
      destDir,
    );

    expect(result).toEqual({
      success: false,
      error: "Invalid or expired workspace path token",
    });
    expect(fs.existsSync(path.join(destDir, "raw-source.txt"))).toBe(false);
  });

  it("rejects external file authorization without a matching bridge token", async () => {
    const sourceFile = path.join(externalDir, "raw-authorize.txt");
    fs.writeFileSync(sourceFile, "raw");

    await expect(
      invokeWorkspaceHandler("workspace:authorizeExternalFiles", 1, undefined, [sourceFile]),
    ).resolves.toEqual({
      success: false,
      error: "Unauthorized external file import",
    });

    await expect(
      invokeWorkspaceHandler("workspace:authorizeExternalFiles", 1, "", [sourceFile]),
    ).resolves.toEqual({
      success: false,
      error: "Unauthorized external file import",
    });

    await expect(
      invokeWorkspaceHandler("workspace:authorizeExternalFiles", 1, "wrong-token", [sourceFile]),
    ).resolves.toEqual({
      success: false,
      error: "Unauthorized external file import",
    });
  });

  it("rejects non-string and blank bridge tokens before authorizing external files", async () => {
    const sourceFile = path.join(externalDir, "blank-bridge-token.txt");
    fs.writeFileSync(sourceFile, "secret");

    await expect(
      invokeWorkspaceHandler("workspace:registerExternalFileImportBridge", 1, "bridge-token-1"),
    ).resolves.toEqual({ success: true });

    await Promise.all(
      [undefined, "", "   ", 123].map((bridgeToken) =>
        expect(
          invokeWorkspaceHandler("workspace:authorizeExternalFiles", 1, bridgeToken, [sourceFile]),
        ).resolves.toEqual({
          success: false,
          error: "Unauthorized external file import",
        }),
      ),
    );
  });

  it("rejects external file authorization when no dropped paths resolve", async () => {
    await expect(
      invokeWorkspaceHandler("workspace:registerExternalFileImportBridge", 1, "bridge-token-1"),
    ).resolves.toEqual({ success: true });

    await expect(
      invokeWorkspaceHandler("workspace:authorizeExternalFiles", 1, "bridge-token-1", [
        path.join(externalDir, "missing.txt"),
      ]),
    ).resolves.toEqual({
      success: false,
      error: "No external files to import",
    });
  });

  it("authorizes external files only for the webContents that registered the bridge token", async () => {
    const sourceFile = path.join(externalDir, "registered-authorize.txt");
    fs.writeFileSync(sourceFile, "registered");

    await expect(
      invokeWorkspaceHandler("workspace:registerExternalFileImportBridge", 1, "bridge-token-1"),
    ).resolves.toEqual({ success: true });

    await expect(
      invokeWorkspaceHandler("workspace:authorizeExternalFiles", 1, "bridge-token-1", [sourceFile]),
    ).resolves.toMatchObject({
      success: true,
      importToken: expect.any(String),
    });

    await expect(
      invokeWorkspaceHandler("workspace:authorizeExternalFiles", 2, "bridge-token-1", [sourceFile]),
    ).resolves.toEqual({
      success: false,
      error: "Unauthorized external file import",
    });
  });

  it("does not allow a later registration to overwrite the bridge token", async () => {
    const sourceFile = path.join(externalDir, "first-token-wins.txt");
    fs.writeFileSync(sourceFile, "first");

    await expect(
      invokeWorkspaceHandler("workspace:registerExternalFileImportBridge", 1, "first-token"),
    ).resolves.toEqual({ success: true });
    await expect(
      invokeWorkspaceHandler("workspace:registerExternalFileImportBridge", 1, "second-token"),
    ).resolves.toEqual({
      success: false,
      error: "External file import bridge already registered",
    });

    await expect(
      invokeWorkspaceHandler("workspace:authorizeExternalFiles", 1, "second-token", [sourceFile]),
    ).resolves.toEqual({
      success: false,
      error: "Unauthorized external file import",
    });
    await expect(
      invokeWorkspaceHandler("workspace:authorizeExternalFiles", 1, "first-token", [sourceFile]),
    ).resolves.toMatchObject({
      success: true,
      importToken: expect.any(String),
    });
  });

  it("cleans up the external file import bridge token before a sender navigation reloads preload", async () => {
    const sourceFile = path.join(externalDir, "navigation-reload-source.txt");
    fs.writeFileSync(sourceFile, "navigation");

    await expect(
      invokeWorkspaceHandler("workspace:registerExternalFileImportBridge", 1, "first-token"),
    ).resolves.toEqual({ success: true });

    navigateSender(1);

    await expect(
      invokeWorkspaceHandler("workspace:registerExternalFileImportBridge", 1, "second-token"),
    ).resolves.toEqual({ success: true });
    await expect(
      invokeWorkspaceHandler("workspace:authorizeExternalFiles", 1, "first-token", [sourceFile]),
    ).resolves.toEqual({
      success: false,
      error: "Unauthorized external file import",
    });
    await expect(
      invokeWorkspaceHandler("workspace:authorizeExternalFiles", 1, "second-token", [sourceFile]),
    ).resolves.toMatchObject({
      success: true,
      importToken: expect.any(String),
    });
  });

  it("cleans up the external file import bridge token when the sender is destroyed", async () => {
    const sourceFile = path.join(externalDir, "destroyed-sender-source.txt");
    fs.writeFileSync(sourceFile, "destroyed");

    await expect(
      invokeWorkspaceHandler("workspace:registerExternalFileImportBridge", 1, "bridge-token-1"),
    ).resolves.toEqual({ success: true });

    destroySender(1);

    await expect(
      invokeWorkspaceHandler("workspace:authorizeExternalFiles", 1, "bridge-token-1", [sourceFile]),
    ).resolves.toEqual({
      success: false,
      error: "Unauthorized external file import",
    });
  });

  it("authorizes external files and copies with a fresh token exactly once", async () => {
    const sourceFile = path.join(externalDir, "authorized.txt");
    fs.writeFileSync(sourceFile, "authorized");
    const destDir = path.join(workspaceDir, "Scratchpad");

    const authorizeResult = await authorizeExternalFiles(1, [sourceFile]);

    expect(authorizeResult).toMatchObject({
      success: true,
      importToken: expect.any(String),
    });

    const copyResult = await invokeWorkspaceHandler(
      "workspace:copyExternalFiles",
      1,
      authorizeResult.importToken,
      destDir,
    );

    expect(copyResult).toEqual({ success: true, copied: 1 });
    expect(fs.readFileSync(path.join(destDir, "authorized.txt"), "utf8")).toBe("authorized");

    const reuseResult = await invokeWorkspaceHandler(
      "workspace:copyExternalFiles",
      1,
      authorizeResult.importToken,
      destDir,
    );
    expect(reuseResult).toEqual({
      success: false,
      error: "Invalid or expired workspace path token",
    });
  });

  it("does not accept path capability tokens issued by a prior handler registration", async () => {
    const sourceFile = path.join(externalDir, "old-registration-token.txt");
    fs.writeFileSync(sourceFile, "old registration");
    const destDir = path.join(workspaceDir, "Scratchpad");

    const authorizeResult = await authorizeExternalFiles(1, [sourceFile]);
    expect(authorizeResult).toMatchObject({
      success: true,
      importToken: expect.any(String),
    });

    registerWorkspaceHandlers(workspaceDir);

    await expect(
      invokeWorkspaceHandler(
        "workspace:copyExternalFiles",
        1,
        authorizeResult.importToken,
        destDir,
      ),
    ).resolves.toEqual({
      success: false,
      error: "Invalid or expired workspace path token",
    });
  });

  it("imports a clean nested directory into the workspace", async () => {
    const sourceDir = path.join(externalDir, "clean-source");
    const nestedDir = path.join(sourceDir, "nested");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "top-level.txt"), "top level");
    fs.writeFileSync(path.join(nestedDir, "nested.txt"), "nested file");
    const destDir = path.join(workspaceDir, "Scratchpad");

    const authorizeResult = await authorizeExternalFiles(1, [sourceDir]);

    const copyResult = await invokeWorkspaceHandler(
      "workspace:copyExternalFiles",
      1,
      authorizeResult.importToken,
      destDir,
    );

    expect(copyResult).toEqual({ success: true, copied: 1 });
    expect(fs.readFileSync(path.join(destDir, "clean-source", "top-level.txt"), "utf8")).toBe(
      "top level",
    );
    expect(
      fs.readFileSync(path.join(destDir, "clean-source", "nested", "nested.txt"), "utf8"),
    ).toBe("nested file");
  });

  it("rejects a top-level symlink directory import without leaving a destination", async () => {
    const targetDir = path.join(testPaths.root, "top-level-symlink-target");
    const linkPath = path.join(externalDir, "top-level-symlink");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "target.txt"), "target");
    fs.symlinkSync(targetDir, linkPath, process.platform === "win32" ? "junction" : "dir");
    const destDir = path.join(workspaceDir, "Scratchpad");

    const authorizeResult = await authorizeExternalFiles(1, [linkPath]);

    const copyResult = await invokeWorkspaceHandler(
      "workspace:copyExternalFiles",
      1,
      authorizeResult.importToken,
      destDir,
    );

    expect(copyResult).toEqual({
      success: false,
      error: "Symbolic links cannot be imported into the workspace",
    });
    expect(fs.existsSync(path.join(destDir, "top-level-symlink"))).toBe(false);
  });

  it("rejects directory imports that contain symlinks and rolls back created destination", async () => {
    const tmpRoot = path.join(testPaths.root, "symlink-import");
    const sourceDir = path.join(tmpRoot, "source");
    const allowedFile = path.join(sourceDir, "allowed.txt");
    const secretDir = path.join(tmpRoot, "secret");
    const linkPath = path.join(sourceDir, "secret-link");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(secretDir, { recursive: true });
    fs.writeFileSync(allowedFile, "ok");
    fs.writeFileSync(path.join(secretDir, "secret.txt"), "secret");
    fs.symlinkSync(secretDir, linkPath, process.platform === "win32" ? "junction" : "dir");
    const destDir = path.join(workspaceDir, "Scratchpad");

    const authorizeResult = await authorizeExternalFiles(1, [sourceDir]);

    const copyResult = await invokeWorkspaceHandler(
      "workspace:copyExternalFiles",
      1,
      authorizeResult.importToken,
      destDir,
    );

    expect(copyResult).toEqual({
      success: false,
      error: "Symbolic links cannot be imported into the workspace",
    });
    expect(fs.existsSync(path.join(destDir, "source"))).toBe(false);
    expect(fs.existsSync(path.join(destDir, "source", "allowed.txt"))).toBe(false);
  });

  it("rejects a multi-item import containing a symlink before copying any item", async () => {
    const cleanFile = path.join(externalDir, "clean-before-symlink.txt");
    const targetDir = path.join(testPaths.root, "multi-item-symlink-target");
    const linkPath = path.join(externalDir, "multi-item-symlink");
    fs.writeFileSync(cleanFile, "clean");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "target.txt"), "target");
    fs.symlinkSync(targetDir, linkPath, process.platform === "win32" ? "junction" : "dir");
    const destDir = path.join(workspaceDir, "Scratchpad");

    const authorizeResult = await authorizeExternalFiles(1, [cleanFile, linkPath]);

    const copyResult = await invokeWorkspaceHandler(
      "workspace:copyExternalFiles",
      1,
      authorizeResult.importToken,
      destDir,
    );

    expect(copyResult).toEqual({
      success: false,
      error: "Symbolic links cannot be imported into the workspace",
    });
    expect(fs.existsSync(path.join(destDir, "clean-before-symlink.txt"))).toBe(false);
    expect(fs.existsSync(path.join(destDir, "multi-item-symlink"))).toBe(false);
  });

  it("rejects external file import tokens minted for another webContentsId", async () => {
    const sourceFile = path.join(externalDir, "wrong-sender.txt");
    fs.writeFileSync(sourceFile, "wrong sender");
    const destDir = path.join(workspaceDir, "Scratchpad");

    const authorizeResult = await authorizeExternalFiles(1, [sourceFile]);

    const copyResult = await invokeWorkspaceHandler(
      "workspace:copyExternalFiles",
      2,
      authorizeResult.importToken,
      destDir,
    );

    expect(copyResult).toEqual({
      success: false,
      error: "Invalid or expired workspace path token",
    });
    expect(fs.existsSync(path.join(destDir, "wrong-sender.txt"))).toBe(false);
  });

  it("sandboxed blocks ../../etc/passwd pattern", () => {
    const wsDir = path.resolve("/workspaces");
    const result = sandboxed(wsDir, path.join(wsDir, "..", "..", "etc", "passwd"));
    expect(result).toHaveProperty("error");
    expect("resolved" in result).toBe(false);
  });

  it("validateName blocks all path traversal characters", () => {
    const traversalInputs = ["..", "../etc", "..\\etc", "foo/bar", "foo\\bar", "C:", ".git"];
    for (const input of traversalInputs) {
      expect(validateName(input), `Expected "${input}" to be rejected`).not.toBeNull();
    }
  });

  it("sandboxed + validateName together prevent workspace escape", () => {
    // Even if validateName is bypassed, sandboxed catches it
    const wsDir = path.resolve("/workspaces");
    const malicious = path.join(wsDir, "..", "secrets");
    const result = sandboxed(wsDir, malicious);
    expect(result).toHaveProperty("error");

    // And validateName catches traversal names before they reach sandboxed
    expect(validateName("..")).not.toBeNull();
    expect(validateName("../secrets")).not.toBeNull();
  });
});
