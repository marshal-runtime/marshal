import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatPanelRef } from "@/features/chat";
import type { SessionData } from "@/features/chat/types";
import { installMockAPIs } from "@/test-utils";
import type { SessionsAPI } from "@/types/electron";

import type { NavigateFn } from "./useNavigation";
import { useSessionManager } from "./useSessionManager";

const projectBinding = {
  name: "Project",
  identity: {
    version: 1 as const,
    device: "1",
    inode: "2",
    birthtimeNs: "3",
  },
};
const reviewer = {
  name: "Reviewer",
  path: ".github/agents/reviewer.agent.md",
  identity: {
    version: 1 as const,
    normalizedPath: ".github/agents/reviewer.agent.md",
    declaredName: "Reviewer",
    contentDigest: "reviewer-v1",
  },
};
const goalFence = {
  goalId: "goal-1",
  epoch: 1,
};

function scopedTimelineData(): SessionData {
  return {
    messages: [
      {
        id: "goal-declared",
        role: "system",
        content: "Goal started: Ship",
        timestamp: new Date("2026-07-24T09:00:00.000Z"),
        goalTimelineEvent: {
          type: "goal.declared",
          fence: goalFence,
          objective: "Ship",
        },
      },
      {
        id: "subagent-handoff",
        role: "user",
        content: "Message from subagent Worker (child-1):\n\nReady",
        timestamp: new Date("2026-07-24T09:01:00.000Z"),
        agentMessage: {
          source: "child-1",
          sourceLabel: "Worker",
          kind: "parent",
          deliveryMode: "queue",
          sequence: 1,
          sourceSessionSource: "subagent",
        },
      },
    ],
    isBusy: false,
    soul: "default",
    workspaceName: "Project",
    workspaceIdentity: projectBinding.identity,
    repositoryAgent: reviewer,
    permissionCards: [],
    turnState: null,
  };
}

function mountHook(
  onSessionsLoaded?: (
    sessions: Array<{ id: string; source?: string; workspaceName?: string; updatedAt?: string }>,
  ) => void,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  const migrateDraftToSession = vi.fn<ChatPanelRef["migrateDraftToSession"]>();
  const clearChat = vi.fn<ChatPanelRef["clearChat"]>();
  const panelRef: ChatPanelRef = {
    migrateDraftToSession,
    clearChat,
    focusInput: vi.fn<ChatPanelRef["focusInput"]>(),
    addContextFile: vi.fn<ChatPanelRef["addContextFile"]>(),
    clearContextFiles: vi.fn<ChatPanelRef["clearContextFiles"]>(),
    clearDraft: vi.fn<ChatPanelRef["clearDraft"]>(),
    hasInput: vi.fn<() => boolean>().mockReturnValue(false),
    getInput: vi.fn<() => string>().mockReturnValue(""),
  };
  const chatPanelRef = createRef<ChatPanelRef>();
  // createRef gives a RefObject with readonly .current in types, but a test
  // seed is the one place it's fine to assign — wrap the cast locally.
  (chatPanelRef as { current: ChatPanelRef | null }).current = panelRef;

  const view = renderHook(
    () =>
      useSessionManager({
        chatPanelRef,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, eslint-plugin-vitest/require-mock-type-parameters -- overloaded function
        navigate: vi.fn() as unknown as NavigateFn & ReturnType<typeof vi.fn>,
        onSessionsLoaded,
      }),
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    },
  );

  return {
    view,
    queryClient,
    chatPanelRef,
    migrateDraftToSession,
    clearChat,
    clearDraft: panelRef.clearDraft,
  };
}

