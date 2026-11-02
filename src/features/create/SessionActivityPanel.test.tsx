import type { RuntimeUiEvent } from "@common/runtime-ui";
import { DEFAULT_WORKSPACE_DISPLAY_NAME } from "@common/workspace-display";
import { SWARM_RUN_VIEW_RENDER_ID } from "@marshal/swarm/presentation";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, afterEach } from "vitest";

import type { RuntimeUiModel } from "@/features/runtime-ui/useRuntimeUi";
import { act, render, screen, waitFor } from "@/test-utils";
import type {
  CommandCenterAPI,
  CommandCenterSessionActivityDetails,
  CommandCenterSnapshot,
  SessionMetadata,
} from "@/types/electron";

import { SessionActivityPanel } from "./SessionActivityPanel";

const runtimePanelTest = vi.hoisted(() => ({
  model: null as import("@/features/runtime-ui/useRuntimeUi").RuntimeUiModel | null,
}));
vi.mock("@/features/runtime-ui/runtimeUiContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/runtime-ui/runtimeUiContext")>()),
  useOptionalRuntimeUiModel: () => runtimePanelTest.model,
}));
afterEach(() => {
  runtimePanelTest.model = null;
});

vi.mock("./filepreview/MonacoEditor", () => ({
  MonacoEditor: ({ value, testId }: { value: string; testId: string }) => (
    <pre data-testid={testId}>{value}</pre>
  ),
}));

vi.mock("@/features/chat/components/ChatPanel", () => ({
  ChatPanel: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="mock-chat-panel">Chat {sessionId}</div>
  ),
}));

const snapshot: CommandCenterSnapshot = {
  replay: { status: "ok", lastDurableSeq: 1, skippedEvents: 0 },
  sessions: [],
  relationships: [],
  tools: [],
  files: [],
  artifacts: [],
  todos: [
    {
      id: "todo-1",
      title: "Implement tracker",
      status: "done",
      sessionId: "safe-root",
      updatedAt: 1,
    },
    {
      id: "todo-2",
      title: "Wire panel",
      status: "pending",
      sessionId: "safe-child",
      updatedAt: 2,
    },
    {
      id: "todo-3",
      title: "Raw session todo",
      status: "done",
      sessionId: "child",
      updatedAt: 3,
    },
  ],
  runs: [],
  blockers: [],
};

const activity: CommandCenterSessionActivityDetails = {
  rootSessionId: "root",
  sessionIds: ["root", "child"],
  safeSessionIds: ["safe-root", "safe-child"],
  fileChanges: [
    {
      id: "file-1",
      sessionId: "child",
      path: "src/app.ts",
      label: "app.ts",
      toolName: "apply_patch",
      additions: 2,
      deletions: 1,
      diff: "+new\n-old",
      updatedAt: 2,
    },
  ],
  sources: [
    {
      id: "source-1",
      sessionId: "root",
      kind: "other",
      label: "Docs search",
      toolName: "search_docs",
      query: "release notes 2026",
      url: "https://docs.example.com/search?q=release%20notes%202026",
      updatedAt: 1,
    },
    {
      id: "source-pr-1",
      sessionId: "root",
      kind: "pr",
      label: "Pull request 8472",
      toolName: "get_pull_request",
      url: "https://git.example.com/org/repo/pullrequest/8472",
      updatedAt: 5,
    },
  ],
};

interface ReviewPayloadThreadForTest {
  threadId: string;
  commentId: string;
  file: { path: string; name: string };
  anchor: {
    side: string;
    oldLine?: number;
    newLine?: number;
    hunkHeader?: string;
    lineText: string;
  };
  hunkContext: Array<{
    kind: string;
    side: string;
    oldLine?: number;
    newLine?: number;
    prefix: string;
    content: string;
    hunkHeader?: string;
    contentTruncated?: boolean;
    hunkHeaderTruncated?: boolean;
  }>;
  hunkContextTruncated?: boolean;
  hunkContextReason?: string;
  status: string;
  comment: string;
  replies: Array<{ replyId: string; text: string }>;
}

interface ReviewPayloadForTest {
  schemaVersion: number;
  kind: string;
  requestedActions: string[];
  threads: ReviewPayloadThreadForTest[];
}

interface ReviewResponseSchemaForTest {
  schemaVersion: number;
  actions: Array<{
    threadId: string;
    commentId: string;
    action: string;
    message: string;
    status: string;
  }>;
}

function jsonBlockAfter(message: string, label: string): unknown {
  const sectionStart = message.indexOf(label);
  if (sectionStart < 0) throw new Error(`Missing JSON label: ${label}`);
  const match = message.slice(sectionStart).match(/~~~json\n([\s\S]*?)\n~~~/);
  if (!match) throw new Error(`Missing JSON block after: ${label}`);
  return JSON.parse(match[1].replace(/^marshal-actions\s+/, "")) as unknown;
}

function assertReviewPayload(value: unknown): asserts value is ReviewPayloadForTest {
  if (!value || typeof value !== "object") throw new Error("Payload is not an object");
  const payload = value as Partial<ReviewPayloadForTest>;
  if (
    payload.schemaVersion !== 1 ||
    payload.kind !== "workspace_file_review_comments" ||
    !Array.isArray(payload.requestedActions) ||
    !Array.isArray(payload.threads)
  ) {
    throw new Error("Payload does not match review payload shape");
  }
}

function assertReviewResponseSchema(value: unknown): asserts value is ReviewResponseSchemaForTest {
  if (!value || typeof value !== "object") throw new Error("Response schema is not an object");
  const schema = value as Partial<ReviewResponseSchemaForTest>;
  if (schema.schemaVersion !== 1 || !Array.isArray(schema.actions)) {
    throw new Error("Response schema does not match expected shape");
  }
}

function defaultSessions(): SessionMetadata[] {
  return [
    {
      id: "root",
      name: "Root",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      workspaceName: "Scratchpad",
    },
    {
      id: "child",
      name: "Subagent: worker",
      createdAt: "",
      updatedAt: "",
      hasUnread: false,
      isActive: true,
      isBusy: true,
      source: "subagent",
      parentSessionId: "root",
      workspaceName: "Scratchpad",
    },
  ];
}

