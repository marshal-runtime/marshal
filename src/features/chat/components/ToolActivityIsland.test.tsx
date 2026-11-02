import { beforeEach, describe, expect, it } from "vitest";

import { installMockAPIs, render, screen, userEvent, within } from "@/test-utils";
import type { PermissionCardData } from "@/types/electron";

import type { BackendEvent } from "../../../../electron/backend/types";
import { SessionViewBuilder } from "../../../../electron/session-view-builder";
import { TurnAccumulator } from "../../../../electron/turn-accumulator";
import { ToolActivityIsland } from "./ToolActivityIsland";

beforeEach(() => {
  installMockAPIs();
});

function permission(id: string, overrides: Partial<PermissionCardData> = {}): PermissionCardData {
  return {
    id,
    kind: "shell",
    title: "Run a command",
    message: "Marshal needs to run a command",
    detail: "pnpm test",
    buttons: ["Allow", "Deny"],
    ...overrides,
  };
}

function productionToolStatuses(events: BackendEvent[]) {
  const accumulator = new TurnAccumulator();
  const builder = new SessionViewBuilder();
  for (const event of events) {
    for (const turnEvent of accumulator.processEvent(event)) {
      builder.apply(turnEvent);
    }
  }
  return builder.getView().toolStatuses;
}

