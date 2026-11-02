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

export type SerializedSkillPillNode = Spread<
  {
    skillName: string;
    skillId: string;
  },
  SerializedLexicalNode
>;

export class SkillPillNode extends DecoratorNode<JSX.Element> {
  __skillName: string;
  __skillId: string;

  static getType(): string {
    return "skill-pill";
  }

  static clone(node: SkillPillNode): SkillPillNode {
    return new SkillPillNode(node.__skillName, node.__skillId, node.__key);
  }

  constructor(skillName: string, skillId: string, key?: NodeKey) {
    super(key);
    this.__skillName = skillName;
    this.__skillId = skillId;
  }

  getSkillName(): string {
    return this.__skillName;
  }

  getSkillId(): string {
    return this.__skillId;
  }

  createDOM(_config: EditorConfig): HTMLElement {
    return document.createElement("span");
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

  /** Plain-text form sent downstream on submit (no trailing space — caller adds one). */
  getTextContent(): string {
    return `/${this.__skillName}`;
  }

  static importJSON(serialized: SerializedSkillPillNode): SkillPillNode {
    return new SkillPillNode(serialized.skillName, serialized.skillId);
  }

  exportJSON(): SerializedSkillPillNode {
    return {
      ...super.exportJSON(),
      type: SkillPillNode.getType(),
      version: 1,
      skillName: this.__skillName,
      skillId: this.__skillId,
    };
  }

  static importDOM(): DOMConversionMap | null {
    return null;
  }

  decorate(): JSX.Element {
    return (
      <InlinePillDecorator
        nodeKey={this.getKey()}
        className="font-semibold"
        selectedClassName=""
        selectionTreatment="subtle"
      >
        <span data-skill-pill-id={this.__skillId} data-testid="skill-pill">
          /{this.__skillName}
        </span>
      </InlinePillDecorator>
    );
  }
}
