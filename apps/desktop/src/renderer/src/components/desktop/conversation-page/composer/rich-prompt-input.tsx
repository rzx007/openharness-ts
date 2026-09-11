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
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  COPY_COMMAND,
  CUT_COMMAND,
  KEY_ENTER_COMMAND,
  PASTE_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  type TextNode,
  type RangeSelection,
} from "lexical"

import { cn } from "@renderer/lib/utils"
import {
  composerDocument,
  sameComposerDocument,
  type ComposerDocument,
} from "@renderer/stores/desktop-session/composer-document"
import {
  ComposerPicker,
  type ComposerPickerItem,
  type ComposerPickerCommand,
  type ComposerPickerSkill,
  pickerItems,
} from "./composer-picker"
import { findComposerTrigger, type ComposerTrigger } from "./composer-trigger"
import { readComposerClipboard } from "./composer-file-input"
import { ResourceMentionNode } from "./resource-mention-node"
import {
  $createSkillMentionNode,
  $isSkillMentionNode,
  SkillMentionNode,
} from "./skill-mention-node"

export interface ComposerSkill {
  name: string
  commandName?: string
  path: string
  displayName: string
  description: string
  source?: "bundled" | "user" | "project" | "plugin"
  sourceLabel: string
}

interface TextLeaf {
  node: LexicalNode
  from: number
  to: number
}

export function composerDocumentFromLexical(): ComposerDocument {
  const items: ComposerDocument["items"] = []
  const paragraphs = $getRoot().getChildren()
  paragraphs.forEach((paragraph, index) => {
    for (const node of descendantLeaves(paragraph)) {
      if ($isSkillMentionNode(node)) {
        items.push({
          type: "skill",
          name: node.__name,
          path: node.__path,
          displayName: node.__displayName,
          ...(isSkillSource(node.__source) ? { source: node.__source } : {}),
        })
      } else if (node instanceof ResourceMentionNode) {
        items.push({ ...node.__item })
      } else {
        const text = node.getTextContent()
        if (text) items.push({ type: "text", text })
      }
    }
    if (index < paragraphs.length - 1) items.push({ type: "text", text: "\n" })
  })
  return composerDocument(items)
}

export function restoreComposerDocument(value: ComposerDocument): void {
  const root = $getRoot()
  root.clear()
  const paragraphs = composerParagraphs(value)
  root.append(...paragraphs)
  paragraphs.at(-1)!.selectEnd()
}

function composerParagraphs(value: ComposerDocument) {
  let paragraph = $createParagraphNode()
  const paragraphs = [paragraph]
  for (const item of value.items) {
    if (item.type === "text") {
      item.text.split("\n").forEach((text, index) => {
        if (index > 0) {
          paragraph = $createParagraphNode()
          paragraphs.push(paragraph)
        }
        if (text) paragraph.append($createTextNode(text))
      })
    } else if (item.type === "skill") {
      paragraph.append(
        $createSkillMentionNode(
          item.name,
          item.path,
          item.displayName ?? item.name,
          item.source ?? ""
        )
      )
    } else paragraph.append(new ResourceMentionNode(item))
  }
  return paragraphs
}

function SyncDraftPlugin({
  value,
  onChange,
}: {
  value: ComposerDocument
  onChange: (value: ComposerDocument) => void
}): null {
  const [editor] = useLexicalComposerContext()
  const syncingRef = useRef(false)
  useEffect(
    () =>
      editor.registerUpdateListener(() => {
        if (syncingRef.current) return
        const next = editor.getEditorState().read(composerDocumentFromLexical)
        if (!sameComposerDocument(next, value)) onChange(next)
      }),
    [editor, onChange, value]
  )
  useEffect(() => {
    if (sameComposerDocument(editor.getEditorState().read(composerDocumentFromLexical), value))
      return
    syncingRef.current = true
    editor.update(() => {
      restoreComposerDocument(value)
    })
    queueMicrotask(() => {
      syncingRef.current = false
    })
  }, [editor, value])
  return null
}

function SubmitKeyPlugin({ onSubmit }: { onSubmit: () => void }): null {
  const [editor] = useLexicalComposerContext()
  useEffect(
    () =>
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event: KeyboardEvent | null) => {
          if (!event || event.shiftKey || event.defaultPrevented) return false
          event.preventDefault()
          onSubmit()
          return true
        },
        COMMAND_PRIORITY_LOW
      ),
    [editor, onSubmit]
  )
  return null
}

const COMPOSER_CLIPBOARD_TYPE = "application/x-openharness-composer"

