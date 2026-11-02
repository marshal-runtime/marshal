import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import { installMockAPIs, render, screen, userEvent } from "@/test-utils";
import type { CommandCenterAPI, SessionMetadata } from "@/types/electron";

import { CommandCenterPanel } from "./CommandCenterPanel";

type EmptyCallback = () => void;
type OpenSessionCallback = (sessionId: string) => void;
type SessionsApi = NonNullable<typeof window.sessionsAPI>;

const NOW = new Date("2026-06-10T11:19:00.000Z").getTime();
const eightHoursAgoIso = new Date(NOW - 7 * 60 * 60 * 1000).toISOString();
const tenHoursAgoIso = new Date(NOW - 10 * 60 * 60 * 1000).toISOString();

function makeSession(
  id: string,
  name: string,
  overrides: Partial<SessionMetadata> = {},
): SessionMetadata {
  return {
    id,
    name,
    createdAt: tenHoursAgoIso,
    updatedAt: eightHoursAgoIso,
    hasUnread: false,
    isActive: false,
    isBusy: false,
    ...overrides,
  };
}

function installCommandCenterAPI(api: Partial<CommandCenterAPI> | undefined) {
  Object.defineProperty(window, "commandCenterAPI", {
    configurable: true,
    value: api,
  });
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  installCommandCenterAPI(undefined);
});

