import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  startTransition,
  useState,
  useEffect,
  useMemo,
  useCallback,
  useDeferredValue,
} from "react";

import type { SessionListPage, SessionMetadata, SessionSearchResult } from "@/types/electron";

const SEARCH_DEBOUNCE_MS = 300;
export const SESSION_PAGE_SIZE = 40;

export type DisplaySession = SessionMetadata & { snippets?: string[] };
export type SessionListFilter = "chats" | "all" | "subagents" | "workflow-agents";
type SessionPages = InfiniteData<SessionListPage>;

interface UseSessionsReturn {
  sessions: SessionMetadata[];
  displaySessions: DisplaySession[];
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  filter: SessionListFilter;
  setFilter: (filter: SessionListFilter) => void;
  isSearchStale: boolean;
  isLoading: boolean;
  isError: boolean;
  errorMessage?: string;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  loadMore: () => Promise<void>;
  refetch: () => Promise<void>;
  /** Optimistically remove a session from the local list (before IPC confirms). */
  optimisticRemove: (sessionId: string) => void;
}

interface UseSessionsOptions {
  includeWorkflowRuns?: boolean;
}

async function listSessionsPage(
  beforeSessionId: string | undefined,
  includeWorkflowRuns: boolean,
): Promise<SessionListPage> {
  if (!window.sessionsAPI) return { sessions: [], hasMore: false };
  if (!window.sessionsAPI.listWithOptions) {
    const result = await window.sessionsAPI.list();
    if (!result.success) throw new Error(result.error ?? "Sessions could not be loaded");
    return { sessions: result.sessions ?? [], hasMore: false };
  }
  const result = await window.sessionsAPI.listWithOptions({
    ...(includeWorkflowRuns ? { includeWorkflowRuns: true } : {}),
    limit: SESSION_PAGE_SIZE,
    beforeSessionId,
  });
  if (!result.success) throw new Error(result.error ?? "Sessions could not be loaded");
  return {
    sessions: result.sessions ?? [],
    hasMore: result.hasMore ?? false,
    nextCursor: result.nextCursor,
    selectedSession: result.selectedSession,
  };
}

function mergeSessionPages(data: SessionPages | undefined): SessionMetadata[] {
  if (!data) return [];
  const byId = new Map<string, SessionMetadata>();
  for (const page of data.pages) {
    for (const session of page.sessions) byId.set(session.id, session);
    if (page.selectedSession) byId.set(page.selectedSession.id, page.selectedSession);
  }
  return [...byId.values()].sort((a, b) => {
    const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return bTime - aTime;
  });
}

function applyMetadataChanges<T extends SessionMetadata>(
  session: T,
  sessionId: string,
  changes: Partial<SessionMetadata>,
): T {
  return session.id === sessionId ? { ...session, ...changes, id: session.id } : session;
}

function findSessionInPages(
  pages: SessionPages | undefined,
  sessionId: string,
): SessionMetadata | undefined {
  if (!pages) return undefined;
  for (const page of pages.pages) {
    const session = page.sessions.find((candidate) => candidate.id === sessionId);
    if (session) return session;
    if (page.selectedSession?.id === sessionId) return page.selectedSession;
  }
  return undefined;
}

function matchesFilter(
  session: SessionMetadata,
  filter: SessionListFilter,
  includeWorkflowRuns: boolean,
): boolean {
  if (session.source === "workflow-run" && !includeWorkflowRuns) {
    return false;
  }
  if (filter === "all") return true;
  if (filter === "subagents") return session.source === "subagent";
  if (filter === "workflow-agents") return session.source === "workflow-agent";
  return session.source !== "subagent" && session.source !== "workflow-agent";
}

/** Wire once at app boot — subscriptions live outside React so events
 *  fired while a panel is unmounted still update the cache. */
