import { QueryClient } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  act,
  createMockBackendAPI,
  installMockAPIs,
  render,
  screen,
  userEvent,
  waitFor,
} from "@/test-utils";
import type { BackendAPI, SessionsAPI } from "@/types/electron";

import { ChatInputActions } from "./ChatInputActions";

type ChatInputActionsProps = ComponentProps<typeof ChatInputActions>;

const defaultProps = {
  sessionId: "session-1",
  sdkReady: true,
  isWaiting: false,
  isCancelling: false,
  hasContent: false,
  showTokenCount: false,
  canSubmit: false,
  onSubmit: vi.fn<ChatInputActionsProps["onSubmit"]>(),
  onStop: vi.fn<ChatInputActionsProps["onStop"]>(),
  onSteer: vi.fn<ChatInputActionsProps["onSteer"]>(),
} satisfies ChatInputActionsProps;

async function installCompactionSupport(
  supported: boolean,
  compact = vi.fn<SessionsAPI["compact"]>().mockResolvedValue({ success: true }),
) {
  const capabilities = await createMockBackendAPI().capabilities();
  installMockAPIs({
    backendAPI: {
      capabilities: vi.fn<BackendAPI["capabilities"]>().mockResolvedValue({
        ...capabilities,
        sessionCompaction: supported,
      }),
    },
    sessionsAPI: { compact },
  });
  return compact;
}

describe("ChatInputActions send behavior", () => {
  it("shows the latest input-token count when context capacity is unavailable", async () => {
    await installCompactionSupport(true);
    render(<ChatInputActions {...defaultProps} showTokenCount inputTokens={12_345} />);

    expect(screen.getByText("12K sent")).toHaveAttribute(
      "title",
      "12,345 input tokens sent in the latest turn",
    );
  });

  it("steers immediately when clicked during an active turn", async () => {
    await installCompactionSupport(false);
    const onSteer = vi.fn<ChatInputActionsProps["onSteer"]>();
    const user = userEvent.setup();
    render(<ChatInputActions {...defaultProps} isWaiting hasContent canSubmit onSteer={onSteer} />);

    await user.click(screen.getByRole("button", { name: "Steer now (hold to queue)" }));

    expect(onSteer).toHaveBeenCalledExactlyOnceWith({
      sessionId: "session-1",
      isWaiting: true,
      isCancelling: false,
    });
  });

  it("queues instead when the send button is held", async () => {
    await installCompactionSupport(false);
    const onSubmit = vi.fn<ChatInputActionsProps["onSubmit"]>();
    const onSteer = vi.fn<ChatInputActionsProps["onSteer"]>();
    const user = userEvent.setup();
    render(
      <ChatInputActions
        {...defaultProps}
        isWaiting
        hasContent
        canSubmit
        onSubmit={onSubmit}
        onSteer={onSteer}
      />,
    );
    const button = screen.getByRole("button", { name: "Steer now (hold to queue)" });
    await user.pointer([{ target: button, keys: "[MouseLeft>]" }]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 510));
    });
    await user.pointer([{ target: button, keys: "[/MouseLeft]" }]);

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      sessionId: "session-1",
      isWaiting: true,
      isCancelling: false,
    });
    expect(onSteer).not.toHaveBeenCalled();
  });

  it("does not swallow the next send when queueing unmounts the held button", async () => {
    await installCompactionSupport(false);
    const onSubmit = vi.fn<ChatInputActionsProps["onSubmit"]>();
    const holdingUser = userEvent.setup();
    const { rerender } = render(
      <ChatInputActions {...defaultProps} isWaiting hasContent canSubmit onSubmit={onSubmit} />,
    );

    await holdingUser.pointer([
      {
        target: screen.getByRole("button", { name: "Steer now (hold to queue)" }),
        keys: "[MouseLeft>]",
      },
    ]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 510));
    });
    rerender(<ChatInputActions {...defaultProps} hasContent canSubmit onSubmit={onSubmit} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit).toHaveBeenLastCalledWith({
      sessionId: "session-1",
      isWaiting: false,
      isCancelling: false,
    });
  });

  it("keeps the stop action when the active-turn composer is empty", async () => {
    await installCompactionSupport(false);
    render(<ChatInputActions {...defaultProps} isWaiting />);

    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.queryByTestId("send-btn")).not.toBeInTheDocument();
  });
});

