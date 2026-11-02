import { RUNTIME_UI_PLACEMENT } from "@common/runtime-ui";
import {
  useCallback,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { useRuntimeUiPlacement } from "@/features/runtime-ui";
import type { ContextEntity, Skill } from "@/types/electron";

import { entityValue } from "../conversation-input/entity-value";
import {
  CONTEXT_PICKER_LISTBOX_ID,
  contextPickerOptionId,
} from "../conversation-input/picker-option-id";
import {
  usePickerKeyboard,
  type PickerVisibleItem,
} from "../conversation-input/use-picker-keyboard";
import type { InputEditorHandle } from "../editor/InputEditor";
import type { ContextChipEntity } from "../editor/nodes/context-chip";
import { getVisibleTabs, type TabId } from "./context-picker-tabs";
import { ContextPickerMenu, type ContextPickerCloseReason } from "./ContextPickerMenu";
import {
  commandValue,
  filterCommandsByQuery,
  mergeSlashCommands,
  slashCommandFromPlacement,
  SLASH_COMMANDS,
  type SlashCommand,
} from "./slash-commands";
import {
  useInteractiveElementMonitor_ContextPickerSelectEntity,
  useInteractiveElementMonitor_ContextPickerSwitchTab,
} from "./telemetry/context-picker-telemetry-hooks";
import { useContextPicker } from "./useChatContextPicker";
import { useContextSearch } from "./useContextSearch";

/** Adapt the IPC-side `ContextEntity` to the chip-side `ContextChipEntity`. */
function entityToChipEntity(entity: ContextEntity): ContextChipEntity {
  switch (entity.type) {
    case "People":
      return {
        type: "People",
        id: entity.id,
        referenceId: entity.referenceId,
        displayName: entity.displayName,
        email: entity.email,
      };
    case "File":
      return {
        type: "File",
        id: entity.id,
        referenceId: entity.referenceId,
        title: entity.title,
        accessUrl: entity.accessUrl,
        extension: entity.fileExtension,
      };
    default: {
      const _exhaustive: never = entity;
      return _exhaustive;
    }
  }
}

interface PickerControllerRenderProps {
  activate: (tab?: TabId) => void;
  handleKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => boolean;
  menu: ReactNode;
  onPickerKeyIntercept: (key: "Enter" | "Tab" | "Escape" | "ArrowUp" | "ArrowDown") => boolean;
  pickerActive: boolean;
  /**
   * Callback ref. Attach to the editor wrapper element. Radix Popover
   * uses this as the positioning anchor for the picker menu (and exposes
   * its width via the --radix-popover-trigger-width CSS variable so the
   * menu can match).
   */
  setAnchorEl: (el: HTMLElement | null) => void;
  /** cmdk-owned id of the listbox element (auto-generated). */
  pickerListboxId: string | undefined;
  /** cmdk-owned id of the currently highlighted option, if any. */
  pickerActiveDescendantId: string | undefined;
}

interface PickerControllerProps {
  input: string;
  editorRef: RefObject<InputEditorHandle | null>;
  skills: Skill[];
  setInputAndEditor: (text: string) => void;
  workspaceName?: string;
  onPickLocalFile?: (filePath: string) => void;
  children: (props: PickerControllerRenderProps) => ReactNode;
}

export function PickerController({
  input,
  editorRef,
  skills,
  setInputAndEditor,
  workspaceName,
  onPickLocalFile,
  children,
}: PickerControllerProps) {
  const pickEntity = useCallback(
    (entity: ContextEntity, triggerLength: number) => {
      if (entity.type === "File" && entity.localPath) onPickLocalFile?.(entity.localPath);
      editorRef.current?.insertChipAtCaret(entityToChipEntity(entity), triggerLength);
      editorRef.current?.focus();
    },
    [editorRef, onPickLocalFile],
  );
  const contextPicker = useContextPicker({
    value: input,
    onPickEntity: pickEntity,
  });

  const {
    handleClose: closeContextPicker,
    handleSelect: selectContextEntity,
    setActiveTab: setContextPickerActiveTab,
    triggerLength,
  } = contextPicker;

  const closeAndReset = useCallback(
    (valueAfterClose: string) => {
      closeContextPicker(valueAfterClose);
    },
    [closeContextPicker],
  );

  const visibleTabIds = useMemo(
    () => getVisibleTabs(contextPicker.isStartSlash).map((t) => t.id),
    [contextPicker.isStartSlash],
  );

  const closeAndStripTrigger = useCallback(() => {
    let nextValue = input;
    if (triggerLength > 0) {
      nextValue = input.slice(0, input.length - triggerLength);
      setInputAndEditor(nextValue);
    }
    closeAndReset(nextValue);
    editorRef.current?.focus();
  }, [closeAndReset, editorRef, input, setInputAndEditor, triggerLength]);

  const handleMenuClose = useCallback(
    (reason: ContextPickerCloseReason) => {
      if (reason === "escape") {
        closeAndStripTrigger();
        return;
      }
      closeAndReset(input);
    },
    [closeAndReset, closeAndStripTrigger, input],
  );

  const selectSkill = useCallback(
    (skill: Skill) => {
      // Pass the post-insert plain-text value so dismissal suppression tracks
      // the pillified buffer rather than the slash trigger.
      editorRef.current?.setSkill(skill.name, skill.id);
      const next = `/${skill.name} `;
      closeAndReset(next);
      editorRef.current?.focus();
    },
    [closeAndReset, editorRef],
  );

  const selectCommand = useCallback(
    (command: SlashCommand) => {
      // Built-in commands aren't pills — fill the editor with `/<name> ` so the
      // user types the argument (e.g. the goal objective) and submits. The
      // trailing space ends the slash trigger, so the picker closes cleanly and
      // ChatInput's `/goal` submit interception takes over.
      const next = `/${command.name} `;
      setInputAndEditor(next);
      closeAndReset(next);
      editorRef.current?.focus();
    },
    [closeAndReset, editorRef, setInputAndEditor],
  );

  const {
    entities: contextEntities,
    isLoading: contextSearchLoading,
    error: contextSearchError,
  } = useContextSearch({
    // The typed text after the trigger slash is the entity-search query.
    // When it's empty (user just typed `/`), the IPC's isZeroQuery branch
    // returns recommended people/files/events. The Skills tab doesn't use
    // this hook (it filters skills locally), so no special-case needed for
    // start-slash here.
    query: contextPicker.query,
    workspaceName,
    entityTypes: contextPicker.activeTab === "Skills" ? undefined : [contextPicker.activeTab],
    // When opened with `/`, default to Skills tab. But once the user
    // switches to another tab (People/Files/Events/All), still run the
    // entity search so those tabs aren't blank.
    enabled:
      contextPicker.active && (!contextPicker.isStartSlash || contextPicker.activeTab !== "Skills"),
  });

  const selectEntityCallback = useCallback(
    (entity: ContextEntity) => {
      selectContextEntity(entity);
    },
    [selectContextEntity],
  );
  const getSelectEntityMisc = useCallback(
    (entity: ContextEntity) => ({
      entityType: entity.type,
      tab: contextPicker.activeTab,
      // Index is computed from the ranked entity list for telemetry parity
      // with the pre-cmdk implementation. Not used for selection.
      index: contextEntities.findIndex(
        (e) => e.type === entity.type && e.referenceId === entity.referenceId,
      ),
      count: contextEntities.length,
    }),
    [contextEntities, contextPicker.activeTab],
  );
  const selectEntityMonitorProps = useMemo(
    () => ({
      callback: selectEntityCallback,
      hasContent: contextPicker.active,
      getMisc: getSelectEntityMisc,
    }),
    [contextPicker.active, getSelectEntityMisc, selectEntityCallback],
  );
  const selectEntity = useInteractiveElementMonitor_ContextPickerSelectEntity<
    [ContextEntity],
    void,
    ContextEntity["type"] | TabId
  >(selectEntityMonitorProps);

  const switchTabCallback = useCallback(
    (tab: TabId) => {
      setContextPickerActiveTab(tab);
    },
    [setContextPickerActiveTab],
  );
  const getSwitchTabMisc = useCallback((tab: TabId) => ({ tab }), []);
  const switchTabMonitorProps = useMemo(
    () => ({
      callback: switchTabCallback,
      hasContent: contextPicker.active,
      getMisc: getSwitchTabMisc,
    }),
    [contextPicker.active, getSwitchTabMisc, switchTabCallback],
  );
  const switchTab = useInteractiveElementMonitor_ContextPickerSwitchTab<[TabId], void, TabId>(
    switchTabMonitorProps,
  );

  // Filter skills once here and pass the result to both the menu and the
  // keyboard hook — keeping the visible list and the selectable list in
  // lockstep so Enter/Tab can never insert a different skill from what's
  // highlighted.
  const filteredSkills = useMemo(
    () =>
      skills.filter(
        (skill) =>
          skill.enabled && skill.name.toLowerCase().includes(contextPicker.query.toLowerCase()),
      ),
    [skills, contextPicker.query],
  );

  const slashPlacement = useRuntimeUiPlacement(RUNTIME_UI_PLACEMENT.CHAT_SLASH_COMMAND);
  const slashCommands = useMemo(
    () =>
      mergeSlashCommands(
        SLASH_COMMANDS,
        slashPlacement.applications.map(slashCommandFromPlacement),
      ),
    [slashPlacement.applications],
  );
  const filteredCommands = useMemo(
    () => filterCommandsByQuery(contextPicker.query, slashCommands),
    [contextPicker.query, slashCommands],
  );

  // Build the visible-items list for usePickerKeyboard. cmdk renders the
  // same logical list, indexed by the same `value` string — so what the
  // keyboard hook commits on Enter / Tab is exactly what cmdk highlights.
  const skillVisibleItems = useMemo<PickerVisibleItem[]>(
    () =>
      filteredSkills.map((skill) => ({
        id: skill.id,
        commit: () => selectSkill(skill),
      })),
    [filteredSkills, selectSkill],
  );
  // Command rows render below skills in the menu, so they must trail the
  // keyboard-navigable list too (order must match the rendered order).
  const commandVisibleItems = useMemo<PickerVisibleItem[]>(
    () =>
      filteredCommands.map((command) => ({
        id: commandValue(command),
        commit: () => selectCommand(command),
      })),
    [filteredCommands, selectCommand],
  );
  const entityVisibleItems = useMemo<PickerVisibleItem[]>(
    () =>
      contextEntities
        .filter((e) => e.type === contextPicker.activeTab)
        .map((entity) => ({
          id: entityValue(entity),
          commit: () => selectEntity(entity),
        })),
    [contextPicker.activeTab, contextEntities, selectEntity],
  );
  const visibleItems =
    contextPicker.activeTab === "Skills"
      ? [...skillVisibleItems, ...commandVisibleItems]
      : entityVisibleItems;

  // Pre-seed cmdk's controlled value to the first visible item so a) the
  // picker always opens on a real highlight (Enter commits the first row
  // immediately) and b) the keyboard hook never needs a "fall back to
  // first" branch — pickerValue is always a real item id when items are
  // present. Done as adjust-state-during-render so the value reflects the
  // CURRENT visibleItems list, not the previous render's.
  const [prevFirstId, setPrevFirstId] = useState<string | null>(null);
  const firstId = visibleItems[0]?.id ?? null;
  const pickerValueIsStale =
    contextPicker.pickerValue !== "" &&
    !visibleItems.some((it) => it.id === contextPicker.pickerValue);
  if (firstId !== prevFirstId || pickerValueIsStale) {
    setPrevFirstId(firstId);
    if (firstId !== null && (contextPicker.pickerValue === "" || pickerValueIsStale)) {
      contextPicker.setPickerValue(firstId);
    } else if (firstId === null && contextPicker.pickerValue !== "") {
      contextPicker.setPickerValue("");
    }
  }

  const { handleKeyDown, onPickerKeyIntercept } = usePickerKeyboard({
    active: contextPicker.active,
    activeTab: contextPicker.activeTab,
    visibleTabs: visibleTabIds,
    visibleItems,
    pickerValue: contextPicker.pickerValue,
    setPickerValue: contextPicker.setPickerValue,
    setActiveTab: switchTab,
    onClose: closeAndStripTrigger,
  });

  // Compute ARIA ids directly after pickerValue stale correction.
  // pickerActiveDescendantId points to the highlighted option when the
  // picker is open and the current pickerValue is in the visible list.
  const pickerValueHasLiveItem =
    contextPicker.pickerValue !== "" &&
    visibleItems.some((it) => it.id === contextPicker.pickerValue);
  const pickerActiveDescendantId = pickerValueHasLiveItem
    ? contextPickerOptionId(contextPicker.pickerValue)
    : undefined;

  // Radix Popover needs an anchor element to position the menu against.
  // ChatInput attaches this via the setAnchorEl callback ref on the
  // editor wrapper. Stored in state (not a ref) because the menu re-reads
  // it on each render and React Compiler forbids ref reads during render.
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  const menu = contextPicker.active ? (
    <ContextPickerMenu
      anchorEl={anchorEl}
      entities={contextEntities}
      isLoading={contextSearchLoading}
      error={contextSearchError}
      pickerValue={contextPicker.pickerValue}
      onPickerValueChange={contextPicker.setPickerValue}
      activeTab={contextPicker.activeTab}
      isStartSlash={contextPicker.isStartSlash}
      onSelect={selectEntity}
      onActiveTabChange={switchTab}
      filteredSkills={filteredSkills}
      slashQuery={contextPicker.query}
      onSelectSkill={selectSkill}
      filteredCommands={filteredCommands}
      onSelectCommand={selectCommand}
      onClose={handleMenuClose}
    />
  ) : null;

  return children({
    activate: contextPicker.activate,
    handleKeyDown,
    menu,
    onPickerKeyIntercept,
    pickerActive: contextPicker.active,
    setAnchorEl,
    pickerListboxId: contextPicker.active ? CONTEXT_PICKER_LISTBOX_ID : undefined,
    pickerActiveDescendantId: contextPicker.active ? pickerActiveDescendantId : undefined,
  });
}
