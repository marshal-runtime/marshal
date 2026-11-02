/**
 * useContextSearch — debounced entity search across the registered context
 * sources (see `context-sources.ts`). The hook knows nothing about which
 * backend serves a source; it asks the registry and renders what comes back.
 */

import { useQuery } from "@tanstack/react-query";

import { useDebouncedValue } from "@/shared/hooks/timing/useDebouncedValue";
import type { ContextEntity, ContextEntityType } from "@/types/electron";

import { searchContextSources } from "./context-sources";

export const CONTEXT_SEARCH_QUERY_KEY = ["contextPicker", "search"] as const;

interface UseContextSearchOptions {
  query: string;
  enabled: boolean;
  entityTypes?: ContextEntityType[];
  workspaceName?: string;
}

export interface ContextSearchResult {
  entities: ContextEntity[];
  isLoading: boolean;
  /** Free-form error string from the source, suitable for rendering. */
  error: string | null;
}

export function useContextSearch({
  query,
  enabled,
  entityTypes,
  workspaceName,
}: UseContextSearchOptions): ContextSearchResult {
  const debouncedQuery = useDebouncedValue(query, 300, { enabled, disabledValue: "" });

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: [...CONTEXT_SEARCH_QUERY_KEY, debouncedQuery, entityTypes, workspaceName],
    queryFn: async ({ signal }): Promise<ContextEntity[]> => {
      const result = await searchContextSources({
        query: debouncedQuery,
        entityTypes,
        workspaceName,
        signal,
      });
      return result.entities;
    },
    enabled: enabled,
    staleTime: 30_000,
    gcTime: 60_000,
    retry: false,
  });

  const errorMessage = error instanceof Error ? error.message : null;

  return {
    entities: data ?? [],
    isLoading: enabled && (isLoading || isFetching || query !== debouncedQuery),
    error: errorMessage,
  };
}
