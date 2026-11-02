/** Lexical prompt editor with inline context chips and an imperative ref API. */

import { createLogger } from "@common/marshal-logger";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { useId, useMemo, type KeyboardEvent as ReactKeyboardEvent, type Ref } from "react";

import { cn } from "@/lib/marshal-class-names";
import type { Skill } from "@/types/electron";

import type { InputEditorHandle } from "./contracts/input-editor-handle";
import { ChangeRelayPlugin } from "./marshal/ChangeRelayPlugin";
import { EditableStatePlugin } from "./marshal/EditableStatePlugin";
import { ImperativeRefBridge } from "./marshal/ImperativeRefBridge";
import { PickerKeyPlugin } from "./marshal/PickerKeyPlugin";
import { PromptHistoryPlugin, type ArrowDirection } from "./marshal/PromptHistoryPlugin";
import { RichPastePlugin } from "./marshal/RichPastePlugin";
import { ContextChipNode } from "./nodes/ContextChipNode";
import { SkillPillNode } from "./nodes/SkillPillNode";
import { InlinePillKeyboardPlugin } from "./pills/InlinePillKeyboardPlugin";
import { SkillTypeaheadPlugin } from "./plugins/SkillTypeaheadPlugin";
import { SubmitPlugin } from "./plugins/SubmitPlugin";
import type { ChipDescriptor } from "./contracts/chip-descriptor";

export interface InputEditorProps {
  ref?: Ref<InputEditorHandle>;
  initialValue?: string;
  placeholder?: string;
  className?: string;
  onChange: (text: string) => void;
  onChipsChange: (chips: ChipDescriptor[]) => void;
  /**
   * Non-Enter, non-arrow keydown handler (Escape, slash-menu nav, etc.).
   * Enter is handled by SubmitPlugin via `onEnter`. ArrowUp/Down are handled
   * by PromptHistoryPlugin via `onArrowAtBoundary`.
   */
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  /**
   * Called when ArrowUp/Down is pressed at a visual row boundary. Return true
   * to consume the event (suppress Lexical's default arrow handling).
   */
  onArrowAtBoundary?: (direction: ArrowDirection, value: string) => boolean;
  /**
   * Called on plain Enter (no Shift, not in IME composition). `modifiers.steer`
   * is true when Ctrl/Cmd was held (request to interrupt/steer a running turn).
   * Return `true` to consume the event (no newline inserted); return `false` to
   * fall through and let Lexical insert a line break.
   */
  onEnter?: (modifiers: { steer: boolean }) => boolean;
  /**
   * When provided, mounts the slash-skill typeahead menu.
   * Mutually exclusive with `onPickerKeyIntercept` — when the Context Picker
   * is wired up, slash triggers are routed through the picker instead.
   */
  skills?: ReadonlyArray<Skill>;
  onSelectSkill?: (skill: Skill) => void;
  /**
   * When provided, mounts `PickerKeyPlugin` so the Context Picker can
   * intercept Enter/Tab/Escape ahead of the editor's own handlers.
   */
  onPickerKeyIntercept?: (key: "Enter" | "Tab" | "Escape" | "ArrowUp" | "ArrowDown") => boolean;
  ariaLabel?: string;
  /**
   * ARIA combobox-style wiring for an external popup (e.g. the Context
   * Picker). When provided, screen readers announce that a popup is
   * associated with the editor (`hasPopup`), `expanded` reflects whether
   * it's currently open, and `controls`/`activeDescendant` point at the
   * popup's listbox + currently-highlighted option (only emitted while
   * `expanded`).
   */
  combobox?: {
    hasPopup: "listbox" | "menu" | "tree" | "grid" | "dialog";
    expanded: boolean;
    controls?: string;
    activeDescendant?: string;
  };
  testId?: string;
  /** When true, the editor refuses input and reports `aria-disabled="true"`. */
  disabled?: boolean;
  /** Surfaces an init error to assistive tech via aria-live + aria-errormessage. */
  errorMessage?: string;
}

const editorTheme = {
  paragraph: "m-0",
};
const log = createLogger("InputEditor");

