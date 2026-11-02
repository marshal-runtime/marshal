/** Lexical DecoratorNode for inline context chips. */

import {
  DecoratorNode,
  type DOMConversionMap,
  type EditorConfig,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import type { JSX } from "react";

import { InlinePillDecorator } from "../pills/SelectableInlinePill";
import { chipPlainText, type ContextChipEntity } from "./context-chip";

export type SerializedContextChipNode = Spread<
  {
    chipId: string;
    entity: ContextChipEntity;
  },
  SerializedLexicalNode
>;

export class ContextChipNode extends DecoratorNode<JSX.Element> {
  __chipId: string;
  __entity: ContextChipEntity;

  static getType(): string {
    return "context-chip";
  }

  static clone(node: ContextChipNode): ContextChipNode {
    return new ContextChipNode(node.__entity, node.__chipId, node.__key);
  }

  constructor(entity: ContextChipEntity, chipId: string, key?: NodeKey) {
    super(key);
    this.__entity = entity;
    this.__chipId = chipId;
  }

  getChipId(): string {
    return this.__chipId;
  }

  getEntity(): ContextChipEntity {
    return this.__entity;
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement("span");
    span.style.display = "inline-block";
    return span;
  }

  updateDOM(): false {
    return false;
  }

  isInline(): boolean {
    return true;
  }

  isIsolated(): boolean {
    return false;
  }

  /** Plain-text form used for submit flattening. */
  getTextContent(): string {
    return chipPlainText(this.__entity);
  }

  static importJSON(serialized: SerializedContextChipNode): ContextChipNode {
    return new ContextChipNode(serialized.entity, serialized.chipId);
  }

  exportJSON(): SerializedContextChipNode {
    return {
      ...super.exportJSON(),
      type: ContextChipNode.getType(),
      version: 1,
      chipId: this.__chipId,
      entity: this.__entity,
    };
  }

  static importDOM(): DOMConversionMap | null {
    return null;
  }

  decorate(): JSX.Element {
    const displayText =
      this.__entity.type === "People" ? this.__entity.displayName : this.__entity.title;

    return (
      <InlinePillDecorator
        nodeKey={this.getKey()}
        className=""
        selectedClassName="bg-(--accent)/20 rounded-sm"
      >
        <strong
          data-context-chip-id={this.__chipId}
          data-testid="chip-decorator"
          className="font-semibold"
        >
          {displayText}
        </strong>
      </InlinePillDecorator>
    );
  }
}
