import DOMPurify from "dompurify";

import { resolvePreviewUrl } from "./preview-support/previewUrls";

// ── HTML sanitization for markdown-embedded HTML blocks ────────

const SAFE_HTML_STYLE_PROPERTIES = new Set([
  "align-items",
  "background",
  "background-color",
  "border",
  "border-color",
  "border-radius",
  "border-style",
  "border-width",
  "color",
  "column-gap",
  "display",
  "fill",
  "flex",
  "flex-basis",
  "flex-direction",
  "flex-grow",
  "flex-shrink",
  "flex-wrap",
  "font-size",
  "font-style",
  "font-weight",
  "gap",
  "height",
  "justify-content",
  "line-height",
  "margin",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "margin-top",
  "max-height",
  "max-width",
  "min-height",
  "min-width",
  "object-fit",
  "opacity",
  "padding",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "row-gap",
  "text-align",
  "width",
]);
const UNSAFE_STYLE_VALUE_RE =
  /(?:url\s*\(|expression\s*\(|@import|javascript:|vbscript:|-moz-binding|behavior\s*:)/i;
const SAFE_HTML_URI_RE =
  /^(?:(?:https?|mailto|tel|blob|local-file|local-preview):|data:image\/|#)/i;

function sanitizeInlineStyle(styleText: string): string | null {
  const safeDeclarations: string[] = [];

  for (const declaration of styleText.split(";")) {
    const [rawProperty, ...rawValueParts] = declaration.split(":");
    const property = rawProperty?.trim().toLowerCase();
    const value = rawValueParts.join(":").trim();
    if (!property || !value || !SAFE_HTML_STYLE_PROPERTIES.has(property)) continue;
    if (UNSAFE_STYLE_VALUE_RE.test(value)) continue;
    safeDeclarations.push(`${property}: ${value}`);
  }

  return safeDeclarations.length > 0 ? safeDeclarations.join("; ") : null;
}

function resolveHtmlAssetUrls(html: string, baseFilePath?: string): string {
  if (!baseFilePath) return html;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  for (const el of doc.querySelectorAll<HTMLElement>("[src], [href]")) {
    if (el.hasAttribute("src")) {
      el.setAttribute(
        "src",
        resolvePreviewUrl(el.getAttribute("src") ?? "", baseFilePath, { kind: "embedded" }),
      );
    }
    if (el.hasAttribute("href")) {
      el.setAttribute("href", resolvePreviewUrl(el.getAttribute("href") ?? "", baseFilePath));
    }
  }
  return doc.body.innerHTML;
}

export function sanitizeHtmlBlock(html: string, baseFilePath?: string): string {
  const htmlWithResolvedAssets = resolveHtmlAssetUrls(html, baseFilePath);

  DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
    if (data.attrName !== "style") return;
    const safeStyle = sanitizeInlineStyle(data.attrValue);
    if (!safeStyle) {
      data.keepAttr = false;
      return;
    }
    data.attrValue = safeStyle;
  });

  try {
    return DOMPurify.sanitize(htmlWithResolvedAssets, {
      ADD_ATTR: ["style"],
      ALLOWED_URI_REGEXP: SAFE_HTML_URI_RE,
    });
  } finally {
    DOMPurify.removeAllHooks();
  }
}
