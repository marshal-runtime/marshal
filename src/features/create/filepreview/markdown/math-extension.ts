/**
 * mdast transform extension for $$math$$ block syntax.
 *
 * Since mdast doesn't natively support `$$` math blocks, they end up as
 * paragraphs containing literal `$$` text.  This transform walks the AST
 * after parsing and replaces those paragraphs with proper `mathBlock` nodes
 * that carry the correct position metadata.
 *
 * Unlike the highlight extension (which is an inline attention-marker and
 * needs a full micromark tokenizer), math blocks are detected structurally
 * from their paragraph content — a transform is the right tool.
 */

import type { Literal, Root, RootContent } from "mdast";
import type { Extension as FromMdExtension } from "mdast-util-from-markdown";

// ── mdast node type ────────────────────────────────────────────

export interface MathBlock extends Literal {
  type: "mathBlock";
}

declare module "mdast" {
  interface RootContentMap {
    mathBlock: MathBlock;
  }
}

// ── mdast-util extension ───────────────────────────────────────

/** Create an mdast-util-from-markdown extension that transforms $$...$$ paragraphs into mathBlock nodes. */
export function mathFromMarkdown(raw: string): FromMdExtension {
  return {
    transforms: [(tree: Root) => replaceMathParagraphs(tree, raw)],
  };
}

function replaceMathParagraphs(tree: Root, raw: string): void {
  for (let i = 0; i < tree.children.length; i++) {
    const node = tree.children[i];
    if (node.type !== "paragraph" || !node.position) continue;

    const start = node.position.start.offset;
    const end = node.position.end.offset;
    if (start == null || end == null) continue;

    const text = raw.slice(start, end).trim();
    if (!text.startsWith("$$") || !text.endsWith("$$") || text.length <= 4) continue;

    const value = text.slice(2, -2).trim();

    const mathNode: MathBlock = {
      type: "mathBlock",
      value,
      position: node.position,
    };

    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Custom node replacing paragraph in-place
    tree.children[i] = mathNode as unknown as RootContent;
  }
}