describe("useSessionManager — session deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMockAPIs();
  });

  it("deletes one session and activates the returned remaining session", async () => {
    window.sessionsAPI.list = vi.fn<SessionsAPI["list"]>().mockResolvedValue({
      success: true,
      sessions: [
        {
          id: "s1",
          name: "Session 1",
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: true,
        },
        {
          id: "remaining",
          name: "Remaining",
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: false,
        },
      ],
    });
    window.sessionsAPI.switch = vi.fn<SessionsAPI["switch"]>().mockResolvedValue({
      success: true,
      session: {
        id: "s1",
        name: "Session 1",
        messages: [],
        createdAt: "",
        updatedAt: "",
        hasUnread: false,
        isActive: true,
      },
    });
    window.sessionsAPI.delete = vi.fn<SessionsAPI["delete"]>().mockResolvedValue({
      success: true,
      newActiveId: "remaining",
    });
    window.sessionsAPI.deleteAll = vi.fn<SessionsAPI["deleteAll"]>();
    window.sessionsAPI.create = vi.fn<SessionsAPI["create"]>();

    const { view, clearDraft } = mountHook();
    await waitFor(() => expect(view.result.current.activeSessionId).toBe("s1"));

    await act(async () => {
      await view.result.current.handleDeleteSession("s1");
    });

    expect(window.sessionsAPI.delete).toHaveBeenCalledWith("s1");
    expect(clearDraft).toHaveBeenCalledTimes(1);
    expect(clearDraft).toHaveBeenCalledWith("s1");
    expect(window.sessionsAPI.deleteAll).not.toHaveBeenCalled();
    expect(window.sessionsAPI.create).not.toHaveBeenCalled();
    expect(view.result.current.activeSessionId).toBe("remaining");
  });
});

describe("useSessionManager — initial session loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMockAPIs();
  });

  it("bounds conversation loading while restoring workspace sessions separately", async () => {
    const selectedSession = {
      id: "selected-chat",
      name: "Selected chat",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      hasUnread: false,
      isActive: false,
    };
    const workspaceSession = {
      ...selectedSession,
      id: "workspace-chat",
      source: "workspace" as const,
      workspaceName: "Project",
    };
    window.sessionsAPI.listWithOptions = vi
      .fn<SessionsAPI["listWithOptions"]>()
      .mockImplementation(async (options) =>
        options?.sources?.includes("workspace")
          ? { success: true, sessions: [workspaceSession] }
          : {
              success: true,
              sessions: [{ ...selectedSession, id: "newest-chat" }],
              selectedSession,
              hasMore: true,
              nextCursor: "newest-chat",
            },
      );
    window.sessionsAPI.switch = vi.fn<SessionsAPI["switch"]>().mockResolvedValue({
      success: true,
      session: { ...selectedSession, messages: [] },
    });
    const onSessionsLoaded = vi.fn<NonNullable<Parameters<typeof mountHook>[0]>>();

    const { view } = mountHook(onSessionsLoaded);

    await waitFor(() => expect(view.result.current.activeSessionId).toBe("selected-chat"));
    expect(window.sessionsAPI.listWithOptions).toHaveBeenCalledWith({
      excludeSources: ["workspace"],
      limit: 40,
    });
    expect(window.sessionsAPI.listWithOptions).toHaveBeenCalledWith({ sources: ["workspace"] });
    expect(onSessionsLoaded).toHaveBeenCalledWith([workspaceSession]);
  });

  it("restores workspace sessions when there are no existing conversations", async () => {
    const workspaceSession = {
      id: "workspace-chat",
      name: "Workspace chat",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      hasUnread: false,
      isActive: false,
      source: "workspace" as const,
      workspaceName: "Project",
    };
    window.sessionsAPI.listWithOptions = vi
      .fn<SessionsAPI["listWithOptions"]>()
      .mockImplementation(async (options) =>
        options?.sources?.includes("workspace")
          ? { success: true, sessions: [workspaceSession] }
          : { success: true, sessions: [], hasMore: false },
      );
    window.sessionsAPI.create = vi.fn<SessionsAPI["create"]>().mockResolvedValue({
      success: true,
      session: {
        ...workspaceSession,
        id: "new-chat",
        name: "New Chat",
        source: "user",
        workspaceName: undefined,
      },
    });
    const onSessionsLoaded = vi.fn<NonNullable<Parameters<typeof mountHook>[0]>>();

    const { view } = mountHook(onSessionsLoaded);

    await waitFor(() => expect(view.result.current.activeSessionId).toBe("new-chat"));
    expect(onSessionsLoaded).toHaveBeenCalledWith([workspaceSession]);
  });
});

