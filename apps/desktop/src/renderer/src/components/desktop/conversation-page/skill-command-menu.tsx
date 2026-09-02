import { Box } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import { Button } from "@renderer/components/ui/button"
import { cn } from "@renderer/lib/utils"
import type { ComposerSkillCommand } from "./composer-skill-commands"
import {
  draftForSelectedSkillCommand,
  filterSkillCommands,
  getSkillCommandTrigger,
} from "./composer-skill-commands"

export function SkillCommandMenu({
  draft,
  commands,
  onSelect,
}: {
  draft: string
  commands: ComposerSkillCommand[]
  onSelect: (value: string) => void
}): React.JSX.Element | null {
  const trigger = getSkillCommandTrigger(draft)
  const query = trigger?.query
  const [dismissedDraft, setDismissedDraft] = useState<string | null>(null)
  const open = Boolean(trigger && dismissedDraft !== draft)
  const options = useMemo(
    () => (open && query !== undefined ? filterSkillCommands(commands, query) : []),
    [commands, open, query]
  )
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const activeIndex = Math.min(highlightedIndex, Math.max(options.length - 1, 0))
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    setHighlightedIndex(0)
  }, [query])

  useEffect(() => {
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" })
  }, [activeIndex, options])

  useEffect(() => {
    if (!open || options.length === 0) return

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setHighlightedIndex((current) => (current + 1) % options.length)
      } else if (event.key === "ArrowUp") {
        event.preventDefault()
        setHighlightedIndex((current) => (current - 1 + options.length) % options.length)
      } else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault()
        onSelect(draftForSelectedSkillCommand(options[activeIndex]))
      } else if (event.key === "Escape") {
        event.preventDefault()
        setDismissedDraft(draft)
      }
    }

    window.addEventListener("keydown", handleKeyDown, true)
    return () => window.removeEventListener("keydown", handleKeyDown, true)
  }, [activeIndex, draft, onSelect, open, options])

  if (!open || commands.length === 0 || options.length === 0) return null

  return (
    <div
      role="listbox"
      aria-label="技能"
      className="absolute right-0 bottom-[calc(100%+10px)] left-0 z-40 overflow-hidden rounded-2xl bg-background/95 py-2 shadow-composer ring-1 ring-black/7 backdrop-blur dark:bg-card/95 dark:ring-white/12"
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="text-ui-caption px-4 pb-1 font-medium text-muted-foreground">技能</div>
      <div className="max-h-72 scroll-py-1 scrollbar-thin overflow-y-auto overscroll-contain px-2 pb-1">
        {options.map((command, index) => (
          <SkillCommandMenuItem
            key={command.name}
            buttonRef={(element) => {
              optionRefs.current[index] = element
            }}
            command={command}
            highlighted={index === activeIndex}
            onHighlight={() => setHighlightedIndex(index)}
            onSelect={() => onSelect(draftForSelectedSkillCommand(command))}
          />
        ))}
      </div>
    </div>
  )
}

function SkillCommandMenuItem({
  buttonRef,
  command,
  highlighted,
  onHighlight,
  onSelect,
}: {
  buttonRef?: (element: HTMLButtonElement | null) => void
  command: ComposerSkillCommand
  highlighted: boolean
  onHighlight: () => void
  onSelect: () => void
}): React.JSX.Element {
  return (
    <Button
      ref={buttonRef}
      type="button"
      variant="ghost"
      role="option"
      aria-selected={highlighted}
      title={`${command.label} — ${command.description}`}
      onMouseEnter={onHighlight}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
      className={cn(
        "h-7.5 w-full justify-start gap-2 rounded-lg px-2 text-left font-normal",
        highlighted && "bg-muted text-foreground"
      )}
    >
      <span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
        <Box className="size-3.5" />
      </span>
      <span className="text-ui-small min-w-0 flex-1 truncate font-medium">{command.label}</span>
      <span className="hidden min-w-0 flex-[1.35] truncate text-xs text-muted-foreground sm:inline">
        {command.description}
      </span>
      <span className="text-ui-caption shrink-0 text-muted-foreground/65">
        {command.sourceLabel}
      </span>
    </Button>
  )
}
