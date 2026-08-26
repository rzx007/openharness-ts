import { Circle } from "lucide-react"

import { cn } from "@renderer/lib/utils"
import type { DesktopScheduledTask } from "@shared/schedule-types"
import { TaskActionsMenu } from "./task-actions-menu"
import { formatNextRunLabel, recurrenceShortLabel } from "./utils"

export function TaskRow({
  task,
  active,
  compact,
  running,
  busy,
  onSelect,
  onRunNow,
  onEdit,
  onToggle,
  onDelete,
}: {
  task: DesktopScheduledTask
  active: boolean
  compact: boolean
  running: boolean
  busy: boolean
  onSelect: () => void
  onRunNow: () => void
  onEdit: () => void
  onToggle: () => void
  onDelete: () => void
}): React.JSX.Element {
  const nextRunLabel = task.nextRunAt ? formatNextRunLabel(task.nextRunAt) : null
  return (
    <div
      className={cn(
        "group relative w-full rounded-xl border border-transparent transition-[background-color,border-color,box-shadow] duration-150",
        active ? "border-border/60 bg-muted" : "hover:bg-muted/85"
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? "true" : undefined}
        className="w-full rounded-xl text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <div className={cn("flex items-start gap-3.5", compact ? "px-3.5 py-3.5" : "px-3 py-4")}>
          <div className="pt-1">
            {active ? (
              <span className="inline-flex size-4.5 items-center justify-center rounded-full border border-foreground/30 bg-foreground text-background">
                <span className="size-1.5 rounded-full bg-background" />
              </span>
            ) : (
              <Circle className="size-4.5 text-muted-foreground/60" strokeWidth={1.5} />
            )}
          </div>

          <div className="min-w-0 flex-1 pr-8">
            <div
              className={cn(
                "truncate font-medium text-sidebar-foreground",
                compact ? "text-[14px]" : "text-[15px]"
              )}
            >
              {task.name}
            </div>
            <div
              className={cn(
                "mt-1 flex items-center justify-between gap-4 text-muted-foreground",
                compact ? "text-[12px]" : "text-[13px]"
              )}
            >
              <p className="min-w-0 truncate">
                {recurrenceShortLabel(task)}
                {nextRunLabel ? ` · ${nextRunLabel}` : null}
              </p>
              {running ? (
                <span className="shrink-0">
                  运行中
                  {task.runCount > 0 ? ` · 已运行 ${task.runCount} 次` : null}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </button>

      <div className="absolute top-2.5 right-2.5">
        <TaskActionsMenu
          task={task}
          busy={busy}
          onRunNow={onRunNow}
          onEdit={onEdit}
          onToggle={onToggle}
          onDelete={onDelete}
          triggerClassName={cn(
            "opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 data-[popup-open]:opacity-100",
            active && "opacity-100"
          )}
        />
      </div>
    </div>
  )
}
