import * as fs from "fs";
import * as path from "path";

import { z } from "zod";

import type { WorkspaceInstanceIdentity, WorkspaceUIState } from "../common/marshal-ipc-contract";
import { createLogger } from "../common/marshal-logger";
import {
  DEFAULT_WORKSPACE_DISPLAY_NAME,
  DEFAULT_WORKSPACE_KEY,
  workspaceDisplayName,
} from "../common/workspace-display";
import { workspaceInstanceIdentitiesEqual } from "../common/workspace-role-identity";
import { getAppDataDir } from "./app-paths";
import { resolveWorktreesDir } from "./persisted-paths";
import { secureMkdirSync, secureWriteFileSync } from "./platform-security";
import { captureWorkspaceBinding } from "./workspace-role-identity";

const log = createLogger("WorkspaceStore");

export const SCRATCHPAD_WORKSPACE_NAME = DEFAULT_WORKSPACE_KEY;

export { DEFAULT_WORKSPACE_DISPLAY_NAME, workspaceDisplayName };

export const WORKSPACE_STORE_KNOWN_FIELDS = ["version", "activeWorkspace", "workspaces"] as const;
export const WORKSPACE_ENTRY_KNOWN_FIELDS = [
  "origin",
  "externalPath",
  "identity",
  "expandedPaths",
  "selectedFile",
] as const;

const WorkspaceInstanceIdentitySchema = z
  .object({
    version: z.literal(1),
    device: z.string(),
    inode: z.string(),
    birthtimeNs: z.string(),
  })
  .strict();

const WorkspaceOriginSchema = z.enum(["scratchpad", "user-created", "user-added", "e2e-fixture"]);

const WorkspaceEntrySchema = z
  .object({
    origin: WorkspaceOriginSchema,
    externalPath: z.string().optional(),
    identity: WorkspaceInstanceIdentitySchema.optional(),
    expandedPaths: z.array(z.string()).default([]),
    selectedFile: z.string().optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.origin === "scratchpad") {
      if (entry.externalPath || entry.identity) {
        context.addIssue({
          code: "custom",
          message: "Scratchpad must not persist an external path or identity",
        });
      }
      return;
    }
    if (entry.origin === "user-created" && entry.externalPath) {
      context.addIssue({
        code: "custom",
        message: "User-created workspaces must use the managed workspace root",
      });
    }
    if ((entry.origin === "user-added" || entry.origin === "e2e-fixture") && !entry.externalPath) {
      context.addIssue({
        code: "custom",
        message: "Added workspaces must persist their external path",
      });
    }
    if (entry.origin !== "user-added" && !entry.identity) {
      context.addIssue({
        code: "custom",
        message: "Registered workspaces must persist their directory identity",
      });
    }
  });

const WorkspaceStoreSchema = z
  .object({
    version: z.literal(3),
    activeWorkspace: z.string().default(SCRATCHPAD_WORKSPACE_NAME),
    workspaces: z.record(z.string(), WorkspaceEntrySchema).default({}),
  })
  .strict();

const LegacyWorkspaceEntrySchema = z.object({
  externalPath: z.string().optional(),
  expandedPaths: z.array(z.string()).default([]),
  selectedFile: z.string().optional(),
  source: z.enum(["subagent-worktree"]).optional(),
});

const LegacyWorkspaceStoreSchema = z.object({
  version: z.literal(2),
  activeWorkspace: z.string().default(SCRATCHPAD_WORKSPACE_NAME),
  workspaces: z.record(z.string(), LegacyWorkspaceEntrySchema).default({}),
});

type WorkspaceStore = z.infer<typeof WorkspaceStoreSchema>;
type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>;
type LegacyWorkspaceEntry = z.infer<typeof LegacyWorkspaceEntrySchema>;

export type WorkspaceOrigin = z.infer<typeof WorkspaceOriginSchema>;
export type WorkspaceRegistryEntry = Pick<WorkspaceEntry, "origin" | "externalPath" | "identity">;

