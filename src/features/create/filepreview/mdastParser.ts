/**
 * CommonMark-based markdown parser using mdast.
 *
 * Replaces the regex-based `parseSegments` with a proper AST that carries
 * positional metadata (character offsets) on every node.  This enables
 * precise partial-selection editing — no more string-search heuristics.
 */

import type { Nodes, Root, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

import { highlight, highlightFromMarkdown } from "./markdown/highlight-extension";
import { mathFromMarkdown } from "./markdown/math-extension";
import {
  COMMENT_RE,
  COMMENT_START_RE,
  COMMENT_END_RE,
  type Segment,
} from "./preview-support/segment-types";

// ── Parse raw markdown to mdast AST ────────────────────────────

/** Parse raw markdown into an mdast AST with full position info. */
export function parseMarkdownToAst(raw: string): Root {
  return fromMarkdown(raw, {
    extensions: [gfm(), highlight()],
    mdastExtensions: [gfmFromMarkdown(), highlightFromMarkdown(), mathFromMarkdown(raw)],
  });
}

// ── Frontmatter detection ──────────────────────────────────────

const FRONTMATTER_MAX_LINES = 1000;

/**
 * If the raw text starts with YAML frontmatter (`---`), return the
 * character offset just past its closing `---` (and any trailing blank
 * line).  Returns 0 when no frontmatter is detected.
 */
function skipFrontmatter(raw: string): number {
  if (!raw.startsWith("---")) return 0;

  const lines = raw.split("\n");
  if (lines[0].trim() !== "---") return 0;

  let sawYamlKey = false;
  const maxLine = Math.min(lines.length, FRONTMATTER_MAX_LINES);
  let charOffset = lines[0].length + 1; // past first line + \n

  for (let i = 1; i < maxLine; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "---") {
      if (!sawYamlKey) return 0;
      charOffset += lines[i].length + 1;
      // Skip optional blank line after frontmatter
      if (i + 1 < lines.length && lines[i + 1].trim() === "") {
        charOffset += lines[i + 1].length + 1;
      }
      return charOffset;
    }
    if (/^[A-Za-z0-9_-]+:\s*(?:.*)$/.test(lines[i])) {
      sawYamlKey = true;
    }
    charOffset += lines[i].length + 1;
  }

  return 0;
}

// ── AST → Segment[] mapping ────────────────────────────────────

/** Compute (0-based) line index from character offset. */
function offsetToLine(offset: number, lineBreaks: number[]): number {
  // lineBreaks[i] = offset of the \n ending line i
  // Binary search for the line containing `offset`
  let lo = 0;
  let hi = lineBreaks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lineBreaks[mid] < offset) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** Pre-compute line break positions for fast offset→line lookups. */
function buildLineBreaks(raw: string): number[] {
  const breaks: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "\n") breaks.push(i);
  }
  return breaks;
}

/**
 * Detect if a raw HTML string is one of our comment/anchor markers.
 * Returns the comment segment info or null.
 */
function detectComment(htmlValue: string): {
  type: "comment" | "comment-start" | "comment-end";
  anchorId?: string;
} | null {
  const trimmed = htmlValue.trim();
  if (COMMENT_RE.test(trimmed)) {
    const m = trimmed.match(COMMENT_RE);
    return { type: "comment", anchorId: m?.[2] || undefined };
  }
  if (COMMENT_START_RE.test(trimmed)) {
    return { type: "comment-start" };
  }
  if (COMMENT_END_RE.test(trimmed)) {
    return { type: "comment-end" };
  }
  return null;
}

/**
 * Check if an HTML node represents a `<details>` block.
 */
function isDetailsHtml(value: string): boolean {
  const firstLine = value.trim().split("\n")[0].trim();
  return firstLine === "<details>" || firstLine.startsWith("<details ");
}

/**
 * Recursively flatten a list node into individual list-item segments.
 * Each listItem becomes its own segment; nested sub-lists within a
 * listItem are flattened in-order so the editor sees every item as
 * a separate, re-orderable row.
 */
function flattenList(
  listNode: import("mdast").List,
  segments: Segment[],
  lineBreaks: number[],
): void {
  for (const item of listNode.children) {
    if (!item.position) continue;
    const itemStart = item.position.start.offset!;

    // Find the first nested list child — the item's own content ends there
    const nestedLists: import("mdast").List[] = [];
    let ownEnd = item.position.end.offset!;
    for (const child of item.children) {
      if (child.type === "list" && child.position) {
        nestedLists.push(child);
        if (child.position.start.offset! < ownEnd) {
          ownEnd = child.position.start.offset!;
        }
      }
    }

    segments.push({
      type: "list-item",
      start: offsetToLine(itemStart, lineBreaks),
      end: offsetToLine(Math.max(itemStart, ownEnd - 1), lineBreaks),
      mdStart: itemStart,
      mdEnd: ownEnd,
      ast: item,
    });

    // Recurse into nested sub-lists
    for (const nested of nestedLists) {
      flattenList(nested, segments, lineBreaks);
    }
  }
}

