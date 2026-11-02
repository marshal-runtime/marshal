// marshal-owned renderer test
import { describe, it, expect } from "vitest";

import { parseMarkdownToAst, astToSegments, normalizeOrphans } from "./mdastParser";

// ── Helper ─────────────────────────────────────────────────────
function parse(md: string) {
  const ast = parseMarkdownToAst(md);
  return astToSegments(ast, md);
}

function contentSegments(md: string) {
  return parse(md).filter((s) => s.type !== "blank");
}

// ── parseMarkdownToAst ─────────────────────────────────────────
describe("parseMarkdownToAst", () => {
  it("parses simple paragraph", () => {
    const ast = parseMarkdownToAst("Hello world");
    expect(ast.type).toBe("root");
    expect(ast.children).toHaveLength(1);
    expect(ast.children[0].type).toBe("paragraph");
  });

  it("parses GFM strikethrough", () => {
    const ast = parseMarkdownToAst("~~deleted~~");
    const para = ast.children[0];
    expect(para.type).toBe("paragraph");
    expect(para.type === "paragraph" && para.children[0].type).toBe("delete");
  });

  it("parses ==highlight== syntax", () => {
    const ast = parseMarkdownToAst("==highlighted==");
    const para = ast.children[0];
    expect(para.type).toBe("paragraph");
    expect(para.type === "paragraph" && para.children[0].type).toBe("highlight");
  });

  it("preserves position offsets", () => {
    const ast = parseMarkdownToAst("**bold**");
    const para = ast.children[0];
    expect(para.position?.start.offset).toBe(0);
    expect(para.position?.end.offset).toBe(8);
  });
});

// ── astToSegments: segment types ───────────────────────────────
describe("astToSegments", () => {
  it("maps heading with correct level", () => {
    const segs = contentSegments("## Hello");
    expect(segs).toHaveLength(1);
    const seg = segs[0];
    if (seg.type !== "heading") throw new Error(`expected heading, got ${seg.type}`);
    expect(seg.headingLevel).toBe(2);
  });

  it("maps paragraph", () => {
    const segs = contentSegments("Hello world");
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe("paragraph");
  });

  it("maps unordered list items as individual segments", () => {
    const md = "- Item 1\n- Item 2\n- Item 3";
    const segs = contentSegments(md);
    expect(segs).toHaveLength(3);
    expect(segs.every((s) => s.type === "list-item")).toBe(true);
  });

  it("maps ordered list items as individual segments", () => {
    const md = "1. First\n2. Second";
    const segs = contentSegments(md);
    expect(segs).toHaveLength(2);
    expect(segs.every((s) => s.type === "list-item")).toBe(true);
  });

  it("maps blockquote", () => {
    const segs = contentSegments("> Quoted text");
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe("blockquote");
  });

  it("maps fenced code block", () => {
    const md = "```js\nconsole.log(42)\n```";
    const segs = contentSegments(md);
    expect(segs).toHaveLength(1);
    const seg = segs[0];
    if (seg.type !== "code") throw new Error(`expected code, got ${seg.type}`);
    expect(seg.lang).toBe("js");
  });

  it("maps table", () => {
    const md = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const segs = contentSegments(md);
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe("table");
  });

  it("maps horizontal rule", () => {
    const segs = contentSegments("---");
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe("hr");
  });

  it("maps HTML block", () => {
    const md = "<div>custom content</div>";
    const segs = contentSegments(md);
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe("html-block");
  });

  it("maps <details> as details type", () => {
    const md = "<details>\n<summary>Title</summary>\nBody\n</details>";
    const segs = contentSegments(md);
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe("details");
  });
});

