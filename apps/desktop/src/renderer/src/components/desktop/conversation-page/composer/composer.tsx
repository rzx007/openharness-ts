import { ChevronDown, Mic, ShieldCheck } from "lucide-react"
import { IconPlus } from "@tabler/icons-react"
import { useState } from "react"

import { Button } from "@renderer/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover"
import { cn } from "@renderer/lib/utils"
import type { DesktopAttachmentDraft } from "@shared/attachment-types"
import type { DesktopContextUsageSnapshot } from "@shared/context-usage-types"
import type { DesktopModel, DesktopPermissionMode, DesktopSessionRecord } from "@shared/session-types"
import type { ComposerDocument } from "@renderer/stores/desktop-session/composer-document"
import { ComposerAttachments } from "./composer-attachments"
import { readComposerDrop } from "./composer-file-input"
import { ComposerIconButton, ComposerSendButton, PermissionModeMenu } from "./controls"
import { ContextUsageControl } from "./context-usage-control"
import { ModelPicker } from "./model-picker"
import { RichPromptInput } from "./rich-prompt-input"
import type { ComposerSkill } from "./rich-prompt-input"
import type { ComposerPickerCommand, ComposerPickerItem } from "./composer-picker"
import { resolvePermissionModeLabel } from "../utils"

export function Composer({
  id,
  draft,
  sending,
  running = false,
  models,
  selectedModel,
  selectedProvider,
  modelLabel,
  permissionMode,
  skills = [],
  commands = [],
  conversations = [],
  activeSessionId = null,
  className,
  textareaClassName,
  rows = 2,
  canSubmit,
  contextUsage = null,
  onOpenContextUsage,
  onDraftChange,
  onSubmit,
  onCommand,
  onInterrupt,
  onSelectModel,
  onSelectPermissionMode,
  attachments = [],
  attachmentInteractionEnabled = false,
  attachmentReadOnly = false,
  onPickFiles,
  onDropFiles,
  onPasteFiles,
  onCancelAttachment,
  onRetryAttachment,
  onRemoveAttachment,
}: {
  id: string
  draft: ComposerDocument
  sending: boolean
  running?: boolean
  models: DesktopModel[]
  selectedModel: string | null
  selectedProvider: string | null
  modelLabel: string
  permissionMode: DesktopPermissionMode
  skills?: readonly ComposerSkill[]
  commands?: readonly ComposerPickerItem[]
  conversations?: readonly DesktopSessionRecord[]
  activeSessionId?: string | null
  className?: string
  textareaClassName?: string
  rows?: number
  canSubmit?: boolean
  contextUsage?: DesktopContextUsageSnapshot | null
  onOpenContextUsage?: () => void
  onDraftChange: (value: ComposerDocument) => void
  onSubmit: () => void
  onCommand?: (command: ComposerPickerCommand) => Promise<void>
  onInterrupt?: () => void
  onSelectModel: (model: DesktopModel) => void
  onSelectPermissionMode: (mode: DesktopPermissionMode) => void
  attachments?: readonly DesktopAttachmentDraft[]
  attachmentInteractionEnabled?: boolean
  attachmentReadOnly?: boolean
  onPickFiles?: () => void
  onDropFiles?: (files: readonly File[]) => void
  onPasteFiles?: (files: readonly File[]) => void
  onCancelAttachment?: (draftId: string) => void
  onRetryAttachment?: (draftId: string) => void
  onRemoveAttachment?: (draftId: string) => void
}): React.JSX.Element {
  const [activePicker, setActivePicker] = useState<"model" | "permission" | null>(null)
  const [contextPickerRequest, setContextPickerRequest] = useState(0)
  const permissionLabel = resolvePermissionModeLabel(permissionMode)
  const closePicker = (): void => setActivePicker(null)
  const allowSubmit = canSubmit ?? draft.items.length > 0
  const attachDisabled = attachmentReadOnly
  const contextItems: ComposerPickerItem[] = [
    {
      id: "context:files",
      kind: "context",
      label: "文件和文件夹",
      description: "添加本地文件或文件夹",
      context: { kind: "files" },
    },
    {
      id: "context:plan",
      kind: "context",
      label: "计划模式",
      description: "切换为只读分析模式",
      context: { kind: "plan" },
    },
    ...conversations
      .filter((session) => session.id !== activeSessionId && session.status !== "archived")
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((session): ComposerPickerItem => ({
        id: `context:conversation:${session.id}`,
        kind: "context",
        label: session.title.trim() || "未命名对话",
        description: "引用历史对话",
        sourceLabel: "对话",
        context: { kind: "conversation", sessionId: session.id, displayName: session.title.trim() || "未命名对话" },
      })),
  ]

  const submit = (): void => {
    if (sending || !allowSubmit) return
    onSubmit()
  }

  return (
    <form
      className={cn(
        "relative min-w-0 overflow-visible rounded-2xl bg-background shadow-composer ring-1 ring-black/7 dark:bg-card dark:ring-white/12",
        className
      )}
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
      onDragOver={(event) => {
        if (!attachmentInteractionEnabled || !event.dataTransfer.types.includes("Files")) return
        event.preventDefault()
        event.dataTransfer.dropEffect = "copy"
      }}
      onDrop={(event) => {
        if (!attachmentInteractionEnabled) return
        const files = readComposerDrop(event.dataTransfer.files)
        if (files.length === 0) return
        event.preventDefault()
        onDropFiles?.(files)
      }}
    >
      <label htmlFor={id} className="sr-only">
        输入对话内容
      </label>
      <ComposerAttachments
        attachments={attachments}
        readOnly={attachmentReadOnly}
        onCancel={(draftId) => onCancelAttachment?.(draftId)}
        onRetry={(draftId) => onRetryAttachment?.(draftId)}
        onRemove={(draftId) => onRemoveAttachment?.(draftId)}
      />
      <RichPromptInput
        id={id}
        value={draft}
        placeholder="随心输入"
        rows={rows}
        disabled={sending}
        skills={skills}
        commands={commands}
        className={textareaClassName}
        onChange={onDraftChange}
        onSubmit={submit}
        onCommand={onCommand}
        onPasteFiles={attachmentInteractionEnabled ? onPasteFiles : undefined}
        contextItems={contextItems}
        contextPickerRequest={contextPickerRequest}
        onContextAction={(item) => {
          if (item.context?.kind === "files") onPickFiles?.()
          if (item.context?.kind === "plan") onSelectPermissionMode("plan")
        }}
      />
      <div className="flex h-12 min-w-0 items-center gap-1 px-3 pb-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="rounded-full"
          aria-label="添加上下文"
          title="添加上下文"
          disabled={attachDisabled}
          onClick={() => setContextPickerRequest((value) => value + 1)}
        >
          <IconPlus className="size-5" />
        </Button>
        <Popover
          open={activePicker === "permission"}
          onOpenChange={(open) => setActivePicker(open ? "permission" : null)}
        >
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                className="ml-1 h-8 max-w-36 min-w-0 shrink overflow-hidden px-2 text-xs font-normal text-muted-foreground"
              />
            }
          >
            <ShieldCheck data-icon="inline-start" />
            <span className="min-w-0 truncate">{permissionLabel}</span>
            <ChevronDown data-icon="inline-end" />
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="start"
            sideOffset={8}
            className="w-56 gap-0 rounded-xl p-1.5 shadow-lg ring-1 ring-black/10"
          >
            <PermissionModeMenu
              selected={permissionMode}
              onSelect={(mode) => {
                onSelectPermissionMode(mode)
                closePicker()
              }}
            />
          </PopoverContent>
        </Popover>
        <div className="ml-auto flex min-w-0 items-center gap-0.5">
          <ModelPicker
            open={activePicker === "model"}
            onOpenChange={(open) => setActivePicker(open ? "model" : null)}
            models={models}
            selectedModel={selectedModel}
            selectedProvider={selectedProvider}
            modelLabel={modelLabel}
            onSelectModel={(model) => {
              onSelectModel(model)
              closePicker()
            }}
          />
          <ComposerIconButton label="语音输入">
            <Mic />
          </ComposerIconButton>
          <ContextUsageControl snapshot={contextUsage} onOpen={onOpenContextUsage} />
          <ComposerSendButton
            sending={sending}
            running={running}
            disabled={!allowSubmit}
            onInterrupt={onInterrupt}
          />
        </div>
      </div>
    </form>
  )
}
