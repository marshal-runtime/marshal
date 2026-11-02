// marshal-owned renderer test
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { $getRoot, $isElementNode, $isTextNode, UNDO_COMMAND, type LexicalEditor } from "lexical";
import React, { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { render } from "@/test-utils";

import { InputEditor, type ChipDescriptor, type InputEditorHandle } from "./InputEditor";
import { chipPlainText } from "./nodes/context-chip";

const noop = () => {};

function pressKey(key: string) {
  const editor = screen.getByTestId("input-editor");
  // oxlint-disable-next-line testing-library/prefer-user-event -- happy-dom does not reliably drive Lexical key commands with userEvent.
  fireEvent.keyDown(editor, { key });
}

function withEditor(
  ref: React.RefObject<InputEditorHandle | null>,
  callback: (editor: LexicalEditor) => void,
) {
  const handle = ref.current;
  if (!handle?.__test_with) {
    throw new Error("__test_with unavailable - production build or ref not attached");
  }
  handle.__test_with(callback);
}

function seedCaretAtStartOfTrailingSpace(ref: React.RefObject<InputEditorHandle | null>) {
  withEditor(ref, (editor) => {
    editor.update(
      () => {
        const root = $getRoot();
        const para = root.getFirstChild();
        if (!$isElementNode(para)) return;
        const last = para.getLastChild();
        if ($isTextNode(last)) last.select(0, 0);
      },
      { discrete: true },
    );
  });
}

function seedCaretAtEndOfText(ref: React.RefObject<InputEditorHandle | null>, text: string) {
  withEditor(ref, (editor) => {
    editor.update(
      () => {
        const root = $getRoot();
        const para = root.getFirstChild();
        if (!$isElementNode(para)) return;
        for (const child of para.getChildren()) {
          if ($isTextNode(child) && child.getTextContent() === text) {
            child.select(child.getTextContentSize(), child.getTextContentSize());
            return;
          }
        }
      },
      { discrete: true },
    );
  });
}

function makePersonEntity() {
  return {
    type: "People" as const,
    id: "p1",
    referenceId: "p1",
    displayName: "Alice Example",
    email: "alice@example.com",
  };
}

describe("InputEditor", () => {
  it("getPlainText() reflects initialValue", () => {
    const ref = createRef<InputEditorHandle>();
    render(
      <InputEditor ref={ref} initialValue="hello world" onChange={noop} onChipsChange={noop} />,
    );
    expect(ref.current?.getPlainText()).toBe("hello world");
  });

  it("renders the editor as a textbox", () => {
    render(<InputEditor onChange={noop} onChipsChange={noop} ariaLabel="Message" />);
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveAttribute(
      "aria-multiline",
      "true",
    );
  });

  it("setPlainText() replaces the content", async () => {
    const ref = createRef<InputEditorHandle>();
    render(<InputEditor ref={ref} onChange={noop} onChipsChange={noop} />);
    await act(async () => {
      ref.current?.setPlainText("from-set");
    });
    expect(ref.current?.getPlainText()).toBe("from-set");
  });

  it("Cmd-Z after setPlainText cannot resurrect previous content (history is cleared)", async () => {
    const ref = createRef<InputEditorHandle>();
    render(<InputEditor ref={ref} initialValue="my draft" onChange={noop} onChipsChange={noop} />);

    await act(async () => {
      ref.current?.setPlainText("history line");
    });
    expect(ref.current?.getPlainText()).toBe("history line");

    await act(async () => {
      // Lexical's history plugin handles undo via this command; stays inside the editor model.
      withEditor(ref, (editor) => {
        editor.dispatchCommand(UNDO_COMMAND, undefined);
      });
    });

    expect(ref.current?.getPlainText()).toBe("history line");
    expect(ref.current?.getPlainText()).not.toContain("my draft");
  });

  it("Cmd-Z after clear() cannot resurrect previous content (history is cleared)", async () => {
    const ref = createRef<InputEditorHandle>();
    render(<InputEditor ref={ref} initialValue="my draft" onChange={noop} onChipsChange={noop} />);

    await act(async () => {
      ref.current?.clear();
    });
    expect(ref.current?.getPlainText()).toBe("");

    await act(async () => {
      withEditor(ref, (editor) => {
        editor.dispatchCommand(UNDO_COMMAND, undefined);
      });
    });

    expect(ref.current?.getPlainText()).toBe("");
  });

  it("insertChipAtCaret() inserts a chip and reports it via onChipsChange", async () => {
    const ref = createRef<InputEditorHandle>();
    let chips: ChipDescriptor[] = [];
    render(
      <InputEditor
        ref={ref}
        onChange={noop}
        onChipsChange={(c) => {
          chips = c;
        }}
      />,
    );
    const entity = makePersonEntity();
    await act(async () => {
      ref.current?.focus();
      ref.current?.insertChipAtCaret(entity);
    });
    expect(chips).toHaveLength(1);
    expect(chips[0].entity).toEqual(entity);
    expect(ref.current?.getPlainText()).toBe(`${chipPlainText(entity)} `);
  });

  it("removeChipById() removes the matching chip", async () => {
    const ref = createRef<InputEditorHandle>();
    let chips: ChipDescriptor[] = [];
    render(
      <InputEditor
        ref={ref}
        onChange={noop}
        onChipsChange={(c) => {
          chips = c;
        }}
      />,
    );
    await act(async () => {
      ref.current?.focus();
      ref.current?.insertChipAtCaret(makePersonEntity());
    });
    expect(chips).toHaveLength(1);
    const chipId = chips[0].chipId;
    await act(async () => {
      ref.current?.removeChipById(chipId);
    });
    expect(chips).toHaveLength(0);
  });

  it("clear() empties the content", async () => {
    const ref = createRef<InputEditorHandle>();
    render(<InputEditor ref={ref} initialValue="abc" onChange={noop} onChipsChange={noop} />);
    await act(async () => {
      ref.current?.clear();
    });
    expect(ref.current?.getPlainText()).toBe("");
  });

  it("context picker selection consumes the `/query` trigger text", async () => {
    const ref = createRef<InputEditorHandle>();
    const entity = {
      type: "People" as const,
      id: "p1",
      referenceId: "p1",
      displayName: "John Doe",
      email: "john@example.com",
    };

    render(<InputEditor ref={ref} onChange={noop} onChipsChange={noop} testId="input-editor" />);

    await act(async () => {
      ref.current?.setPlainText("hello /joh");
      ref.current?.insertChipAtCaret(entity, 4);
    });

    expect(ref.current?.getPlainText()).toBe(`hello ${chipPlainText(entity)} `);
    expect(ref.current?.getPlainText()).not.toContain("/joh");
  });

  it("Enter is consumed by the context picker before submit", () => {
    const onPickerKeyIntercept = vi.fn<
      (key: "Enter" | "Tab" | "Escape" | "ArrowUp" | "ArrowDown") => boolean
    >(() => true);
    const onEnter = vi.fn<() => boolean>(() => true);

    render(
      <InputEditor
        onChange={noop}
        onChipsChange={noop}
        onPickerKeyIntercept={onPickerKeyIntercept}
        onEnter={onEnter}
        testId="input-editor"
      />,
    );

    pressKey("Enter");

    expect(onPickerKeyIntercept).toHaveBeenCalledWith("Enter");
    expect(onEnter).not.toHaveBeenCalled();
  });

  it("backspace right after a chip removes the chip", async () => {
    const ref = createRef<InputEditorHandle>();
    let chips: ChipDescriptor[] = [];

    render(
      <InputEditor
        ref={ref}
        onChange={noop}
        onChipsChange={(nextChips) => {
          chips = nextChips;
        }}
        testId="input-editor"
      />,
    );

    await act(async () => {
      ref.current?.focus();
      ref.current?.insertChipAtCaret(makePersonEntity());
    });

    expect(chips).toHaveLength(1);

    seedCaretAtStartOfTrailingSpace(ref);
    pressKey("Backspace");

    await waitFor(() => {
      expect(chips).toHaveLength(0);
      expect(ref.current?.getPlainText()).toBe(" ");
    });
  });

  it("clicking a chip and pressing Backspace removes it (NodeSelection path)", async () => {
    const ref = createRef<InputEditorHandle>();
    let chips: ChipDescriptor[] = [];

    render(
      <InputEditor
        ref={ref}
        onChange={noop}
        onChipsChange={(nextChips) => {
          chips = nextChips;
        }}
        testId="input-editor"
      />,
    );

    await act(async () => {
      ref.current?.focus();
      ref.current?.insertChipAtCaret(makePersonEntity());
    });

    expect(chips).toHaveLength(1);

    const chipEl = await screen.findByTestId("chip-decorator");
    // Wrap click in act so React's onClick handler flushes setSelected -> NodeSelection
    // before we dispatch Backspace via Lexical command.
    // oxlint-disable-next-line testing-library/no-unnecessary-act -- setSelected must flush before Backspace.
    await act(async () => {
      // oxlint-disable-next-line testing-library/prefer-user-event -- happy-dom + portal-rendered span; userEvent's pointer flow doesn't always reach the React onClick listener inside the editor portal.
      fireEvent.click(chipEl);
    });
    expect(chipEl.parentElement?.getAttribute("data-selected")).toBe("true");

    pressKey("Backspace");

    await waitFor(() => {
      expect(chips).toHaveLength(0);
    });
  });

  it("forward Delete just before a chip removes the chip", async () => {
    const ref = createRef<InputEditorHandle>();
    let chips: ChipDescriptor[] = [];

    render(
      <InputEditor
        ref={ref}
        onChange={noop}
        onChipsChange={(nextChips) => {
          chips = nextChips;
        }}
        testId="input-editor"
      />,
    );

    await act(async () => {
      ref.current?.setPlainText("hi ");
      ref.current?.focus();
      ref.current?.insertChipAtCaret(makePersonEntity());
    });

    expect(chips).toHaveLength(1);

    seedCaretAtEndOfText(ref, "hi ");
    pressKey("Delete");

    await waitFor(() => {
      expect(chips).toHaveLength(0);
    });
  });

  it("setSkill() inserts a pill that flattens to /skill-name and getSkill() reports it", async () => {
    const ref = createRef<InputEditorHandle>();
    render(<InputEditor ref={ref} onChange={noop} onChipsChange={noop} testId="input-editor" />);

    await act(async () => {
      ref.current?.setPlainText("/sum");
      ref.current?.setSkill("summarize", "skill-summarize");
    });

    // Pill replaces the leading "/sum" trigger; getPlainText flattens to "/skill-name ".
    expect(ref.current?.getPlainText()).toBe("/summarize ");
    expect(ref.current?.getSkill()).toEqual({ name: "summarize", id: "skill-summarize" });
  });

  it("setSkill() called twice replaces the existing pill", async () => {
    const ref = createRef<InputEditorHandle>();
    render(<InputEditor ref={ref} onChange={noop} onChipsChange={noop} testId="input-editor" />);

    await act(async () => {
      ref.current?.setSkill("summarize", "skill-1");
    });
    await act(async () => {
      ref.current?.setSkill("translate", "skill-2");
    });

    expect(ref.current?.getPlainText()).toBe("/translate ");
    expect(ref.current?.getSkill()).toEqual({ name: "translate", id: "skill-2" });
  });

  it("clearSkill() removes the pill", async () => {
    const ref = createRef<InputEditorHandle>();
    render(<InputEditor ref={ref} onChange={noop} onChipsChange={noop} testId="input-editor" />);

    await act(async () => {
      ref.current?.setSkill("summarize", "skill-1");
    });
    expect(ref.current?.getSkill()).not.toBeNull();

    await act(async () => {
      ref.current?.clearSkill();
    });
    expect(ref.current?.getSkill()).toBeNull();
    expect(ref.current?.getPlainText()).toBe("");
  });

  it("backspace right after a skill pill removes the pill", async () => {
    const ref = createRef<InputEditorHandle>();
    render(<InputEditor ref={ref} onChange={noop} onChipsChange={noop} testId="input-editor" />);

    await act(async () => {
      ref.current?.setSkill("summarize", "skill-1");
    });
    expect(ref.current?.getSkill()).not.toBeNull();

    seedCaretAtStartOfTrailingSpace(ref);
    pressKey("Backspace");

    await waitFor(() => {
      expect(ref.current?.getSkill()).toBeNull();
    });
  });
});

it("forwards combobox.hasPopup / expanded / controls to the textbox", () => {
  render(
    <InputEditor
      ariaLabel="Message"
      combobox={{ hasPopup: "listbox", expanded: true, controls: "my-listbox-id" }}
      onChange={noop}
      onChipsChange={noop}
    />,
  );
  const textbox = screen.getByRole("textbox", { name: "Message" });
  expect(textbox).toHaveAttribute("aria-haspopup", "listbox");
  expect(textbox).toHaveAttribute("aria-expanded", "true");
  expect(textbox).toHaveAttribute("aria-controls", "my-listbox-id");
});

it("sets aria-expanded to false when the picker is not active", () => {
  render(
    <InputEditor
      ariaLabel="Message"
      combobox={{ hasPopup: "listbox", expanded: false }}
      onChange={noop}
      onChipsChange={noop}
    />,
  );
  const textbox = screen.getByRole("textbox", { name: "Message" });
  expect(textbox).toHaveAttribute("aria-haspopup", "listbox");
  expect(textbox).toHaveAttribute("aria-expanded", "false");
  expect(textbox).not.toHaveAttribute("aria-controls");
});

it("forwards combobox.activeDescendant to the textbox when the picker is expanded", () => {
  render(
    <InputEditor
      ariaLabel="Message"
      combobox={{
        hasPopup: "listbox",
        expanded: true,
        controls: "my-listbox-id",
        activeDescendant: "my-option-id",
      }}
      onChange={noop}
      onChipsChange={noop}
    />,
  );
  const textbox = screen.getByRole("textbox", { name: "Message" });
  expect(textbox).toHaveAttribute("aria-activedescendant", "my-option-id");
});

it("omits aria-activedescendant when the picker is collapsed", () => {
  render(
    <InputEditor
      ariaLabel="Message"
      combobox={{ hasPopup: "listbox", expanded: false, activeDescendant: "my-option-id" }}
      onChange={noop}
      onChipsChange={noop}
    />,
  );
  const textbox = screen.getByRole("textbox", { name: "Message" });
  expect(textbox).not.toHaveAttribute("aria-activedescendant");
});

// ---------------------------------------------------------------------------
// Rich paste — link substitution
// ---------------------------------------------------------------------------

interface PasteOptions {
  plain?: string;
  html?: string;
  hasImageItem?: boolean;
}

async function pasteIntoEditor(ref: React.RefObject<InputEditorHandle | null>, opts: PasteOptions) {
  const { plain = "", html = "", hasImageItem = false } = opts;
  ref.current?.focus();
  fireEvent.paste(screen.getByRole("textbox"), {
    clipboardData: {
      items: hasImageItem ? [{ type: "image/png" }] : [],
      getData: (type: string) => (type === "text/plain" ? plain : type === "text/html" ? html : ""),
    },
  });
}

describe("InputEditor — rich paste (link substitution)", () => {
  it("replaces anchor label with href for a single rich-text link", async () => {
    const ref = createRef<InputEditorHandle>();
    render(<InputEditor ref={ref} onChange={noop} onChipsChange={noop} ariaLabel="Message" />);

    await pasteIntoEditor(ref, {
      plain: "Click here",
      html: '<a href="https://github.com/OmerMachluf/marshal">Click here</a>',
    });

    await waitFor(() =>
      expect(ref.current?.getPlainText()).toBe("https://github.com/OmerMachluf/marshal"),
    );
  });

  it("preserves surrounding plain text while substituting the anchor label", async () => {
    const ref = createRef<InputEditorHandle>();
    render(<InputEditor ref={ref} onChange={noop} onChipsChange={noop} ariaLabel="Message" />);

    await pasteIntoEditor(ref, {
      plain: "Repo link\ntimeout check 5 min",
      html: '<a href="https://github.com/OmerMachluf/marshal">Repo link</a>\ntimeout check 5 min',
    });

    await waitFor(() =>
      expect(ref.current?.getPlainText()).toBe(
        "https://github.com/OmerMachluf/marshal\ntimeout check 5 min",
      ),
    );
  });

  it("substitutes each of multiple anchors in document order", async () => {
    const ref = createRef<InputEditorHandle>();
    render(<InputEditor ref={ref} onChange={noop} onChipsChange={noop} ariaLabel="Message" />);

    await pasteIntoEditor(ref, {
      plain: "Doc A\nDoc B\nnotes",
      html: '<a href="https://github.com/OmerMachluf/a">Doc A</a>\n<a href="https://github.com/OmerMachluf/b">Doc B</a>\nnotes',
    });

    await waitFor(() =>
      expect(ref.current?.getPlainText()).toBe(
        "https://github.com/OmerMachluf/a\nhttps://github.com/OmerMachluf/b\nnotes",
      ),
    );
  });

  it("substitutes both anchors when two share the same display text (sequential replace)", async () => {
    const ref = createRef<InputEditorHandle>();
    render(<InputEditor ref={ref} onChange={noop} onChipsChange={noop} ariaLabel="Message" />);

    await pasteIntoEditor(ref, {
      plain: "Link Link",
      html: '<a href="https://example.com/a">Link</a> <a href="https://example.com/b">Link</a>',
    });

    await waitFor(() =>
      expect(ref.current?.getPlainText()).toBe("https://example.com/a https://example.com/b"),
    );
  });

  it("correctly substitutes two anchors whose label is a substring of their own href (domain-as-label)", async () => {
    const ref = createRef<InputEditorHandle>();
    render(<InputEditor ref={ref} onChange={noop} onChipsChange={noop} ariaLabel="Message" />);

    await pasteIntoEditor(ref, {
      plain: "github.com github.com",
      html: '<a href="https://github.com/foo">github.com</a> <a href="https://github.com/bar">github.com</a>',
    });

    await waitFor(() =>
      expect(ref.current?.getPlainText()).toBe("https://github.com/foo https://github.com/bar"),
    );
  });

  it("substitutes URL when anchor text contains non-breaking spaces (whitespace normalization)", async () => {
    const ref = createRef<InputEditorHandle>();
    render(<InputEditor ref={ref} onChange={noop} onChipsChange={noop} ariaLabel="Message" />);

    // Email and other rich clients emit NBSP (\u00a0) inside anchor text.
    // The plain-text clipboard copy uses regular spaces, so without normalization
    // label !== plain-text-snippet and the substitution is silently skipped.
    await pasteIntoEditor(ref, {
      plain: "Open ticket",
      html: '<a href="https://example.com/ticket">Open\u00a0ticket</a>',
    });

    await waitFor(() => expect(ref.current?.getPlainText()).toBe("https://example.com/ticket"));
  });

  it("inserts plain text as-is when there is no HTML data", async () => {
    const ref = createRef<InputEditorHandle>();
    render(<InputEditor ref={ref} onChange={noop} onChipsChange={noop} ariaLabel="Message" />);

    await pasteIntoEditor(ref, { plain: "hello world" });

    await waitFor(() => expect(ref.current?.getPlainText()).toBe("hello world"));
  });

  it("inserts plain text as-is when HTML has no <a> anchors", async () => {
    const ref = createRef<InputEditorHandle>();
    render(<InputEditor ref={ref} onChange={noop} onChipsChange={noop} ariaLabel="Message" />);

    await pasteIntoEditor(ref, { plain: "just text", html: "<p>just text</p>" });

    await waitFor(() => expect(ref.current?.getPlainText()).toBe("just text"));
  });

  it("inserts the URL as-is when anchor label already equals href (bare URL copy)", async () => {
    const ref = createRef<InputEditorHandle>();
    render(<InputEditor ref={ref} onChange={noop} onChipsChange={noop} ariaLabel="Message" />);

    await pasteIntoEditor(ref, {
      plain: "https://github.com/OmerMachluf/marshal",
      html: '<a href="https://github.com/OmerMachluf/marshal">https://github.com/OmerMachluf/marshal</a>',
    });

    await waitFor(() =>
      expect(ref.current?.getPlainText()).toBe("https://github.com/OmerMachluf/marshal"),
    );
  });

  it("inserts plain label text for mailto: anchors (no URL substitution)", async () => {
    const ref = createRef<InputEditorHandle>();
    render(<InputEditor ref={ref} onChange={noop} onChipsChange={noop} ariaLabel="Message" />);

    await pasteIntoEditor(ref, {
      plain: "email me",
      html: '<a href="mailto:user@example.com">email me</a>',
    });

    await waitFor(() => expect(ref.current?.getPlainText()).toBe("email me"));
  });

  it("inserts plain label text for file: anchors (no URL substitution)", async () => {
    const ref = createRef<InputEditorHandle>();
    render(<InputEditor ref={ref} onChange={noop} onChipsChange={noop} ariaLabel="Message" />);

    await pasteIntoEditor(ref, {
      plain: "local file",
      html: '<a href="file:///C:/Users/report.pdf">local file</a>',
    });

    await waitFor(() => expect(ref.current?.getPlainText()).toBe("local file"));
  });

  it("does not inject StartFragment/EndFragment comment text from Windows clipboard HTML", async () => {
    // Windows clipboard wraps HTML in <!--StartFragment--> / <!--EndFragment--> comments.
    // These appear in the HTML but not in the plain-text clipboard copy, so the
    // cursor-based alignment approach handles them naturally: labels are matched
    // against the plain text, comment node text is simply never present there.
    const ref = createRef<InputEditorHandle>();
    render(<InputEditor ref={ref} onChange={noop} onChipsChange={noop} ariaLabel="Message" />);

    await pasteIntoEditor(ref, {
      plain: "Open doc",
      html: '<!--StartFragment--><a href="https://example.com/doc">Open doc</a><!--EndFragment-->',
    });

    await waitFor(() => expect(ref.current?.getPlainText()).toBe("https://example.com/doc"));
  });

  it("does not concatenate aria-hidden duplicate label text after a substituted URL (office-app pattern)", async () => {
    // Office and chat apps often emit the anchor's visible
    // label a second time in a sibling aria-hidden element for screen readers.
    // aria-hidden content is absent from the plain-text clipboard copy, so cursor-based
    // alignment naturally ignores it. collectAnchors also skips aria-hidden subtrees
    // so no second substitution entry is collected.
    const ref = createRef<InputEditorHandle>();
    render(<InputEditor ref={ref} onChange={noop} onChipsChange={noop} ariaLabel="Message" />);

    await pasteIntoEditor(ref, {
      plain: "timeout check 5 min",
      html: '<a href="https://files.example.com/doc?e=bABOnB">timeout check 5 min</a><span aria-hidden="true">timeout check 5 min</span>',
    });

    await waitFor(() =>
      expect(ref.current?.getPlainText()).toBe("https://files.example.com/doc?e=bABOnB"),
    );
  });

  it("preserves a newline when a <br> separates an anchor from following text", async () => {
    // The plain-text clipboard copy already contains the \n; cursor-based alignment
    // preserves it by using the plain text as the output skeleton.
    const ref = createRef<InputEditorHandle>();
    render(<InputEditor ref={ref} onChange={noop} onChipsChange={noop} ariaLabel="Message" />);

    await pasteIntoEditor(ref, {
      plain: "Open doc\nnotes",
      html: '<a href="https://example.com/doc">Open doc</a><br>notes',
    });

    await waitFor(() => expect(ref.current?.getPlainText()).toBe("https://example.com/doc\nnotes"));
  });

  it("preserves whitespace between a substituted URL and adjacent text with no HTML separator", async () => {
    // Office and chat clipboard HTML often has no whitespace between </a> and
    // following text: `<a href="...">File.potx</a>timeout check 5 min`. The DOM-walk
    // approach concatenates them as URLtimeout; cursor-based alignment preserves the
    // newline from the plain-text clipboard copy instead.
    const ref = createRef<InputEditorHandle>();
    render(<InputEditor ref={ref} onChange={noop} onChipsChange={noop} ariaLabel="Message" />);

    await pasteIntoEditor(ref, {
      plain: "File.potx\ntimeout check 5 min",
      html: '<a href="https://files.example.com/doc.potx">File.potx</a>timeout check 5 min',
    });

    await waitFor(() =>
      expect(ref.current?.getPlainText()).toBe(
        "https://files.example.com/doc.potx\ntimeout check 5 min",
      ),
    );
  });

  it("does not insert text for image pastes (handled by attachment logic)", async () => {
    const ref = createRef<InputEditorHandle>();
    render(<InputEditor ref={ref} onChange={noop} onChipsChange={noop} ariaLabel="Message" />);

    await pasteIntoEditor(ref, { hasImageItem: true });

    expect(ref.current?.getPlainText()).toBe("");
  });
});
