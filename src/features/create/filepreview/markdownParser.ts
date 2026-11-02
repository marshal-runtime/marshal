// Re-export shared types and constants from segment-types (barrel for backward compat)
export {
  type Segment,
  type SegmentType,
  TABLE_ROW_RE,
  FENCE_RE,
  COMMENT_RE,
  COMMENT_START_RE,
  COMMENT_END_RE,
  isTableSep,
} from "./preview-support/segment-types";

import { parseMarkdownToAst, astToSegments } from "./mdastParser";
import type { Segment } from "./preview-support/segment-types";

// ── Segment Parser ────────────────────────────────────────────
export function parseSegments(allLines: string[]): Segment[] {
  const raw = allLines.join("\n");
  const ast = parseMarkdownToAst(raw);
  return astToSegments(ast, raw);
}
