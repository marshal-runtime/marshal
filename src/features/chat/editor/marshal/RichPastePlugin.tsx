// Marshal-owned module.
/**
 * Intercepts Lexical's PASTE_COMMAND to replace anchor display text with
 * its href for rich-text pastes (e.g. copying a hyperlink from a browser).
 *
 * Without this, pasting a link like "Click me" (href: https://example.com)
 * inserts only the visible label "Click me" rather than the URL itself.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createTextNode, $insertNodes, COMMAND_PRIORITY_HIGH, PASTE_COMMAND } from "lexical";
import { useEffect } from "react";

/**
 * Walk `node` recursively in document order and collect http(s) anchors that
 * qualify for substitution (visible label differs from href).
 *
 * Skips aria-hidden subtrees - office and chat clients' clipboard HTML often
 * duplicates the anchor's visible label in a sibling aria-hidden element for
 * screen readers, and those duplicates must not generate a second substitution
 * entry.
 */
function collectAnchors(node: Node): Array<{ label: string; href: string }> {
  if (node instanceof Element) {
    if (node.getAttribute("aria-hidden") === "true") return [];
    if (node instanceof HTMLAnchorElement) {
      try {
        const url = new URL(node.href);
        if (url.protocol === "http:" || url.protocol === "https:") {
          // Normalize NBSP to space so email/chat client anchor text aligns with
          // the plain-text clipboard copy.
          const label = (node.textContent ?? "").replace(/\u00a0/g, " ").trim();
          if (label && label !== node.href) {
            return [{ label, href: node.href }];
          }
        }
      } catch {
        // Non-parseable href - skip.
      }
      return [];
    }
  }
  return Array.from(node.childNodes).flatMap((child) => collectAnchors(child));
}

/**
 * Apply anchor substitutions to the plain-text clipboard payload using
 * cursor-based alignment. Labels are matched in document order starting from
 * the current cursor position so that:
 *   - Duplicate labels are handled correctly (each consumed once, in order).
 *   - Labels that are substrings of their own href are never re-matched
 *     (we search the plain text, not the accumulated result).
 *   - Plain-text whitespace between the anchor and surrounding text is
 *     preserved automatically - <br> newlines, block separators, and the
 *     gap between </a> and adjacent text all come from the plain-text copy,
 *     not from the HTML structure.
 */
function substituteAnchors(
  plain: string,
  anchors: ReadonlyArray<{ label: string; href: string }>,
): string {
  // Normalize NBSP to space so email/chat client anchor text matches the plain-text copy.
  const normalized = plain.replace(/\u00a0/g, " ");
  let result = "";
  let cursor = 0;
  for (const { label, href } of anchors) {
    const idx = normalized.indexOf(label, cursor);
    if (idx === -1) continue;
    result += normalized.slice(cursor, idx) + href;
    cursor = idx + label.length;
  }
  return result + normalized.slice(cursor);
}

export function RichPastePlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand<ClipboardEvent>(
      PASTE_COMMAND,
      (e) => {
        const data = e.clipboardData;
        if (!data) return false;

        // Let useChatAttachments handle image pastes - don't interfere.
        for (const item of data.items) {
          if (item.type.startsWith("image/")) return false;
        }

        const plain = data.getData("text/plain");
        const html = data.getData("text/html");
        // Some browsers omit text/plain for HTML-only clipboard payloads.
        // Falling through to Lexical's default paste in that case is intentional -
        // Lexical will handle the rich-text content appropriately.
        if (!plain || !html) return false;

        const doc = new DOMParser().parseFromString(html, "text/html");
        const anchors = collectAnchors(doc.body);
        if (anchors.length === 0) return false;

        const result = substituteAnchors(plain, anchors);
        const normalizedPlain = plain.replace(/\u00a0/g, " ");
        if (result === normalizedPlain) return false;

        e.preventDefault();
        editor.update(() => {
          $insertNodes([$createTextNode(result)]);
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

  return null;
}
