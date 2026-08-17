import { ArrowUp, ChevronDown, CircleStop, Mic, Plus, ShieldCheck } from "lucide-react"
import { useState } from "react"

import { Button } from "@renderer/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover"
import { Spinner } from "@renderer/components/ui/spinner"
import type { DesktopModel, DesktopPermissionMode } from "@shared/session-types"
import { ComposerIconButton, PermissionModeMenu } from "./controls"
import { ModelPicker } from "./model-picker"
import { resolvePermissionModeLabel } from "./utils"

export function Composer({
  id,
  draft,
  sending,
  running,
  models,
  selectedModel,
  selectedProvider,
  modelLabel,
  permissionMode,
  onDraftChange,
  onSubmit,
  onInterrupt,
  onSelectModel,
  onSelectPermissionMode,
}: {
  id: string
  draft: string
  sending: boolean
  running: boolean
  models: DesktopModel[]
  selectedModel: string | null
  selectedProvider: string | null
  modelLabel: string
  permissionMode: DesktopPermissionMode
  onDraftChange: (value: string) => void
  onSubmit: () => void
  onInterrupt: () => void
  onSelectModel: (model: DesktopModel) => void
  onSelectPermissionMode: (mode: DesktopPermissionMode) => void
}): React.JSX.Element {
  const [activePicker, setActivePicker] = useState<"model" | "permission" | null>(null)
  const permissionLabel = resolvePermissionModeLabel(permissionMode)
  const closePicker = (): void => setActivePicker(null)

  return (
    <form
      className="mx-auto mb-5 w-[min(760px,calc(100%-32px))] min-w-0 shrink-0 overflow-hidden rounded-2xl bg-background shadow-composer ring-1 ring-black/7 dark:bg-card dark:ring-white/12"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <label htmlFor={id} className="sr-only">
        输入对话内容
      </label>
      <textarea
        id={id}
        value={draft}
        rows={2}
        placeholder="随心输入"
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault()
            onSubmit()
          }
        }}
        className="block max-h-44 min-h-18 w-full resize-none bg-transparent px-4 pt-3 text-[13px] leading-6 text-foreground outline-none placeholder:text-placeholder/65"
      />
      <div className="flex h-12 min-w-0 items-center gap-1 overflow-hidden px-3 pb-2">
        <ComposerIconButton label="添加附件">
          <Plus />
        </ComposerIconButton>
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
          {running ? (
            <Button
              type="button"
              size="icon"
              aria-label="停止生成"
              title="停止生成"
              onClick={onInterrupt}
              className="ml-1 size-8 rounded-full bg-foreground text-background hover:bg-foreground/85"
            >
              <CircleStop />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon"
              aria-label="发送"
              title="发送"
              disabled={!draft.trim() || sending}
              className="ml-1 size-8 rounded-full bg-foreground text-background hover:bg-foreground/85 disabled:bg-ui-muted disabled:text-background disabled:opacity-55"
            >
              {sending ? <Spinner /> : <ArrowUp />}
            </Button>
          )}
        </div>
      </div>
    </form>
  )
}