describe("ChatInputActions session compaction", () => {
  it("disables compaction with an unsupported-provider tooltip", async () => {
    await installCompactionSupport(false);
    const user = userEvent.setup();
    render(<ChatInputActions {...defaultProps} />);

    const button = await screen.findByRole("button", { name: "Compact session" });
    expect(button).toBeDisabled();

    await user.hover(screen.getByTestId("compact-session-tooltip-trigger"));
    expect(
      await screen.findByText("Provider does not support session compaction", {
        selector: '[data-slot="tooltip-content"]',
      }),
    ).toBeVisible();
  });

  it("warns before invoking compaction for a supported idle session", async () => {
    const compact = await installCompactionSupport(true);
    const user = userEvent.setup();
    render(<ChatInputActions {...defaultProps} />);

    const button = await screen.findByRole("button", { name: "Compact session" });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(compact).not.toHaveBeenCalled();
    expect(screen.getByText("Compact this session?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Compact$/ }));

    await waitFor(() => expect(compact).toHaveBeenCalledWith("session-1"));
  });

  it("does not compact when the warning is cancelled", async () => {
    const compact = await installCompactionSupport(true);
    const user = userEvent.setup();
    render(<ChatInputActions {...defaultProps} />);

    const button = await screen.findByRole("button", { name: "Compact session" });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(compact).not.toHaveBeenCalled();
    expect(screen.queryByText("Compact this session?")).not.toBeInTheDocument();
  });

  it("keeps pending compaction scoped to the requested session across navigation", async () => {
    type CompactResult = Awaited<ReturnType<SessionsAPI["compact"]>>;
    let resolveSessionA!: (result: CompactResult) => void;
    let resolveSessionB!: (result: CompactResult) => void;
    const sessionAPromise = new Promise<CompactResult>((resolve) => {
      resolveSessionA = resolve;
    });
    const sessionBPromise = new Promise<CompactResult>((resolve) => {
      resolveSessionB = resolve;
    });
    const compact = await installCompactionSupport(
      true,
      vi.fn<SessionsAPI["compact"]>().mockImplementation((sessionId) => {
        if (sessionId === "session-a") return sessionAPromise;
        if (sessionId === "session-b") return sessionBPromise;
        return Promise.resolve({ success: true });
      }),
    );
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const { rerender, unmount } = render(
      <ChatInputActions {...defaultProps} sessionId="session-a" />,
      { queryClient },
    );

    let button = await screen.findByRole("button", { name: "Compact session" });
    await waitFor(() => expect(button).toBeEnabled());
    act(() => {
      button.click();
      button.click();
    });
    await user.click(screen.getByRole("button", { name: /^Compact$/ }));
    await waitFor(() => expect(button).toHaveAttribute("aria-busy", "true"));
    expect(button).toBeDisabled();
    expect(compact).toHaveBeenCalledTimes(1);

    rerender(<ChatInputActions {...defaultProps} sessionId="session-b" />);
    button = screen.getByRole("button", { name: "Compact session" });
    await waitFor(() => expect(button).toBeEnabled());
    expect(button).toHaveAttribute("aria-busy", "false");

    await user.click(button);
    await user.click(screen.getByRole("button", { name: /^Compact$/ }));
    await waitFor(() => expect(button).toHaveAttribute("aria-busy", "true"));
    expect(compact).toHaveBeenNthCalledWith(1, "session-a");
    expect(compact).toHaveBeenNthCalledWith(2, "session-b");

    rerender(<ChatInputActions {...defaultProps} sessionId="session-a" />);
    button = screen.getByRole("button", { name: "Compact session" });
    await waitFor(() => expect(button).toHaveAttribute("aria-busy", "true"));

    await act(async () => {
      resolveSessionA({ success: true });
      await sessionAPromise;
    });
    await waitFor(() => expect(button).toBeEnabled());
    expect(button).toHaveAttribute("aria-busy", "false");

    rerender(<ChatInputActions {...defaultProps} sessionId="session-b" />);
    button = screen.getByRole("button", { name: "Compact session" });
    await waitFor(() => expect(button).toHaveAttribute("aria-busy", "true"));

    unmount();
    render(<ChatInputActions {...defaultProps} sessionId="session-b" />, { queryClient });
    button = await screen.findByRole("button", { name: "Compact session" });
    await waitFor(() => expect(button).toHaveAttribute("aria-busy", "true"));

    await act(async () => {
      resolveSessionB({ success: false, error: "Compaction failed" });
      await sessionBPromise;
    });
    await waitFor(() => expect(button).toBeEnabled());
    expect(button).toHaveAttribute("aria-busy", "false");
  });
});
