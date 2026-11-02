/* eslint-disable react-refresh/only-export-components */
import type { ReactNode } from "react";

import { MermaidDiagram } from "@/features/mermaid/MermaidDiagram";

import { sanitizeHtmlBlock } from "../htmlSanitizer";
import { parseInlineRich } from "../inlineMarkdown";
import { FENCE_RE, TABLE_ROW_RE, isTableSep } from "../markdownParser";

export function RenderedCodeBlock({ lines, lang }: { lines: string[]; lang: string }) {
  const code = lines.slice(1, -1).join("\n");
  return (
    <pre
      className={`relative overflow-x-auto rounded-md border border-border bg-muted px-4 py-3 font-mono text-[0.88em] leading-normal whitespace-pre my-1${lang ? ` language-${lang}` : ""}`}
    >
      <code>{code}</code>
      {lang && (
        <span className="absolute top-1 right-2 text-[0.75em] tracking-[0.5px] text-muted-foreground uppercase">
          {lang.replace(/\s*\{.*\}$/, "")}
        </span>
      )}
    </pre>
  );
}

export function RenderedTable({ lines }: { lines: string[] }) {
  const headerCells =
    lines[0]
      .match(TABLE_ROW_RE)?.[1]
      .split("|")
      .map((c) => c.trim()) ?? [];
  const bodyRows = lines
    .slice(2)
    .filter((l) => !isTableSep(l.trim()))
    .map(
      (l) =>
        l
          .match(TABLE_ROW_RE)?.[1]
          .split("|")
          .map((c) => c.trim()) ?? [],
    );

  return (
    <table className="my-[0.3em] w-full border-collapse text-[13px]">
      <thead>
        <tr>
          {headerCells.map((cell, ci) => (
            <th
              // eslint-disable-next-line react/no-array-index-key -- parsed content, no stable IDs
              key={ci}
              className="border border-border bg-muted px-2.5 py-1.5 text-left font-semibold"
            >
              {parseInlineRich(cell)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {bodyRows.map((row, ri) => (
          // eslint-disable-next-line react/no-array-index-key -- parsed content, no stable IDs
          <tr key={ri} className="hover:[&>td]:bg-muted">
            {row.map((cell, ci) => (
              // eslint-disable-next-line react/no-array-index-key -- parsed content, no stable IDs
              <td key={ci} className="border border-border px-2.5 py-1.5 text-left">
                {parseInlineRich(cell)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RenderedDetails({ lines }: { lines: string[] }) {
  const renderBody = (bodyLines: string[]): ReactNode[] => {
    const elems: ReactNode[] = [];
    let j = 0;
    while (j < bodyLines.length) {
      const t = bodyLines[j].trim();
      if (t === "<details>" || t.startsWith("<details ")) {
        j++;
        let summary = "";
        if (j < bodyLines.length) {
          const sm = bodyLines[j].match(/<summary>(.*?)<\/summary>/);
          if (sm) {
            summary = sm[1];
            j++;
          }
        }
        const nested: string[] = [];
        let depth = 1;
        while (j < bodyLines.length && depth > 0) {
          const tt = bodyLines[j].trim();
          if (tt === "<details>" || tt.startsWith("<details ")) depth++;
          if (tt === "</details>") depth--;
          if (depth > 0) nested.push(bodyLines[j]);
          j++;
        }
        elems.push(
          <details
            key={`nested-${j}`}
            className="my-1 overflow-hidden rounded-md border border-border"
          >
            <summary className="cursor-pointer bg-muted px-3 py-2 font-semibold select-none hover:bg-card">
              {summary || "Details"}
            </summary>
            <div className="px-3 py-2 [&>p]:my-1">{renderBody(nested)}</div>
          </details>,
        );
      } else if (t === "") {
        j++;
      } else if (FENCE_RE.test(t)) {
        const fence = t.match(FENCE_RE)![1];
        const lang = t.slice(fence.length).trim();
        const codeLines: string[] = [];
        j++;
        while (j < bodyLines.length) {
          if (
            bodyLines[j].trim().startsWith(fence) &&
            bodyLines[j].trim().length === fence.length
          ) {
            j++;
            break;
          }
          codeLines.push(bodyLines[j]);
          j++;
        }
        if (lang === "mermaid") {
          elems.push(
            <MermaidDiagram key={`mermaid-${j}`} source={codeLines.join("\n")} className="my-1" />,
          );
        } else {
          elems.push(
            <RenderedCodeBlock
              key={`code-${j}`}
              lines={[`${fence}${lang}`, ...codeLines, fence]}
              lang={lang}
            />,
          );
        }
      } else if (TABLE_ROW_RE.test(t)) {
        const tableLines: string[] = [];
        while (j < bodyLines.length && TABLE_ROW_RE.test(bodyLines[j].trim())) {
          tableLines.push(bodyLines[j]);
          j++;
        }
        if (tableLines.length >= 2)
          elems.push(<RenderedTable key={`table-${j}`} lines={tableLines} />);
      } else {
        elems.push(<p key={j}>{parseInlineRich(bodyLines[j])}</p>);
        j++;
      }
    }
    return elems;
  };

  let summary = "";
  let bodyStart = 1;
  if (lines.length > 1) {
    const sm = lines[1].match(/<summary>(.*?)<\/summary>/);
    if (sm) {
      summary = sm[1];
      bodyStart = 2;
    }
  }
  return (
    <details className="my-1 overflow-hidden rounded-md border border-border">
      <summary className="cursor-pointer bg-muted px-3 py-2 font-semibold select-none hover:bg-card">
        {summary || "Details"}
      </summary>
      <div className="px-3 py-2 [&>p]:my-1">{renderBody(lines.slice(bodyStart, -1))}</div>
    </details>
  );
}

export function renderHtmlBlock(lines: string[], baseFilePath?: string) {
  return (
    <div
      // eslint-disable-next-line better-tailwindcss/no-unknown-classes -- custom markdown styling hook defined in src/index.css
      className="md-html-block py-1"
      // Safe: sanitizeHtmlBlock() runs the input through DOMPurify.sanitize() which strips
      // all dangerous tags and attributes.
      // Rule: https://semgrep.dev/r/typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: sanitizeHtmlBlock(lines.join("\n"), baseFilePath) }} // nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml
    />
  );
}
