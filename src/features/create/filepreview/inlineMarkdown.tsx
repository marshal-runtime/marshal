import type { ReactNode } from "react";

import { resolvePreviewUrl } from "./preview-support/previewUrls";

/* eslint-disable react/only-export-components -- utility functions, not React components */
// ── Inline Markdown Parser ────────────────────────────────────
export const INLINE_RE =
  /(\\[\\*_~`[\]#>!]|\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`|\*[^*]+\*|_[^_]+_|==[^=]+==|!\[[^\]]*\]\([^)]+\)|\[[^\]]+\]\([^)]+\)|<https?:\/\/[^>]+>|<\/?(?:kbd|mark|sub|sup)>)/g;

export function parseInline(text: string, baseFilePath?: string): ReactNode {
  const parts = text.split(INLINE_RE);
  if (parts.length === 1) return text;
  return parts.map((part, i) => {
    if (!part) return null;
    // Escaped character: \* \_ \~ etc → literal character
    if (/^\\[\\*_~`[\]#>!]$/.test(part)) return part.slice(1);
    // Bold+italic ***text***
    if (part.startsWith("***") && part.endsWith("***"))
      return (
        // eslint-disable-next-line react/no-array-index-key -- parsed content, no stable IDs
        <strong key={i}>
          <em>{part.slice(3, -3)}</em>
        </strong>
      );
    if (part.startsWith("**") && part.endsWith("**"))
      // eslint-disable-next-line react/no-array-index-key -- parsed content, no stable IDs
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("~~") && part.endsWith("~~"))
      return (
        // eslint-disable-next-line react/no-array-index-key -- parsed content, no stable IDs
        <del key={i} className="line-through opacity-70">
          {part.slice(2, -2)}
        </del>
      );
    if (part.startsWith("`") && part.endsWith("`"))
      return (
        // eslint-disable-next-line react/no-array-index-key -- parsed content, no stable IDs
        <code key={i} className="rounded-[3px] bg-muted px-[5px] py-[2px] font-mono text-[0.9em]">
          {part.slice(1, -1)}
        </code>
      );
    if (part.startsWith("==") && part.endsWith("=="))
      return (
        // eslint-disable-next-line react/no-array-index-key -- parsed content, no stable IDs
        <mark key={i} className="rounded-sm bg-[rgba(255,208,0,0.3)] px-[3px] py-px">
          {part.slice(2, -2)}
        </mark>
      );
    if (
      (part.startsWith("*") && part.endsWith("*")) ||
      (part.startsWith("_") && part.endsWith("_"))
    )
      // eslint-disable-next-line react/no-array-index-key -- parsed content, no stable IDs
      return <em key={i}>{part.slice(1, -1)}</em>;
    // ![alt](url)
    const imgMatch = part.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imgMatch)
      return (
        <img
          // eslint-disable-next-line react/no-array-index-key -- parsed content, no stable IDs
          key={i}
          className="my-2 block max-h-[400px] max-w-full rounded-md"
          src={resolvePreviewUrl(imgMatch[2], baseFilePath, { kind: "embedded" })}
          alt={imgMatch[1]}
          loading="lazy"
        />
      );
    // [text](url)
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      const resolved = resolvePreviewUrl(linkMatch[2], baseFilePath);
      return (
        <a
          // eslint-disable-next-line react/no-array-index-key -- parsed content, no stable IDs
          key={i}
          className="cursor-pointer text-primary no-underline hover:underline"
          href={resolved}
          title={linkMatch[2]}
          onClick={(e) => {
            e.preventDefault();
            // All URLs go through window.open → setWindowOpenHandler → handleLinkOpen.
            // file:// URLs are rewritten to local-file:// by rehype-local-images,
            // and handleLinkOpen routes them to openLocalFileSafe.
            window.open(resolved, "_blank", "noreferrer");
          }}
        >
          {linkMatch[1]}
        </a>
      );
    }
    // <https://url> autolink
    const autoMatch = part.match(/^<(https?:\/\/[^>]+)>$/);
    if (autoMatch)
      return (
        <a
          // eslint-disable-next-line react/no-array-index-key -- parsed content, no stable IDs
          key={i}
          className="cursor-pointer text-primary no-underline hover:underline"
          href={autoMatch[1]}
          onClick={(e) => {
            e.preventDefault();
            void window.shellAPI?.openExternal(autoMatch[1]);
          }}
        >
          {autoMatch[1]}
        </a>
      );
    // HTML inline tags — skip these (handled by parseInlineRich)
    if (/^<\/?(kbd|mark|sub|sup)>$/.test(part)) return null;
    return part;
  });
}

/** Parse inline with HTML tag support (kbd, mark, sub, sup) */
export function parseInlineRich(text: string, baseFilePath?: string): ReactNode {
  // Handle <kbd>...</kbd>, <mark>...</mark>, <sub>...</sub>, <sup>...</sup>
  const htmlTagRe = /<(kbd|mark|sub|sup)>(.*?)<\/\1>/g;
  const parts: ReactNode[] = [];
  let lastIdx = 0;
  let match;
  while ((match = htmlTagRe.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(parseInline(text.slice(lastIdx, match.index), baseFilePath));
    }
    const tagName = match[1];
    if (tagName !== "kbd" && tagName !== "mark" && tagName !== "sub" && tagName !== "sup") continue;
    const Tag = tagName;
    parts.push(<Tag key={match.index}>{parseInline(match[2], baseFilePath)}</Tag>);
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) {
    parts.push(parseInline(text.slice(lastIdx), baseFilePath));
  }
  return parts.length === 1 ? parts[0] : <>{parts}</>;
}