describe("useSessionManager — handleSoulChange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMockAPIs();
  });

  it("carries the input draft over to the new session by calling migrateDraftToSession before the session swap", async () => {
    // Seed an "initial" session via the init effect so activeSessionId is set.
    window.sessionsAPI.list = vi.fn<SessionsAPI["list"]>().mockResolvedValue({
      success: true,
      sessions: [
        {
          id: "session-old",
          name: "Old",
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: true,
        },
      ],
    });
    window.sessionsAPI.switch = vi.fn<SessionsAPI["switch"]>().mockResolvedValue({
      success: true,
      session: {
        id: "session-old",
        name: "Old",
        messages: [],
        createdAt: "",
        updatedAt: "",
        hasUnread: false,
        isActive: true,
      },
    });
    window.sessionsAPI.createMain = vi.fn<SessionsAPI["createMain"]>().mockResolvedValue({
      success: true,
      session: {
        id: "session-new",
        name: "New",
        createdAt: "",
        updatedAt: "",
        hasUnread: false,
        isActive: true,
      },
    });
    window.sessionsAPI.delete = vi
      .fn<SessionsAPI["delete"]>()
      .mockResolvedValue({ success: true, newActiveId: null });

    const { view, migrateDraftToSession, clearChat } = mountHook();

    await waitFor(() => expect(view.result.current.activeSessionId).toBe("session-old"));

    // Snapshot the renderHook's view of activeSessionId at the moment
    // migrateDraftToSession is invoked. If migrate runs BEFORE
    // setActiveSessionId commits, the snapshot is still the OLD id.
    const observedActiveIdAtMigrate: Array<string | null> = [];
    migrateDraftToSession.mockImplementation(() => {
      observedActiveIdAtMigrate.push(view.result.current.activeSessionId);
    });

    await act(async () => {
      await view.result.current.handleSoulChange("operator");
    });

    expect(window.sessionsAPI.delete).not.toHaveBeenCalled();
    expect(window.sessionsAPI.createMain).toHaveBeenCalledWith(undefined, "operator", {
      replaceEmptySessionId: "session-old",
    });
    expect(migrateDraftToSession).toHaveBeenCalledWith("session-old", "session-new", "");
    expect(clearChat).toHaveBeenCalled();
    // Ordering invariant: migrateDraftToSession must be invoked before
    // clearChat so the new session's draft is seeded before the ChatInput's
    // session-switch effect runs.
    const migrateOrder = migrateDraftToSession.mock.invocationCallOrder[0];
    const clearOrder = clearChat.mock.invocationCallOrder[0];
    expect(migrateOrder).toBeLessThan(clearOrder);
    // Ordering invariant: migrateDraftToSession must also run before
    // setActiveSessionId commits. Otherwise useDraftSync (in ChatInput)
    // would observe the new sessionId BEFORE the migrate has seeded its
    // draft, so getDraft(newId) returns undefined and the input is silently
    // lost. The snapshot below proves activeSessionId hadn't flipped yet.
    expect(observedActiveIdAtMigrate).toEqual(["session-old"]);
    expect(view.result.current.activeSessionId).toBe("session-new");
  });

  it("primes the React Query cache with empty SessionData for the new session to prevent the welcome→empty-messages flicker", async () => {
    window.sessionsAPI.list = vi.fn<SessionsAPI["list"]>().mockResolvedValue({
      success: true,
      sessions: [
        {
          id: "session-old",
          name: "Old",
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: true,
        },
      ],
    });
    window.sessionsAPI.switch = vi.fn<SessionsAPI["switch"]>().mockResolvedValue({
      success: true,
      session: {
        id: "session-old",
        name: "Old",
        messages: [],
        createdAt: "",
        updatedAt: "",
        hasUnread: false,
        isActive: true,
      },
    });
    window.sessionsAPI.createMain = vi.fn<SessionsAPI["createMain"]>().mockResolvedValue({
      success: true,
      session: {
        id: "session-new",
        name: "New",
        createdAt: "",
        updatedAt: "",
        hasUnread: false,
        isActive: true,
      },
    });
    window.sessionsAPI.delete = vi
      .fn<SessionsAPI["delete"]>()
      .mockResolvedValue({ success: true, newActiveId: null });

    const { view, queryClient } = mountHook();

    await waitFor(() => expect(view.result.current.activeSessionId).toBe("session-old"));

    await act(async () => {
      await view.result.current.handleSoulChange("operator");
    });

    const primed = queryClient.getQueryData<SessionData>(["session", "session-new"]);
    expect(primed).toEqual({
      messages: [],
      isBusy: false,
      soul: undefined,
      permissionCards: [],
      turnState: null,
    });
  });

  it("is a no-op when there is no active session", async () => {
    window.sessionsAPI.list = vi
      .fn<SessionsAPI["list"]>()
      .mockResolvedValue({ success: true, sessions: [] });
    window.sessionsAPI.create = vi
      .fn<SessionsAPI["create"]>()
      .mockResolvedValue({ success: false, error: "no" });

    const { view } = mountHook();

    // No session ever established (list empty, create failed).
    await waitFor(() => expect(window.sessionsAPI.list).toHaveBeenCalled());
    expect(view.result.current.activeSessionId).toBeNull();

    const deleteFn = vi.fn<SessionsAPI["delete"]>();
    window.sessionsAPI.delete = deleteFn;

    await act(async () => {
      await view.result.current.handleSoulChange("operator");
    });

    expect(deleteFn).not.toHaveBeenCalled();
  });

  it("preserves an existing workspace and role when changing soul", async () => {
    window.sessionsAPI.list = vi.fn<SessionsAPI["list"]>().mockResolvedValue({
      success: true,
      sessions: [
        {
          id: "session-old",
          name: "Old",
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: true,
          source: "user",
          workspaceName: "Project",
          workspaceIdentity: projectBinding.identity,
          repositoryAgent: reviewer,
        },
      ],
    });
    window.sessionsAPI.switch = vi.fn<SessionsAPI["switch"]>().mockResolvedValue({
      success: true,
      session: {
        id: "session-old",
        name: "Old",
        messages: [],
        createdAt: "",
        updatedAt: "",
        hasUnread: false,
        isActive: true,
        source: "user",
        workspaceName: "Project",
      },
    });
    window.sessionsAPI.createMain = vi.fn<SessionsAPI["createMain"]>().mockResolvedValue({
      success: true,
      session: {
        id: "session-new",
        name: "New",
        createdAt: "",
        updatedAt: "",
        hasUnread: false,
        isActive: true,
        source: "user",
        workspaceName: "Project",
      },
    });

    const { view } = mountHook();
    await waitFor(() => expect(view.result.current.activeSessionId).toBe("session-old"));

    await act(async () => {
      await view.result.current.handleSoulChange("operator", {
        workspaceBinding: projectBinding,
        repositoryAgent: reviewer,
      });
    });

    expect(window.sessionsAPI.createMain).toHaveBeenCalledWith(undefined, "operator", {
      workspaceBinding: projectBinding,
      repositoryAgent: reviewer,
      replaceEmptySessionId: "session-old",
    });
  });
});

