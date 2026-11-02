// electron/workflows/workflow-loader.ts
//
// Resolve and load workflow definitions. Two roots are supported:
//   1. `~/.marshal/marshal-workflows/<id>/` (R+W via `install-local`)
//   2. `<repo>/.github/marshal-workflows/<id>/` (repo-local, no install step)
//
// Each workflow folder ships:
//   manifest.json
//   workflow.ts (source)
//   dist/workflow.js (compiled, when prebuilt)
//   renderer.tsx (optional)
//   .installed.json (sidecar — owned by `installed-source-store`)
//
// User-local workflows still run from prebuilt dist files. Repo-local
// workflows may be source-only: the run manager compiles `workflow.ts` at run
// start and pins the resulting JS into the run directory.
//
// Pinning at run start: `pinCompiledForRun(workflowId, runId)` copies the
// current `dist/workflow.js` bytes into the run directory so a later
// `install-local --overwrite` cannot corrupt an in-flight run (r1-fixes
// A5). All subsequent `loadForRun` calls read from the run-local pin.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

import type { WorkflowDefinition } from "@marshal/workflow-sdk";

import { createLogger } from "../../common/marshal-logger";
import {
  BindingsFileSchema,
  type BindingsFile,
  EMPTY_BINDINGS,
  type InstalledSource,
  WorkflowManifestSchema,
  type WorkflowManifest,
} from "../../common/workflows-contract";
import { getAppDataDir } from "../app-paths";
import { WorkflowInstallError, WorkflowNotFoundError } from "./errors";
import { readInstalledSource } from "./installed-source-store";
import { compileWithEsbuild } from "./workflow-compiler";

const log = createLogger("WorkflowLoader");

export interface LoaderDeps {
  /** Override the user workflow root (defaults to `~/.marshal/marshal-workflows/`). */
  readonly userRoot?: string;
  /** Override require() for tests. */
  readonly requireFn?: (path: string) => unknown;
}

export interface InstalledWorkflowEntry {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly description?: string;
  readonly version: string;
  readonly source: InstalledSource["source"];
  readonly installedAt: number;
  readonly distHash: string;
  readonly manifest: WorkflowManifest;
  readonly dir: string;
  readonly repoPath?: string;
  readonly workspaceName?: string;
}

export interface WorkflowLookup {
  readonly workflowId: string;
  readonly repoPath?: string | null;
  readonly workspaceName?: string;
}

export class WorkflowLoader {
  constructor(private readonly deps: LoaderDeps = {}) {}

  userRoot(): string {
    return this.deps.userRoot ?? path.join(getAppDataDir(), "marshal-workflows");
  }

