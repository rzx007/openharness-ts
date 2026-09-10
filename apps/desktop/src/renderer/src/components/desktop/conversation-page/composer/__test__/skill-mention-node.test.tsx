import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { createEditor } from "lexical"

import {
  $createSkillMentionNode,
  SkillMentionNode,
} from "../skill-mention-node"

function withEditor<T>(callback: () => T): T {
  const editor = createEditor({ nodes: [SkillMentionNode] })
  let result!: T
  editor.update(() => {
    result = callback()
  })
  return result
}

describe("SkillMentionNode", () => {
  test("preserves skill identity in serialized output", () => {
    withEditor(() => {
      const node = $createSkillMentionNode(
        "design-md",
        "C:/skills/design-md",
        "Design MD",
        "user"
      )

      expect(node.exportJSON()).toEqual({
        type: "skill-mention",
        version: 1,
        name: "design-md",
        path: "C:/skills/design-md",
        displayName: "Design MD",
        source: "user",
      })
    })
  })

  test("uses the command form as text content", () => {
    withEditor(() => {
      const node = $createSkillMentionNode("design-md", "/skills/design-md", "Design MD", "project")
      expect(node.getTextContent()).toBe("$design-md")
    })
  })

  test("renders an unadorned inline mention with a primary Box icon", () => {
    withEditor(() => {
      const node = $createSkillMentionNode("design-md", "/skills/design-md", "Design MD", "project")
      const markup = renderToStaticMarkup(node.decorate())

      expect(markup).toContain("Design MD")
      expect(markup).toContain("text-primary")
      expect(markup).toContain("font-medium")
      expect(markup).toContain("size-3.5")
      expect(markup).toContain("align-baseline")
      expect(markup).not.toMatch(/(?:bg-|border|rounded|px-)/)
    })
  })

  test("is recognized as a skill mention node", () => {
    withEditor(() => {
      expect(SkillMentionNode.getType()).toBe("skill-mention")
      expect(SkillMentionNode.importJSON({
        type: "skill-mention",
        version: 1,
        name: "review",
        path: "/skills/review",
        displayName: "Review",
        source: "bundled",
      }).getTextContent()).toBe("$review")
    })
  })
})