describe("useSessionManager — handleWorkspaceRoleChange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMockAPIs();
    window.sessionsAPI.list = vi.fn<SessionsAPI["list"]>().mockResolvedValue({
      success: true,
      sessions: [
        {
          id: "session-old",
          name: "Old",
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: true,
        },
      ],
    });
    window.sessionsAPI.switch = vi.fn<SessionsAPI["switch"]>().mockResolvedValue({
      success: true,
      session: {
        id: "session-old",
        name: "Old",
        messages: [],
        createdAt: "",
        updatedAt: "",
        hasUnread: false,
        isActive: true,
      },
    });
    window.sessionsAPI.createMain = vi.fn<SessionsAPI["createMain"]>().mockResolvedValue({
      success: true,
      session: {
        id: "session-new",
        name: "New",
        createdAt: "",
        updatedAt: "",
        hasUnread: false,
        isActive: true,
        source: "user",
        workspaceName: "Project",
        workspaceIdentity: projectBinding.identity,
        repositoryAgent: reviewer,
      },
    });
  });

  it("replaces an empty predecessor when applying a workspace or role", async () => {
    const { view, migrateDraftToSession } = mountHook();
    await waitFor(() => expect(view.result.current.activeSessionId).toBe("session-old"));

    await act(async () => {
      await view.result.current.handleWorkspaceRoleChange(
        {
          workspaceBinding: projectBinding,
          repositoryAgent: reviewer,
        },
        { hasUserMessages: false, soulId: "default" },
      );
    });

    expect(window.sessionsAPI.createMain).toHaveBeenCalledWith(undefined, "default", {
      workspaceBinding: projectBinding,
      repositoryAgent: reviewer,
      replaceEmptySessionId: "session-old",
    });
    expect(migrateDraftToSession).toHaveBeenCalledWith("session-old", "session-new", "");
    expect(window.sessionsAPI.delete).not.toHaveBeenCalled();
    expect(view.result.current.activeSessionId).toBe("session-new");
  });

  it("starts a selected main-chat context when initialization has not established a session", async () => {
    window.sessionsAPI.list = vi
      .fn<SessionsAPI["list"]>()
      .mockResolvedValue({ success: true, sessions: [] });
    window.sessionsAPI.create = vi
      .fn<SessionsAPI["create"]>()
      .mockResolvedValue({ success: false, error: "not ready" });
    const { view, migrateDraftToSession } = mountHook();
    await waitFor(() => expect(window.sessionsAPI.create).toHaveBeenCalled());
    expect(view.result.current.activeSessionId).toBeNull();

    await act(async () => {
      await view.result.current.handleWorkspaceRoleChange(
        {
          workspaceBinding: projectBinding,
          repositoryAgent: reviewer,
        },
        { hasUserMessages: false, soulId: "default" },
      );
    });

    expect(window.sessionsAPI.createMain).toHaveBeenCalledWith(undefined, "default", {
      workspaceBinding: projectBinding,
      repositoryAgent: reviewer,
    });
    expect(migrateDraftToSession).toHaveBeenCalledWith(null, "session-new", "");
    expect(view.result.current.activeSessionId).toBe("session-new");
  });

  it("preserves a conversation when changing workspace or role after a user turn", async () => {
    const { view, queryClient, chatPanelRef, migrateDraftToSession } = mountHook();
    await waitFor(() => expect(view.result.current.activeSessionId).toBe("session-old"));
    const existing = scopedTimelineData();
    queryClient.setQueryData(["session", "session-old"], existing);
    vi.mocked(chatPanelRef.current!.getInput).mockReturnValue("keep this draft");

    await act(async () => {
      await view.result.current.handleWorkspaceRoleChange(
        {
          workspaceBinding: projectBinding,
          repositoryAgent: reviewer,
        },
        { hasUserMessages: true, soulId: "operator" },
      );
    });

    expect(window.sessionsAPI.delete).not.toHaveBeenCalled();
    expect(view.result.current.activeSessionId).toBe("session-new");
    expect(queryClient.getQueryData<SessionData>(["session", "session-old"])).toEqual(existing);
    expect(queryClient.getQueryData<SessionData>(["session", "session-new"])).toMatchObject({
      messages: [],
      workspaceName: "Project",
      workspaceIdentity: projectBinding.identity,
      repositoryAgent: reviewer,
    });
    expect(migrateDraftToSession).toHaveBeenCalledWith(
      "session-old",
      "session-new",
      "keep this draft",
      { preserveSource: true },
    );
  });

  it("starts a safe no-workspace chat without changing the predecessor", async () => {
    window.sessionsAPI.createMain = vi.fn<SessionsAPI["createMain"]>().mockResolvedValue({
      success: true,
      session: {
        id: "session-new",
        name: "New",
        createdAt: "",
        updatedAt: "",
        hasUnread: false,
        isActive: true,
        source: "user",
      },
    });
    const { view, queryClient, chatPanelRef, migrateDraftToSession } = mountHook();
    await waitFor(() => expect(view.result.current.activeSessionId).toBe("session-old"));
    const existing = scopedTimelineData();
    queryClient.setQueryData(["session", "session-old"], existing);
    vi.mocked(chatPanelRef.current!.getInput).mockReturnValue("safe recovery draft");

    await act(async () => {
      await view.result.current.handleWorkspaceRoleChange(
        {},
        { hasUserMessages: true, soulId: "default" },
      );
    });

    expect(window.sessionsAPI.createMain).toHaveBeenCalledWith(undefined, "default", {});
    expect(queryClient.getQueryData<SessionData>(["session", "session-old"])).toEqual(existing);
    expect(queryClient.getQueryData<SessionData>(["session", "session-new"])).toEqual({
      messages: [],
      isBusy: false,
      soul: undefined,
      permissionCards: [],
      turnState: null,
    });
    expect(migrateDraftToSession).toHaveBeenCalledWith(
      "session-old",
      "session-new",
      "safe recovery draft",
      { preserveSource: true },
    );
    expect(window.sessionsAPI.delete).not.toHaveBeenCalled();
  });

  it("keeps the current session when the explicit selection cannot be created", async () => {
    window.sessionsAPI.createMain = vi.fn<SessionsAPI["createMain"]>().mockResolvedValue({
      success: false,
      error: 'Workspace "Removed" is unavailable',
    });
    const { view, migrateDraftToSession, queryClient } = mountHook();
    await waitFor(() => expect(view.result.current.activeSessionId).toBe("session-old"));
    const existing = scopedTimelineData();
    queryClient.setQueryData(["session", "session-old"], existing);

    await act(async () => {
      await expect(
        view.result.current.handleWorkspaceRoleChange(
          {
            workspaceBinding: {
              name: "Removed",
              identity: { ...projectBinding.identity, inode: "99" },
            },
          },
          { hasUserMessages: true, soulId: "default" },
        ),
      ).rejects.toThrow(/Removed.*unavailable/);
    });

    expect(view.result.current.activeSessionId).toBe("session-old");
    expect(queryClient.getQueryData<SessionData>(["session", "session-old"])).toEqual(existing);
    expect(migrateDraftToSession).not.toHaveBeenCalled();
    expect(window.sessionsAPI.delete).not.toHaveBeenCalled();
  });

  it("rejects overlapping workspace or soul replacements", async () => {
    let finishCreation:
      | ((value: Awaited<ReturnType<SessionsAPI["createMain"]>>) => void)
      | undefined;
    window.sessionsAPI.createMain = vi.fn<SessionsAPI["createMain"]>().mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCreation = resolve;
        }),
    );
    const { view } = mountHook();
    await waitFor(() => expect(view.result.current.activeSessionId).toBe("session-old"));

    const first = view.result.current.handleWorkspaceRoleChange(
      { workspaceBinding: projectBinding },
      { hasUserMessages: true, soulId: "default" },
    );
    await view.result.current.handleSessionSelect("session-b");
    expect(view.result.current.activeSessionId).toBe("session-old");
    await expect(
      view.result.current.handleSoulChange("operator", { workspaceBinding: projectBinding }),
    ).resolves.toBeUndefined();
    expect(window.sessionsAPI.createMain).toHaveBeenCalledTimes(1);

    finishCreation?.({
      success: true,
      session: {
        id: "session-new",
        name: "New",
        createdAt: "",
        updatedAt: "",
        hasUnread: false,
        isActive: true,
        source: "user",
        workspaceName: "Project",
      },
    });
    await act(async () => {
      await first;
    });
  });
});

