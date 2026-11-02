// marshal-owned renderer test
/**
 * Integration test for the slash-skill typeahead end-to-end flow at the
 * editor level. Drives Enter / Tab / Click selection on the menu and asserts
 * the skill pill ends up in the editor. Intentionally lives outside
 * InputEditor.marshal.test.tsx because it composes the editor with the typeahead
 * plugin and exercises the menu plumbing rather than the imperative API.
 */

import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  $createTextNode,
  $getRoot,
  $isElementNode,
  KEY_ENTER_COMMAND,
  KEY_TAB_COMMAND,
  type LexicalEditor,
} from "lexical";
import { createRef, type RefObject } from "react";
import { describe, expect, it, vi } from "vitest";

import { render } from "@/test-utils";
import type { Skill } from "@/types/electron";

import { InputEditor, type InputEditorHandle } from "./InputEditor";

const noop = () => {};

const SKILLS: Skill[] = [
  {
    id: "s1",
    name: "summarize",
    description: "Summarize text",
    instructions: "",
    enabled: true,
    createdAt: "2025-01-01",
    scope: "local",
  },
  {
    id: "s2",
    name: "translate",
    description: "Translate text",
    instructions: "",
    enabled: true,
    createdAt: "2025-01-01",
    scope: "local",
  },
];

function withEditor(ref: RefObject<InputEditorHandle | null>, cb: (editor: LexicalEditor) => void) {
  const handle = ref.current;
  if (!handle?.__test_with) throw new Error("__test_with unavailable");
  handle.__test_with(cb);
}

/** Simulate user typing `text` with caret at the end. */
function seedSlashCommand(ref: RefObject<InputEditorHandle | null>, text: string) {
  withEditor(ref, (editor) => {
    editor.update(
      () => {
        const root = $getRoot();
        const para = root.getFirstChild();
        if (!$isElementNode(para)) return;
        para.clear();
        const tn = $createTextNode(text);
        para.append(tn);
        tn.select(text.length, text.length);
      },
      { discrete: true },
    );
  });
}

describe("Skill typeahead end-to-end", () => {
  it("Enter on highlighted skill option inserts the pill", async () => {
    const ref = createRef<InputEditorHandle>();
    const onSelectSkill = vi.fn<(skill: Skill) => void>();
    render(
      <InputEditor
        ref={ref}
        onChange={noop}
        onChipsChange={noop}
        skills={SKILLS}
        onSelectSkill={(skill) => {
          onSelectSkill(skill);
          ref.current?.setSkill(skill.name, skill.id);
        }}
        testId="input-editor"
      />,
    );

    await act(async () => {
      seedSlashCommand(ref, "/sum");
    });

    await screen.findByText("Summarize text");

    await act(async () => {
      withEditor(ref, (editor) => {
        editor.dispatchCommand(KEY_ENTER_COMMAND, new KeyboardEvent("keydown", { key: "Enter" }));
      });
    });

    await waitFor(() => {
      expect(ref.current?.getSkill()).toEqual({ name: "summarize", id: "s1" });
    });
    expect(ref.current?.getPlainText()).toBe("/summarize ");
    expect(onSelectSkill).toHaveBeenCalledWith(expect.objectContaining({ name: "summarize" }));
  });

  it("Tab on highlighted skill option inserts the pill", async () => {
    const ref = createRef<InputEditorHandle>();
    render(
      <InputEditor
        ref={ref}
        onChange={noop}
        onChipsChange={noop}
        skills={SKILLS}
        onSelectSkill={(skill) => ref.current?.setSkill(skill.name, skill.id)}
        testId="input-editor"
      />,
    );

    await act(async () => {
      seedSlashCommand(ref, "/sum");
    });

    await screen.findByText("Summarize text");

    // One microtask tick so typeahead's preselectFirstItem effect runs.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    await act(async () => {
      withEditor(ref, (editor) => {
        editor.dispatchCommand(KEY_TAB_COMMAND, new KeyboardEvent("keydown", { key: "Tab" }));
      });
    });

    await waitFor(() => {
      expect(ref.current?.getSkill()).toEqual({ name: "summarize", id: "s1" });
    });
  });

  it("Click on skill option inserts the pill", async () => {
    const ref = createRef<InputEditorHandle>();
    const setSkillSpy = vi.fn<(skill: Skill) => void>();
    render(
      <InputEditor
        ref={ref}
        onChange={noop}
        onChipsChange={noop}
        skills={SKILLS}
        onSelectSkill={(skill) => {
          setSkillSpy(skill);
          ref.current?.setSkill(skill.name, skill.id);
        }}
        testId="input-editor"
      />,
    );

    await act(async () => {
      seedSlashCommand(ref, "/sum");
    });

    const opt = await screen.findByText("Summarize text");
    const user = userEvent.setup();
    await user.click(opt);

    expect(setSkillSpy).toHaveBeenCalledWith(expect.objectContaining({ name: "summarize" }));
    await waitFor(() => {
      expect(ref.current?.getSkill()).toEqual({ name: "summarize", id: "s1" });
    });
  });
});
