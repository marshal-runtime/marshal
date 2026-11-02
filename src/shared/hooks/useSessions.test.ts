import { InfiniteQueryObserver, QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { renderHook, waitFor, act, installMockAPIs } from "@/test-utils";
import type {
  SessionListPage,
  SessionMetadata,
  SessionSearchResult,
  SessionsAPI,
} from "@/types/electron";

import { SESSION_PAGE_SIZE, useSessions, wireSessionsApi } from "./useSessions";

const SESSION_A = {
  id: "a",
  name: "Session A",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
  hasUnread: false,
  isActive: false,
};

const SESSION_B = {
  id: "b",
  name: "Session B",
  createdAt: "2024-01-02T00:00:00Z",
  updatedAt: "2024-01-02T00:00:00Z",
  hasUnread: false,
  isActive: true,
};

function mockSessionList(listMock: SessionsAPI["list"]) {
  window.sessionsAPI.list = listMock;
  window.sessionsAPI.listWithOptions = vi.fn<SessionsAPI["listWithOptions"]>((options) =>
    listMock(options?.query),
  );
}

function searchResult(session: SessionMetadata, snippets: string[]) {
  return { ...session, snippets };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("useSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMockAPIs();
  });

  it("fetches sessions on mount", async () => {
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [SESSION_A, SESSION_B],
      }),
    );

    const { result } = renderHook(() => useSessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(2);
    });
    expect(result.current.sessions[0].id).toBe("b");
  });

  it("requests a bounded first page", async () => {
    const sessions = Array.from({ length: SESSION_PAGE_SIZE }, (_, index) => ({
      ...SESSION_A,
      id: `session-${index}`,
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, SESSION_PAGE_SIZE - index)).toISOString(),
    }));
    window.sessionsAPI.listWithOptions = vi.fn<SessionsAPI["listWithOptions"]>().mockResolvedValue({
      success: true,
      sessions,
      hasMore: true,
      nextCursor: sessions.at(-1)?.id,
    });

    const { result } = renderHook(() => useSessions());

    await waitFor(() => expect(result.current.sessions).toHaveLength(SESSION_PAGE_SIZE));
    expect(window.sessionsAPI.listWithOptions).toHaveBeenCalledWith({
      limit: SESSION_PAGE_SIZE,
      beforeSessionId: undefined,
    });
    expect(result.current.hasNextPage).toBe(true);
  });

  it("keeps existing workspace-classified chats visible", async () => {
    const workspaceSession = {
      ...SESSION_A,
      id: "workspace-chat",
      source: "workspace" as const,
      workspaceName: "Project",
    };
    window.sessionsAPI.listWithOptions = vi
      .fn<SessionsAPI["listWithOptions"]>()
      .mockResolvedValue({ success: true, sessions: [workspaceSession], hasMore: false });

    const { result } = renderHook(() => useSessions());

    await waitFor(() => expect(result.current.displaySessions).toEqual([workspaceSession]));
  });

  it("keeps paging until the active filter has a full visible page", async () => {
    const makeSession = (id: string, source?: SessionMetadata["source"]) => ({
      ...SESSION_A,
      id,
      name: id,
      source,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const firstPage = Array.from({ length: 40 }, (_, index) =>
      index < 9 ? makeSession(`chat-${index}`) : makeSession(`agent-${index - 9}`, "subagent"),
    );
    const secondPage = Array.from({ length: 40 }, (_, index) =>
      index < 15
        ? makeSession(`chat-${index + 9}`)
        : makeSession(`workflow-agent-${index - 15}`, "workflow-agent"),
    );
    const thirdPage = Array.from({ length: 15 }, (_, index) => makeSession(`chat-${index + 24}`));
    const selectedSession = makeSession("selected-chat");
    const listWithOptions = vi
      .fn<SessionsAPI["listWithOptions"]>()
      .mockResolvedValueOnce({
        success: true,
        sessions: firstPage,
        selectedSession,
        hasMore: true,
        nextCursor: firstPage.at(-1)?.id,
      })
      .mockResolvedValueOnce({
        success: true,
        sessions: secondPage,
        hasMore: true,
        nextCursor: secondPage.at(-1)?.id,
      })
      .mockResolvedValueOnce({
        success: true,
        sessions: thirdPage,
        hasMore: false,
      });
    window.sessionsAPI.listWithOptions = listWithOptions;

    const { result } = renderHook(() => useSessions());

    await waitFor(() => expect(listWithOptions).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(result.current.displaySessions).toHaveLength(40));
    expect(listWithOptions.mock.calls.map(([options]) => options?.beforeSessionId)).toEqual([
      undefined,
      firstPage.at(-1)?.id,
      secondPage.at(-1)?.id,
    ]);
    expect(result.current.hasNextPage).toBe(false);
  });

  it("loads incremental pages with deduplication and newest-first ordering", async () => {
    const firstPage = Array.from({ length: SESSION_PAGE_SIZE }, (_, index) => ({
      ...SESSION_A,
      id: `session-${index}`,
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, SESSION_PAGE_SIZE - index)).toISOString(),
    }));
    const older = {
      ...SESSION_A,
      id: "session-older",
      updatedAt: "2025-12-31T23:59:00.000Z",
    };
    window.sessionsAPI.listWithOptions = vi
      .fn<SessionsAPI["listWithOptions"]>()
      .mockResolvedValueOnce({
        success: true,
        sessions: firstPage,
        hasMore: true,
        nextCursor: firstPage.at(-1)?.id,
      })
      .mockResolvedValueOnce({
        success: true,
        sessions: [firstPage.at(-1)!, older],
        hasMore: false,
      });

    const { result } = renderHook(() => useSessions());
    await waitFor(() => expect(result.current.sessions).toHaveLength(SESSION_PAGE_SIZE));

    await act(async () => {
      await result.current.loadMore();
    });

    await waitFor(() => expect(result.current.sessions).toHaveLength(SESSION_PAGE_SIZE + 1));
    expect(result.current.sessions.at(-1)?.id).toBe("session-older");
    expect(new Set(result.current.sessions.map((session) => session.id)).size).toBe(
      SESSION_PAGE_SIZE + 1,
    );
  });

  it("keeps the selected session visible when it is outside the first page", async () => {
    window.sessionsAPI.listWithOptions = vi.fn<SessionsAPI["listWithOptions"]>().mockResolvedValue({
      success: true,
      sessions: [SESSION_B],
      selectedSession: SESSION_A,
      hasMore: false,
    });

    const { result } = renderHook(() => useSessions());

    await waitFor(() =>
      expect(result.current.sessions.map((session) => session.id)).toEqual(["b", "a"]),
    );
  });

  // NOTE: The "refetches when onListChanged fires" test was removed because
  // onListChanged subscription moved from the hook body to wireSessionsApi
  // (boot-time wiring). The behavior is covered by the wireSessionsApi tests below.

  it("refetch() re-loads sessions from server", async () => {
    const listMock2 = vi.fn<SessionsAPI["list"]>();
    listMock2.mockResolvedValueOnce({ success: true, sessions: [SESSION_A] });
    listMock2.mockResolvedValueOnce({ success: true, sessions: [SESSION_A, SESSION_B] });
    mockSessionList(listMock2);

    const { result } = renderHook(() => useSessions());

    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => expect(result.current.sessions).toHaveLength(2));
  });

  it("returns search results merged with session metadata", async () => {
    const listMock3 = vi.fn<SessionsAPI["list"]>();
    listMock3.mockResolvedValueOnce({ success: true, sessions: [SESSION_A, SESSION_B] });
    listMock3.mockResolvedValue({
      success: true,
      results: [searchResult(SESSION_A, ["hello"])],
    });
    mockSessionList(listMock3);

    const { result } = renderHook(() => useSessions());

    await waitFor(() => expect(result.current.sessions).toHaveLength(2));

    act(() => {
      result.current.setSearchQuery("hello");
    });
    expect(result.current.displaySessions).toHaveLength(0);
    expect(result.current.isSearchStale).toBe(true);

    await waitFor(() => {
      expect(result.current.displaySessions).toHaveLength(1);
    });
    expect(result.current.isSearchStale).toBe(false);
    expect(result.current.displaySessions[0].snippets).toEqual(["hello"]);
    expect(result.current.displaySessions[0].hasUnread).toBe(SESSION_A.hasUnread);
  });

  it("hides stale matches while a replacement query is debouncing", async () => {
    const listMock = vi.fn<SessionsAPI["list"]>().mockImplementation(async (query) => {
      if (!query) return { success: true, sessions: [SESSION_A, SESSION_B] };
      return {
        success: true,
        results:
          query === "python"
            ? [searchResult(SESSION_A, ["python"])]
            : [searchResult(SESSION_B, ["api"])],
      };
    });
    mockSessionList(listMock);

    const { result } = renderHook(() => useSessions());
    await waitFor(() => expect(result.current.sessions).toHaveLength(2));

    act(() => result.current.setSearchQuery("python"));
    await waitFor(() => expect(result.current.displaySessions[0]?.id).toBe("a"));

    act(() => result.current.setSearchQuery("api"));
    expect(result.current.displaySessions).toHaveLength(0);
    expect(result.current.isSearchStale).toBe(true);

    await waitFor(() => expect(result.current.displaySessions[0]?.id).toBe("b"));
    expect(result.current.isSearchStale).toBe(false);
  });

  it("shows search matches that are not present in loaded pages", async () => {
    const listMock = vi.fn<SessionsAPI["list"]>();
    listMock.mockResolvedValueOnce({ success: true, sessions: [SESSION_A] });
    listMock.mockResolvedValue({
      success: true,
      results: [searchResult({ ...SESSION_B, source: "subagent" }, ["unloaded"])],
    });
    mockSessionList(listMock);

    const { result } = renderHook(() => useSessions());
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    act(() => {
      result.current.setFilter("subagents");
      result.current.setSearchQuery("unloaded");
    });

    await waitFor(() => expect(result.current.displaySessions[0]?.id).toBe("b"));
  });

  it("displaySessions returns full list when search is empty", async () => {
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [SESSION_A, SESSION_B],
      }),
    );

    const { result } = renderHook(() => useSessions());

    await waitFor(() => expect(result.current.displaySessions).toHaveLength(2));
    expect(result.current.displaySessions[0].snippets).toBeUndefined();
  });

  it("includes workflow-run hosts only for sidebar callers that opt in", async () => {
    const workflowHost = {
      id: "workflow-host",
      name: "Workflow: Power Query",
      createdAt: "2024-01-03T00:00:00Z",
      updatedAt: "2024-01-03T00:00:00Z",
      hasUnread: false,
      isActive: false,
      source: "workflow-run" as const,
    };
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [SESSION_A, workflowHost, { ...SESSION_B, source: "subagent" as const }],
      }),
    );

    const { result: defaultResult, unmount: unmountDefault } = renderHook(() => useSessions());

    await waitFor(() => expect(defaultResult.current.sessions).toHaveLength(3));
    expect(defaultResult.current.displaySessions.map((session) => session.id)).toEqual(["a"]);
    unmountDefault();

    const { result: sidebarResult } = renderHook(() => useSessions({ includeWorkflowRuns: true }));
    await waitFor(() =>
      expect(sidebarResult.current.displaySessions.map((session) => session.id)).toEqual([
        "workflow-host",
        "a",
      ]),
    );
    act(() => sidebarResult.current.setFilter("all"));
    expect(sidebarResult.current.displaySessions.map((session) => session.id)).toEqual([
      "workflow-host",
      "b",
      "a",
    ]);
    expect(window.sessionsAPI.listWithOptions).toHaveBeenCalledWith(
      expect.objectContaining({ includeWorkflowRuns: true }),
    );
  });

  it("clears search results when query is emptied", async () => {
    const listMock4 = vi.fn<SessionsAPI["list"]>();
    listMock4.mockResolvedValueOnce({ success: true, sessions: [SESSION_A, SESSION_B] });
    listMock4.mockResolvedValue({
      success: true,
      results: [searchResult(SESSION_A, [])],
    });
    mockSessionList(listMock4);

    const { result } = renderHook(() => useSessions());
    await waitFor(() => expect(result.current.sessions).toHaveLength(2));

    act(() => result.current.setSearchQuery("hello"));
    await waitFor(() => expect(result.current.displaySessions).toHaveLength(1));

    act(() => result.current.setSearchQuery(""));
    await waitFor(() => expect(result.current.displaySessions).toHaveLength(2));
  });

  it("handles search API failure gracefully", async () => {
    const listMock5 = vi.fn<SessionsAPI["list"]>();
    listMock5.mockResolvedValueOnce({ success: true, sessions: [SESSION_A] });
    listMock5.mockRejectedValue(new Error("IPC error"));
    mockSessionList(listMock5);

    const { result } = renderHook(() => useSessions());
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    act(() => result.current.setSearchQuery("crash"));

    await waitFor(() => {
      expect(result.current.displaySessions).toHaveLength(0);
    });
  });

  it("optimisticRemove removes session from both sessions and search results", async () => {
    const listMock6 = vi.fn<SessionsAPI["list"]>();
    listMock6.mockResolvedValueOnce({ success: true, sessions: [SESSION_A, SESSION_B] });
    listMock6.mockResolvedValue({
      success: true,
      results: [searchResult(SESSION_A, ["match"]), searchResult(SESSION_B, ["match"])],
    });
    mockSessionList(listMock6);

    const { result } = renderHook(() => useSessions());
    await waitFor(() => expect(result.current.sessions).toHaveLength(2));

    act(() => result.current.setSearchQuery("match"));
    await waitFor(() => expect(result.current.displaySessions).toHaveLength(2));

    act(() => result.current.optimisticRemove("a"));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
      expect(result.current.sessions[0].id).toBe("b");
      expect(result.current.displaySessions).toHaveLength(1);
      expect(result.current.displaySessions[0].id).toBe("b");
    });
  });

  it("optimisticRemove works when no search is active", async () => {
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [SESSION_A, SESSION_B],
      }),
    );

    const { result } = renderHook(() => useSessions());
    await waitFor(() => expect(result.current.sessions).toHaveLength(2));

    act(() => result.current.optimisticRemove("a"));

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
      expect(result.current.displaySessions).toHaveLength(1);
    });
  });
});

