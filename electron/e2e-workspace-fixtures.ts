import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { E2E_DATA_DIR, isMockMode } from "./mock-mode";
import { captureWorkspaceBinding } from "./workspace-role-identity";
import {
  addWorkspaceEntry,
  getWorkspaceRegistry,
  type WorkspaceRegistryEntry,
} from "./workspace-store";

export const E2E_WORKSPACE_FIXTURE_FILENAME = "marshal-e2e-workspace-fixtures.json";

const WorkspaceFixtureManifestSchema = z
  .object({
    version: z.literal(1),
    externalWorkspaces: z
      .array(
        z
          .object({
            name: z.string().min(1).max(100),
            relativePath: z.string().min(1).max(1024),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export interface E2EWorkspaceFixture {
  name: string;
  externalPath: string;
}

interface LoadFixtureOptions {
  dataDir?: string;
  manifestPath?: string;
}

interface InstallFixtureOptions extends LoadFixtureOptions {
  enabled?: boolean;
  getRegistry?: () => Record<string, WorkspaceRegistryEntry>;
  registerWorkspace?: (name: string, entry: WorkspaceRegistryEntry) => void;
}

function fixtureError(message: string): Error {
  return new Error(`Invalid E2E workspace fixture manifest: ${message}`);
}

function isInsideDirectory(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function normalizePathForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertFixtureName(name: string): void {
  if (
    name !== name.trim() ||
    name.startsWith(".") ||
    /[/\\:]/.test(name) ||
    name.toLowerCase() === "scratchpad"
  ) {
    throw fixtureError(`invalid workspace name "${name}"`);
  }
}

export function getE2EWorkspaceFixtureManifestPath(dataDir = E2E_DATA_DIR): string {
  return path.join(dataDir, E2E_WORKSPACE_FIXTURE_FILENAME);
}

export function loadE2EWorkspaceFixtures(options: LoadFixtureOptions = {}): E2EWorkspaceFixture[] {
  const dataDir = path.resolve(options.dataDir ?? E2E_DATA_DIR);
  const manifestPath = path.resolve(
    options.manifestPath ?? getE2EWorkspaceFixtureManifestPath(dataDir),
  );
  if (!isInsideDirectory(dataDir, manifestPath)) {
    throw fixtureError("manifest path must stay inside the E2E worker data directory");
  }

  let realDataDir: string;
  let realManifestPath: string;
  try {
    realDataDir = fs.realpathSync(dataDir);
    realManifestPath = fs.realpathSync(manifestPath);
  } catch (error) {
    throw fixtureError(`unable to resolve fixture manifest: ${String(error)}`);
  }
  if (!isInsideDirectory(realDataDir, realManifestPath)) {
    throw fixtureError("manifest symlink resolves outside the E2E worker data directory");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(realManifestPath, "utf8")) as unknown;
  } catch (error) {
    throw fixtureError(`unable to read fixture manifest: ${String(error)}`);
  }
  const result = WorkspaceFixtureManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw fixtureError(result.error.issues[0]?.message ?? "schema validation failed");
  }

  const names = new Set<string>();
  const roots = new Set<string>();
  return result.data.externalWorkspaces.map(({ name, relativePath }) => {
    assertFixtureName(name);
    if (relativePath !== relativePath.trim() || path.isAbsolute(relativePath)) {
      throw fixtureError(`workspace "${name}" must use a trimmed relativePath`);
    }
    const candidate = path.resolve(realDataDir, relativePath);
    if (!isInsideDirectory(realDataDir, candidate)) {
      throw fixtureError(`workspace "${name}" resolves outside the E2E worker data directory`);
    }

    let externalPath: string;
    try {
      externalPath = fs.realpathSync(candidate);
      if (!fs.statSync(externalPath).isDirectory()) {
        throw new Error("path is not a directory");
      }
    } catch (error) {
      throw fixtureError(`workspace "${name}" is unavailable: ${String(error)}`);
    }
    if (!isInsideDirectory(realDataDir, externalPath)) {
      throw fixtureError(
        `workspace "${name}" symlink resolves outside the E2E worker data directory`,
      );
    }

    const normalizedName = name.toLowerCase();
    const normalizedRoot = normalizePathForCompare(externalPath);
    if (names.has(normalizedName)) {
      throw fixtureError(`workspace name "${name}" is duplicated`);
    }
    if (roots.has(normalizedRoot)) {
      throw fixtureError(`workspace path "${relativePath}" is duplicated`);
    }
    names.add(normalizedName);
    roots.add(normalizedRoot);
    return { name, externalPath };
  });
}

export function installE2EWorkspaceFixtures(
  workspaceDir: string,
  options: InstallFixtureOptions = {},
): E2EWorkspaceFixture[] {
  const enabled =
    options.enabled ?? (isMockMode() && process.env.MARSHAL_E2E_WORKSPACE_FIXTURES === "1");
  if (!enabled) return [];

  const fixtures = loadE2EWorkspaceFixtures(options);
  const registry = (options.getRegistry ?? getWorkspaceRegistry)();
  const registerWorkspace = options.registerWorkspace ?? addWorkspaceEntry;

  for (const fixture of fixtures) {
    const conflictingName = Object.entries(registry).find(
      ([name]) => name.toLowerCase() === fixture.name.toLowerCase() && name !== fixture.name,
    );
    if (conflictingName) {
      throw fixtureError(
        `workspace "${fixture.name}" conflicts with registered workspace "${conflictingName[0]}"`,
      );
    }

    const existing = registry[fixture.name];
    if (
      existing?.externalPath &&
      normalizePathForCompare(existing.externalPath) !==
        normalizePathForCompare(fixture.externalPath)
    ) {
      throw fixtureError(`workspace "${fixture.name}" is already registered to another path`);
    }
    const duplicatePath = Object.entries(registry).find(
      ([name, entry]) =>
        name !== fixture.name &&
        entry.externalPath &&
        normalizePathForCompare(entry.externalPath) ===
          normalizePathForCompare(fixture.externalPath),
    );
    if (duplicatePath) {
      throw fixtureError(
        `workspace "${fixture.name}" reuses the path registered by "${duplicatePath[0]}"`,
      );
    }

    const managedWorkspacePath = path.join(workspaceDir, fixture.name);
    if (
      fs.existsSync(managedWorkspacePath) &&
      normalizePathForCompare(fs.realpathSync(managedWorkspacePath)) !==
        normalizePathForCompare(fixture.externalPath)
    ) {
      throw fixtureError(`workspace "${fixture.name}" conflicts with a managed E2E workspace`);
    }

    const identity = captureWorkspaceBinding(fixture.name, fixture.externalPath).binding.identity;
    const entry: WorkspaceRegistryEntry = {
      origin: "e2e-fixture",
      externalPath: fixture.externalPath,
      identity,
    };
    registerWorkspace(fixture.name, entry);
    registry[fixture.name] = entry;
  }

  return fixtures;
}