  listInstalled(): InstalledWorkflowEntry[] {
    const entries: InstalledWorkflowEntry[] = [];
    const root = this.userRoot();
    if (!fs.existsSync(root)) return entries;
    for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const entry = this.readEntry(path.join(root, dirent.name));
      if (entry) entries.push(entry);
    }
    return entries;
  }

  repoWorkflowRoot(repoPath: string): string {
    return path.join(path.resolve(repoPath), ".github", "marshal-workflows");
  }

  private legacyRepoWorkflowRoot(repoPath: string): string {
    return path.join(path.resolve(repoPath), ".github", "m-workflows");
  }

  listRepoWorkflows(repoPath: string, workspaceName?: string): InstalledWorkflowEntry[] {
    const entries: InstalledWorkflowEntry[] = [];
    const seenIds = new Set<string>();
    for (const root of [this.repoWorkflowRoot(repoPath), this.legacyRepoWorkflowRoot(repoPath)]) {
      if (!fs.existsSync(root)) continue;
      for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue;
        const dir = path.join(root, dirent.name);
        const entry = this.readEntry(dir, {
          source: "repo-local",
          repoPath: path.resolve(repoPath),
          workspaceName,
        });
        if (entry && !seenIds.has(entry.id)) {
          seenIds.add(entry.id);
          entries.push(entry);
        }
      }
    }
    return entries;
  }

  /** Read manifest + sidecar without compiling. */
  private readEntry(
    dir: string,
    opts: { source?: InstalledSource["source"]; repoPath?: string; workspaceName?: string } = {},
  ): InstalledWorkflowEntry | null {
    const manifestPath = path.join(dir, "manifest.json");
    if (!fs.existsSync(manifestPath)) return null;
    try {
      const raw = fs.readFileSync(manifestPath, "utf-8");
      const obj = JSON.parse(raw) as unknown;
      if (typeof obj !== "object" || obj === null) return null;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- typeof guard above; Zod validates immediately
      const objRecord = obj as Record<string, unknown>;
      // Strip any disk-supplied `source` (per r1-fixes A12).
      delete objRecord.source;
      const parsed = WorkflowManifestSchema.safeParse(objRecord);
      if (!parsed.success) {
        log.warn(`manifest.json schema mismatch in ${dir}:`, parsed.error.issues);
        return null;
      }
      const manifest = parsed.data;
      const sidecar = readInstalledSource(dir);
      // Bundled folders may omit the sidecar — default to bundled.
      const source: InstalledSource["source"] = opts.source ?? sidecar?.source ?? "bundled";
      const distHash = sidecar?.distHash ?? this.hashDist(dir);
      return {
        id: manifest.id,
        key: workflowEntryKey({
          workflowId: manifest.id,
          source,
          repoPath: opts.repoPath,
        }),
        title: manifest.title,
        description: manifest.description,
        version: manifest.version,
        source,
        installedAt: sidecar?.installedAt ?? 0,
        distHash,
        manifest,
        dir,
        repoPath: opts.repoPath,
        workspaceName: opts.workspaceName,
      };
    } catch (err) {
      log.warn(`Failed to read workflow at ${dir}:`, err);
      return null;
    }
  }

  /** Get a single workflow by id, optionally scoped to a repo-local root. */
  getEntry(lookup: string | WorkflowLookup): InstalledWorkflowEntry {
    const workflowId = typeof lookup === "string" ? lookup : lookup.workflowId;
    const repoPath = typeof lookup === "string" ? undefined : lookup.repoPath;
    const workspaceName = typeof lookup === "string" ? undefined : lookup.workspaceName;
    if (repoPath) {
      const entry = this.listRepoWorkflows(repoPath, workspaceName).find(
        (e) => e.id === workflowId,
      );
      if (!entry) {
        throw new WorkflowNotFoundError(
          workflowId,
          `Workflow '${workflowId}' not found in repo. Checked current and legacy .github workflow roots.`,
        );
      }
      return entry;
    }
    const entry = this.listInstalled().find((e) => e.id === workflowId);
    if (!entry) throw new WorkflowNotFoundError(workflowId);
    return entry;
  }

  /**
   * Copy the workflow's compiled bytes into the run directory and return
   * the SHA-256 hash. Subsequent `loadForRun(runId)` reads the pin.
   */
  async pinCompiledForRun(lookup: string | WorkflowLookup, runDestPath: string): Promise<string> {
    const entry = this.getEntry(lookup);
    const compiledSrc = path.join(entry.dir, "dist", "workflow.js");
    let bytes: Buffer;
    if (entry.source === "repo-local" && fs.existsSync(path.join(entry.dir, "workflow.ts"))) {
      const compiled = await compileWithEsbuild(path.join(entry.dir, "workflow.ts"));
      fs.mkdirSync(path.dirname(runDestPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(runDestPath, compiled, { mode: 0o600 });
      bytes = Buffer.from(compiled, "utf-8");
    } else if (fs.existsSync(compiledSrc)) {
      fs.mkdirSync(path.dirname(runDestPath), { recursive: true, mode: 0o700 });
      fs.copyFileSync(compiledSrc, runDestPath);
      bytes = fs.readFileSync(runDestPath);
    } else {
      throw new WorkflowInstallError(
        "MISSING_WORKFLOW_TS",
        entry.source === "repo-local"
          ? `Workflow '${entry.id}' has neither dist/workflow.js nor workflow.ts at ${entry.dir}.`
          : `Workflow ${entry.id} has no dist/workflow.js — build or import it through the workflow authoring UI/CLI.`,
      );
    }
    // Ensure Node treats the pinned copy as CJS (matches the dist-local
    // package.json the install + bundle scripts write).
    fs.writeFileSync(
      path.join(path.dirname(runDestPath), "package.json"),
      JSON.stringify({ type: "commonjs" }),
    );
    copyAssetsDir(entry.dir, path.dirname(runDestPath));
    return createHash("sha256").update(bytes).digest("hex");
  }

  /**
   * Load the WorkflowDefinition from a previously pinned run-local copy.
   * Uses a fresh `require()` cache key each call to defeat Node's module
   * cache — replays must always run against the on-disk bytes.
   */
  loadFromRunPin(runDestPath: string): WorkflowDefinition {
    if (!fs.existsSync(runDestPath)) {
      throw new WorkflowInstallError(
        "MISSING_WORKFLOW_TS",
        `Pinned workflow missing at ${runDestPath}`,
      );
    }
    const req = this.deps.requireFn ?? createRequire(runDestPath);
    // `require.cache` does not survive across loaders that pass their own
    // requireFn; for the default Node loader, evict before re-require.
    if (!this.deps.requireFn) {
      try {
        // The Node-supplied `createRequire` returns a NodeRequire (has
        // `.resolve`). Tests pass a plain function and skip this branch.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- createRequire always returns NodeRequire on Node ≥12
        const nodeReq = req as unknown as NodeRequire;
        const resolved = nodeReq.resolve(runDestPath);
        if (require.cache[resolved]) delete require.cache[resolved];
      } catch {
        /* ignore */
      }
    }
    const mod: unknown = req(runDestPath);
    let def: WorkflowDefinition | undefined;
    if (mod && typeof mod === "object" && "default" in mod) {
      const inner = (mod as { default?: unknown }).default;
      if (inner && typeof inner === "object" && "run" in inner) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- structural guard above; final shape validated by the `typeof def.run` check
        def = inner as WorkflowDefinition;
      }
    } else if (mod && typeof mod === "object" && "run" in mod) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- structural guard above; final shape validated by the `typeof def.run` check
      def = mod as WorkflowDefinition;
    }
    if (!def || typeof def.run !== "function") {
      throw new WorkflowInstallError(
        "COMPILE_FAILED",
        `${runDestPath} does not default-export a WorkflowDefinition`,
      );
    }
    return def;
  }

  private hashDist(dir: string): string {
    const file = path.join(dir, "dist", "workflow.js");
    if (!fs.existsSync(file)) return "";
    const bytes = fs.readFileSync(file);
    return createHash("sha256").update(bytes).digest("hex");
  }

  /**
   * Read `bindings.json` from a workflow install dir, if present. Falls
   * back to `EMPTY_BINDINGS` when missing (legacy installs / workflows
   * that don't declare any agentRequirements). Invalid files are logged
   * and `EMPTY_BINDINGS` returned so a corrupt bindings file does NOT
   * brick the workflow at run time — the engine's slot resolver will
   * throw a precise per-slot error if needed.
   */
  loadBindings(workflowId: string): BindingsFile {
    const entry = this.getEntry(workflowId);
    return readBindingsFile(entry.dir);
  }
}