describe("CommandCenterPanel", () => {
  it("renders the three session sections using the session name from sessionsAPI", async () => {
    const sessions: SessionMetadata[] = [
      makeSession("running-1", "Running root agent", { isBusy: true }),
      makeSession("recent-1", "Recently finished session", {
        updatedAt: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
      }),
      makeSession("old-1", "Old session", {
        updatedAt: new Date(NOW - 24 * 60 * 60 * 1000).toISOString(),
      }),
    ];
    installMockAPIs({
      sessionsAPI: {
        listWithOptions: vi
          .fn<SessionsApi["listWithOptions"]>()
          .mockResolvedValue({ success: true, sessions }),
      },
    });
    installCommandCenterAPI(undefined);

    render(
      <CommandCenterPanel
        onClose={vi.fn<EmptyCallback>()}
        onOpenSession={vi.fn<OpenSessionCallback>()}
      />,
    );

    expect(await screen.findByText("Running root agent")).toBeInTheDocument();
    expect(screen.getByText("Recently finished session")).toBeInTheDocument();

    // Older section is collapsed by default.
    expect(screen.queryByText("Old session")).not.toBeInTheDocument();

    // Sections render with their bucket counts.
    const activeSection = screen.getByTestId("command-center-section-active");
    expect(activeSection).toHaveTextContent("Active");
    expect(activeSection).toHaveTextContent("1");

    const olderSection = screen.getByTestId("command-center-section-older");
    expect(olderSection).toHaveTextContent("Older");
    expect(olderSection).toHaveTextContent("1");
  });

  it("expanding the Older section reveals sessions outside the 8h window", async () => {
    const user = userEvent.setup();
    installMockAPIs({
      sessionsAPI: {
        listWithOptions: vi.fn<SessionsApi["listWithOptions"]>().mockResolvedValue({
          success: true,
          sessions: [
            makeSession("old-1", "Yesterday session", {
              updatedAt: new Date(NOW - 30 * 60 * 60 * 1000).toISOString(),
            }),
          ],
        }),
      },
    });

    render(
      <CommandCenterPanel
        onClose={vi.fn<EmptyCallback>()}
        onOpenSession={vi.fn<OpenSessionCallback>()}
      />,
    );

    await screen.findByTestId("command-center-section-older");
    expect(screen.queryByText("Yesterday session")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Older/ }));
    expect(await screen.findByText("Yesterday session")).toBeInTheDocument();
  });

  it("renders subagent children indented under their parent within the same section", async () => {
    installMockAPIs({
      sessionsAPI: {
        listWithOptions: vi.fn<SessionsApi["listWithOptions"]>().mockResolvedValue({
          success: true,
          sessions: [
            makeSession("parent", "Parent agent", { isBusy: true }),
            makeSession("child-a", "Child A", { isBusy: true, parentSessionId: "parent" }),
            makeSession("child-b", "Child B", { isBusy: true, parentSessionId: "parent" }),
            makeSession("grandchild", "Grandchild", {
              isBusy: true,
              parentSessionId: "child-a",
            }),
          ],
        }),
      },
    });

    render(
      <CommandCenterPanel
        onClose={vi.fn<EmptyCallback>()}
        onOpenSession={vi.fn<OpenSessionCallback>()}
      />,
    );

    const rows = await screen.findAllByTestId("command-center-session-row");
    const byId = new Map(rows.map((row) => [row.getAttribute("data-session-id"), row]));
    expect(byId.get("parent")?.getAttribute("data-depth")).toBe("0");
    expect(byId.get("child-a")?.getAttribute("data-depth")).toBe("1");
    expect(byId.get("child-b")?.getAttribute("data-depth")).toBe("1");
    expect(byId.get("grandchild")?.getAttribute("data-depth")).toBe("2");

    // Children lists nest under their parent in the DOM (one per parent with
    // children — in this fixture: under "parent" and under "child-a").
    const childrenLists = screen.getAllByTestId("command-center-children");
    const parentIds = childrenLists
      .map((el) => el.getAttribute("data-parent-id"))
      .sort((left, right) => String(left).localeCompare(String(right)));
    expect(parentIds).toEqual(["child-a", "parent"]);
  });

  it("selecting a session shows the reused activity panel for that session", async () => {
    const user = userEvent.setup();
    installMockAPIs({
      sessionsAPI: {
        listWithOptions: vi.fn<SessionsApi["listWithOptions"]>().mockResolvedValue({
          success: true,
          sessions: [makeSession("s-1", "Chosen session", { isBusy: true })],
        }),
      },
    });

    render(
      <CommandCenterPanel
        onClose={vi.fn<EmptyCallback>()}
        onOpenSession={vi.fn<OpenSessionCallback>()}
      />,
    );

    const detail = await screen.findByTestId("command-center-detail");
    expect(detail).toHaveTextContent(/Select a session/);

    await user.click(screen.getByRole("button", { name: /Chosen session/ }));
    expect(await screen.findByTestId("session-activity-panel")).toBeInTheDocument();
  });

  it("routes Open chat through commandCenterAPI.openSession when available", async () => {
    const user = userEvent.setup();
    const openSession = vi
      .fn<CommandCenterAPI["openSession"]>()
      .mockResolvedValue({ success: true });
    installMockAPIs({
      sessionsAPI: {
        listWithOptions: vi.fn<SessionsApi["listWithOptions"]>().mockResolvedValue({
          success: true,
          sessions: [makeSession("s-1", "Chosen session", { isBusy: true })],
        }),
      },
    });
    installCommandCenterAPI({
      openSession,
      getSnapshot: vi.fn<CommandCenterAPI["getSnapshot"]>().mockResolvedValue({ success: false }),
      onSnapshot: vi.fn<CommandCenterAPI["onSnapshot"]>().mockReturnValue(() => {}),
    });
    const onOpenSession = vi.fn<OpenSessionCallback>();

    render(<CommandCenterPanel onClose={vi.fn<EmptyCallback>()} onOpenSession={onOpenSession} />);

    await user.click(await screen.findByRole("button", { name: /Chosen session/ }));
    await user.click(await screen.findByRole("button", { name: "Open chat" }));

    expect(openSession).toHaveBeenCalledWith("s-1");
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("falls back to onOpenSession when no commandCenterAPI is available", async () => {
    const user = userEvent.setup();
    installMockAPIs({
      sessionsAPI: {
        listWithOptions: vi.fn<SessionsApi["listWithOptions"]>().mockResolvedValue({
          success: true,
          sessions: [makeSession("s-1", "Chosen session", { isBusy: true })],
        }),
      },
    });
    installCommandCenterAPI(undefined);
    const onOpenSession = vi.fn<OpenSessionCallback>();

    render(<CommandCenterPanel onClose={vi.fn<EmptyCallback>()} onOpenSession={onOpenSession} />);

    await user.click(await screen.findByRole("button", { name: /Chosen session/ }));
    await user.click(await screen.findByRole("button", { name: "Open chat" }));

    expect(onOpenSession).toHaveBeenCalledWith("s-1");
  });

  it("does not render the removed numbers summary or tools/runs/blockers sections", async () => {
    installMockAPIs({
      sessionsAPI: {
        listWithOptions: vi.fn<SessionsApi["listWithOptions"]>().mockResolvedValue({
          success: true,
          sessions: [makeSession("s-1", "Some session", { isBusy: true })],
        }),
      },
    });

    render(
      <CommandCenterPanel
        onClose={vi.fn<EmptyCallback>()}
        onOpenSession={vi.fn<OpenSessionCallback>()}
      />,
    );

    await screen.findByText("Some session");

    expect(screen.queryByText(/Replay state/)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Tools" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Runs" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Blockers" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Todos" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Files" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Artifacts" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Relationships" })).not.toBeInTheDocument();
  });
});
