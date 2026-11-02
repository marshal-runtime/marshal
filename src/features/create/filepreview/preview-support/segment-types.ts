import type {
  Blockquote,
  Code,
  Definition,
  Heading,
  Html,
  ListItem,
  Paragraph,
  RootContent,
  Table,
  ThematicBreak,
} from "mdast";

import type { MathBlock } from "../markdown/math-extension";

// ── Types ──────────────────────────────────────────────────────

interface SegmentBase {
  start: number; // first line index
  end: number; // last line index (inclusive)
  /** Character offset of the segment's start in raw markdown. */
  mdStart?: number;
  /** Character offset of the segment's end in raw markdown. */
  mdEnd?: number;
}

/**
 * A document segment. The variant is discriminated by `type`, and each
 * variant carries the precise mdast node it backs (when applicable).
 *
 * `definition` is reserved for link reference definitions (CommonMark
 * does not render these); `unknown` is a safety fallback for any node
 * type the parser doesn't recognize and is rendered as raw text.
 */
export type Segment =
  | (SegmentBase & { type: "heading"; ast: Heading; headingLevel: Heading["depth"] })
  | (SegmentBase & { type: "paragraph"; ast: Paragraph })
  | (SegmentBase & { type: "blockquote"; ast: Blockquote })
  | (SegmentBase & { type: "list-item"; ast: ListItem })
  | (SegmentBase & { type: "table"; ast: Table })
  | (SegmentBase & { type: "code"; ast: Code; lang: string })
  | (SegmentBase & { type: "math-block"; ast: MathBlock })
  | (SegmentBase & { type: "html-block"; ast: Html })
  | (SegmentBase & { type: "details"; ast: Html })
  | (SegmentBase & { type: "comment"; ast: Html; anchorId?: string })
  | (SegmentBase & { type: "hr"; ast: ThematicBreak })
  | (SegmentBase & { type: "definition"; ast: Definition })
  | (SegmentBase & { type: "unknown"; ast: RootContent })
  | (SegmentBase & { type: "blank"; ast?: Html });

/** String-only type tag, derived from `Segment` so the two can never drift. */
export type SegmentType = Segment["type"];

// ── Constants (shared with renderers) ─────────────────────────
const TABLE_SEP_RE = /^\|[\s:|-]+\|$/;
export const TABLE_ROW_RE = /^\|(.+)\|$/;
export const FENCE_RE = /^(`{3,}|~{3,})/;
export const COMMENT_RE = /^<!--\s*@(comment|reply)(?::([a-z0-9]+))?:\s*(.*?)\s*-->$/;
export const COMMENT_START_RE = /^<!--\s*@comment-start:([a-z0-9]+)\s*-->$/;
export const COMMENT_END_RE = /^<!--\s*@comment-end:([a-z0-9]+)\s*-->$/;

// ── Helpers ───────────────────────────────────────────────────
export function isTableSep(line: string): boolean {
  return TABLE_SEP_RE.test(line.trim());
}
