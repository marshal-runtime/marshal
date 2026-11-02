import { act, render, screen } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatPanelWithActivity } from "./ChatPanelWithActivity";

const panelLifecycle = vi.hoisted(() => ({
  mounts: 0,
  unmounts: 0,
  width: 1000,
  resize: undefined as ((width: number) => void) | undefined,
}));
vi.mock("@/shared/hooks/useResizablePanel", () => ({
  useElementSize: () => ({ width: panelLifecycle.width, height: 800 }),
}));

vi.mock("@/features/runtime-ui/RuntimeUiBottomPanel", () => ({
  RuntimeUiBottomPanelLayout: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("./ChatPanel", () => ({
  ChatPanel: ({ runtimeUiInline }: { runtimeUiInline?: ReactNode }) => (
    <div data-testid="chat-panel-stub">{runtimeUiInline}</div>
  ),
}));

vi.mock("@/features/create/SessionActivityPanel", () => ({
  SessionActivityPanel: ({
    layout,
    onLayoutWidthChange,
  }: {
    layout: string;
    onLayoutWidthChange: (width: number) => void;
  }) => {
    panelLifecycle.resize = onLayoutWidthChange;
    useEffect(() => {
      panelLifecycle.mounts += 1;
      return () => {
        panelLifecycle.unmounts += 1;
      };
    }, []);
    return <div data-testid="activity-panel-stub" data-layout={layout} />;
  },
}));

describe("ChatPanelWithActivity", () => {
  beforeEach(() => {
    panelLifecycle.mounts = 0;
    panelLifecycle.unmounts = 0;
    panelLifecycle.width = 1000;
  });

  it("reserves panel width on narrow windows and reallocates space on resize", () => {
    const view = render(<ChatPanelWithActivity sessionId="session-1" />);
    const rail = screen.getByTestId("chat-panel-activity-rail");
    expect(screen.getByTestId("activity-panel-stub")).toHaveAttribute("data-layout", "rail");
    expect(rail).toHaveStyle({ width: "392px" });
    act(() => panelLifecycle.resize?.(520));
    expect(rail).toHaveStyle({ width: "520px" });
    act(() => panelLifecycle.resize?.(280));
    expect(rail).toHaveStyle({ width: "280px" });
    act(() => panelLifecycle.resize?.(0));
    expect(rail).toHaveStyle({ width: "0px" });
    act(() => panelLifecycle.resize?.(900));
    expect(rail).toHaveStyle({ width: "640px" });
    panelLifecycle.width = 500;
    view.rerender(<ChatPanelWithActivity sessionId="session-1" />);
    expect(rail).toHaveStyle({ width: "300px" });
    expect(panelLifecycle.mounts).toBe(1);
    expect(panelLifecycle.unmounts).toBe(0);
  });

  it("integrates runtime inline and secondary panel slots without replacing chat activity", () => {
    render(
      <ChatPanelWithActivity
        sessionId="session-1"
        runtimeUiInline={<div data-testid="runtime-inline-stub" />}
        secondaryPanel={<aside data-testid="runtime-secondary-panel-stub" />}
      />,
    );

    expect(screen.getByTestId("runtime-inline-stub")).toBeInTheDocument();
    expect(screen.getByTestId("runtime-secondary-panel-stub")).toBeInTheDocument();
    expect(screen.getByTestId("activity-panel-stub")).toBeInTheDocument();
  });
});
