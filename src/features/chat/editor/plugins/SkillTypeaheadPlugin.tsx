/**
 * SkillTypeaheadPlugin: wraps `LexicalTypeaheadMenuPlugin` for the slash
 * skill picker. Lexical owns ArrowUp/Down/Enter/Tab/Escape and the open/close
 * lifecycle while the menu is shown; we only provide the trigger semantics,
 * the option list, and a render function for the popup.
 *
 * Trigger semantics: the menu opens only when the entire editor content
 * matches `^/(\S*)$` (slash-prefixed, no whitespace anywhere). This mirrors
 * the previous host-side regex and keeps the menu hidden inside multi-line
 * drafts or after a space follows the command.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  type MenuTextMatch,
} from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { $getRoot, COMMAND_PRIORITY_CRITICAL } from "lexical";
import { useCallback, useMemo, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

import type { Skill } from "@/types/electron";

import { SkillCommandPalette } from "../../commands/SkillCommandPalette";

// eslint-disable-next-line react/only-export-components -- class extends Lexical's MenuOption and is tightly coupled to this plugin's render path
export class SkillMenuOption extends MenuOption {
  skill: Skill;
  constructor(skill: Skill) {
    super(skill.id);
    this.skill = skill;
  }
}

interface SkillTypeaheadPluginProps {
  skills: ReadonlyArray<Skill>;
  onSelect: (skill: Skill) => void;
}

export function SkillTypeaheadPlugin({ skills, onSelect }: SkillTypeaheadPluginProps) {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string>("");

  const filtered = useMemo(
    () => skills.filter((s) => s.enabled && s.name.toLowerCase().includes(query.toLowerCase())),
    [skills, query],
  );

  const options = useMemo(() => filtered.map((s) => new SkillMenuOption(s)), [filtered]);

  const triggerFn = useCallback((): MenuTextMatch | null => {
    const text = editor.getEditorState().read(() => $getRoot().getTextContent());
    const m = /^\/(\S*)$/.exec(text);
    if (!m) return null;
    return {
      leadOffset: 0,
      matchingString: m[1],
      replaceableString: text,
    };
  }, [editor]);

  const onSelectOption = useCallback(
    (option: SkillMenuOption, _textNode: unknown, closeMenu: () => void) => {
      onSelect(option.skill);
      closeMenu();
    },
    [onSelect],
  );

  return (
    <LexicalTypeaheadMenuPlugin<SkillMenuOption>
      options={options}
      onQueryChange={(s) => setQuery(s ?? "")}
      onSelectOption={onSelectOption}
      triggerFn={triggerFn}
      commandPriority={COMMAND_PRIORITY_CRITICAL}
      menuRenderFn={(anchorRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) =>
        renderMenu(anchorRef, {
          options,
          selectedIndex,
          selectOptionAndCleanUp,
          setHighlightedIndex,
        })
      }
    />
  );
}

function renderMenu(
  anchorRef: RefObject<HTMLElement | null>,
  props: {
    options: SkillMenuOption[];
    selectedIndex: number | null;
    selectOptionAndCleanUp: (option: SkillMenuOption) => void;
    setHighlightedIndex: (index: number) => void;
  },
) {
  if (anchorRef.current === null || props.options.length === 0) return null;
  return createPortal(
    <SkillCommandPalette
      options={props.options}
      selectedIndex={props.selectedIndex ?? 0}
      onHover={props.setHighlightedIndex}
      onSelect={props.selectOptionAndCleanUp}
    />,
    anchorRef.current,
  );
}
