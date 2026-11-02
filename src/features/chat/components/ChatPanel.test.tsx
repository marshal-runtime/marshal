import type { RuntimeUiAPI } from "@common/marshal-ipc-contract";
import {
  MARSHAL_RUNTIME_DEFAULT_WORKSPACE,
  RUNTIME_UI_HOST_PLACEMENTS,
  RUNTIME_UI_PLACEMENT,
  type RuntimeUiPlacementApplication,
  type RuntimeUiPlacementSnapshot,
} from "@common/runtime-ui";
import { QueryClient } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { RuntimeUiPlacementsProvider } from "@/features/runtime-ui/RuntimeUiPlacements";
import { copilotService } from "@/services/copilot";
import { installMockAPIs, render, screen, waitFor, act, within } from "@/test-utils";
import type {
  PermissionCardData,
  SessionView,
  SessionViewDelivery,
  SessionsAPI,
  StoredSession,
} from "@/types/electron";

import {
  SLASH_FRESH_FLAG,
  SLASH_PLACEMENT_ARGUMENT_KEY,
  SLASH_PLACEMENT_FRESH_KEY,
  SLASH_PREFIX,
} from "../context-picker/slash-commands";
import { hydrationStore } from "../session-state/hydration-store";
import { classifyTimelineMessage } from "../state/timelineFilters";
import {
  getPromptEditor,
  pressInPromptEditor,
  promptEditorText,
  setPromptTextDOM,
} from "../testing/prompt-editor-dom";
import type { SessionData } from "../types";
import { _clearSessionDrafts } from "./ChatInput";
import { ChatPanel, type ChatPanelProps, type ChatPanelRef } from "./ChatPanel";
import { clearDismissedChatNoticesForTest } from "./dismissed-chat-notices";

const PROJECT_REVIEWER_CONTEXT_LABEL =
  "Chat context: Project · Reviewer Choose context for a new chat.";

// Mock Copilot service calls.
vi.mock("@/services/copilot", () => ({
  copilotService: {
    initialize: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    send: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    steer: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    abort: vi.fn<() => void>(),
    stop: vi.fn<() => void>(),
    onEvent: vi.fn<(cb: unknown) => () => void>().mockReturnValue(() => {}),
    saveImage: vi.fn<() => Promise<string>>().mockResolvedValue("/tmp/img.png"),
  },
}));

// Mock the permission-card store used by useSyncExternalStore.
const permStoreListeners = new Set<() => void>();
let permStoreCache = new Map<string, PermissionCardData[]>();
const PERM_EMPTY: PermissionCardData[] = [];
vi.mock("../permissions/state/permission-cards-store", () => ({
  permissionCardsStore: {
    subscribe: vi.fn<(cb: () => void) => () => void>((cb: () => void) => {
      permStoreListeners.add(cb);
      return () => permStoreListeners.delete(cb);
    }),
    getSnapshot: vi.fn<(sid: string) => PermissionCardData[]>(
      (sid: string) => permStoreCache.get(sid) ?? PERM_EMPTY,
    ),
    fetch: vi.fn<(sid: string) => Promise<void>>(async () => {}),
    optimisticUpdate: vi.fn<
      (sid: string, updater: (cards: PermissionCardData[]) => PermissionCardData[]) => void
    >((sid: string, updater: (cards: PermissionCardData[]) => PermissionCardData[]) => {
      const current = permStoreCache.get(sid) ?? [];
      permStoreCache.set(sid, updater(current));
      permStoreListeners.forEach((l) => l());
    }),
    clear: vi.fn<(sid: string) => void>((sid: string) => {
      permStoreCache.delete(sid);
      permStoreListeners.forEach((l) => l());
    }),
  },
}));

function injectPermissionCard(sessionId: string, card: PermissionCardData) {
  const current = permStoreCache.get(sessionId) ?? [];
  permStoreCache.set(sessionId, [...current, { ...card, createdAt: Date.now() }]);
  permStoreListeners.forEach((l) => l());
}

// Mock streamdown to avoid ESM and Shiki issues in tests.
vi.mock("streamdown", () => ({
  Streamdown: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
  defaultRehypePlugins: { raw: () => {}, sanitize: [], harden: [] },
}));

vi.mock("@streamdown/code", () => ({
  code: {},
}));

vi.mock("@/plugins/streamdown-config", () => ({
  MarkdownRenderer: ({ children }: { children: string }) => (
    <div data-testid="markdown">{children}</div>
  ),
}));

// Happy DOM does not consume ClipboardItem payload promises, so Monaco's normal superseded-write
// cancellation becomes an unhandled rejection instead of flowing through clipboard.write().
const HappyDomClipboardItem = ClipboardItem;
class ConsumingClipboardItem extends HappyDomClipboardItem {
  constructor(
    items: Record<string, string | Blob | PromiseLike<string | Blob>>,
    options?: ClipboardItemOptions,
  ) {
    for (const value of Object.values(items)) {
      if (typeof value === "object" && value !== null && "then" in value) {
        void Promise.resolve(value).catch(() => undefined);
      }
    }
    super(items, options);
  }
}
vi.stubGlobal("ClipboardItem", ConsumingClipboardItem);

beforeEach(() => {
  installMockAPIs();
  vi.mocked(window.sessionsAPI.get).mockResolvedValue({ success: true, session: makeSession() });
  clearDismissedChatNoticesForTest();
  hydrationStore.reset();
  permStoreCache = new Map();
  viewSequence = 0;
  vi.mocked(window.sessionsAPI.subscribeView).mockImplementation(async (sessionId) => {
    const result = await window.sessionsAPI.getView(sessionId);
    return {
      success: true,
      snapshot: {
        sessionId,
        epoch: "chat-panel-test-runtime",
        sequence: 0,
        view: result.success && result.view ? result.view : makeView(),
      },
    };
  });
});

function makeView(overrides: Partial<SessionView> = {}): SessionView {
  return {
    status: "ready",
    streamingText: "",
    reasoning: null,
    toolStatuses: [],
    tokenUsage: null,
    lastTurnUsage: null,
    error: null,
    sessionStatus: null,
    ...overrides,
  };
}

let viewSequence = 0;

function sequencedViewCallback(
  callback: (event: SessionViewDelivery) => void,
): (event: Omit<SessionViewDelivery, "epoch" | "sequence">) => void {
  return (event) =>
    callback({
      ...event,
      epoch: "chat-panel-test-runtime",
      sequence: ++viewSequence,
    });
}

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: "test-session",
    name: "Test Session",
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    hasUnread: false,
    isActive: true,
    ...overrides,
  };
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
}

