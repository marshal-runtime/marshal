/**
 * Regression coverage for a bug where switching soul used to clear the
 * unsent text in the chat input. The fix wired
 * `migrateDraftToSession` into `useSessionManager.handleSoulChange`
 * so the draft survives the underlying session swap.
 *
 * Lives in the browser project (real Chromium via Playwright) and mounts
 * the REAL `useSessionManager` + REAL `ChatPanel` against mocked IPC. The
 * picker click goes through the real `handleSoulChange`, which
 * deletes/creates via mocked IPC, primes the real React Query cache,
 * calls the real `migrateDraftToSession` (real ChatPanel passthrough →
 * real ChatInput), swaps the real `activeSessionId`, and triggers the
 * real `useSouls` refetch — i.e., it actually reproduces the
 * conditions that caused the bug, including the `selectMutation.onSettled`
 * cache invalidation race that made the e2e variant flaky.
 *
 * A previous iteration of this file used a thin `Harness` that mirrored
 * just the migrate + setSessionId slice of the real handler; that test
 * passed for the wrong reasons (no real mutation/invalidation/refetch
 * chain), per review feedback. This file replaces it.
 */
import { useRef } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { _clearSessionDrafts } from "@/features/chat/components/ChatInput";
import { ChatPanel, type ChatPanelRef } from "@/features/chat/components/ChatPanel";
import { copilotService } from "@/services/copilot";
import { installMockAPIs, render, screen, waitFor, within, userEvent } from "@/test-utils";
import type {
  PermissionCardData,
  SoulAPI,
  SessionsAPI,
  StoredSession,
} from "@/types/electron";

import type { NavigateFn } from "./useNavigation";
import { useSessionManager } from "./useSessionManager";

// --- Module mocks -----------------------------------------------------------

// Mock telemetry context for this focused browser test.
// in the vitest browser environment (duplicate React instances). The real
// telemetry schema module composes these primitives, so mocking the underlying lib
// is enough to satisfy every TelemetryPath_* / InteractiveElementMonitor_*
// re-export upstream.
vi.mock("@/services/telemetry/opensource", () => {
  const passthrough = ({ children }: { children: React.ReactNode }) => children;
  const monitor = ({
    callback,
    children,
  }: {
    callback: () => void;
    children: (cb: () => void, disabled?: boolean) => React.ReactNode;
  }) => children(callback, false);
  const noopHook = () => ({ callback: () => {}, isDisabled: false });
  return {
    TelemetryPath: passthrough,
    InteractiveElementMonitor: monitor,
    NonInteractiveElementMonitor: passthrough,
    RenderErrorMonitor: passthrough,
    SimplePropertyMonitor: passthrough,
    allContentReadyCheckpoint: () => {},
    primaryContentReadyCheckpoint: () => {},
    guid: () => "mock-guid",
    withTelemetryPath: (_c: unknown, Wrapped: React.ComponentType<unknown>) => Wrapped,
    useInteractiveElementMonitor: noopHook,
    useNonInteractiveElementMonitor: noopHook,
    useSimplePropertyMonitor: noopHook,
  };
});

vi.mock("@/services/copilot", () => ({
  copilotService: {
    initialize: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    send: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    abort: vi.fn<() => void>(),
    stop: vi.fn<() => void>(),
    onEvent: vi.fn<(cb: unknown) => () => void>().mockReturnValue(() => {}),
    saveImage: vi.fn<() => Promise<string>>().mockResolvedValue("/tmp/img.png"),
  },
}));

// Permission-card store — useSyncExternalStore needs a real subscribe shape.
const permStoreListeners = new Set<() => void>();
const PERM_EMPTY: PermissionCardData[] = [];
vi.mock("../features/chat/permissions/state/permission-cards-store", () => ({
  permissionCardsStore: {
    subscribe: (cb: () => void) => {
      permStoreListeners.add(cb);
      return () => permStoreListeners.delete(cb);
    },
    getSnapshot: () => PERM_EMPTY,
    fetch: async () => {},
    optimisticUpdate: () => {},
    clear: () => {},
  },
}));