export interface ResolvedWorkspace {
  name: string;
  path: string;
  origin: WorkspaceOrigin;
  identity: WorkspaceInstanceIdentity;
  external: boolean;
}

export function validateWorkspaceName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Name cannot be empty";
  if (trimmed.startsWith(".")) return "Name cannot start with a dot";
  if (/[/\\:]/.test(trimmed)) return "Name cannot contain slashes or colons";
  if (["__proto__", "prototype", "constructor"].includes(trimmed.toLowerCase())) {
    return "Name is reserved";
  }
  if (trimmed.length > 100) return "Name is too long";
  return null;
}

function getStorePath(): string {
  return path.join(getAppDataDir(), "marshal-sessions", "workspaces.json");
}

function getLegacyRegistryPath(): string {
  return path.join(getAppDataDir(), "marshal-sessions", "workspace-registry.json");
}

let cached: WorkspaceStore | null = null;

function scratchpadEntry(): WorkspaceEntry {
  return { origin: "scratchpad", expandedPaths: [] };
}

function defaultStore(): WorkspaceStore {
  return {
    version: 3,
    activeWorkspace: SCRATCHPAD_WORKSPACE_NAME,
    workspaces: { [SCRATCHPAD_WORKSPACE_NAME]: scratchpadEntry() },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickKnownFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const knownFields = new Set(fields);
  return Object.fromEntries(Object.entries(value).filter(([key]) => knownFields.has(key)));
}

function sanitizePersistedWorkspaceStore(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const sanitized = pickKnownFields(value, WORKSPACE_STORE_KNOWN_FIELDS);
  if (!isRecord(sanitized.workspaces)) return sanitized;
  sanitized.workspaces = Object.fromEntries(
    Object.entries(sanitized.workspaces).map(([name, entry]) => [
      name,
      isRecord(entry) ? pickKnownFields(entry, WORKSPACE_ENTRY_KNOWN_FIELDS) : entry,
    ]),
  );
  return sanitized;
}

function normalizeStore(store: WorkspaceStore): WorkspaceStore {
  const workspaces = Object.fromEntries(
    Object.entries(store.workspaces)
      .filter(
        ([name]) =>
          (name === SCRATCHPAD_WORKSPACE_NAME ||
            name.toLowerCase() !== SCRATCHPAD_WORKSPACE_NAME.toLowerCase()) &&
          validateWorkspaceName(name) === null,
      )
      .map(([name, entry]) => [name, { ...entry, expandedPaths: [...entry.expandedPaths] }]),
  );
  const existingScratchpad = workspaces[SCRATCHPAD_WORKSPACE_NAME];
  workspaces[SCRATCHPAD_WORKSPACE_NAME] = {
    ...scratchpadEntry(),
    expandedPaths:
      existingScratchpad?.origin === "scratchpad" ? [...existingScratchpad.expandedPaths] : [],
    ...(existingScratchpad?.origin === "scratchpad" && existingScratchpad.selectedFile
      ? { selectedFile: existingScratchpad.selectedFile }
      : {}),
  };
  return {
    version: 3,
    activeWorkspace: workspaces[store.activeWorkspace]
      ? store.activeWorkspace
      : SCRATCHPAD_WORKSPACE_NAME,
    workspaces,
  };
}

export function normalizePathForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase() : resolved;
}

