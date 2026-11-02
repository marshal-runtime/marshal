/**
 * Rehype plugin: add `dir` to text-bearing block elements for RTL support.
 *
 * ORDERING: Must run AFTER sanitize/harden so the `dir` attribute isn't stripped.
 */
import type { Element, Root } from "hast";
import { visit } from "unist-util-visit";

const TEXT_ELEMENTS = new Set([
  "p",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "td",
  "th",
  "summary",
  "dt",
  "dd",
]);

const CODE_ELEMENTS = new Set(["pre"]);

const RTL_REGEX =
  /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u0780-\u07BF\u07C0-\u07FF\u0800-\u083F\u0840-\u085F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

// Presence-based (not first-strong-char or counting): any RTL character → dir="rtl".
// Trade-off: an English paragraph containing one Hebrew word gets RTL. In practice this
// almost never happens — Hebrew/Arabic paragraphs routinely embed English words (brand
// names, tech terms), but English paragraphs rarely contain RTL words. The alternative
// (dir="auto") fails when RTL paragraphs start with an English word.
export function resolveContentDirection(text: string): "rtl" | "auto" {
  return RTL_REGEX.test(text) ? "rtl" : "auto";
}

function extractText(node: Element): string {
  let text = "";
  for (const child of node.children) {
    if (child.type === "text") {
      text += child.value;
    } else if (child.type === "element") {
      text += extractText(child);
    }
  }
  return text;
}

export function rehypeMarshalTextDirection() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      node.properties ??= {};
      if (node.properties.dir) return;
      if (TEXT_ELEMENTS.has(node.tagName)) {
        const text = extractText(node);
        node.properties.dir = resolveContentDirection(text);
      } else if (CODE_ELEMENTS.has(node.tagName)) {
        node.properties.dir = "ltr";
      }
    });
  };
}
