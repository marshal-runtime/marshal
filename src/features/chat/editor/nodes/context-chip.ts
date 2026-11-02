/** Split from ContextChipNode so Fast Refresh does not mix the node class with JSX helpers. */

import type { LexicalNode } from "lexical";
import { $applyNodeReplacement, $nodesOfType } from "lexical";

import type { ChipDescriptor } from "../contracts/chip-descriptor";
import { ContextChipNode } from "./ContextChipNode";

export type ContextChipEntity =
  | {
      type: "People";
      id: string;
      referenceId?: string;
      displayName: string;
      email?: string;
    }
  | {
      type: "File";
      id: string;
      referenceId?: string;
      title: string;
      accessUrl?: string;
      extension?: string;
    };

export function contextChipDisplayName(entity: ContextChipEntity): string {
  switch (entity.type) {
    case "People":
      return entity.displayName;
    case "File":
      return entity.title;
    default: {
      const _exhaustive: never = entity;
      return _exhaustive;
    }
  }
}

function entityEmoji(entity: ContextChipEntity): string {
  switch (entity.type) {
    case "People":
      return "👤";
    case "File":
      return "📄";
    default: {
      const _exhaustive: never = entity;
      return String(_exhaustive);
    }
  }
}

function entityRefSentinel(entity: ContextChipEntity): string {
  const refId = "referenceId" in entity && entity.referenceId ? entity.referenceId : entity.id;
  switch (entity.type) {
    case "People":
      return `person:${refId}`;
    case "File":
      return `file:${refId}`;
    default: {
      const _exhaustive: never = entity;
      return String(_exhaustive);
    }
  }
}

/** Plain-text form of a chip, used as the placeholder during submit flattening. */
export function chipPlainText(entity: ContextChipEntity): string {
  return `${entityEmoji(entity)} ${contextChipDisplayName(entity)} (${entityRefSentinel(entity)}) `;
}

/** Markdown form of a chip, used as the replacement during submit flattening.
 *
 * Renders as bold display text followed by an HTML comment carrying the URL or
 * email. The comment is invisible in the rendered chat bubble (rehype-sanitize
 * drops comment nodes) but the model receives the raw text. Use
 * `stripCtxMarkers` (../support/editor-support) to remove the marker for
 * Copy / edit-to-resend flows. */
export function chipMarkdownText(entity: ContextChipEntity): string {
  switch (entity.type) {
    case "People": {
      const name = `**${entity.displayName}**`;
      return entity.email ? `${name} <!--ctx:mailto:${entity.email}-->` : name;
    }
    case "File": {
      const name = `**${entity.title}**`;
      return entity.accessUrl ? `${name} <!--ctx:${entity.accessUrl}-->` : name;
    }
    default: {
      const _exhaustive: never = entity;
      return String(_exhaustive);
    }
  }
}

/** Snapshot every ContextChipNode in the current editor state. Must run inside `editor.read()` / `editor.update()`. */
export function $collectChips(): ChipDescriptor[] {
  return $nodesOfType(ContextChipNode).map((node) => ({
    chipId: node.getChipId(),
    entity: node.getEntity(),
  }));
}

export function $createContextChipNode(
  entity: ContextChipEntity,
  chipId?: string,
): ContextChipNode {
  const id =
    chipId ??
    (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `chip-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return $applyNodeReplacement(new ContextChipNode(entity, id));
}

export function $isContextChipNode(node: LexicalNode | null | undefined): node is ContextChipNode {
  return node instanceof ContextChipNode;
}
