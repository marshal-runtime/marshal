/* eslint-disable react-refresh/only-export-components */
import type { ReactNode } from "react";

import { MermaidDiagram } from "@/features/mermaid/MermaidDiagram";

import { parseInlineRich } from "../inlineMarkdown";
import { type Segment } from "../markdownParser";
import {
  renderMdastBlockquote,
  renderMdastHeading,
  renderMdastListItem,
  renderMdastParagraph,
  renderMdastTable,
} from "../MdastRenderer";
import { renderHtmlBlock, RenderedCodeBlock, RenderedDetails } from "./block-renderers";
import { RenderedComment } from "./comment-renderer";

export { RenderedComment };

export function renderSegmentContent(
  seg: Segment,
  lines: string[],
  baseFilePath?: string,
): ReactNode {
  const segLines = lines.slice(seg.start, seg.end + 1);
  switch (seg.type) {
    case "heading":
      return renderMdastHeading(seg.ast, baseFilePath);
    case "paragraph":
      return renderMdastParagraph(seg.ast, baseFilePath);
    case "blockquote":
      return renderMdastBlockquote(seg.ast, lines.join("\n"), baseFilePath);
    case "list-item": {
      const lineText = segLines[0] || "";
      const olMatch = lineText.match(/^\s*(\d+)\.\s/);
      return renderMdastListItem(
        seg.ast,
        !!olMatch,
        olMatch ? parseInt(olMatch[1], 10) : 0,
        baseFilePath,
      );
    }
    case "table":
      return renderMdastTable(seg.ast, baseFilePath);
    case "hr":
      return <hr className="my-[0.8em] border-0 border-t border-t-border" />;
    case "code":
      return seg.lang === "mermaid" ? (
        <MermaidDiagram source={segLines.slice(1, -1).join("\n")} className="my-1" />
      ) : (
        <RenderedCodeBlock lines={segLines} lang={seg.lang} />
      );
    case "details":
      return <RenderedDetails lines={segLines} />;
    case "math-block":
      return (
        <pre className="my-1 rounded-md border border-border bg-muted px-4 py-3 text-center font-mono text-[0.88em] leading-normal text-foreground-secondary">
          <code>{segLines.slice(1, -1).join("\n")}</code>
        </pre>
      );
    case "html-block":
      return renderHtmlBlock(segLines, baseFilePath);
    case "comment":
    case "definition":
      return null;
    case "blank":
      return <div className="min-h-[0.4em]">&nbsp;</div>;
    case "unknown":
      return parseInlineRich(segLines[0], baseFilePath);
    default:
      return assertNever(seg);
  }
}

function assertNever(x: never): never {
  throw new Error(`Unhandled segment type: ${JSON.stringify(x)}`);
}
