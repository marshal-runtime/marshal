/**
 * MarkdownRenderer — shared Streamdown wrapper for all chat message rendering.
 *
 * Bundles the rehype pipeline (local image support), feature plugins,
 * mermaid theming, and URL-space encoding so consumers just pass children.
 */
import { harden } from "rehype-harden";
import { defaultRehypePlugins, Streamdown } from "streamdown";
import type { CustomRendererProps, PluginConfig, StreamdownProps } from "streamdown";
import type { PluggableList } from "unified";

import { MermaidDiagram } from "@/features/mermaid/MermaidDiagram";

import { isTrustedLink } from "./link-safety";
import { MarkdownLink } from "./MarkdownLink";
import { imageHardenOptions } from "./marshal-content/image-harden-options";
import { rehypeMarshalTextDirection } from "./marshal-content/markdown/direction-annotations";
import { parseMarshalMarkdownBlocks } from "./marshal-content/markdown/local-image-block-parser";
import { rehypeLocalImages } from "./marshal-content/rehype-local-images";
import { code } from "./syntax-highlighting";

// ---------------------------------------------------------------------------
// Internal config (not exported — consumers use MarkdownRenderer instead)
// ---------------------------------------------------------------------------

function MermaidBlock({ code: source, isIncomplete }: CustomRendererProps) {
  return <MermaidDiagram source={source} isIncomplete={isIncomplete} className="my-4" />;
}

// Mermaid fences go to the same viewer the file preview uses, instead of
// Streamdown's built-in mermaid block.
const plugins: PluginConfig = {
  code,
  renderers: [{ language: "mermaid", component: MermaidBlock }],
};

// Extend sanitize schema to allow local-file:, data:, and blob: protocols on
// img[src]. Sanitize runs before harden — without this, sanitize strips data:
// and blob: src attributes before harden can evaluate them.
const sanitizeTuple = defaultRehypePlugins.sanitize;
if (!Array.isArray(sanitizeTuple)) {
  throw new TypeError("Expected sanitize to be a plugin tuple");
}
const [sanitizePlugin, sanitizeSchema] = sanitizeTuple;
const extendedSanitizeSchema = {
  ...sanitizeSchema,
  protocols: {
    ...sanitizeSchema.protocols,
    src: [...(sanitizeSchema.protocols?.src || []), "local-file", "data", "blob"],
    href: [...(sanitizeSchema.protocols?.href || []), "local-file"],
  },
};

const rehypePlugins: PluggableList = [
  defaultRehypePlugins.raw,
  rehypeLocalImages,
  [sanitizePlugin, extendedSanitizeSchema],
  [harden, imageHardenOptions],
  rehypeMarshalTextDirection,
];

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export type MarkdownRendererProps = Omit<
  StreamdownProps,
  "plugins" | "rehypePlugins" | "parseMarkdownIntoBlocksFn" | "mermaid"
>;

/**
 * Pre-configured Streamdown wrapper with local image rendering, syntax
 * highlighting, Mermaid diagrams, and URL-space encoding.
 *
 * Usage:
 * ```tsx
 * <MarkdownRenderer>{content}</MarkdownRenderer>
 * <div data-streaming><MarkdownRenderer>{streamingContent}</MarkdownRenderer></div>
 * ```
 */
export function MarkdownRenderer(props: MarkdownRendererProps) {
  return (
    <Streamdown
      plugins={plugins}
      rehypePlugins={rehypePlugins}
      parseMarkdownIntoBlocksFn={parseMarshalMarkdownBlocks}
      {...props}
      components={{ ...props.components, a: MarkdownLink }}
      linkSafety={{
        enabled: true,
        onLinkCheck: isTrustedLink,
      }}
    />
  );
}
