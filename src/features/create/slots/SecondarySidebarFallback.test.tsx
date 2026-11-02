import type { ReactNode } from "react";
import { describe, expect, it, beforeEach, vi } from "vitest";

import { installMockAPIs, render, screen } from "@/test-utils";
import type { SessionsAPI, StoredSession } from "@/types/electron";

import { SecondarySidebarFallback } from "./SecondarySidebarFallback";

vi.mock("@/features/chat/components/ChatPanel", () => ({
  ChatPanel: ({
    welcomeContent,
    inputPlaceholder,
  }: {
    welcomeContent?: ReactNode;
    inputPlaceholder?: string;
  }) => (
    <div>
      <div data-testid="mock-welcome">{welcomeContent}</div>
      <input aria-label="Message" placeholder={inputPlaceholder} />
    </div>
  ),
}));

vi.mock("../SessionActivityPanel", () => ({
  SessionActivityPanel: () => <div data-testid="mock-session-activity-panel" />,
}));

function session(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: "session-1",
    name: "Launch notes",
    createdAt: "2026-06-08T10:00:00.000Z",
    updatedAt: "2026-06-08T10:10:00.000Z",
    hasUnread: false,
    isActive: true,
    source: "workspace",
    messages: [],
    ...overrides,
  };
}

describe("SecondarySidebarFallback", () => {
  beforeEach(() => {
    installMockAPIs();
  });

  it("uses active workspace and session context for chat placeholders", async () => {
    window.sessionsAPI.get = vi.fn<SessionsAPI["get"]>().mockResolvedValue({
      success: true,
      session: session(),
    });

    render(
      <SecondarySidebarFallback
        sessionIds={["session-1"]}
        sessionId="session-1"
        activeWorkspace="Product Brief"
        chatPanelRef={{ current: null }}
        onSwitch={vi.fn<(id: string) => void>()}
        onNew={vi.fn<() => void>()}
        onDelete={vi.fn<(id: string) => void>()}
      />,
    );

    expect(await screen.findByText("Continue Launch notes in Product Brief")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Ask about Launch notes...")).toBeInTheDocument();
    expect(screen.queryByText("Find information and draft a first outline version")).toBeNull();
    expect(screen.queryByPlaceholderText("Ask anything...")).toBeNull();
  });

  it("falls back to workspace context before session details are available", () => {
    window.sessionsAPI.get = vi.fn<SessionsAPI["get"]>().mockResolvedValue({
      success: false,
      error: "not found",
    });

    render(
      <SecondarySidebarFallback
        sessionIds={["missing-session"]}
        sessionId="missing-session"
        activeWorkspace="Research"
        chatPanelRef={{ current: null }}
        onSwitch={vi.fn<(id: string) => void>()}
        onNew={vi.fn<() => void>()}
        onDelete={vi.fn<(id: string) => void>()}
      />,
    );

    expect(screen.getByText("Start a workspace chat for Research")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Ask about Research...")).toBeInTheDocument();
  });
});
