// electron/workflows/workflow-introspect.ts
//
// Helpers for reading metadata out of a compiled workflow.js without a
// running engine. Used by:
//
//  - The install tool (`install-local.ts`) to discover `agentRequirements`
//    so it can validate the binding map covers every declared slot.
//  - The `workflowDescribe` self-tool (which surfaces requirements +
//    manifest metadata to the installing agent).
//
// The compiled JS bundles `@marshal/workflow-sdk` and `zod`, so we
// can `require()` it from a tmpdir. The actual load is hash-cached below:
// V8 keeps compiled script source alive even after require.cache eviction, so
// repeated describe/list calls must not create fresh temp modules for identical
// bytes.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { Module } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

import type { WorkflowDefinition } from "@marshal/workflow-sdk";

import { WorkflowInstallError } from "./errors";

const MAX_DEFINITION_CACHE_ENTRIES = 128;
const definitionCache = new Map<string, WorkflowDefinition>();

function cacheKeyForCompiled(
  compiledJs: string,
  workflowId: string,
  workflowSrcDir: string,
): string {
  const hash = createHash("sha256").update(compiledJs).digest("hex");
  return `${workflowId}\0${path.resolve(workflowSrcDir)}\0${hash}`;
}

function getCachedDefinition(cacheKey: string): WorkflowDefinition | undefined {
  const cached = definitionCache.get(cacheKey);
  if (!cached) return undefined;
  definitionCache.delete(cacheKey);
  definitionCache.set(cacheKey, cached);
  return cached;
}

function setCachedDefinition(cacheKey: string, def: WorkflowDefinition): void {
  definitionCache.set(cacheKey, def);
  while (definitionCache.size > MAX_DEFINITION_CACHE_ENTRIES) {
    const oldest = definitionCache.keys().next().value;
    if (oldest === undefined) break;
    definitionCache.delete(oldest);
  }
}

export function clearWorkflowIntrospectionCacheForTests(): void {
  definitionCache.clear();
}

/**
 * Load a compiled workflow's default export from in-memory bytes. Results are
 * cached by workflow id, source dir, and compiled-byte hash so repeated
 * introspection does not create unbounded V8 Script/source objects while still
 * reloading when the compiled bytes change.
 */
export async function loadDefinitionFromCompiled(
  compiledJs: string,
  workflowId: string,
  workflowSrcDir: string,
): Promise<WorkflowDefinition> {
  const cacheKey = cacheKeyForCompiled(compiledJs, workflowId, workflowSrcDir);
  const cached = getCachedDefinition(cacheKey);
  if (cached) return cached;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `wf-introspect-${workflowId}-`));
  const file = path.join(tmp, "workflow.compiled.js");
  fs.writeFileSync(file, compiledJs, "utf-8");
  // Sibling package.json so Node treats this as CJS regardless of any
  // ancestor `"type": "module"` declaration that might exist when the
  // tmpdir is below a Node project root.
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ type: "commonjs" }));
  try {
    // Use a NodeRequire rooted in the workflow source dir so any
    // externalised deps (`electron` is the only one in the default
    // esbuild config) resolve to the host app's node_modules.
    const req = Module.createRequire(path.join(workflowSrcDir, "introspect.js"));
    // Evict any earlier copy to avoid stale results across re-installs.
    try {
      const resolved = (req as NodeRequire).resolve(file);
      if (require.cache[resolved]) delete require.cache[resolved];
    } catch {
      /* ignore */
    }
    const mod: unknown = req(file);
    const def = extractDefinition(mod);
    if (!def) {
      throw new WorkflowInstallError(
        "COMPILE_FAILED",
        `Compiled workflow at ${file} does not default-export a WorkflowDefinition`,
      );
    }
    setCachedDefinition(cacheKey, def);
    return def;
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

function extractDefinition(mod: unknown): WorkflowDefinition | undefined {
  if (!mod || typeof mod !== "object") return undefined;
  const m = mod as { default?: unknown; run?: unknown };
  const candidate = (m.default ?? m) as { run?: unknown };
  if (candidate && typeof candidate === "object" && typeof candidate.run === "function") {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- structural guard above
    return candidate as WorkflowDefinition;
  }
  return undefined;
}
