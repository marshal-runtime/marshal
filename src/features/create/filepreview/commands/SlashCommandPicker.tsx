import { useEffect, useRef } from "react";

import { Popover, PopoverContent, PopoverAnchor } from "@/components/marshal-ui/marshal-popover";

import type { SlashCommandItem } from "./command-catalog";

interface SlashCommandPickerProps {
  isOpen: boolean;
  items: SlashCommandItem[];
  selectedIndex: number;
  anchorElement: HTMLElement | null;
  onSelect: (item: SlashCommandItem) => void;
  onHover: (index: number) => void;
  onClose: () => void;
}

export function SlashCommandPicker({
  isOpen,
  items,
  selectedIndex,
  anchorElement,
  onSelect,
  onHover,
  onClose,
}: SlashCommandPickerProps) {
  const virtualRef = useRef<HTMLElement>(null!);
  const listRef = useRef<HTMLDivElement>(null);

  // Keep virtualRef in sync with the anchor element
  useEffect(() => {
    if (anchorElement) {
      virtualRef.current = anchorElement;
    }
  }, [anchorElement]);

  // Scroll selected item into view
  useEffect(() => {
    if (!isOpen) return;
    const list = listRef.current;
    if (!list) return;
    const selected = list.querySelector("[data-selected=true]");
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [isOpen, selectedIndex]);

  if (!isOpen || !anchorElement || items.length === 0) return null;

  return (
    <Popover open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <PopoverAnchor virtualRef={virtualRef} />
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={4}
        className="w-64 p-1 shadow-lg"
        onMouseDown={(e) => e.preventDefault()}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div ref={listRef} className="max-h-72 overflow-x-hidden overflow-y-auto">
          {items.map((cmd, i) => (
            <div
              key={cmd.id}
              data-selected={i === selectedIndex}
              onMouseEnter={() => onHover(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onSelect(cmd)}
              className="relative flex cursor-default items-center gap-3 rounded-sm px-3 py-2 text-sm select-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
            >
              <cmd.icon className="size-4 shrink-0 text-muted-foreground" />
              <span>{cmd.label}</span>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
