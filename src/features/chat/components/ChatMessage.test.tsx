import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";

import { TelemetryProvider } from "@/services/telemetry";
import { RenderScenarioProvider } from "@/services/telemetry/RenderScenarioProvider";
import {
  TelemetryPath_App,
  TelemetryPath_Chat,
  TelemetryPath_Messages,
  TelemetryPath_Message,
} from "@/services/telemetry/schema";
import {
  installMockAPIs,
  installMockClipboard,
  render,
  screen,
  waitFor,
  within,
} from "@/test-utils";

import { ChatMessage, StreamingMessage, type Message } from "./ChatMessage";

function installMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    }),
  });
}

beforeEach(() => {
  installMockAPIs();
  installMockClipboard();
  // Default to desktop; individual tests opt into mobile via installMatchMedia(true).
  installMatchMedia(false);
});

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "m1",
    role: "user",
    content: "Hello world",
    timestamp: new Date(),
    ...overrides,
  };
}

function makeAgentMessage(
  overrides: Partial<NonNullable<Message["agentMessage"]>> = {},
): NonNullable<Message["agentMessage"]> {
  return {
    messageId: "delivery-1",
    idempotencyKey: "delivery-1",
    source: "subagent-1",
    target: "parent-1",
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
    ...overrides,
  };
}

function renderMessage(message: Message, sessionId?: string) {
  return render(
    <TelemetryProvider>
      <RenderScenarioProvider view="chat">
        <TelemetryPath_App>
          <TelemetryPath_Chat>
            <TelemetryPath_Messages>
              <TelemetryPath_Message>
                <ChatMessage message={message} sessionId={sessionId} />
              </TelemetryPath_Message>
            </TelemetryPath_Messages>
          </TelemetryPath_Chat>
        </TelemetryPath_App>
      </RenderScenarioProvider>
    </TelemetryProvider>,
  );
}

describe("ChatMessage timestamps", () => {
  it("shows timestamp on user message", () => {
    render(<ChatMessage message={makeMessage()} />);
    expect(screen.getByTestId("message-timestamp")).toBeInTheDocument();
    expect(screen.getByTestId("message-action-bar")).toBeInTheDocument();
  });

  describe("ChatMessage identities", () => {
    it("renders an attributed goal continuation without exposing its injected prompt", () => {
      renderMessage(
        makeMessage({
          content: "Private internal continuation instructions",
          goalContinuation: true,
          goalTimelineEvent: {
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
          },
        }),
      );

      expect(screen.getByTestId("timeline-boundary")).toBeInTheDocument();
      expect(screen.getByText("Goal continuation 2")).toBeInTheDocument();
      expect(screen.getByText("· Handled by Research helper")).toBeInTheDocument();
      expect(
        screen.queryByText("Private internal continuation instructions"),
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId("message-user")).not.toBeInTheDocument();
    });

    it("renders legacy goal continuations with generic assistant attribution", () => {
      renderMessage(
        makeMessage({
          content: "Private internal continuation instructions",
          goalContinuation: true,
        }),
      );

      expect(screen.getByTestId("timeline-boundary")).toBeInTheDocument();
      expect(screen.getByText("Goal continuation")).toBeInTheDocument();
    });

    it("renders a user-role delivery from a subagent with the subagent identity", async () => {
      const agentMessage = makeAgentMessage();
      const message = makeMessage({
        content: "Message from subagent Research helper (subagent-1):\n\nFinal handoff",
        agentMessage,
      });

      renderMessage(message);

      expect(screen.getByTestId("timeline-boundary")).toBeInTheDocument();
      expect(screen.getByText("Subagent handoff")).toBeInTheDocument();
      expect(screen.getByText("· From Research helper")).toBeInTheDocument();
      expect(await screen.findByTestId("timeline-boundary-detail")).toHaveTextContent(
        "Final handoff",
      );
      expect(screen.queryByText(/Message from subagent Research helper/)).not.toBeInTheDocument();
      expect(screen.queryByTestId("message-user")).not.toBeInTheDocument();
      expect(message.agentMessage).toBe(agentMessage);
    });

    it("renders a named workflow-agent boundary", () => {
      renderMessage(
        makeMessage({
          content: "Workflow result",
          agentMessage: makeAgentMessage({
            source: "workflow-1",
            sourceLabel: "Verifier",
            sourceSessionSource: "workflow-agent",
          }),
        }),
      );

      expect(screen.getByText("· From Verifier")).toBeInTheDocument();
    });

    it("renders system messages as system events instead of assistant messages", () => {
      renderMessage(makeMessage({ role: "system", content: "Session restarted" }));

      expect(screen.getByTestId("message-system")).toBeInTheDocument();
      expect(screen.getByText("System")).toBeInTheDocument();
      expect(screen.queryByTestId("message-assistant")).not.toBeInTheDocument();
    });
  });

  it("shows timestamp on assistant message", () => {
    render(<ChatMessage message={makeMessage({ role: "assistant", content: "Hi there" })} />);
    expect(screen.getByTestId("message-timestamp")).toBeInTheDocument();
  });

  it("assistant message has a left-aligned action bar", () => {
    render(<ChatMessage message={makeMessage({ role: "assistant", content: "Hi" })} />);
    const bar = screen.getByTestId("message-action-bar");
    expect(bar).toBeInTheDocument();
    expect(bar.className).toContain("justify-start");
  });

  it("user message action bar is right-aligned", () => {
    render(<ChatMessage message={makeMessage()} />);
    const bar = screen.getByTestId("message-action-bar");
    expect(bar.className).toContain("justify-end");
  });

  it("keeps timestamp visible while copy button is hover-only", () => {
    render(<ChatMessage message={makeMessage()} />);
    const bar = screen.getByTestId("message-action-bar");
    expect(bar.className).not.toContain("opacity-0");
    expect(screen.getByTestId("copy-message-btn").parentElement?.className).toContain(
      "group-hover:opacity-100",
    );
  });

  it("always shows the copy button in mobile view, without hover-gating", () => {
    installMatchMedia(true);
    render(<ChatMessage message={makeMessage()} />);
    expect(screen.getByTestId("copy-message-btn").parentElement?.className).not.toContain(
      "opacity-0",
    );
  });

  it("has dateTime attribute for accessibility", () => {
    const date = new Date("2026-04-18T20:35:00");
    render(<ChatMessage message={makeMessage({ timestamp: date })} />);
    const timestamp = screen.getByTestId("message-timestamp");
    expect(timestamp).toHaveAttribute("dateTime", date.toISOString());
  });

  it("timestamp is keyboard-focusable", () => {
    render(<ChatMessage message={makeMessage()} />);
    const timestamp = screen.getByTestId("message-timestamp");
    expect(timestamp).toHaveAttribute("tabIndex", "0");
  });

  it("does not render timestamp or action bar for invalid date", () => {
    render(<ChatMessage message={makeMessage({ timestamp: new Date("invalid") })} />);
    expect(screen.queryByTestId("message-timestamp")).not.toBeInTheDocument();
    expect(screen.queryByTestId("message-action-bar")).not.toBeInTheDocument();
  });
});