export function workflowEntryKey(args: {
  workflowId: string;
  source: InstalledSource["source"];
  repoPath?: string;
}): string {
  if (args.source === "repo-local" && args.repoPath) {
    return `repo-local:${path.resolve(args.repoPath)}:${args.workflowId}`;
  }
  return `${args.source}:${args.workflowId}`;
}

function copyAssetsDir(srcDir: string, destDir: string): void {
  const assetsSrc = path.join(srcDir, "assets");
  if (!fs.existsSync(assetsSrc) || !fs.statSync(assetsSrc).isDirectory()) return;
  fs.cpSync(assetsSrc, path.join(destDir, "assets"), { recursive: true });
}

/**
 * Pure helper: read & validate a `bindings.json` next to a workflow
 * install dir. Exported so the install tool can re-use it.
 */
export function readBindingsFile(dir: string): BindingsFile {
  const bindingsPath = path.join(dir, "bindings.json");
  if (!fs.existsSync(bindingsPath)) return EMPTY_BINDINGS;
  try {
    const raw = JSON.parse(fs.readFileSync(bindingsPath, "utf-8")) as unknown;
    const parsed = BindingsFileSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn(
        `bindings.json schema mismatch in ${dir}: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
      return EMPTY_BINDINGS;
    }
    return parsed.data;
  } catch (err) {
    log.warn(`Failed to read bindings.json in ${dir}:`, err);
    return EMPTY_BINDINGS;
  }
}