// ── Offsets ────────────────────────────────────────────────────
describe("astToSegments offsets", () => {
  it("has correct mdStart and mdEnd for a paragraph", () => {
    const md = "Hello world";
    const segs = contentSegments(md);
    expect(segs[0].mdStart).toBe(0);
    expect(segs[0].mdEnd).toBe(11);
  });

  it("has correct offsets for second segment", () => {
    const md = "# Title\n\nParagraph";
    const segs = contentSegments(md);
    expect(segs[0].type).toBe("heading");
    expect(segs[0].mdStart).toBe(0);
    expect(segs[0].mdEnd).toBe(7);
    expect(segs[1].type).toBe("paragraph");
    expect(segs[1].mdStart).toBe(9);
    expect(segs[1].mdEnd).toBe(18);
  });

  it("has correct offsets for list items", () => {
    const md = "- Alpha\n- Beta";
    const segs = contentSegments(md);
    expect(segs[0].mdStart).toBe(0);
    expect(segs[0].mdEnd).toBe(7);
    expect(segs[1].mdStart).toBe(8);
    expect(segs[1].mdEnd).toBe(14);
  });

  it("flattens nested list items into individual segments", () => {
    const md = "- Parent\n  - Child 1\n  - Child 2\n    - Grandchild\n  - Child 3\n- Sibling";
    const segs = contentSegments(md);
    const listSegs = segs.filter((s) => s.type === "list-item");
    expect(listSegs.map((s) => md.slice(s.mdStart, s.mdEnd).split("\n")[0].trim())).toEqual([
      "- Parent",
      "- Child 1",
      "- Child 2",
      "- Grandchild",
      "- Child 3",
      "- Sibling",
    ]);
  });

  it("nested list items have correct line indices for indent detection", () => {
    const md =
      "# Lists\n\n- Parent item\n  - Child 1\n  - Child 2\n    - Grandchild\n  - Child 3\n- Sibling item\n- Another top-level";
    const segs = contentSegments(md);
    const lines = md.split("\n");
    const listSegs = segs.filter((s) => s.type === "list-item");
    // Verify each segment starts on the correct line
    expect(listSegs.map((s) => lines[s.start])).toEqual([
      "- Parent item",
      "  - Child 1",
      "  - Child 2",
      "    - Grandchild",
      "  - Child 3",
      "- Sibling item",
      "- Another top-level",
    ]);
    // Verify segments are consecutive in array (so hasCollapsibleChildren can check next segment)
    const indices = listSegs.map((s) => segs.indexOf(s));
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBe(indices[i - 1] + 1);
    }
    // Verify getListIndent would work: check leading whitespace of each segment's first line
    const indents = listSegs.map((s) => {
      const line = lines[s.start];
      const match = line.match(/^(\s*)/);
      return match ? Math.floor(match[1].length / 2) : 0;
    });
    expect(indents).toEqual([0, 1, 1, 2, 1, 0, 0]);
    // hasCollapsibleChildren for "Parent item" (first list seg):
    // myIndent=0, next seg type="list-item", next indent=1, 1 > 0 → true
    const parentIdx = indices[0];
    expect(segs[parentIdx + 1].type).toBe("list-item");
    expect(indents[1]).toBeGreaterThan(indents[0]);
  });

  it("offset range matches raw text for code block", () => {
    const md = "```python\nprint(42)\n```";
    const segs = contentSegments(md);
    expect(md.slice(segs[0].mdStart, segs[0].mdEnd)).toBe(md);
  });
});

// ── Line indices ───────────────────────────────────────────────
describe("astToSegments line indices", () => {
  it("single-line paragraph has start === end", () => {
    const segs = contentSegments("Hello");
    expect(segs[0].start).toBe(0);
    expect(segs[0].end).toBe(0);
  });

  it("multi-line code block spans correct lines", () => {
    const md = "```\nline1\nline2\n```";
    const segs = contentSegments(md);
    expect(segs[0].start).toBe(0);
    expect(segs[0].end).toBe(3);
  });

  it("second paragraph after blank line has correct line index", () => {
    const md = "First\n\nSecond";
    const segs = contentSegments(md);
    expect(segs[1].start).toBe(2);
    expect(segs[1].end).toBe(2);
  });
});

