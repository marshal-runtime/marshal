import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { HotkeysRoot } from "@/features/hotkeys";
import { renderHook } from "@/test-utils";
import type { SessionMetadata } from "@/types/electron";

import { useChatNavigationHotkeys } from "./useChatNavigationHotkeys";

function session(id: string, source: SessionMetadata["source"] = "user"): SessionMetadata {
  return {
    id,
    name: id,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    hasUnread: false,
    isActive: false,
    source,
  };
}

function createHotkeyProps(options: Partial<Parameters<typeof useChatNavigationHotkeys>[0]> = {}) {
  return {
    sessions: [session("a"), session("b"), session("c")],
    activeSessionId: "a",
    handleNewChat: vi.fn<() => void>(),
    handleSessionSelect: vi.fn<(sessionId: string) => void>(),
    handleSessionRename: vi.fn<(sessionId: string) => void>(),
    renameEnabled: true,
    enabled: true,
    ...options,
  } satisfies Parameters<typeof useChatNavigationHotkeys>[0];
}

function setupHotkeys(options: Partial<Parameters<typeof useChatNavigationHotkeys>[0]> = {}) {
  const props = createHotkeyProps(options);
  renderHook(() => useChatNavigationHotkeys(props), { wrapper: HotkeysRoot });
  return props;
}

function dispatchCtrlTab(
  options: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    code: "Tab",
    bubbles: true,
    cancelable: true,
    ctrlKey: options.ctrl ?? true,
    metaKey: options.meta ?? false,
    shiftKey: options.shift ?? false,
  });
  document.dispatchEvent(event);
  return event;
}

function dispatchF2(
  options: {
    alt?: boolean;
    ctrl?: boolean;
    meta?: boolean;
    shift?: boolean;
    isComposing?: boolean;
  } = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "F2",
    code: "F2",
    bubbles: true,
    cancelable: true,
    altKey: options.alt ?? false,
    ctrlKey: options.ctrl ?? false,
    metaKey: options.meta ?? false,
    shiftKey: options.shift ?? false,
    isComposing: options.isComposing ?? false,
  });
  document.dispatchEvent(event);
  return event;
}