/**
 * Convert an mdast AST into the Segment[] structure used by the editor.
 *
 * Each segment carries:
 * - `type`: segment classification (heading, paragraph, etc.)
 * - `start` / `end`: line indices (inclusive), for backward compat
 * - `mdStart` / `mdEnd`: character offsets in raw markdown, for precise editing
 * - `ast`: the mdast node, for AST-aware rendering
 */
export function astToSegments(ast: Root, raw: string): Segment[] {
  const frontmatterEnd = skipFrontmatter(raw);
  const lineBreaks = buildLineBreaks(raw);
  const segments: Segment[] = [];

  // Group consecutive html nodes that form comment threads
  let i = 0;
  const children = ast.children;

  while (i < children.length) {
    const node = children[i];
    const pos = node.position;
    if (!pos) {
      i++;
      continue;
    }

    const mdStart = pos.start.offset!;
    const mdEnd = pos.end.offset!;

    // Skip nodes that fall within frontmatter
    if (mdStart < frontmatterEnd) {
      i++;
      continue;
    }

    const startLine = offsetToLine(mdStart, lineBreaks);
    const endLine = offsetToLine(Math.max(mdStart, mdEnd - 1), lineBreaks);

    switch (node.type) {
      case "heading":
        segments.push({
          type: "heading",
          start: startLine,
          end: endLine,
          headingLevel: node.depth,
          mdStart,
          mdEnd,
          ast: node,
        });
        break;

      case "paragraph":
        segments.push({
          type: "paragraph",
          start: startLine,
          end: endLine,
          mdStart,
          mdEnd,
          ast: node,
        });
        break;

      // mathBlock nodes are created by the Markdown extension transform from $$...$$ paragraphs
      case "mathBlock":
        segments.push({
          type: "math-block",
          start: startLine,
          end: endLine,
          mdStart,
          mdEnd,
          ast: node,
        });
        break;

      case "blockquote":
        segments.push({
          type: "blockquote",
          start: startLine,
          end: endLine,
          mdStart,
          mdEnd,
          ast: node,
        });
        break;

      case "list": {
        // Recursively flatten list items (including nested sub-lists)
        flattenList(node, segments, lineBreaks);
        break;
      }

      case "code":
        segments.push({
          type: "code",
          start: startLine,
          end: endLine,
          lang: node.lang || "",
          mdStart,
          mdEnd,
          ast: node,
        });
        break;

      case "table":
        segments.push({
          type: "table",
          start: startLine,
          end: endLine,
          mdStart,
          mdEnd,
          ast: node,
        });
        break;

      case "thematicBreak":
        segments.push({
          type: "hr",
          start: startLine,
          end: endLine,
          mdStart,
          mdEnd,
          ast: node,
        });
        break;

      case "html": {
        const htmlValue = node.value;
        const commentInfo = detectComment(htmlValue);

        if (commentInfo) {
          if (commentInfo.type === "comment-start" || commentInfo.type === "comment-end") {
            // Comment anchor markers — rendered as invisible blank segments
            segments.push({
              type: "blank",
              start: startLine,
              end: endLine,
              mdStart,
              mdEnd,
              ast: node,
            });
          } else {
            // Start of a comment thread — consume consecutive comment HTML nodes
            const threadStart = mdStart;
            const threadStartLine = startLine;
            let threadEnd = mdEnd;
            let threadEndLine = endLine;
            const anchorId = commentInfo.anchorId;
            let j = i + 1;

            while (j < children.length) {
              const next = children[j];
              if (
                next.type === "html" &&
                next.position &&
                detectComment(next.value)?.type === "comment"
              ) {
                threadEnd = next.position.end.offset!;
                threadEndLine = offsetToLine(
                  Math.max(next.position.start.offset!, threadEnd - 1),
                  lineBreaks,
                );
                j++;
              } else {
                break;
              }
            }

            segments.push({
              type: "comment",
              start: threadStartLine,
              end: threadEndLine,
              anchorId,
              mdStart: threadStart,
              mdEnd: threadEnd,
              ast: node,
            });
            i = j;
            continue; // skip the i++ at end of loop
          }
        } else if (isDetailsHtml(htmlValue)) {
          // <details> block — mdast puts the entire block in a single html node
          segments.push({
            type: "details",
            start: startLine,
            end: endLine,
            mdStart,
            mdEnd,
            ast: node,
          });
        } else {
          // Generic HTML block
          segments.push({
            type: "html-block",
            start: startLine,
            end: endLine,
            mdStart,
            mdEnd,
            ast: node,
          });
        }
        break;
      }

      case "definition":
        segments.push({
          type: "definition",
          start: startLine,
          end: endLine,
          mdStart,
          mdEnd,
          ast: node,
        });
        break;

      default:
        // Any unknown node type — render as raw text fallback
        segments.push({
          type: "unknown",
          start: startLine,
          end: endLine,
          mdStart,
          mdEnd,
          ast: node,
        });
        break;
    }

    i++;
  }

  // Insert blank segments for empty lines between content segments.
  // The editor expects a segment for every line range, including blanks.
  const allSegments = insertBlankSegments(segments, raw, lineBreaks, frontmatterEnd);

  return allSegments;
}

