/**
 * ARIA snapshot renderer inspired by Playwright's approach.
 *
 * Converts an {@link AccessibilityNode} tree into a compact YAML-like text
 * representation optimised for LLM consumption. Applies several
 * normalisation passes to reduce payload size:
 *
 * 1. **Prune** – removes `none` / `presentation` roles entirely.
 * 2. **Collapse generics** – generic nodes with a single child are replaced
 *    by their child; generic nodes whose only content is text are rendered
 *    inline.
 * 3. **Text deduplication** – when a node's accessible name is identical to
 *    its only text child, the child is elided.
 * 4. **Interactable refs** – sequential `ref` markers (e1, e2, …) are
 *    emitted only on elements the agent can interact with.
 */

import type { AccessibilityNode } from "../types/browser.js";

// ── Roles that should be dropped entirely ────────────────────────────────

const PRUNED_ROLES = new Set(["none", "presentation", "InlineTextBox"]);

// ── Roles considered interactable (agent can click / type / toggle) ──────

const INTERACTABLE_ROLES = new Set([
  "link",
  "button",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "slider",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "treeitem",
  "spinbutton",
  "scrollbar",
]);

// ── Normalisation ────────────────────────────────────────────────────────

/**
 * Recursively normalises an {@link AccessibilityNode} tree.
 *
 * - Removes nodes with pruned roles (`none`, `presentation`, `InlineTextBox`).
 * - Removes `StaticText` nodes whose text is already captured by their parent.
 * - Collapses generic containers that add no semantic value.
 * - Deduplicates text (parent name === single child text → drop child).
 * - Assigns sequential `ref` identifiers to interactable elements.
 */
export function normalizeAriaTree(root: AccessibilityNode): AccessibilityNode {
  const counter = { value: 1 };
  return (
    normalizeNode(root, counter, "") ?? {
      role: "document",
      name: "",
    }
  );
}

function normalizeNode(
  node: AccessibilityNode,
  refCounter: { value: number },
  parentName: string,
): AccessibilityNode | null {
  // Drop pruned roles
  if (PRUNED_ROLES.has(node.role)) {
    return null;
  }

  // Drop StaticText when its name duplicates the parent name
  if (node.role === "StaticText" && node.name && node.name === parentName) {
    return null;
  }

  // Recursively normalise children
  const normalizedChildren: AccessibilityNode[] = [];
  if (node.children) {
    for (const child of node.children) {
      const normalized = normalizeNode(child, refCounter, node.name);
      if (normalized !== null) {
        normalizedChildren.push(normalized);
      }
    }
  }

  // Collapse generic nodes with no name and no semantic value
  if (isGenericRole(node.role) && !node.name) {
    if (normalizedChildren.length === 0) {
      return null; // empty generic — drop
    }
    if (normalizedChildren.length === 1) {
      return normalizedChildren[0]; // single child — promote
    }
    // Multiple children — keep as container but don't emit role
  }

  // Text deduplication: if node name matches the only text child, drop child
  const deduplicatedChildren = deduplicateTextChildren(node.name, normalizedChildren);

  // Assign ref to interactable elements
  const ref = isInteractable(node) ? `e${refCounter.value++}` : undefined;

  const result: AccessibilityNode = {
    role: node.role,
    name: node.name,
    ...(node.value !== undefined ? { value: node.value } : {}),
    ...(node.description !== undefined ? { description: node.description } : {}),
    ...(ref !== undefined ? { ref } : {}),
    ...(node.boundingBox !== undefined && ref !== undefined
      ? { boundingBox: node.boundingBox }
      : {}),
    ...(node.offScreen === true && ref !== undefined ? { offScreen: true } : {}),
    ...(deduplicatedChildren.length > 0 ? { children: deduplicatedChildren } : {}),
  };

  return result;
}

function isGenericRole(role: string): boolean {
  return role === "generic" || role === "group";
}

function isInteractable(node: AccessibilityNode): boolean {
  if (INTERACTABLE_ROLES.has(node.role)) {
    return true;
  }
  // Elements with a selector were marked interactive by the DOM walker
  if (node.selector) {
    return true;
  }
  return false;
}

