import { LexicalComposer } from "@lexical/react/LexicalComposer"
import { ContentEditable } from "@lexical/react/LexicalContentEditable"
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary"
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext"
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin"
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin"
import { useEffect, useMemo, useRef, useState } from "react"
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  KEY_ENTER_COMMAND,
  PASTE_COMMAND,
} from "lexical"

import { cn } from "@renderer/lib/utils"
import type { ComposerSkillCommand } from "./composer-skill-commands"
import { parseSelectedSkillCommandDraft } from "./composer-skill-commands"
import { $createSkillCommandPillNode, SkillCommandPillNode } from "./skill-command-pill-node"
import { readComposerClipboard } from "./composer-file-input"

function SyncDraftPlugin({
  value,
  skillCommands,
  onChange,
}: {
  value: string
  skillCommands: ComposerSkillCommand[]
  onChange: (value: string) => void
}): null {
  const [editor] = useLexicalComposerContext()
  const syncingRef = useRef(false)

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      if (syncingRef.current) return

      editorState.read(() => {
        const nextValue = $getRoot().getTextContent()
        if (nextValue !== value) onChange(nextValue)
      })
    })
  }, [editor, onChange, value])

  useEffect(() => {
    editor.getEditorState().read(() => {
      const currentText = $getRoot().getTextContent()
      if (currentText === value) return

      syncingRef.current = true
      editor.update(() => {
        const root = $getRoot()
        root.clear()

        if (value) {
          const paragraph = $createParagraphNode()
          const selectedSkill = parseSelectedSkillCommandDraft(value, skillCommands)
          if (selectedSkill) {
            paragraph.append(
              $createSkillCommandPillNode(selectedSkill.command.name, selectedSkill.command.label)
            )
            if (selectedSkill.body) paragraph.append($createTextNode(selectedSkill.body))
          } else {
            paragraph.append($createTextNode(value))
          }
          root.append(paragraph)
          paragraph.selectEnd()
        }
      })

      queueMicrotask(() => {
        syncingRef.current = false
      })
    })
  }, [editor, skillCommands, value])

  return null
}

function SubmitKeyPlugin({ onSubmit }: { onSubmit: () => void }): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event: KeyboardEvent | null) => {
        if (!event || event.shiftKey || event.defaultPrevented) return false

        event.preventDefault()
        onSubmit()
        return true
      },
      COMMAND_PRIORITY_LOW
    )
  }, [editor, onSubmit])

  return null
}

function PlainTextPastePlugin({
  onPasteFiles,
}: {
  onPasteFiles?: (files: readonly File[]) => void
}): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    return editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        if (!("clipboardData" in event)) return false

        const clipboard = event.clipboardData
        if (!clipboard) return false
        const { files, text } = readComposerClipboard(clipboard)
        if (files.length === 0 && !text) return false

        event.preventDefault()
        if (files.length > 0) onPasteFiles?.(files)
        editor.update(() => {
          const selection = $getSelection()
          if (text && $isRangeSelection(selection)) selection.insertRawText(text)
        })
        return true
      },
      COMMAND_PRIORITY_HIGH
    )
  }, [editor, onPasteFiles])

  return null
}

function RichPromptPlaceholder({
  placeholder,
  className,
}: {
  placeholder: string
  className?: string
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "pointer-events-none absolute top-3 left-4 text-[13px] leading-6 text-placeholder/65",
        className
      )}
    >
      {placeholder}
    </div>
  )
}

export function RichPromptInput({
  id,
  value,
  rows,
  placeholder,
  disabled,
  skillCommands = [],
  className,
  onChange,
  onSubmit,
  onPasteFiles,
}: {
  id: string
  value: string
  rows: number
  placeholder: string
  disabled: boolean
  skillCommands?: ComposerSkillCommand[]
  className?: string
  onChange: (value: string) => void
  onSubmit: () => void
  onPasteFiles?: (files: readonly File[]) => void
}): React.JSX.Element {
  const [isComposing, setIsComposing] = useState(false)
  const minHeight = `${Math.max(rows, 1) * 24 + 24}px`
  const initialConfig = useMemo(
    () => ({
      namespace: `DesktopComposer:${id}`,
      theme: {
        paragraph: "m-0",
        text: {
          bold: "font-semibold",
          italic: "italic",
          underline: "underline",
          strikethrough: "line-through",
        },
      },
      onError(error: Error) {
        console.error(error)
      },
      nodes: [SkillCommandPillNode],
    }),
    [id]
  )

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div
        className={cn("relative", disabled && "pointer-events-none opacity-60")}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => setIsComposing(false)}
      >
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              id={id}
              aria-label="输入对话内容"
              aria-multiline="true"
              className={cn(
                "block max-h-44 min-h-18 w-full overflow-y-auto bg-transparent px-4 pt-3 text-[13px] leading-6 break-words whitespace-pre-wrap text-foreground outline-none",
                "**:text-inherit empty:before:content-none focus-visible:outline-none",
                className
              )}
              style={{ minHeight }}
            />
          }
          placeholder={
            <RichPromptPlaceholder
              placeholder={placeholder}
              className={cn(className?.includes("pt-4") && "top-4")}
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <PlainTextPastePlugin onPasteFiles={onPasteFiles} />
        <SyncDraftPlugin value={value} skillCommands={skillCommands} onChange={onChange} />
        {!isComposing && !disabled ? <SubmitKeyPlugin onSubmit={onSubmit} /> : null}
      </div>
    </LexicalComposer>
  )
}
