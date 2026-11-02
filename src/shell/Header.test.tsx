import userEvent from "@testing-library/user-event";
import { beforeEach, describe, it, expect, vi } from "vitest";

import { LayoutProvider } from "@/shared/contexts/marshal-layout-provider";
import {
  createMockWindowControlsAPI,
  installMockAPIs,
  render,
  screen,
  waitFor,
} from "@/test-utils";
import type { AIInvestigatorAPI } from "@/types/electron";

import { Header } from "./Header";
import * as windowStateModule from "./windowing/use-window-state";

function renderHeader(
  props: {
    showChatToggle?: boolean;
    showNavigation?: boolean;
    onGoBack?: () => void;
    onGoForward?: () => void;
    canGoBack?: boolean;
    canGoForward?: boolean;
  } = {},
) {
  return render(
    <LayoutProvider>
      <Header {...props} />
    </LayoutProvider>,
  );
}

describe("Header", () => {
  beforeEach(() => {
    installMockAPIs();
    window.platform = "darwin";
    vi.restoreAllMocks();
  });

  it("renders the app title", () => {
    renderHeader();
    expect(screen.getByText("Marshal Runtime Harness")).toBeInTheDocument();
    expect(screen.queryByText(/Powered by Copilot/)).not.toBeInTheDocument();
  });

  it("middle aligns the app title and app-mode badge", () => {
    window.appModeAPI = { getLatest: () => "dev", onModeChanged: () => () => {} };
    renderHeader();

    const title = screen.getByText("Marshal Runtime Harness");
    const appModeBadge = screen.getByText("DEV");

    expect(title.className).toContain("inline-flex");
    expect(title.className).toContain("items-center");
    expect(title.className).toContain("gap-1");
    expect(appModeBadge.className).not.toMatch(/\bm[lrxy]?-/);
  });

  it("shows DEV badge in title bar when app mode is dev", () => {
    window.appModeAPI = { getLatest: () => "dev", onModeChanged: () => () => {} };
    renderHeader();
    expect(screen.getByText("DEV")).toBeInTheDocument();
  });

  it("does not show a badge in release mode", () => {
    renderHeader();
    expect(screen.queryByText("DEV")).not.toBeInTheDocument();
    expect(screen.queryByText("BETA")).not.toBeInTheDocument();
  });

  it("shows BETA badge when app mode is beta", () => {
    window.appModeAPI = { getLatest: () => "beta", onModeChanged: () => () => {} };
    renderHeader();
    expect(screen.getByText("BETA")).toBeInTheDocument();
    expect(screen.queryByText("DEV")).not.toBeInTheDocument();
  });

  it("renders the subtitle prop when provided", () => {
    render(
      <LayoutProvider>
        <Header subtitle="My Session" />
      </LayoutProvider>,
    );
    expect(screen.getByText(/My Session/)).toBeInTheDocument();
    expect(screen.queryByText(/Powered by Copilot/)).not.toBeInTheDocument();
  });

  it("renders custom window controls on Windows when the preload API is available", async () => {
    const windowControlsAPI = createMockWindowControlsAPI();
    installMockAPIs({ windowControlsAPI });
    window.platform = "win32";

    renderHeader();

    expect(await screen.findByRole("group", { name: "Window controls" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Minimize window" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Maximize window" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close window" })).toBeInTheDocument();
  });

  it("does not render custom window controls on macOS", () => {
    renderHeader();

    expect(screen.queryByRole("button", { name: "Minimize window" })).not.toBeInTheDocument();
  });

  it("calls the preload window-control actions when the custom buttons are pressed", async () => {
    const user = userEvent.setup();
    const windowControlsAPI = createMockWindowControlsAPI();
    installMockAPIs({ windowControlsAPI });
    window.platform = "win32";

    renderHeader();

    await user.click(await screen.findByRole("button", { name: "Minimize window" }));
    await user.click(screen.getByRole("button", { name: "Maximize window" }));
    await user.click(screen.getByRole("button", { name: "Close window" }));

    expect(windowControlsAPI.minimize).toHaveBeenCalledOnce();
    expect(windowControlsAPI.toggleMaximize).toHaveBeenCalledOnce();
    expect(windowControlsAPI.close).toHaveBeenCalledOnce();
  });

  it("always renders the sidebar toggle button", () => {
    renderHeader();
    expect(screen.getByTitle("Hide sidebar")).toBeInTheDocument();
  });

  it("toggles sidebar collapse state on click", async () => {
    const user = userEvent.setup();
    renderHeader();

    expect(screen.getByTitle("Hide sidebar")).toBeInTheDocument();
    await user.click(screen.getByTitle("Hide sidebar"));
    expect(screen.getByTitle("Show sidebar")).toBeInTheDocument();
  });

  it("renders chat toggle button only when showChatToggle is true", () => {
    renderHeader({ showChatToggle: false });
    expect(screen.queryByTitle("Hide chat")).not.toBeInTheDocument();

    renderHeader({ showChatToggle: true });
    expect(screen.getByTitle("Hide chat")).toBeInTheDocument();
  });

  it("updates the maximize button when the main window state changes", async () => {
    const windowControlsAPI = createMockWindowControlsAPI();
    installMockAPIs({ windowControlsAPI });
    window.platform = "win32";

    vi.spyOn(windowStateModule, "useWindowState").mockReturnValue({
      isMaximized: false,
      isFullScreen: false,
    });

    const { rerender } = render(
      <LayoutProvider>
        <Header />
      </LayoutProvider>,
    );

    expect(await screen.findByRole("button", { name: "Maximize window" })).toBeInTheDocument();

    vi.spyOn(windowStateModule, "useWindowState").mockReturnValue({
      isMaximized: true,
      isFullScreen: false,
    });

    rerender(
      <LayoutProvider>
        <Header />
      </LayoutProvider>,
    );

    expect(screen.getByRole("button", { name: "Restore window" })).toBeInTheDocument();
  });

  it("collapses the traffic light spacer when fullscreen is active on macOS", () => {
    window.platform = "darwin";

    vi.spyOn(windowStateModule, "useWindowState").mockReturnValue({
      isMaximized: false,
      isFullScreen: false,
    });

    const { rerender } = render(
      <LayoutProvider>
        <Header />
      </LayoutProvider>,
    );

    const spacer = screen.getByTestId("traffic-light-spacer");
    expect(spacer.className).toContain("w-18");

    vi.spyOn(windowStateModule, "useWindowState").mockReturnValue({
      isMaximized: false,
      isFullScreen: true,
    });

    rerender(
      <LayoutProvider>
        <Header />
      </LayoutProvider>,
    );

    expect(spacer.className).toContain("w-0");

    vi.spyOn(windowStateModule, "useWindowState").mockReturnValue({
      isMaximized: false,
      isFullScreen: false,
    });

    rerender(
      <LayoutProvider>
        <Header />
      </LayoutProvider>,
    );

    expect(spacer.className).toContain("w-18");
  });

  it("renders the AI investigator button when available (ST-I6)", async () => {
    // Default mock has checkAvailability → { success: true, available: true }
    renderHeader();
    expect(await screen.findByTestId("ai-investigator-button")).toBeInTheDocument();
  });

  it("does not render the AI investigator button when unavailable (ST-I6)", async () => {
    installMockAPIs({
      aiInvestigatorAPI: {
        checkAvailability: vi
          .fn<AIInvestigatorAPI["checkAvailability"]>()
          .mockResolvedValue({ success: true, available: false }),
      },
    });
    renderHeader();
    await waitFor(() =>
      expect(screen.queryByTestId("ai-investigator-button")).not.toBeInTheDocument(),
    );
  });

  it("hides back and forward buttons by default", () => {
    renderHeader();
    expect(screen.queryByRole("button", { name: "Go to previous page" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go to next page" })).not.toBeInTheDocument();
  });

  it("renders back and forward buttons when showNavigation is true", () => {
    renderHeader({ showNavigation: true });
    expect(screen.getByRole("button", { name: "Go to previous page" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to next page" })).toBeInTheDocument();
  });

  it("disables back button when canGoBack is false", () => {
    renderHeader({ showNavigation: true, canGoBack: false, canGoForward: true });
    expect(screen.getByRole("button", { name: "Go to previous page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Go to next page" })).toBeEnabled();
  });

  it("disables forward button when canGoForward is false", () => {
    renderHeader({ showNavigation: true, canGoBack: true, canGoForward: false });
    expect(screen.getByRole("button", { name: "Go to previous page" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Go to next page" })).toBeDisabled();
  });

  it("calls onGoBack when back button is clicked", async () => {
    const user = userEvent.setup();
    const onGoBack = vi.fn<() => void>();
    renderHeader({ showNavigation: true, canGoBack: true, onGoBack });

    await user.click(screen.getByRole("button", { name: "Go to previous page" }));

    expect(onGoBack).toHaveBeenCalledOnce();
  });

  it("calls onGoForward when forward button is clicked", async () => {
    const user = userEvent.setup();
    const onGoForward = vi.fn<() => void>();
    renderHeader({ showNavigation: true, canGoForward: true, onGoForward });

    await user.click(screen.getByRole("button", { name: "Go to next page" }));

    expect(onGoForward).toHaveBeenCalledOnce();
  });
});
