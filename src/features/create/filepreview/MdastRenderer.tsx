/**
 * AST-aware React renderer for mdast nodes.
 *
 * Every rendered element is annotated with `data-md-start` / `data-md-end`
 * attributes that map back to character offsets in the raw markdown source.
 * This enables `rangeToMarkdownRange()` to translate a DOM selection into
 * precise raw-markdown offsets for partial-selection editing.
 */

/* eslint-disable react/no-array-index-key -- parsed content, no stable IDs */

import type {
  Blockquote,
  Code,
  Heading,
  ListItem,
  Paragraph,
  PhrasingContent,
  RootContent,
  Table,
  TableCell,
  TableRow,
  ThematicBreak,
} from "mdast";
import type { ReactNode } from "react";

import { sanitizeHtmlBlock } from "./htmlSanitizer";
import type { Highlight } from "./markdown/highlight-extension";
import { resolvePreviewUrl } from "./preview-support/previewUrls";

// ── Position helpers ───────────────────────────────────────────

type MdPos = { "data-md-start"?: number; "data-md-end"?: number };

/** Cast unknown child nodes to PhrasingContent[] for inline rendering. */
function asPhrasingContent(nodes: unknown[]): PhrasingContent[] {
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- centralised cast for fallback render paths
  return nodes as PhrasingContent[];
}

function mdPos(node: {
  position?: { start: { offset?: number }; end: { offset?: number } };
}): MdPos {
  const s = node.position?.start.offset;
  const e = node.position?.end.offset;
  if (s == null || e == null) return {};
  return { "data-md-start": s, "data-md-end": e };
}

// ── Inline rendering ───────────────────────────────────────────

/** Render an array of phrasing content (inline) nodes. */
export function renderMdastChildren(
  children: PhrasingContent[],
  baseFilePath?: string,
): ReactNode[] {
  return children.map((child, i) => renderMdastInline(child, i, baseFilePath));
}

/** Render a single phrasing (inline) mdast node. */
function renderMdastInline(
  node: PhrasingContent,
  key: number | string,
  baseFilePath?: string,
): ReactNode {
  switch (node.type) {
    case "text":
      return (
        <span key={key} {...mdPos(node)}>
          {node.value}
        </span>
      );

    case "strong":
      return (
        <strong key={key} {...mdPos(node)}>
          {renderMdastChildren(node.children, baseFilePath)}
        </strong>
      );

    case "emphasis":
      return (
        <em key={key} {...mdPos(node)}>
          {renderMdastChildren(node.children, baseFilePath)}
        </em>
      );

    case "delete":
      return (
        <del key={key} className="line-through opacity-70" {...mdPos(node)}>
          {renderMdastChildren(node.children, baseFilePath)}
        </del>
      );

    case "inlineCode":
      return (
        <code
          key={key}
          className="rounded-[3px] bg-muted px-[5px] py-[2px] font-mono text-[0.9em]"
          {...mdPos(node)}
        >
          {node.value}
        </code>
      );

    case "link": {
      const resolved = resolvePreviewUrl(node.url, baseFilePath);
      return (
        <a
          key={key}
          className="cursor-pointer text-primary no-underline hover:underline"
          href={resolved}
          title={node.url}
          onClick={(e) => {
            e.preventDefault();
            window.open(resolved, "_blank", "noreferrer");
          }}
          {...mdPos(node)}
        >
          {renderMdastChildren(node.children, baseFilePath)}
        </a>
      );
    }

    case "image":
      return (
        <img
          key={key}
          className="my-2 block max-h-[400px] max-w-full rounded-md"
          src={resolvePreviewUrl(node.url, baseFilePath, { kind: "embedded" })}
          alt={node.alt || ""}
          loading="lazy"
          {...mdPos(node)}
        />
      );

    case "break":
      return <br key={key} />;

    case "html": {
      const autolinkMatch = node.value.match(/^<(https?:\/\/[^>]+)>$/);
      if (autolinkMatch) {
        return (
          <a
            key={key}
            className="cursor-pointer text-primary no-underline hover:underline"
            href={autolinkMatch[1]}
            onClick={(e) => {
              e.preventDefault();
              void window.shellAPI?.openExternal(autolinkMatch[1]);
            }}
            {...mdPos(node)}
          >
            {autolinkMatch[1]}
          </a>
        );
      }
      return (
        <span
          key={key}
          // Safe: sanitizeHtmlBlock() runs input through DOMPurify.sanitize() which strips
          // all dangerous tags and attributes. No unsanitized content can reach the DOM.
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: sanitizeHtmlBlock(node.value, baseFilePath) }} // nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml
          {...mdPos(node)}
        />
      );
    }

    case "highlight": {
      // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Custom extension node
      const hlNode = node as unknown as Highlight;
      return (
        <mark
          key={key}
          className="rounded-sm bg-[rgba(255,208,0,0.3)] px-[3px] py-px"
          {...mdPos(hlNode)}
        >
          {renderMdastChildren(hlNode.children, baseFilePath)}
        </mark>
      );
    }

    default:
      if ("children" in node && Array.isArray(node.children)) {
        return (
          <span key={key} {...mdPos(node)}>
            {renderMdastChildren(asPhrasingContent(node.children), baseFilePath)}
          </span>
        );
      }
      if ("value" in node) {
        return (
          <span key={key} {...mdPos(node)}>
            {String(node.value)}
          </span>
        );
      }
      return null;
  }
}

