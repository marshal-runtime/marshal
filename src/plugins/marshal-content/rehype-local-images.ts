/**
 * Rehype plugin: rewrite local file URLs to the local-file: protocol.
 *
 * ORDERING: This plugin MUST run before rehype-sanitize and rehype-harden.
 * - Before sanitize: because sanitize strips src/href attributes with protocols
 *   not in its allowlist (default: http/https only).
 * - Before harden: because harden hardcode-blocks the file: protocol
 *   (see node_modules/rehype-harden/dist/index.js:72 — blockedProtocols Set).
 *   The allowedProtocols option cannot override this.
 *
 * We rewrite file:// URLs and bare absolute paths (e.g. C:\...) to
 * local-file:// which both sanitize (via extended schema) and harden allow.
 *
 * For images: Electron's local-file: protocol handler serves them via net.fetch.
 * For links: Streamdown's onClick calls window.open(href), which
 * setWindowOpenHandler routes to openLocalFileSafe in the main process.
 *
 * Note: URLs with unencoded spaces never reach this plugin — the markdown
 * parser treats them as plain text. Use parseMarshalMarkdownBlocks() from
 * markdown/local-image-block-parser.ts to preprocess the raw markdown.
 */
import type { Element, Root } from "hast";
import { visit } from "unist-util-visit";

import { remoteMediaUrl } from "../../shared/remote-media-url";

const LOCAL_IMAGE_SUFFIX = /\.(?:png|jpe?g|gif|svg|webp)$/i;

/** Rewrite a file:// or bare Windows path to local-file:// */
function normalizeLocalFileUrl(value: string): string | null {
  const remote = remoteMediaUrl(value);
  if (remote !== value) return remote;
  if (/^file:\/{2,3}/i.test(value)) {
    return value.replace(/^file:\/{2,3}/i, "local-file:///");
  }
  if (/^[A-Za-z]:[/\\]/.test(value)) {
    return `local-file:///${value.replaceAll("\\", "/")}`;
  }
  return null;
}

export function rehypeLocalImages() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (node.tagName === "img" && node.properties?.src) {
        const src = String(node.properties.src);
        if (!LOCAL_IMAGE_SUFFIX.test(src)) return;
        const rewritten = normalizeLocalFileUrl(src);
        if (rewritten) node.properties.src = rewritten;
      }

      if (node.tagName === "a" && node.properties?.href) {
        const href = String(node.properties.href);
        const rewritten = normalizeLocalFileUrl(href);
        if (rewritten) node.properties.href = rewritten;
      }
    });
  };
}
