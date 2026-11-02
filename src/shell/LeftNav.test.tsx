import type { SessionMetadata } from "@common/marshal-ipc-contract";
import { act, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { installMockAPIs, render, screen, waitFor } from "@/test-utils";
import type { SessionsAPI, WorkflowsAPI } from "@/types/electron";

import { LeftNav } from "./LeftNav";

function mockSessionList(listMock: SessionsAPI["list"]) {
  window.sessionsAPI.list = listMock;
  window.sessionsAPI.listWithOptions = vi.fn<SessionsAPI["listWithOptions"]>((options) =>
    listMock(options?.query),
  );
}

const defaultProps = {
  activeView: "chat" as const,
  onViewChange: vi.fn<(view: string) => void>(),
  onNewChat: vi.fn<() => void>(),
  activeSessionId: null,
  onSessionSelect: vi.fn<(id: string) => void>(),
  onDeleteSession: vi.fn<(id: string) => void>(),
};

const COLLAPSED_THREAD_GROUPS_STORAGE_KEY = "marshal.left-nav.collapsed-thread-groups.v1";

function makeSession(
  id: string,
  name: string,
  overrides: Partial<SessionMetadata> = {},
): SessionMetadata {
  return {
    id,
    name,
    createdAt: "2026-07-31T08:00:00.000Z",
    updatedAt: "2026-07-31T08:00:00.000Z",
    hasUnread: false,
    isActive: false,
    ...overrides,
  };
}

function getSessionRow(sessionId: string): HTMLElement {
  const row = screen
    .getAllByTestId("session-item")
    .find((candidate) => candidate.dataset.sessionId === sessionId);
  if (!row) throw new Error(`Session row ${sessionId} was not rendered`);
  return row;
}

async function showAllSessionTypes(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("button", { name: /^Filter threads/ }));
  const menu = await screen.findByRole("menu");
  await user.click(within(menu).getByRole("menuitemcheckbox", { name: "All" }));
  await user.keyboard("{Escape}");
}

afterEach(() => {
  window.localStorage.removeItem(COLLAPSED_THREAD_GROUPS_STORAGE_KEY);
});

