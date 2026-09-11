import { Box, Command } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import { Button } from "@renderer/components/ui/button"
import { cn } from "@renderer/lib/utils"
import type {
  DesktopCommandCatalogEntry,
  DesktopCommandSource,
  SessionUserInputItem,
} from "@shared/session-types"

export interface ComposerPickerSkill extends Omit<
  Extract<SessionUserInputItem, { type: "skill" }>,
  "type"
> {
  type?: "skill"
  commandName?: string
  source?: "bundled" | "user" | "project" | "plugin"
}

export interface ComposerPickerCatalogSkill extends ComposerPickerSkill {
  displayName: string
  description: string
  sourceLabel: string
}

export interface ComposerPickerCommand {
  id: string
  title: string
  description: string
  requiresEmptyComposer: boolean
  selection: "execute" | "submenu" | "insert"
}

export interface ComposerPickerItem {
  id: string
  kind: "skill" | "command"
  label: string
  description: string
  sourceLabel?: string
  skill?: ComposerPickerSkill
  command?: ComposerPickerCommand
}

export function toComposerSkills(
  commands: readonly DesktopCommandCatalogEntry[]
): ComposerPickerCatalogSkill[] {
  return commands
    .filter(
      (command): command is Extract<DesktopCommandCatalogEntry, { kind: "template" }> =>
        command.kind === "template"
    )
    .map((command) => {
      const name = command.skillName
      return {
        name,
        commandName: command.name.replace(/^\//, ""),
        path: command.path,
        displayName: command.displayName?.trim() || name.replace(/[-_:]+/g, " ") || name,
        description: command.description?.trim() || "使用此技能处理当前请求",
        source: skillSource(command.source),
        sourceLabel: skillSourceLabel(command.source),
      }
    })
    .sort(
      (left, right) =>
        skillSourcePriority(left.source) - skillSourcePriority(right.source) ||
        (left.displayName ?? left.name).localeCompare(right.displayName ?? right.name)
    )
}

function filterPickerItems(
  items: readonly ComposerPickerItem[],
  query: string
): ComposerPickerItem[] {
  const normalized = query.trim().toLocaleLowerCase()
  return items.filter((item) => {
    if (!normalized) return true
    return [
      item.label,
      item.description,
      item.skill?.name ?? "",
      item.skill?.commandName ?? "",
    ].some((value) => value.toLocaleLowerCase().includes(normalized))
  })
}

export function toComposerCommands(
  commands: readonly DesktopCommandCatalogEntry[]
): ComposerPickerItem[] {
  return commands
    .filter(
      (command): command is Extract<DesktopCommandCatalogEntry, { kind: "session" }> =>
        command.kind === "session" &&
        command.selection === "execute" &&
        command.requiresEmptyComposer === true
    )
    .map((command) => {
      const id = command.name.replace(/^\//, "").trim()
      return {
        id,
        kind: "command" as const,
        label: command.displayName?.trim() || command.name,
        description: command.description?.trim() || "执行应用命令",
        command: {
          id,
          title: command.displayName?.trim() || command.name,
          description: command.description?.trim() || "执行应用命令",
          requiresEmptyComposer: true,
          selection: "execute",
        },
      }
    })
}

export function pickerItems({
  trigger,
  commands,
  skills,
}: {
  trigger: {
    sigil: "/" | "$"
    query: string
    mode: "leading" | "inline"
    from?: number
    to?: number
  }
  commands: readonly ComposerPickerItem[]
  skills: readonly ComposerPickerItem[]
}): ComposerPickerItem[] {
  const allowed =
    trigger.sigil === "/" && trigger.mode === "leading"
      ? [...commands.filter((item) => item.command?.requiresEmptyComposer), ...skills]
      : skills
  return filterPickerItems(allowed, trigger.query)
}

function skillSource(source: DesktopCommandSource | undefined): ComposerPickerSkill["source"] {
  return source === "bundled" || source === "user" || source === "project" || source === "plugin"
    ? source
    : undefined
}

function skillSourceLabel(source: DesktopCommandSource | undefined): string {
  if (source === "project") return "项目"
  if (source === "plugin") return "插件"
  if (source === "bundled" || source === "builtin") return "内置"
  return "个人"
}

function skillSourcePriority(source: ComposerPickerSkill["source"]): number {
  if (source === "project") return 0
  if (source === "user") return 1
  if (source === "plugin") return 2
  return 3
}

export function ComposerPicker({
  items,
  query,
  onSelect,
  onDismiss,
}: {
  items: readonly ComposerPickerItem[]
  query: string
  onSelect: (item: ComposerPickerItem) => void
  onDismiss: () => void
}): React.JSX.Element | null {
  const options = useMemo(() => filterPickerItems(items, query), [items, query])
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])
  const activeIndex = Math.min(highlightedIndex, Math.max(options.length - 1, 0))

  useEffect(() => setHighlightedIndex(0), [query, options.length])

  useEffect(() => {
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" })
  }, [activeIndex])

  useEffect(() => {
    if (options.length === 0) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setHighlightedIndex((current) => (current + 1) % options.length)
      } else if (event.key === "ArrowUp") {
        event.preventDefault()
        setHighlightedIndex((current) => (current - 1 + options.length) % options.length)
      } else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault()
        event.stopPropagation()
        onSelect(options[activeIndex]!)
      } else if (event.key === "Escape") {
        event.preventDefault()
        onDismiss()
      }
    }
    window.addEventListener("keydown", handleKeyDown, true)
    return () => window.removeEventListener("keydown", handleKeyDown, true)
  }, [activeIndex, onDismiss, onSelect, options])

  if (options.length === 0) return null

  return (
    <div
      role="listbox"
      aria-label="命令和技能"
      className="absolute right-0 bottom-[calc(100%+10px)] left-0 z-40 overflow-hidden rounded-2xl bg-background/95 py-2 shadow-composer ring-1 ring-black/7 backdrop-blur dark:bg-card/95 dark:ring-white/12"
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="text-ui-caption px-4 pb-1 font-medium text-muted-foreground">命令和技能</div>
      <div className="max-h-72 scroll-py-1 scrollbar-thin overflow-y-auto overscroll-contain px-2 pb-1">
        {options.map((item, index) => (
          <Button
            key={item.id}
            ref={(element) => {
              optionRefs.current[index] = element
            }}
            type="button"
            variant="ghost"
            role="option"
            aria-selected={index === activeIndex}
            title={`${item.label} — ${item.description}`}
            onMouseEnter={() => setHighlightedIndex(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(item)}
            className={cn(
              "h-7.5 w-full justify-start gap-2 rounded-lg px-2 text-left font-normal",
              index === activeIndex && "bg-muted text-foreground"
            )}
          >
            <span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
              {item.kind === "command" ? (
                <Command className="size-3.5" />
              ) : (
                <Box className="size-3.5" />
              )}
            </span>
            <span className="text-ui-small min-w-0 flex-1 truncate font-medium">{item.label}</span>
            <span className="hidden min-w-0 flex-[1.35] truncate text-xs text-muted-foreground sm:inline">
              {item.description}
            </span>
            {item.sourceLabel ? (
              <span className="text-ui-caption shrink-0 text-muted-foreground/65">
                {item.sourceLabel}
              </span>
            ) : null}
          </Button>
        ))}
      </div>
    </div>
  )
}
