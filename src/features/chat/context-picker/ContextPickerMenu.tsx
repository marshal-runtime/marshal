import { Tabs as TabsPrimitive } from "radix-ui";
import { useEffect, useMemo, useState } from "react";

import { FileText, Sparkles, User } from "@/components/icons";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/marshal-ui/marshal-popover";
import { Tabs, TabsList } from "@/components/marshal-ui/marshal-tabs";
import { Command, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/marshal-class-names";
import type { ContextEntity, Skill } from "@/types/electron";

import { entityValue } from "../conversation-input/entity-value";
import {
  CONTEXT_PICKER_LISTBOX_ID,
  contextPickerOptionId,
} from "../conversation-input/picker-option-id";
import { useContextPickerTabHotkeys } from "../conversation-input/use-context-picker-tab-hotkeys";
import { CommandResultRow } from "./CommandResultRow";
import { getVisibleTabs, isTabId, type TabId } from "./context-picker-tabs";
import { getContextSourceProvider } from "./context-sources";
import { FileResultRow } from "./results/FileResultRow";
import { PeopleResultRow } from "./results/PeopleResultRow";
import { SkillResultRow } from "./results/SkillResultRow";
import { SkeletonRow } from "./SkeletonRow";
import { commandValue, type SlashCommand } from "./slash-commands";

// Number of skeleton rows shown while loading. Sized to roughly fill the
// fixed 240px (h-60) results region so the picker mounts at its final
// height and doesn't reflow when real results arrive.
const SKELETON_ROW_COUNT = 5;

const TAB_ICONS: Record<TabId, React.ReactNode> = {
  Skills: <Sparkles size={14} />,
  People: <User size={14} />,
  File: <FileText size={14} />,
};

const POSITION_TOLERANCE_PX = 1;

function isPlacementAligned(contentEl: HTMLElement, anchorEl: HTMLElement) {
  const contentRect = contentEl.getBoundingClientRect();
  const anchorRect = anchorEl.getBoundingClientRect();

  return (
    Math.abs(contentRect.left - anchorRect.left) <= POSITION_TOLERANCE_PX &&
    Math.abs(contentRect.right - anchorRect.right) <= POSITION_TOLERANCE_PX &&
    Math.abs(contentRect.width - anchorRect.width) <= POSITION_TOLERANCE_PX &&
    contentRect.bottom <= anchorRect.top + POSITION_TOLERANCE_PX
  );
}

export type ContextPickerCloseReason = "escape" | "outside";

interface ContextPickerMenuProps {
  /**
   * The picker is positioned by Radix Popover relative to this element.
   * The consumer (PickerController via ChatInput) hands in the editor
   * wrapper so the menu floats just above the input. When `null`, the
   * popover positions against the viewport (used in tests).
   */
  anchorEl?: HTMLElement | null;
  /**
   * Flat list of suggestions in 3S rank order. Per-type tabs filter on
   * `entity.type`; ranking within a type is preserved.
   */
  entities: ContextEntity[];
  isLoading: boolean;
  /** Free-form search error from the IPC handler. */
  error?: string | null;
  /** cmdk's controlled value — the highlighted row's stable id. */
  pickerValue: string;
  onPickerValueChange: (value: string) => void;
  activeTab: TabId;
  /**
   * True when the picker was triggered by `/` at column 0.
   * Controls whether the Skills tab is rendered (Joel UX: hide Skills when
   * `/` is pressed mid-prompt).
   */
  isStartSlash: boolean;
  onSelect: (entity: ContextEntity) => void;
  onActiveTabChange: (tab: TabId) => void;
  /**
   * Skills already filtered by `enabled` and the current slash query.
   * Filtering lives in `PickerController` so the rendered list and the
   * keyboard hook can't drift apart.
   */
  filteredSkills?: Skill[];
  slashQuery?: string;
  onSelectSkill?: (skill: Skill) => void;
  /**
   * Built-in slash commands (e.g. `/goal`) matching the current query,
   * rendered at the top of the Skills tab so they're as discoverable as
   * skills. Selection is handled by `onSelectCommand`.
   */
  filteredCommands?: SlashCommand[];
  onSelectCommand?: (command: SlashCommand) => void;
  /**
   * Called when the user dismisses the picker.
   */
  onClose?: (reason: ContextPickerCloseReason) => void;
}

export function ContextPickerMenu({
  anchorEl,
  entities,
  isLoading,
  error = null,
  pickerValue,
  onPickerValueChange,
  activeTab,
  isStartSlash,
  onSelect,
  onActiveTabChange,
  filteredSkills = [],
  slashQuery = "",
  onSelectSkill,
  filteredCommands = [],
  onSelectCommand,
  onClose,
}: ContextPickerMenuProps) {
  // Radix PopoverAnchor accepts a RefObject, not an element directly. Build a
  // plain ref-shaped object from the prop so the first Popover layout pass has
  // the real anchor without mutating a React ref during render.
  const anchorVirtualRef = useMemo(() => (anchorEl ? { current: anchorEl } : null), [anchorEl]);
  const [contentEl, setContentEl] = useState<HTMLDivElement | null>(null);
  const [readyAnchorEl, setReadyAnchorEl] = useState<HTMLElement | null>(null);
  const isPlaced = anchorEl === undefined || (anchorEl !== null && readyAnchorEl === anchorEl);

  useEffect(() => {
    if (!anchorEl || !contentEl) return undefined;

    const updateMobileSpace = () => {
      if (!window.marshalRemote) return;
      const viewportTop = window.visualViewport?.offsetTop ?? 0;
      const height = Math.max(
        0,
        Math.min(280, anchorEl.getBoundingClientRect().top - viewportTop - 64),
      );
      contentEl.style.setProperty("--remote-picker-height", `${height}px`);
      contentEl.style.setProperty("--remote-picker-list-height", `${Math.max(0, height - 46)}px`);
    };
    updateMobileSpace();
    const observer = new ResizeObserver(updateMobileSpace);
    observer.observe(anchorEl);
    observer.observe(document.getElementById("root") ?? document.body);
    window.visualViewport?.addEventListener("resize", updateMobileSpace);
    window.visualViewport?.addEventListener("scroll", updateMobileSpace);

    let frame: number | undefined;
    let cancelled = false;

    const checkPlacement = () => {
      if (cancelled) return;
      if (isPlacementAligned(contentEl, anchorEl)) {
        setReadyAnchorEl(anchorEl);
        return;
      }
      frame = requestAnimationFrame(checkPlacement);
    };

    frame = requestAnimationFrame(checkPlacement);

    return () => {
      cancelled = true;
      observer.disconnect();
      window.visualViewport?.removeEventListener("resize", updateMobileSpace);
      window.visualViewport?.removeEventListener("scroll", updateMobileSpace);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [anchorEl, contentEl]);

  useEffect(() => {
    if (!contentEl || !pickerValue || !isPlaced) return undefined;

    const scrollSelectedItemIntoView = () => {
      contentEl
        .querySelector<HTMLElement>('[cmdk-item][data-selected="true"]')
        ?.scrollIntoView({ block: "nearest" });
    };

    const frame = requestAnimationFrame(scrollSelectedItemIntoView);

    return () => cancelAnimationFrame(frame);
  }, [activeTab, contentEl, isPlaced, pickerValue]);

  const visibleEntities =
    activeTab === "Skills" ? [] : entities.filter((e) => e.type === activeTab);

  const visibleTabs = useMemo(() => getVisibleTabs(isStartSlash), [isStartSlash]);

  const totalItems =
    activeTab === "Skills"
      ? filteredCommands.length + filteredSkills.length
      : visibleEntities.length;

  useContextPickerTabHotkeys(visibleTabs, onActiveTabChange);

  const isSkillsTab = activeTab === "Skills";
  const isEmpty = totalItems === 0;

  // Every empty/error/connect string belongs to the active source, so the menu
  // renders whatever a source says without knowing which backend it is.
  const sourceCopy = getContextSourceProvider(activeTab)?.copy;

  // cmdk paints `data-selected="true"` on the highlighted row and
  // `data-selected="false"` on every other row. We override shadcn's
  // CommandItem default with bg-accent (selected) using `!` so it wins
  // the cascade, plus a CSS :hover for a separate, subtler hover cue
  // (bg-muted). disablePointerSelection on <Command> ensures hover does
  // NOT change cmdk's selection — the two visuals are intentionally
  // independent.
  const rowClass = cn(
    "flex cursor-pointer items-center gap-2.5 rounded-md p-2",
    "hover:bg-muted",
    "data-[selected=true]:bg-accent! data-[selected=true]:text-accent-foreground!",
  );

  if (anchorEl === null) return null;

  return (
    <Popover open>
      {anchorVirtualRef ? <PopoverAnchor virtualRef={anchorVirtualRef} /> : null}
      <PopoverContent
        ref={setContentEl}
        side="top"
        align="start"
        sideOffset={4}
        avoidCollisions={false}
        data-context-picker-menu="true"
        data-testid="context-picker-menu"
        // Keep focus on the Lexical editor — Popover's default focus
        // trap would steal it.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          onClose?.("escape");
        }}
        onInteractOutside={(e) => {
          const target = e.target;
          if (anchorEl && target instanceof Node && anchorEl.contains(target)) {
            e.preventDefault();
            return;
          }
          onClose?.("outside");
        }}
        style={{
          width: anchorEl === undefined ? undefined : "var(--radix-popover-trigger-width)",
          visibility: isPlaced ? undefined : "hidden",
          pointerEvents: isPlaced ? undefined : "none",
        }}
        className="max-h-80 overflow-hidden rounded-lg border border-border bg-popover p-0 shadow-md"
      >
        {/* Tabs — Radix Tabs in controlled, manual-activation mode. Focus is
          pinned on the Lexical editor so Radix's keyboard handlers stay
          inert; we get aria-selected / role / aria-controls scaffolding
          correctness for free. */}
        <Tabs
          value={activeTab}
          onValueChange={(v) => {
            if (isTabId(v)) onActiveTabChange(v);
          }}
          activationMode="manual"
          className="contents"
        >
          {/* Tabs row + divider as a single unit. The divider is the
              TabsList's border-b and visually spans the popover edge to
              edge (PopoverContent has p-0). The TabsList itself uses
              px-2 to gutter the tab buttons; the result list below
              matches that gutter (see CommandList px-2 below) so the
              selected-tab side-spacing equals the divider-to-result
              spacing. */}
          <TabsList className="flex h-auto w-full justify-start gap-1 rounded-none border-b border-border bg-transparent px-2 pt-1.5 pb-0">
            {visibleTabs.map((tab) => (
              <TabsPrimitive.Trigger
                key={tab.id}
                value={tab.id}
                className={cn(
                  "relative -mb-px inline-flex h-auto flex-initial items-center justify-center gap-1 rounded-none border-0 border-b-2 border-b-transparent bg-transparent px-2 py-1.5 text-xs font-normal text-muted-foreground shadow-none transition-colors",
                  "hover:border-b-muted-foreground/40 hover:bg-transparent hover:text-foreground",
                  "data-[state=active]:border-b-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none",
                  "focus-visible:ring-0 focus-visible:outline-none",
                )}
                // D4: Radix Tabs activates inside onMouseDown via composeEventHandlers,
                // which skips its handler when event.defaultPrevented — so we BOTH
                // preventDefault (to keep focus on the editor) AND call
                // onActiveTabChange ourselves.
                onMouseDown={(e) => {
                  if (e.button !== 0 || e.ctrlKey) return;
                  e.preventDefault();
                  onActiveTabChange(tab.id);
                }}
              >
                {TAB_ICONS[tab.id]}
                {tab.label}
              </TabsPrimitive.Trigger>
            ))}
          </TabsList>
        </Tabs>

        {/* Listbox — cmdk Command in controlled, no-filter, no-pointer-selection
          mode. Focus stays on the Lexical editor; cmdk's own keyboard handlers
          never fire (they require focus on the Command root). usePickerKeyboard
          drives selection via `value` / `onValueChange` and clicks go through
          CommandItem.onSelect. cmdk owns: the listbox `role`, `data-selected`
          attribute on highlighted items, and click-to-select. ContextPickerMenu
          provides deterministic ids on the listbox and options for use by
          PickerController's aria-controls/aria-activedescendant. */}
        <Command
          value={pickerValue}
          onValueChange={onPickerValueChange}
          shouldFilter={false}
          disablePointerSelection
          vimBindings={false}
          label="Context picker"
          className="rounded-none bg-transparent p-0"
        >
          {/* Fixed h-60 prevents the menu from growing upward as async
            results arrive (it's anchored bottom-full).

            pt-0 + first-row p-2 (top) = 8px from divider to first row
            text content — matches TabsList's px-2 = 8px gutter so the
            selected-tab side spacing equals the divider-to-result spacing.

            Wrap items in a `key={activeTab}` div so a tab change
            categorically unmounts the previous tab's rows. Defensive
            belt-and-suspenders against React reconciliation edge cases
            and cmdk's internal item-registry retaining items across
            tab switches — symptoms include visual row-stacking ("File
            tab shows People rows on top, then File rows below"). */}
          <CommandList id={CONTEXT_PICKER_LISTBOX_ID} className="h-60 max-h-60 px-2 pt-0 pb-2">
            <div key={activeTab}>
              {!isSkillsTab && error && isEmpty && (
                <div className="flex h-full items-center justify-center px-3 text-center text-sm text-muted-foreground">
                  {sourceCopy?.error}
                </div>
              )}

              {!isSkillsTab && !error && isLoading && isEmpty && (
                <div aria-live="polite" aria-busy="true">
                  <span className="sr-only">Searching...</span>
                  {Array.from({ length: SKELETON_ROW_COUNT }, (_, i) => (
                    <SkeletonRow key={i} />
                  ))}
                </div>
              )}

              {!isSkillsTab && !error && !isLoading && isEmpty && (
                <div className="flex h-full items-center justify-center px-3 text-center text-sm text-muted-foreground">
                  {slashQuery ? sourceCopy?.noMatch(slashQuery) : sourceCopy?.empty}
                </div>
              )}

              {isSkillsTab && isEmpty && (
                <div className="flex h-full items-center justify-center px-3 text-center text-sm text-muted-foreground">
                  {sourceCopy?.empty}
                </div>
              )}

              {isSkillsTab &&
                filteredSkills.map((skill) => (
                  <CommandItem
                    key={skill.id}
                    id={contextPickerOptionId(skill.id)}
                    value={skill.id}
                    onSelect={() => onSelectSkill?.(skill)}
                    className={rowClass}
                  >
                    <SkillResultRow skill={skill} />
                  </CommandItem>
                ))}

              {isSkillsTab &&
                filteredCommands.map((command) => {
                  const value = commandValue(command);
                  return (
                    <CommandItem
                      key={value}
                      id={contextPickerOptionId(value)}
                      value={value}
                      onSelect={() => onSelectCommand?.(command)}
                      className={rowClass}
                    >
                      <CommandResultRow command={command} />
                    </CommandItem>
                  );
                })}

              {!isSkillsTab &&
                visibleEntities.map((entity) => {
                  const value = entityValue(entity);
                  switch (entity.type) {
                    case "People":
                      return (
                        <CommandItem
                          key={value}
                          id={contextPickerOptionId(value)}
                          value={value}
                          onSelect={() => onSelect(entity)}
                          className={rowClass}
                        >
                          <PeopleResultRow entity={entity} />
                        </CommandItem>
                      );
                    case "File":
                      return (
                        <CommandItem
                          key={value}
                          id={contextPickerOptionId(value)}
                          value={value}
                          onSelect={() => onSelect(entity)}
                          className={rowClass}
                        >
                          <FileResultRow entity={entity} />
                        </CommandItem>
                      );
                    default: {
                      const _exhaustive: never = entity;
                      return _exhaustive;
                    }
                  }
                })}
            </div>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