describe("ChatMessage copy button", () => {
  it("shows copy button on user message action bar", () => {
    render(<ChatMessage message={makeMessage()} />);
    const bar = screen.getByTestId("message-action-bar");
    expect(within(bar).getByTestId("copy-message-btn")).toBeInTheDocument();
  });

  it("copy button has accessible label", () => {
    render(<ChatMessage message={makeMessage()} />);
    const btn = screen.getByTestId("copy-message-btn");
    expect(btn).toHaveAttribute("aria-label", "Copy message");
  });

  it("copy button uses muted foreground color", () => {
    render(<ChatMessage message={makeMessage()} />);
    const btn = screen.getByTestId("copy-message-btn");
    expect(btn.className).toContain("text-muted-foreground");
  });

  it("shows copy button on assistant message action bar", () => {
    render(<ChatMessage message={makeMessage({ role: "assistant", content: "Hi" })} />);
    const bar = screen.getByTestId("message-action-bar");
    expect(within(bar).getByTestId("copy-message-btn")).toBeInTheDocument();
  });

  it("copies user-visible content without hidden context markers", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(
      <ChatMessage
        message={makeMessage({ content: "**Alice** <!--ctx:mailto:alice@example.com-->" })}
      />,
    );

    await user.click(screen.getByTestId("copy-message-btn"));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("**Alice**");
    });
  });

  it("renders subagent detail without mutating the stored transport envelope", () => {
    const message = makeMessage({
      content: "Message from subagent Research helper (subagent-1):\n\nFinal handoff",
      agentMessage: makeAgentMessage(),
    });
    renderMessage(message);

    expect(screen.getByTestId("timeline-boundary-detail")).toHaveTextContent("Final handoff");
    expect(screen.queryByText(/Message from subagent Research helper/)).not.toBeInTheDocument();
    expect(message.content).toBe(
      "Message from subagent Research helper (subagent-1):\n\nFinal handoff",
    );
  });
});

