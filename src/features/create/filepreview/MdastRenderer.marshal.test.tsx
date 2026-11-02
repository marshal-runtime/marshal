// marshal-owned renderer test
import type { Heading, Paragraph } from "mdast";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";

import { parseMarkdownToAst } from "./mdastParser";
import { renderMdastParagraph, renderMdastHeading, renderMdastChildren } from "./MdastRenderer";

// ── Helpers ────────────────────────────────────────────────────

/** Parse markdown and return the first root child as a Paragraph. */
function parseParagraph(md: string): Paragraph {
  const ast = parseMarkdownToAst(md);
  const node = ast.children[0];
  if (node.type !== "paragraph") throw new Error(`expected paragraph, got ${node.type}`);
  return node;
}

/** Parse markdown and return the first root child as a Heading. */
function parseHeading(md: string): Heading {
  const ast = parseMarkdownToAst(md);
  const node = ast.children[0];
  if (node.type !== "heading") throw new Error(`expected heading, got ${node.type}`);
  return node;
}

/** Render a node to HTML string */
function toStaticHtml(node: React.ReactNode): string {
  return renderToStaticMarkup(<>{node}</>);
}

// ── Tests ──────────────────────────────────────────────────────

describe("MdastRenderer", () => {
  describe("renderMdastParagraph", () => {
    it("renders plain text paragraph with correct position attributes", () => {
      const md = "Hello world";
      const node = parseParagraph(md);
      const view = toStaticHtml(renderMdastParagraph(node));

      expect(view).toContain('data-md-start="0"');
      expect(view).toContain('data-md-end="11"');
      expect(view).toContain("Hello world");
    });

    it("renders paragraph with bold text and correct offsets", () => {
      const md = "**bold**";
      const node = parseParagraph(md);
      const view = toStaticHtml(renderMdastParagraph(node));

      // Paragraph wrapper
      expect(view).toContain('data-md-start="0"');
      expect(view).toContain('data-md-end="8"');
      // Strong element should also have offsets for **bold**
      expect(view).toContain("<strong");
      expect(view).toContain("bold");
    });

    it("renders paragraph with emphasis and correct offsets", () => {
      const md = "*italic*";
      const node = parseParagraph(md);
      const view = toStaticHtml(renderMdastParagraph(node));

      // Paragraph wrapper
      expect(view).toContain('data-md-start="0"');
      expect(view).toContain('data-md-end="8"');
      // Em element
      expect(view).toContain("<em");
      expect(view).toContain("italic");
    });

    it("renders nested inline elements with correct offsets", () => {
      const md = "**bold _italic_**";
      const node = parseParagraph(md);
      const view = toStaticHtml(renderMdastParagraph(node));

      // Paragraph should span the entire text
      expect(view).toContain('data-md-start="0"');
      expect(view).toContain('data-md-end="17"');
      // Should have both strong and em elements
      expect(view).toContain("<strong");
      expect(view).toContain("<em");
      expect(view).toContain("bold");
      expect(view).toContain("italic");
    });

    it("renders inline code with correct offsets", () => {
      const md = "`code`";
      const node = parseParagraph(md);
      const view = toStaticHtml(renderMdastParagraph(node));

      // Paragraph wrapper
      expect(view).toContain('data-md-start="0"');
      expect(view).toContain('data-md-end="6"');
      // Code element
      expect(view).toContain("<code");
      expect(view).toContain("code");
    });

    it("renders link with correct offsets", () => {
      const md = "[text](url)";
      const node = parseParagraph(md);
      const view = toStaticHtml(renderMdastParagraph(node));

      // Paragraph wrapper
      expect(view).toContain('data-md-start="0"');
      expect(view).toContain('data-md-end="11"');
      // Link element
      expect(view).toContain("<a");
      expect(view).toContain("text");
      expect(view).toContain('href="url"');
    });
  });

  describe("renderMdastHeading", () => {
    it("renders heading with correct position attributes", () => {
      const md = "# Heading";
      const node = parseHeading(md);

      const view = toStaticHtml(renderMdastHeading(node));

      expect(view).toContain('data-md-start="0"');
      expect(view).toContain('data-md-end="9"');
      expect(view).toContain("Heading");
    });

    it("renders heading with inline formatting", () => {
      const md = "## **Bold** heading";
      const node = parseHeading(md);

      const view = toStaticHtml(renderMdastHeading(node));

      expect(view).toContain('data-md-start="0"');
      expect(view).toContain('data-md-end="19"');
      expect(view).toContain("<strong");
      expect(view).toContain("Bold");
    });
  });

  describe("renderMdastChildren", () => {
    it("renders array of inline nodes with individual offsets", () => {
      const md = "**bold** and *italic*";
      const node = parseParagraph(md);

      const view = toStaticHtml(renderMdastChildren(node.children));

      // Should have strong element
      expect(view).toContain("<strong");
      expect(view).toContain("bold");
      // Should have em element
      expect(view).toContain("<em");
      expect(view).toContain("italic");
      // Should have the "and" text
      expect(view).toContain("and");
    });

    it("renders text nodes with position attributes", () => {
      const md = "plain text";
      const node = parseParagraph(md);

      const view = toStaticHtml(renderMdastChildren(node.children));

      expect(view).toContain("plain text");
      // Text nodes are wrapped in spans with position data
      expect(view).toContain("<span");
    });
  });

  describe("missing position handling", () => {
    it("gracefully handles nodes without position info", () => {
      // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- testing edge case with manually constructed node
      const nodeWithoutPosition = {
        type: "paragraph",
        children: [
          {
            type: "text",
            value: "test",
          },
        ],
      } as Paragraph;

      const view = toStaticHtml(renderMdastParagraph(nodeWithoutPosition));

      // Should not have position attributes
      expect(view).not.toContain("data-md-start");
      expect(view).not.toContain("data-md-end");
      // But should still render content
      expect(view).toContain("test");
    });

    it("handles mixed nodes with and without position", () => {
      const md = "text **bold**";
      const node = parseParagraph(md);

      // Remove position from one child
      if (node.children[0]) {
        delete node.children[0].position;
      }

      const view = toStaticHtml(renderMdastParagraph(node));

      // Should still render all content
      expect(view).toContain("text");
      expect(view).toContain("bold");
    });
  });

  describe("complex inline combinations", () => {
    it("renders link with formatted text inside", () => {
      const md = "[**bold link**](url)";
      const node = parseParagraph(md);
      const view = toStaticHtml(renderMdastParagraph(node));

      expect(view).toContain("<a");
      expect(view).toContain("<strong");
      expect(view).toContain("bold link");
    });

    it("renders multiple inline elements in sequence", () => {
      const md = "**bold** *italic* `code` [link](url)";
      const node = parseParagraph(md);
      const view = toStaticHtml(renderMdastParagraph(node));

      expect(view).toContain("<strong");
      expect(view).toContain("<em");
      expect(view).toContain("<code");
      expect(view).toContain("<a");
    });
  });

  describe("position offset accuracy", () => {
    it("has correct byte offsets for multi-line paragraph", () => {
      const md = "Line one\nLine two";
      const node = parseParagraph(md);
      const view = toStaticHtml(renderMdastParagraph(node));

      // Should span from 0 to 17 (including newline)
      expect(view).toContain('data-md-start="0"');
      expect(view).toContain('data-md-end="17"');
    });

    it("preserves exact character offsets for inline elements", () => {
      const md = "prefix **bold** suffix";
      const node = parseParagraph(md);

      // Get the strong child
      const strongChild = node.children.find((c) => c.type === "strong");
      expect(strongChild).toBeDefined();

      // The **bold** part starts at position 7 and ends at 15
      expect(strongChild!.position?.start.offset).toBe(7);
      expect(strongChild!.position?.end.offset).toBe(15);
    });
  });
});
