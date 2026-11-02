// Marshal-owned module.
import { useHotkeys, type HotkeyCallback } from "@tanstack/react-hotkeys";
import { useCallback } from "react";

interface UseSidebarToggleHotkeyOptions {
  toggleSidebar: () => void;
  enabled: boolean;
}

export function useSidebarToggleHotkey({
  toggleSidebar,
  enabled,
}: UseSidebarToggleHotkeyOptions): void {
  const handleToggle = useCallback<HotkeyCallback>(
    (event) => {
      if (event.altKey || event.shiftKey) return;
      event.preventDefault();
      toggleSidebar();
    },
    [toggleSidebar],
  );

  useHotkeys([{ hotkey: "Mod+B", callback: handleToggle }], {
    enabled,
    ignoreInputs: true,
    preventDefault: false,
    stopPropagation: false,
    target: document,
  });
}
