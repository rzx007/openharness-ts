import { Box } from "lucide-react"
import { DecoratorNode, type LexicalNode, type NodeKey, type SerializedLexicalNode } from "lexical"

import { cn } from "@renderer/lib/utils"

export interface SerializedSkillCommandPillNode {
  type: "skill-command-pill"
  version: 1
  name: string
  label: string
}

type SerializedSkillCommandPillPayload = SerializedLexicalNode & Record<string, unknown>

export class SkillCommandPillNode extends DecoratorNode<React.JSX.Element> {
  __name: string
  __label: string

  static getType(): string {
    return "skill-command-pill"
  }

  static clone(node: SkillCommandPillNode): SkillCommandPillNode {
    return new SkillCommandPillNode(node.__name, node.__label, node.__key)
  }

  static importJSON(serializedNode: SerializedSkillCommandPillPayload): SkillCommandPillNode {
    const name = typeof serializedNode.name === "string" ? serializedNode.name : "/skill"
    const label = typeof serializedNode.label === "string" ? serializedNode.label : "skill"
    return $createSkillCommandPillNode(name, label)
  }

  constructor(name: string, label: string, key?: NodeKey) {
    super(key)
    this.__name = name
    this.__label = label
  }

  exportJSON(): SerializedSkillCommandPillNode {
    return {
      type: "skill-command-pill",
      version: 1,
      name: this.__name,
      label: this.__label,
    }
  }

  createDOM(): HTMLElement {
    const element = document.createElement("span")
    element.className = "inline-flex align-baseline"
    return element
  }

  updateDOM(): false {
    return false
  }

  getTextContent(): string {
    return this.__name
  }

  isKeyboardSelectable(): boolean {
    return false
  }

  decorate(): React.JSX.Element {
    return (
      <span
        className={cn(
          "text-ui-small mx-0.5 inline-flex h-6 max-w-48 items-center gap-1 rounded-md bg-muted px-2 leading-6 font-medium text-foreground select-none",
          "ring-1 ring-black/6 dark:ring-white/10"
        )}
      >
        <Box className="size-3.5 shrink-0 text-primary" />
        <span className="min-w-0 truncate">{this.__label}</span>
      </span>
    )
  }
}

export function $createSkillCommandPillNode(name: string, label: string): SkillCommandPillNode {
  return new SkillCommandPillNode(name, label)
}

export function $isSkillCommandPillNode(
  node: LexicalNode | null | undefined
): node is SkillCommandPillNode {
  return node instanceof SkillCommandPillNode
}