function selectedComposerDocument(selection: RangeSelection): ComposerDocument {
  const leaves = textLeaves()
  const pointOffset = (point: RangeSelection["anchor"]): number => {
    const node = point.getNode()
    if (node === $getRoot()) {
      const paragraphs = $getRoot().getChildren()
      return paragraphs.slice(0, point.offset).reduce((sum, paragraph) => sum + paragraph.getTextContent().length, 0) +
        Math.min(point.offset, Math.max(0, paragraphs.length - 1))
    }
    if ($isTextNode(node)) return (leaves.find((leaf) => leaf.node === node)?.from ?? 0) + point.offset
    if ($isElementNode(node)) {
      const after = node.getChildren().slice(point.offset).flatMap(descendantLeaves)[0]
      const next = leaves.find((leaf) => leaf.node === after)
      if (next) return next.from
      const last = descendantLeaves(node).at(-1)
      const end = leaves.find((leaf) => leaf.node === last)
      if (end) return end.to
      // Empty paragraphs still occupy a newline in the serialized document.
      let offset = 0
      for (const paragraph of $getRoot().getChildren()) {
        if (paragraph === node) return offset
        offset += paragraph.getTextContent().length + 1
      }
    }
    return 0
  }
  const [start, end] = [pointOffset(selection.anchor), pointOffset(selection.focus)].sort((a, b) => a - b)
  let offset = 0
  return composerDocument(composerDocumentFromLexical().items.flatMap((item): ComposerDocument["items"] => {
    const length = item.type === "text" ? item.text.length : item.name.length + 1
    const from = offset
    offset += length
    if (end <= from || start >= offset) return []
    return item.type === "text"
      ? [{ type: "text" as const, text: item.text.slice(Math.max(0, start - from), end - from) }]
      : [item]
  }))
}

function readStructuredClipboard(raw: string, skills: readonly ComposerSkill[]): ComposerDocument | null {
  if (!raw || raw.length > 2 * 1024 * 1024) return null
  try {
    const value = JSON.parse(raw)
    if (value?.version !== 1 || !Array.isArray(value.items) || value.items.length > 256) return null
    const items: ComposerDocument["items"] = []
    for (const item of value.items) {
      if (item?.type === "text" && typeof item.text === "string") {
        items.push({ type: "text", text: item.text })
        continue
      }
      if ((item?.type !== "skill" && item?.type !== "mention") ||
        typeof item.name !== "string" || typeof item.path !== "string" ||
        (item.displayName !== undefined && typeof item.displayName !== "string")) return null
      if (item.type === "skill" && !skills.some((skill) => skill.name === item.name && skill.path === item.path)) {
        items.push({ type: "text", text: `$${item.name}` })
      } else {
        items.push({ type: item.type, name: item.name, path: item.path,
          ...(item.displayName !== undefined ? { displayName: item.displayName } : {}),
          ...(item.type === "skill" && isSkillSource(item.source) ? { source: item.source } : {}),
        })
      }
    }
    return composerDocument(items)
  } catch { return null }
}

function ComposerClipboardPlugin({
  onPasteFiles,
  skills,
}: {
  onPasteFiles?: (files: readonly File[]) => void
  skills: readonly ComposerSkill[]
}): null {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    const copy = (event: ClipboardEvent | KeyboardEvent | null, cut = false): boolean => {
      if (!event || !("clipboardData" in event) || !event.clipboardData) return false
      const selection = $getSelection()
      if (!$isRangeSelection(selection) || selection.isCollapsed()) return false
      const value = selectedComposerDocument(selection)
      event.preventDefault()
      event.clipboardData.setData(COMPOSER_CLIPBOARD_TYPE, JSON.stringify(value))
      event.clipboardData.setData("text/plain", value.items.map((item) => item.type === "text" ? item.text : `${item.type === "skill" ? "$" : "@"}${item.name}`).join(""))
      if (cut) selection.removeText()
      return true
    }
    const removeCopy = editor.registerCommand(COPY_COMMAND, (event) => copy(event), COMMAND_PRIORITY_HIGH)
    const removeCut = editor.registerCommand(CUT_COMMAND, (event) => copy(event, true), COMMAND_PRIORITY_HIGH)
    return () => { removeCopy(); removeCut() }
  }, [editor])
  useEffect(
    () =>
      editor.registerCommand(
        PASTE_COMMAND,
        (event) => {
          if (!("clipboardData" in event) || !event.clipboardData) return false
          const { files, text } = readComposerClipboard(event.clipboardData)
          const structured = readStructuredClipboard(event.clipboardData.getData(COMPOSER_CLIPBOARD_TYPE), skills)
          if (files.length === 0 && !text && !structured) return false
          event.preventDefault()
          if (files.length > 0) onPasteFiles?.(files)
          editor.update(() => {
            const selection = $getSelection()
            if (!$isRangeSelection(selection)) return
            if (structured) selection.insertNodes(composerParagraphs(structured))
            else if (text) selection.insertRawText(text)
          })
          return true
        },
        COMMAND_PRIORITY_HIGH
      ),
    [editor, onPasteFiles, skills]
  )
  return null
}