// ── Blank segments ─────────────────────────────────────────────
describe("blank segments", () => {
  it("inserts blank between two paragraphs", () => {
    const md = "First\n\nSecond";
    const segs = parse(md);
    expect(segs).toHaveLength(3);
    expect(segs[0].type).toBe("paragraph");
    expect(segs[1].type).toBe("blank");
    expect(segs[2].type).toBe("paragraph");
  });

  it("inserts blank for trailing empty line", () => {
    const md = "Hello\n";
    const segs = parse(md);
    const blanks = segs.filter((s) => s.type === "blank");
    expect(blanks.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Frontmatter ────────────────────────────────────────────────
describe("frontmatter skipping", () => {
  it("skips YAML frontmatter", () => {
    const md = "---\ntitle: Test\n---\n\nHello world";
    const segs = contentSegments(md);
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe("paragraph");
  });

  it("does not skip non-frontmatter ---", () => {
    const md = "Hello\n\n---\n\nWorld";
    const segs = contentSegments(md);
    // Should have: paragraph, hr, paragraph
    const types = segs.map((s) => s.type);
    expect(types).toContain("hr");
  });

  it("treats empty frontmatter (no YAML keys) as content, not metadata", () => {
    const md = "---\n---\n\nBody text";
    const segs = contentSegments(md);
    // With no YAML keys, the opening --- is treated as an <hr>, not frontmatter.
    const types = segs.map((s) => s.type);
    expect(types).toContain("hr");
  });

  it("treats unterminated frontmatter as regular content", () => {
    const md = "---\ntitle: Hello\ndate: 2025-01-01\n\nBody text";
    const segs = contentSegments(md);
    // No closing ---, so skipFrontmatter returns 0 and the opening ---
    // is parsed as a thematic break.
    expect(segs.length).toBeGreaterThan(1);
    const types = segs.map((s) => s.type);
    expect(types).toContain("hr");
  });

  it("skips multi-key frontmatter and preserves body", () => {
    const md = "---\ntitle: Hello\ndate: 2025-01-01\ntags: a,b\n---\n\nBody text";
    const segs = contentSegments(md);
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe("paragraph");
  });
});

// ── Comment detection ──────────────────────────────────────────
describe("comment segments", () => {
  it("detects comment thread", () => {
    const md = "Hello\n\n<!-- @comment:abc: This is a comment -->";
    const segs = contentSegments(md);
    const comment = segs.find((s) => s.type === "comment");
    expect(comment).toBeDefined();
    expect(comment!.anchorId).toBe("abc");
  });

  it("groups consecutive comment/reply lines", () => {
    const md = "<!-- @comment:x1: First -->\n<!-- @reply:x1: Reply -->";
    const segs = contentSegments(md);
    const comments = segs.filter((s) => s.type === "comment");
    expect(comments).toHaveLength(1);
  });

  it("detects comment-start/end markers as blank", () => {
    const md = "<!-- @comment-start:abc -->\nSome text\n<!-- @comment-end:abc -->";
    const segs = parse(md);
    const blanks = segs.filter((s) => s.type === "blank");
    expect(blanks.length).toBeGreaterThanOrEqual(1);
  });
});

// ── AST node reference ─────────────────────────────────────────
describe("ast node on segments", () => {
  it("attaches ast node to paragraph segment", () => {
    const segs = contentSegments("Hello world");
    expect(segs[0].ast).toBeDefined();
    expect(segs[0].ast?.type).toBe("paragraph");
  });

  it("attaches ast node to heading segment", () => {
    const segs = contentSegments("# Title");
    expect(segs[0].ast).toBeDefined();
    expect(segs[0].ast?.type).toBe("heading");
  });

  it("attaches ast node to code segment", () => {
    const segs = contentSegments("```\ncode\n```");
    expect(segs[0].ast).toBeDefined();
    expect(segs[0].ast?.type).toBe("code");
  });
});

// ── Highlight extension integration ────────────────────────────
describe("highlight in segments", () => {
  it("highlight syntax produces paragraph with highlight child", () => {
    const md = "Some ==highlighted== text";
    const segs = contentSegments(md);
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe("paragraph");
    const ast = segs[0].ast;
    expect(ast).toBeDefined();
    expect(ast?.type === "paragraph" && ast.children.some((c) => c.type === "highlight")).toBe(
      true,
    );
  });
});

// ── Orphan normalization ───────────────────────────────────────
describe("normalizeOrphans", () => {
  it("removes empty bold markers (****)", () => {
    expect(normalizeOrphans("hello **** world")).toBe("hello world");
  });

  it("removes quadruple asterisks from deletion", () => {
    expect(normalizeOrphans("before **** after")).toBe("before after");
  });

  it("removes empty strikethrough (~~~~)", () => {
    expect(normalizeOrphans("before ~~~~ after")).toBe("before after");
  });

  it("removes empty highlight (====)", () => {
    expect(normalizeOrphans("before ==== after")).toBe("before after");
  });

  it("removes empty inline code (``)", () => {
    expect(normalizeOrphans("before `` after")).toBe("before after");
  });

  it("removes empty link text [](url)", () => {
    expect(normalizeOrphans("before [](http://example.com) after")).toBe("before after");
  });

  it("preserves valid formatting", () => {
    expect(normalizeOrphans("**bold** and *italic*")).toBe("**bold** and *italic*");
  });

  it("cleans up double spaces after removal", () => {
    expect(normalizeOrphans("hello  ****  world")).toBe("hello world");
  });

  it("handles nested orphans: empty strikethrough inside bold", () => {
    // Known limitation (CommonMark §6.2): trailing space before closing **
    // makes this technically invalid bold. Fixing requires paired-delimiter
    // awareness — acceptable for an editor cleanup pass.
    expect(normalizeOrphans("**bold ~~~~**")).toBe("**bold **");
  });

  it("handles fully nested orphans: both layers collapse", () => {
    expect(normalizeOrphans("**~~~~**")).toBe("");
  });

  it("handles nested orphans: empty highlight inside emphasis", () => {
    // Known limitation (CommonMark §6.2): same trailing-space issue as above.
    expect(normalizeOrphans("*text ====*")).toBe("*text *");
  });
});

// ── Math-block segments ─────────────────────────────────────────

describe("math-block segments", () => {
  it("maps $$...$$ at file start (offset 0) as math-block, not paragraph", () => {
    const segs = contentSegments("$$\nx^2\n$$");
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe("math-block");
    expect(segs[0].mdStart).toBe(0);
  });

  it("maps $$...$$ mid-file as math-block", () => {
    const segs = contentSegments("# Heading\n\n$$\nx^2\n$$");
    const math = segs.find((s) => s.type === "math-block");
    expect(math).toBeDefined();
    expect(math!.mdStart).toBeGreaterThan(0);
  });

  it("maps multi-line math block correctly", () => {
    const segs = contentSegments("$$\na + b\nc + d\n$$");
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe("math-block");
  });

  it("does not treat single $ as math-block", () => {
    const segs = contentSegments("$x^2$");
    expect(segs).toHaveLength(1);
    expect(segs[0].type).not.toBe("math-block");
  });

  it("preserves correct offsets for math block with surrounding content", () => {
    const md = "Hello\n\n$$\nE=mc^2\n$$\n\nWorld";
    const segs = contentSegments(md);
    const math = segs.find((s) => s.type === "math-block");
    expect(math).toBeDefined();
    expect(md.slice(math!.mdStart, math!.mdEnd)).toContain("$$");
    expect(md.slice(math!.mdStart, math!.mdEnd)).toContain("E=mc^2");
  });
});