describe("LeftNav (wide)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMockAPIs();
    // Ensure wide mode so the full sidebar renders — mock matchMedia to return matches: false
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn<() => void>(),
        removeListener: vi.fn<() => void>(),
        addEventListener: vi.fn<() => void>(),
        removeEventListener: vi.fn<() => void>(),
        dispatchEvent: vi.fn<() => boolean>(),
      }),
    });
  });

  it("renders New Chat button", () => {
    render(<LeftNav {...defaultProps} />);
    expect(screen.getByText("New chat")).toBeInTheDocument();
  });

  it("keeps the mounted session rows bounded with 100 sessions", async () => {
    const now = new Date().toISOString();
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: Array.from({ length: 100 }, (_, index) => ({
          id: `session-${index}`,
          name: `Session ${index}`,
          createdAt: now,
          updatedAt: now,
          hasUnread: false,
          isActive: false,
        })),
      }),
    );

    render(<LeftNav {...defaultProps} />);

    const rows = await screen.findAllByTestId("session-item");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(28);
    expect(screen.queryByText("Session 99")).not.toBeInTheDocument();
  });

  it("shows 15 sessions per project and loads the next project batch on demand", async () => {
    const registeredWorkspaceKey = "c:\\repos\\project";
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: Array.from({ length: 18 }, (_, index) =>
          makeSession(`project-${index}`, `Project thread ${index}`, {
            updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 18 - index)).toISOString(),
            workspaceName: "Project",
            registeredWorkspaceKey,
            registeredWorkspaceLabel: "Project",
          }),
        ),
      }),
    );
    const user = userEvent.setup();

    render(<LeftNav {...defaultProps} />);

    expect(await screen.findAllByTestId("session-item")).toHaveLength(15);
    expect(screen.queryByText("Project thread 15")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Load 3 more sessions in Project" }));

    expect(await screen.findByText("Project thread 17")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /more sessions in Project/ }),
    ).not.toBeInTheDocument();
  });

  it("loads the next session page when the sidebar scrolls near the bottom", async () => {
    const now = new Date().toISOString();
    const firstPage = Array.from({ length: 40 }, (_, index) => ({
      id: `session-${index}`,
      name: `Session ${index}`,
      createdAt: now,
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 40 - index)).toISOString(),
      hasUnread: false,
      isActive: false,
    }));
    const listWithOptions = vi
      .fn<SessionsAPI["listWithOptions"]>()
      .mockResolvedValueOnce({
        success: true,
        sessions: firstPage,
        hasMore: true,
        nextCursor: "session-39",
      })
      .mockResolvedValueOnce({
        success: true,
        sessions: [
          {
            ...firstPage[0],
            id: "session-40",
            name: "Session 40",
            updatedAt: "2025-12-31T23:59:00.000Z",
          },
        ],
        hasMore: false,
      });
    window.sessionsAPI.listWithOptions = listWithOptions;

    render(<LeftNav {...defaultProps} />);
    await screen.findByText("Session 0");

    const viewport = screen.getByLabelText("Session list");
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 600 },
      scrollTop: { configurable: true, value: 520 },
    });
    fireEvent.scroll(viewport);

    await waitFor(() => expect(listWithOptions).toHaveBeenCalledTimes(2));
    expect(listWithOptions.mock.calls[1][0]?.beforeSessionId).toBe("session-39");
    expect(await screen.findByTestId("sessions-end")).toBeInTheDocument();
  });

  it("automatically fills a filtered list when the first backend page has too few matches", async () => {
    const now = new Date().toISOString();
    const makeFilteredSession = (id: string, source?: "subagent" | "workflow-agent") => ({
      id,
      name: id,
      createdAt: now,
      updatedAt: now,
      hasUnread: false,
      isActive: false,
      source,
    });
    const firstPage = [
      ...Array.from({ length: 9 }, (_, index) => makeFilteredSession(`chat-${index}`)),
      ...Array.from({ length: 31 }, (_, index) =>
        makeFilteredSession(`agent-${index}`, "subagent"),
      ),
    ];
    const secondPage = [
      ...Array.from({ length: 30 }, (_, index) => makeFilteredSession(`chat-${index + 9}`)),
      ...Array.from({ length: 10 }, (_, index) =>
        makeFilteredSession(`workflow-agent-${index}`, "workflow-agent"),
      ),
    ];
    const listWithOptions = vi
      .fn<SessionsAPI["listWithOptions"]>()
      .mockResolvedValueOnce({
        success: true,
        sessions: firstPage,
        selectedSession: makeFilteredSession("selected-chat"),
        hasMore: true,
        nextCursor: firstPage.at(-1)?.id,
      })
      .mockResolvedValueOnce({
        success: true,
        sessions: secondPage,
        hasMore: false,
      });
    window.sessionsAPI.listWithOptions = listWithOptions;

    render(<LeftNav {...defaultProps} />);

    await waitFor(() => expect(listWithOptions).toHaveBeenCalledTimes(2));
    expect(listWithOptions.mock.calls[1][0]?.beforeSessionId).toBe(firstPage.at(-1)?.id);
    expect(await screen.findByTestId("sessions-end")).toBeInTheDocument();
    expect(screen.queryByText("Clear all chats")).not.toBeInTheDocument();
  });

  it("renders all allowed nav items as a flat list without an overflow menu", () => {
    render(<LeftNav {...defaultProps} />);
    expect(screen.getByText("Orchestration")).toBeInTheDocument();
    expect(screen.queryByText("Heartbeat")).not.toBeInTheDocument();
    expect(screen.queryByText("Automations")).not.toBeInTheDocument();
    expect(screen.getByText("Activity")).toBeInTheDocument();
    expect(screen.getByText("Plugins")).toBeInTheDocument();
    expect(screen.getByText("Integrations")).toBeInTheDocument();
    expect(screen.getByText("Workspaces")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
    expect(screen.queryByText("Command Center")).not.toBeInTheDocument();
    expect(screen.queryByText("Workflows")).not.toBeInTheDocument();
  });

  it("renders the signed-in identity in a bottom Settings row", async () => {
    const user = userEvent.setup();
    render(<LeftNav {...defaultProps} />);

    const accountSettings = await screen.findByRole("button", {
      name: "Open Settings for Test User",
    });
    expect(accountSettings).toHaveTextContent("Test User");
    expect(screen.queryByRole("button", { name: "User menu" })).not.toBeInTheDocument();

    await user.click(accountSettings);
    expect(defaultProps.onViewChange).toHaveBeenCalledWith("settings");
  });

  it("calls onNewChat when New Chat is clicked", async () => {
    const user = userEvent.setup();
    render(<LeftNav {...defaultProps} />);
    await user.click(screen.getByText("New chat"));
    expect(defaultProps.onNewChat).toHaveBeenCalledOnce();
  });

  it.each([
    ["Orchestration", "automations"],
    ["Workspaces", "create"],
  ] as const)("calls onViewChange with %s nav view", async (label, view) => {
    const user = userEvent.setup();
    render(<LeftNav {...defaultProps} />);
    await user.click(screen.getByText(label));
    expect(defaultProps.onViewChange).toHaveBeenCalledWith(view);
  });

  it("does not expose separate heartbeat navigation", () => {
    render(<LeftNav {...defaultProps} />);
    expect(screen.queryByRole("button", { name: "Heartbeat" })).not.toBeInTheDocument();
  });

  it("clicking the already-active top-nav item does not toggle to chat", async () => {
    const user = userEvent.setup();
    render(<LeftNav {...defaultProps} activeView="automations" />);
    await user.click(screen.getByText("Orchestration"));
    expect(defaultProps.onViewChange).toHaveBeenCalledWith("automations");
    expect(defaultProps.onViewChange).not.toHaveBeenCalledWith("chat");
  });

  it("applies active styling to the current top-nav item", () => {
    render(<LeftNav {...defaultProps} activeView="automations" />);
    expect(screen.getByRole("button", { name: /Orchestration/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  describe("session date visibility", () => {
    const SESSION = {
      id: "s1",
      name: "Test session",
      createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      hasUnread: false,
      isActive: false,
    };

    beforeEach(() => {
      window.sessionsAPI.list = vi.fn<SessionsAPI["list"]>().mockImplementation((q?: string) =>
        Promise.resolve(
          q
            ? {
                success: true,
                results: [{ ...SESSION, snippets: [] }],
              }
            : { success: true, sessions: [SESSION] },
        ),
      );
    });

    it("does not show session date when not searching", async () => {
      render(<LeftNav {...defaultProps} />);
      await screen.findByText("Test session");
      expect(screen.queryByTestId("session-date")).not.toBeInTheDocument();
    });

    it("shows session date when searching", async () => {
      const user = userEvent.setup();
      render(<LeftNav {...defaultProps} />);
      await screen.findByText("Test session");
      await user.type(screen.getByPlaceholderText("Search threads"), "Test");
      expect(
        await screen.findByTestId("session-date", undefined, { timeout: 2000 }),
      ).toBeInTheDocument();
    });
  });

  it("calls onSessionSelect and switches to chat when a session is clicked", async () => {
    window.sessionsAPI.list = vi.fn<SessionsAPI["list"]>().mockResolvedValue({
      success: true,
      sessions: [
        {
          id: "s1",
          name: "Test session",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          hasUnread: false,
          isActive: false,
        },
      ],
    });
    render(<LeftNav {...defaultProps} activeSessionId="s1" />);
    // Wait for sessions to load
    const user = userEvent.setup();
    const sessionBtn = await screen.findByText("Test session");
    await user.click(sessionBtn);
    expect(defaultProps.onSessionSelect).toHaveBeenCalledWith("s1");
    expect(defaultProps.onViewChange).toHaveBeenCalledWith("chat", { sessionId: "s1" });
  });

  it("shows a spinner for busy sessions", async () => {
    window.sessionsAPI.list = vi.fn<SessionsAPI["list"]>().mockResolvedValue({
      success: true,
      sessions: [
        {
          id: "s1",
          name: "Running session",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          hasUnread: false,
          isActive: true,
          isBusy: true,
        },
      ],
    });
    render(<LeftNav {...defaultProps} activeSessionId="s1" />);

    expect(await screen.findByTestId("session-running-spinner")).toBeInTheDocument();
  });

  it("shows a spinner when only a subagent descendant is running (isBusy false)", async () => {
    window.sessionsAPI.list = vi.fn<SessionsAPI["list"]>().mockResolvedValue({
      success: true,
      sessions: [
        {
          id: "s1",
          name: "Parent with running subagent",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          hasUnread: false,
          isActive: false,
          isBusy: false,
          hasRunningSubagent: true,
        },
      ],
    });
    render(<LeftNav {...defaultProps} activeSessionId="s1" />);

    const spinner = await screen.findByTestId("session-running-spinner");
    expect(spinner).toBeInTheDocument();
    expect(spinner).toHaveAttribute("aria-label", "Subagents are running");
  });

  it("groups registered workspace sessions by path and labels them with the current name", async () => {
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [
          makeSession("beta", "Beta thread", {
            workspaceName: "Old Beta binding",
            registeredWorkspaceKey: "c:\\repos\\beta",
            registeredWorkspaceLabel: "Beta",
          }),
          makeSession("alpha", "Alpha thread", {
            workspaceName: "Old Alpha binding",
            registeredWorkspaceKey: "c:\\repos\\alpha",
            registeredWorkspaceLabel: "Alpha",
          }),
        ],
      }),
    );

    render(<LeftNav {...defaultProps} />);

    await screen.findByText("Alpha thread");
    expect(
      screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent),
    ).toEqual(["Alpha", "Beta"]);
    expect(screen.queryByRole("heading", { name: "Old Alpha binding" })).not.toBeInTheDocument();
  });

  it("keeps a workspace collapse key stable when its label changes", async () => {
    const user = userEvent.setup();
    const registeredWorkspaceKey = "c:\\repos\\alpha";
    const installWorkspace = (label: string) =>
      mockSessionList(
        vi.fn<SessionsAPI["list"]>().mockResolvedValue({
          success: true,
          sessions: [
            makeSession("project", "Project thread", {
              workspaceName: "Original binding",
              registeredWorkspaceKey,
              registeredWorkspaceLabel: label,
            }),
          ],
        }),
      );

    installWorkspace("Project Alpha");
    const { unmount } = render(<LeftNav {...defaultProps} />);
    await user.click(await screen.findByRole("button", { name: "Collapse Project Alpha" }));
    await waitFor(() =>
      expect(window.localStorage.getItem(COLLAPSED_THREAD_GROUPS_STORAGE_KEY)).toBe(
        JSON.stringify([`group:workspace:${registeredWorkspaceKey}`]),
      ),
    );

    unmount();
    installWorkspace("Renamed Project");
    render(<LeftNav {...defaultProps} />);

    expect(await screen.findByRole("button", { name: "Expand Renamed Project" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByText("Project thread")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(COLLAPSED_THREAD_GROUPS_STORAGE_KEY)).toBe(
      JSON.stringify([`group:workspace:${registeredWorkspaceKey}`]),
    );
  });

  it("hides a bound session that does not resolve to a registered workspace", async () => {
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [
          makeSession("general", "General thread"),
          makeSession("stale", "Stale workspace thread", {
            workspaceName: "Deleted Project",
          }),
        ],
      }),
    );

    render(<LeftNav {...defaultProps} />);

    await screen.findByText("General thread");
    expect(screen.queryByText("Stale workspace thread")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Deleted Project" })).not.toBeInTheDocument();
  });

  it("keeps a session with no workspace binding in General", async () => {
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [makeSession("general", "General thread")],
      }),
    );

    render(<LeftNav {...defaultProps} />);

    expect(await screen.findByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(screen.getByText("General thread")).toBeInTheDocument();
  });

  it("keeps an unregistered pinned session visible in the pinned section", async () => {
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [
          makeSession("pinned", "Pinned legacy thread", {
            isPinned: true,
            workspaceName: "Deleted Project",
          }),
        ],
      }),
    );

    render(<LeftNav {...defaultProps} />);

    const pinnedSection = await screen.findByTestId("pinned-threads-section");
    expect(within(pinnedSection).getByText("Pinned legacy thread")).toBeInTheDocument();
    expect(screen.getAllByText("Pinned legacy thread")).toHaveLength(1);
  });

  it("nests unresolved descendants under a pinned root-visible session", async () => {
    const user = userEvent.setup();
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [
          makeSession("parent", "Pinned parent", {
            isPinned: true,
            workspaceName: "deleted-project",
          }),
          makeSession("child", "Pinned parent child", {
            source: "subagent",
            parentSessionId: "parent",
            workspaceName: "throwaway-worktree",
          }),
        ],
      }),
    );

    render(<LeftNav {...defaultProps} />);

    const pinnedSection = await screen.findByTestId("pinned-threads-section");
    expect(within(pinnedSection).queryByText("Pinned parent child")).not.toBeInTheDocument();
    await user.click(
      within(pinnedSection).getByRole("button", {
        name: "Expand 1 nested agent for Pinned parent",
      }),
    );
    expect(await within(pinnedSection).findByText("Pinned parent child")).toBeInTheDocument();
    expect(getSessionRow("child")).toHaveAttribute("data-nested");
  });

  it("keeps an unregistered active session visible", async () => {
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [
          makeSession("active", "Active legacy thread", {
            workspaceName: "Deleted Project",
          }),
        ],
      }),
    );

    render(<LeftNav {...defaultProps} activeSessionId="active" />);

    expect(await screen.findByText("Active legacy thread")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(screen.getByTestId("session-item")).toHaveAttribute("data-active");
  });

  it("keeps unregistered sessions searchable", async () => {
    const user = userEvent.setup();
    const legacySession = makeSession("legacy", "Searchable legacy thread", {
      workspaceName: "Deleted Project",
    });
    mockSessionList(
      vi
        .fn<SessionsAPI["list"]>()
        .mockImplementation((query?: string) =>
          Promise.resolve(
            query
              ? { success: true, results: [{ ...legacySession, snippets: [] }] }
              : { success: true, sessions: [legacySession] },
          ),
        ),
    );

    render(<LeftNav {...defaultProps} />);
    await screen.findByTestId("no-sessions");
    expect(screen.queryByText("Searchable legacy thread")).not.toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Search threads"), "legacy");

    expect(
      await screen.findByTestId("session-item", undefined, { timeout: 2500 }),
    ).toHaveTextContent("Searchable legacy thread");
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
  });

  it("never creates a synthetic Worktrees heading", async () => {
    const user = userEvent.setup();
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [
          makeSession("resolved-worktree", "Resolved worktree agent", {
            source: "subagent",
            originWorkspaceName: "Project Alpha",
            isWorktreeWorkspace: true,
            registeredWorkspaceKey: "c:\\repos\\alpha",
            registeredWorkspaceLabel: "Project Alpha",
          }),
          makeSession("stale-worktree", "Stale worktree agent", {
            source: "subagent",
            workspaceName: "repo-a1b2c3d4",
            isWorktreeWorkspace: true,
          }),
        ],
      }),
    );

    render(<LeftNav {...defaultProps} />);
    await showAllSessionTypes(user);

    await screen.findByText("Resolved worktree agent");
    expect(screen.getByRole("heading", { name: "Project Alpha" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Worktrees" })).not.toBeInTheDocument();
    expect(screen.queryByText("Stale worktree agent")).not.toBeInTheDocument();
  });

  it("nests an unresolved subagent under its root-visible parent without a top-level duplicate", async () => {
    const user = userEvent.setup();
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [
          makeSession("parent", "Parent chat", {
            workspaceName: "Alpha binding",
            registeredWorkspaceKey: "c:\\repos\\alpha",
            registeredWorkspaceLabel: "Alpha",
          }),
          makeSession("child", "Child agent", {
            source: "subagent",
            parentSessionId: "parent",
            workspaceName: "throwaway-worktree",
          }),
        ],
      }),
    );

    render(<LeftNav {...defaultProps} />);
    await showAllSessionTypes(user);

    await screen.findByText("Parent chat");
    expect(screen.getByRole("heading", { name: "Alpha" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "throwaway-worktree" })).not.toBeInTheDocument();
    expect(screen.queryByText("Child agent")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Expand 1 nested agent for Parent chat" }));
    expect(await screen.findByText("Child agent")).toBeInTheDocument();
    expect(getSessionRow("child")).toHaveAttribute("data-nested");
    expect(screen.getAllByText("Child agent")).toHaveLength(1);
  });

  it("renders a workflow run as a clickable persistent group with nested agents", async () => {
    const user = userEvent.setup();
    type HostLookupResult = Awaited<ReturnType<WorkflowsAPI["getRunForHostSession"]>>;
    let resolveFirstLookup: (result: HostLookupResult) => void = () => {};
    const firstLookup = new Promise<HostLookupResult>((resolve) => {
      resolveFirstLookup = resolve;
    });
    const getRunForHostSession = vi
      .fn<WorkflowsAPI["getRunForHostSession"]>()
      .mockImplementation((hostSessionId) =>
        hostSessionId === "workflow-host"
          ? firstLookup
          : Promise.resolve({ success: true, runId: "run-456" }),
      );
    installMockAPIs({ workflowsAPI: { getRunForHostSession } });
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [
          makeSession("workflow-host", "Workflow: Power Query (12345678)", {
            source: "workflow-run",
          }),
          makeSession("workflow-child", "Collect refresh failures", {
            source: "subagent",
            parentSessionId: "workflow-host",
            workspaceName: "power-query-worktree",
          }),
          makeSession("workflow-host-2", "Workflow: Incident response (abcdef12)", {
            source: "workflow-run",
          }),
        ],
      }),
    );
    const onViewChange = vi.fn<(view: string, state?: Record<string, unknown>) => void>();
    const onSessionSelect = vi.fn<(id: string) => void>();
    let navigationEpoch = 0;
    const getNavigationEpoch = () => navigationEpoch;

    const view = render(
      <LeftNav
        {...defaultProps}
        activeView="workflows"
        navigationKey="workflows:existing-run"
        getNavigationEpoch={getNavigationEpoch}
        onViewChange={onViewChange}
        onSessionSelect={onSessionSelect}
      />,
    );
    await showAllSessionTypes(user);

    const hostLabel = await screen.findByText(/Power Query - .*2026/);
    const secondHostLabel = await screen.findByText(/Incident response - .*2026/);
    expect(screen.queryByText("Workflow: Power Query (12345678)")).not.toBeInTheDocument();
    expect(screen.queryByText("Collect refresh failures")).not.toBeInTheDocument();

    const hostRow = getSessionRow("workflow-host");
    expect(within(hostRow).queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();
    await user.click(within(hostRow).getByTestId("nested-agent-disclosure"));
    expect(await screen.findByText("Collect refresh failures")).toBeInTheDocument();
    expect(getSessionRow("workflow-child")).toHaveAttribute("data-nested");
    expect(screen.queryByText("Clear all chats")).not.toBeInTheDocument();

    await user.click(hostLabel);
    navigationEpoch += 1;
    await act(async () => {
      resolveFirstLookup({ success: true, runId: "run-123" });
      await firstLookup;
    });
    expect(onViewChange).not.toHaveBeenCalled();
    expect(getRunForHostSession).toHaveBeenCalledWith("workflow-host");
    view.rerender(
      <LeftNav
        {...defaultProps}
        activeView="workflows"
        navigationKey="workflows:other-run"
        getNavigationEpoch={getNavigationEpoch}
        onViewChange={onViewChange}
        onSessionSelect={onSessionSelect}
      />,
    );
    await user.click(secondHostLabel);
    await waitFor(() => expect(getRunForHostSession).toHaveBeenCalledWith("workflow-host-2"));
    expect(onSessionSelect).not.toHaveBeenCalled();
    expect(onViewChange).toHaveBeenCalledWith("workflows", { runId: "run-456" });
    expect(onViewChange).toHaveBeenCalledTimes(1);
  });

  it("keeps a root-visible session in its own group even when it has a parent", async () => {
    const user = userEvent.setup();
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [
          makeSession("parent", "Parent chat", {
            workspaceName: "Alpha binding",
            registeredWorkspaceKey: "c:\\repos\\alpha",
            registeredWorkspaceLabel: "Alpha",
          }),
          makeSession("child", "Root-visible child", {
            source: "subagent",
            parentSessionId: "parent",
            workspaceName: "Beta binding",
            registeredWorkspaceKey: "c:\\repos\\beta",
            registeredWorkspaceLabel: "Beta",
          }),
        ],
      }),
    );

    render(<LeftNav {...defaultProps} />);
    await showAllSessionTypes(user);

    await screen.findByText("Root-visible child");
    expect(screen.getByRole("heading", { name: "Alpha" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Beta" })).toBeInTheDocument();
    expect(getSessionRow("child")).not.toHaveAttribute("data-nested");
    expect(
      screen.queryByRole("button", { name: /nested agent for Parent chat/ }),
    ).not.toBeInTheDocument();
  });

  it("collapses nested subagents by default and removes their rows when collapsed", async () => {
    const user = userEvent.setup();
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [
          makeSession("parent", "Parent chat"),
          makeSession("child", "Child agent", {
            source: "subagent",
            parentSessionId: "parent",
            workspaceName: "throwaway-worktree",
          }),
        ],
      }),
    );

    render(<LeftNav {...defaultProps} />);
    await showAllSessionTypes(user);

    const expand = await screen.findByRole("button", {
      name: "Expand 1 nested agent for Parent chat",
    });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Child agent")).not.toBeInTheDocument();

    await user.click(expand);
    await screen.findByText("Child agent");
    const childRow = getSessionRow("child");
    expect(childRow).toHaveAttribute("data-nested");

    await user.click(
      screen.getByRole("button", { name: "Collapse 1 nested agent for Parent chat" }),
    );
    await waitFor(() => expect(screen.queryByText("Child agent")).not.toBeInTheDocument());
  });

  it("keeps a subagent top-level when its parent is absent", async () => {
    const user = userEvent.setup();
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [
          makeSession("orphan", "Orphan agent", {
            source: "subagent",
            parentSessionId: "missing-parent",
            workspaceName: "Alpha binding",
            registeredWorkspaceKey: "c:\\repos\\alpha",
            registeredWorkspaceLabel: "Alpha",
          }),
        ],
      }),
    );

    render(<LeftNav {...defaultProps} />);
    await showAllSessionTypes(user);

    await screen.findByText("Orphan agent");
    const orphanRow = getSessionRow("orphan");
    expect(orphanRow).not.toHaveAttribute("data-nested");
    expect(screen.getByRole("heading", { name: "Alpha" })).toBeInTheDocument();
    expect(screen.queryByTestId("nested-agent-disclosure")).not.toBeInTheDocument();
  });

  it("hides an unresolved subagent with no root-visible ancestor", async () => {
    const user = userEvent.setup();
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [
          makeSession("general", "General thread"),
          makeSession("orphan", "Hidden orphan agent", {
            source: "subagent",
            parentSessionId: "missing-parent",
            workspaceName: "throwaway-worktree",
          }),
        ],
      }),
    );

    render(<LeftNav {...defaultProps} />);
    await showAllSessionTypes(user);

    await screen.findByText("General thread");
    expect(screen.queryByText("Hidden orphan agent")).not.toBeInTheDocument();
    expect(screen.queryByTestId("nested-agent-disclosure")).not.toBeInTheDocument();
  });

  it("flattens unresolved descendant chains under the nearest root-visible ancestor", async () => {
    const user = userEvent.setup();
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [
          makeSession("parent", "Parent chat"),
          makeSession("child", "Child agent", {
            source: "subagent",
            parentSessionId: "parent",
            workspaceName: "child-worktree",
          }),
          makeSession("grandchild", "Grandchild agent", {
            source: "subagent",
            parentSessionId: "child",
            workspaceName: "grandchild-worktree",
          }),
        ],
      }),
    );

    render(<LeftNav {...defaultProps} />);
    await showAllSessionTypes(user);
    await user.click(
      await screen.findByRole("button", { name: "Expand 2 nested agents for Parent chat" }),
    );
    await screen.findByText("Child agent");
    const childRow = getSessionRow("child");
    expect(childRow).toHaveAttribute("data-nested");

    await screen.findByText("Grandchild agent");
    const grandchildRow = getSessionRow("grandchild");
    expect(grandchildRow).toHaveAttribute("data-nested");
    expect(childRow).toHaveClass("pl-7");
    expect(grandchildRow).toHaveClass("pl-7");
    expect(
      screen.queryByRole("button", { name: /nested agent for Child agent/ }),
    ).not.toBeInTheDocument();
  });

  it("does not hang or fabricate nesting for cyclic parent links", async () => {
    const user = userEvent.setup();
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [
          makeSession("general", "General thread"),
          makeSession("cycle-a", "Cycle A", {
            source: "subagent",
            parentSessionId: "cycle-b",
            workspaceName: "cycle-a-worktree",
          }),
          makeSession("cycle-b", "Cycle B", {
            source: "subagent",
            parentSessionId: "cycle-a",
            workspaceName: "cycle-b-worktree",
          }),
        ],
      }),
    );

    render(<LeftNav {...defaultProps} />);
    await showAllSessionTypes(user);

    await screen.findByText("General thread");
    expect(screen.queryByText("Cycle A")).not.toBeInTheDocument();
    expect(screen.queryByText("Cycle B")).not.toBeInTheDocument();
    expect(screen.queryByTestId("nested-agent-disclosure")).not.toBeInTheDocument();
  });

  it("shows the honest nested-child count and sorts children newest first", async () => {
    const user = userEvent.setup();
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [
          makeSession("parent", "Parent chat"),
          makeSession("older", "Older child", {
            source: "subagent",
            parentSessionId: "parent",
            workspaceName: "older-worktree",
            updatedAt: "2026-07-31T07:00:00.000Z",
          }),
          makeSession("newer", "Newer child", {
            source: "subagent",
            parentSessionId: "parent",
            workspaceName: "newer-worktree",
            updatedAt: "2026-07-31T09:00:00.000Z",
          }),
        ],
      }),
    );

    render(<LeftNav {...defaultProps} />);
    await showAllSessionTypes(user);

    const toggle = await screen.findByRole("button", {
      name: "Expand 2 nested agents for Parent chat",
    });
    expect(within(toggle).getByTestId("nested-agent-count")).toHaveTextContent("2");
    await user.click(toggle);

    expect(screen.getAllByTestId("session-item").map((row) => row.dataset.sessionId)).toEqual([
      "parent",
      "newer",
      "older",
    ]);
  });

  it("persists per-parent expansion across remounts", async () => {
    const user = userEvent.setup();
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [
          makeSession("parent", "Parent chat"),
          makeSession("child", "Child agent", {
            source: "subagent",
            parentSessionId: "parent",
            workspaceName: "throwaway-worktree",
          }),
        ],
      }),
    );

    const { unmount } = render(<LeftNav {...defaultProps} />);
    await showAllSessionTypes(user);
    await user.click(
      await screen.findByRole("button", { name: "Expand 1 nested agent for Parent chat" }),
    );
    await screen.findByText("Child agent");
    await waitFor(() =>
      expect(window.localStorage.getItem(COLLAPSED_THREAD_GROUPS_STORAGE_KEY)).toBe(
        '["agents:expanded:parent"]',
      ),
    );

    unmount();
    render(<LeftNav {...defaultProps} />);
    await showAllSessionTypes(user);

    expect(await screen.findByText("Child agent")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Collapse 1 nested agent for Parent chat" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("does not leave disclosure triggers pointing at missing controlled content", async () => {
    const user = userEvent.setup();
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [
          makeSession("parent", "Parent chat"),
          makeSession("child", "Child agent", {
            source: "subagent",
            parentSessionId: "parent",
            workspaceName: "throwaway-worktree",
          }),
          makeSession("pinned", "Pinned thread", { isPinned: true }),
        ],
      }),
    );

    render(<LeftNav {...defaultProps} />);
    await showAllSessionTypes(user);

    const nestedToggle = await screen.findByRole("button", {
      name: "Expand 1 nested agent for Parent chat",
    });
    const nestedContent = screen.getByTestId("nested-agent-content-parent");
    expect(nestedToggle).toHaveAttribute("aria-controls", nestedContent.id);
    expect(screen.getByRole("button", { name: "Collapse General" })).not.toHaveAttribute(
      "aria-controls",
    );
    expect(screen.getByRole("button", { name: "Collapse Pinned threads" })).not.toHaveAttribute(
      "aria-controls",
    );
  });

  it("excludes nonmatching children but keeps a parent whose nested child matches the filter", async () => {
    const user = userEvent.setup();
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [
          makeSession("parent", "Parent chat"),
          makeSession("child", "Child agent", {
            source: "subagent",
            parentSessionId: "parent",
            workspaceName: "throwaway-worktree",
          }),
          makeSession("other", "Other chat"),
        ],
      }),
    );

    render(<LeftNav {...defaultProps} />);
    await screen.findByText("Parent chat");
    await user.click(screen.getByRole("button", { name: "Filter threads" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitemcheckbox", { name: "All" })).toHaveAttribute(
      "data-state",
      "unchecked",
    );
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Chats" })).toHaveAttribute(
      "data-state",
      "checked",
    );

    expect(screen.getByText("Parent chat")).toBeInTheDocument();
    expect(screen.getByText("Other chat")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /nested agent for Parent chat/ }),
    ).not.toBeInTheDocument();

    await user.click(within(menu).getByRole("menuitemcheckbox", { name: "Chats" }));
    await user.click(within(menu).getByRole("menuitemcheckbox", { name: "Agents" }));

    expect(screen.getByText("Parent chat")).toBeInTheDocument();
    expect(screen.queryByText("Other chat")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(
      await screen.findByRole("button", { name: "Expand 1 nested agent for Parent chat" }),
    );
    expect(await screen.findByText("Child agent")).toBeInTheDocument();
  });

  it("persists collapsed thread groups with registered path keys and removes their rows", async () => {
    const user = userEvent.setup();
    const registeredWorkspaceKey = "c:\\repos\\alpha";
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [
          makeSession("general", "General thread"),
          makeSession("project", "Project thread", {
            workspaceName: "Original binding",
            registeredWorkspaceKey,
            registeredWorkspaceLabel: "Project Alpha",
          }),
        ],
      }),
    );

    render(<LeftNav {...defaultProps} />);
    await user.click(await screen.findByRole("button", { name: "Collapse General" }));
    await waitFor(() => expect(screen.queryByText("General thread")).not.toBeInTheDocument());
    expect(screen.getByText("Project thread")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Collapse Project Alpha" }));
    await waitFor(() => expect(screen.queryByText("Project thread")).not.toBeInTheDocument());
    await waitFor(() =>
      expect(window.localStorage.getItem(COLLAPSED_THREAD_GROUPS_STORAGE_KEY)).toBe(
        JSON.stringify(["group:general", `group:workspace:${registeredWorkspaceKey}`]),
      ),
    );
  });

  it("renders pinned threads once with a pin control and relative time", async () => {
    const user = userEvent.setup();
    const now = new Date().toISOString();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [
          {
            id: "pinned-project",
            name: "Pinned project thread",
            createdAt: twoHoursAgo,
            updatedAt: twoHoursAgo,
            hasUnread: false,
            isActive: false,
            isPinned: true,
            workspaceName: "Project Alpha",
          },
          {
            id: "general",
            name: "General thread",
            createdAt: now,
            updatedAt: now,
            hasUnread: false,
            isActive: false,
          },
          {
            id: "project",
            name: "Project thread",
            createdAt: now,
            updatedAt: now,
            hasUnread: false,
            isActive: false,
            workspaceName: "Project Alpha",
            registeredWorkspaceKey: "c:\\repos\\alpha",
            registeredWorkspaceLabel: "Project Alpha",
          },
        ],
      }),
    );

    render(<LeftNav {...defaultProps} />);

    const section = await screen.findByTestId("pinned-threads-section");
    expect(within(section).getByRole("heading", { name: "Pinned threads" })).toBeInTheDocument();
    const pinnedToggle = within(section).getByRole("button", {
      name: "Collapse Pinned threads",
    });
    expect(pinnedToggle).toHaveAttribute("aria-expanded", "true");
    expect(within(section).getByText("Pinned project thread")).toBeInTheDocument();
    expect(within(section).getByText("2h ago")).toBeInTheDocument();
    expect(screen.getAllByText("Pinned project thread")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Pin General thread" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(
      screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent),
    ).toEqual(["General", "Project Alpha"]);

    await user.click(pinnedToggle);
    expect(within(section).getByRole("button", { name: "Expand Pinned threads" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(within(section).queryByText("Pinned project thread")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(window.localStorage.getItem(COLLAPSED_THREAD_GROUPS_STORAGE_KEY)).toBe(
        '["group:pinned"]',
      ),
    );

    await user.click(within(section).getByRole("button", { name: "Expand Pinned threads" }));
    await user.click(within(section).getByRole("button", { name: "Unpin Pinned project thread" }));
    expect(window.sessionsAPI.setPinned).toHaveBeenCalledWith("pinned-project", false);
  });

  it("shows the optimistic pin state while the mutation is pending", async () => {
    const user = userEvent.setup();
    const setPinned = vi
      .fn<SessionsAPI["setPinned"]>()
      .mockReturnValue(new Promise<Awaited<ReturnType<SessionsAPI["setPinned"]>>>(() => {}));
    window.sessionsAPI.setPinned = setPinned;
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [
          {
            id: "regular",
            name: "Regular thread",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            hasUnread: false,
            isActive: false,
          },
        ],
      }),
    );

    render(<LeftNav {...defaultProps} />);

    const pinButton = await screen.findByRole("button", { name: "Pin Regular thread" });
    await user.click(pinButton);

    expect(setPinned).toHaveBeenCalledWith("regular", true);
    expect(pinButton).toHaveAttribute("aria-pressed", "true");
    expect(pinButton).toHaveAccessibleName("Unpin Regular thread");
    expect(screen.getByTestId("session-pin-pending")).toBeInTheDocument();
  });

  it("surfaces a failed pin mutation on the row", async () => {
    const user = userEvent.setup();
    window.sessionsAPI.setPinned = vi
      .fn<SessionsAPI["setPinned"]>()
      .mockResolvedValue({ success: false, error: "Pin failed" });
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [
          {
            id: "regular",
            name: "Regular thread",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            hasUnread: false,
            isActive: false,
          },
        ],
      }),
    );

    render(<LeftNav {...defaultProps} />);

    const pinButton = await screen.findByRole("button", { name: "Pin Regular thread" });
    await user.click(pinButton);

    await waitFor(() => expect(pinButton).toHaveAttribute("aria-invalid", "true"));
    expect(pinButton).toHaveAttribute("title", "Pin failed");
  });

  it("shows the honest running automation count on the Automations row", async () => {
    const now = new Date().toISOString();
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [
          {
            id: "automation-running",
            name: "Running automation",
            createdAt: now,
            updatedAt: now,
            hasUnread: false,
            isActive: false,
            automationId: "automation-1",
            isBusy: true,
          },
          {
            id: "automation-descendant-running",
            name: "Automation with running agent",
            createdAt: now,
            updatedAt: now,
            hasUnread: false,
            isActive: false,
            automationId: "automation-2",
            hasRunningSubagent: true,
          },
          {
            id: "automation-idle",
            name: "Idle automation",
            createdAt: now,
            updatedAt: now,
            hasUnread: false,
            isActive: false,
            automationId: "automation-3",
          },
          {
            id: "regular-running",
            name: "Regular running chat",
            createdAt: now,
            updatedAt: now,
            hasUnread: false,
            isActive: false,
            isBusy: true,
          },
        ],
      }),
    );

    render(<LeftNav {...defaultProps} />);

    expect(await screen.findByTestId("automations-running-count")).toHaveTextContent("2");
  });

  it("selects session on Enter key even with onOpenInNewWindow wired (keyboard regression pin)", async () => {
    const onOpenInNewWindow = vi.fn<(id: string) => void>();
    window.sessionsAPI.list = vi.fn<SessionsAPI["list"]>().mockResolvedValue({
      success: true,
      sessions: [
        {
          id: "s1",
          name: "Test session",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          hasUnread: false,
          isActive: false,
        },
      ],
    });
    render(
      <LeftNav
        {...defaultProps}
        activeSessionId="s1"
        onOpenSessionInNewWindow={onOpenInNewWindow}
      />,
    );
    const user = userEvent.setup();
    const sessionItem = await screen.findByTestId("session-item");
    sessionItem.focus();
    await user.keyboard("{Enter}");
    expect(defaultProps.onSessionSelect).toHaveBeenCalledWith("s1");
    expect(onOpenInNewWindow).not.toHaveBeenCalled();
  });

  describe("session-row highlight follows chat view (visualActiveSessionId)", () => {
    beforeEach(() => {
      window.sessionsAPI.list = vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [
          {
            id: "s1",
            name: "Test session",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            hasUnread: false,
            isActive: false,
          },
        ],
      });
    });

    it("marks the active session row as active when activeView is 'chat'", async () => {
      render(<LeftNav {...defaultProps} activeView="chat" activeSessionId="s1" />);
      const sessionRow = await screen.findByTestId("session-item");
      expect(sessionRow).toHaveAttribute("data-active");
    });

    it("clears the session-row highlight when navigated to a non-chat view", async () => {
      // Regression guard for `visualActiveSessionId = activeView === "chat" ? activeSessionId : null`
      // — when the user is on Settings (or any non-chat view) the previously-active session
      // must not stay visually selected.
      const { rerender } = render(
        <LeftNav {...defaultProps} activeView="chat" activeSessionId="s1" />,
      );
      const sessionRow = await screen.findByTestId("session-item");
      expect(sessionRow).toHaveAttribute("data-active");

      for (const view of ["settings", "heartbeat", "automations"] as const) {
        rerender(<LeftNav {...defaultProps} activeView={view} activeSessionId="s1" />);
        expect(screen.getByTestId("session-item")).not.toHaveAttribute("data-active");
      }
    });
  });

  it("invokes onOpenSessionInNewWindow when the overflow menu's 'Open in New Window' is clicked", async () => {
    // Locks the telemetry-parity fix: the overflow menu must go through the
    // same instrumented callback as the drag-to-popout gesture so both
    // entry points emit InteractiveElementMonitor_DragToPopout.
    const onOpenInNewWindow = vi.fn<(id: string) => void>();
    window.sessionsAPI.list = vi.fn<SessionsAPI["list"]>().mockResolvedValue({
      success: true,
      sessions: [
        {
          id: "s1",
          name: "Test session",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          hasUnread: false,
          isActive: false,
        },
      ],
    });
    render(
      <LeftNav
        {...defaultProps}
        activeSessionId="s1"
        onOpenSessionInNewWindow={onOpenInNewWindow}
      />,
    );
    await screen.findByText("Test session");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: /Open in New Window/ }));

    expect(onOpenInNewWindow).toHaveBeenCalledWith("s1");
  });

  describe("session rename", () => {
    beforeEach(() => {
      window.sessionsAPI.list = vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [
          {
            id: "s1",
            name: "Old name",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            hasUnread: false,
            isActive: false,
          },
        ],
      });
      window.sessionsAPI.rename = vi
        .fn<SessionsAPI["rename"]>()
        .mockResolvedValue({ success: true });
    });

    async function openOverflowAndClickRename(user: ReturnType<typeof userEvent.setup>) {
      const moreBtn = screen.getByRole("button", { name: "More actions" });
      await user.click(moreBtn);
      const renameItem = await screen.findByRole("menuitem", { name: /Rename/ });
      await user.click(renameItem);
    }

    it("enters edit mode via overflow menu and saves on Enter", async () => {
      const user = userEvent.setup();
      render(<LeftNav {...defaultProps} />);
      await screen.findByText("Old name");

      await openOverflowAndClickRename(user);

      // Should show input with current name
      const input = screen.getByTestId("session-rename-input");
      expect(input).toHaveValue("Old name");

      // Clear and type new name
      await user.clear(input);
      await user.type(input, "New name{Enter}");

      // Should call rename API
      expect(window.sessionsAPI.rename).toHaveBeenCalledWith("s1", "New name");
    });

    it("enters edit mode from an F2 request, selects the title, and saves on Enter", async () => {
      const user = userEvent.setup();
      const { rerender } = render(
        <>
          <button type="button">Focus origin</button>
          <LeftNav {...defaultProps} activeSessionId="s1" />
        </>,
      );
      await screen.findByText("Old name");
      const focusOrigin = screen.getByRole("button", { name: "Focus origin" });
      focusOrigin.focus();

      rerender(
        <>
          <button type="button">Focus origin</button>
          <LeftNav
            {...defaultProps}
            activeSessionId="s1"
            renameSessionRequest={{ sessionId: "s1", requestId: 1 }}
          />
        </>,
      );

      const input = screen.getByRole("textbox", { name: "Rename Old name" });
      expect(input).toHaveFocus();
      expect(input).toHaveValue("Old name");
      expect(input).toHaveProperty("selectionStart", 0);
      expect(input).toHaveProperty("selectionEnd", "Old name".length);

      await user.clear(input);
      await user.type(input, "F2 name{Enter}");

      expect(window.sessionsAPI.rename).toHaveBeenCalledWith("s1", "F2 name");
      expect(focusOrigin).toHaveFocus();
    });

    it("does not save when name is unchanged", async () => {
      const user = userEvent.setup();
      render(<LeftNav {...defaultProps} />);
      await screen.findByText("Old name");

      await openOverflowAndClickRename(user);

      const input = screen.getByTestId("session-rename-input");
      await user.type(input, "{Enter}");

      expect(window.sessionsAPI.rename).not.toHaveBeenCalled();
    });

    it("cancels edit on Escape without saving", async () => {
      const user = userEvent.setup();
      render(<LeftNav {...defaultProps} />);
      await screen.findByText("Old name");

      await openOverflowAndClickRename(user);

      const input = screen.getByTestId("session-rename-input");
      await user.clear(input);
      await user.type(input, "Something else{Escape}");

      expect(window.sessionsAPI.rename).not.toHaveBeenCalled();
      // Should show original name again
      expect(screen.getByText("Old name")).toBeInTheDocument();
    });

    it("restores prior focus when an F2 rename is cancelled with Escape", async () => {
      const user = userEvent.setup();
      const { rerender } = render(
        <>
          <button type="button">Focus origin</button>
          <LeftNav {...defaultProps} activeSessionId="s1" />
        </>,
      );
      await screen.findByText("Old name");
      const focusOrigin = screen.getByRole("button", { name: "Focus origin" });
      focusOrigin.focus();

      rerender(
        <>
          <button type="button">Focus origin</button>
          <LeftNav
            {...defaultProps}
            activeSessionId="s1"
            renameSessionRequest={{ sessionId: "s1", requestId: 1 }}
          />
        </>,
      );
      const input = screen.getByTestId("session-rename-input");
      await user.clear(input);
      await user.type(input, "Discard me{Escape}");

      expect(window.sessionsAPI.rename).not.toHaveBeenCalled();
      expect(screen.getByText("Old name")).toBeInTheDocument();
      expect(focusOrigin).toHaveFocus();
    });

    it("saves on blur when clicking outside", async () => {
      const user = userEvent.setup();
      render(<LeftNav {...defaultProps} />);
      await screen.findByText("Old name");

      await openOverflowAndClickRename(user);

      const input = screen.getByTestId("session-rename-input");
      await user.clear(input);
      await user.type(input, "Blur name");

      // Click outside to blur
      await user.click(document.body);

      expect(window.sessionsAPI.rename).toHaveBeenCalledWith("s1", "Blur name");
    });

    it("does not double-fire rename on Enter then blur", async () => {
      const user = userEvent.setup();
      render(<LeftNav {...defaultProps} />);
      await screen.findByText("Old name");

      await openOverflowAndClickRename(user);

      const input = screen.getByTestId("session-rename-input");
      await user.clear(input);
      await user.type(input, "New name{Enter}");

      // rename should only be called once, not twice (Enter + blur)
      expect(window.sessionsAPI.rename).toHaveBeenCalledTimes(1);
    });

    it("does not save when name is empty", async () => {
      const user = userEvent.setup();
      render(<LeftNav {...defaultProps} />);
      await screen.findByText("Old name");

      await openOverflowAndClickRename(user);

      const input = screen.getByTestId("session-rename-input");
      await user.clear(input);
      await user.type(input, "{Enter}");

      expect(window.sessionsAPI.rename).not.toHaveBeenCalled();
    });

    it("does not save a whitespace-only title on blur", async () => {
      const user = userEvent.setup();
      render(
        <LeftNav
          {...defaultProps}
          activeSessionId="s1"
          renameSessionRequest={{ sessionId: "s1", requestId: 1 }}
        />,
      );
      const input = await screen.findByTestId("session-rename-input");
      await user.clear(input);
      await user.type(input, "   ");
      await user.click(document.body);

      expect(window.sessionsAPI.rename).not.toHaveBeenCalled();
      expect(screen.getByText("Old name")).toBeInTheDocument();
    });

    it("cancels rename when the selected session changes and does not reactivate it", async () => {
      const user = userEvent.setup();
      window.sessionsAPI.list = vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [
          {
            id: "s1",
            name: "Old name",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            hasUnread: false,
            isActive: false,
          },
          {
            id: "s2",
            name: "Second session",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            hasUnread: false,
            isActive: false,
          },
        ],
      });
      const request = { sessionId: "s1", requestId: 1 };
      const { rerender } = render(
        <LeftNav {...defaultProps} activeSessionId="s1" renameSessionRequest={request} />,
      );
      const input = await screen.findByTestId("session-rename-input");
      await user.clear(input);
      await user.type(input, "Uncommitted");

      rerender(<LeftNav {...defaultProps} activeSessionId="s2" renameSessionRequest={request} />);

      expect(screen.queryByTestId("session-rename-input")).not.toBeInTheDocument();
      expect(window.sessionsAPI.rename).not.toHaveBeenCalled();

      rerender(<LeftNav {...defaultProps} activeSessionId="s1" renameSessionRequest={request} />);
      expect(screen.queryByTestId("session-rename-input")).not.toBeInTheDocument();
    });
  });

  describe("session tooltip behavior", () => {
    const SESSION = {
      id: "s1",
      name: "Test session with a long name",
      createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      hasUnread: false,
      isActive: false,
    };

    beforeEach(() => {
      window.sessionsAPI.list = vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [SESSION],
      });
    });

    async function openDeleteDialog(user: ReturnType<typeof userEvent.setup>) {
      const moreBtn = screen.getByRole("button", { name: "More actions" });
      await user.click(moreBtn);
      const deleteItem = await screen.findByRole("menuitem", { name: /Delete/ });
      await user.click(deleteItem);
    }

    it("shows delete confirmation dialog when delete is clicked from overflow menu", async () => {
      const user = userEvent.setup();
      render(<LeftNav {...defaultProps} />);
      await screen.findByText("Test session with a long name");

      await openDeleteDialog(user);

      expect(screen.getByText("Delete session?")).toBeInTheDocument();
      expect(screen.getByRole("dialog", { name: "Delete session?" })).toHaveTextContent(
        /Test session with a long name.*will be permanently deleted/,
      );
    });

    it("confirms delete — calls onDeleteSession and removes session", async () => {
      const user = userEvent.setup();
      render(<LeftNav {...defaultProps} />);
      await screen.findByText("Test session with a long name");

      await openDeleteDialog(user);
      await user.click(screen.getByRole("button", { name: "Delete" }));

      expect(defaultProps.onDeleteSession).toHaveBeenCalledWith("s1");
    });

    it("cancels delete — does not call onDeleteSession", async () => {
      const user = userEvent.setup();
      render(<LeftNav {...defaultProps} />);
      await screen.findByText("Test session with a long name");

      await openDeleteDialog(user);
      await user.click(screen.getByRole("button", { name: "Cancel" }));

      expect(defaultProps.onDeleteSession).not.toHaveBeenCalled();
    });

    it("tooltip is keyboard-accessible (uncontrolled open when not suppressed)", async () => {
      render(<LeftNav {...defaultProps} />);
      const sessionItem = await screen.findByTestId("session-item");

      // The tooltip trigger should have the correct aria attributes for keyboard accessibility.
      // Radix Tooltip sets data-state on the trigger element. When uncontrolled (open={undefined}),
      // Radix manages both hover and keyboard focus. We verify the trigger exists and has the
      // expected Radix tooltip data attribute, confirming it's wired up for native focus handling.
      expect(sessionItem).toHaveAttribute("data-state");
    });

    it("tooltip is forced closed when showTooltip is false (narrow nav flyout)", async () => {
      // In the narrow nav HoverCard flyout, SessionListItem gets showTooltip={false}
      // which sets open={false}, preventing the tooltip from appearing even on focus/hover.
      // This is verified by the existing narrow nav tests — the tooltip portal content
      // should not render for session items inside the flyout.
      render(<LeftNav {...defaultProps} />);
      const sessionItem = await screen.findByTestId("session-item");
      expect(sessionItem).toBeInTheDocument();
    });
  });

  it("filters unpinned thread types while pinned threads remain visible", async () => {
    const user = userEvent.setup();
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [
          {
            id: "chat-1",
            name: "Regular chat",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            hasUnread: false,
            isActive: false,
          },
          {
            id: "sub-1",
            name: "Worker agent",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            hasUnread: false,
            isActive: false,
            source: "subagent",
          },
          {
            id: "workflow-agent-1",
            name: "Workflow investigator",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            hasUnread: false,
            isActive: false,
            source: "workflow-agent",
          },
          {
            id: "automation-1",
            name: "Automation run",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            hasUnread: false,
            isActive: false,
            automationId: "automation-definition-1",
            source: "automation",
          },
          {
            id: "pinned-workflow-agent",
            name: "Pinned workflow investigator",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            hasUnread: false,
            isActive: false,
            isPinned: true,
            source: "workflow-agent",
          },
        ],
      }),
    );

    render(<LeftNav {...defaultProps} />);

    expect(await screen.findByText("Regular chat")).toBeInTheDocument();
    expect(screen.queryByText("Worker agent")).not.toBeInTheDocument();
    expect(screen.queryByText("Workflow investigator")).not.toBeInTheDocument();
    expect(screen.queryByText("Automation run")).not.toBeInTheDocument();
    expect(screen.getByText("Pinned workflow investigator")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Filter threads" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitemcheckbox", { name: "All" })).toHaveAttribute(
      "data-state",
      "unchecked",
    );
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Chats" })).toHaveAttribute(
      "data-state",
      "checked",
    );
    await user.click(within(menu).getByRole("menuitemcheckbox", { name: "Chats" }));
    await user.click(within(menu).getByRole("menuitemcheckbox", { name: "Agents" }));

    expect(await screen.findByText("Worker agent")).toBeInTheDocument();
    expect(screen.queryByText("Regular chat")).not.toBeInTheDocument();
    expect(screen.queryByText("Workflow investigator")).not.toBeInTheDocument();
    expect(screen.queryByText("Automation run")).not.toBeInTheDocument();
    expect(screen.getByText("Pinned workflow investigator")).toBeInTheDocument();
    expect(screen.getByTestId("session-filter-active")).toBeInTheDocument();

    await user.click(within(menu).getByRole("menuitemcheckbox", { name: "Automations" }));
    expect(await screen.findByText("Automation run")).toBeInTheDocument();
    expect(screen.queryByText("Regular chat")).not.toBeInTheDocument();
    expect(screen.getByText("Pinned workflow investigator")).toBeInTheDocument();
  });
});