describe("ChatMessage tool details", () => {
  it("expands committed tool input and output", async () => {
    const user = userEvent.setup();
    renderMessage({
      ...makeMessage(),
      role: "assistant",
      content: "Done",
      toolCalls: [
        {
          id: "tool-1",
          name: "read_file",
          description: "Read package.json",
          input: '{\n  "path": "package.json"\n}',
          output: "file contents",
          success: true,
        },
      ],
    });

    await user.click(screen.getByTestId("committed-tool-calls-toggle"));
    await user.click(screen.getByTestId("committed-tool-call-toggle"));

    expect(screen.getByText("Input")).toBeInTheDocument();
    expect(screen.getByTestId("tool-detail-input")).toHaveTextContent("package.json");
    expect(screen.getByText("Output")).toBeInTheDocument();
    expect(screen.getByTestId("tool-detail-output")).toHaveTextContent("file contents");
  });

  it("uses saved PowerShell input description for generic committed tool rows", async () => {
    const user = userEvent.setup();
    renderMessage({
      ...makeMessage(),
      role: "assistant",
      content: "Done",
      toolCalls: [
        {
          id: "tool-1",
          name: "powershell",
          description: "Running powershell",
          input: JSON.stringify({
            command: "git status --porcelain=v1",
            description: "List worktree changes",
          }),
          output: "",
          success: true,
        },
      ],
    });

    await user.click(screen.getByTestId("committed-tool-calls-toggle"));

    expect(screen.getAllByText("Ran git status --porcelain=v1").length).toBeGreaterThan(0);
    expect(screen.queryByText("Running powershell")).not.toBeInTheDocument();
  });

  it("fetches summarized tool details only after the row is expanded", async () => {
    const user = userEvent.setup();
    vi.mocked(window.sessionsAPI.getToolCallDetails).mockResolvedValue({
      success: true,
      toolCall: {
        id: "tool-1",
        name: "listSubagents",
        description: "Running list subagents",
        output: "lazy subagent details",
        success: true,
      },
    });
    renderMessage(
      {
        ...makeMessage(),
        role: "assistant",
        content: "Done",
        toolCalls: [
          {
            id: "tool-1",
            name: "listSubagents",
            description: "Running list subagents",
            success: true,
            detailsAvailable: true,
          },
        ],
      },
      "session-1",
    );

    expect(window.sessionsAPI.getToolCallDetails).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("committed-tool-calls-toggle"));
    expect(screen.getByText("List subagents")).toBeInTheDocument();
    expect(screen.getByTestId("committed-tool-call-toggle")).toHaveAccessibleName(
      "Show technical details for List subagents, tool listSubagents, Done",
    );
    expect(window.sessionsAPI.getToolCallDetails).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("committed-tool-call-toggle"));

    await waitFor(() =>
      expect(window.sessionsAPI.getToolCallDetails).toHaveBeenCalledWith("session-1", "m1", 0),
    );
    expect(await screen.findByTestId("tool-detail-output")).toHaveTextContent(
      "lazy subagent details",
    );
  });

  it("dismisses a committed failed tool notice", async () => {
    const user = userEvent.setup();
    renderMessage({
      ...makeMessage(),
      role: "assistant",
      content: "I could not finish that step.",
      toolCalls: [
        {
          id: "tool-failed",
          name: "shell",
          description: "Run tests",
          error: "Command failed",
          success: false,
        },
      ],
    });

    await user.click(screen.getByTestId("committed-tool-calls-toggle"));
    await user.click(screen.getByRole("button", { name: "Dismiss tool error" }));

    expect(screen.queryByText("Run tests")).not.toBeInTheDocument();
    expect(screen.queryByTestId("committed-tool-calls")).not.toBeInTheDocument();
  });

  it("keeps identical failed tools in different messages independently dismissible", async () => {
    const user = userEvent.setup();

    function ToolNoticePair() {
      const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
      const failedTool = {
        name: "shell",
        description: "Run tests",
        error: "Command failed",
        success: false,
      };
      return (
        <>
          <ChatMessage
            message={makeMessage({
              id: "message-1",
              role: "assistant",
              content: "First attempt",
              toolCalls: [failedTool],
            })}
            sessionId="session-1"
            dismissedToolNoticeKeys={dismissed}
            onToolNoticeDismiss={(key) => setDismissed((current) => new Set(current).add(key))}
          />
          <ChatMessage
            message={makeMessage({
              id: "message-2",
              role: "assistant",
              content: "Second attempt",
              toolCalls: [failedTool],
            })}
            sessionId="session-1"
            dismissedToolNoticeKeys={dismissed}
            onToolNoticeDismiss={(key) => setDismissed((current) => new Set(current).add(key))}
          />
        </>
      );
    }

    render(<ToolNoticePair />);
    const toggles = screen.getAllByTestId("committed-tool-calls-toggle");
    await user.click(toggles[0]);
    await user.click(toggles[1]);
    expect(screen.getAllByText("Run tests")).toHaveLength(2);

    await user.click(screen.getAllByRole("button", { name: "Dismiss tool error" })[0]);

    expect(screen.getAllByText("Run tests")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Dismiss tool error" })).toHaveLength(1);
  });
});

