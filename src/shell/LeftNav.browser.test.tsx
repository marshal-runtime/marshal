/**
 * Browser-level drag-to-popout coverage.
 *
 * Renders the real LeftNav (not a synthetic harness) so the test exercises
 * the same component tree the user drags from in production: session row →
 * useSessionDragOut hook → onOpenSessionInNewWindow prop. Runs in the browser
 * vitest project so HTML5 DnD events flow through real Chromium.
 */
import { act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { installMockAPIs, render, screen } from "@/test-utils";
import type { SessionsAPI } from "@/types/electron";

import { LeftNav } from "./LeftNav";

const SESSION = {
  id: "s1",
  name: "Test session",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  hasUnread: false,
  isActive: false,
};

const defaultProps = {
  activeView: "chat" as const,
  onViewChange: vi.fn<(view: string) => void>(),
  onNewChat: vi.fn<() => void>(),
  activeSessionId: "s1",
  onSessionSelect: vi.fn<(id: string) => void>(),
  onDeleteSession: vi.fn<(id: string) => void>(),
};

/**
 * Real Chromium's DragEvent constructor rejects plain objects for
 * `dataTransfer`, so we build a plain Event and attach the properties the
 * production code reads. React's synthetic event proxies through to these.
 */
function fireDragEvent(
  el: Element,
  type: "dragstart" | "drag" | "dragend",
  init: {
    clientX: number;
    clientY: number;
    screenX?: number;
    screenY?: number;
    dropEffect?: "move" | "none";
  },
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: {
      value: {
        setDragImage: () => {},
        setData: () => {},
        getData: () => "",
        effectAllowed: "move",
        dropEffect: init.dropEffect ?? "move",
      },
    },
    clientX: { value: init.clientX },
    clientY: { value: init.clientY },
    screenX: { value: init.screenX ?? init.clientX },
    screenY: { value: init.screenY ?? init.clientY },
  });
  el.dispatchEvent(event);
}

/**
 * The test renderer doesn't apply enough layout to give the nav its real
 * height, so getBoundingClientRect would return a zero-height rect and the
 * vertical-band check inside the hook would reject every drop. Stub the rect
 * to a realistic viewport-sized region so the geometry checks behave as in
 * production.
 */
async function stubNavGeometry() {
  const nav = await screen.findByRole("navigation", { name: "Main navigation" });
  const rect: DOMRect = new DOMRect(0, 0, 256, 720);
  nav.getBoundingClientRect = () => rect;
}