describe("useSessionManager — handleSessionSelect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMockAPIs();
  });

  it("selects immediately while the main-process switch is still pending", async () => {
    window.sessionsAPI.list = vi.fn<SessionsAPI["list"]>().mockResolvedValue({
      success: true,
      sessions: [
        {
          id: "session-initial",
          name: "Initial",
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: true,
        },
      ],
    });
    let resolveSwitch: ((value: Awaited<ReturnType<SessionsAPI["switch"]>>) => void) | undefined;
    window.sessionsAPI.switch = vi
      .fn<SessionsAPI["switch"]>()
      .mockResolvedValueOnce({
        success: true,
        session: {
          id: "session-initial",
          name: "Initial",
          messages: [],
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: true,
        },
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSwitch = resolve;
          }),
      );

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () =>
        useSessionManager({
          chatPanelRef: createRef<ChatPanelRef>(),
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, eslint-plugin-vitest/require-mock-type-parameters -- overloaded function
          navigate: vi.fn() as unknown as NavigateFn,
        }),
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
      },
    );
    await waitFor(() => expect(result.current.activeSessionId).toBe("session-initial"));

    act(() => {
      void result.current.handleSessionSelect("session-target");
    });
    expect(result.current.activeSessionId).toBe("session-target");

    await act(async () => resolveSwitch?.({ success: true }));
  });

  it("transitions activeSessionId when sessions:switch returns { success: true, hydrating: true } (gateway index-only)", async () => {
    // Seed an initial session so activeSessionId is set before we test handleSessionSelect.
    window.sessionsAPI.list = vi.fn<SessionsAPI["list"]>().mockResolvedValue({
      success: true,
      sessions: [
        {
          id: "session-initial",
          name: "Initial",
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: true,
        },
      ],
    });
    // Switch for the init effect returns the full session object.
    window.sessionsAPI.switch = vi
      .fn<SessionsAPI["switch"]>()
      .mockResolvedValueOnce({
        success: true,
        session: {
          id: "session-initial",
          name: "Initial",
          messages: [],
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: true,
        },
      })
      // Subsequent switch (handleSessionSelect) returns hydrating=true with no session object.
      .mockResolvedValueOnce({ success: true, hydrating: true });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, eslint-plugin-vitest/require-mock-type-parameters -- overloaded function
    const navigate = vi.fn() as unknown as NavigateFn & ReturnType<typeof vi.fn>;
    const chatPanelRef = createRef<ChatPanelRef>();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    const { result } = renderHook(() => useSessionManager({ chatPanelRef, navigate }), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });

    // Wait for init effect to set the initial active session.
    await waitFor(() => expect(result.current.activeSessionId).toBe("session-initial"));

    // Now select a gateway index-only session (returns hydrating: true).
    await act(async () => {
      await result.current.handleSessionSelect("session-gateway");
    });

    // activeSessionId must transition to the requested id even though
    // result.session was absent — the hydrating flag means "it exists, fetch in progress".
    expect(result.current.activeSessionId).toBe("session-gateway");
  });

  it("onSwitchTo listener navigates to a hydrating session", async () => {
    // Capture the onSwitchTo callback so we can fire it directly.
    let capturedCallback: ((sessionId: string) => void) | null = null;
    window.sessionsAPI.onSwitchTo = vi
      .fn<(cb: (sessionId: string) => void) => () => void>()
      .mockImplementation((cb) => {
        capturedCallback = cb;
        return () => {};
      });

    // Seed initial session via list + first switch.
    window.sessionsAPI.list = vi.fn<SessionsAPI["list"]>().mockResolvedValue({
      success: true,
      sessions: [
        {
          id: "session-initial",
          name: "Initial",
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: true,
        },
      ],
    });
    window.sessionsAPI.switch = vi
      .fn<SessionsAPI["switch"]>()
      .mockResolvedValueOnce({
        success: true,
        session: {
          id: "session-initial",
          name: "Initial",
          messages: [],
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: true,
        },
      })
      .mockResolvedValueOnce({ success: true, hydrating: true });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, eslint-plugin-vitest/require-mock-type-parameters -- overloaded function
    const navigate = vi.fn() as unknown as NavigateFn & ReturnType<typeof vi.fn>;
    const chatPanelRef = createRef<ChatPanelRef>();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    const { result } = renderHook(() => useSessionManager({ chatPanelRef, navigate }), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });
    await waitFor(() => expect(result.current.activeSessionId).toBe("session-initial"));

    // Fire onSwitchTo and wait for the async switch chain to resolve.
    await act(async () => {
      capturedCallback?.("session-gateway");
    });

    await waitFor(() => expect(result.current.activeSessionId).toBe("session-gateway"));
    expect(navigate).toHaveBeenCalledWith("chat", { sessionId: "session-gateway" });
  });
});