describe("ordered assistant content blocks", () => {
  const blocks: NonNullable<Message["contentBlocks"]> = [
    { id: "text-1", type: "text", content: "First update" },
    { id: "reasoning-1", type: "reasoning", text: "Checking", durationSeconds: 1 },
    {
      id: "tools-1",
      type: "tools",
      toolCalls: [
        {
          id: "tool-1",
          name: "shell",
          description: "Run tests",
          success: true,
        },
      ],
    },
    { id: "text-2", type: "text", content: "Second update" },
  ];

  it("renders every committed stream in chronological order", () => {
    renderMessage(
      makeMessage({
        role: "assistant",
        content: "First updateSecond update",
        contentBlocks: blocks,
      }),
    );

    const ordered = [
      screen.getAllByTestId("message-text-block")[0],
      screen.getByTestId("message-reasoning-block"),
      screen.getByTestId("message-tools-block"),
      screen.getAllByTestId("message-text-block")[1],
    ];
    ordered.slice(0, -1).forEach((element, index) => {
      expect(element.compareDocumentPosition(ordered[index + 1])).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });
    expect(screen.getAllByTestId("message-text").map((node) => node.textContent)).toEqual([
      "First update",
      "Second update",
    ]);
  });

  it("renders every live stream in chronological order", () => {
    render(
      <StreamingMessage
        streamingContent="First updateSecond update"
        toolStatuses={[]}
        reasoning={{ content: "Checking", duration: 1 }}
        contentBlocks={blocks}
      />,
    );

    const ordered = [
      screen.getAllByTestId("message-text-block")[0],
      screen.getByTestId("message-reasoning-block"),
      screen.getByTestId("message-tools-block"),
      screen.getAllByTestId("message-text-block")[1],
    ];
    ordered.slice(0, -1).forEach((element, index) => {
      expect(element.compareDocumentPosition(ordered[index + 1])).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });
  });
});

describe("StreamingMessage", () => {
  it("shows a working spinner while waiting with no visible content", () => {
    render(
      <StreamingMessage
        streamingContent=""
        toolStatuses={[]}
        reasoning={{ content: "", duration: null }}
      />,
    );
    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(screen.getByTestId("working-spinner")).toHaveClass("animate-spin");
  });

  it("keeps a live tool error dismissed while allowing a distinct error", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <StreamingMessage
        streamingContent=""
        toolStatuses={[
          {
            id: "tool-1",
            description: "Run tests",
            running: false,
            success: false,
            error: "Tests failed",
          },
        ]}
        reasoning={{ content: "", duration: null }}
      />,
    );

    await user.click(screen.getByTestId("tool-status-toggle"));
    await user.click(screen.getByRole("button", { name: "Dismiss tool error" }));
    expect(screen.queryByText("Run tests")).not.toBeInTheDocument();

    rerender(
      <StreamingMessage
        streamingContent=""
        toolStatuses={[
          {
            id: "tool-1",
            description: "Run tests",
            running: false,
            success: false,
            error: "Tests failed",
          },
        ]}
        reasoning={{ content: "", duration: null }}
      />,
    );
    expect(screen.queryByText("Run tests")).not.toBeInTheDocument();

    rerender(
      <StreamingMessage
        streamingContent=""
        toolStatuses={[
          {
            id: "tool-2",
            description: "Build app",
            running: false,
            success: false,
            error: "Build failed",
          },
        ]}
        reasoning={{ content: "", duration: null }}
      />,
    );
    expect(screen.getByText("Build app")).toBeInTheDocument();
  });
});

describe("ChatMessage markdown rendering", () => {
  it("renders markdown in user messages instead of raw syntax", async () => {
    renderMessage({
      ...makeMessage(),
      role: "user",
      content: "hello **Shweta Vaidya** world",
    });
    const bubble = await screen.findByTestId("message-text");
    expect(bubble.textContent).not.toContain("**");
    expect(bubble.textContent).toContain("Shweta Vaidya");
  });

  it("renders a GFM table in user messages", async () => {
    const tableMarkdown = [
      "| Name | Role |",
      "|------|------|",
      "| an upstream reviewer | ENG (SDE2) |",
      "| Jakob Werner | Principal ENG (Mgr) |",
    ].join("\n");
    renderMessage({
      ...makeMessage(),
      role: "user",
      content: tableMarkdown,
    });
    const bubble = await screen.findByTestId("message-text");
    expect(within(bubble).getByRole("table")).toBeInTheDocument();
    expect(bubble.textContent).not.toContain("|");
    expect(within(bubble).getByText("an upstream reviewer")).toBeInTheDocument();
  });
});