export function InputEditor({
  ref,
  initialValue = "",
  placeholder,
  className,
  onChange,
  onChipsChange,
  onKeyDown,
  onArrowAtBoundary,
  onEnter,
  skills,
  onSelectSkill,
  onPickerKeyIntercept,
  ariaLabel,
  combobox,
  testId,
  disabled = false,
  errorMessage,
}: InputEditorProps) {
  const errorId = useId();
  // Keep stable so Lexical does not remount.
  const initialConfig = useMemo(
    () => ({
      namespace: "ChatInput",
      theme: editorTheme,
      nodes: [ContextChipNode, SkillPillNode],
      onError(error: Error) {
        log.error("Lexical error:", error);
      },
      editorState: () => {
        const root = $getRoot();
        if (root.getFirstChild() === null) {
          const p = $createParagraphNode();
          if (initialValue.length > 0) p.append($createTextNode(initialValue));
          root.append(p);
        }
      },
    }),
    // eslint-disable-next-line react-compiler/exhaustive-deps -- intentional: initial config is captured once on mount.
    [],
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div
        className={cn("relative", className)}
        // Forwarded keys: ArrowUp/Down for history, slash-menu nav, Escape, etc.
        // Enter is handled inside the editor by SubmitPlugin.
        onKeyDown={onKeyDown}
      >
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              role="textbox"
              aria-label={ariaLabel}
              aria-multiline="true"
              aria-haspopup={combobox?.hasPopup}
              aria-expanded={combobox?.expanded}
              aria-controls={combobox?.expanded ? combobox.controls : undefined}
              aria-activedescendant={combobox?.expanded ? combobox.activeDescendant : undefined}
              aria-disabled={disabled || undefined}
              aria-invalid={errorMessage ? true : undefined}
              aria-errormessage={errorMessage ? errorId : undefined}
              data-testid={testId}
              // Cap at 200px so the editor scrolls internally rather than
              // pushing the composer up into the messages above it. Measured
              // on the running app: collapsed, the editor is 24px inside a
              // 58px bordered surface, and the whole chat-input form is 160px
              // including its p-6. At the cap those become ~234px and ~336px.

              className="max-h-[200px] min-h-[24px] w-full resize-none overflow-y-auto bg-transparent text-sm wrap-break-word whitespace-pre-wrap outline-none"
            />
          }
          placeholder={
            placeholder ? (
              <div
                aria-hidden="true"
                // Add a placeholder attribute so getByPlaceholderText still works in tests.
                {...{ placeholder }}
                // inset-x-0 + truncate keeps the hint on a single line. Without
                // it, narrow containers (mini mode) wrap the placeholder past
                // the editor's min-h-[24px], which pushes the composer taller
                // and leaves the hint vertically misaligned against the action
                // row beside it.
                className="pointer-events-none absolute inset-x-0 top-0 truncate text-sm text-muted-foreground select-none"
              >
                {placeholder}
              </div>
            ) : null
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <RichPastePlugin />
        <InlinePillKeyboardPlugin />
        <EditableStatePlugin disabled={disabled} />
        {onArrowAtBoundary ? <PromptHistoryPlugin onArrowAtBoundary={onArrowAtBoundary} /> : null}
        {onPickerKeyIntercept ? (
          <PickerKeyPlugin onPickerKeyIntercept={onPickerKeyIntercept} />
        ) : skills && onSelectSkill ? (
          <SkillTypeaheadPlugin skills={skills} onSelect={onSelectSkill} />
        ) : null}
        {onEnter ? <SubmitPlugin onEnter={onEnter} /> : null}
        <ImperativeRefBridge imperativeRef={ref} />
        <ChangeRelayPlugin onChange={onChange} onChipsChange={onChipsChange} />
        {errorMessage ? (
          <span id={errorId} role="status" aria-live="polite" className="sr-only">
            {errorMessage}
          </span>
        ) : null}
      </div>
    </LexicalComposer>
  );
}

export type { ChipDescriptor } from "./contracts/chip-descriptor";
export type { InputEditorHandle };
