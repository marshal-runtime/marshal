import { DEFAULT_SESSION_VIEW } from "@common/marshal-ipc-contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, renderHook, screen, waitFor, act } from "@testing-library/react";
import { createElement, Fragment, useRef, type ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { installMockAPIs } from "@/test-utils";
import type { SessionMessage, SessionView, SessionViewDelivery } from "@/types/electron";

import { setTranscriptHeld } from "../state/messageWindow";
import type { SessionData } from "../types";
import { useLiveSessionView, useSessionView, useSessionViewControls } from "./useSessionView";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let queryClient: QueryClient;

function createWrapper() {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

function makeView(overrides: Partial<SessionView> = {}): SessionView {
  return { ...DEFAULT_SESSION_VIEW, ...overrides };
}

function makeMessage(id: string, overrides: Partial<SessionMessage> = {}): SessionMessage {
  return {
    id,
    role: "assistant",
    content: `Message ${id}`,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Capture the callback registered via `onViewEvent` and return a fire() helper
 * to simulate incoming IPC events.
 */
function captureViewEventCallback() {
  const onViewEvent = vi.mocked(window.sessionsAPI.onViewEvent);
  const cb = onViewEvent.mock.calls.at(-1)?.[0] as
    | ((event: SessionViewDelivery) => void)
    | undefined;
  if (!cb) throw new Error("onViewEvent was not called — is the hook mounted?");
  let sequence = 0;
  return {
    fire(
      sessionId: string,
      view: SessionView,
      committedMessages: SessionMessage[] = [],
      overrides: Partial<Pick<SessionViewDelivery, "epoch" | "sequence">> = {},
    ) {
      sequence = overrides.sequence ?? sequence + 1;
      cb({
        sessionId,
        type: "session:view",
        view,
        committedMessages,
        epoch: overrides.epoch ?? "test-runtime",
        sequence,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useSessionView", () => {
  beforeEach(() => {
    installMockAPIs();
    vi.clearAllMocks();
    vi.mocked(window.sessionsAPI.subscribeView).mockResolvedValue({
      success: true,
      snapshot: {
        sessionId: "session-1",
        epoch: "test-runtime",
        sequence: 0,
        view: DEFAULT_SESSION_VIEW,
      },
    });
  });

  it("returns DEFAULT_SESSION_VIEW when sessionId is null", () => {
    const { result } = renderHook(() => useSessionView(null), {
      wrapper: createWrapper(),
    });
    expect(result.current).toEqual(DEFAULT_SESSION_VIEW);
    expect(window.sessionsAPI.getView).not.toHaveBeenCalled();
  });

  it("uses the authoritative subscribe snapshot on mount", async () => {
    const serverView = makeView({ status: "streaming", streamingText: "hello" });
    vi.mocked(window.sessionsAPI.subscribeView).mockResolvedValue({
      success: true,
      snapshot: {
        sessionId: "session-1",
        epoch: "test-runtime",
        sequence: 0,
        view: serverView,
      },
    });

    const { result } = renderHook(() => useSessionView("session-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toEqual(serverView);
    });
    expect(window.sessionsAPI.getView).not.toHaveBeenCalled();
  });

  it("falls back to getView when subscribing does not return a snapshot", async () => {
    vi.mocked(window.sessionsAPI.subscribeView).mockResolvedValue({
      success: false,
      snapshot: undefined,
    });
    vi.mocked(window.sessionsAPI.getView).mockResolvedValue({
      success: false,
      view: undefined,
    } as ReturnType<typeof window.sessionsAPI.getView> extends Promise<infer T> ? T : never);

    const { result } = renderHook(() => useSessionView("session-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(window.sessionsAPI.getView).toHaveBeenCalledWith("session-1");
    });
    expect(result.current).toEqual(DEFAULT_SESSION_VIEW);
  });

  it("session:view events update the view in cache", async () => {
    vi.mocked(window.sessionsAPI.getView).mockResolvedValue({
      success: true,
      view: makeView({ status: "ready" }),
    });

    const { result } = renderHook(() => useSessionView("session-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.status).toBe("ready"));

    // Simulate an incoming view event
    const { fire } = captureViewEventCallback();
    const updatedView = makeView({ status: "streaming", streamingText: "thinking..." });

    act(() => {
      fire("session-1", updatedView);
    });

    await waitFor(() => {
      expect(result.current).toEqual(updatedView);
    });
    expect(window.sessionsAPI.ackView).toHaveBeenCalledWith("session-1", "test-runtime", 1);
  });

  it("keeps the composer control render count stable across 100 streaming frames", async () => {
    const initialStreamingView = makeView({ status: "streaming" });
    vi.mocked(window.sessionsAPI.getView).mockResolvedValue({
      success: true,
      view: initialStreamingView,
    });
    vi.mocked(window.sessionsAPI.subscribeView).mockResolvedValue({
      success: true,
      snapshot: {
        sessionId: "session-1",
        epoch: "test-runtime",
        sequence: 0,
        view: initialStreamingView,
      },
    });
    const counts = { composer: 0, live: 0 };

    function ComposerProbe() {
      const controls = useSessionViewControls("session-1");
      const renders = useRef(0);
      renders.current += 1;
      counts.composer = renders.current;
      return createElement("span", { "data-testid": "composer-probe" }, controls.status);
    }

    function LiveProbe() {
      const liveView = useLiveSessionView("session-1");
      const renders = useRef(0);
      renders.current += 1;
      counts.live = renders.current;
      return createElement("span", null, liveView.streamingText);
    }

    const Wrapper = createWrapper();
    render(
      createElement(
        Wrapper,
        null,
        createElement(Fragment, null, createElement(ComposerProbe), createElement(LiveProbe)),
      ),
    );
    await waitFor(() => expect(window.sessionsAPI.subscribeView).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByTestId("composer-probe")).toHaveTextContent("streaming"),
    );
    const baselineComposerRenders = counts.composer;
    const baselineLiveRenders = counts.live;
    const { fire } = captureViewEventCallback();

    await act(async () => {
      for (let frame = 1; frame <= 100; frame += 1) {
        fire("session-1", makeView({ status: "streaming", streamingText: `frame-${frame}` }));
      }
    });

    expect(await screen.findByText("frame-100")).toBeInTheDocument();

    expect(counts.composer).toBe(baselineComposerRenders);
    expect(counts.live).toBeGreaterThan(baselineLiveRenders);
    expect(window.sessionsAPI.ackView).toHaveBeenCalledTimes(100);
  });

  it("observes live view cache updates without starting another view fetch", async () => {
    const liveView = makeView({ status: "streaming", streamingText: "cached live frame" });
    const wrapper = createWrapper();
    queryClient.setQueryData(["session-view", "session-1"], liveView);

    const { result } = renderHook(() => useLiveSessionView("session-1"), { wrapper });

    expect(result.current).toEqual(liveView);
    expect(window.sessionsAPI.getView).not.toHaveBeenCalled();
    expect(window.sessionsAPI.subscribeView).not.toHaveBeenCalled();
  });

  it("resyncs the view and messages once when a delivery sequence has a gap", async () => {
    const resyncedView = makeView({ status: "streaming", streamingText: "authoritative" });
    vi.mocked(window.sessionsAPI.getView).mockResolvedValue({
      success: true,
      view: makeView(),
    });
    vi.mocked(window.sessionsAPI.resyncView).mockResolvedValue({
      success: true,
      snapshot: {
        sessionId: "session-1",
        epoch: "test-runtime",
        sequence: 2,
        view: resyncedView,
      },
    });
    const wrapper = createWrapper();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useSessionView("session-1"), { wrapper });
    await waitFor(() => expect(window.sessionsAPI.subscribeView).toHaveBeenCalled());
    const { fire } = captureViewEventCallback();

    act(() => {
      fire("session-1", makeView({ streamingText: "gap" }), [], { sequence: 2 });
    });

    await waitFor(() => expect(result.current).toEqual(resyncedView));
    expect(window.sessionsAPI.resyncView).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["session", "session-1"] });
    expect(window.sessionsAPI.ackView).not.toHaveBeenCalled();
  });

  it("committed messages from view events are pushed into session message cache", async () => {
    vi.mocked(window.sessionsAPI.getView).mockResolvedValue({
      success: true,
      view: makeView(),
    });

    const wrapper = createWrapper();

    // Seed the session cache with existing messages
    const existingMessages: SessionData["messages"] = [
      { id: "m0", content: "Hi", role: "user", timestamp: new Date() },
    ];
    queryClient.setQueryData<SessionData>(["session", "session-1"], {
      messages: existingMessages,
      isBusy: false,
      soul: undefined,
      permissionCards: [],
      turnState: null,
    });

    const { result } = renderHook(() => useSessionView("session-1"), { wrapper });

    await waitFor(() => expect(window.sessionsAPI.subscribeView).toHaveBeenCalled());

    const { fire } = captureViewEventCallback();
    const agentMessage: NonNullable<SessionMessage["agentMessage"]> = {
      messageId: "delivery-1",
      idempotencyKey: "delivery-1",
      source: "subagent-1",
      target: "session-1",
      kind: "parent",
      deliveryMode: "queue",
      priority: 10,
      sequence: 1,
      attempts: 1,
      state: "leased",
      acceptedAt: "2026-07-24T09:00:00.000Z",
      updatedAt: "2026-07-24T09:00:01.000Z",
      sourceLabel: "Research helper",
      sourceSessionSource: "subagent",
    };
    const msg = makeMessage("m1", {
      role: "user",
      content: "Hello from a subagent",
      agentMessage,
    });
    const goalTimelineEvent: NonNullable<SessionMessage["goalTimelineEvent"]> = {
      type: "goal.continuation",
      fence: {
        goalId: "goal-1",
        epoch: 1,
      },
      sequence: 2,
      verification: false,
      resumeTrigger: {
        kind: "continuation-completed",
        reason: "Continue delegated work.",
        occurredAt: "2026-07-24T09:00:00.000Z",
      },
      durableMilestone: {},
      agent: {
        sessionId: "subagent-1",
        source: "subagent",
        sourceLabel: "Research helper",
      },
    };
    const continuation = makeMessage("m2", {
      role: "user",
      content: "Internal continuation prompt",
      goalContinuation: true,
      goalTimelineEvent,
    });

    act(() => {
      fire("session-1", makeView({ status: "streaming" }), [msg, continuation]);
    });

    // Verify the session cache now contains the new message
    const sessionData = queryClient.getQueryData<SessionData>(["session", "session-1"]);
    expect(sessionData).toBeDefined();
    expect(sessionData!.messages).toHaveLength(3);
    expect(sessionData!.messages[1].content).toBe("Hello from a subagent");
    // Timestamp should be converted from string to Date
    expect(sessionData!.messages[1].timestamp).toBeInstanceOf(Date);
    expect(sessionData!.messages[1].agentMessage).toEqual(agentMessage);
    expect(sessionData!.messages[2].goalTimelineEvent).toEqual(goalTimelineEvent);
    // The view should also be updated
    await waitFor(() => {
      expect(result.current.status).toBe("streaming");
    });
  });

  it("dedupes committed messages by id against the existing cache", async () => {
    // Pin for the cross-window mirroring fix. The origin window already has the
    // user message in its cache (optimistic insert in ChatPanel.onMutate using
    // the same clientMessageId that's plumbed through copilot:send). When the
    // broadcast comes back, dedup-by-id prevents a double render.
    vi.mocked(window.sessionsAPI.getView).mockResolvedValue({
      success: true,
      view: makeView(),
    });

    const wrapper = createWrapper();

    // Seed cache as if the optimistic insert had already happened
    queryClient.setQueryData<SessionData>(["session", "session-1"], {
      messages: [
        {
          id: "shared-id",
          clientMessageId: "shared-id",
          content: "Hi",
          role: "user",
          timestamp: new Date(),
          optimistic: true,
        },
      ],
      isBusy: false,
      soul: undefined,
      permissionCards: [],
      turnState: null,
    });

    renderHook(() => useSessionView("session-1"), { wrapper });

    await waitFor(() => expect(window.sessionsAPI.subscribeView).toHaveBeenCalled());

    const { fire } = captureViewEventCallback();
    // Broadcast carries a message with the same id
    const msg = makeMessage("shared-id", { role: "user", content: "Hi" });

    act(() => {
      fire("session-1", makeView({ status: "streaming" }), [msg]);
    });

    const sessionData = queryClient.getQueryData<SessionData>(["session", "session-1"]);
    expect(sessionData!.messages).toHaveLength(1);
    expect(sessionData!.messages[0]).toMatchObject({
      id: "shared-id",
      content: "Hi",
      optimistic: false,
    });
  });

  it("applies a buffered commit already covered by the subscribe snapshot sequence", async () => {
    let resolveSubscribe!: (
      result: Awaited<ReturnType<typeof window.sessionsAPI.subscribeView>>,
    ) => void;
    vi.mocked(window.sessionsAPI.subscribeView).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSubscribe = resolve;
        }),
    );
    const wrapper = createWrapper();
    queryClient.setQueryData<SessionData>(["session", "session-1"], {
      messages: [{ id: "older", content: "Earlier", role: "user", timestamp: new Date() }],
      isBusy: false,
      soul: undefined,
      permissionCards: [],
      turnState: null,
    });

    renderHook(() => useSessionView("session-1"), { wrapper });
    await waitFor(() => expect(window.sessionsAPI.onViewEvent).toHaveBeenCalled());
    const { fire } = captureViewEventCallback();
    act(() => {
      fire("session-1", makeView({ status: "submitted" }), [
        makeMessage("live-user", {
          role: "user",
          content: "Submitted while subscribe was resolving",
        }),
      ]);
    });
    await act(async () => {
      resolveSubscribe({
        success: true,
        snapshot: {
          sessionId: "session-1",
          epoch: "test-runtime",
          sequence: 1,
          view: makeView({ status: "submitted" }),
        },
      });
    });

    expect(
      queryClient
        .getQueryData<SessionData>(["session", "session-1"])
        ?.messages.map((message) => message.id),
    ).toEqual(["older", "live-user"]);
  });

  it("peer windows (cache lacks the id) append the broadcast message", async () => {
    // From the perspective of a non-origin window that's also viewing the
    // same session: the cache has no copy of the new user message, so the
    // broadcast must produce an append.
    vi.mocked(window.sessionsAPI.getView).mockResolvedValue({
      success: true,
      view: makeView(),
    });

    const wrapper = createWrapper();

    queryClient.setQueryData<SessionData>(["session", "session-1"], {
      messages: [{ id: "older", content: "Earlier", role: "user", timestamp: new Date() }],
      isBusy: false,
      soul: undefined,
      permissionCards: [],
      turnState: null,
    });

    renderHook(() => useSessionView("session-1"), { wrapper });

    await waitFor(() => expect(window.sessionsAPI.subscribeView).toHaveBeenCalled());

    const { fire } = captureViewEventCallback();
    const msg = makeMessage("shared-id", { role: "user", content: "Hi from peer" });

    act(() => {
      fire("session-1", makeView({ status: "streaming" }), [msg]);
    });

    const sessionData = queryClient.getQueryData<SessionData>(["session", "session-1"]);
    expect(sessionData!.messages).toHaveLength(2);
    expect(sessionData!.messages[1].content).toBe("Hi from peer");
  });

  it("keeps only the newest 20 messages as live commits arrive", async () => {
    vi.mocked(window.sessionsAPI.getView).mockResolvedValue({
      success: true,
      view: makeView(),
    });
    const wrapper = createWrapper();
    queryClient.setQueryData<SessionData>(["session", "session-1"], {
      messages: Array.from({ length: 20 }, (_, index) => ({
        id: `m${index}`,
        content: `Message ${index}`,
        role: "assistant" as const,
        timestamp: new Date(index),
      })),
      isBusy: false,
      soul: undefined,
      permissionCards: [],
      turnState: null,
      hasOlderMessages: false,
      totalMessages: 20,
    });

    renderHook(() => useSessionView("session-1"), { wrapper });
    await waitFor(() => expect(window.sessionsAPI.subscribeView).toHaveBeenCalled());
    const { fire } = captureViewEventCallback();

    act(() => {
      fire("session-1", makeView(), [makeMessage("m20"), makeMessage("m21")]);
    });

    const sessionData = queryClient.getQueryData<SessionData>(["session", "session-1"]);
    expect(sessionData?.messages).toHaveLength(20);
    expect(sessionData?.messages[0].id).toBe("m2");
    expect(sessionData?.messages.at(-1)?.id).toBe("m21");
    expect(sessionData?.hasOlderMessages).toBe(true);
    expect(sessionData?.totalMessages).toBe(22);
  });

  it("does not trim the transcript while the reader is holding a scrolled-up position", async () => {
    vi.mocked(window.sessionsAPI.getView).mockResolvedValue({
      success: true,
      view: makeView(),
    });
    const wrapper = createWrapper();
    queryClient.setQueryData<SessionData>(["session", "session-1"], {
      messages: Array.from({ length: 20 }, (_, index) => ({
        id: `m${index}`,
        content: `Message ${index}`,
        role: "assistant" as const,
        timestamp: new Date(index),
      })),
      isBusy: false,
      soul: undefined,
      permissionCards: [],
      turnState: null,
      hasOlderMessages: false,
      totalMessages: 20,
    });

    renderHook(() => useSessionView("session-1"), { wrapper });
    await waitFor(() => expect(window.sessionsAPI.subscribeView).toHaveBeenCalled());
    const { fire } = captureViewEventCallback();

    setTranscriptHeld("session-1", true);
    try {
      act(() => {
        fire("session-1", makeView(), [makeMessage("m20")]);
      });
    } finally {
      setTranscriptHeld("session-1", false);
    }

    const sessionData = queryClient.getQueryData<SessionData>(["session", "session-1"]);
    expect(sessionData?.messages).toHaveLength(21);
    expect(sessionData?.messages[0].id).toBe("m0");
    expect(sessionData?.messages.at(-1)?.id).toBe("m20");
  });

  it("collapses explicitly loaded history when a new live commit arrives", async () => {
    vi.mocked(window.sessionsAPI.getView).mockResolvedValue({
      success: true,
      view: makeView(),
    });
    const wrapper = createWrapper();
    queryClient.setQueryData<SessionData>(["session", "session-1"], {
      messages: Array.from({ length: 40 }, (_, index) => ({
        id: `m${index}`,
        content: `Message ${index}`,
        role: "assistant" as const,
        timestamp: new Date(index),
      })),
      isBusy: false,
      soul: undefined,
      permissionCards: [],
      turnState: null,
      hasOlderMessages: false,
      totalMessages: 40,
    });

    renderHook(() => useSessionView("session-1"), { wrapper });
    await waitFor(() => expect(window.sessionsAPI.subscribeView).toHaveBeenCalled());
    const { fire } = captureViewEventCallback();

    act(() => {
      fire("session-1", makeView(), [makeMessage("new")]);
    });
    const sessionData = queryClient.getQueryData<SessionData>(["session", "session-1"]);
    expect(sessionData?.messages).toHaveLength(20);
    expect(sessionData?.messages.at(-1)?.id).toBe("new");
    expect(sessionData?.hasOlderMessages).toBe(true);
    expect(sessionData?.totalMessages).toBe(41);
  });

  it("events for other sessions are ignored", async () => {
    vi.mocked(window.sessionsAPI.getView).mockResolvedValue({
      success: true,
      view: makeView({ status: "ready" }),
    });

    const wrapper = createWrapper();

    const { result } = renderHook(() => useSessionView("session-1"), { wrapper });

    await waitFor(() => expect(result.current.status).toBe("ready"));

    const { fire } = captureViewEventCallback();

    act(() => {
      // Fire event for a different session
      fire("session-OTHER", makeView({ status: "error", error: "boom" }));
    });

    // Our view should remain unchanged
    expect(result.current.status).toBe("ready");
    expect(result.current.error).toBeNull();
  });

  it("session switch registers interest and applies the new snapshot", async () => {
    const viewA = makeView({ status: "ready", streamingText: "" });
    const viewB = makeView({ status: "streaming", streamingText: "B is active" });

    vi.mocked(window.sessionsAPI.subscribeView).mockImplementation(async (sessionId) => ({
      success: true,
      snapshot: {
        sessionId,
        epoch: "test-runtime",
        sequence: 0,
        view: sessionId === "session-A" ? viewA : viewB,
      },
    }));

    const wrapper = createWrapper();

    const { result, rerender } = renderHook(
      ({ sid }: { sid: string | null }) => useSessionView(sid),
      { wrapper, initialProps: { sid: "session-A" as string | null } },
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(window.sessionsAPI.getView).not.toHaveBeenCalled();

    // Switch session
    rerender({ sid: "session-B" });

    await waitFor(() => expect(result.current.streamingText).toBe("B is active"));
    expect(window.sessionsAPI.subscribeView).toHaveBeenCalledWith("session-B");
  });

  it("unsubscribes from onViewEvent on unmount", async () => {
    const unsubscribe = vi.fn<() => void>();
    vi.mocked(window.sessionsAPI.onViewEvent).mockReturnValue(unsubscribe);
    vi.mocked(window.sessionsAPI.getView).mockResolvedValue({
      success: true,
      view: makeView(),
    });

    const { unmount } = renderHook(() => useSessionView("session-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(window.sessionsAPI.onViewEvent).toHaveBeenCalled());

    unmount();

    expect(unsubscribe).toHaveBeenCalled();
    expect(window.sessionsAPI.unsubscribeView).toHaveBeenCalledWith("session-1");
  });

  it("does not subscribe to onViewEvent when sessionId is null", () => {
    renderHook(() => useSessionView(null), { wrapper: createWrapper() });
    expect(window.sessionsAPI.onViewEvent).not.toHaveBeenCalled();
  });
});
