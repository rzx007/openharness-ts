import { Goal, Pause, Play, Trash2 } from "lucide-react"
import { Button } from "@renderer/components/ui/button"
import type { SessionGoal } from "@shared/session-types"

const labels: Record<SessionGoal["status"], string> = {
  active: "正在推进目标",
  waiting_user: "目标等待你的处理",
  blocked: "目标暂时受阻",
  paused: "已暂停的目标",
  completed: "目标已完成",
  cancelled: "目标已取消",
}

export function GoalBanner({ goal, busy, onAction }: { goal: SessionGoal; busy: boolean; onAction: (action: "pause" | "resume" | "cancel") => void }): React.JSX.Element {
  return (
    <div className="flex h-10 items-center gap-2 rounded-xl border border-border/70 bg-background/95 px-3 text-sm shadow-sm">
      <Goal className="size-4 shrink-0 text-muted-foreground" />
      <span className="shrink-0 font-medium">{labels[goal.status]}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{goal.objective}</span>
      {goal.status === "active" ? <Button type="button" variant="ghost" size="icon-xs" disabled={busy} aria-label="暂停目标" onClick={() => onAction("pause")}><Pause /></Button> : null}
      {goal.status === "paused" || goal.status === "blocked" ? <Button type="button" variant="ghost" size="icon-xs" disabled={busy} aria-label="继续目标" onClick={() => onAction("resume")}><Play /></Button> : null}
      {goal.status !== "completed" && goal.status !== "cancelled" ? <Button type="button" variant="ghost" size="icon-xs" disabled={busy} aria-label="取消目标" onClick={() => onAction("cancel")}><Trash2 /></Button> : null}
    </div>
  )
}