// ── Block rendering ────────────────────────────────────────────

/** Render a heading node's inline content. */
export function renderMdastHeading(node: Heading, baseFilePath?: string): ReactNode {
  return <span {...mdPos(node)}>{renderMdastChildren(node.children, baseFilePath)}</span>;
}

/** Render a paragraph node's inline content. */
export function renderMdastParagraph(node: Paragraph, baseFilePath?: string): ReactNode {
  return <span {...mdPos(node)}>{renderMdastChildren(node.children, baseFilePath)}</span>;
}

/** Render a blockquote. */
export function renderMdastBlockquote(
  node: Blockquote,
  raw: string,
  baseFilePath?: string,
): ReactNode {
  const start = node.position?.start.offset ?? 0;
  const end = node.position?.end.offset ?? 0;
  const rawText = raw.slice(start, end);
  const innerText = rawText.replace(/^>\s?/gm, "");

  const calloutMatch = innerText.match(/^\[!(NOTE|TIP|WARNING|CAUTION|IMPORTANT)\]\s*/i);
  if (calloutMatch) {
    const calloutType = calloutMatch[1].toLowerCase();
    return (
      <div
        className={`md-callout py-1 font-semibold not-italic md-callout-${calloutType}`}
        {...mdPos(node)}
      >
        <span className="md-callout-label text-[0.85em] tracking-[0.5px] uppercase">
          {calloutMatch[1]}
        </span>
      </div>
    );
  }

  return (
    <div className="text-foreground-secondary italic" {...mdPos(node)}>
      {node.children.map((child, i) => {
        if (child.type === "paragraph") {
          return (
            <span key={i} {...mdPos(child)}>
              {renderMdastChildren(child.children, baseFilePath)}
            </span>
          );
        }
        return <span key={i}>{renderMdastBlock(child, raw, baseFilePath)}</span>;
      })}
    </div>
  );
}

