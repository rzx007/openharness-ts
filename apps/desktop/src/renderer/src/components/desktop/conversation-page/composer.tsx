import { IconFilePlus, IconFolderPlus, IconPhotoPlus } from "@tabler/icons-react"
import { ChevronDown, Mic, ShieldCheck } from "lucide-react"
import { useState } from "react"

import { Button } from "@renderer/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover"
import { PlusMenu } from "@renderer/components/ui/plus-menu"
import { cn } from "@renderer/lib/utils"
import type { DesktopModel, DesktopPermissionMode } from "@shared/session-types"
import { ComposerIconButton, ComposerSendButton, PermissionModeMenu } from "./controls"
import type { ComposerSkillCommand } from "./composer-skill-commands"
import { ModelPicker } from "./model-picker"
import { RichPromptInput } from "./rich-prompt-input"
import { SkillCommandMenu } from "./skill-command-menu"
import { resolvePermissionModeLabel } from "./utils"

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
  skillCommands = [],
  className,
  textareaClassName,
  rows = 2,
  canSubmit,
  onDraftChange,
  onSubmit,
  onInterrupt,
  onSelectModel,
  onSelectPermissionMode,
}: {
  id: string
  draft: string
  sending: boolean
  running?: boolean
  models: DesktopModel[]
  selectedModel: string | null
  selectedProvider: string | null
  modelLabel: string
  permissionMode: DesktopPermissionMode
  skillCommands?: ComposerSkillCommand[]
  className?: string
  textareaClassName?: string
  rows?: number
  canSubmit?: boolean
  onDraftChange: (value: string) => void
  onSubmit: () => void
  onInterrupt?: () => void
  onSelectModel: (model: DesktopModel) => void
  onSelectPermissionMode: (mode: DesktopPermissionMode) => void
}): React.JSX.Element {
  const [activePicker, setActivePicker] = useState<"model" | "permission" | null>(null)
  const permissionLabel = resolvePermissionModeLabel(permissionMode)
  const closePicker = (): void => setActivePicker(null)
  const allowSubmit = canSubmit ?? Boolean(draft.trim())

  const submit = (): void => {
    if (sending || running || !allowSubmit) return
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
    >
      <label htmlFor={id} className="sr-only">
        输入对话内容
      </label>
      <RichPromptInput
        id={id}
        value={draft}
        placeholder="随心输入"
        rows={rows}
        disabled={sending}
        skillCommands={skillCommands}
        className={textareaClassName}
        onChange={onDraftChange}
        onSubmit={submit}
      />
      <SkillCommandMenu draft={draft} commands={skillCommands} onSelect={onDraftChange} />
      <div className="flex h-12 min-w-0 items-center gap-1 px-3 pb-2">
        <PlusMenu
          items={[
            { id: "file", label: "添加文件", icon: <IconFilePlus className="size-4" /> },
            { id: "image", label: "添加图片", icon: <IconPhotoPlus className="size-4" /> },
            { id: "folder", label: "添加文件夹", icon: <IconFolderPlus className="size-4" /> },
          ]}
          triggerLabel={{ open: "关闭附件菜单", closed: "添加附件" }}
        />
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
        <div className="ml-auto flex min-w-0 items-center gap-1">
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
