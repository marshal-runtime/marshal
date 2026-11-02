// Marshal-owned module.
/**
 * Map a DOM Range (from a user selection) to raw-markdown character offsets.
 *
 * Walks from the Range's start/end containers up to the nearest ancestor
 * annotated with `data-md-start` / `data-md-end` (emitted by MdastRenderer),
 * then counts the text offset within that annotated element to compute the
 * precise markdown position.
 */

export interface MarkdownRange {
  /** Character offset in raw markdown where the selection starts. */
  mdStart: number;
  /** Character offset in raw markdown where the selection ends. */
  mdEnd: number;
}

/**
 * Convert a DOM Range into raw-markdown character offsets.
 *
 * Returns null if the range doesn't fall within annotated elements.
 */
export function rangeToMarkdownRange(range: Range, editorEl: Element): MarkdownRange | null {
  const start = resolveOffset(range.startContainer, range.startOffset, editorEl);
  const end = resolveOffset(range.endContainer, range.endOffset, editorEl);
  if (start == null || end == null) return null;
  return { mdStart: Math.min(start, end), mdEnd: Math.max(start, end) };
}

/**
 * Given a DOM node + offset (from a Range boundary), find the nearest
 * ancestor with `data-md-start`/`data-md-end` and compute the absolute
 * markdown character offset.
 */
function resolveOffset(node: Node, offset: number, editorEl: Element): number | null {
  // Walk up to find the nearest annotated element
  const annotated = findAnnotatedAncestor(node, editorEl);
  if (!annotated) return null;

  const mdStart = parseInt(annotated.getAttribute("data-md-start") || "", 10);
  if (isNaN(mdStart)) return null;

  // Count text characters from the start of the annotated element
  // to the range boundary point
  const textOffset = countTextOffset(annotated, node, offset);
  if (textOffset == null) return null;

  return mdStart + textOffset;
}

/**
 * Walk up the DOM tree from `node` to find the nearest element with
 * `data-md-start` attribute, stopping at `boundary`.
 */
function findAnnotatedAncestor(node: Node, boundary: Element): Element | null {
  let current: Node | null = node;
  while (current && current !== boundary) {
    if (current instanceof Element && current.hasAttribute("data-md-start")) {
      return current;
    }
    current = current.parentNode;
  }
  return null;
}

/**
 * Count the number of text characters from the start of `root`
 * to the point (targetNode, targetOffset).
 *
 * Uses a TreeWalker to iterate text nodes in document order.
 */
function countTextOffset(root: Element, targetNode: Node, targetOffset: number): number | null {
  // If targetNode is the root element itself (e.g., range set at element level),
  // count characters up to the nth child
  if (targetNode === root && targetNode.nodeType === Node.ELEMENT_NODE) {
    const children = Array.from(root.childNodes);
    let count = 0;
    for (let i = 0; i < Math.min(targetOffset, children.length); i++) {
      count += getTextLength(children[i]);
    }
    return count;
  }

  const isElementTarget = targetNode.nodeType === Node.ELEMENT_NODE;
  const targetChildren = isElementTarget ? Array.from(targetNode.childNodes) : null;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let count = 0;
  let textNode = walker.nextNode();

  while (textNode) {
    // Text node target: exact match
    if (textNode === targetNode) {
      return count + targetOffset;
    }

    // Element target: check if this text node is a child at or past the target offset
    if (isElementTarget && textNode.parentNode === targetNode && targetChildren) {
      let childIdx = -1;
      for (let j = 0; j < targetChildren.length; j++) {
        if (targetChildren[j] === textNode) {
          childIdx = j;
          break;
        }
      }
      if (childIdx >= 0 && childIdx >= targetOffset) {
        return count;
      }
    }

    count += (textNode.textContent || "").length;
    textNode = walker.nextNode();
  }

  // Element target: all children traversed — offset is at or past the end
  if (isElementTarget && targetChildren && targetOffset >= targetChildren.length) {
    return count;
  }

  return null;
}

/** Get the total text length of a node and all its descendants. */
function getTextLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent || "").length;
  }
  let len = 0;
  for (const child of Array.from(node.childNodes)) {
    len += getTextLength(child);
  }
  return len;
}
