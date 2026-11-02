/**
 * PopoutApp reuses the mainline `Header` component (with
 * `HeaderWindowControls`) so popout chats share titlebar UI with the main
 * window. These tests pin that contract:
 *  - the shared Header is rendered
 *  - sidebar/chat/navigation toggles are hidden (popouts have none of those)
 *  - the locked ChatPanel receives the URL-derived sessionId
 *  - the popout doesn't mutate the main window's "active session"
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs, render, screen, waitFor, act } from "@/test-utils";

import { _resetWindowFocusState } from "./hooks/useWindowFocused";

// ChatPanel is heavyweight (Monaco, mention parsers, etc.) — replace with a
// minimal probe that exposes the sessionId prop so we can assert on it.
vi.mock("./features/chat", () => ({
  ChatPanel: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="chat-panel" data-session-id={sessionId} />
  ),
  ChatPanelWithActivity: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="chat-panel" data-session-id={sessionId} />
  ),
}));

// Toaster pulls in sonner styles we don't need for these tests.
vi.mock("./components/ui/sonner", () => ({
  Toaster: () => null,
}));

// Theme application uses CSS variables and document side effects we don't care
// about here. Stub it so the effect resolves without touching the DOM.
vi.mock("./app-theme", () => ({
  applyTheme: vi.fn<(theme: string) => void>(),
}));

import { PopoutApp } from "./PopoutApp";

describe("PopoutApp (popout chat windows)", () => {
  beforeEach(() => {
    installMockAPIs();
    window.platform = "win32";
    _resetWindowFocusState();
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.documentElement.removeAttribute("data-window-inactive");
  });

  it("reuses the mainline Header (drag region + app title) so popout chrome matches the main window", async () => {
    vi.mocked(window.sessionsAPI.get).mockResolvedValue({ success: false });
    render(<PopoutApp sessionId="session-abc" />);
    expect(await screen.findByText(/Marshal/)).toBeInTheDocument();
    expect(screen.queryByText(/Powered by/)).not.toBeInTheDocument();
  });

  it("shows the session name as the Header subtitle once sessionsAPI.get resolves", async () => {
    vi.mocked(window.sessionsAPI.get).mockResolvedValue({
      success: true,
      session: {
        id: "session-1",
        name: "My Chat",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [],
        hasUnread: false,
        isActive: false,
      },
    });
    render(<PopoutApp sessionId="session-1" />);
    expect(await screen.findByText(/My Chat/)).toBeInTheDocument();
  });

  it("updates the title when onMetadataChanged fires for this session", async () => {
    // Capture the metadata callback so we can fire renames synthetically.
    let metadataCb: ((sessionId: string) => void) | undefined;
    vi.mocked(window.sessionsAPI.onMetadataChanged).mockImplementation((cb) => {
      metadataCb = cb;
      return () => {};
    });

    // Reset the shared queryClient cache so this test isn't tainted by a prior
    // test that populated ["session-name", ...] with a different value.
    const { queryClient } = await import("./services/query/query-client");
    queryClient.clear();

    let currentName = "Original";
    vi.mocked(window.sessionsAPI.get).mockImplementation(() =>
      Promise.resolve({
        success: true,
        session: {
          id: "session-rename",
          name: currentName,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: [],
          hasUnread: false,
          isActive: false,
        },
      }),
    );

    render(<PopoutApp sessionId="session-rename" />);
    expect(await screen.findByText(/Original/)).toBeInTheDocument();

    expect(metadataCb).toBeDefined();
    currentName = "Renamed";
    await act(async () => {
      metadataCb!("session-rename");
    });
    expect(await screen.findByText(/Renamed/)).toBeInTheDocument();
  });

  it("ignores onMetadataChanged events for other sessions", async () => {
    let metadataCb: ((sessionId: string) => void) | undefined;
    vi.mocked(window.sessionsAPI.onMetadataChanged).mockImplementation((cb) => {
      metadataCb = cb;
      return () => {};
    });

    const { queryClient } = await import("./services/query/query-client");
    queryClient.clear();

    const get = vi.mocked(window.sessionsAPI.get).mockResolvedValue({
      success: true,
      session: {
        id: "session-isolate",
        name: "Mine",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [],
        hasUnread: false,
        isActive: false,
      },
    });

    render(<PopoutApp sessionId="session-isolate" />);
    expect(await screen.findByText(/Mine/)).toBeInTheDocument();

    const beforeCallCount = get.mock.calls.length;
    await act(async () => {
      metadataCb!("session-OTHER");
    });
    // No additional get() call — the filter rejected the unrelated id.
    expect(get.mock.calls.length).toBe(beforeCallCount);
    expect(screen.getByText(/Mine/)).toBeInTheDocument();
  });

  it("renders custom window controls (minimize / maximize / close) inside the shared Header on Windows", async () => {
    render(<PopoutApp sessionId="session-1" />);
    expect(await screen.findByRole("group", { name: "Window controls" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Minimize window" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Maximize window" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close window" })).toBeInTheDocument();
  });

  it("does not render the sidebar / chat / navigation toggles (popouts have none of those panels)", async () => {
    render(<PopoutApp sessionId="session-1" />);
    await screen.findByText(/Marshal/);
    expect(screen.queryByRole("button", { name: /sidebar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Show chat|Hide chat/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Go to previous page/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Go to next page/ })).not.toBeInTheDocument();
  });

  it("renders ChatPanel locked to the sessionId from the URL", async () => {
    render(<PopoutApp sessionId="session-from-url" />);
    const panel = await screen.findByTestId("chat-panel");
    expect(panel).toHaveAttribute("data-session-id", "session-from-url");
  });

  it("never calls sessionsAPI.switch (popouts must not move the main window's active session)", async () => {
    render(<PopoutApp sessionId="session-1" />);
    await screen.findByTestId("chat-panel");
    // Visibility filtering keys off the main window's active session, so the
    // popout deliberately leaves it untouched.
    expect(window.sessionsAPI?.switch).not.toHaveBeenCalled();
  });

  it("marks the chat area as vibrancy-opaque so it gets a solid background on macOS", async () => {
    render(<PopoutApp sessionId="session-1" />);
    const panel = await screen.findByTestId("chat-panel");
    // The chat content wrapper (parent of ChatPanel) must have data-vibrancy-opaque
    // so the CSS rule [data-vibrancy] [data-vibrancy-opaque] applies an opaque
    // background, matching the main window's <main> element.
    expect(panel.closest("[data-vibrancy-opaque]")).not.toBeNull();
  });

  it("sets data-window-inactive on <html> and data-window-ready on wrapper after focus+blur cycle", async () => {
    render(<PopoutApp sessionId="session-1" />);
    const panel = await screen.findByTestId("chat-panel");
    const wrapper = panel.closest("[data-app-root]");

    // Before any focus/blur cycle, data-window-ready should not be set
    expect(wrapper?.hasAttribute("data-window-ready")).toBe(false);

    // useWindowFocused stays inert until it has seen at least one focus+blur
    // cycle. Wrap dispatches in act() so React processes the state change.
    await act(() => window.dispatchEvent(new Event("focus")));
    await act(() => window.dispatchEvent(new Event("blur")));

    await waitFor(() => {
      expect(document.documentElement.hasAttribute("data-window-inactive")).toBe(true);
    });
    // After the first blur, data-window-ready gates the CSS transition
    expect(wrapper?.hasAttribute("data-window-ready")).toBe(true);

    await act(() => window.dispatchEvent(new Event("focus")));

    await waitFor(() => {
      expect(document.documentElement.hasAttribute("data-window-inactive")).toBe(false);
    });
  });

  it("re-applies theme on settings:changed (runtime theme switching from main window)", async () => {
    // Initial theme is applied synchronously in `src/main.tsx` from
    // localStorage; PopoutApp's only theme job is to re-apply when the main
    // window broadcasts a settings change (its imperative `applyTheme` call
    // can't reach a separate renderer process).
    const { applyTheme } = await import("./app-theme");
    const onChanged = vi.fn<(cb: () => void) => () => void>(() => () => {});
    const fakeGet = vi.fn<() => Promise<{ success: true; settings: { theme: string } }>>(() =>
      Promise.resolve({ success: true, settings: { theme: "dark" } }),
    );
    // Override the test-util mocks for this test only.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing the shared mock for this test
    const api = window.settingsAPI as unknown as {
      onChanged: typeof onChanged;
      get: typeof fakeGet;
    };
    api.onChanged = onChanged;
    api.get = fakeGet;

    render(<PopoutApp sessionId="session-1" />);
    await screen.findByTestId("chat-panel");

    expect(onChanged).toHaveBeenCalled();
    // Multiple components register onChanged listeners; fire all of them so
    // the assertion below isn't sensitive to registration order.
    for (const [cb] of onChanged.mock.calls) cb();
    await waitFor(() => {
      expect(applyTheme).toHaveBeenCalledWith("dark");
    });
  });
});
