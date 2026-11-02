/**
 * Headless Lexical tests for chip/pill JSON serialization.
 *
 * No React mount, no editor element. We construct a bare LexicalEditor with our custom
 * nodes registered, drive node mutations through editor.update(), serialize via
 * getEditorState().toJSON(), parse the JSON back, and assert the round-tripped state.
 *
 * Splitting these out of InputEditor.marshal.test.tsx keeps the JSON contract pinned in a
 * test that does not depend on React, decorate(), or DOM behavior.
 */

import {
  $createParagraphNode,
  $getRoot,
  $isElementNode,
  createEditor,
  type LexicalEditor,
} from "lexical";
import { describe, expect, it } from "vitest";

import { $createContextChipNode, type ContextChipEntity } from "./nodes/context-chip";
import { ContextChipNode } from "./nodes/ContextChipNode";
import { SkillPillNode } from "./nodes/SkillPillNode";
import { $createSkillPillNode } from "./pills/pill-type-guards";

function createHeadlessEditor(): LexicalEditor {
  const editor = createEditor({
    nodes: [ContextChipNode, SkillPillNode],
    onError: (error) => {
      throw error;
    },
  });
  return editor;
}

function applySync(editor: LexicalEditor, fn: () => void): void {
  editor.update(fn, { discrete: true });
}

function readSync<T>(editor: LexicalEditor, fn: () => T): T {
  return editor.getEditorState().read(fn);
}

const personEntity: ContextChipEntity = {
  type: "People",
  id: "p1",
  referenceId: "p1",
  displayName: "Alice Example",
  email: "alice@example.com",
};

describe("editor JSON round-trip (headless)", () => {
  it("ContextChipNode preserves chipId + entity through export/import", () => {
    const editor = createHeadlessEditor();
    let originalChipId = "";

    applySync(editor, () => {
      const root = $getRoot();
      const chip = $createContextChipNode(personEntity);
      originalChipId = chip.getChipId();
      const para = $createParagraphNode();
      para.append(chip);
      root.clear();
      root.append(para);
    });

    const serialized = JSON.parse(JSON.stringify(editor.getEditorState().toJSON()));

    expect(serialized).toMatchObject({
      root: {
        children: [
          {
            children: expect.arrayContaining([
              expect.objectContaining({
                type: "context-chip",
                chipId: originalChipId,
                entity: {
                  type: "People",
                  id: "p1",
                  referenceId: "p1",
                  displayName: "Alice Example",
                  email: "alice@example.com",
                },
              }),
            ]),
          },
        ],
      },
    });

    const restored = createHeadlessEditor();
    applySync(restored, () => {
      const state = restored.parseEditorState(serialized);
      restored.setEditorState(state);
    });

    const restoredChip = readSync(restored, () => {
      const root = $getRoot();
      const para = root.getFirstChild();
      const first = $isElementNode(para) ? para.getFirstChild() : null;
      if (!(first instanceof ContextChipNode)) throw new Error("chip not restored");
      return { chipId: first.getChipId(), entity: first.getEntity() };
    });

    expect(restoredChip.chipId).toBe(originalChipId);
    expect(restoredChip.entity).toEqual(personEntity);
  });

  it("SkillPillNode preserves skillName + skillId through export/import", () => {
    const editor = createHeadlessEditor();

    applySync(editor, () => {
      const root = $getRoot();
      const para = $createParagraphNode();
      const pill = $createSkillPillNode("summarize", "skill-1");
      para.append(pill);
      root.clear();
      root.append(para);
    });

    const serialized = JSON.parse(JSON.stringify(editor.getEditorState().toJSON()));

    expect(serialized).toMatchObject({
      root: {
        children: [
          {
            children: expect.arrayContaining([
              expect.objectContaining({
                type: "skill-pill",
                skillName: "summarize",
                skillId: "skill-1",
              }),
            ]),
          },
        ],
      },
    });

    const restored = createHeadlessEditor();
    applySync(restored, () => {
      const state = restored.parseEditorState(serialized);
      restored.setEditorState(state);
    });

    const restoredPill = readSync(restored, () => {
      const root = $getRoot();
      const para = root.getFirstChild();
      const first = $isElementNode(para) ? para.getFirstChild() : null;
      if (!(first instanceof SkillPillNode)) throw new Error("pill not restored");
      return { name: first.getSkillName(), id: first.getSkillId() };
    });

    expect(restoredPill).toEqual({ name: "summarize", id: "skill-1" });
  });
});
