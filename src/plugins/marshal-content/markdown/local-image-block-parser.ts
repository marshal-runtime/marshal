import { parseMarkdownIntoBlocks } from "streamdown";

/**
 * URL-encode spaces in local image paths before markdown parsing.
 *
 * Markdown parsers don't create <img> nodes when URLs contain spaces —
 * the entire `![alt](url)` is treated as plain text. No tree-based plugin
 * (remark or rehype) can fix this because the image is never parsed.
 */
function encodeLocalImagePaths(text: string): string {
  return text.replace(
    /!\[([^\]]*)\]\(((?:file:\/\/\/|[A-Za-z]:[/\\])[^)]*\.(?:png|jpe?g|gif|svg|webp))\)/gi,
    (match, alt: string, url: string) => {
      if (!url.includes(" ")) return match;
      return `![${alt}](${url.replace(/ /g, "%20")})`;
    },
  );
}

/**
 * Wraps Streamdown's default block parser with URL encoding for local images.
 * Passed as `parseMarkdownIntoBlocksFn` prop to Streamdown.
 */
export function parseMarshalMarkdownBlocks(markdown: string): string[] {
  return parseMarkdownIntoBlocks(encodeLocalImagePaths(markdown));
}
