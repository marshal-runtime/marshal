import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appDataState = vi.hoisted(() => ({ path: "" }));

vi.mock("./app-paths", () => ({
  getAppDataDir: () => appDataState.path,
}));

const tempDirs: string[] = [];
let workspaceDir: string;

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function storePath(): string {
  return path.join(appDataState.path, "marshal-sessions", "workspaces.json");
}

function legacyRegistryPath(): string {
  return path.join(appDataState.path, "marshal-sessions", "workspace-registry.json");
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function freshImport() {
  vi.resetModules();
  return await import("./workspace-store");
}

beforeEach(() => {
  appDataState.path = makeTempDir("m-workspace-store-app-");
  workspaceDir = makeTempDir("m-workspace-store-root-");
  fs.mkdirSync(path.join(workspaceDir, "Scratchpad"), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0).reverse()) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("workspace-store explicit registry", () => {
  it("starts with only the reserved Scratchpad", async () => {
    const { getWorkspaceRegistry, listRegisteredWorkspaces, loadWorkspaceStore } =
      await freshImport();

    expect(loadWorkspaceStore()).toEqual({
      version: 3,
      activeWorkspace: "Scratchpad",
      workspaces: {
        Scratchpad: { origin: "scratchpad", expandedPaths: [] },
      },
    });
    expect(Object.keys(getWorkspaceRegistry())).toEqual(["Scratchpad"]);
    expect(listRegisteredWorkspaces(workspaceDir).map((workspace) => workspace.name)).toEqual([
      "Scratchpad",
    ]);
  });

  it("renders the default workspace display name while the persisted identifier stays 'Scratchpad'", async () => {
    const {
      SCRATCHPAD_WORKSPACE_NAME,
      DEFAULT_WORKSPACE_DISPLAY_NAME,
      workspaceDisplayName,
      loadWorkspaceStore,
    } = await freshImport();

    // The persisted key / on-disk directory name / origin discriminant are all
    // still "Scratchpad" — only presentation swaps in the display name (AC5).
    expect(SCRATCHPAD_WORKSPACE_NAME).toBe("Scratchpad");
    expect(DEFAULT_WORKSPACE_DISPLAY_NAME).toBe("Marshal's workspace");

    const store = loadWorkspaceStore();
    expect(store.activeWorkspace).toBe(SCRATCHPAD_WORKSPACE_NAME);
    expect(Object.keys(store.workspaces)).toContain(SCRATCHPAD_WORKSPACE_NAME);

    expect(workspaceDisplayName(SCRATCHPAD_WORKSPACE_NAME)).toBe(DEFAULT_WORKSPACE_DISPLAY_NAME);
    // Non-default workspaces render their own name verbatim.
    expect(workspaceDisplayName("my-project")).toBe("my-project");
  });

  it("does not promote arbitrary default-root children or generic mkdir output", async () => {
    const leakedNames = [
      "1eacb6d6-8975-4093-beda-9ad72deac778",
      "agent",
      "marshal-final-evidence-review",
      "isolated-installed-data",
      "out",
      "TestResults",
    ];
    for (const name of leakedNames) {
      fs.mkdirSync(path.join(workspaceDir, name), { recursive: true });
    }
    fs.mkdirSync(path.join(workspaceDir, "Scratchpad", "generated-output"), { recursive: true });
    fs.mkdirSync(path.join(appDataState.path, "marshal-worktrees", "internal-worktree-12345678"), {
      recursive: true,
    });

    const { listRegisteredWorkspaces } = await freshImport();

    expect(listRegisteredWorkspaces(workspaceDir).map((workspace) => workspace.name)).toEqual([
      "Scratchpad",
    ]);
    for (const name of leakedNames) {
      expect(fs.existsSync(path.join(workspaceDir, name))).toBe(true);
    }
  });

  it("persists an explicitly created managed workspace across restart", async () => {
    const first = await freshImport();
    const created = first.registerManagedWorkspace("Project", workspaceDir);

    expect(created).toMatchObject({
      name: "Project",
      origin: "user-created",
      external: false,
    });
    expect(first.getWorkspaceRegistry().Project).toMatchObject({
      origin: "user-created",
      identity: { version: 1 },
    });

    const second = await freshImport();
    expect(
      second.listRegisteredWorkspaces(workspaceDir).map((workspace) => workspace.name),
    ).toEqual(["Scratchpad", "Project"]);
    expect(second.getWorkspaceRoot("Project", workspaceDir)).toBe(fs.realpathSync(created.path));
  });

  it("persists explicitly added external workspaces across restart", async () => {
    const externalRoot = makeTempDir("m-workspace-external-");
    const first = await freshImport();
    first.registerExistingWorkspace("PowerQuery", externalRoot, workspaceDir);

    const second = await freshImport();
    expect(second.listRegisteredWorkspaces(workspaceDir)).toEqual([
      expect.objectContaining({ name: "Scratchpad", origin: "scratchpad" }),
      expect.objectContaining({
        name: "PowerQuery",
        path: fs.realpathSync(externalRoot),
        origin: "user-added",
        external: true,
      }),
    ]);
  });

  it("migrates only provenance-backed external roots and leaves leaked directories untouched", async () => {
    const externalRoots = Object.fromEntries(
      ["marshal", "PBI", "PowerQuery"].map((name) => [name, makeTempDir(`m-workspace-${name}-`)]),
    );
    const internalWorktree = path.join(
      appDataState.path,
      "marshal-worktrees",
      "internal-worktree-12345678",
    );
    const legacyWorktree = path.join(appDataState.path, "m-worktrees", "legacy-worktree-87654321");
    fs.mkdirSync(internalWorktree, { recursive: true });
    fs.mkdirSync(legacyWorktree, { recursive: true });
    for (const name of [
      "1eacb6d6-8975-4093-beda-9ad72deac778",
      "marshal-final-evidence-review",
      "isolated-ajv-data",
      "out",
      "TestResults",
    ]) {
      fs.mkdirSync(path.join(workspaceDir, name), { recursive: true });
    }
    writeJson(storePath(), {
      version: 2,
      activeWorkspace: "marshal-final-evidence-review",
      workspaces: {
        marshal: { externalPath: externalRoots.marshal, expandedPaths: [] },
        PBI: { externalPath: externalRoots.PBI, expandedPaths: ["src"] },
        PowerQuery: { externalPath: externalRoots.PowerQuery, expandedPaths: [] },
        "marshal-final-evidence-review": { expandedPaths: ["evidence"] },
        "1eacb6d6-8975-4093-beda-9ad72deac778": { expandedPaths: [] },
        "internal-worktree-12345678": {
          externalPath: internalWorktree,
          expandedPaths: [],
          source: "subagent-worktree",
        },
        "legacy-worktree-87654321": {
          externalPath: legacyWorktree,
          expandedPaths: [],
        },
      },
    });

    const { listRegisteredWorkspaces, loadWorkspaceStore } = await freshImport();
    const store = loadWorkspaceStore();

    expect(store.version).toBe(3);
    expect(store.activeWorkspace).toBe("Scratchpad");
    expect(listRegisteredWorkspaces(workspaceDir).map((workspace) => workspace.name)).toEqual([
      "Scratchpad",
      "marshal",
      "PBI",
      "PowerQuery",
    ]);
    expect(Object.keys(store.workspaces).sort()).toEqual([
      "PBI",
      "PowerQuery",
      "Scratchpad",
      "marshal",
    ]);
    expect(fs.existsSync(path.join(workspaceDir, "marshal-final-evidence-review"))).toBe(true);
    expect(fs.existsSync(internalWorktree)).toBe(true);
    expect(fs.existsSync(legacyWorktree)).toBe(true);
  });

  it("preserves explicit external roots from the legacy registry file", async () => {
    const externalRoot = makeTempDir("m-workspace-legacy-external-");
    writeJson(legacyRegistryPath(), {
      version: 1,
      workspaces: {
        External: { externalPath: externalRoot },
        ImplicitManaged: {},
      },
    });

    const { listRegisteredWorkspaces } = await freshImport();

    expect(listRegisteredWorkspaces(workspaceDir).map((workspace) => workspace.name)).toEqual([
      "Scratchpad",
      "External",
    ]);
    expect(fs.existsSync(legacyRegistryPath())).toBe(false);
  });

  it("hides overlapping and filesystem-root entries during legacy migration", async () => {
    const ancestor = makeTempDir("m-workspace-legacy-ancestor-");
    const descendant = path.join(ancestor, "descendant");
    fs.mkdirSync(descendant, { recursive: true });
    writeJson(storePath(), {
      version: 2,
      activeWorkspace: "Scratchpad",
      workspaces: {
        Ancestor: { externalPath: ancestor, expandedPaths: [] },
        Descendant: { externalPath: descendant, expandedPaths: [] },
        "Filesystem Root": {
          externalPath: path.parse(process.cwd()).root,
          expandedPaths: [],
        },
      },
    });

    const { listRegisteredWorkspaces } = await freshImport();

    expect(listRegisteredWorkspaces(workspaceDir).map((workspace) => workspace.name)).toEqual([
      "Scratchpad",
      "Ancestor",
    ]);
  });

  it("allows an internal worktree to become visible only through explicit registration", async () => {
    const worktreePath = path.join(
      appDataState.path,
      "marshal-worktrees",
      "explicit-worktree-12345678",
    );
    fs.mkdirSync(worktreePath, { recursive: true });
    const store = await freshImport();

    expect(store.listRegisteredWorkspaces(workspaceDir).map((workspace) => workspace.name)).toEqual(
      ["Scratchpad"],
    );

    store.registerExistingWorkspace("Explicit Worktree", worktreePath, workspaceDir);

    expect(store.listRegisteredWorkspaces(workspaceDir)).toEqual([
      expect.objectContaining({ name: "Scratchpad" }),
      expect.objectContaining({
        name: "Explicit Worktree",
        path: fs.realpathSync(worktreePath),
        origin: "user-added",
      }),
    ]);
  });

  it("does not auto-adopt a deleted or replaced root until it is explicitly re-added", async () => {
    const externalRoot = makeTempDir("m-workspace-replaced-");
    const store = await freshImport();
    const original = store.registerExistingWorkspace("Project", externalRoot, workspaceDir);

    fs.rmSync(externalRoot, { recursive: true, force: true });
    fs.mkdirSync(externalRoot, { recursive: true });

    expect(store.resolveRegisteredWorkspace("Project", workspaceDir)).toBeUndefined();
    expect(store.listRegisteredWorkspaces(workspaceDir).map((workspace) => workspace.name)).toEqual(
      ["Scratchpad"],
    );
    expect(() => store.getWorkspaceRoot("Project", workspaceDir)).toThrow("unavailable");

    const readded = store.registerExistingWorkspace("Project", externalRoot, workspaceDir);
    expect(readded.identity).not.toEqual(original.identity);
    expect(store.listRegisteredWorkspaces(workspaceDir).map((workspace) => workspace.name)).toEqual(
      ["Scratchpad", "Project"],
    );
  });

  it("allows an explicit re-add to replace a stale registration that used another name", async () => {
    const externalRoot = makeTempDir("m-workspace-stale-alias-");
    const store = await freshImport();
    store.registerExistingWorkspace("Old Display Name", externalRoot, workspaceDir);
    fs.rmSync(externalRoot, { recursive: true, force: true });
    fs.mkdirSync(externalRoot, { recursive: true });

    store.registerExistingWorkspace("New Display Name", externalRoot, workspaceDir);

    expect(store.getWorkspaceRegistry()).not.toHaveProperty("Old Display Name");
    expect(store.listRegisteredWorkspaces(workspaceDir).map((workspace) => workspace.name)).toEqual(
      ["Scratchpad", "New Display Name"],
    );
  });

  it("rejects case-fold name collisions and canonical path aliases", async () => {
    const firstRoot = makeTempDir("m-workspace-first-");
    const secondRoot = makeTempDir("m-workspace-second-");
    const aliasRoot = path.join(path.dirname(firstRoot), `${path.basename(firstRoot)}-alias`);
    fs.symlinkSync(firstRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
    tempDirs.push(aliasRoot);
    fs.mkdirSync(path.join(workspaceDir, "GeneratedOutput"), { recursive: true });
    const store = await freshImport();
    store.registerExistingWorkspace("Project", firstRoot, workspaceDir);

    expect(() => store.registerExistingWorkspace("project", secondRoot, workspaceDir)).toThrow(
      "name already exists",
    );
    expect(() => store.registerExistingWorkspace("Alias", firstRoot, workspaceDir)).toThrow(
      "already uses this folder",
    );
    expect(() => store.registerExistingWorkspace("Symlink Alias", aliasRoot, workspaceDir)).toThrow(
      "already uses this folder",
    );
    expect(() =>
      store.registerExistingWorkspace("generatedoutput", secondRoot, workspaceDir),
    ).toThrow("name already exists");
    expect(() => store.registerExistingWorkspace("__proto__", secondRoot, workspaceDir)).toThrow(
      "reserved",
    );
  });

  it("rejects ancestor and descendant workspace roots", async () => {
    const parentRoot = makeTempDir("m-workspace-parent-");
    const childRoot = path.join(parentRoot, "child");
    fs.mkdirSync(childRoot, { recursive: true });
    const store = await freshImport();
    store.registerExistingWorkspace("Parent", parentRoot, workspaceDir);

    expect(() => store.registerExistingWorkspace("Child", childRoot, workspaceDir)).toThrow(
      "overlaps registered workspace",
    );

    store.deleteWorkspaceEntry("Parent");
    store.registerExistingWorkspace("Child", childRoot, workspaceDir);
    expect(() => store.registerExistingWorkspace("Parent", parentRoot, workspaceDir)).toThrow(
      "overlaps registered workspace",
    );
    expect(() =>
      store.registerExistingWorkspace(
        "Scratchpad Alias",
        path.join(workspaceDir, "Scratchpad"),
        workspaceDir,
      ),
    ).toThrow("already uses this folder");
    expect(() =>
      store.registerExistingWorkspace("Managed Root", workspaceDir, workspaceDir),
    ).toThrow("overlaps registered workspace");
    expect(() =>
      store.registerExistingWorkspace(
        "Filesystem Root",
        path.parse(workspaceDir).root,
        workspaceDir,
      ),
    ).toThrow("filesystem root");
  });

  it("rejects managed entries that resolve through a junction outside the managed root", async () => {
    const externalRoot = makeTempDir("m-workspace-escape-");
    const escapedPath = path.join(workspaceDir, "Escaped");
    fs.symlinkSync(externalRoot, escapedPath, process.platform === "win32" ? "junction" : "dir");
    const store = await freshImport();
    const identity = (await import("./workspace-role-identity")).captureWorkspaceBinding(
      "Escaped",
      externalRoot,
    ).binding.identity;
    store.addWorkspaceEntry("Escaped", { origin: "user-created", identity });

    expect(store.resolveRegisteredWorkspace("Escaped", workspaceDir)).toBeUndefined();
    expect(store.listRegisteredWorkspaces(workspaceDir).map((workspace) => workspace.name)).toEqual(
      ["Scratchpad"],
    );
  });

  it("never falls back to an unresolved Scratchpad path", async () => {
    const siblingRoot = path.join(workspaceDir, "InternalData");
    fs.mkdirSync(siblingRoot, { recursive: true });
    const scratchpadPath = path.join(workspaceDir, "Scratchpad");
    fs.rmSync(scratchpadPath, { recursive: true, force: true });
    fs.symlinkSync(siblingRoot, scratchpadPath, process.platform === "win32" ? "junction" : "dir");
    const store = await freshImport();

    expect(() => store.getActiveWorkspaceRoot(workspaceDir)).toThrow("Scratchpad is unavailable");
  });

  it("supports a managed workspace directory reached through a junction", async () => {
    const workspaceAlias = path.join(
      path.dirname(workspaceDir),
      `${path.basename(workspaceDir)}-alias`,
    );
    fs.symlinkSync(workspaceDir, workspaceAlias, process.platform === "win32" ? "junction" : "dir");
    tempDirs.push(workspaceAlias);
    const store = await freshImport();

    expect(store.getActiveWorkspaceRoot(workspaceAlias)).toBe(
      fs.realpathSync(path.join(workspaceDir, "Scratchpad")),
    );
  });

  it("keeps registry state coherent through rename, delete, and UI-state writes", async () => {
    const store = await freshImport();
    const created = store.registerManagedWorkspace("OldName", workspaceDir);
    store.setExpandedPaths("OldName", ["src", "../escape", "docs\\guide"]);
    expect(store.setSelectedFile("OldName", "src\\index.ts")).toBe(true);
    expect(store.setActiveWorkspace("OldName")).toBe(true);
    store.renameWorkspaceEntry("OldName", "OldName");
    expect(store.getWorkspaceRegistry()).toHaveProperty("OldName");

    const renamedPath = path.join(path.dirname(created.path), "NewName");
    fs.renameSync(created.path, renamedPath);
    store.renameWorkspaceEntry("OldName", "NewName");

    expect(store.getWorkspaceUIState()).toEqual({
      activeWorkspace: "NewName",
      expandedPaths: { NewName: ["src", "docs/guide"] },
      selectedFiles: { NewName: "src/index.ts" },
    });
    expect(store.listRegisteredWorkspaces(workspaceDir).map((workspace) => workspace.name)).toEqual(
      ["Scratchpad", "NewName"],
    );

    store.deleteWorkspaceEntry("NewName");
    expect(store.getWorkspaceUIState().activeWorkspace).toBe("Scratchpad");
    expect(store.listRegisteredWorkspaces(workspaceDir).map((workspace) => workspace.name)).toEqual(
      ["Scratchpad"],
    );
    expect(fs.existsSync(renamedPath)).toBe(true);
  });

  it("strips unknown persisted fields using the explicit allowlists", async () => {
    writeJson(storePath(), {
      version: 3,
      activeWorkspace: "Scratchpad",
      ignoredTopLevel: true,
      workspaces: {
        Scratchpad: {
          origin: "scratchpad",
          expandedPaths: [],
          ignoredEntryField: "drop-me",
        },
      },
    });

    const { loadWorkspaceStore } = await freshImport();

    expect(loadWorkspaceStore()).toEqual({
      version: 3,
      activeWorkspace: "Scratchpad",
      workspaces: {
        Scratchpad: { origin: "scratchpad", expandedPaths: [] },
      },
    });
    expect(fs.readFileSync(storePath(), "utf8")).not.toContain("ignored");
  });
});
