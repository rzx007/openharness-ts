import { CirclePause, MoreHorizontal, Pencil, Play, Trash2 } from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu"
import { cn } from "@renderer/lib/utils"
import type { DesktopScheduledTask } from "@shared/schedule-types"

export function TaskActionsMenu({
  task,
  busy,
  onRunNow,
  onEdit,
  onToggle,
  onDelete,
  triggerClassName,
}: {
  task: DesktopScheduledTask
  busy: boolean
  onRunNow: () => void
  onEdit: () => void
  onToggle?: () => void
  onDelete: () => void
  triggerClassName?: string
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${task.name}的更多操作`}
        title="更多操作"
        className={cn(
          "grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-muted data-[popup-open]:text-foreground [&_svg]:size-4",
          triggerClassName
        )}
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="min-w-40">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={onEdit} disabled={busy}>
            <Pencil />
            编辑
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onRunNow} disabled={busy}>
            <Play />
            立即运行
          </DropdownMenuItem>
          {onToggle ? (
            <DropdownMenuItem onClick={onToggle} disabled={busy}>
              {task.status === "active" ? <CirclePause /> : <Play />}
              {task.status === "active" ? "暂停" : "继续"}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem variant="destructive" onClick={onDelete} disabled={busy}>
            <Trash2 />
            删除
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
