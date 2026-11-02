import { formatForDisplay } from "@tanstack/react-hotkeys";

import { KbdGroup, renderShortcutKeys } from "@/components/marshal-ui/kbd";

interface ShortcutKbdProps {
  hotkey: string;
}

export function ShortcutKbd({ hotkey }: ShortcutKbdProps) {
  const display = formatForDisplay(hotkey);
  return <KbdGroup aria-label={display}>{renderShortcutKeys(display)}</KbdGroup>;
}