function installApis({ sessions = defaultSessions() }: { sessions?: SessionMetadata[] } = {}) {
  let currentSessions = sessions;
  let listChangedListener: (() => void) | undefined;
  const commandCenterAPI: CommandCenterAPI = {
    getSnapshot: vi.fn<CommandCenterAPI["getSnapshot"]>().mockResolvedValue({
      success: true,
      snapshot,
    }),
    refresh: vi.fn<CommandCenterAPI["refresh"]>().mockResolvedValue({ success: true, snapshot }),
    upsertTodo: vi.fn<CommandCenterAPI["upsertTodo"]>().mockResolvedValue({
      success: true,
      snapshot,
    }),
    deleteTodo: vi.fn<CommandCenterAPI["deleteTodo"]>().mockResolvedValue({
      success: true,
      snapshot,
    }),
    openSession: vi.fn<CommandCenterAPI["openSession"]>().mockResolvedValue({ success: true }),
    getSessionActivity: vi
      .fn<CommandCenterAPI["getSessionActivity"]>()
      .mockImplementation(async () => ({
        success: true,
        activity,
        sessions: currentSessions,
      })),
    onSnapshot: vi.fn<CommandCenterAPI["onSnapshot"]>().mockReturnValue(() => {}),
  };
  Object.defineProperty(window, "commandCenterAPI", {
    configurable: true,
    value: commandCenterAPI,
  });
  Object.defineProperty(window, "sessionsAPI", {
    configurable: true,
    value: {
      onListChanged: vi
        .fn<NonNullable<typeof window.sessionsAPI>["onListChanged"]>()
        .mockImplementation((listener) => {
          listChangedListener = listener;
          return () => {
            listChangedListener = undefined;
          };
        }),
      messageSubagent: vi
        .fn<NonNullable<typeof window.sessionsAPI>["messageSubagent"]>()
        .mockResolvedValue({ success: true, status: "sent" }),
      sendReviewComments: vi
        .fn<NonNullable<typeof window.sessionsAPI>["sendReviewComments"]>()
        .mockResolvedValue({ success: true, status: "sent" }),
    },
  });
  Object.defineProperty(window, "workspaceAPI", {
    configurable: true,
    value: {
      readFile: vi.fn<NonNullable<typeof window.workspaceAPI>["readFile"]>().mockResolvedValue({
        success: true,
        type: "text",
        content: "fallback line\nsecond line\n",
      }),
    },
  });
  return {
    commandCenterAPI,
    updateSessions(nextSessions: SessionMetadata[]) {
      currentSessions = nextSessions;
      listChangedListener?.();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, "commandCenterAPI", { configurable: true, value: undefined });
  Object.defineProperty(window, "sessionsAPI", { configurable: true, value: undefined });
  Object.defineProperty(window, "workspaceAPI", { configurable: true, value: undefined });
  Object.defineProperty(window, "workflowsAPI", { configurable: true, value: undefined });
  Object.defineProperty(window, "runtimeUiAPI", { configurable: true, value: undefined });
  window.localStorage.removeItem("marshal.panel.session-activity.progress-width");
  window.localStorage.removeItem("marshal.panel.session-activity.detail-width");
  window.localStorage.removeItem("marshal.panel.session-activity.progress-width");
  window.localStorage.removeItem("marshal.panel.session-activity.detail-width");
});