export function wireSessionsApi(qc: QueryClient): () => void {
  const unsubListChanged =
    window.sessionsAPI?.onListChanged?.(() => {
      void qc.invalidateQueries({ queryKey: ["sessions"] });
    }) ?? (() => {});

  const unsubMetadataChanged =
    window.sessionsAPI?.onMetadataChanged?.((sessionId, changes) => {
      if (!changes) {
        void qc.invalidateQueries({ queryKey: ["sessions"] });
        return;
      }
      for (const [queryKey, previous] of qc.getQueriesData<SessionPages>({
        queryKey: ["sessions", "list"],
      })) {
        const current = findSessionInPages(previous, sessionId);
        const orderingChanged =
          changes.updatedAt !== undefined && changes.updatedAt !== current?.updatedAt;
        if (!current || orderingChanged || qc.isFetching({ queryKey, exact: true }) > 0) {
          void qc.invalidateQueries({ queryKey, exact: true });
          continue;
        }
        startTransition(() => {
          qc.setQueryData<SessionPages>(queryKey, (cached) => {
            if (!cached) return cached;
            return {
              ...cached,
              pages: cached.pages.map((page) => ({
                ...page,
                sessions: page.sessions.map((session) =>
                  applyMetadataChanges(session, sessionId, changes),
                ),
                selectedSession: page.selectedSession
                  ? applyMetadataChanges(page.selectedSession, sessionId, changes)
                  : undefined,
              })),
            };
          });
        });
      }

      for (const [queryKey, previous] of qc.getQueriesData<SessionSearchResult[] | null>({
        queryKey: ["sessions", "search"],
      })) {
        const current = previous?.find((session) => session.id === sessionId);
        const membershipOrOrderingChanged =
          changes.name !== undefined || changes.updatedAt !== undefined;
        if (
          !current ||
          membershipOrOrderingChanged ||
          qc.isFetching({ queryKey, exact: true }) > 0
        ) {
          void qc.invalidateQueries({ queryKey, exact: true });
          continue;
        }
        startTransition(() => {
          qc.setQueryData<SessionSearchResult[] | null>(
            queryKey,
            (cached) =>
              cached?.map((session) => applyMetadataChanges(session, sessionId, changes)) ?? cached,
          );
        });
      }
    }) ?? (() => {});

  let statusEpoch: string | null = null;
  let statusSequence = 0;
  const unsubStatusDelta =
    window.sessionsAPI?.onStatusDelta?.((batch) => {
      if (statusEpoch !== batch.epoch) {
        statusEpoch = batch.epoch;
        statusSequence = 0;
      }
      if (batch.sequence !== statusSequence + 1) {
        statusSequence = batch.sequence;
        void qc.invalidateQueries({ queryKey: ["sessions"] });
        return;
      }
      statusSequence = batch.sequence;
      const byId = new Map(batch.sessions.map((delta) => [delta.sessionId, delta]));
      startTransition(() => {
        qc.setQueriesData<SessionPages>({ queryKey: ["sessions", "list"] }, (previous) => {
          if (!previous) return previous;
          return {
            ...previous,
            pages: previous.pages.map((page) => ({
              ...page,
              sessions: page.sessions.map((session) => {
                const delta = byId.get(session.id);
                if (!delta) return session;
                const isBusy = delta.status === "submitted" || delta.status === "streaming";
                return session.isBusy === isBusy ? session : { ...session, isBusy };
              }),
              selectedSession: page.selectedSession
                ? (() => {
                    const delta = byId.get(page.selectedSession.id);
                    if (!delta) return page.selectedSession;
                    const isBusy = delta.status === "submitted" || delta.status === "streaming";
                    return page.selectedSession.isBusy === isBusy
                      ? page.selectedSession
                      : { ...page.selectedSession, isBusy };
                  })()
                : undefined,
            })),
          };
        });
      });
    }) ?? (() => {});

  return () => {
    unsubListChanged();
    unsubMetadataChanged();
    unsubStatusDelta();
  };
}

/**
 * Owns the full sessions list and search state.
 * Refetches from the server whenever the backend emits list-change events
 * (wired at boot via `wireSessionsApi`), eliminating the need to manually
 * filter local state after mutations.
 */