describe("useSessionManager — handleNewChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMockAPIs();
  });

  function setup(panelOverrides: Partial<ChatPanelRef> = {}) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    const panelRef: ChatPanelRef = {
      migrateDraftToSession: vi.fn<ChatPanelRef["migrateDraftToSession"]>(),
      clearChat: vi.fn<ChatPanelRef["clearChat"]>(),
      focusInput: vi.fn<ChatPanelRef["focusInput"]>(),
      addContextFile: vi.fn<ChatPanelRef["addContextFile"]>(),
      clearContextFiles: vi.fn<ChatPanelRef["clearContextFiles"]>(),
      clearDraft: vi.fn<ChatPanelRef["clearDraft"]>(),
      hasInput: vi.fn<() => boolean>().mockReturnValue(false),
      getInput: vi.fn<() => string>().mockReturnValue(""),
      ...panelOverrides,
    };
    const chatPanelRef = createRef<ChatPanelRef>();
    (chatPanelRef as { current: ChatPanelRef | null }).current = panelRef;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, eslint-plugin-vitest/require-mock-type-parameters -- overloaded function
    const navigate = vi.fn() as unknown as NavigateFn & ReturnType<typeof vi.fn>;
    const view = renderHook(() => useSessionManager({ chatPanelRef, navigate }), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });
    return { view, navigate };
  }

  it("reuses empty session when no draft is present", async () => {
    const mockSession = {
      id: "reused-1",
      name: "New Chat",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hasUnread: false,
      isActive: true,
    };

    vi.mocked(window.sessionsAPI.createOrReuseEmpty).mockResolvedValue({
      success: true,
      reused: true,
      session: mockSession,
    });
    vi.mocked(window.sessionsAPI.list).mockResolvedValue({
      success: true,
      sessions: [
        {
          id: "existing",
          name: "Old Chat",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          hasUnread: false,
          isActive: true,
        },
      ],
    });

    const { view, navigate } = setup({ hasInput: vi.fn<() => boolean>().mockReturnValue(false) });
    await act(() => new Promise((r) => setTimeout(r, 10)));
    vi.mocked(window.sessionsAPI.create).mockClear();

    await act(() => view.result.current.handleNewChat());

    expect(navigate).toHaveBeenCalledWith("chat");
    expect(window.sessionsAPI.createOrReuseEmpty).toHaveBeenCalledWith({ source: "user" });
    expect(window.sessionsAPI.create).not.toHaveBeenCalled();
  });

  it("creates new session when draft is present", async () => {
    const mockSession = {
      id: "new-1",
      name: "New Chat",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hasUnread: false,
      isActive: true,
    };
    vi.mocked(window.sessionsAPI.create).mockResolvedValue({ success: true, session: mockSession });

    const { view } = setup({ hasInput: vi.fn<() => boolean>().mockReturnValue(true) });

    await act(() => view.result.current.handleNewChat());

    expect(window.sessionsAPI.createOrReuseEmpty).not.toHaveBeenCalled();
    expect(window.sessionsAPI.create).toHaveBeenCalledWith(undefined, undefined, {
      source: "user",
    });
  });

  it("keeps a workspace-bound new chat in the ordinary chat source", async () => {
    const mockSession = {
      id: "workspace-bound-1",
      name: "New Chat",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hasUnread: false,
      isActive: true,
    };
    vi.mocked(window.sessionsAPI.create).mockResolvedValue({ success: true, session: mockSession });

    const { view } = setup({ hasInput: vi.fn<() => boolean>().mockReturnValue(true) });

    await act(() => view.result.current.handleNewChat("Project"));

    expect(window.sessionsAPI.create).toHaveBeenCalledWith(undefined, undefined, {
      source: "user",
      workspaceName: "Project",
    });
  });

  it("falls back to create when createOrReuseEmpty finds no reusable session", async () => {
    vi.mocked(window.sessionsAPI.createOrReuseEmpty).mockResolvedValue({
      success: true,
      reused: false,
      session: undefined,
    });
    vi.mocked(window.sessionsAPI.list).mockResolvedValue({
      success: true,
      sessions: [
        {
          id: "existing",
          name: "Old",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          hasUnread: false,
          isActive: true,
        },
      ],
    });

    const { view } = setup({ hasInput: vi.fn<() => boolean>().mockReturnValue(false) });
    await act(() => new Promise((r) => setTimeout(r, 10)));
    vi.mocked(window.sessionsAPI.create).mockClear();

    await act(() => view.result.current.handleNewChat());

    expect(window.sessionsAPI.createOrReuseEmpty).toHaveBeenCalledWith({ source: "user" });
    expect(window.sessionsAPI.create).toHaveBeenCalledWith(undefined, undefined, {
      source: "user",
    });
  });

  it("does not double-fire when called rapidly", async () => {
    const { view } = setup();

    const p1 = act(() => view.result.current.handleNewChat());
    const p2 = act(() => view.result.current.handleNewChat());
    await p1;
    await p2;

    expect(window.sessionsAPI.createOrReuseEmpty).toHaveBeenCalledTimes(1);
  });
});