function ComposerPickerPlugin({
  skills,
  commands,
  onCommand,
  onCommandError,
  onPickFiles,
}: {
  skills: readonly ComposerSkill[]
  commands: readonly ComposerPickerItem[]
  onCommand: (command: ComposerPickerCommand) => Promise<void>
  onCommandError: (message: string | null) => void
  onPickFiles?: () => void
}): React.JSX.Element | null {
  const [editor] = useLexicalComposerContext()
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState }) => {
        const next = editorState.read(triggerFromEditorState)
        setTrigger(next)
        if (next) setDismissed(null)
      }),
    [editor]
  )
  useEffect(() => {
    setTrigger(editor.getEditorState().read(triggerFromEditorState))
  }, [editor])
  const visible =
    trigger &&
    dismissed !== `${trigger.from}:${trigger.to}:${trigger.query}` &&
    (trigger.sigil === "@" || trigger.sigil === "$" || trigger.mode === "inline" || trigger.mode === "leading")
  if (!visible) return null
  const skillItems: ComposerPickerItem[] = skills.map((skill) => ({
    id: `skill:${skill.path}`,
    kind: "skill",
    label: skill.displayName,
    description: skill.description,
    sourceLabel: skill.sourceLabel,
    skill,
  }))
  const contextItem: ComposerPickerItem = { id: "context:files", kind: "command", label: "文件和文件夹", description: "添加文件或文件夹" }
  const items = trigger.sigil === "@" ? [contextItem] : pickerItems({
    trigger,
    commands: editor.getEditorState().read(() => canExecuteComposerCommand(trigger)) ? commands : [],
    skills: skillItems,
  })
  return (
    <ComposerPicker
      items={items}
      query=""
      onDismiss={() => setDismissed(`${trigger.from}:${trigger.to}:${trigger.query}`)}
      onSelect={(item) => {
        if (item.skill) {
          insertSkillMention(editor, trigger, item.skill)
          return
        }
        if (trigger.sigil === "@") {
          removeComposerTrigger(editor, trigger)
          onPickFiles?.()
          return
        }
        if (item.command) {
          onCommandError(null)
          void executeComposerCommand(editor, item.command, onCommand, onCommandError)
        }
      }}
    />
  )
}

function removeComposerTrigger(editor: LexicalEditor, trigger: ComposerTrigger): void {
  editor.update(() => {
    const leaf = textLeaves().find((item) => $isTextNode(item.node) && item.from <= trigger.from && item.to >= trigger.to)
    if (!leaf || !$isTextNode(leaf.node)) return
    const start = trigger.from - leaf.from
    const end = trigger.to - leaf.from
    const fragments = leaf.node.splitText(start, end)
    fragments[start === 0 ? 0 : 1]?.remove()
  }, { discrete: true })
}

export async function executeComposerCommand(
  editor: LexicalEditor,
  command: ComposerPickerCommand,
  onCommand: (command: ComposerPickerCommand) => Promise<void>,
  onError: (message: string) => void = () => {}
): Promise<void> {
  if (!editor.getEditorState().read(() => canExecuteComposerCommand())) return
  const previous = editor.getEditorState().read(composerDocumentFromLexical)
  editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      const paragraph = $createParagraphNode()
      root.append(paragraph)
      paragraph.selectEnd()
    },
    { discrete: true }
  )
  try {
    await onCommand(command)
  } catch (error) {
    editor.update(
      () => {
        restoreComposerDocument(previous)
      },
      { discrete: true }
    )
    onError(error instanceof Error ? error.message : String(error))
  }
}

function canExecuteComposerCommand(trigger?: ComposerTrigger | null): boolean {
  const document = composerDocumentFromLexical()
  if (document.items.some((item) => item.type !== "text")) return false
  const text = document.items.map((item) => (item.type === "text" ? item.text : "")).join("")
  const current = trigger ?? findComposerTrigger(text, text.trimEnd().length)
  return (
    !!current &&
    current.sigil === "/" &&
    current.mode === "leading" &&
    (text.slice(0, current.from) + text.slice(current.to)).trim() === ""
  )
}