describe("LeftNav drag-to-popout (browser)", () => {
  beforeEach(() => {
    installMockAPIs();
    window.sessionsAPI.list = vi.fn<SessionsAPI["list"]>().mockResolvedValue({
      success: true,
      sessions: [SESSION],
    });
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn<() => void>(),
        removeListener: vi.fn<() => void>(),
        addEventListener: vi.fn<() => void>(),
        removeEventListener: vi.fn<() => void>(),
        dispatchEvent: vi.fn<() => boolean>(),
      }),
    });
  });

  it("opens a new window with bounds when the drop lands past the nav's right edge", async () => {
    const onOpen = vi.fn<(id: string, bounds?: { x: number; y: number }) => void>();
    render(<LeftNav {...defaultProps} onOpenSessionInNewWindow={onOpen} />);
    await stubNavGeometry();
    const row = await screen.findByTestId("session-item");

    fireDragEvent(row, "dragstart", { clientX: 50, clientY: 200 });
    fireDragEvent(row, "dragend", {
      clientX: 600,
      clientY: 200,
      screenX: 1200,
      screenY: 600,
    });

    expect(onOpen).toHaveBeenCalledWith("s1", { x: 1200, y: 600 });
  });

  it("does not open a new window when ESC cancels the drag", async () => {
    // Production reality: when the user presses ESC, Chromium fires a
    // keydown event (which the hook listens for) and then fires dragend
    // with dropEffect="none". The hook gates on the keydown, not the
    // dropEffect — dropping outside the window also produces
    // dropEffect="none" but is a valid drop.
    const onOpen = vi.fn<(id: string) => void>();
    render(<LeftNav {...defaultProps} onOpenSessionInNewWindow={onOpen} />);
    await stubNavGeometry();
    const row = await screen.findByTestId("session-item");

    // act() flushes React state + effects between events. In production the
    // user can't press ESC faster than React commits, but synthetic events
    // dispatched back-to-back here would land before the useEffect attaches
    // its keydown listener.
    await act(async () => {
      fireDragEvent(row, "dragstart", { clientX: 50, clientY: 200 });
    });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    fireDragEvent(row, "dragend", {
      clientX: 600,
      clientY: 200,
      screenX: 1200,
      screenY: 600,
      dropEffect: "none",
    });

    expect(onOpen).not.toHaveBeenCalled();
  });

  it("does not open a new window when the drop is released inside the nav", async () => {
    const onOpen = vi.fn<(id: string) => void>();
    render(<LeftNav {...defaultProps} onOpenSessionInNewWindow={onOpen} />);
    await stubNavGeometry();
    const row = await screen.findByTestId("session-item");

    fireDragEvent(row, "dragstart", { clientX: 50, clientY: 200 });
    fireDragEvent(row, "dragend", { clientX: 60, clientY: 200 });

    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens a new window when dropping outside the app (un-maximised window)", async () => {
    // Production reality: when the user releases the mouse outside the app,
    // nothing in the DOM accepts the drop, so dragend fires with
    // dropEffect="none" — same as ESC, but ESC ALSO fires a keydown first.
    // No keydown = valid drop, open the popout.
    const onOpen = vi.fn<(id: string, bounds?: { x: number; y: number }) => void>();
    render(<LeftNav {...defaultProps} onOpenSessionInNewWindow={onOpen} />);
    await stubNavGeometry();
    const row = await screen.findByTestId("session-item");

    fireDragEvent(row, "dragstart", { clientX: 50, clientY: 200 });
    fireDragEvent(row, "dragend", {
      clientX: 99999,
      clientY: 200,
      screenX: 2400,
      screenY: 600,
      dropEffect: "none", // no in-app drop target accepted the drop
    });

    expect(onOpen).toHaveBeenCalledWith("s1", { x: 2400, y: 600 });
  });

  it("document-level dragend tears down the pill if the source element vanishes mid-drag", async () => {
    // Load-bearing safety net for the "source detached mid-drag" case (e.g.
    // the session is deleted while the user is still holding it). The React
    // onDragEnd can't fire — the element is gone — so the hook also listens
    // for dragend at the document level. Without this listener, the floating
    // pill would leak in document.body. The keydown / native-dragend listener
    // attach is gated on `isDragging`; this test pins both the attach and the
    // teardown path.
    const onOpen = vi.fn<(id: string, bounds?: { x: number; y: number }) => void>();
    render(<LeftNav {...defaultProps} onOpenSessionInNewWindow={onOpen} />);
    await stubNavGeometry();
    const row = await screen.findByTestId("session-item");

    // act() so the useEffect that attaches the document listeners runs
    // before we dispatch the document-level dragend.
    await act(async () => {
      fireDragEvent(row, "dragstart", { clientX: 50, clientY: 200 });
    });
    // The pill is a portal sibling of the row, both showing the session name,
    // so two matches during drag is the visible signature of "pill attached".
    expect(screen.getAllByText("Test session")).toHaveLength(2);

    // Wrap in act() — resetDragState calls setIsDragging(false)/setPillPos(null),
    // and the assertion below needs the unmount commit to land first.
    await act(async () => {
      document.dispatchEvent(new Event("dragend", { bubbles: true, cancelable: true }));
    });

    // After the document fallback fires, only the row remains.
    expect(screen.getAllByText("Test session")).toHaveLength(1);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