export function useSessions(options: UseSessionsOptions = {}): UseSessionsReturn {
  const queryClient = useQueryClient();
  const includeWorkflowRuns = options.includeWorkflowRuns ?? false;
  const sessionListQueryKey = useMemo(
    () =>
      includeWorkflowRuns
        ? (["sessions", "list", "workflow-runs"] as const)
        : (["sessions", "list"] as const),
    [includeWorkflowRuns],
  );
  const [filter, setFilter] = useState<SessionListFilter>("chats");

  const {
    data: sessionPages,
    fetchNextPage,
    hasNextPage,
    isPending,
    isError,
    error,
    isFetchingNextPage,
    isFetchNextPageError,
  } = useInfiniteQuery({
    queryKey: sessionListQueryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => listSessionsPage(pageParam, includeWorkflowRuns),
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
  });
  const sessions = useMemo(() => mergeSessionPages(sessionPages), [sessionPages]);

  // --- Search ---

  const [searchQueryRaw, setSearchQueryRaw] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  // useDeferredValue covers render transitions; IPC remains gated by the
  // 300ms debounce so keystrokes don't hammer the disk.
  const deferredQuery = useDeferredValue(searchQueryRaw);

  // Debounce the raw query into debouncedQuery
  useEffect(() => {
    if (!searchQueryRaw.trim()) {
      // eslint-disable-next-line react-compiler/set-state-in-effect -- resetting derived search state, no external system involved
      setDebouncedQuery("");
      return undefined;
    }
    const timer = setTimeout(() => setDebouncedQuery(searchQueryRaw.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchQueryRaw]);

  const { data: searchResults, isFetching: isFetchingSearch } = useQuery<
    SessionSearchResult[] | null
  >({
    queryKey: ["sessions", "search", debouncedQuery],
    queryFn: async () => {
      if (!window.sessionsAPI || !debouncedQuery) return null;
      try {
        const result = window.sessionsAPI.listWithOptions
          ? await window.sessionsAPI.listWithOptions({ query: debouncedQuery })
          : await window.sessionsAPI.list(debouncedQuery);
        return result.success && result.results ? result.results : [];
      } catch {
        return [];
      }
    },
    enabled: !!debouncedQuery,
  });
  const normalizedSearchQuery = searchQueryRaw.trim();
  const isSearchStale =
    searchQueryRaw !== deferredQuery ||
    (normalizedSearchQuery.length > 0 &&
      (normalizedSearchQuery !== debouncedQuery || isFetchingSearch));

  // Wrap setSearchQueryRaw so clearing the query also atomically clears stale results,
  // preventing a flash of old search results between the clear and the next refetch.
  const setSearchQuery = useCallback(
    (q: string) => {
      setSearchQueryRaw(q);
      if (!q.trim()) {
        setDebouncedQuery("");
        queryClient.setQueryData(["sessions", "search", ""], null);
      }
    },
    [queryClient],
  );

  // --- Derived data ---

  const filteredSessions = useMemo(() => {
    return sessions.filter((session) => matchesFilter(session, filter, includeWorkflowRuns));
  }, [sessions, filter, includeWorkflowRuns]);

  const displaySessions: DisplaySession[] = useMemo(() => {
    if (!normalizedSearchQuery) return filteredSessions;
    if (normalizedSearchQuery !== debouncedQuery || !searchResults) return [];
    return searchResults.filter((session) => matchesFilter(session, filter, includeWorkflowRuns));
  }, [
    normalizedSearchQuery,
    debouncedQuery,
    searchResults,
    filteredSessions,
    filter,
    includeWorkflowRuns,
  ]);

  // Backend pages mix chats and agents. Advance until the
  // active filter has a complete visible page, or the backend is exhausted.
  useEffect(() => {
    if (
      searchQueryRaw.trim() ||
      isPending ||
      isFetchingNextPage ||
      !hasNextPage ||
      filteredSessions.length >= SESSION_PAGE_SIZE
    ) {
      return;
    }
    void fetchNextPage();
  }, [
    fetchNextPage,
    filteredSessions.length,
    hasNextPage,
    isFetchingNextPage,
    isPending,
    searchQueryRaw,
  ]);

  // --- Mutations ---

  const optimisticRemove = useCallback(
    (sessionId: string) => {
      queryClient.setQueryData<SessionPages>(sessionListQueryKey, (previous) =>
        previous
          ? {
              ...previous,
              pages: previous.pages.map((page) => ({
                ...page,
                sessions: page.sessions.filter((session) => session.id !== sessionId),
                selectedSession:
                  page.selectedSession?.id === sessionId ? undefined : page.selectedSession,
              })),
            }
          : previous,
      );
      // Also remove from active search results if a search is in progress
      if (debouncedQuery) {
        queryClient.setQueryData<SessionSearchResult[] | null>(
          ["sessions", "search", debouncedQuery],
          (prev) => (prev ? prev.filter((r) => r.id !== sessionId) : prev),
        );
      }
    },
    [queryClient, debouncedQuery, sessionListQueryKey],
  );

  const refetch = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["sessions"] });
  }, [queryClient]);

  const loadMore = useCallback(async () => {
    if (searchQueryRaw.trim() || !hasNextPage || isFetchingNextPage) return;
    await fetchNextPage();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, searchQueryRaw]);

  return {
    sessions,
    displaySessions,
    searchQuery: searchQueryRaw,
    setSearchQuery,
    filter,
    setFilter,
    isSearchStale,
    isLoading: isPending,
    isError,
    errorMessage: error instanceof Error ? error.message : undefined,
    hasNextPage: !searchQueryRaw.trim() && hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    loadMore,
    refetch,
    optimisticRemove,
  };
}
