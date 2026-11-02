import { afterEach, describe, expect, it } from "vitest";

import { detectPartialSelection } from "./detectPartialSelection";
import type { Segment } from "../markdownParser";

/**
 * Build a minimal editor DOM with `.md-seg` elements annotated with
 * `data-md-start` / `data-md-end` so `rangeToMarkdownRange` can resolve
 * offsets.  Mirrors the production MdastRenderer DOM depth: the annotated
 * element wraps an inner `<span>` containing the text node, so
 * `findAnnotatedAncestor` must walk 2+ levels (not just one).
 *
 * Appends to `document.body` — call `cleanup()` when done.
 */
function createEditor(...defs: Array<{ text: string; mdStart: number; mdEnd: number }>) {
  const editor = document.createElement("div");
  editor.className = "md-custom-editor";
  const segments: Segment[] = [];

  for (const { text, mdStart, mdEnd } of defs) {
    const seg = document.createElement("div");
    seg.className = "md-seg";
    const rendered = document.createElement("span");
    rendered.className = "md-seg-rendered";
    // Annotated wrapper (like the <p> or <span> emitted by MdastRenderer)
    const annotated = document.createElement("span");
    annotated.setAttribute("data-md-start", String(mdStart));
    annotated.setAttribute("data-md-end", String(mdEnd));
    // Inner inline element (like <strong>, <em>, or plain text wrapper)
    const inner = document.createElement("span");
    inner.textContent = text;
    annotated.appendChild(inner);
    rendered.appendChild(annotated);
    seg.appendChild(rendered);
    editor.appendChild(seg);
    segments.push({
      type: "paragraph",
      start: 0,
      end: 0,
      mdStart,
      mdEnd,
      ast: { type: "paragraph", children: [] },
    });
  }

  document.body.appendChild(editor);
  return { editor, segments, cleanup: () => editor.remove() };
}

describe("detectPartialSelection (browser)", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
  });

  it("returns null for collapsed selection", () => {
    const { editor, segments, cleanup } = createEditor({
      text: "Hello world",
      mdStart: 0,
      mdEnd: 11,
    });
    const textNode = editor.querySelector("[data-md-start] span")!.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 3);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    expect(detectPartialSelection(sel, editor, segments)).toBeNull();
    cleanup();
  });

  it("returns null when selection doesn't overlap any segment", () => {
    const { editor, segments, cleanup } = createEditor({ text: "Hello", mdStart: 0, mdEnd: 5 });
    // Create a text node outside any .md-seg
    const outside = document.createElement("p");
    outside.textContent = "outside text";
    editor.appendChild(outside);

    const range = document.createRange();
    range.selectNodeContents(outside);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    expect(detectPartialSelection(sel, editor, segments)).toBeNull();
    cleanup();
  });

  it("detects partial single-segment selection", () => {
    const { editor, segments, cleanup } = createEditor({
      text: "Hello world",
      mdStart: 0,
      mdEnd: 11,
    });
    const textNode = editor.querySelector("[data-md-start] span")!.firstChild!;
    const range = document.createRange();
    // Select "Hello" (0–5) out of "Hello world" (0–11)
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    const info = detectPartialSelection(sel, editor, segments);
    expect(info).not.toBeNull();
    expect(info!.startSeg).toBe(0);
    expect(info!.endSeg).toBe(0);
    expect(info!.isPartial).toBe(true);
    expect(info!.mdRange).toEqual({ mdStart: 0, mdEnd: 5 });
    expect(info!.renderedText).toBe("Hello");
    cleanup();
  });

  it("returns isPartial=false for full single-segment selection", () => {
    const { editor, segments, cleanup } = createEditor({
      text: "Hello world",
      mdStart: 0,
      mdEnd: 11,
    });
    const textNode = editor.querySelector("[data-md-start] span")!.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 11);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    const info = detectPartialSelection(sel, editor, segments);
    expect(info).not.toBeNull();
    expect(info!.startSeg).toBe(0);
    expect(info!.endSeg).toBe(0);
    expect(info!.isPartial).toBe(false);
    expect(info!.mdRange).toBeNull();
    cleanup();
  });

  it("detects multi-segment selection", () => {
    const { editor, segments, cleanup } = createEditor(
      { text: "First segment", mdStart: 0, mdEnd: 13 },
      { text: "Second segment", mdStart: 14, mdEnd: 28 },
    );
    const firstText = editor.querySelectorAll("[data-md-start] span")[0].firstChild!;
    const secondText = editor.querySelectorAll("[data-md-start] span")[1].firstChild!;
    const range = document.createRange();
    range.setStart(firstText, 3);
    range.setEnd(secondText, 6);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    const info = detectPartialSelection(sel, editor, segments);
    expect(info).not.toBeNull();
    expect(info!.startSeg).toBe(0);
    expect(info!.endSeg).toBe(1);
    // Multi-segment: isPartial is always false (only computed for single-seg)
    expect(info!.isPartial).toBe(false);
    expect(info!.mdRange).toBeNull();
    cleanup();
  });

  it("returns isPartial=false when segment lacks md offset annotations", () => {
    // Build a segment DOM without data-md-start/data-md-end so rangeToMarkdownRange returns null
    const editor = document.createElement("div");
    editor.className = "md-custom-editor";
    const seg = document.createElement("div");
    seg.className = "md-seg";
    const rendered = document.createElement("span");
    rendered.className = "md-seg-rendered";
    rendered.textContent = "No annotations";
    seg.appendChild(rendered);
    editor.appendChild(seg);
    document.body.appendChild(editor);

    const segments: Segment[] = [
      {
        type: "paragraph",
        start: 0,
        end: 0,
        mdStart: 0,
        mdEnd: 14,
        ast: { type: "paragraph", children: [] },
      },
    ];

    const textNode = rendered.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    const info = detectPartialSelection(sel, editor, segments);
    expect(info).not.toBeNull();
    // rangeToMarkdownRange returns null → isPartial stays false, mdRange stays null
    expect(info!.isPartial).toBe(false);
    expect(info!.mdRange).toBeNull();
    editor.remove();
  });
});
