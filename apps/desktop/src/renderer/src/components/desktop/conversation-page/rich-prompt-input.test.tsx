import { describe, expect, it } from "vitest"
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $setSelection,
  createEditor,
} from "lexical"

import {
  composerDocumentFromLexical,
  executeComposerCommand,
  insertSkillMention,
} from "./rich-prompt-input"
import { $createSkillMentionNode, SkillMentionNode } from "./skill-mention-node"

describe("composerDocumentFromLexical", () => {
  it("exports ordered text and multiple Skill mentions without converting ordinary dollar text", () => {
    const editor = createEditor({ nodes: [SkillMentionNode] })
    let document: ReturnType<typeof composerDocumentFromLexical>
    editor.update(
      () => {
        const paragraph = $createParagraphNode()
        paragraph.append(
          $createTextNode("Use $ordinary with "),
          $createSkillMentionNode(
            "writing-plans",
            "D:/skills/writing-plans/SKILL.md",
            "Writing Plans",
            "user"
          ),
          $createTextNode(" then "),
          $createSkillMentionNode("review", "D:/skills/review/SKILL.md", "Review", "project"),
          $createTextNode(".")
        )
        $getRoot().append(paragraph)
        document = composerDocumentFromLexical()
      },
      { discrete: true }
    )

    expect(document!).toEqual({
      version: 1,
      items: [
        { type: "text", text: "Use $ordinary with " },
        {
          type: "skill",
          name: "writing-plans",
          path: "D:/skills/writing-plans/SKILL.md",
          displayName: "Writing Plans",
          source: "user",
        },
        { type: "text", text: " then " },
        {
          type: "skill",
          name: "review",
          path: "D:/skills/review/SKILL.md",
          displayName: "Review",
          source: "project",
        },
        { type: "text", text: "." },
      ],
    })
  })

  it("replaces an inline slash trigger with an atomic Skill and preserves surrounding text", () => {
    const editor = createEditor({ nodes: [SkillMentionNode] })
    let triggerText: ReturnType<typeof $createTextNode>
    editor.update(
      () => {
        const paragraph = $createParagraphNode()
        triggerText = $createTextNode("Use /wri next")
        paragraph.append(triggerText)
        $getRoot().append(paragraph)
        const selection = $createRangeSelection()
        selection.setTextNodeRange(triggerText, 4, triggerText, 8)
        $setSelection(selection)
      },
      { discrete: true }
    )

    expect(editor.getEditorState().read(composerDocumentFromLexical)).toEqual({
      version: 1,
      items: [{ type: "text", text: "Use /wri next" }],
    })

    insertSkillMention(
      editor,
      { sigil: "/", query: "wri", from: 4, to: 8, mode: "inline" },
      {
        name: "writing-plans",
        path: "D:/skills/writing-plans/SKILL.md",
        displayName: "Writing Plans",
        source: "user",
      }
    )

    expect(editor.getEditorState().read(composerDocumentFromLexical)).toEqual({
      version: 1,
      items: [
        { type: "text", text: "Use " },
        {
          type: "skill",
          name: "writing-plans",
          path: "D:/skills/writing-plans/SKILL.md",
          displayName: "Writing Plans",
          source: "user",
        },
        { type: "text", text: " next" },
      ],
    })
  })

  it("replaces a leading dollar trigger without requiring a text prefix", () => {
    const editor = createEditor({ nodes: [SkillMentionNode] })
    editor.update(
      () => {
        const paragraph = $createParagraphNode()
        const triggerText = $createTextNode("$plan work")
        paragraph.append(triggerText)
        $getRoot().append(paragraph)
        const selection = $createRangeSelection()
        selection.setTextNodeRange(triggerText, 0, triggerText, 5)
        $setSelection(selection)
      },
      { discrete: true }
    )

    insertSkillMention(
      editor,
      { sigil: "$", query: "plan", from: 0, to: 5, mode: "leading" },
      { name: "plan", path: "D:/skills/plan/SKILL.md", displayName: "Plan", source: "user" }
    )

    expect(editor.getEditorState().read(composerDocumentFromLexical)).toEqual({
      version: 1,
      items: [
        {
          type: "skill",
          name: "plan",
          path: "D:/skills/plan/SKILL.md",
          displayName: "Plan",
          source: "user",
        },
        { type: "text", text: " work" },
      ],
    })
  })

  it("restores the complete composer document when an application command fails", async () => {
    const editor = createEditor({ nodes: [SkillMentionNode] })
    editor.update(
      () => {
        const paragraph = $createParagraphNode()
        paragraph.append($createTextNode("/compact"))
        $getRoot().append(paragraph)
      },
      { discrete: true }
    )

    await executeComposerCommand(
      editor,
      {
        id: "compact",
        title: "Compact",
        description: "Summarize conversation",
        requiresEmptyComposer: true,
        selection: "execute",
      },
      async () => {
        throw new Error("compact failed")
      }
    )

    expect(editor.getEditorState().read(composerDocumentFromLexical)).toEqual({
      version: 1,
      items: [{ type: "text", text: "/compact" }],
    })
  })
})
