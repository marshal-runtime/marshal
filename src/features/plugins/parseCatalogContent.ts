// Marshal-owned module.
import type { CatalogItem } from "@common/extensions-catalog/marshal-extension-catalog";

/**
 * Safely parse the raw JSON content of a first-party catalog item.
 * Returns null for non-first-party items or on parse failure.
 */
export function parseCatalogContent(source: CatalogItem["source"]): { args?: string[] } | null {
  if (source.type !== "first-party") return null;
  try {
    const parsed: unknown = JSON.parse(source.content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as { args?: string[] }; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- shape-guarded above
  } catch {
    return null;
  }
}
