import type { MemoryEntry } from "@common/marshal-ipc-contract";

import { createLogger } from "../../../common/marshal-logger";
import type { IMemoryStore, MemoryForgetOutcome, MemoryForgetTarget } from "../../backend/ports";

const log = createLogger("LocalMemoryPurge");

export const FORGET_COMPLETELY_UNSUPPORTED =
  "The active memory provider cannot forget completely; use forget without completely.";

/** Full trimmed, case-insensitive text; no dedupe prefix, so a same-prefix memory never matches. */
export function memoryFactKey(fact: string): string {
  return fact.trim().toLowerCase();
}

/** A plain forget in a store without history: the entry is gone, nothing is left behind. */
export const REMOVED_WITHOUT_HISTORY: MemoryForgetOutcome = {
  forgotten: true,
  contentBlanked: true,
  historyRevisionsWithText: 0,
  tombstoneKept: false,
  message: "Forgotten: it was removed; no earlier revision or tombstone remains.",
};

/** A plain forget in a provider that cannot report history: removed, with no claim about what remains. */
export const FORGOTTEN_HISTORY_UNKNOWN: MemoryForgetOutcome = {
  forgotten: true,
  message: "Forgotten: it no longer appears in recall.",
};

/** forgetTarget for stores without one: only active memories in `list()` are found. */
export function forgetTargetFromList(store: IMemoryStore, id: string): MemoryForgetTarget | null {
  const text = factForId(store, id);
  if (text === undefined) return null;
  return { id, state: "active", text, revisions: 1, revisionsWithText: 1 };
}

/** The fact the active provider holds for `id`, read before it is deleted. */
export function factForId(store: IMemoryStore, id: string): string | undefined {
  try {
    const entry = store.list().find((candidate: MemoryEntry) => candidate?.id === id);
    return typeof entry?.fact === "string" ? entry.fact : undefined;
  } catch (error) {
    log.warn("Could not read the memory before forgetting it", {
      error: error instanceof Error ? error.name : typeof error,
    });
    return undefined;
  }
}

/**
 * Deletes every local fallback entry holding one of the given facts, so a fact
 * forgotten in the active provider does not come back when the provider is
 * disabled. Uses one batched rewrite when the store supports it. Never throws;
 * failures are logged by counts only.
 */
export async function removeLocalFactCopies(
  local: IMemoryStore,
  facts: readonly unknown[],
): Promise<number> {
  const keys = new Set(
    facts.flatMap((fact) =>
      typeof fact === "string" && memoryFactKey(fact) ? [memoryFactKey(fact)] : [],
    ),
  );
  if (keys.size === 0) return 0;
  let matches: MemoryEntry[];
  try {
    matches = local
      .list()
      .filter((entry) => typeof entry?.fact === "string" && keys.has(memoryFactKey(entry.fact)));
  } catch (error) {
    log.warn("Local memory copies could not be listed", {
      error: error instanceof Error ? error.name : typeof error,
    });
    return 0;
  }
  if (matches.length === 0) return 0;
  const ids = matches.map((entry) => entry.id);
  if (typeof local.deleteMany === "function") {
    try {
      return await local.deleteMany(ids);
    } catch (error) {
      log.warn("Local memory copies could not be removed", {
        count: ids.length,
        error: error instanceof Error ? error.name : typeof error,
      });
      return 0;
    }
  }
  const outcomes = await Promise.allSettled(ids.map((id) => local.delete(id)));
  const removed = outcomes.filter(
    (outcome) => outcome.status === "fulfilled" && outcome.value,
  ).length;
  const failed = outcomes.filter((outcome) => outcome.status === "rejected").length;
  if (failed > 0) log.warn("Some local memory copies could not be removed", { removed, failed });
  return removed;
}