describe("useChatNavigationHotkeys", () => {
  it("Mod+T calls handleNewChat", async () => {
    const user = userEvent.setup();
    const props = setupHotkeys();

    await user.keyboard("{Control>}t{/Control}");

    expect(props.handleNewChat).toHaveBeenCalledOnce();
  });

  it("Ctrl+Tab selects the next normal chat and wraps", () => {
    const props = setupHotkeys({ activeSessionId: "c" });

    dispatchCtrlTab();

    expect(props.handleSessionSelect).toHaveBeenCalledWith("a");
  });

  it("Ctrl+Shift+Tab selects the previous normal chat and wraps", () => {
    const props = setupHotkeys({ activeSessionId: "a" });

    dispatchCtrlTab({ shift: true });

    expect(props.handleSessionSelect).toHaveBeenCalledWith("c");
  });

  it("Meta+Tab does not select another chat", () => {
    const props = setupHotkeys({ activeSessionId: "a" });

    dispatchCtrlTab({ ctrl: false, meta: true });

    expect(props.handleSessionSelect).not.toHaveBeenCalled();
  });

  it("F2 starts renaming the active session", () => {
    const props = setupHotkeys({ activeSessionId: "b" });

    const event = dispatchF2();

    expect(props.handleSessionRename).toHaveBeenCalledWith("b");
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not handle F2 without a selected session", () => {
    const props = setupHotkeys({ activeSessionId: null });

    const event = dispatchF2();

    expect(props.handleSessionRename).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it.each(["workspace", "workflow-run"] as const)(
    "does not handle F2 for %s sessions",
    (source) => {
      const props = setupHotkeys({
        sessions: [session("special", source)],
        activeSessionId: "special",
      });

      const event = dispatchF2();

      expect(props.handleSessionRename).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    },
  );

  it("does not handle F2 when current-session rename is disabled", () => {
    const props = setupHotkeys({ renameEnabled: false });

    const event = dispatchF2();

    expect(props.handleSessionRename).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("does not handle modified or composing F2 events", () => {
    const props = setupHotkeys();

    const modifiedEvent = dispatchF2({ alt: true });
    const composingEvent = dispatchF2({ isComposing: true });

    expect(props.handleSessionRename).not.toHaveBeenCalled();
    expect(modifiedEvent.defaultPrevented).toBe(false);
    expect(composingEvent.defaultPrevented).toBe(false);
  });

  it.each(["input", "textarea"] as const)("suppresses F2 from %s fields", (tag) => {
    const props = setupHotkeys();
    const element = document.createElement(tag);
    document.body.append(element);

    try {
      element.focus();
      dispatchF2();
    } finally {
      element.remove();
    }

    expect(props.handleSessionRename).not.toHaveBeenCalled();
  });

  it("suppresses F2 from contenteditable editors", () => {
    const props = setupHotkeys();
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.tabIndex = -1;
    document.body.append(editor);

    try {
      editor.focus();
      dispatchF2();
    } finally {
      editor.remove();
    }

    expect(props.handleSessionRename).not.toHaveBeenCalled();
  });

  it.each([
    { role: "dialog", ariaModal: "true" },
    { role: "menu", state: "open" },
  ])("suppresses F2 while an active $role owns keyboard input", ({ role, ariaModal, state }) => {
    const props = setupHotkeys();
    const overlay = document.createElement("div");
    overlay.setAttribute("role", role);
    if (ariaModal) overlay.setAttribute("aria-modal", ariaModal);
    if (state) overlay.setAttribute("data-state", state);
    document.body.append(overlay);

    try {
      dispatchF2();
    } finally {
      overlay.remove();
    }

    expect(props.handleSessionRename).not.toHaveBeenCalled();
  });

  it("filters workspace sessions while cycling", () => {
    const props = setupHotkeys({
      sessions: [session("a"), session("workspace", "workspace"), session("b")],
      activeSessionId: "a",
    });

    dispatchCtrlTab();

    expect(props.handleSessionSelect).toHaveBeenCalledWith("b");
  });

  it("does not prevent default when fewer than two normal sessions exist", () => {
    const props = setupHotkeys({ sessions: [session("a")], activeSessionId: "a" });

    const event = dispatchCtrlTab();

    expect(props.handleSessionSelect).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("does not prevent default when there is no active session", () => {
    const props = setupHotkeys({ activeSessionId: null });

    const event = dispatchCtrlTab();

    expect(props.handleSessionSelect).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("does not prevent default when the active session is missing", () => {
    const props = setupHotkeys({ activeSessionId: "missing" });

    const event = dispatchCtrlTab();

    expect(props.handleSessionSelect).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it.each(["input", "textarea", "select"] as const)(
    "suppresses shortcuts from %s fields",
    async (tag) => {
      const user = userEvent.setup();
      const props = setupHotkeys();
      const element = document.createElement(tag);
      document.body.append(element);

      try {
        element.focus();
        await user.keyboard("{Control>}t{/Control}");
        dispatchCtrlTab();
      } finally {
        element.remove();
      }

      expect(props.handleNewChat).not.toHaveBeenCalled();
      expect(props.handleSessionSelect).not.toHaveBeenCalled();
    },
  );

  it("allows new-chat and cycle shortcuts from contenteditable editors", async () => {
    const user = userEvent.setup();
    const props = setupHotkeys();
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.tabIndex = -1;
    document.body.append(editor);

    try {
      editor.focus();
      await user.keyboard("{Control>}t{/Control}");
      editor.focus();
      expect(editor).toHaveFocus();
      dispatchCtrlTab();
    } finally {
      editor.remove();
    }

    expect(props.handleNewChat).toHaveBeenCalledOnce();
    expect(props.handleSessionSelect).toHaveBeenCalledWith("b");
  });

  it("stops firing when disabled after registration", async () => {
    const user = userEvent.setup();
    const props = createHotkeyProps();
    const { rerender } = renderHook(
      ({ enabled }) => useChatNavigationHotkeys({ ...props, enabled }),
      {
        initialProps: { enabled: true },
        wrapper: HotkeysRoot,
      },
    );

    rerender({ enabled: false });
    await user.keyboard("{Control>}t{/Control}");
    dispatchCtrlTab();

    expect(props.handleNewChat).not.toHaveBeenCalled();
    expect(props.handleSessionSelect).not.toHaveBeenCalled();
  });
});