/**
 * If the node name is identical to the name of its only child, drop the child.
 * This avoids duplication like: `link "Home" → StaticText "Home"`.
 */
function deduplicateTextChildren(
  parentName: string,
  children: AccessibilityNode[],
): AccessibilityNode[] {
  if (
    children.length === 1 &&
    parentName &&
    children[0].name === parentName &&
    !children[0].children?.length
  ) {
    return [];
  }
  return children;
}

// ── YAML Renderer ────────────────────────────────────────────────────────

const INDENT = "  ";

/**
 * Renders an {@link AccessibilityNode} tree as a compact YAML-like
 * text snapshot, matching the Playwright aria-snapshot format.
 *
 * @example
 * ```
 * - document "My Page":
 *   - navigation "Main":
 *     - link "Home" [ref=e1]
 *     - link "About" [ref=e2]
 *   - main:
 *     - heading "Welcome" [level=1]
 *     - textbox "Search" [ref=e3]
 *     - button "Go" [ref=e4]
 * ```
 */
export function renderAriaSnapshot(root: AccessibilityNode): string {
  const lines: string[] = [];
  renderNode(root, 0, lines);
  return lines.join("\n");
}

function renderNode(node: AccessibilityNode, depth: number, lines: string[]): void {
  const indent = INDENT.repeat(depth);
  const attrs = buildAttributes(node);

  const nameStr = node.name ? ` "${escapeYamlString(node.name)}"` : "";
  const attrStr = attrs.length > 0 ? ` [${attrs.join(", ")}]` : "";

  const children = node.children ?? [];

  if (children.length > 0) {
    lines.push(`${indent}- ${node.role}${nameStr}${attrStr}:`);
    for (const child of children) {
      renderNode(child, depth + 1, lines);
    }
  } else if (node.value !== undefined) {
    // Leaf with value (e.g. textbox with current input)
    lines.push(`${indent}- ${node.role}${nameStr}${attrStr}: ${escapeYamlString(node.value)}`);
  } else {
    lines.push(`${indent}- ${node.role}${nameStr}${attrStr}`);
  }
}

function buildAttributes(node: AccessibilityNode): string[] {
  const attrs: string[] = [];

  // Ref for interactable elements
  if (node.ref) {
    attrs.push(`ref=${node.ref}`);
  }

  // Heading level
  if (node.role === "heading" && node.name) {
    const level = inferHeadingLevel(node);
    if (level) {
      attrs.push(`level=${level}`);
    }
  }

  // States (extended property from DOM walker)
  if (node.states?.length) {
    for (const state of node.states) {
      attrs.push(state);
    }
  }

  return attrs;
}

function inferHeadingLevel(node: AccessibilityNode): string | undefined {
  // If the node has a description like "heading level 2" or was
  // tagged via aria-level, the DOM walker may embed it.
  if (node.description) {
    const match = /level\s*(\d)/i.exec(node.description);
    if (match) return match[1];
  }
  return undefined;
}

// ── Ref Map Extraction ───────────────────────────────────────────────────

/** Bounding box for a single ref'd element. */
export interface RefInfo {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly offScreen?: boolean;
}

/**
 * Walks a normalised tree and extracts a mapping from `ref` identifiers
 * to their bounding boxes. This allows agents to resolve coordinates
 * for click-at / coordinate-based interactions without bloating the
 * YAML snapshot.
 */
export function extractRefMap(root: AccessibilityNode): Record<string, RefInfo> {
  const map: Record<string, RefInfo> = {};
  collectRefs(root, map);
  return map;
}

function collectRefs(node: AccessibilityNode, map: Record<string, RefInfo>): void {
  if (node.ref && node.boundingBox) {
    const entry: RefInfo = {
      x: Math.round(node.boundingBox.x),
      y: Math.round(node.boundingBox.y),
      width: Math.round(node.boundingBox.width),
      height: Math.round(node.boundingBox.height),
      ...(node.offScreen === true ? { offScreen: true } : {}),
    };
    map[node.ref] = entry;
  }
  if (node.children) {
    for (const child of node.children) {
      collectRefs(child, map);
    }
  }
}

function escapeYamlString(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