describe("SessionActivityPanel", () => {
  it("opens runtime content inside the existing evidence panel and isolates sessions", async () => {
    installApis();
    const instance: import("@common/runtime-ui").RuntimeUiInstance = {
      instanceId: "document-1",
      owner: {
        sessionId: "root",
        workspaceName: "workspace",
        extensionId: "marshal.documents",
        applicationId: "proposal",
      },
      surface: "panel",
      content: { kind: "text", text: "Proposal document content" },
      idempotencyKey: "open-doc",
      revision: 1,
      openedAt: "2026-09-06",
      updatedAt: "2026-09-06",
      focusedAt: "2026-09-06",
    };
    runtimePanelTest.model = {
      scope: { sessionId: "root", workspaceName: "workspace" },
      status: "ready",
      instances: [instance],
      bySurface: {
        panel: [instance],
        tab: [],
        fullscreen: [],
        "inline-card": [],
        "bottom-panel": [],
        floating: [],
      },
      error: null,
      pending: new Map(),
      focus: vi.fn<RuntimeUiModel["focus"]>(),
      close: vi.fn<RuntimeUiModel["close"]>(),
      update: vi.fn<RuntimeUiModel["update"]>(),
      resync: vi.fn<RuntimeUiModel["resync"]>(),
      dismissError: vi.fn<RuntimeUiModel["dismissError"]>(),
    };
    const view = render(<SessionActivityPanel sessionId="root" />);
    expect(await screen.findByTestId("session-activity-evidence-detail")).toHaveTextContent(
      "Proposal document content",
    );
    expect(screen.queryByTestId("runtime-ui-panel")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Back to progress" }));
    await userEvent.setup().click(screen.getByRole("button", { name: "proposal" }));
    expect(screen.getByTestId("session-activity-evidence-detail")).toHaveTextContent(
      "Proposal document content",
    );
    view.rerender(<SessionActivityPanel sessionId="other" />);
    expect(screen.queryByText("Proposal document content")).not.toBeInTheDocument();
  });

  it("keeps a late previous-session response from erasing restored activity", async () => {
    const { commandCenterAPI } = installApis();
    let finishPrevious!: (
      result: Awaited<ReturnType<CommandCenterAPI["getSessionActivity"]>>,
    ) => void;
    vi.mocked(commandCenterAPI.getSessionActivity).mockImplementation((id) =>
      id === "previous"
        ? new Promise((resolve) => {
            finishPrevious = resolve;
          })
        : Promise.resolve({ success: true, activity, sessions: defaultSessions() }),
    );
    const view = render(<SessionActivityPanel sessionId="previous" />);
    await waitFor(() => expect(finishPrevious).toBeDefined());
    view.rerender(<SessionActivityPanel sessionId="root" />);
    expect(await screen.findByText("Docs search")).toBeInTheDocument();

    await act(async () =>
      finishPrevious({
        success: true,
        activity: {
          rootSessionId: "previous",
          sessionIds: ["previous"],
          safeSessionIds: ["safe-previous"],
          fileChanges: [],
          sources: [],
        },
        sessions: [],
      }),
    );

    expect(screen.getByText("Docs search")).toBeInTheDocument();
    expect(screen.getByText("Subagent: worker")).toBeInTheDocument();
    expect(screen.getByText("Implement tracker")).toBeInTheDocument();
  });

  it("shows failed activity loading and restores data on retry", async () => {
    const { commandCenterAPI } = installApis();
    vi.mocked(commandCenterAPI.getSessionActivity).mockRejectedValueOnce(
      new Error("Activity unavailable"),
    );
    render(<SessionActivityPanel sessionId="root" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Activity unavailable");
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry session activity" }));
    expect(await screen.findByText("Docs search")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders scoped todos, changed files, workspaces, subagents, and sources", async () => {
    installApis();

    render(<SessionActivityPanel sessionId="root" />);

    expect(await screen.findByText("Progress")).toBeInTheDocument();
    expect(screen.getByText("1/1")).toBeInTheDocument();
    expect(screen.getByText("Implement tracker")).toBeInTheDocument();
    expect(screen.queryByText("Wire panel")).not.toBeInTheDocument();
    expect(screen.queryByText("Raw session todo")).not.toBeInTheDocument();
    expect(screen.getByTestId("session-activity-workspace-change")).toHaveTextContent(
      DEFAULT_WORKSPACE_DISPLAY_NAME,
    );
    expect(screen.getByTestId("session-activity-workspace-change")).toHaveTextContent("+2");
    expect(screen.getByTestId("session-activity-workspace-change")).toHaveTextContent("-1");
    expect(screen.queryByText("src/app.ts")).not.toBeInTheDocument();
    expect(screen.getByText("Subagent: worker")).toBeInTheDocument();
    expect(screen.getByText("Docs search")).toBeInTheDocument();
  });

  it("separates running, idle, and completed agents and keeps the collapsed running count live", async () => {
    const root = defaultSessions()[0];
    const running: SessionMetadata = {
      ...defaultSessions()[1],
      id: "running",
      name: "Running agent",
      isActive: true,
      isBusy: true,
    };
    const idle: SessionMetadata = {
      ...running,
      id: "idle",
      name: "Idle agent",
      isBusy: false,
    };
    const completed: SessionMetadata = {
      ...running,
      id: "completed",
      name: "Completed agent",
      isActive: false,
      isBusy: false,
    };
    const { updateSessions } = installApis({ sessions: [root, running, idle, completed] });
    const user = userEvent.setup();

    render(<SessionActivityPanel sessionId="root" />);

    expect(await screen.findByText("Running agent")).toBeInTheDocument();
    expect(screen.getByText("Idle agent")).toBeInTheDocument();
    expect(screen.queryByText("Completed agent")).not.toBeInTheDocument();
    expect(screen.getByTestId("session-activity-section-agents")).toBeInTheDocument();
    expect(screen.getByTestId("session-activity-section-idle-agents")).toBeInTheDocument();
    expect(screen.getByTestId("session-activity-section-completed-agents")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^agents/i }));
    const collapsedRunningLabel = screen.getByTestId(
      "session-activity-section-agents-collapsed-label",
    );
    expect(collapsedRunningLabel).toHaveTextContent("1 running");
    expect(collapsedRunningLabel).toHaveClass("text-muted-foreground");
    expect(collapsedRunningLabel).toHaveAttribute("aria-live", "polite");

    const secondRunning: SessionMetadata = {
      ...running,
      id: "running-2",
      name: "Second running agent",
    };
    updateSessions([root, running, secondRunning, idle, completed]);
    // List-changed refreshes are throttled to one per second.
    await waitFor(
      () =>
        expect(
          screen.getByTestId("session-activity-section-agents-collapsed-label"),
        ).toHaveTextContent("2 running"),
      { timeout: 3_000 },
    );

    await user.click(screen.getByRole("button", { name: "Completed" }));
    expect(await screen.findByText("Completed agent")).toBeInTheDocument();
  });

  it("collapses progress sections", async () => {
    installApis();
    const user = userEvent.setup();

    render(<SessionActivityPanel sessionId="root" />);

    expect(await screen.findByText("Implement tracker")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /todo list/i }));

    expect(screen.queryByText("Implement tracker")).not.toBeInTheDocument();
  });

  it("renders the progress rail inside a scrollable viewport", async () => {
    installApis();

    render(<SessionActivityPanel sessionId="root" />);

    const scroll = await screen.findByTestId("session-activity-scroll");
    expect(scroll.className).toContain("min-h-0");
    expect(scroll.className).toContain("flex-1");
    expect(screen.getByTestId("session-activity-progress").className).toContain("inset-y-4");
  });

  it("resizes with keyboard controls, persists the split, and expands, restores, and folds", async () => {
    installApis();
    const user = userEvent.setup();

    const view = render(<SessionActivityPanel sessionId="root" availableWidth={1000} />);
    const progress = await screen.findByTestId("session-activity-progress");
    const handle = screen.getByTestId("session-activity-panel-resize");
    expect(progress).toHaveStyle({ width: "360px" });
    expect(handle).toHaveAttribute("role", "separator");
    expect(handle).toHaveAttribute("aria-valuemin", "280");
    expect(handle).toHaveAttribute("aria-valuemax", "720");

    await user.tab();
    expect(handle).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(progress).toHaveStyle({ width: "376px" });
    expect(window.localStorage.getItem("marshal.panel.session-activity.progress-width")).toBe(
      "376",
    );

    await user.click(screen.getByTestId("session-activity-panel-expand"));
    expect(progress).toHaveStyle({ width: "968px" });
    expect(screen.getByTestId("session-activity-panel")).toHaveAttribute(
      "data-panel-mode",
      "expanded",
    );

    await user.click(screen.getByTestId("session-activity-panel-restore"));
    expect(progress).toHaveStyle({ width: "376px" });

    await user.click(screen.getByTestId("session-activity-panel-collapse"));
    expect(screen.queryByTestId("session-activity-progress")).not.toBeInTheDocument();
    expect(screen.getByTestId("session-activity-panel-show")).toBeInTheDocument();

    await user.click(screen.getByTestId("session-activity-panel-show"));
    expect(await screen.findByTestId("session-activity-progress")).toHaveStyle({ width: "376px" });

    view.unmount();
    render(<SessionActivityPanel sessionId="root" availableWidth={1000} />);
    expect(await screen.findByTestId("session-activity-progress")).toHaveStyle({ width: "376px" });
  });

  it("groups todos by goal, defaults to the latest goal, and navigates history", async () => {
    const multiGoalSnapshot: CommandCenterSnapshot = {
      replay: { status: "ok", lastDurableSeq: 5, skippedEvents: 0 },
      sessions: [],
      relationships: [],
      tools: [],
      files: [],
      artifacts: [],
      todos: [
        {
          id: "todo-old-1",
          title: "1. wrap up first goal",
          status: "done",
          sessionId: "safe-root",
          goalId: "goal-old",
          goalLabel: "First user request",
          updatedAt: 10,
        },
        {
          id: "todo-old-2",
          title: "2. ship first goal",
          status: "done",
          sessionId: "safe-root",
          goalId: "goal-old",
          goalLabel: "First user request",
          updatedAt: 11,
        },
        {
          id: "todo-new-1",
          title: "1. start second goal",
          status: "in_progress",
          sessionId: "safe-root",
          goalId: "goal-new",
          goalLabel: "Second user request",
          updatedAt: 100,
        },
      ],
      runs: [],
      blockers: [],
    };
    const commandCenterAPI: CommandCenterAPI = {
      getSnapshot: vi
        .fn<CommandCenterAPI["getSnapshot"]>()
        .mockResolvedValue({ success: true, snapshot: multiGoalSnapshot }),
      refresh: vi
        .fn<CommandCenterAPI["refresh"]>()
        .mockResolvedValue({ success: true, snapshot: multiGoalSnapshot }),
      upsertTodo: vi
        .fn<CommandCenterAPI["upsertTodo"]>()
        .mockResolvedValue({ success: true, snapshot: multiGoalSnapshot }),
      deleteTodo: vi
        .fn<CommandCenterAPI["deleteTodo"]>()
        .mockResolvedValue({ success: true, snapshot: multiGoalSnapshot }),
      openSession: vi.fn<CommandCenterAPI["openSession"]>().mockResolvedValue({ success: true }),
      getSessionActivity: vi.fn<CommandCenterAPI["getSessionActivity"]>().mockResolvedValue({
        success: true,
        activity: {
          rootSessionId: "root",
          sessionIds: ["root"],
          safeSessionIds: ["safe-root"],
          fileChanges: [],
          sources: [],
        },
      }),
      onSnapshot: vi.fn<CommandCenterAPI["onSnapshot"]>().mockReturnValue(() => {}),
    };
    Object.defineProperty(window, "commandCenterAPI", {
      configurable: true,
      value: commandCenterAPI,
    });
    Object.defineProperty(window, "sessionsAPI", {
      configurable: true,
      value: {
        listWithOptions: vi
          .fn<NonNullable<typeof window.sessionsAPI>["listWithOptions"]>()
          .mockResolvedValue({ success: true, sessions: [] }),
        onListChanged: vi
          .fn<NonNullable<typeof window.sessionsAPI>["onListChanged"]>()
          .mockReturnValue(() => {}),
      },
    });

    const user = userEvent.setup();
    render(<SessionActivityPanel sessionId="root" />);

    // Default = latest goal.
    expect(await screen.findByText("1. start second goal")).toBeInTheDocument();
    expect(screen.queryByText("1. wrap up first goal")).not.toBeInTheDocument();
    expect(screen.getByTestId("session-activity-goal-history")).toHaveTextContent("Goal 2 of 2");

    // Back to previous goal.
    await user.click(screen.getByTestId("session-activity-goal-prev"));
    expect(await screen.findByText("1. wrap up first goal")).toBeInTheDocument();
    expect(screen.queryByText("1. start second goal")).not.toBeInTheDocument();
    expect(screen.getByTestId("session-activity-goal-history")).toHaveTextContent("Goal 1 of 2");

    // Return to latest via the "Latest" affordance.
    await user.click(screen.getByTestId("session-activity-goal-latest"));
    expect(await screen.findByText("1. start second goal")).toBeInTheDocument();
  });

  it("hides goal history controls when there is only one goal", async () => {
    installApis();

    render(<SessionActivityPanel sessionId="root" />);

    await screen.findByText("Implement tracker");
    expect(screen.queryByTestId("session-activity-goal-history")).not.toBeInTheDocument();
  });

  it("opens a resizable workspace drawer with tracked file diffs", async () => {
    installApis();
    const user = userEvent.setup();

    render(<SessionActivityPanel sessionId="root" />);
    await user.click(await screen.findByTestId("session-activity-workspace-change"));

    expect(await screen.findByTestId("session-activity-detail")).toBeInTheDocument();
    expect(screen.getByTestId("session-activity-detail")).toHaveStyle({ width: "860px" });
    expect(await screen.findAllByText("app.ts")).toHaveLength(2);
    expect(screen.queryByText("src/app.ts")).not.toBeInTheDocument();
    expect(screen.getByTestId("session-activity-file-diff")).toHaveTextContent("+ new");
    expect(screen.getByTestId("session-activity-file-diff")).toHaveTextContent("- old");
  });

  it("adds inline diff comments and sends location-rich thread payloads to the owning session", async () => {
    const { commandCenterAPI } = installApis({
      sessions: [
        ...defaultSessions(),
        {
          id: "child-2",
          name: "Subagent: reviewer",
          createdAt: "",
          updatedAt: "",
          hasUnread: false,
          isActive: false,
          source: "subagent",
          parentSessionId: "root",
          workspaceName: "Scratchpad",
        },
      ],
    });
    vi.mocked(commandCenterAPI.getSessionActivity).mockResolvedValue({
      success: true,
      activity: {
        ...activity,
        fileChanges: [
          {
            ...activity.fileChanges[0],
            diff: [
              "diff --git a/src/app.ts b/src/app.ts",
              "--- a/src/app.ts",
              "+++ b/src/app.ts",
              "@@ -10,14 +10,14 @@ function demo()",
              " context before 1",
              " context before 2",
              " context before 3",
              " context before 4",
              "-old nearby",
              "+new nearby",
              " context after 1",
              " context after 2",
              " context after 3",
              " context after 4",
              " context after 5",
              "@@ -90,3 +90,3 @@ distant()",
              " far context",
              "-old distant",
              "+new distant",
            ].join("\n"),
          },
        ],
      },
    });
    const user = userEvent.setup();
    const nowSpy = vi.spyOn(Date, "now");

    try {
      render(<SessionActivityPanel sessionId="root" />);
      await user.click(await screen.findByTestId("session-activity-workspace-change"));
      await user.click(
        await screen.findByRole("button", { name: /add comment on added line 14/i }),
      );
      await user.type(await screen.findByPlaceholderText("Comment"), "Please simplify this line.");
      nowSpy.mockReturnValue(1_700_000_000_000);
      await user.click(screen.getByRole("button", { name: "Add comment" }));
      expect(screen.getByText("Please simplify this line.")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Reply" }));
      await user.type(screen.getByPlaceholderText("Reply"), "I can keep this local.");
      nowSpy.mockReturnValue(1_700_000_000_001);
      await user.click(screen.getByRole("button", { name: "Add reply" }));
      nowSpy.mockReturnValue(1_700_000_000_002);
      await user.click(screen.getByRole("button", { name: "Mark resolved" }));

      expect(screen.queryByTestId("session-activity-target-agent-select")).not.toBeInTheDocument();
      expect(screen.queryByTestId("session-activity-target-agent")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Send review" }));
    } finally {
      nowSpy.mockRestore();
    }

    const sendReviewComments = window.sessionsAPI?.sendReviewComments;
    expect(sendReviewComments).toHaveBeenCalledWith(
      "root",
      expect.stringContaining("Please simplify this line."),
      { deliveryMode: "queue", waitForResponse: true, timeoutMs: 120_000 },
    );
    expect(window.sessionsAPI?.messageSubagent).not.toHaveBeenCalled();
    if (!sendReviewComments) throw new Error("sendReviewComments missing");
    const sentMessage = vi.mocked(sendReviewComments).mock.calls[0]?.[1] ?? "";
    const responseSchema = jsonBlockAfter(sentMessage, "Return a short summary");
    assertReviewResponseSchema(responseSchema);
    expect(responseSchema.actions[0]).toMatchObject({
      threadId: "<threadId from payload>",
      commentId: "<commentId from payload>",
      action: "reply | add_location_comment | mark_resolved | mark_wontfix",
    });

    const payload = jsonBlockAfter(sentMessage, "Comment payload:");
    assertReviewPayload(payload);
    expect(payload).toMatchObject({
      schemaVersion: 1,
      kind: "workspace_file_review_comments",
      requestedActions: ["reply", "add_location_comment", "mark_resolved", "mark_wontfix"],
    });
    expect(payload.threads).toHaveLength(1);
    const thread = payload.threads[0];
    expect(thread.threadId).toMatch(/^file-1:added::14:/);
    expect(thread.commentId).toBe(`${thread.threadId}:comment:1700000000000`);
    expect(thread.file).toEqual({ path: "src/app.ts", name: "app.ts" });
    expect(thread.anchor).toMatchObject({
      side: "added",
      newLine: 14,
      hunkHeader: "@@ -10,14 +10,14 @@ function demo()",
      lineText: "new nearby",
    });
    expect(thread.status).toBe("resolved");
    expect(thread.comment).toBe("Please simplify this line.");
    expect(thread.replies).toEqual([
      {
        replyId: `${thread.commentId}:reply:1700000000001`,
        text: "I can keep this local.",
      },
    ]);
    expect(thread.hunkContext).toHaveLength(9);
    expect(thread.hunkContextTruncated).toBe(true);
    expect(thread.hunkContextReason).toBeUndefined();
    expect(thread.hunkContext.map((line) => line.content)).toEqual([
      "context before 2",
      "context before 3",
      "context before 4",
      "old nearby",
      "new nearby",
      "context after 1",
      "context after 2",
      "context after 3",
      "context after 4",
    ]);
    expect(thread.hunkContext[4]).toMatchObject({
      kind: "added",
      side: "added",
      newLine: 14,
      prefix: "+",
      hunkHeader: "@@ -10,14 +10,14 @@ function demo()",
    });
    expect(JSON.stringify(thread.hunkContext)).not.toContain("old distant");
  });

  it("applies agent review replies and status actions to matching comments", async () => {
    const { commandCenterAPI } = installApis();
    vi.mocked(commandCenterAPI.getSessionActivity).mockResolvedValue({
      success: true,
      activity: {
        ...activity,
        fileChanges: [
          {
            ...activity.fileChanges[0],
            diff: [
              "diff --git a/src/app.ts b/src/app.ts",
              "--- a/src/app.ts",
              "+++ b/src/app.ts",
              "@@ -1,3 +1,3 @@",
              "-old",
              "+new",
            ].join("\n"),
          },
        ],
      },
    });
    const user = userEvent.setup();
    const nowSpy = vi.spyOn(Date, "now");

    try {
      render(<SessionActivityPanel sessionId="root" />);
      await user.click(await screen.findByTestId("session-activity-workspace-change"));
      await user.click(await screen.findByRole("button", { name: /add comment on added line 1/i }));
      await user.type(await screen.findByPlaceholderText("Comment"), "Please handle this.");
      nowSpy.mockReturnValue(1_700_000_100_000);
      await user.click(screen.getByRole("button", { name: "Add comment" }));

      const commentText = await screen.findByText("Please handle this.");
      const sendReviewComments = window.sessionsAPI?.sendReviewComments;
      if (!sendReviewComments) throw new Error("sendReviewComments missing");
      vi.mocked(sendReviewComments).mockImplementationOnce(async (_sessionId, message) => {
        const payload = jsonBlockAfter(message, "Comment payload:");
        assertReviewPayload(payload);
        const thread = payload.threads[0];
        return {
          success: true,
          response: [
            "Done.",
            "~~~json",
            "marshal-actions",
            JSON.stringify({
              schemaVersion: 1,
              actions: [
                {
                  threadId: thread.threadId,
                  commentId: thread.commentId,
                  action: "reply",
                  message: "Agent reply is visible on the comment.",
                  status: "pending",
                },
                {
                  threadId: thread.threadId,
                  commentId: thread.commentId,
                  action: "mark_resolved",
                  status: "resolved",
                },
              ],
            }),
            "~~~",
          ].join("\n"),
        };
      });

      expect(commentText).toBeInTheDocument();
      nowSpy.mockReturnValue(1_700_000_100_001);
      await user.click(screen.getByRole("button", { name: "Send review" }));
      expect(sendReviewComments).toHaveBeenCalledWith(
        "root",
        expect.stringContaining("Please handle this."),
        { deliveryMode: "queue", waitForResponse: true, timeoutMs: 120_000 },
      );
      expect(await screen.findByText("Agent reply is visible on the comment.")).toBeInTheDocument();
      expect(await screen.findByText("resolved")).toBeInTheDocument();
      expect(await screen.findByText(/Applied 2 actions/)).toBeInTheDocument();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("supports editing, deleting, status changes, and replies on inline comments", async () => {
    installApis();
    const user = userEvent.setup();

    render(<SessionActivityPanel sessionId="root" />);
    await user.click(await screen.findByTestId("session-activity-workspace-change"));
    await user.click(await screen.findByRole("button", { name: /add comment on added line 1/i }));
    await user.type(await screen.findByPlaceholderText("Comment"), "Initial comment.");
    await user.click(screen.getByRole("button", { name: "Add comment" }));

    await user.click(screen.getByRole("button", { name: "Edit comment" }));
    await user.clear(screen.getByPlaceholderText("Edit comment"));
    await user.type(screen.getByPlaceholderText("Edit comment"), "Updated comment.");
    await user.click(screen.getByRole("button", { name: "Save comment" }));
    expect(screen.getByText("Updated comment.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reply" }));
    await user.type(screen.getByPlaceholderText("Reply"), "Agent should explain the tradeoff.");
    await user.click(screen.getByRole("button", { name: "Add reply" }));
    expect(screen.getByTestId("session-activity-review-reply")).toHaveTextContent(
      "Agent should explain the tradeoff.",
    );

    await user.click(screen.getByRole("button", { name: "Mark resolved" }));
    expect(screen.getByText("resolved")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reopen comment" }));
    expect(screen.getByText("pending")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mark won't fix" }));
    expect(screen.getByText("Won't fix")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete comment" }));
    expect(screen.queryByText("Updated comment.")).not.toBeInTheDocument();
    expect(screen.queryByTestId("session-activity-review-reply")).not.toBeInTheDocument();
  });

  it("keeps hunk context under the serialized cap when hunk headers are extremely long", async () => {
    const { commandCenterAPI } = installApis();
    const longHunkHeader = `@@ -1,3 +1,3 @@ ${"x".repeat(12_000)}`;
    vi.mocked(commandCenterAPI.getSessionActivity).mockResolvedValue({
      success: true,
      activity: {
        ...activity,
        fileChanges: [
          {
            ...activity.fileChanges[0],
            diff: [
              "diff --git a/src/app.ts b/src/app.ts",
              "--- a/src/app.ts",
              "+++ b/src/app.ts",
              longHunkHeader,
              " context before",
              "-target old",
              "+target new",
              " context after",
            ].join("\n"),
          },
        ],
      },
    });
    const user = userEvent.setup();

    render(<SessionActivityPanel sessionId="root" />);
    await user.click(await screen.findByTestId("session-activity-workspace-change"));
    await user.click(await screen.findByRole("button", { name: /add comment on added line 2/i }));
    await user.type(await screen.findByPlaceholderText("Comment"), "Please check the target line.");
    await user.click(screen.getByRole("button", { name: "Add comment" }));
    await user.click(screen.getByRole("button", { name: "Send review" }));

    const sendReviewComments = window.sessionsAPI?.sendReviewComments;
    if (!sendReviewComments) throw new Error("sendReviewComments missing");
    const sentMessage = vi.mocked(sendReviewComments).mock.calls[0]?.[1] ?? "";
    const payload = jsonBlockAfter(sentMessage, "Comment payload:");
    assertReviewPayload(payload);
    const context = payload.threads[0].hunkContext;

    expect(JSON.stringify(context).length).toBeLessThanOrEqual(6_000);
    expect(payload.threads[0].hunkContextTruncated).toBe(true);
    expect(context).toHaveLength(1);
    expect(context[0]).toMatchObject({
      kind: "added",
      side: "added",
      newLine: 2,
      content: "target new",
      hunkHeaderTruncated: true,
    });
    expect(context[0].hunkHeader).toContain("...[hunk header truncated]");
    expect(context[0].contentTruncated).toBeUndefined();
  });

  it("keeps comments across drawer remounts and avoids fixed-width comment layouts", async () => {
    installApis();
    const user = userEvent.setup();

    render(<SessionActivityPanel sessionId="root" />);
    await user.click(await screen.findByTestId("session-activity-workspace-change"));
    await user.click(await screen.findByRole("button", { name: /add comment on added line 1/i }));
    const composer = await screen.findByTestId("session-activity-comment-composer");
    expect(composer.className).not.toContain("grid-cols-[128px");
    await user.type(screen.getByPlaceholderText("Comment"), "This must wrap in narrow panels.");
    await user.click(screen.getByRole("button", { name: "Add comment" }));

    const card = screen.getByTestId("session-activity-review-comment");
    const layout = screen.getByTestId("session-activity-workspace-layout");
    expect(layout.className).toContain("grid-cols-[minmax(150px,220px)_minmax(0,1fr)]");
    expect(layout).toHaveAttribute("data-layout", "split");
    expect(screen.getByTestId("session-activity-diff-content").className).not.toContain(
      "min-w-[640px]",
    );
    expect(card.className).toContain("max-w-none");
    expect(card.className).toContain("overflow-hidden");
    expect(card.className).toContain("wrap-anywhere");

    const markResolved = screen.getByRole("button", { name: "Mark resolved" });
    expect(markResolved.className).toContain("min-w-0");
    expect(markResolved.className).not.toContain("basis-full");
    expect(markResolved.className).toContain("whitespace-normal");
    expect(markResolved.className).toContain("wrap-anywhere");

    await user.click(screen.getByRole("button", { name: /close session activity details/i }));
    await user.click(await screen.findByTestId("session-activity-workspace-change"));
    expect(screen.getByText("This must wrap in narrow panels.")).toBeInTheDocument();
  });

  it("opens subagent chat in the shared drawer and hides the floating panel content", async () => {
    installApis();
    const user = userEvent.setup();

    render(<SessionActivityPanel sessionId="root" />);
    await user.click(await screen.findByTestId("session-activity-agent"));

    expect(await screen.findByTestId("session-activity-detail")).toBeInTheDocument();
    expect(screen.getByTestId("mock-chat-panel")).toHaveTextContent("Chat child");
    expect(screen.queryByText("Progress")).not.toBeInTheDocument();
  });

  it("opens source details with query and link in the drawer", async () => {
    installApis();
    const user = userEvent.setup();

    render(<SessionActivityPanel sessionId="root" />);
    await user.click(await screen.findByText("Docs search"));

    expect(await screen.findByTestId("session-activity-detail")).toBeInTheDocument();
    expect(screen.getByText("release notes 2026")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open source" })).toBeInTheDocument();
    expect(screen.queryByText("Progress")).not.toBeInTheDocument();
  });

  it("opens pull request sources directly in the browser", async () => {
    installApis();
    const user = userEvent.setup();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);

    render(<SessionActivityPanel sessionId="root" />);
    await user.click(await screen.findByText("Pull request 8472"));

    expect(open).toHaveBeenCalledWith(
      "https://git.example.com/org/repo/pullrequest/8472",
      "_blank",
      "noopener,noreferrer",
    );
    expect(screen.queryByTestId("session-activity-detail")).not.toBeInTheDocument();
  });

  it("shows an explicit unavailable state instead of reading full file contents", async () => {
    installApis();
    const user = userEvent.setup();
    const commandCenterAPI = window.commandCenterAPI!;
    vi.mocked(commandCenterAPI.getSessionActivity).mockResolvedValue({
      success: true,
      activity: {
        ...activity,
        fileChanges: [
          {
            ...activity.fileChanges[0],
            path: JSON.stringify(["src/app.ts"]),
            diff: undefined,
          },
        ],
      },
    });

    render(<SessionActivityPanel sessionId="root" />);
    await user.click(await screen.findByTestId("session-activity-workspace-change"));

    const diff = await screen.findByTestId("session-activity-file-diff");
    expect(diff).toHaveTextContent("Full file unavailable.");
    expect(diff).toHaveTextContent("no full-file fallback is shown");
    expect(diff).not.toHaveTextContent("fallback line");
    expect(window.workspaceAPI?.readFile).not.toHaveBeenCalled();
  });

  it("surfaces scoped and truncated diff metadata in the drawer", async () => {
    installApis();
    const user = userEvent.setup();
    const commandCenterAPI = window.commandCenterAPI!;
    vi.mocked(commandCenterAPI.getSessionActivity).mockResolvedValue({
      success: true,
      activity: {
        ...activity,
        fileChanges: [
          {
            ...activity.fileChanges[0],
            diff: "@@ -10,7 +10,7 @@\n unchanged\n-old\n+new\n unchanged",
            diffContextLines: 3,
            diffTruncated: true,
          },
        ],
      },
    });

    render(<SessionActivityPanel sessionId="root" />);
    await user.click(await screen.findByTestId("session-activity-workspace-change"));

    const notices = await screen.findAllByTestId("session-activity-diff-notice");
    expect(notices.map((notice) => notice.textContent)).toEqual(
      expect.arrayContaining(["Only changed hunks shown (3 context lines).", "Diff truncated."]),
    );
  });

  it("does not show scoped-hunk wording for plain patch diffs without context metadata", async () => {
    installApis();
    const user = userEvent.setup();
    const commandCenterAPI = window.commandCenterAPI!;
    vi.mocked(commandCenterAPI.getSessionActivity).mockResolvedValue({
      success: true,
      activity: {
        ...activity,
        fileChanges: [
          {
            ...activity.fileChanges[0],
            diff: "+new\n-old",
            diffTruncated: true,
          },
        ],
      },
    });

    render(<SessionActivityPanel sessionId="root" />);
    await user.click(await screen.findByTestId("session-activity-workspace-change"));

    expect(screen.queryByText(/Only changed hunks shown/)).not.toBeInTheDocument();
    expect(screen.getAllByText("Diff truncated.")).toHaveLength(2);
  });

  it("hides the progress rail entirely until at least one section has content", async () => {
    // Empty snapshot + empty activity = no todos, changes, agents, sources, or workflows.
    const emptySnapshot: CommandCenterSnapshot = {
      replay: { status: "ok", lastDurableSeq: 0, skippedEvents: 0 },
      sessions: [],
      relationships: [],
      tools: [],
      files: [],
      artifacts: [],
      todos: [],
      runs: [],
      blockers: [],
    };
    const emptyActivity: CommandCenterSessionActivityDetails = {
      rootSessionId: "root",
      sessionIds: ["root"],
      safeSessionIds: ["safe-root"],
      fileChanges: [],
      sources: [],
    };
    Object.defineProperty(window, "commandCenterAPI", {
      configurable: true,
      value: {
        getSnapshot: vi
          .fn<CommandCenterAPI["getSnapshot"]>()
          .mockResolvedValue({ success: true, snapshot: emptySnapshot }),
        refresh: vi
          .fn<CommandCenterAPI["refresh"]>()
          .mockResolvedValue({ success: true, snapshot: emptySnapshot }),
        upsertTodo: vi
          .fn<CommandCenterAPI["upsertTodo"]>()
          .mockResolvedValue({ success: true, snapshot: emptySnapshot }),
        deleteTodo: vi
          .fn<CommandCenterAPI["deleteTodo"]>()
          .mockResolvedValue({ success: true, snapshot: emptySnapshot }),
        openSession: vi.fn<CommandCenterAPI["openSession"]>().mockResolvedValue({ success: true }),
        getSessionActivity: vi
          .fn<CommandCenterAPI["getSessionActivity"]>()
          .mockResolvedValue({ success: true, activity: emptyActivity }),
        onSnapshot: vi.fn<CommandCenterAPI["onSnapshot"]>().mockReturnValue(() => {}),
      },
    });
    Object.defineProperty(window, "sessionsAPI", {
      configurable: true,
      value: {
        listWithOptions: vi
          .fn<NonNullable<typeof window.sessionsAPI>["listWithOptions"]>()
          .mockResolvedValue({ success: true, sessions: [] }),
        onListChanged: vi
          .fn<NonNullable<typeof window.sessionsAPI>["onListChanged"]>()
          .mockReturnValue(() => {}),
      },
    });

    render(<SessionActivityPanel sessionId="root" />);

    // With empty content, no progress rail should mount after async panel data resolves.
    await screen.findByTestId("session-activity-panel");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.queryByTestId("session-activity-progress")).not.toBeInTheDocument();
    expect(screen.queryByText("Progress")).not.toBeInTheDocument();
  });

  it("renders Workflows section only when a workflow run is initiated by this session tree", async () => {
    installApis();
    const listRuns = vi.fn<() => Promise<{ success: true; runs: unknown[] }>>().mockResolvedValue({
      success: true,
      runs: [
        {
          runId: "run-1",
          runFamilyId: "fam-1",
          workflowId: "wsr-pipeline",
          status: "running",
          startedAt: 100,
          finishedAt: null,
          initiatorSessionId: "root",
        },
        {
          // Unrelated run — initiator outside the session tree.
          runId: "run-other",
          runFamilyId: "fam-other",
          workflowId: "wsr-pipeline",
          status: "succeeded",
          startedAt: 50,
          finishedAt: 75,
          initiatorSessionId: "stranger",
        },
        {
          // Schedule-triggered run with no initiator — must be filtered out.
          runId: "run-cron",
          runFamilyId: "fam-cron",
          workflowId: "wsr-pipeline",
          status: "succeeded",
          startedAt: 25,
          finishedAt: 30,
        },
      ],
    });
    const list = vi.fn<() => Promise<{ success: true; workflows: unknown[] }>>().mockResolvedValue({
      success: true,
      workflows: [{ id: "wsr-pipeline", displayName: "WSR Pipeline" }],
    });
    Object.defineProperty(window, "workflowsAPI", {
      configurable: true,
      value: { listRuns, list },
    });

    render(<SessionActivityPanel sessionId="root" />);

    expect(await screen.findByTestId("session-activity-section-workflows")).toBeInTheDocument();
    const rows = await screen.findAllByTestId("session-activity-workflow-run");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("WSR Pipeline");
    expect(rows[0]).toHaveTextContent("running");
  });

  it("opens a workflow run in the resizable details drawer when clicked", async () => {
    installApis();
    const user = userEvent.setup();
    const getRun = vi
      .fn<(runId: string) => Promise<{ success: true; snapshot: unknown }>>()
      .mockResolvedValue({
        success: true,
        snapshot: {
          runId: "run-1",
          runFamilyId: "fam-1",
          workflowId: "wsr-pipeline",
          workflowVersion: "1.0.0",
          status: "running",
          startedAt: 100,
          steps: [{ stepId: "s1", title: "Investigate", status: "running" }],
          agents: {},
          artifacts: [],
          capacity: { used: 1 },
          events: { lastSeq: 1 },
        },
      });
    Object.defineProperty(window, "workflowsAPI", {
      configurable: true,
      value: {
        listRuns: vi.fn<() => Promise<{ success: true; runs: unknown[] }>>().mockResolvedValue({
          success: true,
          runs: [
            {
              runId: "run-1",
              runFamilyId: "fam-1",
              workflowId: "wsr-pipeline",
              status: "running",
              startedAt: 100,
              finishedAt: null,
              initiatorSessionId: "root",
            },
          ],
        }),
        list: vi.fn<() => Promise<{ success: true; workflows: unknown[] }>>().mockResolvedValue({
          success: true,
          workflows: [{ id: "wsr-pipeline", displayName: "WSR Pipeline" }],
        }),
        getRun,
        cancel: vi.fn<(runId: string) => Promise<{ success: true }>>().mockResolvedValue({
          success: true,
        }),
      },
    });

    render(<SessionActivityPanel sessionId="root" />);

    await user.click(await screen.findByTestId("session-activity-workflow-run"));

    expect(await screen.findByTestId("session-activity-detail")).toBeInTheDocument();
    expect(await screen.findByTestId("session-activity-workflow-run-detail")).toBeInTheDocument();
    expect(await screen.findByText("Investigate")).toBeInTheDocument();
    expect(getRun).toHaveBeenCalledWith("run-1");
    // Existing changes section is still reachable (proves the drawer is the
    // same resizable surface used for changes — same testid).
    expect(screen.queryByTestId("session-activity-progress")).not.toBeInTheDocument();
  });
});

it("drills into a bounded one-line Swarm run in the same progress panel and returns with Back", async () => {
  const user = userEvent.setup();
  installApis();
  const entry = {
    sessionId: "root",
    workspaceName: "Scratchpad",
    extensionId: "@marshal/swarm",
    applicationId: "swarm-run",
    applicationTitle: "Swarm",
    id: "run-1",
    title: `Implement feature\n${"large prompt ".repeat(10000)}`,
    status: "blocked",
  };
  const instance = {
    instanceId: "run-1-view",
    owner: entry,
    surface: "panel",
    revision: 1,
    openedAt: "now",
    updatedAt: "now",
    focusedAt: "now",
    idempotencyKey: "open",
    content: { kind: "text", text: "Swarm tree detail" },
  };
  const listeners = new Set<(event: RuntimeUiEvent) => void>();
  const openEvidence = vi
    .fn<(request: unknown) => Promise<{ success: boolean; value: { instance: typeof instance } }>>()
    .mockResolvedValue({ success: true, value: { instance } });
  Object.defineProperty(window, "runtimeUiAPI", {
    configurable: true,
    value: {
      getEvidence: vi
        .fn<() => Promise<{ success: boolean; value: (typeof entry)[] }>>()
        .mockResolvedValue({ success: true, value: [entry] }),
      openEvidence,
      onEvent: (listener: (event: RuntimeUiEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
  render(<SessionActivityPanel sessionId="root" />);
  const row = await screen.findByTestId("session-activity-evidence-run");
  expect(row.textContent.length).toBeLessThan(150);
  expect(row.textContent).not.toContain("\n");
  expect(row).toHaveTextContent("SwarmImplement feature");
  expect(row).toHaveTextContent("blocked");
  const panel = screen.getByTestId("session-activity-progress");
  const width = panel.style.width;
  await user.click(row);
  expect(await screen.findByText("Swarm tree detail")).toBeInTheDocument();
  expect(openEvidence).toHaveBeenCalledWith(
    expect.objectContaining({ id: "run-1", presentation: "embedded" }),
  );
  expect(screen.queryByTestId("session-activity-detail")).not.toBeInTheDocument();
  expect(screen.getByTestId("session-activity-progress").style.width).toBe(width);
  expect(screen.queryByTestId("session-activity-evidence-run")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Back to progress" }));
  expect(screen.getByTestId("session-activity-evidence-run")).toBeInTheDocument();
  expect(screen.queryByText("Swarm tree detail")).not.toBeInTheDocument();
  const opened: RuntimeUiEvent = {
    type: "instance-opened",
    sequence: 1,
    occurredAt: "now",
    scope: { sessionId: "root", workspaceName: "Scratchpad" },
    instance: {
      ...instance,
      surface: "panel",
      content: {
        kind: "application",
        renderId: SWARM_RUN_VIEW_RENDER_ID,
        resource: { uri: "ui://marshal/swarm/run", mimeType: "text/html" },
        descriptor: { version: "1.0.0", presentationModes: ["pip"], actions: [], tools: [] },
      },
    },
  };
  act(() => listeners.forEach((listener) => listener(opened)));
  expect(screen.getByTestId("session-activity-evidence-detail")).toBeInTheDocument();
  expect(screen.queryByTestId("session-activity-detail")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Back to progress" }));
  act(() =>
    listeners.forEach((listener) => listener({ ...opened, type: "instance-updated", sequence: 2 })),
  );
  expect(screen.queryByTestId("session-activity-evidence-detail")).not.toBeInTheDocument();
});
