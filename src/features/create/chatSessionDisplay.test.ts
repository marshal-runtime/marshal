import { describe, expect, it } from "vitest";

import type { StoredSession } from "@/types/electron";

import {
  deriveChatSessionPlaceholderText,
  deriveChatSessionSummary,
  getChatSessionPreview,
} from "./chatSessionDisplay";

function session(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: "session-1",
    name: "Design review",
    createdAt: "2026-06-08T10:00:00.000Z",
    updatedAt: "2026-06-08T10:10:00.000Z",
    hasUnread: false,
    isActive: true,
    messages: [],
    ...overrides,
  };
}

describe("chat session display", () => {
  it("derives a compact preview from the last user or assistant message", () => {
    const preview = getChatSessionPreview(
      session({
        messages: [
          {
            id: "system",
            role: "system",
            content: "hidden setup",
            timestamp: "2026-06-08T10:00:00.000Z",
          },
          {
            id: "user",
            role: "user",
            content: "  summarize\n\nthis file  ",
            timestamp: "2026-06-08T10:01:00.000Z",
          },
          {
            id: "assistant",
            role: "assistant",
            content: "  Summary   is ready  ",
            timestamp: "2026-06-08T10:02:00.000Z",
          },
        ],
      }),
    );

    expect(preview).toBe("Summary is ready");
  });

  it("omits previews when there are no visible chat messages", () => {
    expect(
      getChatSessionPreview(
        session({
          messages: [
            {
              id: "system",
              role: "system",
              content: "hidden setup",
              timestamp: "2026-06-08T10:00:00.000Z",
            },
          ],
        }),
      ),
    ).toBeUndefined();
  });

  it("does not use hidden control requests or composer responses as session previews", () => {
    expect(
      getChatSessionPreview(
        session({
          messages: [
            {
              id: "ordinary",
              role: "assistant",
              content: "Visible summary",
              timestamp: "2026-06-08T10:00:00.000Z",
            },
            {
              id: "control",
              role: "user",
              content: "Private continuation prompt",
              timestamp: "2026-06-08T10:01:00.000Z",
              goalContinuation: true,
              internalControl: {
                kind: "goal-continuation",
                exchangeId: "goal-continuation:1",
                side: "request",
              },
            },
            {
              id: "control-result",
              role: "assistant",
              content: 'Based on "You are a continuation-prompt composer..."',
              timestamp: "2026-06-08T10:02:00.000Z",
              internalControl: {
                kind: "goal-continuation-composer",
                exchangeId: "goal-continuation:1",
                side: "response",
              },
            },
            {
              id: "readiness-result",
              role: "assistant",
              content: "Private readiness reply",
              timestamp: "2026-06-08T10:03:00.000Z",
              suppressedAgentStatusResponse: true,
            },
          ],
        }),
      ),
    ).toBe("Visible summary");
  });

  it("uses visible readiness-triggered assistant work as the session preview", () => {
    expect(
      getChatSessionPreview(
        session({
          messages: [
            {
              id: "control",
              role: "user",
              content: "Private readiness prompt",
              timestamp: "2026-06-08T10:01:00.000Z",
              internalControl: {
                kind: "subagent-readiness",
                exchangeId: "subagent-readiness:session-1:test",
                side: "request",
              },
            },
            {
              id: "control-result",
              role: "assistant",
              content: "  Integrated   both validators  ",
              timestamp: "2026-06-08T10:02:00.000Z",
              internalControl: {
                kind: "subagent-readiness",
                exchangeId: "subagent-readiness:session-1:test",
                side: "response",
              },
            },
          ],
        }),
      ),
    ).toBe("Integrated both validators");
  });

  it("derives list summaries without adding persisted fields", () => {
    expect(
      deriveChatSessionSummary(
        session({
          messages: [
            {
              id: "user",
              role: "user",
              content: "What changed?",
              timestamp: "2026-06-08T10:01:00.000Z",
            },
          ],
        }),
        true,
      ),
    ).toEqual({
      id: "session-1",
      name: "Design review",
      updatedAt: "2026-06-08T10:10:00.000Z",
      isBusy: true,
      lastMessage: "What changed?",
    });
  });

  it("uses workspace and named session context for placeholders", () => {
    expect(
      deriveChatSessionPlaceholderText({
        workspaceName: "Design Docs",
        activeSessionName: "Launch plan",
      }),
    ).toEqual({
      welcomeText: "Continue Launch plan in Design Docs",
      inputPlaceholder: "Ask about Launch plan...",
    });
  });

  it("falls back to workspace context for default new chat sessions", () => {
    expect(
      deriveChatSessionPlaceholderText({
        workspaceName: "Design Docs",
        activeSessionName: "New Chat",
      }),
    ).toEqual({
      welcomeText: "Start a workspace chat for Design Docs",
      inputPlaceholder: "Ask about Design Docs...",
    });
  });

  it("uses named session context when workspace context is unavailable", () => {
    expect(
      deriveChatSessionPlaceholderText({
        workspaceName: null,
        activeSessionName: "Research notes",
      }),
    ).toEqual({
      welcomeText: "Continue Research notes",
      inputPlaceholder: "Ask about Research notes...",
    });
  });

  it("uses generic workspace copy when no workspace or session context is available", () => {
    expect(
      deriveChatSessionPlaceholderText({
        workspaceName: null,
        activeSessionName: null,
      }),
    ).toEqual({
      welcomeText: "Start a workspace chat",
      inputPlaceholder: "Ask about this workspace...",
    });
  });
});