function isPathInside(root: string, target: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  const relative = path.relative(normalizedRoot, normalizedTarget);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function isFilesystemRoot(value: string): boolean {
  const resolved = path.resolve(value);
  return normalizePathForCompare(resolved) === normalizePathForCompare(path.parse(resolved).root);
}

function isLegacyInternalWorktree(entry: LegacyWorkspaceEntry): boolean {
  const externalPath = entry.externalPath;
  if (!externalPath) return false;
  if (entry.source === "subagent-worktree") return true;
  const appDataDir = getAppDataDir();
  return [resolveWorktreesDir(appDataDir), path.join(appDataDir, "m-worktrees")].some((root) =>
    isPathInside(root, externalPath),
  );
}

function migrateExternalEntry(name: string, entry: LegacyWorkspaceEntry): WorkspaceEntry | null {
  if (!entry.externalPath || isLegacyInternalWorktree(entry)) return null;
  const resolvedPath = path.resolve(entry.externalPath);
  let canonicalPath = resolvedPath;
  let identity: WorkspaceInstanceIdentity | undefined;
  try {
    const captured = captureWorkspaceBinding(name, resolvedPath);
    canonicalPath = captured.canonicalPath;
    identity = captured.binding.identity;
  } catch {
    log.warn(`Migrated workspace is currently unavailable: ${name}`);
  }
  if (isFilesystemRoot(canonicalPath)) {
    log.warn(`Skipping migrated filesystem-root workspace: ${name}`);
    return null;
  }
  return {
    origin: "user-added",
    externalPath: canonicalPath,
    identity,
    expandedPaths: [...entry.expandedPaths],
    ...(entry.selectedFile ? { selectedFile: entry.selectedFile } : {}),
  };
}

function migrateLegacyStore(store: z.infer<typeof LegacyWorkspaceStoreSchema>): WorkspaceStore {
  const migrated = defaultStore();
  const names = new Set([SCRATCHPAD_WORKSPACE_NAME.toLowerCase()]);
  const roots = new Set<string>();
  for (const [name, entry] of Object.entries(store.workspaces)) {
    const normalizedName = name.toLowerCase();
    if (normalizedName === SCRATCHPAD_WORKSPACE_NAME.toLowerCase()) {
      if (name === SCRATCHPAD_WORKSPACE_NAME && !entry.externalPath && !entry.source) {
        migrated.workspaces[SCRATCHPAD_WORKSPACE_NAME] = {
          origin: "scratchpad",
          expandedPaths: [...entry.expandedPaths],
          ...(entry.selectedFile ? { selectedFile: entry.selectedFile } : {}),
        };
      }
      continue;
    }
    if (validateWorkspaceName(name)) continue;
    if (names.has(normalizedName)) continue;
    const migratedEntry = migrateExternalEntry(name, entry);
    if (!migratedEntry?.externalPath) continue;
    const normalizedRoot = normalizePathForCompare(migratedEntry.externalPath);
    if (roots.has(normalizedRoot)) {
      log.warn(`Skipping duplicate migrated workspace path: ${name}`);
      continue;
    }
    names.add(normalizedName);
    roots.add(normalizedRoot);
    migrated.workspaces[name] = migratedEntry;
  }
  migrated.activeWorkspace = migrated.workspaces[store.activeWorkspace]
    ? store.activeWorkspace
    : SCRATCHPAD_WORKSPACE_NAME;
  return migrated;
}

function readLegacyRegistry(value: unknown): Record<string, LegacyWorkspaceEntry> {
  if (!isRecord(value)) return {};
  const candidate = value.version === 1 && isRecord(value.workspaces) ? value.workspaces : value;
  const entries: Record<string, LegacyWorkspaceEntry> = {};
  for (const [name, rawEntry] of Object.entries(candidate)) {
    const parsed = LegacyWorkspaceEntrySchema.safeParse(rawEntry);
    if (parsed.success) entries[name] = parsed.data;
  }
  return entries;
}

export function loadWorkspaceStore(): WorkspaceStore {
  if (cached) return cached;

  const storePath = getStorePath();
  if (fs.existsSync(storePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(storePath, "utf-8")) as unknown;
      const sanitizedRaw = sanitizePersistedWorkspaceStore(raw);
      const current = WorkspaceStoreSchema.safeParse(sanitizedRaw);
      if (current.success) {
        const normalized = normalizeStore(current.data);
        cached = normalized;
        if (
          JSON.stringify(normalized) !== JSON.stringify(current.data) ||
          JSON.stringify(sanitizedRaw) !== JSON.stringify(raw)
        ) {
          saveWorkspaceStore(normalized);
        }
        return normalized;
      }

      const legacy = LegacyWorkspaceStoreSchema.safeParse(raw);
      if (legacy.success) {
        const migrated = migrateLegacyStore(legacy.data);
        saveWorkspaceStore(migrated);
        return migrated;
      }
      log.warn("Invalid schema, falling back to legacy registry or defaults:", current.error);
    } catch (error) {
      log.warn("Failed to read store:", error);
    }
  }

  const legacyPath = getLegacyRegistryPath();
  if (fs.existsSync(legacyPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(legacyPath, "utf-8")) as unknown;
      const legacyEntries = readLegacyRegistry(raw);
      const migrated = migrateLegacyStore({
        version: 2,
        activeWorkspace: SCRATCHPAD_WORKSPACE_NAME,
        workspaces: legacyEntries,
      });
      saveWorkspaceStore(migrated);
      try {
        fs.unlinkSync(legacyPath);
      } catch {
        // The migrated v3 store is authoritative even if legacy cleanup fails.
      }
      return migrated;
    } catch (error) {
      log.warn("Failed to migrate legacy registry:", error);
    }
  }

  cached = defaultStore();
  return cached;
}

