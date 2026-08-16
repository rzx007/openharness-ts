import {
  ArrowUp,
  ChevronDown,
  CircleStop,
  LoaderCircle,
  Mic,
  Plus,
  ShieldCheck,
} from "lucide-react"
import { useState } from "react"

import { Button } from "@renderer/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover"
import type { DesktopModel, DesktopPermissionMode } from "@shared/session-types"
import { ComposerIconButton, PermissionModeMenu, PickerMenuItem } from "./controls"
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
      className="mx-auto mb-5 w-[min(760px,calc(100%-32px))] shrink-0 rounded-2xl bg-background shadow-composer ring-1 ring-black/7 dark:bg-card dark:ring-white/12"
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
      <div className="flex h-12 items-center gap-1 px-3 pb-2">
        <ComposerIconButton label="添加附件">
          <Plus />
        </ComposerIconButton>
        <Popover
          open={activePicker === "permission"}
          onOpenChange={(open) => setActivePicker(open ? "permission" : null)}
        >
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-expanded={activePicker === "permission"}
                className="ml-1 flex h-8 max-w-36 items-center gap-1.5 rounded-md px-2 text-xs text-ui-muted transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <ShieldCheck className="size-3.5 shrink-0" />
                <span className="truncate">{permissionLabel}</span>
                <ChevronDown className="size-3 shrink-0" />
              </button>
            }
          />
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
        <div className="ml-auto flex items-center gap-1">
          <Popover
            open={activePicker === "model"}
            onOpenChange={(open) => setActivePicker(open ? "model" : null)}
          >
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-expanded={activePicker === "model"}
                  className="flex h-8 max-w-52 items-center gap-1.5 rounded-md px-2 text-xs text-ui-muted transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="truncate">{modelLabel}</span>
                  <ChevronDown className="size-3 shrink-0" />
                </button>
              }
            />
            <PopoverContent
              side="top"
              align="end"
              sideOffset={8}
              className="w-64 gap-0 rounded-xl p-1.5 shadow-lg ring-1 ring-black/10"
            >
              <div className="max-h-64 overflow-y-auto py-0.5">
                {models.map((model) => (
                  <PickerMenuItem
                    key={`${model.providerName}:${model.id}`}
                    selected={model.id === selectedModel && model.providerName === selectedProvider}
                    onClick={() => {
                      onSelectModel(model)
                      closePicker()
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{model.label}</span>
                  </PickerMenuItem>
                ))}
              </div>
            </PopoverContent>
          </Popover>
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
              <CircleStop className="size-4" />
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
              {sending ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <ArrowUp className="size-4" />
              )}
            </Button>
          )}
        </div>
      </div>
    </form>
  )
}
