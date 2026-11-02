import {
  $applyNodeReplacement,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isParagraphNode,
  $isTextNode,
  type LexicalNode,
} from "lexical";

import { SkillPillNode } from "../nodes/SkillPillNode";

export function $createSkillPillNode(skillName: string, skillId: string): SkillPillNode {
  return $applyNodeReplacement(new SkillPillNode(skillName, skillId));
}

export function $isSkillPillNode(node: LexicalNode | null | undefined): node is SkillPillNode {
  return node instanceof SkillPillNode;
}

/** Returns the skill pill at the start of the document, or null if none. */
export function $findLeadingSkillPill(): SkillPillNode | null {
  const root = $getRoot();
  const firstChild = root.getFirstChild();
  if (!firstChild || !$isParagraphNode(firstChild)) return null;
  const first = firstChild.getFirstChild();
  return $isSkillPillNode(first) ? first : null;
}

/**
 * Removes any leading skill pill from the first paragraph (and the trailing
 * space text node we paired with it on insertion).
 */
export function $removeLeadingSkillPill(): void {
  const root = $getRoot();
  const firstChild = root.getFirstChild();
  if (!firstChild || !$isParagraphNode(firstChild)) return;
  const first = firstChild.getFirstChild();
  if (!$isSkillPillNode(first)) return;

  const trailing = first.getNextSibling();
  if ($isTextNode(trailing) && trailing.getTextContent() === " ") {
    trailing.remove();
  }
  first.remove();
}

/**
 * Inserts a skill pill at the very start of the document.
 *
 * - Removes any pre-existing leading skill pill (single-skill invariant).
 * - Removes the leading slash trigger text (e.g. `/sum`) from the first
 *   paragraph if present.
 * - Inserts `[pill][" "]` at the start; caret is placed at the end of the
 *   trailing space.
 */
export function $insertSkillPillAtStart(skillName: string, skillId: string): void {
  const root = $getRoot();
  const firstChild = root.getFirstChild();
  let paragraph = $isParagraphNode(firstChild) ? firstChild : null;
  if (!paragraph) {
    paragraph = $createParagraphNode();
    root.splice(0, 0, [paragraph]);
  }

  const first = paragraph.getFirstChild();
  if ($isSkillPillNode(first)) {
    $removeLeadingSkillPill();
  } else if ($isTextNode(first)) {
    const text = first.getTextContent();
    const match = text.match(/^\/\S*/);
    if (match) {
      const remainder = text.slice(match[0].length);
      if (remainder.length === 0) {
        first.remove();
      } else {
        first.setTextContent(remainder);
      }
    }
  }

  const pill = $createSkillPillNode(skillName, skillId);
  const space = $createTextNode(" ");
  paragraph.splice(0, 0, [pill, space]);
  space.select(1, 1);
}