export function saveWorkspaceStore(store: WorkspaceStore): void {
  const normalized = normalizeStore(store);
  const parsed = WorkspaceStoreSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new Error(`Invalid workspace store: ${parsed.error.message}`);
  }
  const storePath = getStorePath();
  secureMkdirSync(path.dirname(storePath), 0o700);
  try {
    secureWriteFileSync(storePath, JSON.stringify(parsed.data, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    cached = parsed.data;
  } catch (error) {
    cached = null;
    throw error;
  }
}

function cloneStore(): WorkspaceStore {
  const store = loadWorkspaceStore();
  return {
    ...store,
    workspaces: Object.fromEntries(
      Object.entries(store.workspaces).map(([name, entry]) => [
        name,
        { ...entry, expandedPaths: [...entry.expandedPaths] },
      ]),
    ),
  };
}

function findWorkspaceName(store: WorkspaceStore, requestedName: string): string | undefined {
  const folded = requestedName.toLowerCase();
  return Object.keys(store.workspaces).find((name) => name.toLowerCase() === folded);
}

function declaredWorkspacePath(name: string, entry: WorkspaceEntry, workspaceDir: string): string {
  return entry.externalPath ?? path.join(workspaceDir, name);
}

function isManagedWorkspaceRoot(workspaceDir: string, canonicalPath: string): boolean {
  try {
    const canonicalWorkspaceDir = fs.realpathSync(path.resolve(workspaceDir));
    return (
      normalizePathForCompare(path.dirname(canonicalPath)) ===
      normalizePathForCompare(canonicalWorkspaceDir)
    );
  } catch {
    return false;
  }
}

function resolveWorkspaceEntry(name: string, workspaceDir: string): ResolvedWorkspace | undefined {
  const store = loadWorkspaceStore();
  const entry = store.workspaces[name];
  if (!entry) return undefined;

  let captured: ReturnType<typeof captureWorkspaceBinding>;
  try {
    captured = captureWorkspaceBinding(name, declaredWorkspacePath(name, entry, workspaceDir));
  } catch {
    return undefined;
  }

  if (!entry.externalPath && !isManagedWorkspaceRoot(workspaceDir, captured.canonicalPath)) {
    return undefined;
  }
  if (entry.origin === "scratchpad") {
    let expectedScratchpadPath: string;
    try {
      expectedScratchpadPath = path.join(
        fs.realpathSync(path.resolve(workspaceDir)),
        SCRATCHPAD_WORKSPACE_NAME,
      );
    } catch {
      return undefined;
    }
    if (
      normalizePathForCompare(captured.canonicalPath) !==
      normalizePathForCompare(expectedScratchpadPath)
    ) {
      return undefined;
    }
  }
  if (
    entry.origin !== "scratchpad" &&
    (!entry.identity ||
      !workspaceInstanceIdentitiesEqual(entry.identity, captured.binding.identity))
  ) {
    return undefined;
  }

  return {
    name,
    path: captured.canonicalPath,
    origin: entry.origin,
    identity: captured.binding.identity,
    external: !!entry.externalPath,
  };
}

export function listRegisteredWorkspaces(workspaceDir: string): ResolvedWorkspace[] {
  const store = loadWorkspaceStore();
  const candidates = Object.keys(store.workspaces)
    .filter((name) => name !== SCRATCHPAD_WORKSPACE_NAME)
    .sort((left, right) => left.localeCompare(right))
    .flatMap((name) => {
      const resolved = resolveWorkspaceEntry(name, workspaceDir);
      return resolved ? [resolved] : [];
    });
  const scratchpad = resolveWorkspaceEntry(SCRATCHPAD_WORKSPACE_NAME, workspaceDir);
  const accepted = scratchpad ? [scratchpad] : [];
  for (const candidate of candidates) {
    if (isFilesystemRoot(candidate.path)) continue;
    if (
      accepted.some(
        (workspace) =>
          isPathInside(workspace.path, candidate.path) ||
          isPathInside(candidate.path, workspace.path),
      )
    ) {
      continue;
    }
    accepted.push(candidate);
  }
  return accepted;
}

export function resolveRegisteredWorkspace(
  name: string,
  workspaceDir: string,
): ResolvedWorkspace | undefined {
  return listRegisteredWorkspaces(workspaceDir).find((workspace) => workspace.name === name);
}

export function getWorkspaceRoot(name: string, workspaceDir: string): string {
  const workspace = resolveRegisteredWorkspace(name, workspaceDir);
  if (!workspace) {
    throw new Error(
      `Workspace "${name}" is unavailable. Add it again or choose another workspace.`,
    );
  }
  return workspace.path;
}

export function getActiveWorkspaceRoot(workspaceDir: string): string {
  const store = loadWorkspaceStore();
  const workspace =
    resolveRegisteredWorkspace(store.activeWorkspace, workspaceDir) ??
    resolveRegisteredWorkspace(SCRATCHPAD_WORKSPACE_NAME, workspaceDir);
  if (!workspace) {
    throw new Error("Scratchpad is unavailable or resolves outside the managed workspace root");
  }
  return workspace.path;
}

export function reconcileActiveWorkspace(workspaceDir: string): void {
  const store = loadWorkspaceStore();
  if (resolveRegisteredWorkspace(store.activeWorkspace, workspaceDir)) return;
  const next = cloneStore();
  next.activeWorkspace = SCRATCHPAD_WORKSPACE_NAME;
  saveWorkspaceStore(next);
}

export function getWorkspaceUIState(): WorkspaceUIState {
  const store = loadWorkspaceStore();
  const expandedPaths: Record<string, string[]> = {};
  const selectedFiles: Record<string, string> = {};
  for (const [name, entry] of Object.entries(store.workspaces)) {
    if (entry.expandedPaths.length > 0) expandedPaths[name] = entry.expandedPaths;
    if (entry.selectedFile) selectedFiles[name] = entry.selectedFile;
  }
  return { activeWorkspace: store.activeWorkspace, expandedPaths, selectedFiles };
}

export function setActiveWorkspace(name: string): boolean {
  const store = cloneStore();
  if (!store.workspaces[name]) return false;
  store.activeWorkspace = name;
  saveWorkspaceStore(store);
  return true;
}

export function setSelectedFile(workspaceName: string, relativePath: string | undefined): boolean {
  const store = cloneStore();
  if (!store.workspaces[workspaceName]) return false;
  if (relativePath) {
    const sanitized = relativePath.replace(/\\/g, "/");
    if (sanitized.startsWith("/") || sanitized.split("/").includes("..")) return false;
    store.workspaces[workspaceName].selectedFile = sanitized;
  } else {
    delete store.workspaces[workspaceName].selectedFile;
  }
  saveWorkspaceStore(store);
  return true;
}

export function setExpandedPaths(workspaceName: string, relativePaths: string[]): void {
  const sanitized = relativePaths
    .map((value) => value.replace(/\\/g, "/"))
    .filter((value) => value && !value.startsWith("/") && !value.split("/").includes(".."));
  const store = cloneStore();
  if (!store.workspaces[workspaceName]) return;
  store.workspaces[workspaceName].expandedPaths = sanitized;
  saveWorkspaceStore(store);
}

export function deleteWorkspaceEntry(name: string): void {
  if (name === SCRATCHPAD_WORKSPACE_NAME) return;
  const store = cloneStore();
  delete store.workspaces[name];
  if (store.activeWorkspace === name) store.activeWorkspace = SCRATCHPAD_WORKSPACE_NAME;
  saveWorkspaceStore(store);
}

export function renameWorkspaceEntry(oldName: string, newName: string): void {
  if (oldName === SCRATCHPAD_WORKSPACE_NAME || newName === SCRATCHPAD_WORKSPACE_NAME) return;
  if (oldName === newName) return;
  const store = cloneStore();
  const entry = store.workspaces[oldName];
  if (!entry) return;
  store.workspaces[newName] = entry;
  delete store.workspaces[oldName];
  if (store.activeWorkspace === oldName) store.activeWorkspace = newName;
  saveWorkspaceStore(store);
}

export function addWorkspaceEntry(name: string, entry: WorkspaceRegistryEntry): void {
  const nameError = validateWorkspaceName(name);
  if (nameError) throw new Error(nameError);
  const store = cloneStore();
  const existing = store.workspaces[name];
  store.workspaces[name] = {
    ...entry,
    expandedPaths: existing ? [...existing.expandedPaths] : [],
    ...(existing?.selectedFile ? { selectedFile: existing.selectedFile } : {}),
  };
  saveWorkspaceStore(store);
}

function registeredPathForCompare(
  name: string,
  entry: WorkspaceEntry,
  workspaceDir: string,
): string {
  const declaredPath = declaredWorkspacePath(name, entry, workspaceDir);
  try {
    return normalizePathForCompare(fs.realpathSync(path.resolve(declaredPath)));
  } catch {
    return normalizePathForCompare(declaredPath);
  }
}

function prepareRegistration(
  name: string,
  canonicalPath: string,
  workspaceDir: string,
): WorkspaceStore {
  const store = cloneStore();
  const managedNameCollision = fs
    .readdirSync(workspaceDir, { withFileTypes: true })
    .find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  if (managedNameCollision) {
    const managedPath = path.join(workspaceDir, managedNameCollision.name);
    let canonicalManagedPath = path.resolve(managedPath);
    try {
      canonicalManagedPath = fs.realpathSync(managedPath);
    } catch {
      // The name is still reserved even when the existing child cannot be resolved.
    }
    if (normalizePathForCompare(canonicalManagedPath) !== normalizePathForCompare(canonicalPath)) {
      throw new Error("A workspace with that name already exists");
    }
  }
  const existingName = findWorkspaceName(store, name);
  if (existingName) {
    const available = resolveRegisteredWorkspace(existingName, workspaceDir);
    if (available) throw new Error("A workspace with that name already exists");
    delete store.workspaces[existingName];
    if (store.activeWorkspace === existingName) {
      store.activeWorkspace = SCRATCHPAD_WORKSPACE_NAME;
    }
  }

  const duplicatePath = Object.entries(store.workspaces).find(
    ([registeredName, entry]) =>
      registeredPathForCompare(registeredName, entry, workspaceDir) ===
      normalizePathForCompare(canonicalPath),
  );
  if (duplicatePath) {
    if (resolveRegisteredWorkspace(duplicatePath[0], workspaceDir)) {
      throw new Error(`Another workspace already uses this folder: ${duplicatePath[0]}`);
    }
    delete store.workspaces[duplicatePath[0]];
    if (store.activeWorkspace === duplicatePath[0]) {
      store.activeWorkspace = SCRATCHPAD_WORKSPACE_NAME;
    }
  }
  const normalizedCandidate = normalizePathForCompare(canonicalPath);
  for (const [registeredName, entry] of Object.entries(store.workspaces)) {
    const registeredPath = registeredPathForCompare(registeredName, entry, workspaceDir);
    if (registeredPath === normalizedCandidate) continue;
    if (
      !isPathInside(registeredPath, normalizedCandidate) &&
      !isPathInside(normalizedCandidate, registeredPath)
    ) {
      continue;
    }
    if (resolveRegisteredWorkspace(registeredName, workspaceDir)) {
      throw new Error(`Workspace folder overlaps registered workspace: ${registeredName}`);
    }
    delete store.workspaces[registeredName];
    if (store.activeWorkspace === registeredName) {
      store.activeWorkspace = SCRATCHPAD_WORKSPACE_NAME;
    }
  }
  return store;
}

export function registerManagedWorkspace(name: string, workspaceDir: string): ResolvedWorkspace {
  const trimmedName = name.trim();
  const nameError = validateWorkspaceName(trimmedName);
  if (nameError) throw new Error(nameError);
  if (trimmedName.toLowerCase() === SCRATCHPAD_WORKSPACE_NAME.toLowerCase()) {
    throw new Error("A workspace with that name already exists");
  }
  secureMkdirSync(workspaceDir, 0o700);
  const caseCollision = fs
    .readdirSync(workspaceDir, { withFileTypes: true })
    .find((entry) => entry.name.toLowerCase() === trimmedName.toLowerCase());
  if (caseCollision) throw new Error("A workspace with that name already exists");

  const workspacePath = path.join(workspaceDir, trimmedName);
  fs.mkdirSync(workspacePath);
  try {
    const captured = captureWorkspaceBinding(trimmedName, workspacePath);
    if (!isManagedWorkspaceRoot(workspaceDir, captured.canonicalPath)) {
      throw new Error("Workspace path escapes the managed workspace directory");
    }
    const store = prepareRegistration(trimmedName, captured.canonicalPath, workspaceDir);
    store.workspaces[trimmedName] = {
      origin: "user-created",
      identity: captured.binding.identity,
      expandedPaths: [],
    };
    saveWorkspaceStore(store);
    return {
      name: trimmedName,
      path: captured.canonicalPath,
      origin: "user-created",
      identity: captured.binding.identity,
      external: false,
    };
  } catch (error) {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    throw error;
  }
}

export function registerExistingWorkspace(
  name: string,
  externalPath: string,
  workspaceDir: string,
  origin: Extract<WorkspaceOrigin, "user-added" | "e2e-fixture"> = "user-added",
): ResolvedWorkspace {
  const trimmedName = name.trim();
  const nameError = validateWorkspaceName(trimmedName);
  if (nameError) throw new Error(nameError);
  if (trimmedName.toLowerCase() === SCRATCHPAD_WORKSPACE_NAME.toLowerCase()) {
    throw new Error("A workspace with that name already exists");
  }
  const captured = captureWorkspaceBinding(trimmedName, externalPath);
  if (isFilesystemRoot(captured.canonicalPath)) {
    throw new Error("A filesystem root cannot be registered as a workspace");
  }
  const store = prepareRegistration(trimmedName, captured.canonicalPath, workspaceDir);
  store.workspaces[trimmedName] = {
    origin,
    externalPath: captured.canonicalPath,
    identity: captured.binding.identity,
    expandedPaths: [],
  };
  saveWorkspaceStore(store);
  return {
    name: trimmedName,
    path: captured.canonicalPath,
    origin,
    identity: captured.binding.identity,
    external: true,
  };
}

export function getWorkspaceRegistry(): Record<string, WorkspaceRegistryEntry> {
  const store = loadWorkspaceStore();
  return Object.fromEntries(
    Object.entries(store.workspaces).map(([name, entry]) => [
      name,
      {
        origin: entry.origin,
        ...(entry.externalPath ? { externalPath: entry.externalPath } : {}),
        ...(entry.identity ? { identity: { ...entry.identity } } : {}),
      },
    ]),
  );
}