describe("ToolActivityIsland", () => {
  it("collapses concurrent calls into one human-readable live objective", async () => {
    const user = userEvent.setup();
    render(
      <ToolActivityIsland
        variant="live"
        tools={[
          {
            id: "search-1",
            name: "rg",
            description: "Searching for session state",
            running: false,
            success: true,
          },
          { id: "read-1", name: "view", description: "Reading ChatPanel.tsx", running: true },
          { id: "read-2", name: "view", description: "Reading Timeline.tsx", running: true },
        ]}
      />,
    );

    const toggle = screen.getByTestId("tool-status-toggle");
    expect(toggle).toHaveAccessibleName("Expand activity: Reading 2 files");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("1 of 3 complete")).toBeInTheDocument();
    expect(screen.queryByText("Reading ChatPanel.tsx")).not.toBeInTheDocument();

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("region", { name: "Completed activity" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Current activity" })).toBeInTheDocument();
    expect(screen.getByText("Reading ChatPanel.tsx")).toBeInTheDocument();
    expect(screen.getByText("Reading Timeline.tsx")).toBeInTheDocument();
  });

  it("keeps raw tool names and payloads behind progressive disclosure", async () => {
    const user = userEvent.setup();
    render(
      <ToolActivityIsland
        variant="live"
        tools={[
          {
            id: "shell-1",
            name: "functions.powershell",
            description: "Running powershell",
            running: true,
            input: JSON.stringify({
              command: "pnpm test src/features/chat",
              description: "Run targeted chat tests",
            }),
          },
        ]}
      />,
    );

    expect(screen.getByText("Run targeted chat tests")).toBeInTheDocument();
    expect(screen.queryByText("functions.powershell")).not.toBeInTheDocument();
    expect(screen.queryByText(/pnpm test src\/features\/chat/)).not.toBeInTheDocument();

    await user.click(screen.getByTestId("tool-status-toggle"));
    await user.click(screen.getByTestId("tool-status-row-toggle"));

    expect(screen.getByText("functions.powershell")).toBeInTheDocument();
    expect(screen.getByTestId("live-tool-detail-input")).toHaveTextContent(
      "pnpm test src/features/chat",
    );
  });

  it("groups a pending permission as current and later decisions as up next", async () => {
    const user = userEvent.setup();
    render(
      <ToolActivityIsland
        variant="live"
        tools={[]}
        activePermissions={[
          permission("permission-1"),
          permission("permission-2", { kind: "write", title: "Update a file" }),
        ]}
      />,
    );

    expect(screen.getByText("Waiting to run a command")).toBeInTheDocument();
    expect(screen.getByText("0 of 2 complete · approval needed")).toBeInTheDocument();

    await user.click(screen.getByTestId("tool-status-toggle"));

    const current = screen.getByRole("region", { name: "Current activity" });
    const upNext = screen.getByRole("region", { name: "Up next activity" });
    expect(within(current).getByText("Waiting to run a command")).toBeInTheDocument();
    expect(within(upNext).getByText("Waiting to change files")).toBeInTheDocument();
  });

  it("renders completed work as a compact receipt", async () => {
    const user = userEvent.setup();
    render(
      <ToolActivityIsland
        variant="receipt"
        messageId="message-1"
        tools={[
          {
            id: "read-1",
            name: "view",
            description: "Reading package.json",
            success: true,
          },
          {
            id: "read-2",
            name: "view",
            description: "Reading pnpm-lock.yaml",
            success: true,
          },
        ]}
      />,
    );

    expect(screen.getByText("Read 2 files")).toBeInTheDocument();
    expect(screen.queryByTestId("committed-tool-calls-content")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("committed-tool-calls-toggle"));

    expect(screen.getByTestId("committed-tool-calls-content")).toBeInTheDocument();
    expect(screen.getAllByTestId("committed-tool-call-row")).toHaveLength(2);
  });

  it("surfaces failure and cancellation states without leaving expanded cards", async () => {
    const user = userEvent.setup();
    render(
      <ToolActivityIsland
        variant="receipt"
        messageId="message-1"
        tools={[
          {
            id: "failed-1",
            name: "shell",
            description: "Run tests",
            success: false,
            error: "Command failed",
          },
          {
            id: "cancelled-1",
            name: "shell",
            description: "Build app",
            success: false,
            error: "Operation cancelled",
          },
        ]}
      />,
    );

    expect(screen.getByText("Finished with 1 issue")).toBeInTheDocument();

    await user.click(screen.getByTestId("committed-tool-calls-toggle"));

    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
  });

  it("renders production accumulator and session-view completion state without relabeling failures as done", async () => {
    const user = userEvent.setup();
    const tools = productionToolStatuses([
      {
        type: "tool-start",
        toolCallId: "read",
        toolName: "browser_snapshot",
        args: { folderId: "root" },
      },
      {
        type: "tool-result",
        toolCallId: "read",
        result: { count: 3 },
        success: true,
      },
      {
        type: "tool-start",
        toolCallId: "failed",
        toolName: "move_file",
        args: { subject: "Status" },
      },
      {
        type: "tool-result",
        toolCallId: "failed",
        result: { requestId: "req-1" },
        success: false,
        error: "Send failed",
      },
      {
        type: "tool-start",
        toolCallId: "cancelled",
        toolName: "browser_click",
        args: { element: "Submit" },
      },
      {
        type: "tool-result",
        toolCallId: "cancelled",
        result: null,
        success: false,
        error: "Operation cancelled",
      },
    ]);

    expect(tools).toEqual([
      expect.objectContaining({
        id: "read",
        activityKind: "read",
        running: false,
        input: '{\n  "folderId": "root"\n}',
        output: '{\n  "count": 3\n}',
        success: true,
      }),
      expect.objectContaining({
        id: "failed",
        activityKind: "mutation",
        running: false,
        success: false,
        error: "Send failed",
      }),
      expect.objectContaining({
        id: "cancelled",
        activityKind: "mutation",
        running: false,
        success: false,
        cancelled: true,
        error: "Operation cancelled",
      }),
    ]);

    render(<ToolActivityIsland variant="live" tools={tools} />);
    expect(screen.getByText("Finished with 1 issue")).toBeInTheDocument();

    await user.click(screen.getByTestId("tool-status-toggle"));

    expect(screen.getByText("Read page content")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.getByText(/^Done$/)).toBeInTheDocument();

    const detailToggles = screen.getAllByTestId("tool-status-row-toggle");
    await user.click(detailToggles[1]);
    expect(screen.getByTestId("live-tool-detail-error")).toHaveTextContent("Send failed");
    expect(screen.getByTestId("live-tool-detail-output")).toHaveTextContent("req-1");
  });

  it("aggregates trusted reads and mutations", () => {
    const { rerender } = render(
      <ToolActivityIsland
        variant="live"
        tools={[
          {
            id: "snapshot",
            name: "browser_snapshot",
            description: "Running browser snapshot",
            running: true,
          },
          { id: "search", name: "web_search", description: "Running web search", running: true },
          { id: "fetch", name: "web_fetch", description: "Running web fetch", running: true },
        ]}
      />,
    );
    expect(screen.getByText("Reading 3 sources")).toBeInTheDocument();

    rerender(
      <ToolActivityIsland
        variant="live"
        tools={[
          {
            id: "click",
            name: "browser_click",
            description: "Running browser click",
            running: true,
          },
          { id: "type", name: "browser_type", description: "Running browser type", running: true },
          {
            id: "navigate",
            name: "browser_navigate",
            description: "Running browser navigate",
            running: true,
          },
        ]}
      />,
    );
    expect(screen.getByText("Performing 3 actions")).toBeInTheDocument();
  });

  it.each([
    ["browser_snapshot", "Read page content"],
    ["browser_click", "Clicked something on the page"],
    ["move_file", "Moved file"],
  ])("renders an accurate singleton receipt for %s", (name, expected) => {
    render(
      <ToolActivityIsland
        variant="receipt"
        messageId="message-1"
        tools={[{ id: name, name, description: `Running ${name}`, success: true }]}
      />,
    );
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it.each([
    ["move_file", "Moving file"],
    ["browser_click", "Clicking something on the page"],
  ])("renders trusted live mutation copy for %s", (name, expected) => {
    render(
      <ToolActivityIsland
        variant="live"
        tools={[
          {
            id: name,
            name,
            description: `Running ${name}`,
            activityKind: "mutation",
            running: true,
          },
        ]}
      />,
    );
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it("keeps producer activity kind authoritative over conflicting move/read text", () => {
    render(
      <ToolActivityIsland
        variant="live"
        tools={[
          {
            id: "mail",
            name: "moveEmail",
            description: "Moving archive file",
            activityKind: "mutation",
            running: true,
          },
          {
            id: "custom",
            name: "custom_mutator",
            description: "Reading file before mutation",
            activityKind: "mutation",
            running: true,
          },
        ]}
      />,
    );
    expect(screen.getByText("Performing 2 actions")).toBeInTheDocument();
    expect(screen.queryByText("Updating 2 files")).not.toBeInTheDocument();
    expect(screen.queryByText("Reading 2 files")).not.toBeInTheDocument();
  });

  it("uses phase-safe copy for a generic view tool", () => {
    const { rerender } = render(
      <ToolActivityIsland
        variant="live"
        tools={[
          {
            id: "view",
            name: "view",
            description: "Reading file",
            activityKind: "read",
            running: true,
          },
        ]}
      />,
    );
    expect(screen.getByText("Reading file")).toBeInTheDocument();

    rerender(
      <ToolActivityIsland
        variant="receipt"
        messageId="message"
        tools={[
          {
            id: "view",
            name: "view",
            description: "Reading file",
            activityKind: "read",
            success: true,
          },
        ]}
      />,
    );
    expect(screen.getByText("Read file")).toBeInTheDocument();
    expect(screen.queryByText("Reading file")).not.toBeInTheDocument();
  });

  it("humanizes generated progress copy for a running unknown native tool", () => {
    render(
      <ToolActivityIsland
        variant="live"
        tools={[
          {
            id: "unknown",
            name: "unknown_tool",
            description: "Running unknown_tool",
            activityKind: "other",
            running: true,
          },
        ]}
      />,
    );
    expect(screen.getByText("Unknown tool")).toBeInTheDocument();
    expect(screen.queryByText("Running unknown_tool")).not.toBeInTheDocument();
  });

  it("keeps meaningful progress copy for a running unknown native tool", () => {
    render(
      <ToolActivityIsland
        variant="live"
        tools={[
          {
            id: "unknown",
            name: "refreshAccountCache",
            description: "Refreshing the account cache",
            activityKind: "other",
            running: true,
          },
        ]}
      />,
    );
    expect(screen.getByText("Refreshing the account cache")).toBeInTheDocument();
  });

  it("uses a humanized row identity with a conservative terminal summary", async () => {
    const user = userEvent.setup();
    render(
      <ToolActivityIsland
        variant="receipt"
        messageId="message"
        tools={[
          {
            id: "unknown",
            name: "unknown_tool",
            description: "Running unknown_tool",
            activityKind: "other",
            success: true,
          },
        ]}
      />,
    );
    expect(screen.getByText("Completed 1 step")).toBeInTheDocument();
    await user.click(screen.getByTestId("committed-tool-calls-toggle"));
    expect(screen.getByText("Unknown tool")).toBeInTheDocument();
    expect(screen.queryByText("Running unknown_tool")).not.toBeInTheDocument();
    expect(screen.queryByText("Completed step")).not.toBeInTheDocument();
  });

  it("summarizes multiple explicit other tools conservatively", () => {
    render(
      <ToolActivityIsland
        variant="receipt"
        messageId="message"
        tools={[
          {
            id: "one",
            name: "unknown_one",
            description: "Running delete email",
            activityKind: "other",
            success: true,
          },
          {
            id: "two",
            name: "unknown_two",
            description: "Running update event",
            activityKind: "other",
            success: true,
          },
        ]}
      />,
    );
    expect(screen.getByText("Completed 2 steps")).toBeInTheDocument();
    expect(screen.queryByText("Ran 2 commands")).not.toBeInTheDocument();
  });

  it.each(["powershell", "bash"])(
    "uses trusted command metadata for live and completed %s copy",
    (name) => {
      const shellTool = {
        id: "shell",
        name,
        description: `Running ${name}`,
        activityKind: "command" as const,
        input: JSON.stringify({ command: "git status --short" }),
      };
      const { rerender } = render(
        <ToolActivityIsland variant="live" tools={[{ ...shellTool, running: true }]} />,
      );
      expect(screen.getByText("Running git status --short")).toBeInTheDocument();

      rerender(
        <ToolActivityIsland
          variant="receipt"
          messageId="message"
          tools={[{ ...shellTool, success: true }]}
        />,
      );
      expect(screen.getByText("Ran git status --short")).toBeInTheDocument();
    },
  );

  it("uses command identity when completed command metadata is unavailable", async () => {
    const user = userEvent.setup();
    render(
      <ToolActivityIsland
        variant="receipt"
        messageId="message"
        tools={[
          {
            id: "shell",
            name: "powershell",
            description: "Running powershell",
            activityKind: "command",
            success: true,
          },
        ]}
      />,
    );

    await user.click(screen.getByTestId("committed-tool-calls-toggle"));

    expect(
      within(screen.getByTestId("committed-tool-call-row")).getByText("Powershell"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Ran command")).not.toBeInTheDocument();
  });

  it.each([
    ["custom_command", "custom_command", "Custom command"],
    ["shellfish", "Running shellfish", "Shellfish"],
  ])("does not treat untrusted %s as a command while active", (name, description, expected) => {
    render(
      <ToolActivityIsland
        variant="live"
        tools={[
          {
            id: name,
            name,
            description,
            activityKind: "other",
            running: true,
          },
        ]}
      />,
    );
    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(screen.queryByText("Running a command")).not.toBeInTheDocument();
  });

  it.each([
    ["custom_command", "custom_command", "Custom command"],
    ["shellfish", "Running shellfish", "Shellfish"],
  ])("uses a humanized terminal row for untrusted %s", async (name, description, expected) => {
    const user = userEvent.setup();
    render(
      <ToolActivityIsland
        variant="receipt"
        messageId="message"
        tools={[
          {
            id: name,
            name,
            description,
            activityKind: "other",
            success: true,
          },
        ]}
      />,
    );
    expect(screen.getByText("Completed 1 step")).toBeInTheDocument();
    await user.click(screen.getByTestId("committed-tool-calls-toggle"));
    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(screen.queryByText("Running a command")).not.toBeInTheDocument();
  });

  it("shows listSubagents at row level without an empty technical-detail affordance", async () => {
    const user = userEvent.setup();
    render(
      <ToolActivityIsland
        variant="receipt"
        messageId="message-1"
        tools={[
          {
            id: "subagents",
            name: "listSubagents",
            description: "Running list subagents",
            success: true,
          },
        ]}
      />,
    );

    await user.click(screen.getByTestId("committed-tool-calls-toggle"));

    const row = screen.getByTestId("committed-tool-call-row");
    const label = within(row).getByText("List subagents");
    expect(label).toHaveClass("truncate");
    expect(label).toHaveAttribute("title", "List subagents (listSubagents)");
    expect(screen.queryByTestId("committed-tool-call-toggle")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "List subagents" })).toBe(row);
    expect(row).toHaveAccessibleDescription("Tool listSubagents. Status: Done.");
    expect(row).not.toHaveAttribute("aria-label");
    expect(row).not.toHaveAttribute("tabindex");
    expect(within(row).getByText("Done")).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByText("Completed step")).not.toBeInTheDocument();
  });

  it.each([
    ["toString", "To string"],
    ["constructor", "Constructor"],
    ["__proto__", "Proto"],
    ["mcp:vendor:unknownAction", "Unknown action"],
  ])("renders prototype-like or unknown name-only tool %s safely", async (name, expected) => {
    const user = userEvent.setup();
    render(
      <ToolActivityIsland
        variant="receipt"
        messageId="message-1"
        tools={[
          {
            id: name,
            name,
            description: `Running ${name}`,
            success: true,
          },
        ]}
      />,
    );

    await user.click(screen.getByTestId("committed-tool-calls-toggle"));

    const row = screen.getByRole("group", { name: expected });
    expect(row).toHaveAccessibleDescription(`Tool ${name}. Status: Done.`);
    expect(screen.queryByText("Completed step")).not.toBeInTheDocument();
  });

  it("shows tool identity before input and output technical details", async () => {
    const user = userEvent.setup();
    render(
      <ToolActivityIsland
        variant="receipt"
        messageId="message-1"
        tools={[
          {
            id: "subagents",
            name: "listSubagents",
            description: "Running list subagents",
            input: '{"scope":"children"}',
            output: '{"count":2}',
            success: true,
          },
        ]}
      />,
    );

    await user.click(screen.getByTestId("committed-tool-calls-toggle"));

    const rowToggle = screen.getByTestId("committed-tool-call-toggle");
    expect(screen.getByText("List subagents")).toBeInTheDocument();
    expect(rowToggle).toHaveAccessibleName(
      "Show technical details for List subagents, tool listSubagents, Done",
    );
    expect(screen.queryByTestId("tool-status-details")).not.toBeInTheDocument();

    await user.click(rowToggle);

    expect(screen.getByText("listSubagents")).toBeInTheDocument();
    expect(screen.getByTestId("tool-detail-input")).toHaveTextContent('"scope":"children"');
    expect(screen.getByTestId("tool-detail-output")).toHaveTextContent('"count":2');
  });

  it("distinguishes unknown camel-case and namespaced tool rows", async () => {
    const user = userEvent.setup();
    render(
      <ToolActivityIsland
        variant="receipt"
        messageId="message-1"
        tools={[
          {
            id: "profile",
            name: "fetchUserProfile",
            description: "Running fetchUserProfile",
            success: true,
          },
          {
            id: "archive",
            name: "mcp:custom:archive_records",
            description: "Running mcp:custom:archive_records",
            success: true,
          },
        ]}
      />,
    );

    await user.click(screen.getByTestId("committed-tool-calls-toggle"));

    expect(screen.getByText("Fetch user profile")).toBeInTheDocument();
    expect(screen.getByText("Archive records")).toBeInTheDocument();
    expect(screen.queryAllByText("Completed step")).toHaveLength(0);
  });

  it("distinguishes concurrent namespaced tools that share server fallback copy", async () => {
    const user = userEvent.setup();
    render(
      <ToolActivityIsland
        variant="live"
        tools={[
          {
            id: "pulls",
            name: "mcp:github:listPullRequests",
            description: "Using GitHub",
            running: true,
          },
          {
            id: "issue",
            name: "mcp:github:getIssue",
            description: "Using GitHub",
            running: true,
          },
        ]}
      />,
    );

    await user.click(screen.getByTestId("tool-status-toggle"));

    const current = screen.getByRole("region", { name: "Current activity" });
    expect(within(current).getByText("List pull requests")).toBeInTheDocument();
    expect(within(current).getByText("Get issue")).toBeInTheDocument();
    expect(screen.queryByText("Using GitHub")).not.toBeInTheDocument();
  });

  it("preserves meaningful file, browser, and shell operation copy in expanded rows", async () => {
    const user = userEvent.setup();
    render(
      <ToolActivityIsland
        variant="receipt"
        messageId="message-1"
        tools={[
          {
            id: "file",
            name: "view",
            description: "Reading ChatPanel.tsx",
            success: true,
          },
          {
            id: "browser",
            name: "browser_click",
            description: "Running browser click",
            success: true,
          },
          {
            id: "shell",
            name: "powershell",
            description: "Running powershell",
            input: '{"command":"git status --short"}',
            success: true,
          },
        ]}
      />,
    );

    await user.click(screen.getByTestId("committed-tool-calls-toggle"));

    expect(screen.getByText("Read ChatPanel.tsx")).toBeInTheDocument();
    expect(screen.getByText("Clicked something on the page")).toBeInTheDocument();
    expect(screen.getByText("Ran git status --short")).toBeInTheDocument();
  });

  it("shows generic tool identities with failed, cancelled, current, and waiting statuses", async () => {
    const user = userEvent.setup();
    render(
      <ToolActivityIsland
        variant="live"
        tools={[
          {
            id: "failed",
            name: "failedGenericTool",
            description: "Running failedGenericTool",
            success: false,
            error: "Tool failed",
          },
          {
            id: "cancelled",
            name: "cancelledGenericTool",
            description: "Running cancelledGenericTool",
            success: false,
            cancelled: true,
            error: "Operation cancelled",
          },
          {
            id: "current",
            name: "currentGenericTool",
            description: "Running currentGenericTool",
            running: true,
          },
          {
            id: "waiting",
            name: "waitingGenericTool",
            description: "Running waitingGenericTool",
            running: true,
          },
          {
            id: "queued",
            name: "queuedGenericTool",
            description: "Running queuedGenericTool",
            running: true,
          },
        ]}
        activePermissions={[
          permission("permission-1", { kind: "custom-tool", toolCallId: "waiting" }),
          permission("permission-2", { kind: "custom-tool", toolCallId: "queued" }),
        ]}
      />,
    );

    await user.click(screen.getByTestId("tool-status-toggle"));

    const completed = screen.getByRole("region", { name: "Completed activity" });
    const current = screen.getByRole("region", { name: "Current activity" });
    const upNext = screen.getByRole("region", { name: "Up next activity" });
    const failed = within(completed).getByRole("button", {
      name: /Failed generic tool, tool failedGenericTool, Failed/,
    });
    const cancelled = within(completed).getByRole("button", {
      name: /Cancelled generic tool, tool cancelledGenericTool, Cancelled/,
    });
    const waiting = within(current).getByRole("button", {
      name: /Waiting generic tool, tool waitingGenericTool, Waiting/,
    });
    const queued = within(upNext).getByRole("button", {
      name: /Queued generic tool, tool queuedGenericTool, Waiting/,
    });

    expect(within(failed).getByText("Failed")).toBeInTheDocument();
    expect(within(cancelled).getByText("Cancelled")).toBeInTheDocument();
    expect(within(current).getByTestId("tool-activity-group-spinner")).toBeInTheDocument();
    const currentTool = within(current).getByRole("group", { name: "Current generic tool" });
    expect(currentTool).toHaveAccessibleDescription(
      "Tool currentGenericTool. Status: In progress.",
    );
    expect(within(waiting).getByText("Waiting")).toBeInTheDocument();
    expect(within(queued).getByText("Waiting")).toBeInTheDocument();
  });
});