// Markdown rendering pulls in Shiki (heavy ESM); not under test here.
vi.mock("streamdown", () => ({
  Streamdown: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
  defaultRehypePlugins: { raw: () => {}, sanitize: [], harden: [] },
}));
vi.mock("@streamdown/code", () => ({ code: {} }));
vi.mock("@/plugins/streamdown-config", () => ({
  MarkdownRenderer: ({ children }: { children: string }) => (
    <div data-testid="markdown">{children}</div>
  ),
}));

// --- Test setup -------------------------------------------------------------

// Touch the mocked service so import order is deterministic — keeps the
// vitest browser optimizer from re-running the file mid-suite.
void copilotService;

const SOULS_FOR_TEST: Partial<SoulAPI> = {
  list: vi.fn<SoulAPI["list"]>().mockResolvedValue({
    success: true,
    souls: [
      { id: "default", name: "Default", description: "Standard", systemPrompt: "", greeting: "" },
      { id: "operator", name: "Operator", description: "Terse", systemPrompt: "", greeting: "" },
      { id: "analyst", name: "Analyst", description: "Evidence first", systemPrompt: "", greeting: "" },
    ],
  }),
};

function makeSession(id: string, overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id,
    name: id,
    messages: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    hasUnread: false,
    isActive: true,
    ...overrides,
  };
}

/**
 * Mirrors App.tsx's wiring for the slice under test: real `useSessionManager`
 * drives `activeSessionId` and `handleSoulChange`; real `ChatPanel`
 * mounts the editor and the picker. The test harness only adds the bits
 * App.tsx adds outside of session management (navigation, refresh keys),
 * which we mock as no-ops.
 *
 * Soul lives inside the workspace-role dialog, which ChatPanel renders
 * only when `onWorkspaceRoleChange` is also supplied — so omitting it here
 * would leave the soul control unreachable even though App.tsx passes
 * both.
 */
const noopWorkspaceRoleChange = (): Promise<void> => Promise.resolve();

function App() {
  const chatPanelRef = useRef<ChatPanelRef>(null);
  const { activeSessionId, handleSoulChange } = useSessionManager({
    chatPanelRef,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, eslint-plugin-vitest/require-mock-type-parameters -- overloaded function
    navigate: vi.fn() as unknown as NavigateFn & ReturnType<typeof vi.fn>,
  });
  if (!activeSessionId) return null;
  return (
    <ChatPanel
      ref={chatPanelRef}
      sessionId={activeSessionId}
      onSoulChange={handleSoulChange}
      onWorkspaceRoleChange={noopWorkspaceRoleChange}
    />
  );
}

function getEditor(): HTMLElement {
  return screen.getByRole("textbox", { name: "Message" });
}