/**
 * Fill gaps between segments with "blank" segments so that every line
 * in the document is covered.  The editor relies on this for drag/drop
 * and click-to-activate.
 */
function insertBlankSegments(
  segments: Segment[],
  raw: string,
  lineBreaks: number[],
  fromOffset: number,
): Segment[] {
  if (segments.length === 0) {
    // Entire document is blank (or only frontmatter)
    const totalLines = raw.split("\n").length;
    const startLine = offsetToLine(fromOffset, lineBreaks);
    const result: Segment[] = [];
    for (let line = startLine; line < totalLines; line++) {
      result.push({
        type: "blank",
        start: line,
        end: line,
        mdStart: line === 0 ? fromOffset : lineBreaks[line - 1] + 1,
        mdEnd: line < lineBreaks.length ? lineBreaks[line] : raw.length,
      });
    }
    return result;
  }

  const result: Segment[] = [];
  let lastEndLine = segments.length > 0 ? segments[0].start : 0;

  // Fill blanks before first segment
  const startLine = offsetToLine(fromOffset, lineBreaks);
  for (let line = startLine; line < segments[0].start; line++) {
    result.push({
      type: "blank",
      start: line,
      end: line,
      mdStart: line === 0 ? fromOffset : lineBreaks[line - 1] + 1,
      mdEnd: line < lineBreaks.length ? lineBreaks[line] : raw.length,
    });
  }

  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];

    // Fill blanks between previous segment and this one
    if (s > 0) {
      const prevEnd = segments[s - 1].end;
      for (let line = prevEnd + 1; line < seg.start; line++) {
        result.push({
          type: "blank",
          start: line,
          end: line,
          mdStart: lineBreaks[line - 1] + 1,
          mdEnd: line < lineBreaks.length ? lineBreaks[line] : raw.length,
        });
      }
    }

    result.push(seg);
    lastEndLine = seg.end;
  }

  // Fill blanks after last segment
  const totalLines = raw.split("\n").length;
  for (let line = lastEndLine + 1; line < totalLines; line++) {
    const lineStart = lineBreaks[line - 1] + 1;
    const lineEnd = line < lineBreaks.length ? lineBreaks[line] : raw.length;
    // Only add blank if the line is actually empty
    if (raw.slice(lineStart, lineEnd).trim() === "") {
      result.push({
        type: "blank",
        start: line,
        end: line,
        mdStart: lineStart,
        mdEnd: lineEnd,
      });
    }
  }

  return result;
}

// Re-export for convenience
export type { Nodes, Root, RootContent };

// ── Orphan normalization ───────────────────────────────────────

/**
 * Patterns that represent empty/orphaned inline markdown syntax.
 * After a partial deletion that removes content from inside formatting
 * markers (e.g., deleting "bold" from "**bold**"), these empty markers
 * should be cleaned up to avoid saving invalid markdown to disk.
 */
const ORPHAN_PATTERNS = [
  /\*\*\s*\*\*/g, // **   ** (empty bold)
  /\*\*\*\s*\*\*\*/g, // ***   *** (empty bold+italic)
  /__\s*__/g, // __   __ (empty bold)
  /___\s*___/g, // ___   ___ (empty bold+italic)
  /~~\s*~~/g, // ~~   ~~ (empty strikethrough)
  /==\s*==/g, // ==   == (empty highlight)
  /`\s*`/g, // `   ` (empty inline code)
  /\[]\([^)]*\)/g, // [](url) (empty link text)
];

/**
 * Remove orphaned inline markup from text that would result in
 * invalid or meaningless markdown.
 *
 * Called after partial-selection edits to prevent data corruption
 * (e.g., deleting "bold" from "**bold**" should not leave "****").
 *
 * Loops until stable to handle nested orphans — e.g. deleting "strike"
 * from "**bold ~~strike~~**" leaves "**bold ~~~~**", which collapses
 * to "**bold ****", then to "**bold **", etc.
 */
export function normalizeOrphans(text: string): string {
  let result = text;
  let prev: string;
  do {
    prev = result;
    for (const pattern of ORPHAN_PATTERNS) {
      result = result.replace(pattern, "");
    }
  } while (result !== prev);
  // Clean up double spaces left behind
  return result.replace(/ {2,}/g, " ");
}
