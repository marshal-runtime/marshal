import { fireEvent, act, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { installMockAPIs, render, screen, userEvent } from "@/test-utils";

// Mock SlashCommandPicker which uses Radix Popover (incompatible with happy-dom)
vi.mock("./filepreview/commands/SlashCommandPicker", () => ({
  SlashCommandPicker: () => null,
}));
vi.mock("./filepreview/state/useSlashCommand", () => ({
  useSlashCommand: () => ({
    state: { isOpen: false, selectedIndex: 0 },
    filteredItems: [],
    onEditValueChange: () => {},
    setSelectedIndex: () => {},
    select: () => {},
    close: () => {},
    handleKeyDown: () => false,
  }),
}));
// Mock MonacoEditor (lazy-loaded) — render a simple textarea so unit tests work in happy-dom.
// `onMount` is forwarded with a minimal stub editor so the source-side scroll path
// (captureFromSource / applyToSource) is exercised in unit tests.
vi.mock("./filepreview/MonacoEditor", () => ({
  MonacoEditor: ({
    value,
    language,
    theme,
    testId,
    onChange,
    onMount,
  }: {
    value: string;
    language: string;
    theme: string;
    testId: string;
    onChange: (v: string | undefined) => void;
    onMount?: (editor: {
      getScrollTop: () => number;
      setScrollTop: (n: number) => void;
      getTopForLineNumber: (n: number) => number;
      getVisibleRanges: () => { startLineNumber: number; endLineNumber: number }[];
      onDidDispose: (listener: () => void) => { dispose: () => void };
    }) => void;
  }) => {
    const onMountRef = useRef(onMount);
    useEffect(() => {
      onMountRef.current?.({
        getScrollTop: () => 0,
        setScrollTop: vi.fn<(n: number) => void>(),
        getTopForLineNumber: () => 0,
        getVisibleRanges: () => [{ startLineNumber: 1, endLineNumber: 1 }],
        onDidDispose: () => ({ dispose: () => {} }),
      });
    }, []);
    return (
      <textarea
        data-testid={testId}
        data-language={language}
        data-theme={theme}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  },
}));

import { FilePreview } from "./FilePreview";

// ── Helpers ──────────────────────────────────────────────────────

// Segments:  0=heading, 1=blank, 2=para, 3=blank, 4=bulletA, 5=bulletB, 6=bulletC, 7=blank, 8=para
const SAMPLE_MD = [
  "# Heading One",
  "",
  "First paragraph line.",
  "",
  "- Bullet A",
  "- Bullet B",
  "- Bullet C",
  "",
  "Second paragraph.",
].join("\n");

// Segments: 0=title, 1=blank, 2=para, 3=blank, 4=codeblock, 5=blank, 6=para
const MULTILINE_MD = [
  "# Title",
  "",
  "Line one.",
  "",
  "```js",
  "const x = 1;",
  "const y = 2;",
  "```",
  "",
  "After code.",
].join("\n");

const FRONTMATTER_MD = [
  "---",
  'title: "Hidden Title"',
  "author: Someone",
  "---",
  "",
  "# Visible Heading",
  "",
  "Visible paragraph.",
].join("\n");

function mockReadFile(content: string, type: "markdown" | "text" | "html" | "image" = "markdown") {
  vi.mocked(window.workspaceAPI.readFile).mockResolvedValue({
    success: true,
    type,
    content,
  });
}

/** Render FilePreview and wait for content to load */
async function renderPreview(
  content: string,
  type: "markdown" | "text" | "html" = "markdown",
  filePath = "test.md",
) {
  mockReadFile(content, type);
  const view = render(<FilePreview filePath={filePath} />);
  await waitFor(() => {
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });
  return view;
}

/** Click a rendered segment div to enter edit mode (async — rAF needed) */
async function clickSegment(_container: HTMLElement, segIndex: number) {
  const seg = screen.getByTestId(`segment-${segIndex}`);
  await user.click(seg);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

/** Get the active textarea/input */
function getActiveInput(container: HTMLElement): HTMLTextAreaElement | null {
  return container.querySelector<HTMLTextAreaElement>(".md-seg-input, .md-seg-textarea");
}

/** Simulate pressing a key on an element */
function pressKey(
  el: HTMLElement,
  key: string,
  opts: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {},
) {
  // eslint-disable-next-line testing-library/prefer-user-event -- dispatches on specific element, not focused element
  fireEvent.keyDown(el, { key, ...opts });
}

/** Count segments in the editor */
function countSegments(container: HTMLElement) {
  return container.querySelectorAll("[data-testid^='segment-']").length;
}

/** Flush rAF / timers after key events that use requestAnimationFrame */
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

// ── Setup ────────────────────────────────────────────────────────

let user: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  user = userEvent.setup();
  installMockAPIs();
  document.documentElement.setAttribute("data-theme", "light");
  Object.defineProperty(navigator, "clipboard", {
    value: {
      readText: vi.fn<() => Promise<string>>().mockResolvedValue(""),
      writeText: vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined),
    },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("data-theme");
});

describe("File access", () => {
  it("forwards a runtime document capability when reading an outside file", async () => {
    mockReadFile("# Outside");

    render(<FilePreview filePath="/outside/report.md" readCapability="runtime-document-token" />);

    await waitFor(() =>
      expect(window.workspaceAPI.readFile).toHaveBeenCalledWith(
        "/outside/report.md",
        "runtime-document-token",
      ),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// MARKDOWN RENDERING
// ═══════════════════════════════════════════════════════════════════

describe("Markdown rendering", () => {
  it("hides leading YAML frontmatter in preview", async () => {
    const { container } = await renderPreview(FRONTMATTER_MD);

    expect(screen.getByText("Visible Heading")).toBeInTheDocument();
    expect(screen.getByText("Visible paragraph.")).toBeInTheDocument();
    expect(screen.queryByText('title: "Hidden Title"')).not.toBeInTheDocument();
    expect(screen.queryByText("author: Someone")).not.toBeInTheDocument();
    expect(countSegments(container)).toBe(3);
  });

  it("hides large leading YAML frontmatter blocks in preview", async () => {
    const largeFrontmatter = [
      "---",
      ...Array.from({ length: 120 }, (_, i) => `field${i}: value${i}`),
      "---",
      "",
      "# Visible After Large Frontmatter",
    ].join("\n");

    await renderPreview(largeFrontmatter);

    expect(screen.getByText("Visible After Large Frontmatter")).toBeInTheDocument();
    expect(screen.queryByText("field0: value0")).not.toBeInTheDocument();
    expect(screen.queryByText("field119: value119")).not.toBeInTheDocument();
  });

  it("normalizes CRLF line endings so markdown renders correctly", async () => {
    // Simulate a file from a Windows email client with \r\n line endings
    const crlfContent =
      "# Heading\r\n\r\n| A | B |\r\n| --- | --- |\r\n| 1 | 2 |\r\n\r\n- bullet one\r\n- bullet two\r\n";
    const { container } = await renderPreview(crlfContent);

    // Heading should render (regex would fail with trailing \r)
    expect(screen.getByText("Heading")).toBeInTheDocument();
    // Table should render as InteractiveTable (not raw pipe chars)
    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
    expect(container.querySelector("table")).toBeTruthy();
    // Bullets should render
    expect(screen.getByText("bullet one")).toBeInTheDocument();
    expect(screen.getByText("bullet two")).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════
// NAVIGATION (13 tests)
// ═══════════════════════════════════════════════════════════════════

describe("Navigation", () => {
  // Segments: 0=heading, 1=blank, 2=para, 3=blank, 4=bulletA, 5=bulletB, 6=bulletC, 7=blank, 8=para

  it("arrow down in single-line edit moves to next segment", async () => {
    const { container } = await renderPreview(SAMPLE_MD);
    await clickSegment(container, 0); // heading
    const input = getActiveInput(container)!;
    expect(input).toBeTruthy();
    expect(input.value).toBe("# Heading One");

    await act(async () => {
      input.setSelectionRange(3, 3); // middle of text
      pressKey(input, "ArrowDown");
    });
    await flush();

    // Should have moved to seg 1 (blank)
    const newInput = getActiveInput(container);
    expect(newInput).toBeTruthy();
    expect(newInput!.value).toBe(""); // blank segment
  });

  it("arrow up in single-line edit moves to previous segment", async () => {
    const { container } = await renderPreview(SAMPLE_MD);
    await clickSegment(container, 5); // Bullet B
    const input = getActiveInput(container)!;
    expect(input).toBeTruthy();
    expect(input.value).toBe("- Bullet B");

    await act(async () => {
      input.setSelectionRange(5, 5); // middle
      pressKey(input, "ArrowUp");
    });
    await flush();

    const newInput = getActiveInput(container);
    expect(newInput).toBeTruthy();
    expect(newInput!.value).toBe("- Bullet A");
  });

  it("arrow up at middle of single-line still navigates (not stuck at pos 0)", async () => {
    const { container } = await renderPreview(SAMPLE_MD);
    await clickSegment(container, 6); // Bullet C
    const input = getActiveInput(container)!;

    await act(async () => {
      input.setSelectionRange(5, 5); // middle
      pressKey(input, "ArrowUp");
    });
    await flush();

    const newInput = getActiveInput(container);
    expect(newInput).toBeTruthy();
    expect(newInput!.value).toBe("- Bullet B");
  });

  it("arrow down in multi-line textarea at end moves to next segment", async () => {
    const { container } = await renderPreview(MULTILINE_MD);
    // seg 4 = code block (multi-line textarea)
    await clickSegment(container, 4);
    const ta = getActiveInput(container)!;
    expect(ta).toBeTruthy();
    expect(ta.value).toContain("const x");

    await act(async () => {
      ta.setSelectionRange(ta.value.length, ta.value.length);
      pressKey(ta, "ArrowDown");
    });
    await flush();

    const newInput = getActiveInput(container);
    expect(newInput).toBeTruthy();
    expect(newInput!.value).not.toContain("const x");
  });

  it("arrow up in multi-line textarea at start moves to previous segment", async () => {
    const { container } = await renderPreview(MULTILINE_MD);
    await clickSegment(container, 4); // code block
    const ta = getActiveInput(container)!;

    await act(async () => {
      ta.setSelectionRange(0, 0);
      pressKey(ta, "ArrowUp");
    });
    await flush();

    const newInput = getActiveInput(container);
    expect(newInput).toBeTruthy();
    expect(newInput!.value).not.toContain("const x");
  });

  it("arrow down from single-line places cursor at start of next segment", async () => {
    const { container } = await renderPreview(SAMPLE_MD);
    await clickSegment(container, 4); // Bullet A
    const input = getActiveInput(container)!;

    await act(async () => {
      input.setSelectionRange(3, 3);
      pressKey(input, "ArrowDown");
    });
    await flush();

    const newInput = getActiveInput(container);
    expect(newInput).toBeTruthy();
    expect(newInput!.value).toBe("- Bullet B");
    // Cursor should be at position 0 (start)
    expect(newInput!.selectionStart).toBe(0);
  });

  it("arrow up from single-line places cursor at end of previous segment", async () => {
    const { container } = await renderPreview(SAMPLE_MD);
    await clickSegment(container, 5); // Bullet B
    const input = getActiveInput(container)!;

    await act(async () => {
      input.setSelectionRange(3, 3);
      pressKey(input, "ArrowUp");
    });
    await flush();

    const newInput = getActiveInput(container);
    expect(newInput).toBeTruthy();
    expect(newInput!.value).toBe("- Bullet A");
    // Cursor should be at end
    expect(newInput!.selectionStart).toBe("- Bullet A".length);
  });

  it("arrow down on last line of multiline places cursor at start of next segment", async () => {
    const { container } = await renderPreview(MULTILINE_MD);
    await clickSegment(container, 4); // code block
    const ta = getActiveInput(container)!;
    expect(ta.value).toContain("const x");

    await act(async () => {
      // Position at last line
      ta.setSelectionRange(ta.value.length, ta.value.length);
      pressKey(ta, "ArrowDown");
    });
    await flush();

    const newInput = getActiveInput(container);
    expect(newInput).toBeTruthy();
    expect(newInput!.value).not.toContain("const x");
    // Cursor should be at start
    expect(newInput!.selectionStart).toBe(0);
  });

  it("arrow up on first line of multiline places cursor at end of previous segment", async () => {
    const { container } = await renderPreview(MULTILINE_MD);
    await clickSegment(container, 4); // code block
    const ta = getActiveInput(container)!;

    await act(async () => {
      // Position at first line (position 0)
      ta.setSelectionRange(0, 0);
      pressKey(ta, "ArrowUp");
    });
    await flush();

    const newInput = getActiveInput(container);
    expect(newInput).toBeTruthy();
    expect(newInput!.value).not.toContain("const x");
    // Cursor should be at end of previous segment
    expect(newInput!.selectionStart).toBe(newInput!.value.length);
  });

  it("arrow down on middle line of multiline stays in same segment", async () => {
    const { container } = await renderPreview(MULTILINE_MD);
    await clickSegment(container, 4); // code block: ```js\nconst x = 1;\nconst y = 2;\n```
    const ta = getActiveInput(container)!;
    expect(ta.value).toContain("const x");

    // Position cursor on the first line (```js)
    await act(async () => {
      ta.setSelectionRange(2, 2); // middle of "```js"
      pressKey(ta, "ArrowDown");
    });
    await flush();

    // Should still be the same segment (code block), NOT the next segment
    const current = getActiveInput(container);
    expect(current).toBeTruthy();
    expect(current!.value).toContain("const x");
  });

  it("arrow left at position 0 moves to previous segment", async () => {
    const { container } = await renderPreview(SAMPLE_MD);
    await clickSegment(container, 5); // Bullet B
    const input = getActiveInput(container)!;

    await act(async () => {
      input.setSelectionRange(0, 0);
      pressKey(input, "ArrowLeft");
    });
    await flush();

    const newInput = getActiveInput(container);
    expect(newInput).toBeTruthy();
    expect(newInput!.value).toBe("- Bullet A");
  });

  it("arrow right at end moves to next segment", async () => {
    const { container } = await renderPreview(SAMPLE_MD);
    await clickSegment(container, 4); // Bullet A
    const input = getActiveInput(container)!;

    await act(async () => {
      input.setSelectionRange(input.value.length, input.value.length);
      pressKey(input, "ArrowRight");
    });
    await flush();

    const newInput = getActiveInput(container);
    expect(newInput).toBeTruthy();
    expect(newInput!.value).toBe("- Bullet B");
  });

  // eslint-disable-next-line vitest/warn-todo
  it.todo("arrow left on rendered selection collapses to start"); // Covered by e2e/editor-selection.marshal.test.ts

  // eslint-disable-next-line vitest/warn-todo
  it.todo("arrow right on rendered selection collapses to end"); // Covered by e2e/editor-selection.marshal.test.ts

  // eslint-disable-next-line vitest/warn-todo
  it.todo("arrow up on rendered selection activates start segment"); // Covered by e2e/editor-selection.marshal.test.ts

  // eslint-disable-next-line vitest/warn-todo
  it.todo("arrow down on rendered selection activates end segment"); // Covered by e2e/editor-selection.marshal.test.ts

  it("click on rendered segment enters edit mode", async () => {
    const { container } = await renderPreview(SAMPLE_MD);
    expect(getActiveInput(container)).toBeNull();

    await clickSegment(container, 0);

    const input = getActiveInput(container);
    expect(input).toBeTruthy();
    expect(input!.value).toBe("# Heading One");
  });

  it("blur commits edit and deactivates", async () => {
    const { container } = await renderPreview(SAMPLE_MD);
    await clickSegment(container, 0);
    const input = getActiveInput(container)!;

    await user.clear(input);
    await user.type(input, "# Updated Heading");

    fireEvent.blur(input);
    await flush();

    expect(getActiveInput(container)).toBeNull();
    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
    const seg = container.querySelector(".md-seg");
    expect(seg?.textContent).toContain("Updated Heading");
  });
});

// ═══════════════════════════════════════════════════════════════════
// SELECTION (6 tests)
// ═══════════════════════════════════════════════════════════════════
// NOTE: All selection tests are skipped — happy-dom does not implement
// the DOM Selection API (containsNode, collapse, extend, addRange).
// These behaviors are verified via CDP E2E tests (e2e-real/).
// ═══════════════════════════════════════════════════════════════════

describe("Selection", () => {
  // eslint-disable-next-line vitest/warn-todo
  it.todo("shift+arrow down from edit mode creates cross-segment selection"); // Covered by e2e/editor-selection.marshal.test.ts

  // eslint-disable-next-line vitest/warn-todo
  it.todo("shift+arrow up from edit mode creates cross-segment selection upward"); // Covered by e2e/editor-selection.marshal.test.ts

  // eslint-disable-next-line vitest/warn-todo
  it.todo("shift+click from edit mode creates range selection"); // Covered by e2e/editor-selection.marshal.test.ts

  // eslint-disable-next-line vitest/warn-todo
  it.todo("shift+click extends existing selection"); // Covered by e2e/editor-selection.marshal.test.ts

  it("clicking a segment clears multi-segment selection", async () => {
    const { container } = await renderPreview(SAMPLE_MD);
    await clickSegment(container, 4); // Bullet A
    const input = getActiveInput(container)!;

    await act(async () => {
      input.setSelectionRange(input.value.length, input.value.length);
      pressKey(input, "ArrowDown", { shiftKey: true });
    });
    await flush();

    // Now click without shift
    await clickSegment(container, 0);

    const active = getActiveInput(container);
    expect(active).toBeTruthy();
    expect(active!.value).toBe("# Heading One");
  });

  it("clicking outside editor deactivates edit mode", async () => {
    const { container } = await renderPreview(SAMPLE_MD);
    await clickSegment(container, 0);
    expect(getActiveInput(container)).toBeTruthy();

    // Blur by clicking outside
    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
    const wrapper = container.querySelector("[data-testid='file-preview-root']")!;
    // eslint-disable-next-line testing-library/prefer-user-event -- deliberate mouseDown-only to test blur
    fireEvent.mouseDown(wrapper);
    fireEvent.blur(getActiveInput(container)!);
    await flush();

    expect(getActiveInput(container)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// EDITING (7 tests)
// ═══════════════════════════════════════════════════════════════════

describe("Editing", () => {
  it("backspace at line start merges with previous line", async () => {
    const { container } = await renderPreview(SAMPLE_MD);
    await clickSegment(container, 5); // Bullet B
    const input = getActiveInput(container)!;
    const initialCount = countSegments(container);

    await act(async () => {
      input.setSelectionRange(0, 0);
      pressKey(input, "Backspace");
    });
    await flush();

    expect(countSegments(container)).toBeLessThan(initialCount);
  });

  // eslint-disable-next-line vitest/warn-todo
  it.todo("backspace with text selection deletes selected text"); // Covered by e2e/editor-selection.marshal.test.ts

  it("enter at line start pushes line down", async () => {
    const { container } = await renderPreview(SAMPLE_MD);
    await clickSegment(container, 0); // heading
    const input = getActiveInput(container)!;
    const initialCount = countSegments(container);

    await act(async () => {
      input.setSelectionRange(0, 0);
      pressKey(input, "Enter");
    });
    await flush();

    expect(countSegments(container)).toBeGreaterThan(initialCount);
  });

  it("enter in middle of line splits segment", async () => {
    const { container } = await renderPreview(SAMPLE_MD);
    await clickSegment(container, 0); // heading
    const input = getActiveInput(container)!;
    const initialCount = countSegments(container);

    await act(async () => {
      input.setSelectionRange(5, 5);
      pressKey(input, "Enter");
    });
    await flush();

    expect(countSegments(container)).toBeGreaterThan(initialCount);
  });

  it("enter in middle of paragraph splits into two paragraph segments (not soft-broken)", async () => {
    // Regression for the mdast migration: pre-mdast each line was its own
    // segment so the existing splitter worked. Post-mdast, two consecutive
    // non-blank lines parse as ONE paragraph with a soft break, so the
    // splitter must insert a blank line between the halves to keep them
    // as distinct segments. Paired with e2e/editor-selection.marshal.test.ts:1686.
    const { container } = await renderPreview(SAMPLE_MD);
    await clickSegment(container, 2); // "First paragraph line."
    const input = getActiveInput(container)!;
    const initialCount = countSegments(container);

    await act(async () => {
      // Cursor between "First" and " paragraph line."
      input.setSelectionRange(5, 5);
      pressKey(input, "Enter");
    });
    await flush();

    expect(countSegments(container)).toBeGreaterThan(initialCount);
    // Both halves should remain visible
    expect(container.textContent).toContain("First");
    expect(container.textContent).toContain("paragraph line.");
  });

  it("typing in edit mode updates textarea value", async () => {
    const { container } = await renderPreview(SAMPLE_MD);
    await clickSegment(container, 0);
    const input = getActiveInput(container)!;

    await user.clear(input);
    await user.type(input, "# New Heading");

    expect(getActiveInput(container)!.value).toBe("# New Heading");
  });

  it("paste single line inserts content", async () => {
    const { container } = await renderPreview(SAMPLE_MD);
    await clickSegment(container, 0);
    const input = getActiveInput(container)!;

    input.setSelectionRange(2, 2);
    fireEvent.paste(input, {
      clipboardData: { getData: () => "PASTED" },
    });
    await flush();

    const active = getActiveInput(container);
    expect(active).toBeTruthy();
    expect(active!.value).toContain("PASTED");
  });

  it("paste multiline content increases segment count", async () => {
    const { container } = await renderPreview(SAMPLE_MD);
    await clickSegment(container, 0);
    const input = getActiveInput(container)!;
    const initialCount = countSegments(container);

    input.setSelectionRange(2, 2);
    fireEvent.paste(input, {
      clipboardData: { getData: () => "Line1\nLine2\nLine3" },
    });
    await flush();

    expect(countSegments(container)).toBeGreaterThan(initialCount);
  });

  // Regression: Cmd+Z while editing a segment must not wipe the whole
  // paragraph. The global handler now bails out so native textarea undo handles it.
  // Pre-fix value would be "# Heading One" (via setEditValue(originalText));
  // post-fix, no React state change happens so the typed text survives.
  it.each([
    { mod: { metaKey: true } as const, name: "cmd" },
    { mod: { ctrlKey: true } as const, name: "ctrl" },
  ])("$name+z while editing does not wipe typed text or deactivate segment", async ({ mod }) => {
    const { container } = await renderPreview(SAMPLE_MD);
    await clickSegment(container, 0); // heading: "# Heading One"
    const input = getActiveInput(container)!;
    expect(input.value).toBe("# Heading One");

    await user.type(input, " plus more");
    const valBefore = getActiveInput(container)!.value;
    expect(valBefore).toBe("# Heading One plus more");

    await act(async () => {
      pressKey(input, "z", mod);
    });
    await flush();

    const stillActive = getActiveInput(container);
    expect(stillActive).toBeTruthy();
    // Word-boundary undo must actually fire (value changed from pre-undo).
    expect(stillActive!.value).not.toBe(valBefore);
    // Must not wipe to the original (the original bug).
    expect(stillActive!.value).not.toBe("# Heading One");
    // Word-boundary chunking pins the exact post-undo value: " more" is removed
    // as one group (boundary char " " is included in the previous group, so it
    // remains). Char-by-char undo would yield "# Heading One plus mor".
    expect(stillActive!.value).toBe("# Heading One plus ");
  });

  it("cmd+shift+z while editing does not deactivate segment", async () => {
    const { container } = await renderPreview(SAMPLE_MD);
    await clickSegment(container, 0);
    const input = getActiveInput(container)!;

    await user.type(input, "X");

    await act(async () => {
      pressKey(input, "z", { metaKey: true, shiftKey: true });
    });
    await flush();

    expect(getActiveInput(container)).toBeTruthy();
  });

  // Regression guard for the editUndoHandledRef bridge: an in-segment Cmd+Z
  // must NOT consume a doc-level undo entry. If a refactor ever stops setting
  // the flag, both handlers fire and `undoStack` gets depleted invisibly.
  it("in-segment cmd+z does not consume a doc-level undo entry", async () => {
    const { container } = await renderPreview(SAMPLE_MD);

    // Seed a doc-level undo entry: edit + commit segment 0.
    await clickSegment(container, 0);
    let input = getActiveInput(container)!;
    await user.type(input, " A");
    await act(async () => {
      pressKey(input, "Escape");
    });
    await flush();

    // Re-enter and type a new word that lives only in the edit-level stack.
    await clickSegment(container, 0);
    input = getActiveInput(container)!;
    await user.type(input, " B");
    expect(getActiveInput(container)!.value).toContain(" B");

    // In-segment Cmd+Z — should be handled by the textarea handler.
    await act(async () => {
      pressKey(input, "z", { metaKey: true });
    });
    await flush();

    // Must still be in the segment; " A" must still be present (doc-level
    // undo was NOT triggered — that would have rolled back the committed " A").
    const stillActive = getActiveInput(container);
    expect(stillActive).toBeTruthy();
    expect(stillActive!.value).toContain(" A");
  });
});

// ═══════════════════════════════════════════════════════════════════
// COPY (3 tests)
// ═══════════════════════════════════════════════════════════════════

describe("Copy", () => {
  // eslint-disable-next-line vitest/warn-todo
  it.todo("copy in edit mode with selection writes to navigator.clipboard"); // Covered by e2e/editor-selection.marshal.test.ts

  it("copy multi-segment selection includes newlines", async () => {
    const { container } = await renderPreview(SAMPLE_MD);
    await clickSegment(container, 4);
    const input = getActiveInput(container)!;

    await act(async () => {
      input.setSelectionRange(input.value.length, input.value.length);
      pressKey(input, "ArrowDown", { shiftKey: true });
    });
    await flush();

    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
    const editor = container.querySelector<HTMLElement>(".md-custom-editor")!;
    await act(async () => {
      expect(editor).toBeInstanceOf(Element);
      pressKey(editor, "c", { metaKey: true });
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalled();
    const calls = vi.mocked(navigator.clipboard.writeText).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const copied: string = calls[calls.length - 1][0];
    expect(copied).toContain("\n");
  });

  it("cmd+c with collapsed cursor does not call navigator.clipboard.writeText", async () => {
    const { container } = await renderPreview(SAMPLE_MD);
    await clickSegment(container, 0);
    const input = getActiveInput(container)!;

    vi.mocked(navigator.clipboard.writeText).mockClear();

    await act(async () => {
      input.setSelectionRange(3, 3); // collapsed
      pressKey(input, "c", { metaKey: true });
    });

    // With collapsed selection in single-segment edit, our handler
    // only fires for multi-segment or when there's actual selection
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// CLIPBOARD ERROR HANDLING
// ═══════════════════════════════════════════════════════════════════

describe("clipboard error handling", () => {
  it("Cmd+C with failing writeText doesn't crash the component", async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new Error("Permission denied"));
    const { container } = await renderPreview(SAMPLE_MD);

    // Select a segment and trigger copy from rendered mode
    await clickSegment(container, 0);
    const input = getActiveInput(container)!;
    await act(async () => {
      input.setSelectionRange(0, input.value.length);
      pressKey(input, "ArrowDown", { shiftKey: true });
    });
    await flush();

    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
    const editor = container.querySelector<HTMLElement>(".md-custom-editor")!;
    // Should not throw even though writeText rejects
    await act(async () => {
      pressKey(editor, "c", { metaKey: true });
    });
    await flush();

    // Component still renders — no crash
    expect(countSegments(container)).toBeGreaterThan(0);
  });

  it("Cmd+V with failing readText doesn't crash in edit mode", async () => {
    vi.mocked(navigator.clipboard.readText).mockRejectedValue(new Error("Permission denied"));
    const { container } = await renderPreview(SAMPLE_MD);

    await clickSegment(container, 0);
    const input = getActiveInput(container)!;
    const originalValue = input.value;

    // Paste in edit mode — readText rejects, component should handle gracefully
    await act(async () => {
      pressKey(input, "v", { metaKey: true });
    });
    await flush();

    // Content unchanged (no paste occurred) and component still renders
    expect(countSegments(container)).toBeGreaterThan(0);
    expect(getActiveInput(container)?.value).toBe(originalValue);
  });
});

// ═══════════════════════════════════════════════════════════════════
// EXTERNAL FOCUS GUARD (keyboard shortcuts should not fire when
// focus is on an editable element outside the editor)
// ═══════════════════════════════════════════════════════════════════

describe("External focus guard", () => {
  it("ctrl+v on an external textarea does not paste into the editor", async () => {
    const { container } = await renderPreview(SAMPLE_MD);
    const initialCount = countSegments(container);

    // Create an external textarea (simulating the chat input) and focus it
    const externalInput = document.createElement("textarea");
    document.body.appendChild(externalInput);
    externalInput.focus();

    vi.mocked(navigator.clipboard.readText).mockResolvedValue("external paste");

    // Dispatch Ctrl+V on the document (as the global keydown handler would see it)
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true }),
      );
    });
    await flush();

    // Editor should be unaffected — no new segments from pasted content
    expect(countSegments(container)).toBe(initialCount);

    document.body.removeChild(externalInput);
  });

  it("ctrl+c with editor selection does not copy when external input is focused", async () => {
    const { container } = await renderPreview(SAMPLE_MD);

    // Create a cross-segment selection (same approach as the "copy multi-segment" test)
    await clickSegment(container, 4); // Bullet A
    const input = getActiveInput(container)!;
    await act(async () => {
      input.setSelectionRange(input.value.length, input.value.length);
      pressKey(input, "ArrowDown", { shiftKey: true });
    });
    await flush();

    // Verify selection was created — getSelection should be non-collapsed
    const sel = window.getSelection();
    expect(sel?.isCollapsed).toBe(false);

    // Now focus an external input (simulating the chat prompt)
    const externalInput = document.createElement("textarea");
    document.body.appendChild(externalInput);
    externalInput.focus();

    vi.mocked(navigator.clipboard.writeText).mockClear();

    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
    const editor = container.querySelector<HTMLElement>(".md-custom-editor")!;
    await act(async () => {
      pressKey(editor, "c", { metaKey: true });
    });
    await flush();

    // Guard should block the copy — clipboard.writeText must not be called
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();

    document.body.removeChild(externalInput);
  });
});

// ═══════════════════════════════════════════════════════════════════
// COMMENTS (5 tests)
// ═══════════════════════════════════════════════════════════════════

describe("Comments", () => {
  // Cmd+K requires window.getSelection() positioned in editor — not supported in happy-dom.
  // Covered by E2E tests in editor-selection.test.ts.
  // eslint-disable-next-line vitest/warn-todo
  it.todo("cmd+k adds a comment segment after active segment", async () => {
    const { container } = await renderPreview(SAMPLE_MD);
    await clickSegment(container, 2); // "First paragraph line."
    const initialCount = countSegments(container);

    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
    const editor = container.querySelector<HTMLElement>(".md-custom-editor")!;
    await act(async () => {
      pressKey(editor, "k", { metaKey: true });
    });
    await flush();

    expect(countSegments(container)).toBeGreaterThan(initialCount);
    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
    const comment = container.querySelector(".md-seg-comment, [data-testid='comment-thread']");
    expect(comment).toBeTruthy();
  });

  it("cmd+k on multi-segment selection creates anchored comment with markers", async () => {
    const { container } = await renderPreview(SAMPLE_MD);
    await clickSegment(container, 4); // Bullet A
    const input = getActiveInput(container)!;

    await act(async () => {
      input.setSelectionRange(input.value.length, input.value.length);
      pressKey(input, "ArrowDown", { shiftKey: true });
    });
    await flush();

    const initialCount = countSegments(container);
    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
    const editor = container.querySelector<HTMLElement>(".md-custom-editor")!;

    await act(async () => {
      pressKey(editor, "k", { metaKey: true });
    });
    await flush();

    // Should have added comment + anchor markers (blank segments count up)
    expect(countSegments(container)).toBeGreaterThan(initialCount);
  });

  // eslint-disable-next-line vitest/warn-todo
  it.todo("comment renders with bubble UI after adding", async () => {
    const md = "# Title\n\nSome text.";
    const { container } = await renderPreview(md);
    await clickSegment(container, 2); // "Some text."

    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
    const editor = container.querySelector<HTMLElement>(".md-custom-editor")!;
    await act(async () => {
      pressKey(editor, "k", { metaKey: true });
    });
    await flush();

    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
    const commentThread = container.querySelector("[data-testid='comment-thread']");
    expect(commentThread).toBeTruthy();
  });

  it("context menu shows Add Comment with keyboard shortcut", async () => {
    const { container } = await renderPreview(SAMPLE_MD);
    const segs = screen.getAllByTestId(/^segment-/);

    fireEvent.contextMenu(segs[2], { clientX: 100, clientY: 100 });
    await flush();

    // Custom context menu rendered as a fixed div
    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
    const menuButtons = container.ownerDocument.querySelectorAll(".fixed.z-50 button");
    const texts = Array.from(menuButtons).map((b) => b.textContent);
    expect(texts.some((t) => t?.includes("Add Comment"))).toBe(true);
    expect(texts.some((t) => t?.match(/⌘K|CtrlK/))).toBe(true);
    expect(screen.getByLabelText(/⌘K|Ctrl\+K/)).toHaveAttribute("data-slot", "kbd-group");
  });
});

// ═══════════════════════════════════════════════════════════════════
// VISUAL STABILITY (2 tests)
// ═══════════════════════════════════════════════════════════════════

describe("Visual stability", () => {
  it("active segment gets md-seg-active class", async () => {
    const { container } = await renderPreview(SAMPLE_MD);
    await clickSegment(container, 0);

    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
    const activeSeg = container.querySelector(".md-seg-active");
    expect(activeSeg).toBeTruthy();
    expect(activeSeg!.classList.contains("md-seg-active")).toBe(true);
  });

  it("bullet segments render bullet marker span", async () => {
    const md = "- Bullet item";
    const { container } = await renderPreview(md);

    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
    const bullet = container.querySelector("[data-testid='bullet-marker']");
    expect(bullet).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════
// BINARY FILE HANDLING (2 tests)
// ═══════════════════════════════════════════════════════════════════

describe("Binary file handling", () => {
  it("renders Open card for .docx files without loading content", async () => {
    // Binary detection happens before readFile, so even error is okay
    mockReadFile("", "text");
    render(<FilePreview filePath="report.docx" />);

    await waitFor(() => {
      expect(screen.getByText("report.docx")).toBeInTheDocument();
      expect(screen.getByText(".DOCX file")).toBeInTheDocument();
      expect(screen.getByText(/Open in/)).toBeInTheDocument();
      expect(screen.getByText("Show in Explorer")).toBeInTheDocument();
    });
  });

  it("renders markdown editor for .md files (not binary)", async () => {
    await renderPreview("# Hello");

    expect(screen.queryByText(/Open in/)).not.toBeInTheDocument();
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("renders HTML files in a sandboxed iframe preview", async () => {
    const html =
      "<!doctype html><html><body><h1>Hello HTML</h1><p>Rendered preview</p></body></html>";

    await renderPreview(html, "html", "test.html");

    expect(screen.getByRole("button", { name: "Preview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Source" })).toBeInTheDocument();
    const iframe = screen.getByTestId("html-preview");
    expect(iframe).toBeInTheDocument();
    expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
    expect(iframe).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(iframe).toHaveAttribute(
      "src",
      "local-preview://preview/__relative__/test.html?marshalTheme=light",
    );
    expect(iframe).toHaveClass("block", "size-full", "border-none", "bg-background");
    expect(screen.queryByText("Hello HTML")).not.toBeInTheDocument();
  });

  it("uses a scoped preview url so HTML previews keep a real document location", async () => {
    const html = "<!doctype html><html><head></head><body><img src='diagram.png'></body></html>";

    await renderPreview(
      html,
      "html",
      "C:\\Users\\test\\Documents\\Marshal\\Projects\\Groups & Orgs\\Project Inception\\Project_Inception_People_Map.html",
    );

    const iframe = screen.getByTestId("html-preview");
    expect(iframe).toHaveAttribute(
      "src",
      "local-preview://preview/C%3A%2FUsers%2Ftest%2FDocuments%2FMarshal%2FProjects%2FGroups%20%26%20Orgs%2FProject%20Inception/Project_Inception_People_Map.html?marshalTheme=light",
    );
  });

  it("updates the HTML preview url when the app theme changes", async () => {
    const html = "<!doctype html><html><body>Theme aware</body></html>";

    await renderPreview(html, "html", "test.html");

    await act(async () => {
      document.documentElement.setAttribute("data-theme", "dark");
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("html-preview")).toHaveAttribute(
        "src",
        "local-preview://preview/__relative__/test.html?marshalTheme=dark",
      );
    });
  });

  it("renders inline html blocks inside markdown files", async () => {
    const markdown = [
      "---",
      "title: Test Person",
      "---",
      "",
      "# Notes",
      "",
      '<div style="display: flex; gap: 12px;">',
      '  <img src="../.images/test.jpg" alt="Test Person" width="120">',
      "  <div>",
      "    <h2>Summary</h2>",
      "    <p>Rendered from inline HTML.</p>",
      "  </div>",
      "</div>",
    ].join("\n");

    const { container } = await renderPreview(
      markdown,
      "markdown",
      "C:\\Users\\test\\Documents\\Marshal\\Projects\\People\\1-My Manager\\person.md",
    );

    expect(screen.getByText("Notes")).toBeInTheDocument();
    expect(screen.getByText("Summary")).toBeInTheDocument();
    expect(screen.getByText("Rendered from inline HTML.")).toBeInTheDocument();
    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access -- verifying resolved inline HTML asset rendering
    const layout = container.querySelector('div[style*="display: flex"]');
    expect(layout).toBeTruthy();
    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access -- verifying resolved inline HTML asset rendering
    const image = container.querySelector('img[alt="Test Person"]');
    expect(image).toBeTruthy();
    expect(image).toHaveAttribute(
      "src",
      "local-file:///C:/Users/test/Documents/Marshal/Projects/People/.images/test.jpg",
    );
  });

  it("does not treat horizontal rules as frontmatter", async () => {
    const markdown = ["---", "", "Actual paragraph", "", "---"].join("\n");

    await renderPreview(markdown);

    expect(screen.getByText("Actual paragraph")).toBeInTheDocument();
    expect(screen.getAllByRole("separator")).toHaveLength(2);
  });

  it("falls back to a single-line HTML block when the closing tag is missing", async () => {
    const markdown = ["# Notes", "", "<div>", "still text", "", "After the broken block"].join(
      "\n",
    );

    await renderPreview(markdown, "markdown", "C:\\Users\\test\\Documents\\notes.md");

    expect(screen.getByText("Notes")).toBeInTheDocument();
    expect(screen.getByText("still text")).toBeInTheDocument();
    expect(screen.getByText("After the broken block")).toBeInTheDocument();
  });

  it("lets HTML files switch between preview and source mode", async () => {
    const html = "<!doctype html><html><body><h1>Hello HTML</h1></body></html>";

    await renderPreview(html, "html", "test.html");

    await user.click(screen.getByRole("button", { name: "Source" }));

    expect(screen.queryByTestId("html-preview")).not.toBeInTheDocument();
    expect(await screen.findByTestId("source-editor")).toHaveValue(html);

    await user.click(screen.getByRole("button", { name: "Preview" }));

    expect(screen.getByTestId("html-preview")).toBeInTheDocument();
  });

  it("restores preview scroll position after toggling source -> preview", async () => {
    // Regression-pin for the scroll-reset bug. Mental revert of the
    // captureFromPreview / applyToPreview / applyToSource calls in FilePreview
    // would silently land scrollTopValue at 0 here.
    await renderPreview(SAMPLE_MD);
    const scrollContainer = screen.getByTestId("file-preview-content");
    let scrollTopValue = 0;
    Object.defineProperty(scrollContainer, "scrollHeight", {
      get: () => 1000,
      configurable: true,
    });
    Object.defineProperty(scrollContainer, "scrollTop", {
      get: () => scrollTopValue,
      set: (v: number) => {
        scrollTopValue = v;
      },
      configurable: true,
    });
    scrollTopValue = 200;
    await user.click(screen.getByRole("button", { name: "Source" }));
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(scrollTopValue).toBeGreaterThan(0);
  });

  it("Monaco onChange persists edits via workspaceAPI.writeFile", async () => {
    // Regression-pin for handleEditorChange — covers the path from Monaco's
    // onChange prop through applyContent + debouncedSave. Switching the
    // implementation between useEffectEvent / useCallback / setTimeout tricks
    // is fine as long as this test still passes.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderPreview("Hello world", "text", "notes.txt");

    const editor = screen.getByTestId("text-editor");
    // eslint-disable-next-line testing-library/prefer-user-event -- typing each char would fire one onChange per keystroke; we want a single full-value change
    fireEvent.change(editor, { target: { value: "Hello world!" } });

    // Advance past the 800ms debounced save.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    expect(window.workspaceAPI.writeFile).toHaveBeenCalledWith("notes.txt", "Hello world!");

    vi.useRealTimers();
  });

  // ── Selection protection tests ────────────────────────────────
  describe("text selection", () => {
    it("rendered segments do not have select-none class", async () => {
      await renderPreview("# Hello\n\nWorld");
      const seg0 = screen.getByTestId("segment-0");
      // ContextMenuTrigger with asChild merges select-text onto the segment div.
      // The critical thing is that select-none (from Radix) is NOT winning.
      // In happy-dom, Radix may not render the context menu wrapper, so we just
      // verify the segment wrapper itself is not select-none.
      expect(seg0.className).not.toMatch(/select-none/);
    });

    it("click activates segment only when no drag-selection exists", async () => {
      const { container } = await renderPreview("# Hello\n\nWorld");
      // Click segment 0 to activate it
      await clickSegment(container, 0);
      // Should be in edit mode — textarea present
      // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access -- verifying DOM structure
      expect(container.querySelector("textarea")).toBeTruthy();
    });

    it("mousedown from rendered state does not activate (preserves drag selection)", async () => {
      await renderPreview("# Hello\n\nWorld");
      const seg0 = screen.getByTestId("segment-0");
      // When no segment is active, mousedown alone should NOT activate
      // (activation deferred to onClick so drag selection works)
      const mouseDownEvent = new MouseEvent("mousedown", { bubbles: true });
      seg0.dispatchEvent(mouseDownEvent);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      // No textarea should appear yet
      // eslint-disable-next-line testing-library/no-node-access -- verifying DOM structure
      expect(seg0.querySelector("textarea")).toBeFalsy();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// MERMAID CODE BLOCKS
// ═══════════════════════════════════════════════════════════════════

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn<(...args: unknown[]) => void>(),
    render: vi
      .fn<(...args: unknown[]) => Promise<{ svg: string }>>()
      .mockResolvedValue({ svg: "<svg>mocked-diagram</svg>" }),
  },
}));

describe("Mermaid code blocks in markdown", () => {
  it("renders mermaid code block via MermaidRenderer", async () => {
    const mdWithMermaid = [
      "# Architecture",
      "",
      "```mermaid",
      "graph TD",
      "    A[Start] --> B[End]",
      "```",
    ].join("\n");

    await renderPreview(mdWithMermaid);

    // The mermaid block renders via MermaidRenderer (not as raw code text)
    expect(screen.queryByText("graph TD")).not.toBeInTheDocument();
    expect(screen.queryByText("A[Start] --> B[End]")).not.toBeInTheDocument();
  });

  it("renders regular code blocks as source code (not mermaid)", async () => {
    const mdWithCode = ["# Code", "", "```js", "const x = 1;", "```"].join("\n");

    await renderPreview(mdWithCode);

    expect(screen.getByText("const x = 1;")).toBeInTheDocument();
  });

  it("renders mermaid inside details via MermaidRenderer", async () => {
    const mdWithDetailsMermaid = [
      "<details>",
      "<summary>Diagram</summary>",
      "",
      "```mermaid",
      "graph LR",
      "    X --> Y",
      "```",
      "",
      "</details>",
    ].join("\n");

    await renderPreview(mdWithDetailsMermaid);

    // The mermaid block inside details renders via MermaidRenderer (not as raw code)
    expect(screen.queryByText("graph LR")).not.toBeInTheDocument();
    expect(screen.queryByText("X --> Y")).not.toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════
// TASK CHECKBOX TOGGLING
// ═══════════════════════════════════════════════════════════════════

describe("Task checkbox toggling", () => {
  const TASK_MD = [
    "# Tasks",
    "",
    "- [ ] Unchecked item",
    "- [x] Checked item",
    "- Regular bullet",
  ].join("\n");

  it("renders task checkboxes with md-task-checkbox class", async () => {
    await renderPreview(TASK_MD);

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]).not.toBeChecked();
    expect(checkboxes[1]).toBeChecked();
    expect(checkboxes[0]).toHaveClass("md-task-checkbox");
    expect(checkboxes[1]).toHaveClass("md-task-checkbox");
  });

  it("applies strikethrough to checked task text", async () => {
    await renderPreview(TASK_MD);

    // Checked item has data-testid="task-text-checked" on its wrapper span
    const checkedWrapper = screen.getByTestId("task-text-checked");
    expect(checkedWrapper).toHaveClass("line-through");
    expect(checkedWrapper).toHaveClass("opacity-60");

    // Unchecked item should not
    const uncheckedEl = screen.getByText("Unchecked item");
    // eslint-disable-next-line testing-library/no-node-access -- checking parent class not applied
    expect(uncheckedEl.closest(".line-through")).toBeNull();
  });

  it("toggles unchecked task to checked on click", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderPreview(TASK_MD);

    // eslint-disable-next-line testing-library/no-node-access -- need direct DOM access to dispatch click with correct target on readOnly checkbox
    const checkbox = screen.getAllByRole("checkbox")[0];
    // eslint-disable-next-line testing-library/prefer-user-event -- fireEvent needed for readOnly checkbox in happy-dom
    fireEvent.click(checkbox);

    // Advance past the 800ms debounce to trigger save
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    expect(window.workspaceAPI.writeFile).toHaveBeenCalledWith(
      "test.md",
      expect.stringContaining("- [x] Unchecked item"),
    );

    vi.useRealTimers();
  });

  it("toggles checked task to unchecked on click", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderPreview(TASK_MD);

    // eslint-disable-next-line testing-library/prefer-user-event -- fireEvent needed for readOnly checkbox in happy-dom
    fireEvent.click(screen.getAllByRole("checkbox")[1]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    expect(window.workspaceAPI.writeFile).toHaveBeenCalledWith(
      "test.md",
      expect.stringContaining("- [ ] Checked item"),
    );

    vi.useRealTimers();
  });
});

// ═══════════════════════════════════════════════════════════════════
// FILE ERROR STATE (5 tests)
// ═══════════════════════════════════════════════════════════════════

describe("File error state", () => {
  it("shows error message and Open button when file is too large", async () => {
    vi.mocked(window.workspaceAPI.readFile).mockResolvedValue({
      success: false,
      error: "File too large to preview",
    });

    render(<FilePreview filePath="huge-log.log" />);

    await waitFor(() => {
      expect(screen.getByText("File too large to preview")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Open in Desktop App" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Show in Explorer" })).toBeInTheDocument();
    });
  });

  it("Open button calls openFile with the file path", async () => {
    vi.mocked(window.workspaceAPI.readFile).mockResolvedValue({
      success: false,
      error: "File too large to preview",
    });

    render(<FilePreview filePath="/workspace/huge.json" />);

    await waitFor(() => {
      expect(screen.getByText("File too large to preview")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "Open in Desktop App" }));
    expect(window.workspaceAPI.openFile).toHaveBeenCalledWith("/workspace/huge.json");
  });

  it("Show in Explorer button calls revealInFileManager with the file path", async () => {
    vi.mocked(window.workspaceAPI.readFile).mockResolvedValue({
      success: false,
      error: "File too large to preview",
    });

    render(<FilePreview filePath="/workspace/huge.json" />);

    await waitFor(() => {
      expect(screen.getByText("File too large to preview")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "Show in Explorer" }));
    expect(window.workspaceAPI.revealInFileManager).toHaveBeenCalledWith("/workspace/huge.json");
  });

  it("does not show action buttons for non-too-large errors", async () => {
    vi.mocked(window.workspaceAPI.readFile).mockResolvedValue({
      success: false,
      error: "File not found",
    });

    render(<FilePreview filePath="missing.txt" />);

    await waitFor(() => {
      expect(screen.getByText("File not found")).toBeInTheDocument();
    });

    expect(screen.queryByRole("button", { name: "Open in Desktop App" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show in Explorer" })).not.toBeInTheDocument();
  });

  it("does not show action buttons for generic read errors", async () => {
    vi.mocked(window.workspaceAPI.readFile).mockResolvedValue({
      success: false,
      error: "Permission denied",
    });

    render(<FilePreview filePath="secret.txt" />);

    await waitFor(() => {
      expect(screen.getByText("Permission denied")).toBeInTheDocument();
    });

    expect(screen.queryByRole("button", { name: "Open in Desktop App" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show in Explorer" })).not.toBeInTheDocument();
  });

  it("calls onError when file cannot be read", async () => {
    vi.mocked(window.workspaceAPI.readFile).mockResolvedValue({
      success: false,
      error: "ENOENT: no such file or directory",
    });

    const onError = vi.fn<() => void>();
    render(<FilePreview filePath="deleted.md" onError={onError} />);

    await waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
    });
  });
});

describe("Zoom", () => {
  it("scales image previews via maxWidth/maxHeight constraints (not CSS zoom)", async () => {
    // CSS `zoom` on the parent doesn't scale <img> with vh-based max-height
    // — Chromium adjusts vh-in-zoom for descendants and the image actually
    // shrinks. We instead scale the image's max-width / max-height with the
    // zoom factor so the rendered size grows linearly. Regression test for
    // the image-zoom bug discovered while implementing Co-Create zoom.
    mockReadFile("base64imagebytes", "image");
    render(<FilePreview filePath="screenshot.png" zoom={1.5} />);
    const img = await screen.findByAltText("screenshot.png");
    expect(img.style.maxWidth).toBe("150%");
    expect(img.style.maxHeight).toBe("105vh");
  });

  it("uses the default 100%/70vh image constraints when zoom is 1", async () => {
    mockReadFile("base64imagebytes", "image");
    render(<FilePreview filePath="screenshot.png" zoom={1} />);
    const img = await screen.findByAltText("screenshot.png");
    expect(img.style.maxWidth).toBe("100%");
    expect(img.style.maxHeight).toBe("70vh");
  });

  it("applies CSS zoom to the markdown content area when zoom != 1", async () => {
    mockReadFile("# Hello", "markdown");
    render(<FilePreview filePath="test.md" zoom={1.25} />);
    await waitFor(() => {
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    });
    const contentArea = screen.getByTestId("file-preview-content");
    expect(contentArea.style.zoom).toBe("1.25");
  });

  it("does NOT apply CSS zoom when zoom is 1 (avoids unnecessary DOM mutations)", async () => {
    await renderPreview("# Hello", "markdown");
    const contentArea = screen.getByTestId("file-preview-content");
    expect(contentArea.style.zoom).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════════════
// FILE SWITCH SAVE FLUSH
// ═══════════════════════════════════════════════════════════════════

describe("File switch save flush", () => {
  it("flushes pending debounced save when filePath changes", async () => {
    mockReadFile("# Original", "markdown");
    const { container, rerender } = render(<FilePreview filePath="a.md" />);
    await waitFor(() => {
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    });

    // Edit a segment so content diverges from lastSavedRef
    await clickSegment(container, 0);
    const input = getActiveInput(container)!;
    await user.clear(input);
    await user.type(input, "# Edited");
    fireEvent.blur(input);
    await flush();

    // writeFile may not have been called yet (800ms debounce)
    vi.mocked(window.workspaceAPI.writeFile).mockClear();

    // Switch to a different file — should flush pending save for a.md
    mockReadFile("# Other file", "markdown");
    rerender(<FilePreview filePath="b.md" />);

    // The cleanup effect should have called writeFile with the edited content
    expect(window.workspaceAPI.writeFile).toHaveBeenCalledTimes(1);
    expect(window.workspaceAPI.writeFile).toHaveBeenCalledWith("a.md", "# Edited");
  });

  it("flushes pending save on unmount", async () => {
    mockReadFile("# Original", "markdown");
    const { container, unmount } = render(<FilePreview filePath="a.md" />);
    await waitFor(() => {
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    });

    await clickSegment(container, 0);
    const input = getActiveInput(container)!;
    await user.clear(input);
    await user.type(input, "# Edited on unmount");
    fireEvent.blur(input);
    await flush();

    vi.mocked(window.workspaceAPI.writeFile).mockClear();
    unmount();

    expect(window.workspaceAPI.writeFile).toHaveBeenCalledTimes(1);
    expect(window.workspaceAPI.writeFile).toHaveBeenCalledWith("a.md", "# Edited on unmount");
  });

  it("does NOT write when there are no pending edits on file switch", async () => {
    mockReadFile("# Untouched", "markdown");
    const { rerender } = render(<FilePreview filePath="a.md" />);
    await waitFor(() => {
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    });

    vi.mocked(window.workspaceAPI.writeFile).mockClear();

    // Switch file without making any edits
    mockReadFile("# Other file", "markdown");
    rerender(<FilePreview filePath="b.md" />);

    expect(window.workspaceAPI.writeFile).not.toHaveBeenCalled();
  });
});
