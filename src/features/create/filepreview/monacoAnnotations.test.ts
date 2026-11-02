import { describe, expect, it } from "vitest";

import { annotationDecorations } from "./monacoAnnotations";

describe("annotationDecorations", () => {
  it("marks the range, clamps it to the document, and adds a trailing label", () => {
    const decorations = annotationDecorations(
      [{ startLine: 3, endLine: 50, tone: "warning", label: "must read", detail: "calls launch" }],
      10,
    );
    expect(decorations).toHaveLength(2);
    expect(decorations[0].range).toMatchObject({ startLineNumber: 3, endLineNumber: 10 });
    expect(decorations[0].options).toMatchObject({
      isWholeLine: true,
      linesDecorationsClassName: "marshal-annotation-warning-gutter",
      hoverMessage: { value: "**must read**\n\ncalls launch" },
    });
    expect(decorations[1].options.showIfCollapsed).toBe(true);
    expect(decorations[1].options.after).toEqual({
      content: "  must read",
      inlineClassName: "marshal-annotation-warning-label",
    });
  });

  it("skips annotations that start past the end of the document", () => {
    expect(annotationDecorations([{ startLine: 11, tone: "info", label: "x" }], 10)).toEqual([]);
  });
});