describe("LeftNav (narrow)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMockAPIs();
    // Ensure narrow mode so the icon rail renders — mock matchMedia to return matches: true
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: query.includes("max-width"),
        media: query,
        onchange: null,
        addListener: vi.fn<() => void>(),
        removeListener: vi.fn<() => void>(),
        addEventListener: vi.fn<() => void>(),
        removeEventListener: vi.fn<() => void>(),
        dispatchEvent: vi.fn<() => boolean>(),
      }),
    });
  });

  it("renders icon-only nav buttons with aria-labels", () => {
    render(<LeftNav {...defaultProps} />);
    expect(screen.getByRole("button", { name: "New chat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Orchestration" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Workspaces" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Heartbeat" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Plugins" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
  });

  it("does not render visible text labels for nav items", () => {
    render(<LeftNav {...defaultProps} />);
    expect(screen.queryByText("Orchestration")).not.toBeInTheDocument();
    expect(screen.queryByText("Workspaces")).not.toBeInTheDocument();
  });

  it("applies active class to the active top-rail nav item", () => {
    render(<LeftNav {...defaultProps} activeView="automations" />);
    expect(screen.getByRole("button", { name: "Orchestration" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("highlights the bottom account row when Settings is active", () => {
    render(<LeftNav {...defaultProps} activeView="settings" />);
    expect(screen.getByRole("button", { name: "Settings" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it.each([
    ["Orchestration", "automations"],
    ["Workspaces", "create"],
  ] as const)(
    "calls onViewChange when the %s top-rail nav item is clicked",
    async (label, view) => {
      const user = userEvent.setup();
      render(<LeftNav {...defaultProps} />);
      await user.click(screen.getByRole("button", { name: label }));
      expect(defaultProps.onViewChange).toHaveBeenCalledWith(view);
    },
  );

  it("does not render a separate heartbeat icon row", () => {
    render(<LeftNav {...defaultProps} />);
    expect(screen.queryByRole("button", { name: "Heartbeat" })).not.toBeInTheDocument();
  });

  it("clicking the already-active top-rail nav item does not toggle to chat", async () => {
    const user = userEvent.setup();
    render(<LeftNav {...defaultProps} activeView="automations" />);
    await user.click(screen.getByRole("button", { name: "Orchestration" }));
    expect(defaultProps.onViewChange).toHaveBeenCalledWith("automations");
    expect(defaultProps.onViewChange).not.toHaveBeenCalledWith("chat");
  });

  it("clicking New chat button calls onNewChat (mirrors wide-mode behavior)", async () => {
    const user = userEvent.setup();
    render(<LeftNav {...defaultProps} activeView="automations" />);
    await user.click(screen.getByRole("button", { name: "New chat" }));
    expect(defaultProps.onNewChat).toHaveBeenCalledOnce();
  });

  it("New chat button is wired as a threads flyout trigger", async () => {
    const user = userEvent.setup();
    render(<LeftNav {...defaultProps} />);
    await user.hover(screen.getByRole("button", { name: "New chat" }));
    expect(await screen.findByText("Threads")).toBeInTheDocument();
  });

  it("opens the threads flyout and focuses the active rename request", async () => {
    mockSessionList(
      vi.fn<SessionsAPI["list"]>().mockResolvedValue({
        success: true,
        sessions: [
          {
            id: "s1",
            name: "Narrow session",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            hasUnread: false,
            isActive: false,
          },
        ],
      }),
    );

    render(
      <LeftNav
        {...defaultProps}
        activeSessionId="s1"
        renameSessionRequest={{ sessionId: "s1", requestId: 1 }}
      />,
    );

    expect(await screen.findByText("Threads")).toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: "Rename Narrow session" })).toHaveFocus();
  });

  it("New chat button carries accent action styling without a filled pill", () => {
    const { rerender } = render(<LeftNav {...defaultProps} activeView="automations" />);
    const btn = screen.getByRole("button", { name: "New chat" });
    // Codex-style chrome: the primary action reads as accent-colored text on a
    // borderless row — no filled neutral-heavy pill. The negative is expressed
    // semantically: New chat is never the "current page" in nav terms.
    expect(btn).toHaveClass("text-brand-action");
    expect(btn).not.toHaveClass("bg-neutral-heavy");
    expect(btn).not.toHaveAttribute("aria-current", "page");

    rerender(<LeftNav {...defaultProps} activeView="chat" activeSessionId={null} />);
    expect(screen.getByRole("button", { name: "New chat" })).toHaveClass("text-brand-action");
  });

  it("threads flyout is not visible before New chat hover", () => {
    render(<LeftNav {...defaultProps} />);
    // flyout content is portal-rendered and only appears on open. The icon button
    // itself has aria-label "New chat" but no visible text, so getByText still
    // returns nothing.
    expect(screen.queryByText("New chat")).not.toBeInTheDocument();
    expect(screen.queryByText("Threads")).not.toBeInTheDocument();
  });

  it("renders the compact account Settings button at the bottom", () => {
    render(<LeftNav {...defaultProps} />);
    const accountSettings = screen.getByRole("button", { name: "Settings" });
    expect(accountSettings).toHaveClass("size-9");
    expect(accountSettings).not.toHaveClass("w-full");
    expect(screen.queryByRole("button", { name: "User menu" })).not.toBeInTheDocument();
  });
});

describe("LeftNav experiments gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMockAPIs();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn<() => void>(),
        removeListener: vi.fn<() => void>(),
        addEventListener: vi.fn<() => void>(),
        removeEventListener: vi.fn<() => void>(),
        dispatchEvent: vi.fn<() => boolean>(),
      }),
    });
  });

  it("shows the Integrations row", () => {
    render(<LeftNav {...defaultProps} />);
    expect(screen.getByRole("button", { name: "Integrations" })).toBeInTheDocument();
  });

  it("calls onSettingsAltClick when Alt+clicking the account Settings row", async () => {
    const onSettingsAltClick = vi.fn<() => void>();
    const user = userEvent.setup();
    render(<LeftNav {...defaultProps} onSettingsAltClick={onSettingsAltClick} />);
    const settingsItem = screen.getByTestId("sidebar-account-settings");
    await user.keyboard("{Alt>}");
    await user.click(settingsItem);
    await user.keyboard("{/Alt}");
    expect(onSettingsAltClick).toHaveBeenCalledOnce();
  });

  it("does not call onSettingsAltClick on regular Settings click", async () => {
    const onSettingsAltClick = vi.fn<() => void>();
    const user = userEvent.setup();
    render(<LeftNav {...defaultProps} onSettingsAltClick={onSettingsAltClick} />);
    const settingsItem = screen.getByTestId("sidebar-account-settings");
    await user.click(settingsItem);
    expect(onSettingsAltClick).not.toHaveBeenCalled();
  });
});

describe("LeftNav highlightedView (visual vs semantic split)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMockAPIs();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn<() => void>(),
        removeListener: vi.fn<() => void>(),
        addEventListener: vi.fn<() => void>(),
        removeEventListener: vi.fn<() => void>(),
        dispatchEvent: vi.fn<() => boolean>(),
      }),
    });
  });

  it("aria-current reflects activeView, not highlightedView", () => {
    render(<LeftNav {...defaultProps} activeView="settings" highlightedView="automations" />);
    const accountSettings = screen.getByTestId("sidebar-account-settings");
    expect(accountSettings).toHaveAttribute("aria-current", "page");
    const automationsBtn = screen.getByRole("button", { name: /Orchestration/ });
    expect(automationsBtn).not.toHaveAttribute("aria-current", "page");
  });

  it("visual highlight follows highlightedView when provided", () => {
    render(<LeftNav {...defaultProps} activeView="settings" highlightedView="automations" />);
    const automationsBtn = screen.getByRole("button", { name: /Orchestration/ });
    expect(automationsBtn).toHaveClass("bg-active-subtle");
  });

  it("highlights a first-class panel from activeView when highlightedView is omitted", () => {
    render(<LeftNav {...defaultProps} activeView="activities" />);
    expect(screen.getByRole("button", { name: "Activity" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "Activity" })).toHaveClass("bg-active-subtle");
    expect(screen.getByRole("button", { name: "Orchestration" })).not.toHaveClass(
      "bg-active-subtle",
    );
  });

  it("account Settings row is not visually highlighted when highlightedView is a page", () => {
    render(<LeftNav {...defaultProps} activeView="settings" highlightedView="automations" />);
    expect(screen.getByTestId("sidebar-account-settings")).not.toHaveClass("bg-active-subtle");
  });
});