export function triggerFromEditorState(): ComposerTrigger | null {
  const selection = $getSelection()
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null
  const anchor = selection.anchor.getNode()
  if (!$isTextNode(anchor)) return null
  const leaves = textLeaves()
  const leaf = leaves.find((item) => item.node === anchor)
  return leaf
    ? findComposerTrigger(editorText(leaves), leaf.from + selection.anchor.offset, {
        atomicBoundaries: leaves
          .filter(
            (item) => $isSkillMentionNode(item.node) || item.node instanceof ResourceMentionNode
          )
          .map((item) => item.to),
      })
    : null
}

export function insertSkillMention(
  editor: LexicalEditor,
  trigger: ComposerTrigger,
  skill: ComposerPickerSkill
): void {
  editor.update(
    () => {
      const selection = $getSelection()
      if (!$isRangeSelection(selection)) return
      const leaf = textLeaves().find(
        (item) => $isTextNode(item.node) && item.from <= trigger.from && item.to >= trigger.to
      )
      if (!leaf || !$isTextNode(leaf.node)) return
      const textNode = leaf.node as TextNode
      const start = trigger.from - leaf.from
      const end = trigger.to - leaf.from
      const fragments = textNode.splitText(start, end)
      const selectedIndex = start === 0 ? 0 : 1
      const selected = fragments[selectedIndex]
      const after = fragments[selectedIndex + 1]
      if (!selected) return
      const mention = $createSkillMentionNode(
        skill.name,
        skill.path,
        skill.displayName ?? skill.name,
        skill.source ?? ""
      )
      selected.replace(mention)
      const spacer = after?.getTextContent().startsWith(" ") ? null : $createTextNode(" ")
      if (spacer) mention.insertAfter(spacer)
      const caretNode = spacer ?? after
      if (caretNode && $isTextNode(caretNode)) caretNode.select(1, 1)
    },
    { discrete: true }
  )
}

function textLeaves(): TextLeaf[] {
  const leaves: TextLeaf[] = []
  let offset = 0
  $getRoot()
    .getChildren()
    .forEach((paragraph, index) => {
      if (index > 0) offset += 1
      for (const node of descendantLeaves(paragraph)) {
        const text = node.getTextContent()
        leaves.push({ node, from: offset, to: offset + text.length })
        offset += text.length
      }
    })
  return leaves
}

function editorText(leaves: TextLeaf[]): string {
  let text = ""
  for (const leaf of leaves) {
    text += "\n".repeat(Math.max(0, leaf.from - text.length)) + leaf.node.getTextContent()
  }
  return text
}

function descendantLeaves(node: LexicalNode): LexicalNode[] {
  return $isElementNode(node) ? node.getChildren().flatMap(descendantLeaves) : [node]
}
function isSkillSource(value: string): value is NonNullable<ComposerPickerSkill["source"]> {
  return value === "bundled" || value === "user" || value === "project" || value === "plugin"
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
        "text-ui-small pointer-events-none absolute top-3 left-4 leading-6 text-placeholder/65",
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
  skills = [],
  commands = [],
  className,
  onChange,
  onSubmit,
  onCommand = async () => undefined,
  onPasteFiles,
  onPickFiles,
}: {
  id: string
  value: ComposerDocument
  rows: number
  placeholder: string
  disabled: boolean
  skills?: readonly ComposerSkill[]
  commands?: readonly ComposerPickerItem[]
  className?: string
  onChange: (value: ComposerDocument) => void
  onSubmit: () => void
  onCommand?: (command: ComposerPickerCommand) => Promise<void>
  onPasteFiles?: (files: readonly File[]) => void
  onPickFiles?: () => void
}): React.JSX.Element {
  const [isComposing, setIsComposing] = useState(false)
  const [commandError, setCommandError] = useState<string | null>(null)
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
      nodes: [SkillMentionNode, ResourceMentionNode],
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
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
              className={cn(
                "text-ui-small block max-h-44 min-h-18 w-full overflow-y-auto bg-transparent px-4 pt-3 leading-6 break-words whitespace-pre-wrap text-foreground outline-none",
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
        <ComposerClipboardPlugin onPasteFiles={onPasteFiles} skills={skills} />
        <SyncDraftPlugin value={value} onChange={onChange} />
        <ComposerPickerPlugin
          skills={skills}
          commands={commands}
          onCommand={onCommand}
          onCommandError={setCommandError}
          onPickFiles={onPickFiles}
        />
        {!isComposing && !disabled ? <SubmitKeyPlugin onSubmit={onSubmit} /> : null}
        {commandError ? (
          <p role="alert" className="px-4 text-sm text-destructive">
            {commandError}
          </p>
        ) : null}
      </div>
    </LexicalComposer>
  )
}