describe("soul switch preserves draft (browser integration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permStoreListeners.clear();
    _clearSessionDrafts();

    // installMockAPIs gives every window.*API a default; we only override
    // the slice the soul-change lifecycle touches.
    installMockAPIs({ soulAPI: SOULS_FOR_TEST });

    // Seed an "old" session so useSessionManager's init effect picks it up
    // via list() → switch(), setting activeSessionId without going through
    // the create() fallback path.
    window.sessionsAPI.list = vi.fn<SessionsAPI["list"]>().mockResolvedValue({
      success: true,
      sessions: [
        {
          id: "old",
          name: "Old",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          hasUnread: false,
          isActive: true,
        },
      ],
    });
    window.sessionsAPI.switch = vi
      .fn<SessionsAPI["switch"]>()
      .mockResolvedValue({ success: true, session: makeSession("old") });
    // ChatPanel's useQuery for ["session", sessionId] uses get() — return a
    // session shape for whichever id it asks about so both old and new mount
    // cleanly.
    window.sessionsAPI.get = vi.fn<SessionsAPI["get"]>().mockImplementation(async (id: string) => ({
      success: true,
      session: makeSession(id),
    }));
    window.sessionsAPI.create = vi
      .fn<SessionsAPI["create"]>()
      .mockResolvedValue({ success: true, session: makeSession("new") });
    window.sessionsAPI.delete = vi
      .fn<SessionsAPI["delete"]>()
      .mockResolvedValue({ success: true, newActiveId: null });
  });

  /**
   * Soul moved out of the send cluster and into the workspace/role
   * dialog, so a switch is now: open the dialog, open the Soul select,
   * pick. The session swap that follows remounts ChatPanel, which takes the
   * dialog with it — so a second switch has to re-open it.
   */
  async function switchSoul(
    user: ReturnType<typeof userEvent.setup>,
    name: RegExp,
  ): Promise<void> {
    await user.click(screen.getByTestId("workspace-role-trigger"));
    await screen.findByTestId("workspace-role-dialog");
    await user.click(screen.getByTestId("soul-trigger"));
    // Scope to the popup listbox: Radix also renders a visually-hidden native
    // <select> whose <option>s match by role but are inert when clicked.
    const listbox = await screen.findByRole("listbox");
    await user.click(await within(listbox).findByRole("option", { name }));
    await waitFor(() => expect(screen.queryByTestId("workspace-role-dialog")).toBeNull());
  }

  it("preserves typed draft after switching soul", async () => {
    const user = userEvent.setup();
    render(<App />);

    const editor = await screen.findByRole("textbox", { name: "Message" }, { timeout: 10_000 });
    const draft = "draft I want to keep";
    await user.click(editor);
    await user.keyboard(draft);
    await waitFor(() => expect(editor.textContent).toBe(draft));

    // Open the soul picker and pick a non-default soul.
    // This drives the real handleSoulChange → delete → create →
    // migrate → setActiveSessionId chain and the real selectMutation
    // cache invalidation that made the e2e variant flaky.
    await switchSoul(user, /Operator/);

    await waitFor(() => expect(getEditor().textContent).toBe(draft));

    // Sanity: the picker click really did drive the orchestrator, not just
    // a UI-only change.
    expect(window.sessionsAPI.createMain).toHaveBeenCalledWith(undefined, "operator", {
      replaceEmptySessionId: "old",
    });
  });

  it("preserves typed draft across multiple soul switches", async () => {
    // Multi-switch is the case that was flaky in e2e: after switch #1, the
    // selectMutation onSettled invalidates the soul cache AND
    // setActiveSessionId triggers useSouls to refetch for the new
    // id — both refetches re-render the picker mid-click. waitFor +
    // findByRole handle the detach/re-attach window deterministically.
    const user = userEvent.setup();

    // Each createMain() returns a unique id so the second switch operates on a
    // genuinely-new session, exercising the suppress-flag re-arm path.
    let createCount = 0;
    window.sessionsAPI.createMain = vi
      .fn<SessionsAPI["createMain"]>()
      .mockImplementation(async () => {
        createCount++;
        return { success: true, session: makeSession(`new-${createCount}`) };
      });

    render(<App />);

    const editor = await screen.findByRole("textbox", { name: "Message" }, { timeout: 10_000 });
    const draft = "still here after two switches";
    await user.click(editor);
    await user.keyboard(draft);
    await waitFor(() => expect(editor.textContent).toBe(draft));

    // First switch: Default → Operator.
    await switchSoul(user, /Operator/);
    await waitFor(() => expect(getEditor().textContent).toBe(draft));

    // Second switch: Operator → Analyst.
    await switchSoul(user, /Analyst/);
    await waitFor(() => expect(getEditor().textContent).toBe(draft));

    expect(window.sessionsAPI.createMain).toHaveBeenNthCalledWith(1, undefined, "operator", {
      replaceEmptySessionId: "old",
    });
    expect(window.sessionsAPI.createMain).toHaveBeenNthCalledWith(2, undefined, "analyst", {
      replaceEmptySessionId: "new-1",
    });
  });
});
