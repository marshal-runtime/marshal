import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  HISTORY_MERGE_TAG,
  type LexicalEditor,
} from "lexical";
import { describe, expect, it, vi } from "vitest";

import { act, render } from "@/test-utils";

import { ChangeRelayPlugin } from "./marshal/ChangeRelayPlugin";
import { ContextChipNode } from "./nodes/ContextChipNode";
import { SkillPillNode } from "./nodes/SkillPillNode";
import { PROGRAMMATIC_UPDATE_TAG } from "./contracts/programmatic-update-tag";

function CaptureEditorRef({ onReady }: { onReady: (editor: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext();
  onReady(editor);
  return null;
}

function mountRelay(onChange: (t: string) => void, onChipsChange: () => void) {
  let editor!: LexicalEditor;
  render(
    <LexicalComposer
      initialConfig={{
        namespace: "test",
        nodes: [ContextChipNode, SkillPillNode],
        onError: (e: Error) => {
          throw e;
        },
      }}
    >
      <CaptureEditorRef onReady={(e) => (editor = e)} />
      <ChangeRelayPlugin onChange={onChange} onChipsChange={onChipsChange} />
    </LexicalComposer>,
  );
  return editor;
}

function seedParagraph(editor: LexicalEditor, text: string, tag?: string) {
  act(() => {
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const p = $createParagraphNode();
        p.append($createTextNode(text));
        root.append(p);
      },
      { discrete: true, ...(tag ? { tag } : {}) },
    );
  });
}

/** Push the editor past its initial empty state so subsequent updates aren't
 * suppressed by the prevEditorState.isEmpty() guard. */
function primeEditor(editor: LexicalEditor) {
  // Use the programmatic tag so the prime itself doesn't fire onChange.
  seedParagraph(editor, "_prime_", PROGRAMMATIC_UPDATE_TAG);
}

describe("ChangeRelayPlugin", () => {
  it("does NOT fire onChange for selection-only updates (regression)", () => {
    const onChange = vi.fn<(t: string) => void>();
    const onChipsChange = vi.fn<() => void>();
    const editor = mountRelay(onChange, onChipsChange);

    primeEditor(editor);
    // Real edit: now prevEditorState is non-empty so onChange will fire on real mutations.
    seedParagraph(editor, "hello");
    expect(onChange).toHaveBeenCalledWith("hello");
    onChange.mockClear();
    onChipsChange.mockClear();

    // Move the cursor without mutating any node — pure selection change.
    act(() => {
      editor.update(
        () => {
          const root = $getRoot();
          const text = root.getFirstDescendant();
          if (text && $isTextNode(text)) {
            text.select(0, 0);
          }
          // Sanity: the only thing that changed is the selection.
          const sel = $getSelection();
          expect($isRangeSelection(sel)).toBe(true);
        },
        { discrete: true },
      );
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(onChipsChange).not.toHaveBeenCalled();
  });

  it("filters PROGRAMMATIC_UPDATE_TAG (typewriter / draft restore)", () => {
    const onChange = vi.fn<(t: string) => void>();
    const onChipsChange = vi.fn<() => void>();
    const editor = mountRelay(onChange, onChipsChange);

    primeEditor(editor);
    onChange.mockClear();
    onChipsChange.mockClear();

    seedParagraph(editor, "drip", PROGRAMMATIC_UPDATE_TAG);

    expect(onChange).not.toHaveBeenCalled();
    expect(onChipsChange).not.toHaveBeenCalled();
  });

  it("filters HISTORY_MERGE_TAG (history coalescing is not a user edit)", () => {
    const onChange = vi.fn<(t: string) => void>();
    const onChipsChange = vi.fn<() => void>();
    const editor = mountRelay(onChange, onChipsChange);

    primeEditor(editor);
    onChange.mockClear();

    seedParagraph(editor, "merged", HISTORY_MERGE_TAG);

    expect(onChange).not.toHaveBeenCalled();
  });

  it("fires onChange for real text mutations", () => {
    const onChange = vi.fn<(t: string) => void>();
    const onChipsChange = vi.fn<() => void>();
    const editor = mountRelay(onChange, onChipsChange);

    primeEditor(editor);
    onChange.mockClear();
    onChipsChange.mockClear();

    seedParagraph(editor, "hi there");

    expect(onChange).toHaveBeenLastCalledWith("hi there");
    expect(onChipsChange).toHaveBeenCalled();
  });
});
