import {
  $getRoot,
  $isElementNode,
  $isTextNode,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";

import { chipMarkdownText, chipPlainText } from "../nodes/context-chip";
import type { ChipDescriptor } from "../contracts/chip-descriptor";

const CTX_MARKER_RE = / ?<!--ctx:[\s\S]*?-->/g;

function replaceFirst(source: string, search: string, replacement: string): string {
  const index = source.indexOf(search);
  return index === -1
    ? source
    : `${source.slice(0, index)}${replacement}${source.slice(index + search.length)}`;
}

/** Replaces each chip placeholder in order with its inline submit text. */
export function flattenChipsForSubmit(
  plainText: string,
  chips: ReadonlyArray<ChipDescriptor>,
): string {
  return chips.reduce(
    (text, { entity }) => replaceFirst(text, chipPlainText(entity), chipMarkdownText(entity)),
    plainText,
  );
}

export function getPlainTextFromEditor(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => $getRoot().getTextContent());
}

export function getLastParagraph() {
  const children = $getRoot().getChildren();
  for (let index = children.length - 1; index >= 0; index--) {
    const child = children[index];
    if ($isElementNode(child)) return child;
  }
  return null;
}

export function stripTrailingPlainTextCharacters(paragraph: LexicalNode, count: number): void {
  if (!$isElementNode(paragraph) || count <= 0) return;

  let remaining = count;
  let current = paragraph.getLastChild();
  while (current && remaining > 0) {
    if (!$isTextNode(current)) break;

    const text = current.getTextContent();
    const removeCount = Math.min(remaining, text.length);
    const nextText = text.slice(0, text.length - removeCount);
    remaining -= removeCount;
    if (nextText.length === 0) {
      const previous = current.getPreviousSibling();
      current.remove();
      current = previous;
    } else {
      current.setTextContent(nextText);
      break;
    }
  }
}

export function isEditorFocused(editor: LexicalEditor): boolean {
  const root = editor.getRootElement();
  return root !== null && root.contains(document.activeElement);
}

/** Removes invisible context markers before text is shown or copied. */
export function stripCtxMarkers(text: string): string {
  return text.replace(CTX_MARKER_RE, "");
}
