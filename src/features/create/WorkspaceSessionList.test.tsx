import { describe, expect, it, beforeEach, vi } from "vitest";

import { installMockAPIs, render, screen, waitFor } from "@/test-utils";
import type { SessionsAPI, StoredSession } from "@/types/electron";

import { WorkspaceSessionList } from "./WorkspaceSessionList";

function session(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: "session-1",
    name: "Workspace chat",
    createdAt: "2026-06-08T10:00:00.000Z",
    updatedAt: "2026-06-08T10:10:00.000Z",
    hasUnread: false,
    isActive: true,
    source: "workspace",
    messages: [],
    ...overrides,
  };
}

describe("WorkspaceSessionList", () => {
  beforeEach(() => {
    installMockAPIs();
  });

  it("renders the active workspace session with a derived message preview", async () => {
    window.sessionsAPI.get = vi.fn<SessionsAPI["get"]>().mockResolvedValue({
      success: true,
      session: session({
        messages: [
          {
            id: "user-1",
            role: "user",
            content: "Please summarize the proposal",
            timestamp: "2026-06-08T10:01:00.000Z",
          },
          {
            id: "assistant-1",
            role: "assistant",
            content: "  Proposal summary\nis ready  ",
            timestamp: "2026-06-08T10:02:00.000Z",
          },
        ],
      }),
      isBusy: true,
    });

    render(
      <WorkspaceSessionList
        sessionIds={["session-1"]}
        activeSessionId="session-1"
        onSwitch={vi.fn<(id: string) => void>()}
        onNew={vi.fn<() => void>()}
        onDelete={vi.fn<(id: string) => void>()}
      />,
    );

    expect(await screen.findByText("Workspace chat")).toBeInTheDocument();
    expect(screen.getByText("Proposal summary is ready")).toBeInTheDocument();
    await waitFor(() =>
      expect(window.sessionsAPI.get).toHaveBeenCalledWith("session-1", { messageLimit: 1 }),
    );
  });

  it("does not render a preview for sessions without user or assistant messages", async () => {
    window.sessionsAPI.get = vi.fn<SessionsAPI["get"]>().mockResolvedValue({
      success: true,
      session: session({
        messages: [
          {
            id: "system-1",
            role: "system",
            content: "system prompt",
            timestamp: "2026-06-08T10:01:00.000Z",
          },
        ],
      }),
    });

    render(
      <WorkspaceSessionList
        sessionIds={["session-1"]}
        activeSessionId="session-1"
        onSwitch={vi.fn<(id: string) => void>()}
        onNew={vi.fn<() => void>()}
        onDelete={vi.fn<(id: string) => void>()}
      />,
    );

    expect(await screen.findByText("Workspace chat")).toBeInTheDocument();
    expect(screen.queryByTestId("session-preview")).not.toBeInTheDocument();
  });
});
