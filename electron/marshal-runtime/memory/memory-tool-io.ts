import { existsSync } from "node:fs";
import path from "node:path";

import type { MemoryEntry } from "@common/marshal-ipc-contract";

import type { MemoryAddOptions } from "../../backend/ports";
import { GLOBAL_MEMORY_APPLIES_TO, memoryAppliesTo } from "./memory-scoping";
import { wrapUntrustedMemoryFact } from "./prompt-provenance";

export const NO_MEMORY_PROJECT_ERROR =
  'This session has no git project workspace to scope the memory to; store it with appliesTo "global" instead.';

/** The shape `recall` and `listMemories` return for each entry. */
export function toMemoryToolEntry(entry: MemoryEntry) {
  return {
    id: entry.id,
    fact: wrapUntrustedMemoryFact(entry.fact),
    category: entry.category,
    createdAt: entry.createdAt,
    source: entry.source,
    appliesTo: memoryAppliesTo(entry),
  };
}

/**
 * `undefined` when the call needs none, so old providers see the old call
 * shape. `appliesTo` is sent only when the agent chose one: a replacement
 * without it inherits the replaced memory's scope in the store.
 */
export function buildRememberOptions(
  replaces: string | undefined,
  appliesTo: "global" | "project" | undefined,
  project: { workspacePath: string; projectId: string } | undefined,
): MemoryAddOptions | undefined {
  const scope = project
    ? { appliesTo: project.projectId, workspacePath: project.workspacePath }
    : appliesTo === "global" && replaces
      ? { appliesTo: GLOBAL_MEMORY_APPLIES_TO }
      : {};
  if (!replaces && !project) return undefined;
  return { ...(replaces ? { replaces } : {}), ...scope };
}

const REPO_PATH = /(?:^|[\s`'"(])((?:[\w.@-]+\/)+[\w.@-]+)/g;

/**
 * Nudge for a `remember` fact that names paths existing in the workspace:
 * only `memory.link` attaches code, and the agent chooses the links.
 * Absolute, home-relative and URL paths are not repo code and never match.
 */
export function codeLinkHint(
  fact: string,
  memoryId: string,
  workspacePath: string,
): string | undefined {
  const candidates = new Set(Array.from(fact.matchAll(REPO_PATH), (match) => match[1]));
  const paths = [...candidates].filter(
    (candidate) =>
      !candidate.split("/").includes("..") && existsSync(path.join(workspacePath, candidate)),
  );
  if (paths.length === 0) return undefined;
  return `This fact names code (${paths.slice(0, 3).join(", ")}). If it is about that code, save it with memory.link through runtimeExecuteTypeScript, linking the files and symbols it explains, then forget ${memoryId}.`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
