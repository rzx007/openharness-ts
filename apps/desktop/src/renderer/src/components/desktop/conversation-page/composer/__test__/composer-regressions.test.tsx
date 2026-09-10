import { describe, expect, it } from "vitest"

import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  createEditor,
  type ParagraphNode,
} from "lexical"

import * as composer from "../rich-prompt-input"

import { $createSkillMentionNode, SkillMentionNode } from "../skill-mention-node"

import { findComposerTrigger } from "../composer-trigger"

const command = {
  id: "compact",
  title: "Compact",
  description: "",
  requiresEmptyComposer: true,
  selection: "execute" as const,
}

const skill = { type: "skill" as const, name: "review", path: "D:/review/SKILL.md" }

function editorWithText(text: string, cursor: number, prefix?: string) {
  const editor = createEditor({ nodes: [SkillMentionNode] })

  editor.update(
    () => {
      if (prefix) $getRoot().append($createParagraphNode().append($createTextNode(prefix)))

      const node = $createTextNode(text)

      $getRoot().append($createParagraphNode().append(node))

      node.select(cursor, cursor)
    },
    { discrete: true }
  )

  return editor
}

describe("composer review regressions", () => {
  it("recognizes leading whitespace", () => {
    expect(findComposerTrigger(" \n /rev", 7)?.mode).toBe("leading")
  })

  it.each(["/rev suffix", "/revsuffix"])(
    "places the caret after the space before the suffix: %s",
    (text) => {
      const editor = editorWithText(text, 4)

      composer.insertSkillMention(
        editor,
        { sigil: "/", query: "rev", from: 0, to: 4, mode: "leading" },
        skill
      )

      editor.getEditorState().read(() => {
        const selection = $getSelection()

        expect($isRangeSelection(selection)).toBe(true)

        if ($isRangeSelection(selection)) {
          expect(selection.anchor.getNode().getTextContent()).toBe(" suffix")

          expect(selection.anchor.offset).toBe(1)
        }
      })
    }
  )

  it("refuses to erase body text when a stale command is selected", async () => {
    const editor = editorWithText("/compact keep this", 8)

    let executions = 0

    await composer.executeComposerCommand(editor, command, async () => {
      executions++
    })

    expect(executions).toBe(0)

    expect(editor.getEditorState().read(composer.composerDocumentFromLexical).items).toEqual([
      { type: "text", text: "/compact keep this" },
    ])
  })
  it("refuses a command when an atomic Skill follows its leading token", async () => {
    const editor = editorWithText("/compact", 8)
    editor.update(
      () => {
        $getRoot()
          .getFirstChildOrThrow<ParagraphNode>()
          .append($createSkillMentionNode("review", "D:/review/SKILL.md", "Review", "user"))
      },
      { discrete: true }
    )
    let executions = 0
    await composer.executeComposerCommand(editor, command, async () => {
      executions++
    })
    expect(executions).toBe(0)
    expect(editor.getEditorState().read(composer.composerDocumentFromLexical).items).toHaveLength(2)
  })

  it("keeps paragraph boundaries in trigger offsets and replacement", () => {
    const editor = editorWithText("/rev suffix", 4, "first")

    const trigger = editor.getEditorState().read(composer.triggerFromEditorState)

    expect(trigger).toEqual({ sigil: "/", query: "rev", from: 6, to: 10, mode: "inline" })

    composer.insertSkillMention(editor, trigger!, skill)

    expect(editor.getEditorState().read(composer.composerDocumentFromLexical).items).toEqual([
      { type: "text", text: "first\n" },
      { ...skill, displayName: "review" },
      { type: "text", text: " suffix" },
    ])
  })
})