describe("wireSessionsApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMockAPIs();
  });

  it("subscribes to list, metadata, and compact status events", () => {
    const onListChanged = vi.fn<SessionsAPI["onListChanged"]>().mockReturnValue(() => {});
    const onMetadataChanged = vi.fn<SessionsAPI["onMetadataChanged"]>().mockReturnValue(() => {});
    window.sessionsAPI.onListChanged = onListChanged;
    window.sessionsAPI.onMetadataChanged = onMetadataChanged;

    const qc = new QueryClient();
    wireSessionsApi(qc);

    expect(onListChanged).toHaveBeenCalledTimes(1);
    expect(onMetadataChanged).toHaveBeenCalledTimes(1);
    expect(window.sessionsAPI.onStatusDelta).toHaveBeenCalledTimes(1);
  });

  it("cleanup unsubscribes all listeners", () => {
    const unsubList = vi.fn<() => void>();
    const unsubMeta = vi.fn<() => void>();
    const unsubStatus = vi.fn<() => void>();
    window.sessionsAPI.onListChanged = vi
      .fn<SessionsAPI["onListChanged"]>()
      .mockReturnValue(unsubList);
    window.sessionsAPI.onMetadataChanged = vi
      .fn<SessionsAPI["onMetadataChanged"]>()
      .mockReturnValue(unsubMeta);
    window.sessionsAPI.onStatusDelta = vi
      .fn<SessionsAPI["onStatusDelta"]>()
      .mockReturnValue(unsubStatus);

    const qc = new QueryClient();
    const cleanup = wireSessionsApi(qc);
    cleanup();

    expect(unsubList).toHaveBeenCalledTimes(1);
    expect(unsubMeta).toHaveBeenCalledTimes(1);
    expect(unsubStatus).toHaveBeenCalledTimes(1);
  });

  it("invalidates sessions query when onListChanged fires", () => {
    let listChangedCb: (() => void) | undefined;
    window.sessionsAPI.onListChanged = vi
      .fn<SessionsAPI["onListChanged"]>()
      .mockImplementation((cb) => {
        listChangedCb = cb;
        return () => {};
      });
    window.sessionsAPI.onMetadataChanged = vi
      .fn<SessionsAPI["onMetadataChanged"]>()
      .mockReturnValue(() => {});

    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    wireSessionsApi(qc);

    listChangedCb?.();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["sessions"] });
  });

  it("invalidates sessions query for legacy ID-only metadata events", () => {
    let metaChangedCb: Parameters<SessionsAPI["onMetadataChanged"]>[0] | undefined;
    window.sessionsAPI.onListChanged = vi
      .fn<SessionsAPI["onListChanged"]>()
      .mockReturnValue(() => {});
    window.sessionsAPI.onMetadataChanged = vi
      .fn<SessionsAPI["onMetadataChanged"]>()
      .mockImplementation((cb) => {
        metaChangedCb = cb;
        return () => {};
      });

    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    wireSessionsApi(qc);

    metaChangedCb?.("some-session-id");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["sessions"] });
  });

  it("merges safe metadata deltas into loaded list and search rows without refetching", () => {
    let metaChangedCb: Parameters<SessionsAPI["onMetadataChanged"]>[0] | undefined;
    window.sessionsAPI.onMetadataChanged = vi
      .fn<SessionsAPI["onMetadataChanged"]>()
      .mockImplementation((callback) => {
        metaChangedCb = callback;
        return () => {};
      });
    const qc = new QueryClient();
    qc.setQueryData<{
      pages: SessionListPage[];
      pageParams: Array<string | undefined>;
    }>(["sessions", "list"], {
      pages: [{ sessions: [SESSION_A, SESSION_B], hasMore: false }],
      pageParams: [undefined],
    });
    qc.setQueryData(["sessions", "search", "session"], [{ ...SESSION_A, snippets: ["match"] }]);
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    wireSessionsApi(qc);

    act(() => {
      metaChangedCb?.("a", { hasUnread: true, model: "gpt-5" });
    });

    expect(
      qc.getQueryData<{ pages: SessionListPage[] }>(["sessions", "list"])?.pages[0].sessions[0],
    ).toMatchObject({ id: "a", hasUnread: true, model: "gpt-5" });
    expect(
      qc.getQueryData<SessionSearchResult[]>(["sessions", "search", "session"])?.[0],
    ).toMatchObject({
      id: "a",
      hasUnread: true,
      model: "gpt-5",
      snippets: ["match"],
    });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("refetches when an unloaded session moves into the first page of 1,005 rows", async () => {
    let metaChangedCb: Parameters<SessionsAPI["onMetadataChanged"]>[0] | undefined;
    window.sessionsAPI.onMetadataChanged = vi
      .fn<SessionsAPI["onMetadataChanged"]>()
      .mockImplementation((callback) => {
        metaChangedCb = callback;
        return () => {};
      });
    let sessions = Array.from({ length: 1_005 }, (_, index) => ({
      ...SESSION_A,
      id: `session-${index}`,
      name: `Session ${index}`,
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 20, 1_005 - index)).toISOString(),
    }));
    const listWithOptions = vi.fn<SessionsAPI["listWithOptions"]>(async (options) => {
      const sorted = [...sessions].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
      const cursorIndex = options?.beforeSessionId
        ? sorted.findIndex((session) => session.id === options.beforeSessionId)
        : -1;
      const start = cursorIndex + 1;
      const limit = options?.limit ?? SESSION_PAGE_SIZE;
      const page = sorted.slice(start, start + limit);
      return {
        success: true,
        sessions: page,
        hasMore: start + limit < sorted.length,
        nextCursor: start + limit < sorted.length ? page.at(-1)?.id : undefined,
      };
    });
    window.sessionsAPI.listWithOptions = listWithOptions;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new InfiniteQueryObserver(qc, {
      queryKey: ["sessions", "list"],
      initialPageParam: undefined as string | undefined,
      queryFn: async ({ pageParam }) => {
        const result = await listWithOptions({
          excludeSources: ["workspace"],
          limit: SESSION_PAGE_SIZE,
          beforeSessionId: pageParam,
        });
        return {
          sessions: result.sessions ?? [],
          hasMore: result.hasMore ?? false,
          nextCursor: result.nextCursor,
          selectedSession: result.selectedSession,
        };
      },
      getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
    });
    const unsubscribeObserver = observer.subscribe(() => {});
    const cleanup = wireSessionsApi(qc);
    try {
      await observer.refetch();
      expect(observer.getCurrentResult().data?.pages[0].sessions[0].id).toBe("session-0");
      sessions = sessions.map((session) =>
        session.id === "session-1004"
          ? {
              ...session,
              name: "Promoted session",
              updatedAt: "2026-08-01T02:00:00.000Z",
              model: "gpt-5",
            }
          : session,
      );

      act(() => {
        metaChangedCb?.("session-1004", {
          name: "Promoted session",
          updatedAt: "2026-08-01T02:00:00.000Z",
          model: "gpt-5",
        });
      });

      await waitFor(() => expect(listWithOptions).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(observer.getCurrentResult().data?.pages[0].sessions[0]).toMatchObject({
          id: "session-1004",
          name: "Promoted session",
          model: "gpt-5",
        }),
      );
    } finally {
      cleanup();
      unsubscribeObserver();
    }
  });

  it("invalidates an in-flight list fetch so an older response cannot overwrite a delta", async () => {
    let metaChangedCb: Parameters<SessionsAPI["onMetadataChanged"]>[0] | undefined;
    window.sessionsAPI.onMetadataChanged = vi
      .fn<SessionsAPI["onMetadataChanged"]>()
      .mockImplementation((callback) => {
        metaChangedCb = callback;
        return () => {};
      });
    const stale = deferred<{
      success: true;
      sessions: SessionMetadata[];
      hasMore: false;
    }>();
    const listWithOptions = vi
      .fn<SessionsAPI["listWithOptions"]>()
      .mockResolvedValueOnce({ success: true, sessions: [SESSION_A], hasMore: false })
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValue({
        success: true,
        sessions: [{ ...SESSION_A, name: "Newest name" }],
        hasMore: false,
      });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new InfiniteQueryObserver(qc, {
      queryKey: ["sessions", "list"],
      initialPageParam: undefined as string | undefined,
      queryFn: async ({ pageParam }) => {
        const result = await listWithOptions({
          limit: SESSION_PAGE_SIZE,
          beforeSessionId: pageParam,
        });
        return {
          sessions: result.sessions ?? [],
          hasMore: result.hasMore ?? false,
          nextCursor: result.nextCursor,
        };
      },
      getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
    });
    const unsubscribeObserver = observer.subscribe(() => {});
    const cleanup = wireSessionsApi(qc);
    try {
      await observer.refetch();
      const inFlight = observer.refetch();
      await waitFor(() => expect(listWithOptions).toHaveBeenCalledTimes(2));

      act(() => {
        metaChangedCb?.("a", { name: "Newest name" });
      });
      stale.resolve({ success: true, sessions: [SESSION_A], hasMore: false });
      await inFlight;

      await waitFor(() => expect(listWithOptions).toHaveBeenCalledTimes(3));
      await waitFor(() =>
        expect(observer.getCurrentResult().data?.pages[0].sessions[0].name).toBe("Newest name"),
      );
    } finally {
      cleanup();
      unsubscribeObserver();
    }
  });

  it("refetches an active search when a renamed unloaded row can enter membership", async () => {
    let metaChangedCb: Parameters<SessionsAPI["onMetadataChanged"]>[0] | undefined;
    window.sessionsAPI.onMetadataChanged = vi
      .fn<SessionsAPI["onMetadataChanged"]>()
      .mockImplementation((callback) => {
        metaChangedCb = callback;
        return () => {};
      });
    let searchResults: SessionSearchResult[] = [];
    const search = vi.fn<() => Promise<SessionSearchResult[]>>(async () => searchResults);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new QueryObserver(qc, {
      queryKey: ["sessions", "search", "needle"],
      queryFn: search,
    });
    const unsubscribeObserver = observer.subscribe(() => {});
    const cleanup = wireSessionsApi(qc);
    try {
      await observer.refetch();
      expect(observer.getCurrentResult().data).toEqual([]);
      searchResults = [
        {
          ...SESSION_A,
          id: "renamed",
          name: "Needle match",
          snippets: ["Needle match"],
        },
      ];

      act(() => {
        metaChangedCb?.("renamed", {
          name: "Needle match",
          updatedAt: "2026-08-01T02:00:00.000Z",
        });
      });

      await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(observer.getCurrentResult().data?.[0]).toMatchObject({
          id: "renamed",
          name: "Needle match",
        }),
      );
    } finally {
      cleanup();
      unsubscribeObserver();
    }
  });

  it("merges compact background busy status without refetching the list", () => {
    let statusChanged: Parameters<SessionsAPI["onStatusDelta"]>[0] | undefined;
    window.sessionsAPI.onStatusDelta = vi
      .fn<SessionsAPI["onStatusDelta"]>()
      .mockImplementation((callback) => {
        statusChanged = callback;
        return () => {};
      });
    const qc = new QueryClient();
    qc.setQueryData<{
      pages: SessionListPage[];
      pageParams: Array<string | undefined>;
    }>(["sessions", "list"], {
      pages: [{ sessions: [SESSION_A, SESSION_B], hasMore: false }],
      pageParams: [undefined],
    });
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    wireSessionsApi(qc);

    act(() => {
      statusChanged?.({
        epoch: "runtime-1",
        sequence: 1,
        sessions: [{ sessionId: "a", status: "streaming", sessionStatus: null, hasError: false }],
      });
    });

    expect(
      qc.getQueryData<{ pages: SessionListPage[] }>(["sessions", "list"])?.pages[0].sessions[0]
        .isBusy,
    ).toBe(true);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("invalidates the session list when a compact status sequence has a gap", () => {
    let statusChanged: Parameters<SessionsAPI["onStatusDelta"]>[0] | undefined;
    window.sessionsAPI.onStatusDelta = vi
      .fn<SessionsAPI["onStatusDelta"]>()
      .mockImplementation((callback) => {
        statusChanged = callback;
        return () => {};
      });
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    wireSessionsApi(qc);

    statusChanged?.({ epoch: "runtime-1", sequence: 2, sessions: [] });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["sessions"] });
  });
});
