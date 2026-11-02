import type { MemoryEntry } from "@common/marshal-ipc-contract";

import type { MemoryAddOptions } from "../../backend/ports";
import { GLOBAL_MEMORY_APPLIES_TO, memoryAppliesTo } from "./memory-scoping";

export interface FallbackMemoryAddPlan {
  /** The store's entries with the replaced one removed. */
  readonly memories: MemoryEntry[];
  /** Same fact text in the same scope: touch it instead of adding. */
  readonly duplicate?: MemoryEntry;
  /** Project id for a new entry; `undefined` for global. */
  readonly appliesTo?: string;
}

/**
 * An explicit `appliesTo` wins; otherwise a replacement inherits the replaced
 * memory's scope, and a plain add is global. Dedupe is per fact and scope.
 */
export function planFallbackMemoryAdd(
  memories: MemoryEntry[],
  fact: string,
  options: MemoryAddOptions | undefined,
): FallbackMemoryAddPlan {
  const replaces = options?.replaces;
  const replaced = replaces ? memories.find((memory) => memory.id === replaces) : undefined;
  if (replaces && !replaced) {
    throw new Error(`Memory ${replaces} does not exist; nothing was stored.`);
  }
  const requested = options?.appliesTo?.trim();
  const scope = requested
    ? memoryAppliesTo({ appliesTo: requested })
    : replaced
      ? memoryAppliesTo(replaced)
      : GLOBAL_MEMORY_APPLIES_TO;
  const remaining = replaced ? memories.filter((memory) => memory !== replaced) : memories;
  const key = fact.toLowerCase();
  const duplicate = remaining.find(
    (memory) => memory.fact.toLowerCase() === key && memoryAppliesTo(memory) === scope,
  );
  return {
    memories: remaining,
    ...(duplicate ? { duplicate } : {}),
    ...(scope === GLOBAL_MEMORY_APPLIES_TO ? {} : { appliesTo: scope }),
  };
}

export function touchMemory(memory: MemoryEntry): MemoryEntry {
  memory.lastAccessedAt = new Date().toISOString();
  memory.accessCount++;
  return memory;
}

/** Keyword match count, then most recently accessed; matched entries are touched. */
export function rankMemoriesByKeywords(
  memories: readonly MemoryEntry[],
  words: readonly string[],
  limit: number,
): MemoryEntry[] {
  return memories
    .map((memory) => ({
      memory,
      score: words.filter((word) => memory.fact.toLowerCase().includes(word)).length,
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (
        new Date(b.memory.lastAccessedAt).getTime() - new Date(a.memory.lastAccessedAt).getTime()
      );
    })
    .slice(0, limit)
    .map((item) => touchMemory(item.memory));
}
