/**
 * Context source registry — the composer's picker pulls suggestions from a set
 * of registered sources rather than from one hard-wired backend.
 *
 * The contract below is deliberately product-neutral: a source is an id, a
 * label, the entity types it contributes, its own user-facing copy, and an
 * optional `search`. Nothing in it names a provider, a transport, or a config
 * ring, so adding a second source (local files, a repo index, another work
 * account) is a registry entry plus a `ContextSourceSearch` — not an edit to
 * the picker.
 */

import type { ContextEntity, ContextEntityType } from "@/types/electron";

/** Every user-facing string a source can put on screen, owned by the source. */
export interface ContextSourceCopy {
  /** Shown when the source returned nothing and reported no problem. */
  readonly empty: string;
  /** Shown when `empty` would render but the user typed a query. */
  readonly noMatch: (query: string) => string;
  /** Shown when the source is reachable but the search failed. */
  readonly error: string;
}

export interface ContextSourceSearchResult {
  readonly entities: ContextEntity[];
}

export class ContextSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextSourceError";
  }
}

export type ContextSourceSearch = (args: {
  query: string;
  workspaceName?: string;
  entityTypes?: readonly ContextEntityType[];
  signal: AbortSignal;
}) => Promise<ContextSourceSearchResult>;

export interface ContextSourceProvider {
  /** Stable id. Doubles as the picker's tab id. */
  readonly id: ContextEntityType | "Skills";
  readonly label: string;
  /** Entity types this source contributes. Empty for picker-local sources. */
  readonly entityTypes: readonly ContextEntityType[];
  /** Only listed when the picker was opened with `/` at column 0. */
  readonly startSlashOnly?: boolean;
  readonly copy: ContextSourceCopy;
  /**
   * Absent for sources the picker fills itself — Skills and slash commands are
   * already in renderer memory and never round-trip to a backend.
   */
  readonly search?: ContextSourceSearch;
}

const searchPeople: ContextSourceSearch = async ({ query, entityTypes, signal }) => {
  const api = window.contextPickerAPI?.search;
  if (signal.aborted || !api) return { entities: [] };
  const result = await api(query, entityTypes ? [...entityTypes] : undefined);
  if (signal.aborted) return { entities: [] };
  if (!result.success) throw new ContextSourceError(result.error ?? "Search failed");
  return { entities: result.entities ?? [] };
};

const searchLocalFiles: ContextSourceSearch = async ({ query, workspaceName, signal }) => {
  const api = window.workspaceAPI?.searchFiles;
  if (signal.aborted || !api) return { entities: [] };
  const result = await api(workspaceName, query);
  if (signal.aborted) return { entities: [] };
  if (!result.success) throw new ContextSourceError(result.error ?? "File search failed");
  return { entities: result.files ?? [] };
};

export const CONTEXT_SOURCE_PROVIDERS: readonly ContextSourceProvider[] = [
  {
    id: "Skills",
    label: "Skills",
    entityTypes: [],
    startSlashOnly: true,
    copy: {
      empty: "No matching commands or skills",
      noMatch: () => "No matching commands or skills",
      error: "No matching commands or skills",
    },
  },
  {
    id: "People",
    label: "People",
    entityTypes: ["People"],
    copy: {
      empty: "No results found",
      noMatch: (query) => `No matches for "${query}"`,
      error: "Couldn’t search people. Try again in a moment.",
    },
    search: searchPeople,
  },
  {
    id: "File",
    label: "Files",
    entityTypes: ["File"],
    copy: {
      empty: "No files in this workspace",
      noMatch: (query) => `No local files match "${query}"`,
      error: "Couldn’t search local workspace files.",
    },
    search: searchLocalFiles,
  },
];

export function getContextSourceProvider(
  id: ContextSourceProvider["id"],
): ContextSourceProvider | undefined {
  return CONTEXT_SOURCE_PROVIDERS.find((source) => source.id === id);
}

/** Sources listed for the current trigger. */
export function getVisibleContextSources(isStartSlash: boolean): readonly ContextSourceProvider[] {
  return isStartSlash
    ? CONTEXT_SOURCE_PROVIDERS.filter((source) => source.startSlashOnly)
    : CONTEXT_SOURCE_PROVIDERS.filter((source) => !source.startSlashOnly);
}

/**
 * Run every searchable source once and concatenate the results. Sources that
 * share a `search` implementation are called a single time so a multi-tab
 * picker doesn't issue identical requests.
 */
export async function searchContextSources(args: {
  query: string;
  workspaceName?: string;
  entityTypes?: readonly ContextEntityType[];
  signal: AbortSignal;
}): Promise<ContextSourceSearchResult> {
  const searches = new Set<ContextSourceSearch>();
  for (const source of CONTEXT_SOURCE_PROVIDERS) {
    if (
      source.search &&
      (!args.entityTypes || source.entityTypes.some((type) => args.entityTypes?.includes(type)))
    ) {
      searches.add(source.search);
    }
  }

  const entities: ContextEntity[] = [];
  for (const search of searches) {
    // eslint-disable-next-line no-await-in-loop -- source order determines stable context-picker result order.
    const result = await search({
      query: args.query,
      workspaceName: args.workspaceName,
      entityTypes: args.entityTypes,
      signal: args.signal,
    });
    entities.push(...result.entities);
  }

  return { entities };
}