describe("ChatPanel", () => {
  beforeEach(() => {
    // Drafts persist across tests, so clear them between cases.
    _clearSessionDrafts();
    window.localStorage.clear();
  });

  it("shows welcome state when no messages", async () => {
    render(<ChatPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("welcome-state")).toBeInTheDocument();
      expect(screen.getByTestId("welcome-greeting")).toBeInTheDocument();
    });
  });

  it("anchors runtime inline content inside the stable chat scroll container", async () => {
    render(
      <ChatPanel
        runtimeUiInline={<section data-testid="runtime-inline-slot">Runtime card</section>}
      />,
    );

    const messagesContainer = await screen.findByTestId("messages-container");
    expect(within(messagesContainer).getByTestId("runtime-inline-slot")).toHaveTextContent(
      "Runtime card",
    );
  });

  it("keeps an actionable context control in an empty ordinary main chat", async () => {
    const onWorkspaceRoleChange = vi
      .fn<NonNullable<ChatPanelProps["onWorkspaceRoleChange"]>>()
      .mockResolvedValue(undefined);
    render(<ChatPanel onWorkspaceRoleChange={onWorkspaceRoleChange} />);

    const trigger = await screen.findByRole("button", {
      name: /Chat context: No workspace · Default/i,
    });
    expect(trigger).toBeEnabled();

    const user = userEvent.setup();
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Start without workspace" }));

    expect(onWorkspaceRoleChange).toHaveBeenCalledWith(
      {
        workspaceBinding: undefined,
        repositoryAgent: undefined,
      },
      { hasUserMessages: false, soulId: "default" },
    );
  });

  it("keeps context and filtering independent in a source-less legacy chat", async () => {
    vi.mocked(window.sessionsAPI.get).mockResolvedValue({
      success: true,
      session: makeSession({
        source: undefined,
        messages: [
          {
            id: "legacy-user",
            role: "user",
            content: "Legacy prompt",
            timestamp: new Date(2026, 6, 24, 12, 0).toISOString(),
          },
          {
            id: "legacy-assistant",
            role: "assistant",
            content: "Legacy answer",
            timestamp: new Date(2026, 6, 24, 12, 1).toISOString(),
          },
        ],
      }),
      messagePage: { hasMore: false, total: 2 },
    });
    const onWorkspaceRoleChange = vi
      .fn<NonNullable<ChatPanelProps["onWorkspaceRoleChange"]>>()
      .mockResolvedValue(undefined);
    render(<ChatPanel sessionId="legacy-session" onWorkspaceRoleChange={onWorkspaceRoleChange} />);

    expect(await screen.findByText("Legacy answer")).toBeInTheDocument();
    const contextTrigger = screen.getByRole("button", {
      name: /Chat context: No workspace · Default/i,
    });
    expect(contextTrigger).toBeEnabled();
    expect(screen.getByRole("button", { name: "Filter timeline" })).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(contextTrigger);
    await user.click(screen.getByRole("button", { name: "Start without workspace" }));

    expect(onWorkspaceRoleChange).toHaveBeenCalledWith(
      {
        workspaceBinding: undefined,
        repositoryAgent: undefined,
      },
      { hasUserMessages: true, soulId: "default" },
    );
  });

  it("shows a name-led greeting and no starter-prompt cards", async () => {
    render(<ChatPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("welcome-greeting")).toBeInTheDocument();
    });
    // The predecessor's option grid was removed deliberately — assert it stays
    // gone rather than just deleting the old positive test.
    expect(screen.queryAllByTestId(/^prompt-card-/)).toHaveLength(0);
  });

  describe("bounded message paging", () => {
    it("reports an unavailable stored session instead of showing a successful empty conversation", async () => {
      vi.mocked(window.sessionsAPI.get).mockResolvedValue({ success: true, session: undefined });
      render(<ChatPanel sessionId="missing-session" />);
      expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded");
    });
    it("shows a retryable history error instead of accepting a failed read as an empty chat", async () => {
      vi.mocked(window.sessionsAPI.get).mockResolvedValue({
        success: false,
        error: "History unavailable",
      });
      render(<ChatPanel sessionId="test-session" />);
      expect(await screen.findByRole("alert")).toHaveTextContent("History unavailable");
      vi.mocked(window.sessionsAPI.get).mockResolvedValue({
        success: true,
        session: makeSession({ messages: storedMessages(0, 1) }),
      });
      await act(async () => screen.getByRole("button", { name: "Retry" }).click());
      expect(await screen.findByText("Message 0")).toBeInTheDocument();
      expect(screen.queryByText("History unavailable")).not.toBeInTheDocument();
    });

    const storedMessages = (start: number, count: number) =>
      Array.from({ length: count }, (_, offset) => ({
        id: `m${start + offset}`,
        role: "user" as const,
        content: `Message ${start + offset}`,
        timestamp: new Date(2026, 0, 1, 0, start + offset).toISOString(),
      }));

    it("requests and retains only the newest 20 messages on session load", async () => {
      vi.mocked(window.sessionsAPI.get).mockResolvedValue({
        success: true,
        session: makeSession({ messages: storedMessages(0, 40) }),
        messagePage: { hasMore: true, total: 40 },
      });

      render(<ChatPanel sessionId="test-session" />);

      await waitFor(() => {
        expect(window.sessionsAPI.get).toHaveBeenCalledWith("test-session", {
          messageLimit: 20,
        });
      });
      expect(screen.queryByText("Message 0")).not.toBeInTheDocument();
      expect(await screen.findByText("Message 20")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Load previous 20 messages" })).toBeInTheDocument();
    });

    it("prepends older messages without replacing the newer page", async () => {
      vi.mocked(window.sessionsAPI.get).mockResolvedValue({
        success: true,
        session: makeSession({
          messages: storedMessages(20, 20),
          source: "user",
          workspaceName: "Project",
          workspaceIdentity: {
            version: 1,
            device: "1",
            inode: "2",
            birthtimeNs: "3",
          },
          repositoryAgent: {
            name: "Reviewer",
            path: ".github/agents/reviewer.agent.md",
            identity: {
              version: 1,
              normalizedPath: ".github/agents/reviewer.agent.md",
              declaredName: "Reviewer",
              contentDigest: "reviewer-v1",
            },
          },
        }),
        messagePage: { hasMore: true, total: 40 },
      });
      vi.mocked(window.sessionsAPI.getMessages).mockResolvedValue({
        success: true,
        messages: storedMessages(0, 20),
        hasMore: false,
        total: 40,
      });
      vi.mocked(window.workspaceAPI.listWorkspaces).mockResolvedValue({
        success: true,
        workspaces: ["Scratchpad", "Project"],
        workspaceBindings: [
          {
            name: "Scratchpad",
            identity: { version: 1, device: "1", inode: "1", birthtimeNs: "3" },
          },
          {
            name: "Project",
            identity: { version: 1, device: "1", inode: "2", birthtimeNs: "3" },
          },
        ],
      });
      vi.mocked(window.workspaceAPI.listRepositoryAgents).mockResolvedValue({
        success: true,
        agents: [
          {
            name: "Reviewer",
            path: ".github/agents/reviewer.agent.md",
            identity: {
              version: 1,
              normalizedPath: ".github/agents/reviewer.agent.md",
              declaredName: "Reviewer",
              contentDigest: "reviewer-v1",
            },
          },
        ],
      });

      const queryClient = makeQueryClient();
      render(
        <ChatPanel
          sessionId="test-session"
          onWorkspaceRoleChange={vi
            .fn<NonNullable<ChatPanelProps["onWorkspaceRoleChange"]>>()
            .mockResolvedValue(undefined)}
        />,
        { queryClient },
      );
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Load previous 20 messages" }));

      await waitFor(() => {
        expect(window.sessionsAPI.getMessages).toHaveBeenCalledWith("test-session", {
          beforeMessageId: "m20",
          limit: 20,
        });
      });
      await waitFor(() => {
        expect(
          queryClient
            .getQueryData<SessionData>(["session", "test-session"])
            ?.messages.map((message) => message.id),
        ).toEqual(storedMessages(0, 40).map((message) => message.id));
      });
      expect(screen.queryByRole("button", { name: "Return to latest" })).not.toBeInTheDocument();
      expect(window.sessionsAPI.get).toHaveBeenCalledTimes(1);
      expect(
        screen.getByRole("button", {
          name: PROJECT_REVIEWER_CONTEXT_LABEL,
        }),
      ).toBeInTheDocument();
    });

    it("preserves live and streaming state while an older-page request is in flight", async () => {
      let fireViewEvent!: (data: any) => void;
      let resolveOlder!: (value: Awaited<ReturnType<SessionsAPI["getMessages"]>>) => void;
      vi.mocked(window.sessionsAPI.onViewEvent).mockImplementation((callback) => {
        fireViewEvent = sequencedViewCallback(callback);
        return () => {};
      });
      vi.mocked(window.sessionsAPI.get).mockResolvedValue({
        success: true,
        session: makeSession({ messages: storedMessages(20, 20) }),
        messagePage: { hasMore: true, total: 40 },
      });
      vi.mocked(window.sessionsAPI.getMessages).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveOlder = resolve;
          }),
      );
      const queryClient = makeQueryClient();

      render(<ChatPanel sessionId="test-session" />, { queryClient });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Load previous 20 messages" }));
      await waitFor(() => expect(window.sessionsAPI.getMessages).toHaveBeenCalledOnce());

      act(() => {
        fireViewEvent({
          sessionId: "test-session",
          type: "session:view",
          view: makeView({ status: "streaming", streamingText: "Partial response" }),
          committedMessages: storedMessages(40, 1),
        });
      });
      await waitFor(() => {
        expect(
          queryClient.getQueryData<SessionData>(["session", "test-session"])?.messages.at(-1)?.id,
        ).toBe("m40");
      });

      await act(async () => {
        resolveOlder({
          success: true,
          messages: storedMessages(0, 20),
          hasMore: false,
          total: 41,
        });
      });

      await waitFor(() => {
        expect(
          queryClient
            .getQueryData<SessionData>(["session", "test-session"])
            ?.messages.map((message) => message.id),
        ).toEqual(storedMessages(0, 41).map((message) => message.id));
      });
      expect(screen.getByText("Partial response")).toBeInTheDocument();
    });

    it("preserves an attributed child handoff while older history is prepended", async () => {
      let fireViewEvent!: (data: any) => void;
      let resolveOlder!: (value: Awaited<ReturnType<SessionsAPI["getMessages"]>>) => void;
      vi.mocked(window.sessionsAPI.onViewEvent).mockImplementation((callback) => {
        fireViewEvent = sequencedViewCallback(callback);
        return () => {};
      });
      vi.mocked(window.sessionsAPI.get).mockResolvedValue({
        success: true,
        session: makeSession({ messages: storedMessages(20, 20) }),
        messagePage: { hasMore: true, total: 40 },
      });
      vi.mocked(window.sessionsAPI.getMessages).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveOlder = resolve;
          }),
      );
      const queryClient = makeQueryClient();

      render(<ChatPanel sessionId="test-session" />, { queryClient });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Load previous 20 messages" }));
      await waitFor(() => expect(window.sessionsAPI.getMessages).toHaveBeenCalledOnce());

      act(() => {
        fireViewEvent({
          sessionId: "test-session",
          type: "session:view",
          view: makeView(),
          committedMessages: [
            {
              id: "handoff-live",
              role: "user",
              content: "Message from subagent Worker (child-1):\n\nImplementation is ready.",
              timestamp: new Date(2026, 0, 1, 0, 40).toISOString(),
              agentMessage: {
                source: "child-1",
                sourceLabel: "Worker",
                sourceSessionSource: "subagent",
                kind: "parent",
                deliveryMode: "queue",
                sequence: 7,
              },
            },
          ],
        });
      });
      await waitFor(() => {
        expect(
          queryClient.getQueryData<SessionData>(["session", "test-session"])?.messages.at(-1)?.id,
        ).toBe("handoff-live");
      });

      await act(async () => {
        resolveOlder({
          success: true,
          messages: storedMessages(0, 20),
          hasMore: false,
          total: 41,
        });
      });

      await waitFor(() => {
        const loaded = queryClient.getQueryData<SessionData>(["session", "test-session"])?.messages;
        expect(loaded).toHaveLength(41);
        expect(loaded?.slice(0, 40).map((message) => message.id)).toEqual(
          storedMessages(0, 40).map((message) => message.id),
        );
        expect(loaded?.at(-1)).toMatchObject({
          id: "handoff-live",
          agentMessage: { kind: "parent", source: "child-1" },
        });
        expect(classifyTimelineMessage(loaded!.at(-1)!)).toMatchObject({
          categories: ["subagent"],
          renderRole: "event",
          subagent: { id: "child-1", name: "Worker", source: "subagent" },
        });
      });
    });

    it("preserves a real editor commit that arrives before the older page", async () => {
      let fireViewEvent!: (data: any) => void;
      let resolveOlder!: (value: Awaited<ReturnType<SessionsAPI["getMessages"]>>) => void;
      vi.mocked(window.sessionsAPI.onViewEvent).mockImplementation((callback) => {
        fireViewEvent = sequencedViewCallback(callback);
        return () => {};
      });
      vi.mocked(window.sessionsAPI.get).mockResolvedValue({
        success: true,
        session: makeSession({ messages: storedMessages(20, 20) }),
        messagePage: { hasMore: true, total: 40 },
      });
      vi.mocked(window.sessionsAPI.getMessages).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveOlder = resolve;
          }),
      );
      const queryClient = makeQueryClient();
      const cancelQueries = vi.spyOn(queryClient, "cancelQueries");

      render(<ChatPanel sessionId="test-session" />, { queryClient });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Load previous 20 messages" }));
      await waitFor(() => expect(window.sessionsAPI.getMessages).toHaveBeenCalledOnce());
      expect(
        cancelQueries.mock.calls.some(
          ([filters]) =>
            filters?.queryKey?.[0] === "session" && filters.queryKey[1] === "test-session",
        ),
      ).toBe(false);

      await setPromptTextDOM("Pending newer message");
      pressInPromptEditor("Enter");
      await waitFor(() => {
        expect(copilotService.send).toHaveBeenCalled();
        expect(
          cancelQueries.mock.calls.some(
            ([filters]) =>
              filters?.queryKey?.[0] === "session" && filters.queryKey[1] === "test-session",
          ),
        ).toBe(false);
        expect(
          queryClient.getQueryData<SessionData>(["session", "test-session"])?.messages.at(-1)
            ?.content,
        ).toBe("Pending newer message");
      });
      const clientMessageId = vi.mocked(copilotService.send).mock.calls.at(-1)?.[3];
      if (!clientMessageId) throw new Error("send did not receive a client message id");
      act(() => {
        fireViewEvent({
          sessionId: "test-session",
          type: "session:view",
          view: makeView({ status: "streaming", streamingText: "Streaming before prepend" }),
          committedMessages: [
            {
              id: clientMessageId,
              role: "user",
              content: "Pending newer message",
              timestamp: new Date(2026, 0, 1, 1).toISOString(),
            },
          ],
        });
      });
      await waitFor(() => {
        const loaded = queryClient.getQueryData<SessionData>(["session", "test-session"])?.messages;
        expect(loaded?.filter((message) => message.id === clientMessageId)).toHaveLength(1);
        expect(loaded?.at(-1)?.optimistic).toBe(false);
      });

      await act(async () => {
        resolveOlder({
          success: true,
          messages: storedMessages(0, 20),
          hasMore: false,
          total: 41,
        });
      });

      await waitFor(() => {
        const loaded = queryClient.getQueryData<SessionData>(["session", "test-session"])?.messages;
        expect(loaded).toHaveLength(41);
        expect(loaded?.slice(0, 40).map((message) => message.id)).toEqual(
          storedMessages(0, 40).map((message) => message.id),
        );
        expect(loaded?.at(-1)?.content).toBe("Pending newer message");
        expect(loaded?.at(-1)?.optimistic).toBe(false);
      });
      expect(screen.getByText("Streaming before prepend")).toBeInTheDocument();
    });

    it("bounds a filtered real editor turn when commit arrives after the older page", async () => {
      let fireViewEvent!: (data: any) => void;
      let resolveOlder!: (value: Awaited<ReturnType<SessionsAPI["getMessages"]>>) => void;
      vi.mocked(window.sessionsAPI.onViewEvent).mockImplementation((callback) => {
        fireViewEvent = sequencedViewCallback(callback);
        return () => {};
      });
      vi.mocked(window.sessionsAPI.get).mockResolvedValue({
        success: true,
        session: makeSession({ messages: storedMessages(20, 20) }),
        messagePage: { hasMore: true, total: 40 },
      });
      vi.mocked(window.sessionsAPI.getMessages).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveOlder = resolve;
          }),
      );
      const queryClient = makeQueryClient();
      render(<ChatPanel sessionId="test-session" />, { queryClient });
      const user = userEvent.setup();

      await user.click(await screen.findByRole("button", { name: "Filter timeline" }));
      await user.click(screen.getByRole("checkbox", { name: "You" }));
      await user.keyboard("{Escape}");
      expect(screen.getByText("0 of 20")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Load previous 20 messages" }));
      await waitFor(() => expect(window.sessionsAPI.getMessages).toHaveBeenCalledOnce());

      await setPromptTextDOM("Committed after prepend");
      pressInPromptEditor("Enter");
      await waitFor(() => expect(copilotService.send).toHaveBeenCalled());
      const clientMessageId = vi.mocked(copilotService.send).mock.calls.at(-1)?.[3];
      if (!clientMessageId) throw new Error("send did not receive a client message id");

      await act(async () => {
        resolveOlder({
          success: true,
          messages: storedMessages(0, 20),
          hasMore: false,
          total: 41,
        });
      });
      await waitFor(() => {
        const loaded = queryClient.getQueryData<SessionData>(["session", "test-session"])?.messages;
        expect(loaded).toHaveLength(20);
        expect(loaded?.[0]?.id).toBe("m21");
        expect(loaded?.at(-1)).toMatchObject({
          id: clientMessageId,
          content: "Committed after prepend",
          optimistic: true,
        });
        expect(screen.getByText("0 of 20")).toBeInTheDocument();
        expect(screen.queryByText("Committed after prepend")).not.toBeInTheDocument();
      });

      act(() => {
        fireViewEvent({
          sessionId: "test-session",
          type: "session:view",
          view: makeView({ status: "streaming", streamingText: "Streaming after prepend" }),
          committedMessages: [
            {
              id: clientMessageId,
              role: "user",
              content: "Committed after prepend",
              timestamp: new Date(2026, 0, 1, 1).toISOString(),
            },
          ],
        });
      });
      await waitFor(() => {
        const loaded = queryClient.getQueryData<SessionData>(["session", "test-session"])?.messages;
        expect(loaded).toHaveLength(20);
        expect(loaded?.[0]?.id).toBe("m21");
        expect(loaded?.filter((message) => message.id === clientMessageId)).toHaveLength(1);
        expect(loaded?.at(-1)?.optimistic).toBe(false);
        expect(screen.getByText("0 of 20")).toBeInTheDocument();
      });
      expect(screen.getByText("Streaming after prepend")).toBeInTheDocument();

      act(() => {
        fireViewEvent({
          sessionId: "test-session",
          type: "session:view",
          view: makeView({ status: "ready" }),
          committedMessages: [
            {
              id: clientMessageId,
              role: "user",
              content: "Committed after prepend",
              timestamp: new Date(2026, 0, 1, 1).toISOString(),
            },
          ],
        });
      });
      expect(
        queryClient
          .getQueryData<SessionData>(["session", "test-session"])
          ?.messages.filter((message) => message.id === clientMessageId),
      ).toHaveLength(1);
    });

    it("ignores a stale older-page response after the transcript is cleared", async () => {
      let resolveOlder!: (value: Awaited<ReturnType<SessionsAPI["getMessages"]>>) => void;
      vi.mocked(window.sessionsAPI.get).mockResolvedValue({
        success: true,
        session: makeSession({ messages: storedMessages(20, 20) }),
        messagePage: { hasMore: true, total: 40 },
      });
      vi.mocked(window.sessionsAPI.getMessages).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveOlder = resolve;
          }),
      );
      const queryClient = makeQueryClient();
      const ref = createRef<ChatPanelRef>();

      render(<ChatPanel ref={ref} sessionId="test-session" />, { queryClient });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Load previous 20 messages" }));
      await waitFor(() => expect(window.sessionsAPI.getMessages).toHaveBeenCalledOnce());

      act(() => ref.current?.clearChat());
      await act(async () => {
        resolveOlder({
          success: true,
          messages: storedMessages(0, 20),
          hasMore: false,
          total: 40,
        });
      });

      await waitFor(() => {
        expect(
          queryClient.getQueryData<SessionData>(["session", "test-session"])?.messages,
        ).toEqual([]);
      });
    });

    it("ignores a stale older-page response after switching sessions", async () => {
      let resolveOlder!: (value: Awaited<ReturnType<SessionsAPI["getMessages"]>>) => void;
      vi.mocked(window.sessionsAPI.get).mockImplementation(async (sessionId) => ({
        success: true,
        session: makeSession({
          id: sessionId,
          messages: sessionId === "session-a" ? storedMessages(20, 20) : storedMessages(100, 2),
        }),
        messagePage:
          sessionId === "session-a" ? { hasMore: true, total: 40 } : { hasMore: false, total: 2 },
      }));
      vi.mocked(window.sessionsAPI.getMessages).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveOlder = resolve;
          }),
      );
      const queryClient = makeQueryClient();
      const { rerender } = render(<ChatPanel sessionId="session-a" />, { queryClient });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Load previous 20 messages" }));
      await waitFor(() => expect(window.sessionsAPI.getMessages).toHaveBeenCalledOnce());

      rerender(<ChatPanel sessionId="session-b" />);
      expect(await screen.findByText("Message 100")).toBeInTheDocument();
      await act(async () => {
        resolveOlder({
          success: true,
          messages: storedMessages(0, 20),
          hasMore: false,
          total: 40,
        });
      });

      expect(
        queryClient
          .getQueryData<SessionData>(["session", "session-a"])
          ?.messages.map((message) => message.id),
      ).toEqual(storedMessages(20, 20).map((message) => message.id));
      expect(
        queryClient
          .getQueryData<SessionData>(["session", "session-b"])
          ?.messages.map((message) => message.id),
      ).toEqual(storedMessages(100, 2).map((message) => message.id));
    });

    it("stops pagination when a repeated page makes no progress", async () => {
      vi.mocked(window.sessionsAPI.get).mockResolvedValue({
        success: true,
        session: makeSession({ messages: storedMessages(20, 20) }),
        messagePage: { hasMore: true, total: 40 },
      });
      vi.mocked(window.sessionsAPI.getMessages).mockResolvedValue({
        success: true,
        messages: storedMessages(20, 20),
        hasMore: true,
        total: 40,
      });
      const queryClient = makeQueryClient();

      render(<ChatPanel sessionId="test-session" />, { queryClient });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Load previous 20 messages" }));

      await waitFor(() => {
        expect(
          queryClient
            .getQueryData<SessionData>(["session", "test-session"])
            ?.messages.map((message) => message.id),
        ).toEqual(storedMessages(20, 20).map((message) => message.id));
        expect(
          screen.queryByRole("button", { name: "Load previous 20 messages" }),
        ).not.toBeInTheDocument();
      });
    });

    it("bounds a latest-page refetch after older history is prepended", async () => {
      let fireMetadataChanged!: (sessionId: string) => void | Promise<void>;
      let resolveOlder!: (value: Awaited<ReturnType<SessionsAPI["getMessages"]>>) => void;
      let resolveLatest!: (value: Awaited<ReturnType<SessionsAPI["get"]>>) => void;
      vi.mocked(window.sessionsAPI.onMetadataChanged).mockImplementation((callback) => {
        fireMetadataChanged = callback;
        return () => {};
      });
      vi.mocked(window.sessionsAPI.get)
        .mockResolvedValueOnce({
          success: true,
          session: makeSession({ messages: storedMessages(20, 20) }),
          messagePage: { hasMore: true, total: 40 },
        })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveLatest = resolve;
            }),
        );
      vi.mocked(window.sessionsAPI.getMessages).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveOlder = resolve;
          }),
      );
      const queryClient = makeQueryClient();

      render(<ChatPanel sessionId="test-session" />, { queryClient });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Load previous 20 messages" }));
      await waitFor(() => expect(window.sessionsAPI.getMessages).toHaveBeenCalledOnce());

      await act(async () => {
        await fireMetadataChanged("test-session");
      });
      await waitFor(() => expect(window.sessionsAPI.get).toHaveBeenCalledTimes(2));
      await act(async () => {
        resolveOlder({
          success: true,
          messages: storedMessages(0, 20),
          hasMore: false,
          total: 40,
        });
      });
      await waitFor(() => {
        expect(
          queryClient
            .getQueryData<SessionData>(["session", "test-session"])
            ?.messages.map((message) => message.id),
        ).toEqual(storedMessages(0, 40).map((message) => message.id));
      });

      await act(async () => {
        resolveLatest({
          success: true,
          session: makeSession({ messages: storedMessages(21, 20) }),
          messagePage: { hasMore: true, total: 41 },
        });
      });

      await waitFor(() => {
        expect(
          queryClient
            .getQueryData<SessionData>(["session", "test-session"])
            ?.messages.map((message) => message.id),
        ).toEqual(storedMessages(21, 20).map((message) => message.id));
        expect(
          queryClient.getQueryData<SessionData>(["session", "test-session"])?.hasOlderMessages,
        ).toBe(true);
      });
    });

    it("keeps the history cursor on the unfiltered page", async () => {
      vi.mocked(window.sessionsAPI.get).mockResolvedValue({
        success: true,
        session: makeSession({ messages: storedMessages(20, 20) }),
        messagePage: { hasMore: true, total: 40 },
      });
      vi.mocked(window.sessionsAPI.getMessages).mockResolvedValue({
        success: true,
        messages: storedMessages(0, 20),
        hasMore: false,
        total: 40,
      });
      render(<ChatPanel sessionId="test-session" />);
      const user = userEvent.setup();

      await user.click(await screen.findByRole("button", { name: "Filter timeline" }));
      await user.click(screen.getByRole("checkbox", { name: "You" }));
      expect(screen.getByText("No timeline entries match these filters.")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Load previous 20 messages" }));

      await waitFor(() => {
        expect(window.sessionsAPI.getMessages).toHaveBeenCalledWith("test-session", {
          beforeMessageId: "m20",
          limit: 20,
        });
      });
    });

    it("keeps context and one persistent filter trigger at the bottom of a long source-less legacy chat", async () => {
      vi.mocked(window.sessionsAPI.get).mockResolvedValue({
        success: true,
        session: makeSession({ source: undefined, messages: storedMessages(0, 40) }),
        messagePage: { hasMore: false, total: 40 },
      });
      render(
        <ChatPanel
          sessionId="test-session"
          onWorkspaceRoleChange={vi
            .fn<NonNullable<ChatPanelProps["onWorkspaceRoleChange"]>>()
            .mockResolvedValue(undefined)}
        />,
      );

      const trigger = await screen.findByRole("button", { name: "Filter timeline" });
      const messagesContainer = screen.getByTestId("messages-container");
      messagesContainer.scrollTop = messagesContainer.scrollHeight;

      expect(screen.getAllByTestId("timeline-filter-trigger")).toHaveLength(1);
      expect(messagesContainer).not.toContainElement(trigger);
      expect(screen.getByTestId("timeline-filter-chrome")).toContainElement(trigger);
      expect(
        screen.getByRole("button", { name: /Chat context: No workspace · Default/i }),
      ).toBeEnabled();
    });

    it("reapplies active filters across multiple prepends and a live commit in a scoped main session", async () => {
      const assistantMessages = (start: number, count: number) =>
        storedMessages(start, count).map((message) => ({
          ...message,
          role: "assistant" as const,
        }));
      let fireViewEvent!: (data: any) => void;
      let resolveFirstOlder!: (value: Awaited<ReturnType<SessionsAPI["getMessages"]>>) => void;
      vi.mocked(window.sessionsAPI.onViewEvent).mockImplementation((callback) => {
        fireViewEvent = sequencedViewCallback(callback);
        return () => {};
      });
      vi.mocked(window.sessionsAPI.get).mockResolvedValue({
        success: true,
        session: makeSession({
          messages: storedMessages(40, 20),
          source: "user",
          workspaceName: "Project",
          workspaceIdentity: {
            version: 1,
            device: "1",
            inode: "2",
            birthtimeNs: "3",
          },
          repositoryAgent: {
            name: "Reviewer",
            path: ".github/agents/reviewer.agent.md",
            identity: {
              version: 1,
              normalizedPath: ".github/agents/reviewer.agent.md",
              declaredName: "Reviewer",
              contentDigest: "reviewer-v1",
            },
          },
        }),
        messagePage: { hasMore: true, total: 60 },
      });
      vi.mocked(window.sessionsAPI.getMessages)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirstOlder = resolve;
            }),
        )
        .mockResolvedValueOnce({
          success: true,
          messages: assistantMessages(0, 20),
          hasMore: false,
          total: 61,
        });
      vi.mocked(window.workspaceAPI.listWorkspaces).mockResolvedValue({
        success: true,
        workspaces: ["Project"],
        workspaceBindings: [
          {
            name: "Project",
            identity: { version: 1, device: "1", inode: "2", birthtimeNs: "3" },
          },
        ],
      });
      vi.mocked(window.workspaceAPI.listRepositoryAgents).mockResolvedValue({
        success: true,
        agents: [
          {
            name: "Reviewer",
            path: ".github/agents/reviewer.agent.md",
            identity: {
              version: 1,
              normalizedPath: ".github/agents/reviewer.agent.md",
              declaredName: "Reviewer",
              contentDigest: "reviewer-v1",
            },
          },
        ],
      });
      const queryClient = makeQueryClient();
      render(
        <ChatPanel
          sessionId="test-session"
          onWorkspaceRoleChange={vi
            .fn<NonNullable<ChatPanelProps["onWorkspaceRoleChange"]>>()
            .mockResolvedValue(undefined)}
        />,
        { queryClient },
      );
      const user = userEvent.setup();

      await user.click(await screen.findByRole("button", { name: "Filter timeline" }));
      await user.click(screen.getByRole("checkbox", { name: "You" }));
      await user.click(screen.getByRole("checkbox", { name: "Agents & reviewers" }));
      await user.click(screen.getByRole("checkbox", { name: "Goals" }));
      await user.click(screen.getByRole("checkbox", { name: "Runtime" }));
      await user.click(screen.getByRole("checkbox", { name: "System" }));
      await user.keyboard("{Escape}");
      expect(screen.getByText("0 of 20")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Load previous 20 messages" }));
      await waitFor(() => expect(window.sessionsAPI.getMessages).toHaveBeenCalledOnce());
      act(() => {
        fireViewEvent({
          sessionId: "test-session",
          type: "session:view",
          view: makeView(),
          committedMessages: [
            {
              ...storedMessages(60, 1)[0],
              role: "assistant",
              content: "Live assistant result",
            },
          ],
        });
      });
      await waitFor(() => {
        expect(screen.getByText("1 of 20")).toBeInTheDocument();
        expect(
          queryClient.getQueryData<SessionData>(["session", "test-session"])?.messages.at(-1)?.id,
        ).toBe("m60");
      });
      await act(async () => {
        resolveFirstOlder({
          success: true,
          messages: assistantMessages(20, 20),
          hasMore: true,
          total: 61,
        });
      });
      await waitFor(() => {
        expect(window.sessionsAPI.getMessages).toHaveBeenNthCalledWith(1, "test-session", {
          beforeMessageId: "m40",
          limit: 20,
        });
        expect(screen.getByText("21 of 41")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: "Load previous 20 messages" }));
      await waitFor(() => {
        expect(window.sessionsAPI.getMessages).toHaveBeenNthCalledWith(2, "test-session", {
          beforeMessageId: "m20",
          limit: 20,
        });
        expect(screen.getByText("41 of 61")).toBeInTheDocument();
        expect(
          queryClient
            .getQueryData<SessionData>(["session", "test-session"])
            ?.messages.map((message) => message.id),
        ).toEqual(storedMessages(0, 61).map((message) => message.id));
      });
      expect(
        screen.getByRole("button", {
          name: PROJECT_REVIEWER_CONTEXT_LABEL,
        }),
      ).toBeInTheDocument();
    });

    it("preserves a concurrent live commit while an active filter and prepend are in flight", async () => {
      let fireViewEvent!: (data: any) => void;
      let resolveOlder!: (value: Awaited<ReturnType<SessionsAPI["getMessages"]>>) => void;
      vi.mocked(window.sessionsAPI.onViewEvent).mockImplementation((callback) => {
        fireViewEvent = sequencedViewCallback(callback);
        return () => {};
      });
      vi.mocked(window.sessionsAPI.get).mockResolvedValue({
        success: true,
        session: makeSession({ messages: storedMessages(20, 20) }),
        messagePage: { hasMore: true, total: 40 },
      });
      vi.mocked(window.sessionsAPI.getMessages).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveOlder = resolve;
          }),
      );
      const queryClient = makeQueryClient();
      render(<ChatPanel sessionId="test-session" />, { queryClient });
      const user = userEvent.setup();

      await user.click(await screen.findByRole("button", { name: "Filter timeline" }));
      await user.click(screen.getByRole("checkbox", { name: "You" }));
      await user.click(screen.getByRole("checkbox", { name: "Agents & reviewers" }));
      await user.click(screen.getByRole("checkbox", { name: "Goals" }));
      await user.click(screen.getByRole("checkbox", { name: "Runtime" }));
      await user.click(screen.getByRole("checkbox", { name: "System" }));
      await user.keyboard("{Escape}");
      await user.click(screen.getByRole("button", { name: "Load previous 20 messages" }));
      await waitFor(() => expect(window.sessionsAPI.getMessages).toHaveBeenCalledOnce());

      act(() => {
        fireViewEvent({
          sessionId: "test-session",
          type: "session:view",
          view: makeView(),
          committedMessages: [
            {
              ...storedMessages(40, 1)[0],
              role: "assistant",
              content: "Live assistant result",
            },
          ],
        });
      });
      await waitFor(() => {
        expect(screen.getByText("1 of 20")).toBeInTheDocument();
        expect(
          queryClient.getQueryData<SessionData>(["session", "test-session"])?.messages.at(-1)?.id,
        ).toBe("m40");
      });

      await act(async () => {
        resolveOlder({
          success: true,
          messages: storedMessages(0, 20).map((message) => ({
            ...message,
            role: "assistant",
          })),
          hasMore: false,
          total: 41,
        });
      });
      await waitFor(() => {
        expect(screen.getByText("21 of 41")).toBeInTheDocument();
        expect(
          queryClient
            .getQueryData<SessionData>(["session", "test-session"])
            ?.messages.map((message) => message.id),
        ).toEqual(storedMessages(0, 41).map((message) => message.id));
      });
    });

    it("isolates and restores timeline filters across session switches and panel remounts", async () => {
      vi.mocked(window.sessionsAPI.get).mockImplementation(async (sessionId) => ({
        success: true,
        session: makeSession({
          id: sessionId,
          source: "user",
          workspaceName: sessionId === "session-a" ? "Project" : "Scratchpad",
          workspaceIdentity: {
            version: 1,
            device: "1",
            inode: sessionId === "session-a" ? "2" : "3",
            birthtimeNs: "4",
          },
          repositoryAgent:
            sessionId === "session-a"
              ? {
                  name: "Reviewer",
                  path: ".github/agents/reviewer.agent.md",
                  identity: {
                    version: 1,
                    normalizedPath: ".github/agents/reviewer.agent.md",
                    declaredName: "Reviewer",
                    contentDigest: "reviewer-v1",
                  },
                }
              : undefined,
          messages: [
            {
              id: `${sessionId}-message`,
              role: "user",
              content: `Message for ${sessionId}`,
              timestamp: new Date().toISOString(),
            },
          ],
        }),
        messagePage: { hasMore: false, total: 1 },
      }));
      vi.mocked(window.workspaceAPI.listWorkspaces).mockResolvedValue({
        success: true,
        workspaces: ["Project", "Scratchpad"],
        workspaceBindings: [
          {
            name: "Project",
            identity: { version: 1, device: "1", inode: "2", birthtimeNs: "4" },
          },
          {
            name: "Scratchpad",
            identity: { version: 1, device: "1", inode: "3", birthtimeNs: "4" },
          },
        ],
      });
      vi.mocked(window.workspaceAPI.listRepositoryAgents).mockResolvedValue({
        success: true,
        agents: [
          {
            name: "Reviewer",
            path: ".github/agents/reviewer.agent.md",
            identity: {
              version: 1,
              normalizedPath: ".github/agents/reviewer.agent.md",
              declaredName: "Reviewer",
              contentDigest: "reviewer-v1",
            },
          },
        ],
      });
      const onWorkspaceRoleChange = vi
        .fn<NonNullable<ChatPanelProps["onWorkspaceRoleChange"]>>()
        .mockResolvedValue(undefined);
      const { rerender, unmount } = render(
        <ChatPanel sessionId="session-a" onWorkspaceRoleChange={onWorkspaceRoleChange} />,
      );
      const user = userEvent.setup();

      await screen.findByText("Message for session-a");
      await user.click(screen.getByRole("button", { name: "Filter timeline" }));
      await user.click(screen.getByRole("checkbox", { name: "You" }));
      await user.keyboard("{Escape}");
      expect(screen.getByText("No timeline entries match these filters.")).toBeInTheDocument();

      rerender(<ChatPanel sessionId="session-b" onWorkspaceRoleChange={onWorkspaceRoleChange} />);

      expect(await screen.findByText("Message for session-b")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Filter timeline" })).toBeInTheDocument();
      expect(
        screen.queryByText("No timeline entries match these filters."),
      ).not.toBeInTheDocument();

      rerender(<ChatPanel sessionId="session-a" onWorkspaceRoleChange={onWorkspaceRoleChange} />);

      await waitFor(() => {
        expect(screen.getByText("No timeline entries match these filters.")).toBeInTheDocument();
      });

      unmount();
      render(<ChatPanel sessionId="session-a" onWorkspaceRoleChange={onWorkspaceRoleChange} />);

      await waitFor(() => {
        expect(screen.getByText("No timeline entries match these filters.")).toBeInTheDocument();
        expect(
          screen.getByRole("button", { name: "Filter timeline, 1 active" }),
        ).toBeInTheDocument();
      });
    });
  });

  describe("inline questions", () => {
    const question = {
      question: "What should I do next?",
      answers: [{ title: "Retry" }, { title: "Stop" }],
      recommendedIndex: 0,
    };

    it("renders question-only assistant messages from session history", async () => {
      vi.mocked(window.sessionsAPI.getView).mockResolvedValue({
        success: true,
        view: makeView(),
      });
      vi.mocked(window.sessionsAPI.get).mockResolvedValue({
        success: true,
        session: makeSession({
          messages: [
            {
              id: "u1",
              role: "user",
              content: "Help me choose",
              timestamp: new Date().toISOString(),
            },
            {
              id: "a1",
              role: "assistant",
              content: "",
              question,
              timestamp: new Date().toISOString(),
            },
          ],
        }),
      });

      render(<ChatPanel sessionId="test-session" />);

      await waitFor(() => {
        expect(screen.getByTestId("inline-question")).toBeInTheDocument();
      });
      expect(screen.getByText("What should I do next?")).toBeInTheDocument();
      expect(screen.getByText("Retry")).toBeInTheDocument();
      expect(screen.getByText("Stop")).toBeInTheDocument();
    });

    it("renders question-only assistant messages committed from live view events", async () => {
      let fireViewEvent: (data: any) => void;
      vi.mocked(window.sessionsAPI.onViewEvent).mockImplementation((cb) => {
        fireViewEvent = sequencedViewCallback(cb);
        return () => {};
      });
      vi.mocked(window.sessionsAPI.getView).mockResolvedValue({
        success: true,
        view: makeView(),
      });
      vi.mocked(window.sessionsAPI.get).mockResolvedValue({
        success: true,
        session: makeSession({
          messages: [
            {
              id: "u1",
              role: "user",
              content: "Help me choose",
              timestamp: new Date().toISOString(),
            },
          ],
        }),
      });

      render(<ChatPanel sessionId="test-session" />);

      await waitFor(() => {
        expect(screen.getByText("Help me choose")).toBeInTheDocument();
      });

      await act(async () => {
        fireViewEvent({
          sessionId: "test-session",
          type: "session:view",
          view: makeView(),
          committedMessages: [
            {
              id: "a1",
              role: "assistant",
              content: "",
              question,
              timestamp: new Date().toISOString(),
            },
          ],
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId("inline-question")).toBeInTheDocument();
      });
      expect(screen.getByText("What should I do next?")).toBeInTheDocument();
    });
  });

  it("sends raw message without capability prefix (enforcement is backend-side)", async () => {
    render(<ChatPanel sessionId="test-session" />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Describe what you want/)).not.toBeDisabled();
    });
    await setPromptTextDOM("Hello");
    pressInPromptEditor("Enter");

    await waitFor(() => {
      expect(copilotService.send).toHaveBeenCalledWith(
        "Hello",
        "test-session",
        undefined,
        expect.any(String),
      );
    });
  }, 15_000);

  it("keeps an undelivered message as not sent, persisted, and retryable", async () => {
    vi.mocked(copilotService.send).mockRejectedValueOnce({
      code: "TEST_POJO_ERROR",
      message: "Synthetic object error for chat UI testing",
    });
    render(<ChatPanel sessionId="test-session" />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Describe what you want/)).not.toBeDisabled();
    });
    await setPromptTextDOM("Hello");
    pressInPromptEditor("Enter");

    const unsent = await screen.findByTestId("message-unsent");
    expect(unsent).toHaveTextContent("Hello");
    expect(unsent).toHaveTextContent("Not sent.");
    expect(unsent).toHaveTextContent("Synthetic object error for chat UI testing");
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
    expect(window.localStorage.getItem("marshal.chat.unsent.v1")).toContain('"text":"Hello"');

    const sendsBeforeRetry = vi.mocked(copilotService.send).mock.calls.length;
    await userEvent.setup().click(screen.getByTestId("unsent-retry"));
    await waitFor(() => {
      expect(copilotService.send).toHaveBeenCalledTimes(sendsBeforeRetry + 1);
      expect(screen.queryByTestId("message-unsent")).not.toBeInTheDocument();
    });
    expect(copilotService.send).toHaveBeenLastCalledWith(
      "Hello",
      "test-session",
      undefined,
      expect.any(String),
    );
    expect(window.localStorage.getItem("marshal.chat.unsent.v1")).toBeNull();
  });

  it("removes a cancelled optimistic turn without leaving an error or ghost", async () => {
    vi.mocked(copilotService.send).mockRejectedValueOnce(
      new DOMException("The operation was aborted", "AbortError"),
    );
    const queryClient = makeQueryClient();
    render(<ChatPanel sessionId="test-session" />, { queryClient });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Describe what you want/)).not.toBeDisabled();
    });
    await setPromptTextDOM("Cancelled message");
    pressInPromptEditor("Enter");

    await waitFor(() => {
      expect(copilotService.send).toHaveBeenCalled();
      expect(screen.queryByText("Cancelled message")).not.toBeInTheDocument();
      expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
      expect(
        queryClient
          .getQueryData<SessionData>(["session", "test-session"])
          ?.messages.some((message) => message.optimistic === true),
      ).toBe(false);
    });
  });

  it("never injects DISABLED CAPABILITIES into prompt text", async () => {
    render(<ChatPanel sessionId="test-session" />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Describe what you want/)).not.toBeDisabled();
    });
    await setPromptTextDOM("Check my emails");
    pressInPromptEditor("Enter");

    await waitFor(() => {
      expect(copilotService.send).toHaveBeenCalledWith(
        "Check my emails",
        "test-session",
        undefined,
        expect.any(String),
      );
    });
  }, 15_000);

  it("blocks new submits while Stop cancellation is pending", async () => {
    const user = userEvent.setup();
    let resolveAbort!: () => void;
    const abortPromise = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    vi.mocked(copilotService.send).mockClear();
    vi.mocked(copilotService.abort).mockClear();
    vi.mocked(copilotService.abort).mockImplementation(() => abortPromise);
    vi.mocked(window.sessionsAPI.getView).mockResolvedValue({
      success: true,
      view: makeView({ status: "streaming" }),
    });

    render(<ChatPanel sessionId="test-session" />);

    const stopButton = await screen.findByTestId("stop-btn");
    await user.click(stopButton);
    await waitFor(() => expect(stopButton).toBeDisabled());
    expect(stopButton).toHaveAccessibleName("Cancelling");
    expect(stopButton).toHaveAttribute("aria-busy", "true");
    expect(copilotService.abort).toHaveBeenCalledExactlyOnceWith("test-session");

    await setPromptTextDOM("send after stop finishes");
    pressInPromptEditor("Enter");

    expect(copilotService.send).not.toHaveBeenCalled();
    expect(promptEditorText()).toBe("send after stop finishes");

    await act(async () => {
      resolveAbort();
      await abortPromise;
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId("send-btn")).toBeEnabled());
  });

  it("keeps cancellation state scoped to the session while navigation changes", async () => {
    const user = userEvent.setup();
    let resolveAbort!: () => void;
    const abortPromise = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    vi.mocked(copilotService.abort).mockClear();
    vi.mocked(copilotService.abort).mockImplementation(() => abortPromise);
    vi.mocked(window.sessionsAPI.getView).mockImplementation(async (sessionId) => ({
      success: true,
      view: makeView({ status: sessionId === "session-a" ? "streaming" : "ready" }),
    }));

    const { rerender } = render(<ChatPanel sessionId="session-a" />);
    await user.click(await screen.findByTestId("stop-btn"));
    await waitFor(() => expect(screen.getByTestId("stop-btn")).toHaveAccessibleName("Cancelling"));

    rerender(<ChatPanel sessionId="session-b" />);
    await waitFor(() => expect(screen.getByTestId("send-btn")).toHaveAccessibleName("Send"));

    rerender(<ChatPanel sessionId="session-a" />);
    await waitFor(() => expect(screen.getByTestId("stop-btn")).toHaveAccessibleName("Cancelling"));

    await act(async () => {
      resolveAbort();
      await abortPromise;
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId("stop-btn")).toHaveAccessibleName("Stop"));
    expect(copilotService.abort).toHaveBeenCalledExactlyOnceWith("session-a");
  });

  describe("tool status and streaming", () => {
    let fireViewEvent: (data: any) => void;

    function fireView(
      sessionId: string,
      viewOverrides: Partial<SessionView>,
      committedMessages: any[] = [],
    ) {
      fireViewEvent({
        sessionId,
        type: "session:view",
        view: makeView(viewOverrides),
        committedMessages,
      });
    }

    async function sendMessage(
      _user: ReturnType<typeof userEvent.setup>,
      sessionId = "test-session",
    ) {
      render(<ChatPanel sessionId={sessionId} />);
      // Let the initial getView/session queries finish before firing view events.
      await waitFor(() =>
        expect(screen.getByPlaceholderText(/Describe what you want/)).not.toBeDisabled(),
      );
      await setPromptTextDOM("Hello");
      pressInPromptEditor("Enter");
      await act(async () => {
        fireView(sessionId, { status: "submitted" });
      });
    }

    async function holdSendButtonToQueue(user: ReturnType<typeof userEvent.setup>): Promise<void> {
      const button = screen.getByTestId("send-btn");
      await user.pointer([{ target: button, keys: "[MouseLeft>]" }]);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 510));
      });
      await user.pointer([{ target: button, keys: "[/MouseLeft]" }]);
    }

    beforeEach(() => {
      vi.mocked(window.sessionsAPI.onViewEvent).mockImplementation((cb) => {
        fireViewEvent = sequencedViewCallback(cb);
        return () => {};
      });
      vi.mocked(window.sessionsAPI.getView).mockResolvedValue({
        success: true,
        view: makeView(),
      });
    });

    it("shows assistant avatar after view enters non-ready state", async () => {
      const user = userEvent.setup();
      await sendMessage(user);
      await waitFor(() => {
        expect(screen.getAllByTestId("message-assistant").length).toBe(1);
      });
      expect(screen.getAllByTestId("assistant-run-avatar").length).toBeGreaterThanOrEqual(1);
      expect(
        within(screen.getByTestId("timeline-virtual-list")).queryByTestId("live-turn"),
      ).not.toBeInTheDocument();
      expect(screen.getByTestId("live-turn")).toBeInTheDocument();
    });

    it("shows Thinking or Working indicator after view enters non-ready state", async () => {
      const user = userEvent.setup();
      await sendMessage(user);
      await waitFor(() => {
        expect(screen.getByText(/Thinking|Working/)).toBeInTheDocument();
      });
    });

    it("shows tool status while tool is running", async () => {
      const user = userEvent.setup();
      await sendMessage(user);
      await act(async () => {
        fireView("test-session", {
          status: "streaming",
          toolStatuses: [
            { id: "t1", name: "grep", description: 'Searching for "auth"', running: true },
          ],
        });
      });
      await waitFor(() => {
        expect(screen.getByText(/Searching for "auth"/)).toBeInTheDocument();
      });
      expect(screen.getAllByTestId("assistant-run-avatar").length).toBeGreaterThanOrEqual(1);
    });

    it("expands live tool input and output details", async () => {
      const user = userEvent.setup();
      await sendMessage(user);
      await act(async () => {
        fireView("test-session", {
          status: "streaming",
          toolStatuses: [
            {
              id: "t1",
              name: "read_file",
              description: "Reading package.json",
              running: false,
              input: '{\n  "path": "package.json"\n}',
              output: "file contents",
              success: true,
            },
          ],
        });
      });

      await user.click(await screen.findByTestId("tool-status-toggle"));
      await user.click(screen.getByTestId("tool-status-row-toggle"));

      expect(screen.getByTestId("live-tool-detail-input")).toHaveTextContent("package.json");
      expect(screen.getByTestId("live-tool-detail-output")).toHaveTextContent("file contents");
    });

    it("keeps a dismissed live tool error hidden after the message commits", async () => {
      const user = userEvent.setup();
      await sendMessage(user);
      await act(async () => {
        fireView("test-session", {
          status: "streaming",
          toolStatuses: [
            {
              id: "tool-failed",
              name: "shell",
              description: "Run tests",
              running: false,
              success: false,
              error: "Command failed",
            },
          ],
        });
      });

      await user.click(await screen.findByTestId("tool-status-toggle"));
      await user.click(screen.getByRole("button", { name: "Dismiss tool error" }));
      expect(screen.queryByText("Run tests")).not.toBeInTheDocument();

      await act(async () => {
        fireViewEvent({
          sessionId: "test-session",
          type: "session:view",
          view: makeView({ status: "ready" }),
          committedMessages: [
            {
              id: "assistant-error",
              role: "assistant",
              content: "The command failed.",
              timestamp: new Date().toISOString(),
              toolCalls: [
                {
                  id: "tool-failed",
                  name: "shell",
                  description: "Run tests",
                  success: false,
                  error: "Command failed",
                },
              ],
            },
          ],
        });
      });

      expect(await screen.findByText("The command failed.")).toBeInTheDocument();
      expect(screen.queryByText("Run tests")).not.toBeInTheDocument();
    });

    it("preserves a cancelled outcome from SessionView through LiveTurn", async () => {
      const user = userEvent.setup();
      await sendMessage(user);
      await act(async () => {
        fireView("test-session", {
          status: "streaming",
          toolStatuses: [
            {
              id: "tool-cancelled",
              name: "browser_click",
              description: "Using playwright",
              activityKind: "mutation",
              running: false,
              success: false,
              cancelled: true,
              error: "Operation cancelled",
            },
          ],
        });
      });

      await waitFor(() => {
        expect(screen.getByText("1 step cancelled")).toBeInTheDocument();
      });
      await user.click(screen.getByTestId("tool-status-toggle"));
      expect(screen.getByText("Cancelled")).toBeInTheDocument();
      expect(screen.queryByText(/^Done$/)).not.toBeInTheDocument();
    });

    it("shows tool status during streaming if tool still running", async () => {
      const user = userEvent.setup();
      await sendMessage(user);
      await act(async () => {
        fireView("test-session", {
          status: "streaming",
          streamingText: "Checking...",
          toolStatuses: [
            {
              id: "t1",
              name: "fetch_report",
              description: "Fetching the weekly report",
              running: true,
            },
          ],
        });
      });
      await waitFor(() => {
        expect(screen.getByText("Fetching the weekly report")).toBeInTheDocument();
        expect(screen.getByText("Checking...")).toBeInTheDocument();
      });
    });

    it("keeps tool status visible after tools finish (until turn ends)", async () => {
      const user = userEvent.setup();
      await sendMessage(user);
      await act(async () => {
        fireView("test-session", {
          status: "streaming",
          streamingText: "Found it",
          toolStatuses: [
            { id: "t1", name: "grep", description: 'Searching for "auth"', running: false },
          ],
        });
      });
      await waitFor(() => {
        expect(screen.getByText(/Searched for "auth"/)).toBeInTheDocument();
        expect(screen.getByText("Found it")).toBeInTheDocument();
      });
    });

    it("shows tool status for events with any toolCallId (no duplicate filtering needed)", async () => {
      const user = userEvent.setup();
      await sendMessage(user);
      await act(async () => {
        fireView("test-session", {
          status: "streaming",
          toolStatuses: [
            { id: "real-id", name: "fetch_report", description: "Fetching the weekly report", running: true },
          ],
        });
      });
      await user.click(await screen.findByTestId("tool-status-toggle"));
      await waitFor(() => {
        expect(screen.getAllByTestId("tool-status-line").length).toBe(1);
      });
    });

    it("applies shimmer animation to ALL running tools", async () => {
      const user = userEvent.setup();
      await sendMessage(user);
      await act(async () => {
        fireView("test-session", {
          status: "streaming",
          toolStatuses: [
            { id: "t1", name: "grep", description: 'Searching for "a"', running: true },
            { id: "t2", name: "view", description: "Reading b.ts", running: true },
          ],
        });
      });
      await user.click(await screen.findByTestId("tool-status-toggle"));
      await waitFor(() => {
        expect(screen.getAllByTestId("tool-status-shimmer").length).toBe(2);
      });
    });

    it("removes shimmer from finished tool", async () => {
      const user = userEvent.setup();
      await sendMessage(user);
      await act(async () => {
        fireView("test-session", {
          status: "streaming",
          toolStatuses: [
            { id: "t1", name: "grep", description: 'Searching for "a"', running: true },
            { id: "t2", name: "view", description: "Reading b.ts", running: true },
          ],
        });
      });
      await user.click(await screen.findByTestId("tool-status-toggle"));
      await act(async () => {
        fireView("test-session", {
          status: "streaming",
          toolStatuses: [
            { id: "t1", name: "grep", description: 'Searching for "a"', running: false },
            { id: "t2", name: "view", description: "Reading b.ts", running: true },
          ],
        });
      });
      await waitFor(() => {
        expect(screen.getAllByTestId("tool-status-shimmer").length).toBe(1);
      });
    });

    it("shows all tool status lines from session:view", async () => {
      const user = userEvent.setup();
      await sendMessage(user);
      await act(async () => {
        fireView("test-session", {
          status: "streaming",
          toolStatuses: [
            { id: "t1", name: "view", description: "Reading a.ts", running: true },
            { id: "t2", name: "view", description: "Reading b.ts", running: true },
            { id: "t3", name: "view", description: "Reading c.ts", running: true },
            { id: "t4", name: "edit", description: "Editing d.ts", running: true },
          ],
        });
      });
      await user.click(await screen.findByTestId("tool-status-toggle"));
      await waitFor(() => {
        expect(screen.getByText(/Reading a.ts/)).toBeInTheDocument();
        expect(screen.getByText(/Reading b.ts/)).toBeInTheDocument();
        expect(screen.getByText(/Reading c.ts/)).toBeInTheDocument();
        expect(screen.getAllByText(/Editing d.ts/).length).toBeGreaterThan(0);
      });
    });

    it("shows streaming bubble when streamingText arrives via view", async () => {
      const user = userEvent.setup();
      await sendMessage(user);
      await act(async () => {
        fireView("test-session", {
          status: "streaming",
          streamingText: "Hello!",
        });
      });
      await waitFor(() => {
        expect(screen.getByText("Hello!")).toBeInTheDocument();
      });
    });

    it("no empty bubble when streaming content is only whitespace", async () => {
      const user = userEvent.setup();
      await sendMessage(user);
      await act(async () => {
        fireView("test-session", {
          status: "streaming",
          streamingText: "\n\n",
        });
      });
      await waitFor(() => {
        expect(screen.getByText(/Working/)).toBeInTheDocument();
      });
      const assistantMessages = screen.getAllByTestId("message-assistant");
      const lastAssistant = assistantMessages[assistantMessages.length - 1];
      expect(within(lastAssistant).queryByTestId("message-text")).toBeNull();
    });

    it("ignores events for a different session", async () => {
      const user = userEvent.setup();
      await sendMessage(user);
      await act(async () => {
        fireView("other-session", {
          status: "streaming",
          toolStatuses: [
            { id: "t1", name: "grep", description: 'Searching for "secret"', running: true },
          ],
        });
      });
      expect(screen.queryByText(/Searching for "secret"/)).not.toBeInTheDocument();
    });

    it("clears tool status when view goes to ready", async () => {
      const user = userEvent.setup();
      await sendMessage(user);
      await act(async () => {
        fireView("test-session", {
          status: "streaming",
          toolStatuses: [
            { id: "t1", name: "grep", description: 'Searching for "test"', running: true },
          ],
        });
      });
      await act(async () => {
        fireView("test-session", { status: "ready" });
      });
      await waitFor(() => {
        expect(screen.queryByText(/Searching for "test"/)).not.toBeInTheDocument();
      });
    });

    it("view ready clears assistant waiting row completely", async () => {
      const user = userEvent.setup();
      await sendMessage(user);
      await act(async () => {
        fireView("test-session", {
          status: "streaming",
          streamingText: "Done",
        });
      });
      await act(async () => {
        fireView("test-session", { status: "ready" }, [
          {
            id: "m1",
            role: "assistant",
            content: "Done",
            timestamp: new Date().toISOString(),
          },
        ]);
      });
      await waitFor(() => {
        expect(screen.queryByText(/Working/)).not.toBeInTheDocument();
      });
    });

    it("stays in waiting state when multiple streaming view events arrive", async () => {
      const user = userEvent.setup();
      await sendMessage(user);

      await act(async () => {
        fireView("test-session", { status: "streaming", streamingText: "Thinking..." });
      });
      await waitFor(() => {
        expect(screen.getByText("Thinking...")).toBeInTheDocument();
      });
      expect(screen.getByPlaceholderText(/Steer this turn/)).toBeInTheDocument();

      await act(async () => {
        fireView("test-session", { status: "streaming", streamingText: "Working on it..." });
      });
      await waitFor(() => {
        expect(screen.getByText("Working on it...")).toBeInTheDocument();
      });
      expect(screen.getByPlaceholderText(/Steer this turn/)).toBeInTheDocument();

      await act(async () => {
        fireView("test-session", { status: "streaming", streamingText: "Almost done..." });
      });
      await waitFor(() => {
        expect(screen.getByText("Almost done...")).toBeInTheDocument();
      });
      expect(screen.getByPlaceholderText(/Steer this turn/)).toBeInTheDocument();
    });

    it("queues a message when Send is held while streaming", async () => {
      const user = userEvent.setup();
      await sendMessage(user);
      await act(async () => {
        fireView("test-session", { status: "streaming", streamingText: "..." });
      });
      vi.mocked(copilotService.send).mockClear();
      vi.mocked(copilotService.steer).mockClear();
      vi.mocked(copilotService.abort).mockClear();

      await setPromptTextDOM("queued message");
      await holdSendButtonToQueue(user);

      expect(copilotService.send).not.toHaveBeenCalled();
      expect(copilotService.steer).not.toHaveBeenCalled();
      expect(copilotService.abort).not.toHaveBeenCalled();
      const queued = await screen.findByTestId("queued-message");
      expect(queued).toHaveTextContent("queued message");
    });

    it("drains a queued message when the running turn finishes", async () => {
      const user = userEvent.setup();
      await sendMessage(user);
      await act(async () => {
        fireView("test-session", { status: "streaming", streamingText: "..." });
      });
      await setPromptTextDOM("queued message");
      await holdSendButtonToQueue(user);
      await screen.findByTestId("queued-message");

      vi.mocked(copilotService.send).mockClear();
      // Turn completes -> session idle -> queue drains.
      await act(async () => {
        fireView("test-session", { status: "ready" });
      });

      await waitFor(() => {
        expect(copilotService.send).toHaveBeenCalledWith(
          "queued message",
          "test-session",
          undefined,
          expect.any(String),
        );
      });
    });

    it("steers atomically on Enter while running", async () => {
      const user = userEvent.setup();
      await sendMessage(user);
      await act(async () => {
        fireView("test-session", { status: "streaming", streamingText: "..." });
      });
      vi.mocked(copilotService.send).mockClear();
      vi.mocked(copilotService.steer).mockClear();
      vi.mocked(copilotService.abort).mockClear();

      await setPromptTextDOM("steer now");
      await act(async () => {
        pressInPromptEditor("Enter");
      });

      await waitFor(() => {
        expect(copilotService.steer).toHaveBeenCalledWith(
          "steer now",
          "test-session",
          undefined,
          expect.any(String),
        );
      });
      expect(
        screen
          .getAllByTestId("message-user")
          .some((message) => within(message).queryByText("steer now") !== null),
      ).toBe(false);

      const clientMessageId = vi.mocked(copilotService.steer).mock.calls[0]?.[3];
      if (!clientMessageId) throw new Error("steer did not receive a client message id");
      await act(async () => {
        fireView("test-session", { status: "submitted" }, [
          {
            id: clientMessageId,
            role: "user",
            content: "steer now",
            timestamp: new Date().toISOString(),
          },
        ]);
      });

      await waitFor(() => {
        expect(
          screen
            .getAllByTestId("message-user")
            .some((message) => within(message).queryByText("steer now") !== null),
        ).toBe(true);
      });
      expect(copilotService.abort).not.toHaveBeenCalled();
      expect(copilotService.send).not.toHaveBeenCalled();
    });
  });

  describe("send target capture", () => {
    let fireViewEvent: (data: any) => void;

    beforeEach(() => {
      vi.mocked(window.sessionsAPI.onViewEvent).mockImplementation((cb) => {
        fireViewEvent = sequencedViewCallback(cb);
        return () => {};
      });
      vi.mocked(window.sessionsAPI.getView).mockResolvedValue({
        success: true,
        view: makeView(),
      });
      vi.mocked(copilotService.send).mockResolvedValue(undefined);
      vi.mocked(copilotService.abort).mockResolvedValue(undefined);
      vi.mocked(copilotService.saveImage).mockResolvedValue("/tmp/img.png");
    });

    it("sends to the clicked session when navigation happens before async attachments finish", async () => {
      const user = userEvent.setup();
      let resolveSaveImage: (path: string) => void = () => {};
      vi.mocked(copilotService.saveImage).mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveSaveImage = resolve;
          }),
      );

      const { rerender } = render(<ChatPanel sessionId="session-a" />);
      await waitFor(() =>
        expect(screen.getByPlaceholderText(/Describe what you want/)).not.toBeDisabled(),
      );
      await user.upload(
        screen.getByTestId("chat-file-input"),
        new File(["fakedata"], "shot.png", { type: "image/png" }),
      );
      await waitFor(() => {
        expect(
          within(screen.getByTestId("visible-row")).getByTestId("file-preview-img"),
        ).toBeInTheDocument();
      });
      await setPromptTextDOM("message for session A");

      await user.click(screen.getByTestId("send-btn"));
      rerender(<ChatPanel sessionId="session-b" />);
      await waitFor(() => expect(copilotService.saveImage).toHaveBeenCalled());

      act(() => resolveSaveImage("/tmp/captured.png"));

      await waitFor(() => {
        expect(copilotService.send).toHaveBeenCalledWith(
          "message for session A",
          "session-a",
          [
            {
              type: "file",
              path: "/tmp/captured.png",
              displayName: "shot.png",
            },
          ],
          expect.any(String),
        );
      });
      expect(vi.mocked(copilotService.send).mock.calls.some(([, sid]) => sid === "session-b")).toBe(
        false,
      );
    });

    it("sends a plain message to the clicked session when navigation happens immediately after send", async () => {
      const user = userEvent.setup();
      const { rerender } = render(<ChatPanel sessionId="session-a" />);
      await waitFor(() =>
        expect(screen.getByPlaceholderText(/Describe what you want/)).not.toBeDisabled(),
      );
      await setPromptTextDOM("plain message for session A");

      await user.click(screen.getByTestId("send-btn"));
      rerender(<ChatPanel sessionId="session-b" />);

      await waitFor(() => {
        expect(copilotService.send).toHaveBeenCalledWith(
          "plain message for session A",
          "session-a",
          undefined,
          expect.any(String),
        );
      });
      expect(vi.mocked(copilotService.send).mock.calls.some(([, sid]) => sid === "session-b")).toBe(
        false,
      );
    });

    it("steers the clicked session when navigation happens before steer resolves", async () => {
      let resolveSteer: () => void = () => {};
      vi.mocked(copilotService.steer).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSteer = resolve;
          }),
      );

      const { rerender } = render(<ChatPanel sessionId="session-a" />);
      await waitFor(() =>
        expect(screen.getByPlaceholderText(/Describe what you want/)).not.toBeDisabled(),
      );
      await act(async () => {
        fireViewEvent({
          sessionId: "session-a",
          type: "session:view",
          view: makeView({ status: "streaming", streamingText: "..." }),
          committedMessages: [],
        });
      });

      await setPromptTextDOM("steer session A");
      await act(async () => {
        pressInPromptEditor("Enter", { ctrlKey: true });
      });
      await waitFor(() => {
        expect(copilotService.steer).toHaveBeenCalledWith(
          "steer session A",
          "session-a",
          undefined,
          expect.any(String),
        );
      });

      rerender(<ChatPanel sessionId="session-b" />);
      act(() => resolveSteer());

      expect(
        vi.mocked(copilotService.steer).mock.calls.some(([, sid]) => sid === "session-b"),
      ).toBe(false);
    });
  });

  describe("attachment popover", () => {
    it("keeps the default plus button as file upload without runtime UI extensions", async () => {
      render(<ChatPanel sessionId="test-session" />);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Upload file" })).toBeInTheDocument();
      });
      expect(screen.queryByText("Review on screen")).toBeNull();
      expect(screen.queryByText("Capture screen")).toBeNull();
    });

    it("opens the file picker directly from the default add-content button", async () => {
      const user = userEvent.setup();
      render(<ChatPanel sessionId="test-session" />);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Upload file" })).toBeInTheDocument();
      });
      const input = screen.getByTestId<HTMLInputElement>("chat-file-input");
      const click = vi.spyOn(input, "click");

      await user.click(screen.getByRole("button", { name: "Upload file" }));

      expect(click).toHaveBeenCalledOnce();
    });
  });

  describe("copy button", () => {
    let fireViewEvent: (data: any) => void;
    let mockWriteText: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      vi.mocked(window.sessionsAPI.onViewEvent).mockImplementation((cb) => {
        fireViewEvent = sequencedViewCallback(cb);
        return () => {};
      });
      vi.mocked(window.sessionsAPI.getView).mockResolvedValue({
        success: true,
        view: makeView(),
      });
      mockWriteText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: mockWriteText },
        writable: true,
        configurable: true,
      });
    });

    async function renderWithAssistantMessage(content = "Hello from assistant") {
      const user = userEvent.setup();
      render(<ChatPanel sessionId="test-session" />);
      await waitFor(() =>
        expect(screen.getByPlaceholderText(/Describe what you want/)).not.toBeDisabled(),
      );
      await setPromptTextDOM("Hi");
      pressInPromptEditor("Enter");
      await act(async () => {
        fireViewEvent({
          sessionId: "test-session",
          type: "session:view",
          view: makeView({ status: "ready" }),
          committedMessages: [
            {
              id: "m1",
              role: "assistant",
              content,
              timestamp: new Date().toISOString(),
            },
          ],
        });
      });
      // Only wait for visible content; whitespace-only content has no visible row.
      const trimmed = content.trim();
      if (trimmed) await screen.findByText(content);
      return user;
    }

    it("renders copy button for assistant message with text content", async () => {
      await renderWithAssistantMessage();
      await waitFor(() => {
        const btns = screen.getAllByTestId("copy-message-btn");
        expect(btns.length).toBeGreaterThanOrEqual(1);
      });
    });

    it("calls navigator.clipboard.writeText with message content on click", async () => {
      await renderWithAssistantMessage("Hello from assistant");
      const writeTextSpy = vi
        .spyOn<typeof navigator.clipboard, "writeText">(navigator.clipboard, "writeText")
        .mockResolvedValue(undefined);
      const clicker = userEvent.setup();
      const copyBtn = within(screen.getByTestId("message-assistant")).getByTestId(
        "copy-message-btn",
      );
      await clicker.click(copyBtn);
      await waitFor(() => {
        expect(writeTextSpy).toHaveBeenCalledWith("Hello from assistant");
      });
    });

    it("shows Copied label after clicking copy button", async () => {
      await renderWithAssistantMessage("Hello from assistant");
      const clicker = userEvent.setup();
      const copyBtn = within(screen.getByTestId("message-assistant")).getByTestId(
        "copy-message-btn",
      );
      await clicker.click(copyBtn);
      await waitFor(() => {
        expect(copyBtn).toHaveAttribute("aria-label", "Copied");
      });
    });

    // eslint-disable-next-line vitest/expect-expect -- whitespace rows may or may not render; assertion is conditional below
    it("does not render copy button for assistant messages with empty content", async () => {
      await renderWithAssistantMessage("   ");
      const assistantMsg = screen.queryByTestId("message-assistant");
      // eslint-disable-next-line vitest/no-conditional-expect -- premise differs by platform
      if (assistantMsg) expect(screen.queryByTestId("copy-message-btn")).not.toBeInTheDocument();
    });
  });

  describe("token usage display", () => {
    let fireViewEvent: (data: any) => void;

    beforeEach(() => {
      vi.mocked(window.sessionsAPI.onViewEvent).mockImplementation((cb) => {
        fireViewEvent = sequencedViewCallback(cb);
        return () => {};
      });
      vi.mocked(window.sessionsAPI.getView).mockResolvedValue({
        success: true,
        view: makeView(),
      });
    });

    it("shows token usage when view includes tokenUsage", async () => {
      render(<ChatPanel sessionId="test-session" />);
      await waitFor(() =>
        expect(screen.getByPlaceholderText(/Describe what you want/)).not.toBeDisabled(),
      );
      await setPromptTextDOM("Hello");
      pressInPromptEditor("Enter");

      await act(async () => {
        fireViewEvent({
          sessionId: "test-session",
          type: "session:view",
          view: makeView({
            status: "ready",
            tokenUsage: { currentTokens: 5000, tokenLimit: 200000 },
          }),
          committedMessages: [
            {
              id: "m1",
              role: "assistant",
              content: "Hi!",
              timestamp: new Date().toISOString(),
            },
          ],
        });
      });

      await waitFor(() => {
        expect(screen.getByText("5K/200K")).toBeInTheDocument();
      });
    });

    it("shows token usage from initial getView on session load", async () => {
      vi.mocked(window.sessionsAPI.getView).mockResolvedValue({
        success: true,
        view: makeView({ tokenUsage: { currentTokens: 120000, tokenLimit: 1000000 } }),
      });
      window.sessionsAPI.get = vi.fn<SessionsAPI["get"]>().mockResolvedValue({
        success: true,
        session: {
          id: "test-session",
          name: "Test",
          messages: [
            { id: "1", role: "assistant", content: "Hello", timestamp: new Date().toISOString() },
          ],
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: true,
        },
      });

      render(<ChatPanel sessionId="test-session" />);

      await waitFor(() => {
        expect(screen.getByText("120K/1M")).toBeInTheDocument();
      });
    });

    it("token usage persists after clearChat (view is owned by main process)", async () => {
      vi.mocked(window.sessionsAPI.getView).mockResolvedValue({
        success: true,
        view: makeView({ tokenUsage: { currentTokens: 50000, tokenLimit: 200000 } }),
      });

      const ref = createRef<import("./ChatPanel").ChatPanelRef>();
      render(<ChatPanel ref={ref} sessionId="test-session" />);

      await waitFor(() => {
        expect(screen.getByText("50K/200K")).toBeInTheDocument();
      });

      // clearChat resets messages, but token usage still comes from the main-process view.
      act(() => ref.current!.clearChat());
      expect(screen.getByText("50K/200K")).toBeInTheDocument();
    });
  });

  describe("prompt history", () => {
    async function renderAndSendPrompt(sessionId = "test-session", prompt = "first message") {
      const user = userEvent.setup();
      const ref = createRef<import("./ChatPanel").ChatPanelRef>();
      const { rerender } = render(<ChatPanel ref={ref} sessionId={sessionId} />);
      await waitFor(() =>
        expect(screen.getByPlaceholderText(/Describe what you want/)).not.toBeDisabled(),
      );
      await setPromptTextDOM(prompt);
      pressInPromptEditor("Enter");
      await waitFor(() => expect(promptEditorText()).toBe(""));
      return { ref, rerender, user };
    }

    it("ArrowUp recalls the last sent prompt (hook wired up)", async () => {
      const { user } = await renderAndSendPrompt();
      await user.keyboard("{ArrowUp}");
      expect(promptEditorText()).toBe("first message");
    });

    it("clearChat() clears prompt history so ArrowUp no longer recalls previous prompts", async () => {
      const { ref, user } = await renderAndSendPrompt();
      act(() => ref.current!.clearChat());
      await user.keyboard("{ArrowUp}");
      expect(promptEditorText()).toBe("");
    });

    it("ArrowUp recalls user prompts from a previously saved session (seeded from session file)", async () => {
      window.sessionsAPI.get = vi.fn<SessionsAPI["get"]>().mockResolvedValue({
        success: true,
        session: {
          id: "test-session",
          name: "Old chat",
          messages: [
            { id: "1", role: "user", content: "older prompt", timestamp: new Date().toISOString() },
            { id: "2", role: "assistant", content: "reply", timestamp: new Date().toISOString() },
            { id: "3", role: "user", content: "newer prompt", timestamp: new Date().toISOString() },
          ],
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: true,
        },
      });
      const user = userEvent.setup();
      render(<ChatPanel sessionId="test-session" />);
      await screen.findByText("older prompt");
      await screen.findByText("newer prompt");
      await user.click(getPromptEditor());
      await user.keyboard("{ArrowUp}");
      expect(promptEditorText()).toBe("newer prompt");
      await user.keyboard("{ArrowUp}");
      expect(promptEditorText()).toBe("older prompt");
    });

    it("excludes lifecycle and agent-delivery turns from human prompt history", async () => {
      const fence = {
        goalId: "goal-1",
        epoch: 1,
      };
      window.sessionsAPI.get = vi.fn<SessionsAPI["get"]>().mockResolvedValue({
        success: true,
        session: {
          id: "test-session",
          name: "Goal chat",
          source: "user",
          workspaceName: "Project",
          workspaceIdentity: {
            version: 1,
            device: "1",
            inode: "2",
            birthtimeNs: "3",
          },
          repositoryAgent: {
            name: "Reviewer",
            path: ".github/agents/reviewer.agent.md",
            identity: {
              version: 1,
              normalizedPath: ".github/agents/reviewer.agent.md",
              declaredName: "Reviewer",
              contentDigest: "reviewer-v1",
            },
          },
          messages: [
            { id: "1", role: "user", content: "older prompt", timestamp: new Date().toISOString() },
            {
              id: "2",
              role: "system",
              content: "Goal started: Ship",
              timestamp: new Date().toISOString(),
              goalTimelineEvent: { type: "goal.declared", fence, objective: "Ship" },
            },
            {
              id: "3",
              role: "user",
              content: "[GOAL CONTINUATION] private control prompt",
              timestamp: new Date().toISOString(),
              goalContinuation: true,
              internalControl: {
                kind: "goal-continuation",
                exchangeId: "goal-continuation:goal-1:1",
                side: "request",
              },
              goalTimelineEvent: {
                type: "goal.continuation",
                fence,
                sequence: 1,
                verification: false,
                resumeTrigger: {
                  kind: "initial-pursuit",
                  reason: "Start autonomous pursuit.",
                  occurredAt: new Date().toISOString(),
                },
                durableMilestone: {},
                agent: {
                  sessionId: "test-session",
                  source: "assistant",
                  sourceLabel: "Primary agent",
                },
              },
            },
            {
              id: "3-response",
              role: "assistant",
              content: "Reproduced the defect and captured the failing command output.",
              timestamp: new Date().toISOString(),
              internalControl: {
                kind: "goal-continuation",
                exchangeId: "goal-continuation:goal-1:1",
                side: "response",
              },
            },
            {
              id: "4",
              role: "user",
              content: "Message from subagent Worker (child-1):\n\nDone",
              timestamp: new Date().toISOString(),
              agentMessage: {
                source: "child-1",
                sourceLabel: "Worker",
                kind: "parent",
                deliveryMode: "queue",
                sequence: 1,
                sourceSessionSource: "subagent",
              },
            },
            { id: "5", role: "user", content: "newer prompt", timestamp: new Date().toISOString() },
          ],
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: true,
        },
      });
      vi.mocked(window.workspaceAPI.listWorkspaces).mockResolvedValue({
        success: true,
        workspaces: ["Project"],
        workspaceBindings: [
          {
            name: "Project",
            identity: { version: 1, device: "1", inode: "2", birthtimeNs: "3" },
          },
        ],
      });
      vi.mocked(window.workspaceAPI.listRepositoryAgents).mockResolvedValue({
        success: true,
        agents: [
          {
            name: "Reviewer",
            path: ".github/agents/reviewer.agent.md",
            identity: {
              version: 1,
              normalizedPath: ".github/agents/reviewer.agent.md",
              declaredName: "Reviewer",
              contentDigest: "reviewer-v1",
            },
          },
        ],
      });
      const user = userEvent.setup();
      render(
        <ChatPanel
          sessionId="test-session"
          onWorkspaceRoleChange={vi
            .fn<NonNullable<ChatPanelProps["onWorkspaceRoleChange"]>>()
            .mockResolvedValue(undefined)}
        />,
      );
      await screen.findByText("newer prompt");
      expect(
        screen.getByRole("button", {
          name: PROJECT_REVIEWER_CONTEXT_LABEL,
        }),
      ).toBeInTheDocument();
      const boundaryText = screen
        .getAllByTestId("timeline-boundary")
        .map((boundary) => boundary.textContent ?? "");
      const declarationIndex = boundaryText.findIndex((text) => text.includes("Goal started"));
      const continuationIndex = boundaryText.findIndex((text) =>
        text.includes("Goal continuation 1"),
      );
      expect(declarationIndex).toBeGreaterThanOrEqual(0);
      expect(continuationIndex).toBeGreaterThan(declarationIndex);
      expect(boundaryText.some((text) => text.includes("Handled by Primary agent"))).toBe(true);
      expect(boundaryText.some((text) => text.includes("From Worker"))).toBe(true);
      expect(boundaryText.some((text) => text.includes("Subagent handoff"))).toBe(true);
      await user.click(getPromptEditor());

      await user.keyboard("{ArrowUp}");
      expect(promptEditorText()).toBe("newer prompt");
      await user.keyboard("{ArrowUp}");
      expect(promptEditorText()).toBe("older prompt");
      expect(screen.queryByText(/private control prompt/)).not.toBeInTheDocument();
      expect(screen.getByText(/Reproduced the defect/)).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Filter timeline" }));
      for (const label of ["Assistant", "You", "Goals", "Runtime", "System"]) {
        // eslint-disable-next-line no-await-in-loop -- each controlled checkbox must settle before the next click
        await user.click(screen.getByRole("checkbox", { name: label }));
      }
      await user.click(screen.getByRole("combobox", { name: "Named agent or reviewer" }));
      await user.click(screen.getByRole("option", { name: "Worker" }));
      await user.keyboard("{Escape}");

      const filteredBoundaryText = screen
        .getAllByTestId("timeline-boundary")
        .map((boundary) => boundary.textContent ?? "");
      expect(filteredBoundaryText).toHaveLength(1);
      expect(filteredBoundaryText[0]).toContain("Subagent handoff");
      expect(filteredBoundaryText[0]).toContain("From Worker");
      expect(filteredBoundaryText[0]).toContain("Done");
      expect(screen.queryByText("Goal started")).not.toBeInTheDocument();
      expect(
        within(screen.getByTestId("timeline-virtual-list")).queryByText("older prompt"),
      ).not.toBeInTheDocument();
      expect(
        within(screen.getByTestId("timeline-virtual-list")).queryByText("newer prompt"),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/Reproduced the defect/)).not.toBeInTheDocument();
    });

    it("switching sessionId clears prompt history so prompts from the old session are not recalled", async () => {
      const { rerender, user } = await renderAndSendPrompt("session-a", "session A prompt");
      await user.keyboard("{ArrowUp}");
      expect(promptEditorText()).toBe("session A prompt");
      await user.keyboard("{ArrowDown}");
      rerender(<ChatPanel sessionId="session-b" />);
      await user.keyboard("{ArrowUp}");
      expect(promptEditorText()).toBe("");
    });
  });

  describe("permission event integration", () => {
    let fireViewEvent: (data: any) => void;

    beforeEach(() => {
      vi.mocked(window.sessionsAPI.onViewEvent).mockImplementation((cb) => {
        fireViewEvent = sequencedViewCallback(cb);
        return () => {};
      });
      vi.mocked(window.sessionsAPI.getView).mockResolvedValue({
        success: true,
        view: makeView(),
      });
    });

    async function renderAndSendMessage() {
      render(<ChatPanel sessionId="test-session" />);
      await waitFor(() =>
        expect(screen.getByPlaceholderText(/Describe what you want/)).not.toBeDisabled(),
      );
      await setPromptTextDOM("Run something");
      pressInPromptEditor("Enter");
      await act(async () => {
        fireViewEvent({
          sessionId: "test-session",
          type: "session:view",
          view: makeView({ status: "streaming" }),
          committedMessages: [],
        });
      });
    }

    it("renders permission card when cards arrive via store", async () => {
      await renderAndSendMessage();

      await act(async () => {
        injectPermissionCard("test-session", {
          id: "perm-1",
          toolCallId: "tc-1",
          kind: "shell",
          title: "Run a Command",
          message: "wants to run a command",
          detail: "echo hello",
          buttons: ["Allow", "Deny"],
        });
      });

      expect(screen.getByText("Run a Command")).toBeInTheDocument();
      const tray = screen.getByTestId("permission-decision-tray");
      const input = screen.getByTestId("chat-input");
      expect(tray).toBeInTheDocument();
      expect(tray.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
      expect(
        within(screen.getByTestId("messages-container")).queryByTestId("permission-decision-tray"),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("echo hello")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Allow once" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
    });

    it("tool completion resolves card (main process pushes updated state)", async () => {
      await renderAndSendMessage();

      await act(async () => {
        injectPermissionCard("test-session", {
          id: "perm-1",
          toolCallId: "tc-1",
          kind: "shell",
          title: "Run a Command",
          message: "run echo",
          detail: "echo hello",
          buttons: ["Allow", "Deny"],
          resolved: "allowed",
        });
      });

      expect(screen.getByTestId("tool-status-indicator")).toHaveAttribute(
        "data-state-kind",
        "running",
      );

      await act(async () => {
        permStoreCache.set("test-session", [
          {
            id: "perm-1",
            toolCallId: "tc-1",
            kind: "shell",
            title: "Run a Command",
            message: "run echo",
            detail: "echo hello",
            buttons: ["Allow", "Deny"],
            resolved: "allowed",
            output: "fallback output",
            createdAt: Date.now(),
          },
        ]);
        permStoreListeners.forEach((l) => l());
      });

      expect(screen.getByText("Output")).toBeInTheDocument();
    });

    it("removes a timed-out tool notice from the timeline when dismissed", async () => {
      const user = userEvent.setup();
      await renderAndSendMessage();

      await act(async () => {
        injectPermissionCard("test-session", {
          id: "perm-timeout",
          toolCallId: "tc-timeout",
          kind: "shell",
          title: "Run a Command",
          message: "run tests",
          detail: "pnpm test",
          buttons: ["Allow", "Deny"],
          resolved: "timed-out",
        });
      });

      expect(screen.getByText("Timed out")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Dismiss timed out tool notice" }));
      expect(screen.queryByText("Timed out")).not.toBeInTheDocument();
      expect(screen.queryByText("Run a Command")).not.toBeInTheDocument();
    });

    it("permission card Allow button calls resolvePermission IPC", async () => {
      await renderAndSendMessage();
      const ue = userEvent.setup();

      await act(async () => {
        injectPermissionCard("test-session", {
          id: "perm-1",
          toolCallId: "tc-1",
          kind: "shell",
          title: "Run a Command",
          message: "run echo",
          detail: "echo hello",
          buttons: ["Allow", "Deny"],
        });
      });

      await ue.click(screen.getByRole("button", { name: "Allow once" }));

      await waitFor(() => {
        expect(window.copilotAPI.resolvePermission).toHaveBeenCalledWith(
          "perm-1",
          "allow",
          undefined,
        );
      });
    });

    it("stop button + session.idle resolves stuck cards (main process pushes)", async () => {
      await renderAndSendMessage();
      const ue = userEvent.setup();

      await act(async () => {
        injectPermissionCard("test-session", {
          id: "perm-1",
          toolCallId: "tc-1",
          kind: "shell",
          title: "Run a Command",
          message: "run echo",
          detail: "echo hello",
          buttons: ["Allow", "Deny"],
          resolved: "allowed",
        });
      });

      expect(screen.getByTestId("tool-status-indicator")).toHaveAttribute(
        "data-state-kind",
        "running",
      );

      await ue.click(screen.getByRole("button", { name: "Stop" }));

      await act(async () => {
        permStoreCache.set("test-session", [
          {
            id: "perm-1",
            toolCallId: "tc-1",
            kind: "shell",
            title: "Run a Command",
            message: "run echo",
            detail: "echo hello",
            buttons: ["Allow", "Deny"],
            resolved: "allowed",
            output: "",
            createdAt: Date.now(),
          },
        ]);
        permStoreListeners.forEach((l) => l());
      });

      await waitFor(() => {
        expect(screen.queryByTestId("tool-status-indicator")).not.toBeInTheDocument();
      });
    });
  });

  describe("reasoning/thinking indicator", () => {
    let fireViewEvent: (data: any) => void;

    function fireView(
      sessionId: string,
      viewOverrides: Partial<SessionView>,
      committedMessages: any[] = [],
    ) {
      fireViewEvent({
        sessionId,
        type: "session:view",
        view: makeView(viewOverrides),
        committedMessages,
      });
    }

    async function sendMessage(sessionId = "test-session") {
      render(<ChatPanel sessionId={sessionId} />);
      await waitFor(() =>
        expect(screen.getByPlaceholderText(/Describe what you want/)).not.toBeDisabled(),
      );
      await setPromptTextDOM("Hello");
      pressInPromptEditor("Enter");
      await act(async () => {
        fireView(sessionId, { status: "submitted" });
      });
    }

    beforeEach(() => {
      vi.mocked(window.sessionsAPI.onViewEvent).mockImplementation((cb) => {
        fireViewEvent = sequencedViewCallback(cb);
        return () => {};
      });
      vi.mocked(window.sessionsAPI.getView).mockResolvedValue({
        success: true,
        view: makeView(),
      });
    });

    it("shows Working indicator immediately after sending", async () => {
      await sendMessage();
      await waitFor(() => {
        expect(screen.getByText(/Working/)).toBeInTheDocument();
      });
    });

    it("shows reasoning content when view includes reasoning", async () => {
      await sendMessage();
      await act(async () => {
        fireView("test-session", {
          status: "streaming",
          reasoning: { text: "Let me think about this", durationSeconds: null },
        });
      });
      await waitFor(() => {
        expect(screen.getByText(/Thinking/)).toBeInTheDocument();
        expect(screen.getByTestId("reasoning-toggle")).not.toBeDisabled();
      });
    });

    it("expands reasoning content when toggle is clicked", async () => {
      await sendMessage();
      await act(async () => {
        fireView("test-session", {
          status: "streaming",
          reasoning: { text: "Considering the options carefully", durationSeconds: null },
        });
      });
      await waitFor(() => {
        expect(screen.getByTestId("reasoning-content")).toBeInTheDocument();
        expect(screen.getByText("Considering the options carefully")).toBeInTheDocument();
      });
    });

    it("persists reasoning on committed message", async () => {
      await sendMessage();
      await act(async () => {
        fireView("test-session", {
          status: "streaming",
          reasoning: { text: "Considering...", durationSeconds: 3 },
        });
      });
      await waitFor(() => {
        expect(screen.getByTestId("reasoning-content")).toBeInTheDocument();
      });
      await act(async () => {
        fireView("test-session", { status: "ready", reasoning: null }, [
          {
            id: "m1",
            role: "assistant",
            content: "Here is my answer",
            timestamp: new Date().toISOString(),
            reasoning: { text: "Considering...", durationSeconds: 3 },
          },
        ]);
      });
      await waitFor(() => {
        expect(screen.getByTestId("committed-reasoning")).toBeInTheDocument();
      });
    });

    it("does not flash Thinking after assistant responds", async () => {
      await sendMessage();
      await act(async () => {
        fireView("test-session", { status: "ready" }, [
          {
            id: "m1",
            role: "assistant",
            content: "Done!",
            timestamp: new Date().toISOString(),
          },
        ]);
      });
      await waitFor(() => {
        expect(screen.queryByText(/Thinking/)).not.toBeInTheDocument();
      });
    });

    it("shows Working text without toggle button when no reasoning content", async () => {
      await sendMessage();
      await waitFor(() => {
        expect(screen.getByText(/Working/)).toBeInTheDocument();
      });
      expect(screen.queryByTestId("reasoning-toggle")).not.toBeInTheDocument();
    });
  });

  describe("chat context files (Co-create)", () => {
    it("sends context files as attachments when provided", async () => {
      const ref = createRef<any>();
      render(<ChatPanel ref={ref} sessionId="test-session" />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Describe what you want/)).not.toBeDisabled();
      });

      act(() => {
        ref.current.addContextFile("/workspace/doc.md");
        ref.current.addContextFile("/workspace/notes.txt");
      });
      await setPromptTextDOM("Summarize these");
      pressInPromptEditor("Enter");

      await waitFor(() => {
        expect(copilotService.send).toHaveBeenCalledWith(
          "Summarize these",
          "test-session",
          [
            { type: "file", path: "/workspace/doc.md", displayName: "doc.md" },
            { type: "file", path: "/workspace/notes.txt", displayName: "notes.txt" },
          ],
          expect.any(String),
        );
      });
    }, 15_000);

    it("deduplicates context files added via ref", async () => {
      const ref = createRef<any>();
      render(<ChatPanel ref={ref} sessionId="test-session" />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Describe what you want/)).not.toBeDisabled();
      });

      act(() => {
        ref.current.addContextFile("/workspace/doc.md");
        ref.current.addContextFile("/workspace/doc.md");
      });

      await setPromptTextDOM("Check this");
      pressInPromptEditor("Enter");

      await waitFor(() => {
        expect(copilotService.send).toHaveBeenCalledWith(
          "Check this",
          "test-session",
          [{ type: "file", path: "/workspace/doc.md", displayName: "doc.md" }],
          expect.any(String),
        );
      });
    }, 15_000);

    it("sends no attachments when context files array is empty", async () => {
      render(<ChatPanel sessionId="test-session" />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Describe what you want/)).not.toBeDisabled();
      });
      await setPromptTextDOM("Hello");
      pressInPromptEditor("Enter");

      await waitFor(() => {
        expect(copilotService.send).toHaveBeenCalledWith(
          "Hello",
          "test-session",
          undefined,
          expect.any(String),
        );
      });
    }, 15_000);

    it("clears context files via clearContextFiles ref method", async () => {
      const ref = createRef<any>();
      render(<ChatPanel ref={ref} sessionId="test-session" />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Describe what you want/)).not.toBeDisabled();
      });

      act(() => {
        ref.current.addContextFile("/workspace/doc.md");
        ref.current.clearContextFiles();
      });

      await setPromptTextDOM("Hello");
      pressInPromptEditor("Enter");

      await waitFor(() => {
        expect(copilotService.send).toHaveBeenCalledWith(
          "Hello",
          "test-session",
          undefined,
          expect.any(String),
        );
      });
    }, 15_000);
  });

  describe("session switch restores live state from getView", () => {
    it("shows streaming state when getView returns a busy session", async () => {
      vi.mocked(window.sessionsAPI.getView).mockResolvedValue({
        success: true,
        view: makeView({
          status: "streaming",
          streamingText: "Response from the assistant",
          toolStatuses: [{ id: "t1", name: "shell", description: "Running ls -la", running: true }],
        }),
      });
      vi.mocked(window.sessionsAPI.get).mockResolvedValue({
        success: true,
        session: {
          id: "busy-session",
          name: "Busy Session",
          messages: [
            { id: "m1", role: "user", content: "Hello", timestamp: new Date().toISOString() },
          ],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          hasUnread: false,
          isActive: true,
        },
      });

      render(<ChatPanel sessionId="busy-session" />);

      await waitFor(() => {
        expect(screen.getByText(/Response from the assistant/)).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByText(/Running ls -la/)).toBeInTheDocument();
      });
    });

    it("error status does not show waiting/spinner state", async () => {
      vi.mocked(window.sessionsAPI.getView).mockResolvedValue({
        success: true,
        view: makeView({
          status: "error",
          error: "Something went wrong",
        }),
      });
      vi.mocked(window.sessionsAPI.get).mockResolvedValue({
        success: true,
        session: {
          id: "err-session",
          name: "Error Session",
          messages: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          hasUnread: false,
          isActive: true,
        },
      });

      render(<ChatPanel sessionId="err-session" />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Describe what you want/)).not.toBeDisabled();
      });
    });

    it("dismisses a persisted terminal error message", async () => {
      const user = userEvent.setup();
      vi.mocked(window.sessionsAPI.get).mockResolvedValue({
        success: true,
        session: {
          id: "err-session",
          name: "Error Session",
          messages: [
            {
              id: "error-message",
              role: "assistant",
              content: "The tool timed out.",
              timestamp: new Date().toISOString(),
              error: true,
            },
          ],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          hasUnread: false,
          isActive: true,
        },
      });

      const { unmount } = render(<ChatPanel sessionId="err-session" />);

      expect(await screen.findByText("The tool timed out.")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Dismiss message error" }));
      await waitFor(() => {
        expect(screen.queryByText("The tool timed out.")).not.toBeInTheDocument();
      });

      unmount();
      render(<ChatPanel sessionId="err-session" />);
      await waitFor(() => {
        expect(screen.queryByText("The tool timed out.")).not.toBeInTheDocument();
      });
    });

    it("ready status shows no waiting/spinner indicators on session load", async () => {
      vi.mocked(window.sessionsAPI.getView).mockResolvedValue({
        success: true,
        view: makeView({ status: "ready" }),
      });

      vi.mocked(window.sessionsAPI.get).mockResolvedValue({
        success: true,
        session: {
          id: "ready-session",
          name: "Ready Session",
          messages: [
            { id: "m1", role: "user", content: "Hi", timestamp: new Date().toISOString() },
            {
              id: "m2",
              role: "assistant",
              content: "Hello!",
              timestamp: new Date().toISOString(),
            },
          ],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          hasUnread: false,
          isActive: true,
        },
      });

      render(<ChatPanel sessionId="ready-session" />);

      await waitFor(() => {
        expect(screen.getByText("Hello!")).toBeInTheDocument();
      });

      expect(screen.getByPlaceholderText(/Describe what you want/)).not.toBeDisabled();
      expect(screen.queryByText(/Thinking|Working/)).not.toBeInTheDocument();
    });
  });

  describe("session status notices", () => {
    it("marks a paused status as idle and leaves the composer available", async () => {
      vi.mocked(window.sessionsAPI.getView).mockResolvedValue({
        success: true,
        view: makeView({ status: "ready", sessionStatus: "Paused" }),
      });
      render(<ChatPanel sessionId="test-session" />);
      expect(await screen.findByText("Paused")).toBeInTheDocument();
      expect(within(screen.getByRole("status", { busy: false })).getByText("Paused")).toBeInTheDocument();
      expect(screen.queryByRole("status", { busy: true })).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByPlaceholderText(/Describe what you want/)).not.toBeDisabled());
    });

    it("keeps a dismissed delay hidden and shows a distinct timeout", async () => {
      const user = userEvent.setup();
      let fireViewEvent: (data: any) => void;
      vi.mocked(window.sessionsAPI.onViewEvent).mockImplementation((cb) => {
        fireViewEvent = sequencedViewCallback(cb);
        return () => {};
      });
      vi.mocked(window.sessionsAPI.getView).mockResolvedValue({
        success: true,
        view: makeView({
          status: "streaming",
          sessionStatus: "This tool is taking longer than expected...",
        }),
      });

      render(<ChatPanel sessionId="test-session" />);

      expect(
        await screen.findByText("This tool is taking longer than expected..."),
      ).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Dismiss session status" }));
      expect(
        screen.queryByText("This tool is taking longer than expected..."),
      ).not.toBeInTheDocument();

      await act(async () => {
        fireViewEvent({
          sessionId: "test-session",
          type: "session:view",
          view: makeView({
            status: "streaming",
            sessionStatus: "This tool is taking longer than expected...",
          }),
          committedMessages: [],
        });
      });
      expect(
        screen.queryByText("This tool is taking longer than expected..."),
      ).not.toBeInTheDocument();

      await act(async () => {
        fireViewEvent({
          sessionId: "test-session",
          type: "session:view",
          view: makeView({
            status: "streaming",
            sessionStatus: "The tool timed out.",
          }),
          committedMessages: [],
        });
      });
      expect(await screen.findByText("The tool timed out.")).toBeInTheDocument();

      await act(async () => {
        fireViewEvent({
          sessionId: "test-session",
          type: "session:view",
          view: makeView({ status: "ready", sessionStatus: null }),
          committedMessages: [],
        });
      });
      await waitFor(() => {
        expect(screen.queryByText("The tool timed out.")).not.toBeInTheDocument();
      });

      await act(async () => {
        fireViewEvent({
          sessionId: "test-session",
          type: "session:view",
          view: makeView({
            status: "streaming",
            sessionStatus: "This tool is taking longer than expected...",
          }),
          committedMessages: [],
        });
      });
      expect(
        await screen.findByText("This tool is taking longer than expected..."),
      ).toBeInTheDocument();
    });
  });

  describe("auth error handling", () => {
    it("does not add error message to chat for auth errors (banner only)", async () => {
      const onAuthError = vi.fn<(error: string) => void>();
      installMockAPIs({
        sessionsAPI: {
          get: vi.fn<SessionsAPI["get"]>().mockResolvedValue({
            success: true,
            session: {
              id: "auth-session",
              name: "Auth Session",
              messages: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              hasUnread: false,
              isActive: true,
            },
          }),
        },
      });

      vi.mocked(copilotService.send).mockRejectedValueOnce(new Error("401 Unauthorized"));

      render(<ChatPanel sessionId="auth-session" onAuthError={onAuthError} />);

      await waitFor(() => {
        expect(screen.getByRole("textbox")).toBeEnabled();
      });
      await setPromptTextDOM("Hello");
      pressInPromptEditor("Enter");

      await waitFor(() => {
        expect(onAuthError).toHaveBeenCalledWith(expect.stringContaining("401"));
      });

      expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
    });
  });

  describe("selection clearing on session switch", () => {
    it("clears text selection when sessionId changes", async () => {
      const selection = window.getSelection();
      const spy = vi.spyOn(selection!, "removeAllRanges");

      const { rerender } = render(<ChatPanel sessionId="session-a" />);
      spy.mockClear();

      rerender(<ChatPanel sessionId="session-b" />);

      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("hydration state", () => {
    it("renders <ChatSkeleton /> when useSessionHydration reports isHydrating", async () => {
      let cb: ((evt: import("@/types/electron").SessionHydrationEvent) => void) | null = null;
      vi.spyOn(window.sessionsAPI, "onHydrationChanged").mockImplementation((fn) => {
        cb = fn;
        return () => {};
      });
      hydrationStore.initialize();

      render(<ChatPanel sessionId="sess-loading" />);

      act(() => {
        cb?.({ sessionId: "sess-loading", state: "started" });
      });

      await waitFor(() => {
        expect(screen.getByTestId("chat-skeleton")).toBeInTheDocument();
      });
    });

    it("does not render <ChatSkeleton /> when not hydrating", () => {
      render(<ChatPanel sessionId="sess-loaded" />);
      expect(screen.queryByTestId("chat-skeleton")).toBeNull();
    });

    it("skeleton disappears on `failed` (falls through to welcome state)", async () => {
      let cb: ((evt: import("@/types/electron").SessionHydrationEvent) => void) | null = null;
      vi.spyOn(window.sessionsAPI, "onHydrationChanged").mockImplementation((fn) => {
        cb = fn;
        return () => {};
      });
      hydrationStore.initialize();

      render(<ChatPanel sessionId="sess-fail" />);

      act(() => cb?.({ sessionId: "sess-fail", state: "started" }));
      await waitFor(() => {
        expect(screen.getByTestId("chat-skeleton")).toBeInTheDocument();
      });

      act(() => cb?.({ sessionId: "sess-fail", state: "failed" }));
      await waitFor(() => {
        expect(screen.queryByTestId("chat-skeleton")).toBeNull();
      });
    });
  });

  describe("injected slash commands", () => {
    const INJECTED_SLASH_NAME = "fixture-cmd";
    const INJECTED_EXTENSION_ID = "@marshal/fixture-extension";
    const SLASH_ARGUMENT = "do the work";
    const SESSION_ID = "test-session";

    function injectedApplication(): RuntimeUiPlacementApplication {
      return {
        extensionId: INJECTED_EXTENSION_ID,
        applicationId: INJECTED_SLASH_NAME,
        title: "Fixture command",
        description: "Injected slash command",
        renderId: "fixture.view",
        action: "augment",
      };
    }

    function placementSnapshot(
      applications: readonly RuntimeUiPlacementApplication[],
    ): RuntimeUiPlacementSnapshot {
      return {
        revision: 1,
        generatedAt: "2026-08-16T10:00:00.000Z",
        placements: RUNTIME_UI_HOST_PLACEMENTS.map((metadata) =>
          metadata.key === RUNTIME_UI_PLACEMENT.CHAT_SLASH_COMMAND
            ? { metadata, applications }
            : { metadata, applications: [] },
        ),
        diagnostics: [],
      };
    }

    function installSlashRuntime() {
      vi.mocked(copilotService.send).mockClear();
      const activatePlacement = vi.fn<RuntimeUiAPI["activatePlacement"]>().mockResolvedValue({
        success: true,
        value: {
          receipt: {
            receiptId: "receipt-1",
            action: "list",
            status: "applied",
            completedAt: "2026-08-16T10:00:00.000Z",
            revision: 1,
          },
        },
      });
      window.runtimeUiAPI = {
        getSnapshot: vi.fn<RuntimeUiAPI["getSnapshot"]>(),
        subscribe: vi.fn<RuntimeUiAPI["subscribe"]>(),
        unsubscribe: vi.fn<RuntimeUiAPI["unsubscribe"]>(),
        open: vi.fn<RuntimeUiAPI["open"]>(),
        update: vi.fn<RuntimeUiAPI["update"]>(),
        focus: vi.fn<RuntimeUiAPI["focus"]>(),
        close: vi.fn<RuntimeUiAPI["close"]>(),
        list: vi.fn<RuntimeUiAPI["list"]>(),
        getPlacements: vi
          .fn<RuntimeUiAPI["getPlacements"]>()
          .mockResolvedValue(placementSnapshot([injectedApplication()])),
        activatePlacement,
        onEvent: vi.fn<RuntimeUiAPI["onEvent"]>().mockReturnValue(() => {}),
      };
      vi.mocked(window.sessionsAPI.get).mockResolvedValue({
        success: true,
        session: makeSession({ id: SESSION_ID }),
        messagePage: { hasMore: false, total: 0 },
      });
      return { activatePlacement };
    }

    async function renderWithPlacements() {
      render(
        <RuntimeUiPlacementsProvider
          scope={{ sessionId: SESSION_ID, workspaceName: MARSHAL_RUNTIME_DEFAULT_WORKSPACE }}
        >
          <ChatPanel sessionId={SESSION_ID} />
        </RuntimeUiPlacementsProvider>,
      );
      await waitFor(() => {
        expect(window.runtimeUiAPI?.getPlacements).toHaveBeenCalled();
      });
      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Describe what you want/)).not.toBeDisabled();
      });
    }

    it("activates the injected command without sending chat", async () => {
      const { activatePlacement } = installSlashRuntime();
      await renderWithPlacements();
      await setPromptTextDOM(`${SLASH_PREFIX}${INJECTED_SLASH_NAME} ${SLASH_ARGUMENT}`);
      pressInPromptEditor("Enter");

      await waitFor(() => {
        expect(activatePlacement).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: SESSION_ID,
            workspaceName: MARSHAL_RUNTIME_DEFAULT_WORKSPACE,
            extensionId: INJECTED_EXTENSION_ID,
            applicationId: INJECTED_SLASH_NAME,
            input: {
              [SLASH_PLACEMENT_ARGUMENT_KEY]: SLASH_ARGUMENT,
              [SLASH_PLACEMENT_FRESH_KEY]: false,
            },
          }),
        );
      });
      expect(copilotService.send).not.toHaveBeenCalled();
    });

    it("forwards the fresh flag from the host slash convention", async () => {
      const { activatePlacement } = installSlashRuntime();
      await renderWithPlacements();
      await setPromptTextDOM(
        `${SLASH_PREFIX}${INJECTED_SLASH_NAME} ${SLASH_FRESH_FLAG} ${SLASH_ARGUMENT}`,
      );
      pressInPromptEditor("Enter");

      await waitFor(() => {
        expect(activatePlacement).toHaveBeenCalledWith(
          expect.objectContaining({
            input: {
              [SLASH_PLACEMENT_ARGUMENT_KEY]: SLASH_ARGUMENT,
              [SLASH_PLACEMENT_FRESH_KEY]: true,
            },
          }),
        );
      });
      expect(copilotService.send).not.toHaveBeenCalled();
    });

    it.each([
      [`${SLASH_PREFIX}${INJECTED_SLASH_NAME} `, false],
      [`${SLASH_PREFIX}${INJECTED_SLASH_NAME} ${SLASH_FRESH_FLAG}`, true],
    ])("activates the bare injected command %s with an empty argument", async (text, fresh) => {
      const { activatePlacement } = installSlashRuntime();
      await renderWithPlacements();
      await setPromptTextDOM(text);
      pressInPromptEditor("Enter");

      await waitFor(() => {
        expect(activatePlacement).toHaveBeenCalledWith(
          expect.objectContaining({
            applicationId: INJECTED_SLASH_NAME,
            input: {
              [SLASH_PLACEMENT_ARGUMENT_KEY]: "",
              [SLASH_PLACEMENT_FRESH_KEY]: fresh,
            },
          }),
        );
      });
      expect(copilotService.send).not.toHaveBeenCalled();
    });

    it("sends an unknown slash as a normal message", async () => {
      const { activatePlacement } = installSlashRuntime();
      await renderWithPlacements();
      await setPromptTextDOM(`${SLASH_PREFIX}unknown ${SLASH_ARGUMENT}`);
      pressInPromptEditor("Enter");

      await waitFor(() => {
        expect(copilotService.send).toHaveBeenCalled();
      });
      expect(activatePlacement).not.toHaveBeenCalled();
    });
  });
});
