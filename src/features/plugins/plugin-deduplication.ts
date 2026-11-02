import type { RuntimeExtensionProjectedStatusItem } from "@common/marshal-ipc-contract";
import type { RuntimeExtensionCatalogEntry } from "@marshal/runtime/extensions";

/** Preserve ordering and the actionable installed record when sources overlap. */
export function uniqueRuntimeEntries(entries: readonly RuntimeExtensionCatalogEntry[]) {
  const result = new Map<string, RuntimeExtensionCatalogEntry>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.identity, entry.version]);
    const previous = result.get(key);
    if (!previous || (!previous.installation && entry.installation)) result.set(key, entry);
  }
  return [...result.values()];
}

export function uniqueDetectedItems(
  items: readonly RuntimeExtensionProjectedStatusItem[],
  entries: readonly RuntimeExtensionCatalogEntry[],
) {
  const catalogKeys = new Set(
    entries.map((entry) => JSON.stringify([entry.identity, entry.version])),
  );
  const seen = new Set<string>();
  return items.filter((item) => {
    if (item.catalogEntryId) return false;
    const key =
      item.identity && item.version
        ? JSON.stringify([item.identity, item.version])
        : (item.packageRoot ?? item.candidateId);
    if (catalogKeys.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function uniqueByKey<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
