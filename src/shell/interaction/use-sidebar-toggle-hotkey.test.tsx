import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { HotkeysRoot } from "@/features/hotkeys";
import { renderHook } from "@/test-utils";

import { useSidebarToggleHotkey } from "./use-sidebar-toggle-hotkey";

function setupHotkey(enabled = true) {
  const toggleSidebar = vi.fn<() => void>();
  renderHook(() => useSidebarToggleHotkey({ toggleSidebar, enabled }), { wrapper: HotkeysRoot });
  return toggleSidebar;
}

describe("useSidebarToggleHotkey", () => {
  it("Mod+B toggles when enabled", async () => {
    const user = userEvent.setup();
    const toggleSidebar = setupHotkey();

    await user.keyboard("{Control>}b{/Control}");

    expect(toggleSidebar).toHaveBeenCalledOnce();
  });

  it("does not toggle while disabled", async () => {
    const user = userEvent.setup();
    const toggleSidebar = setupHotkey(false);

    await user.keyboard("{Control>}b{/Control}");

    expect(toggleSidebar).not.toHaveBeenCalled();
  });

  it.each(["input", "textarea", "select"] as const)("suppresses Mod+B from %s", async (tag) => {
    const user = userEvent.setup();
    const toggleSidebar = setupHotkey();
    const element = document.createElement(tag);
    document.body.append(element);

    try {
      element.focus();
      await user.keyboard("{Control>}b{/Control}");
    } finally {
      element.remove();
    }

    expect(toggleSidebar).not.toHaveBeenCalled();
  });

  it.each(["true", "plaintext-only"] as const)(
    "suppresses Mod+B from contenteditable=%s editors",
    async (contentEditable) => {
      const user = userEvent.setup();
      const toggleSidebar = setupHotkey();
      const editor = document.createElement("div");
      editor.contentEditable = contentEditable;
      editor.tabIndex = -1;
      document.body.append(editor);

      try {
        editor.focus();
        await user.keyboard("{Control>}b{/Control}");
      } finally {
        editor.remove();
      }

      expect(toggleSidebar).not.toHaveBeenCalled();
    },
  );

  it("stops toggling when disabled after registration", async () => {
    const user = userEvent.setup();
    const toggleSidebar = vi.fn<() => void>();
    const { rerender } = renderHook(
      ({ enabled }) => useSidebarToggleHotkey({ toggleSidebar, enabled }),
      {
        initialProps: { enabled: true },
        wrapper: HotkeysRoot,
      },
    );

    rerender({ enabled: false });
    await user.keyboard("{Control>}b{/Control}");

    expect(toggleSidebar).not.toHaveBeenCalled();
  });

  it("does not toggle for shifted or alt variants", async () => {
    const user = userEvent.setup();
    const toggleSidebar = setupHotkey();

    await user.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
    await user.keyboard("{Control>}{Alt>}b{/Alt}{/Control}");

    expect(toggleSidebar).not.toHaveBeenCalled();
  });
});
