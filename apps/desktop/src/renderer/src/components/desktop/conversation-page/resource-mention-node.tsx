import { DecoratorNode, type NodeKey, type SerializedLexicalNode } from "lexical"
import type { SessionUserInputItem } from "@shared/session-types"

type Mention = Extract<SessionUserInputItem, { type: "mention" }>
type SerializedMention = SerializedLexicalNode & { item: Mention }

export class ResourceMentionNode extends DecoratorNode<React.JSX.Element> {
  __item: Mention
  static getType(): string {
    return "resource-mention"
  }
  static clone(node: ResourceMentionNode): ResourceMentionNode {
    return new ResourceMentionNode(node.__item, node.__key)
  }
  static importJSON(node: SerializedMention): ResourceMentionNode {
    return new ResourceMentionNode(node.item)
  }
  constructor(item: Mention, key?: NodeKey) {
    super(key)
    this.__item = { ...item }
  }
  exportJSON(): SerializedMention {
    return { type: "resource-mention", version: 1, item: { ...this.__item } }
  }
  createDOM(): HTMLElement {
    return document.createElement("span")
  }
  updateDOM(): false {
    return false
  }
  getTextContent(): string {
    return `@${this.__item.name}`
  }
  isInline(): boolean {
    return true
  }
  decorate(): React.JSX.Element {
    return (
      <span className="font-medium text-primary">
        {this.__item.displayName ?? this.__item.name}
      </span>
    )
  }
}
