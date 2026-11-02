import { act, screen, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs, render, userEvent } from "@/test-utils";

import type { AppNotice } from "./appNotice";
import { AppNoticeRailView } from "./AppNoticeRail";

function notice(id: string, overrides: Partial<AppNotice> = {}): AppNotice {
  return {
    id,
    source: "update",
    severity: "info",
    icon: "info",
    title: `${id} title`,
    body: `${id} body`,
    ...overrides,
  };
}

function mockNarrowRail(matches: boolean) {
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(max-width: 639px)" ? matches : false,
    media: query,
    onchange: null,
    addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  }));
}

beforeEach(() => {
  installMockAPIs();
  mockNarrowRail(false);
});

describe("AppNoticeRailView", () => {
  it("renders one physical rail with the highest-priority notice and a more count", () => {
    render(
      <AppNoticeRailView
        notices={[
          notice("info"),
          notice("blocking", { source: "auth", severity: "blocking", icon: "auth" }),
          notice("danger", { source: "mcp", severity: "danger" }),
        ]}
      />,
    );

    expect(screen.getAllByTestId("app-notice-rail")).toHaveLength(1);
    expect(screen.getByText("blocking title")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2 more app notices" })).toHaveTextContent("2 more");
  });

  it("opens an anchored panel listing all notices in priority order", async () => {
    const user = userEvent.setup();
    render(
      <AppNoticeRailView
        notices={[notice("info"), notice("blocking", { source: "auth", severity: "blocking" })]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "1 more app notice" }));
    const panel = screen.getByRole("dialog", { name: "App notices" });
    const items = within(panel).getAllByTestId(/^app-notice-item-/);
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute("data-notice-id", "blocking");
    expect(items[1]).toHaveAttribute("data-notice-id", "info");
  });

  it("returns focus to the more trigger when Escape closes the panel", async () => {
    const user = userEvent.setup();
    render(<AppNoticeRailView notices={[notice("one"), notice("two")]} />);
    const trigger = screen.getByRole("button", { name: "1 more app notice" });

    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "App notices" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });

  it("promotes the next notice when the primary is dismissed", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [showPrimary, setShowPrimary] = useState(true);
      return (
        <AppNoticeRailView
          notices={[
            showPrimary
              ? notice("primary", {
                  source: "encryption-reset",
                  severity: "danger",
                  dismiss: { onDismiss: () => setShowPrimary(false) },
                })
              : null,
            notice("next", { source: "mcp", severity: "action" }),
          ]}
        />
      );
    }

    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Dismiss primary title" }));
    expect(screen.getByText("next title")).toBeInTheDocument();
    expect(screen.getByTestId("app-notice-rail")).toHaveAttribute("data-primary-notice", "next");
  });

  it("invokes only the selected notice action from the all-notices panel", async () => {
    const user = userEvent.setup();
    const firstAction = vi.fn<() => void>();
    const secondAction = vi.fn<() => void>();
    render(
      <AppNoticeRailView
        notices={[
          notice("first", {
            source: "auth",
            severity: "blocking",
            actions: [{ id: "first", label: "First action", onAction: firstAction }],
          }),
          notice("second", {
            source: "mcp",
            severity: "action",
            actions: [{ id: "second", label: "Second action", onAction: secondAction }],
          }),
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "1 more app notice" }));
    const secondItem = screen.getByTestId("app-notice-item-second");
    await user.click(within(secondItem).getByRole("button", { name: "Second action" }));

    expect(secondAction).toHaveBeenCalledOnce();
    expect(firstAction).not.toHaveBeenCalled();
  });

  it("does not render a dismiss control for nondismissible active states", () => {
    render(
      <AppNoticeRailView notices={[notice("download", { severity: "active", icon: "spinner" })]} />,
    );

    expect(screen.queryByRole("button", { name: /Dismiss/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("app-notice-icon")).toHaveClass("motion-reduce:animate-none");
  });

  it("uses assertive live announcements for blocking notices and polite status otherwise", () => {
    const { rerender } = render(
      <AppNoticeRailView notices={[notice("auth", { source: "auth", severity: "blocking" })]} />,
    );
    expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "assertive");

    rerender(<AppNoticeRailView notices={[notice("sync")]} />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });

  it("keeps a narrow rail to icon, title, details trigger, and dismiss control", async () => {
    mockNarrowRail(true);
    const user = userEvent.setup();
    const action = vi.fn<() => void>();
    render(
      <AppNoticeRailView
        notices={[
          notice("narrow", {
            actions: [{ id: "act", label: "Take action", onAction: action }],
            dismiss: { onDismiss: vi.fn<() => void>() },
          }),
        ]}
      />,
    );

    const rail = screen.getByTestId("app-notice-rail");
    expect(rail).toHaveClass("flex-nowrap", "overflow-hidden");
    expect(screen.queryByText("narrow body")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Take action" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show notice details and actions" }));
    expect(screen.getByText("narrow body")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Take action" }));
    expect(action).toHaveBeenCalledOnce();
  });

  it("updates the live region without moving the rail when notices change", () => {
    const { rerender } = render(<AppNoticeRailView notices={[notice("first")]} />);
    const rail = screen.getByTestId("app-notice-rail");

    rerender(<AppNoticeRailView notices={[notice("second")]} />);
    expect(screen.getByTestId("app-notice-rail")).toBe(rail);
    expect(screen.getByRole("status")).toHaveTextContent("second title. second body");
  });

  it("reacts to narrow media-query changes", () => {
    let listener: (() => void) | undefined;
    let matches = false;
    vi.stubGlobal("matchMedia", () => ({
      get matches() {
        return matches;
      },
      media: "(max-width: 639px)",
      onchange: null,
      addEventListener: (_event: string, next: () => void) => {
        listener = next;
      },
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    }));
    render(<AppNoticeRailView notices={[notice("responsive")]} />);
    expect(screen.queryByRole("button", { name: "Show notice details and actions" })).toBeNull();

    act(() => {
      matches = true;
      listener?.();
    });
    expect(
      screen.getByRole("button", { name: "Show notice details and actions" }),
    ).toBeInTheDocument();
  });
});