/** Render a list item from an mdast ListItem node. */
export function renderMdastListItem(
  node: ListItem,
  ordered: boolean,
  index: number,
  baseFilePath?: string,
): ReactNode {
  const isTask = node.checked != null;
  const checked = node.checked === true;
  const col = node.position?.start.column ?? 1;
  const indent = Math.max(0, Math.floor((col - 1) / 2));

  const inlineContent = node.children.flatMap((child) => {
    if (child.type === "paragraph") return child.children;
    if (child.type === "list") return []; // nested lists are rendered as separate segments
    return asPhrasingContent([child]);
  });

  return (
    <span className="block" style={{ paddingLeft: indent * 20 }} {...mdPos(node)}>
      {isTask ? (
        <>
          <input
            type="checkbox"
            // eslint-disable-next-line better-tailwindcss/no-unknown-classes -- custom class used as click-target hook in FilePreview
            className="md-task-checkbox mr-1.5 size-3.5 cursor-pointer align-middle accent-primary"
            checked={checked}
            readOnly
            tabIndex={-1}
          />
          <span
            className={checked ? "line-through opacity-60" : ""}
            data-testid={checked ? "task-text-checked" : undefined}
          >
            {renderMdastChildren(inlineContent, baseFilePath)}
          </span>
        </>
      ) : ordered ? (
        <>
          <span className="inline-block min-w-[1.5em] font-medium text-muted-foreground">
            {index}.
          </span>{" "}
          {renderMdastChildren(inlineContent, baseFilePath)}
        </>
      ) : (
        <>
          <span
            className="-ml-[0.2em] inline-block w-[1.2em] text-center align-baseline text-[1.1em] leading-none text-muted-foreground"
            data-testid="bullet-marker"
          >
            •
          </span>
          {renderMdastChildren(inlineContent, baseFilePath)}
        </>
      )}
    </span>
  );
}

/** Render a code block. */
export function renderMdastCode(node: Code): ReactNode {
  const lang = node.lang || "";
  return (
    <pre
      className={`relative overflow-x-auto rounded-md border border-border bg-muted px-4 py-3 font-mono text-[0.88em] leading-normal whitespace-pre my-1${lang ? ` language-${lang}` : ""}`}
      {...mdPos(node)}
    >
      <code>{node.value}</code>
      {lang && (
        <span className="absolute top-1 right-2 text-[0.75em] tracking-[0.5px] text-muted-foreground uppercase">
          {lang.replace(/\s*\{.*\}$/, "")}
        </span>
      )}
    </pre>
  );
}

/** Render a table from mdast Table node. */
export function renderMdastTable(node: Table, baseFilePath?: string): ReactNode {
  const rows = node.children;
  if (rows.length === 0) return null;

  const headerRow = rows[0];
  const bodyRows = rows.slice(1);

  return (
    <table className="my-[0.3em] w-full border-collapse text-[13px]" {...mdPos(node)}>
      <thead>
        <tr>
          {headerRow.children.map((cell: TableCell, ci: number) => (
            <th
              key={ci}
              className="border border-border bg-muted px-2.5 py-1.5 text-left font-semibold"
              {...mdPos(cell)}
            >
              {renderMdastChildren(cell.children, baseFilePath)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {bodyRows.map((row: TableRow, ri: number) => (
          <tr key={ri} className="hover:[&>td]:bg-muted">
            {row.children.map((cell: TableCell, ci: number) => (
              <td
                key={ci}
                className="border border-border px-2.5 py-1.5 text-left"
                {...mdPos(cell)}
              >
                {renderMdastChildren(cell.children, baseFilePath)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Render a thematic break (hr). */
export function renderMdastHr(node: ThematicBreak): ReactNode {
  return <hr className="my-[0.8em] border-0 border-t border-t-border" {...mdPos(node)} />;
}

/** Render any mdast block node. Segment-level entry point used by SegmentRenderer. */
export function renderMdastBlock(node: RootContent, raw: string, baseFilePath?: string): ReactNode {
  switch (node.type) {
    case "heading":
      return renderMdastHeading(node, baseFilePath);
    case "paragraph":
      return renderMdastParagraph(node, baseFilePath);
    case "blockquote":
      return renderMdastBlockquote(node, raw, baseFilePath);
    case "list":
      return node.children.map((item, i) =>
        renderMdastListItem(item, node.ordered ?? false, (node.start ?? 1) + i, baseFilePath),
      );
    case "listItem":
      return renderMdastListItem(node, false, 0, baseFilePath);
    case "code":
      return renderMdastCode(node);
    case "table":
      return renderMdastTable(node, baseFilePath);
    case "thematicBreak":
      return renderMdastHr(node);
    default:
      if ("children" in node && Array.isArray(node.children)) {
        return renderMdastChildren(asPhrasingContent(node.children), baseFilePath);
      }
      if ("value" in node) {
        return <span {...mdPos(node)}>{node.value}</span>;
      }
      return null;
  }
}
