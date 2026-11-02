import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./app-paths", () => ({
  getAppDataDir: () => path.join(os.tmpdir(), "marshal-e2e-workspace-fixtures-app-data"),
}));

import { loadGitHubRepositoryAgents } from "./backend/local/repository-customizations";
import {
  getE2EWorkspaceFixtureManifestPath,
  installE2EWorkspaceFixtures,
  loadE2EWorkspaceFixtures,
} from "./e2e-workspace-fixtures";
import { isMockMode, setMockMode } from "./mock-mode";
import { captureWorkspaceBinding } from "./workspace-role-identity";
import type { WorkspaceRegistryEntry } from "./workspace-store";

const tempDirs: string[] = [];

function makeDataDir(): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "marshal-e2e-workspace-fixtures-"));
  tempDirs.push(dataDir);
  return dataDir;
}

function writeManifest(
  dataDir: string,
  externalWorkspaces: Array<{ name: string; relativePath: string }>,
): void {
  fs.writeFileSync(
    getE2EWorkspaceFixtureManifestPath(dataDir),
    JSON.stringify({ version: 1, externalWorkspaces }, null, 2),
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("isolated E2E workspace fixtures", () => {
  it("does not read or register fixtures outside mock mode", () => {
    const registerWorkspace = vi.fn<(name: string, entry: { externalPath?: string }) => void>();
    const previousMockMode = isMockMode();
    const previousFlag = process.env.MARSHAL_E2E_WORKSPACE_FIXTURES;

    try {
      setMockMode(false);
      process.env.MARSHAL_E2E_WORKSPACE_FIXTURES = "1";
      expect(
        installE2EWorkspaceFixtures(path.join(makeDataDir(), "workspace"), {
          registerWorkspace,
        }),
      ).toEqual([]);
      expect(registerWorkspace).not.toHaveBeenCalled();
    } finally {
      setMockMode(previousMockMode);
      if (previousFlag === undefined) delete process.env.MARSHAL_E2E_WORKSPACE_FIXTURES;
      else process.env.MARSHAL_E2E_WORKSPACE_FIXTURES = previousFlag;
    }
  });

  it("registers contained external workspaces with workspace and repository-agent identities", () => {
    const dataDir = makeDataDir();
    const workspaceDir = path.join(dataDir, "workspace");
    const projectDir = path.join(dataDir, "fixtures", "Project");
    const agentsDir = path.join(projectDir, ".github", "agents");
    fs.mkdirSync(path.join(workspaceDir, "Scratchpad"), { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "reviewer.agent.md"),
      [
        "---",
        "name: Reviewer",
        "description: Reviews fixture changes",
        "---",
        "Review the isolated fixture repository.",
      ].join("\n"),
    );
    writeManifest(dataDir, [{ name: "Project", relativePath: "fixtures/Project" }]);
    const registered = new Map<string, WorkspaceRegistryEntry>();

    const fixtures = installE2EWorkspaceFixtures(workspaceDir, {
      enabled: true,
      dataDir,
      getRegistry: () => Object.fromEntries(registered),
      registerWorkspace: (name, entry) => registered.set(name, entry),
    });

    expect(fixtures).toEqual([{ name: "Project", externalPath: fs.realpathSync(projectDir) }]);
    expect(registered.get("Project")).toEqual({
      origin: "e2e-fixture",
      externalPath: fs.realpathSync(projectDir),
      identity: expect.objectContaining({ version: 1 }),
    });
    expect(captureWorkspaceBinding("Project", fixtures[0].externalPath).binding).toMatchObject({
      name: "Project",
      identity: { version: 1 },
    });
    expect(loadGitHubRepositoryAgents(fixtures[0].externalPath)).toEqual([
      expect.objectContaining({
        name: "Reviewer",
        path: path.join(".github", "agents", "reviewer.agent.md"),
        identity: expect.objectContaining({
          version: 1,
          normalizedPath: ".github/agents/reviewer.agent.md",
          declaredName: "Reviewer",
        }),
      }),
    ]);
  });

  it("keeps fixture manifests isolated by worker data directory", () => {
    const first = makeDataDir();
    const second = makeDataDir();
    fs.mkdirSync(path.join(first, "fixtures", "Project"), { recursive: true });
    fs.mkdirSync(path.join(second, "fixtures", "Project"), { recursive: true });
    writeManifest(first, [{ name: "First", relativePath: "fixtures/Project" }]);
    writeManifest(second, [{ name: "Second", relativePath: "fixtures/Project" }]);

    expect(loadE2EWorkspaceFixtures({ dataDir: first })).toEqual([
      { name: "First", externalPath: fs.realpathSync(path.join(first, "fixtures", "Project")) },
    ]);
    expect(loadE2EWorkspaceFixtures({ dataDir: second })).toEqual([
      { name: "Second", externalPath: fs.realpathSync(path.join(second, "fixtures", "Project")) },
    ]);
  });

  it("rejects malformed, escaping, and unavailable fixture entries", () => {
    const dataDir = makeDataDir();
    fs.writeFileSync(getE2EWorkspaceFixtureManifestPath(dataDir), "{not-json");
    expect(() => loadE2EWorkspaceFixtures({ dataDir })).toThrow(
      "Invalid E2E workspace fixture manifest",
    );

    writeManifest(dataDir, [{ name: "Escaping", relativePath: ".." }]);
    expect(() => loadE2EWorkspaceFixtures({ dataDir })).toThrow(
      'workspace "Escaping" resolves outside',
    );

    writeManifest(dataDir, [{ name: "Missing", relativePath: "fixtures/missing" }]);
    expect(() => loadE2EWorkspaceFixtures({ dataDir })).toThrow(
      'workspace "Missing" is unavailable',
    );
  });
});
