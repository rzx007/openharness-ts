import { Archive, Circle, CirclePause, History, MoreHorizontal, Play, X } from "lucide-react"

import { Button } from "@renderer/components/ui/button"
import { ScrollArea } from "@renderer/components/ui/scroll-area"
import { Spinner } from "@renderer/components/ui/spinner"
import { cn } from "@renderer/lib/utils"
import type { DesktopScheduledRun, DesktopScheduledTask } from "@shared/schedule-types"
import { TaskActionsMenu } from "./task-actions-menu"
import {
  formatRunAge,
  projectLabel,
  recurrenceFrequency,
  recurrenceTime,
  statusLabel,
} from "./utils"

export function DetailPanel({
  task,
  runs,
  busy,
  onBack,
  onRunNow,
  onEdit,
  onToggle,
  onDelete,
}: {
  task: DesktopScheduledTask
  runs: DesktopScheduledRun[]
  busy: string | null
  onBack: () => void
  onRunNow: () => void
  onEdit: () => void
  onToggle: () => void
  onDelete: () => void
}): React.JSX.Element {
  return (
    <div className="mx-auto w-full">
      <div className="flex items-center justify-between gap-4">
        <span className="text-[13px] font-medium text-blue-600 dark:text-blue-400">
          {statusLabel(task.status)}
        </span>
        <div className="flex items-center gap-1">
          <TaskActionsMenu
            task={task}
            busy={busy !== null}
            onRunNow={onRunNow}
            onEdit={onEdit}
            onToggle={onToggle}
            onDelete={onDelete}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onToggle}
            disabled={busy !== null}
            title={task.status === "active" ? "暂停任务" : "继续任务"}
            className="h-8 rounded-lg px-3 text-[12px]"
          >
            {busy === "toggle" ? (
              <Spinner className="size-3.5" />
            ) : task.status === "active" ? (
              <CirclePause className="size-3.5" />
            ) : (
              <Play className="size-3.5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onBack}
            title="关闭详情"
            aria-label="关闭详情"
            className="size-8 rounded-lg text-muted-foreground"
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      <h2 className="mt-3 truncate text-[16px] font-medium tracking-[-0.01em] text-foreground">
        {task.name}
      </h2>

      <ScrollArea
        className="mt-7 max-h-64.5 rounded-2xl border border-border/70 bg-muted/10"
        viewportClassName="px-4 py-4"
      >
        <div className="max-w-[76ch] text-[13px] leading-6 whitespace-pre-wrap text-foreground/90">
          {task.prompt}
        </div>
      </ScrollArea>

      <SettingsGroup
        title="详情"
        className="mt-8"
        items={[
          {
            label: "运行于",
            value: task.destination === "chat" ? "现有聊天" : "每次独立对话",
          },
          {
            label: task.destination === "chat" ? "聊天" : "工作位置",
            value:
              task.destination === "chat"
                ? task.name
                : task.projectPaths[0]
                  ? projectLabel(task)
                  : "不在项目中工作",
          },
        ]}
      />

      <SettingsGroup
        title="频率"
        className="mt-8"
        items={[
          { label: "重复", value: recurrenceFrequency(task) },
          { label: "时间", value: recurrenceTime(task) ?? "按规则执行" },
          { label: "通知", value: "重要更新" },
        ]}
      />

      <section className="mt-12">
        <div className="flex items-center justify-between px-1">
          <h3 className="text-[13px] font-normal text-muted-foreground/70">运行历史记录</h3>
          <MoreHorizontal className="size-4 text-muted-foreground/65" aria-hidden="true" />
        </div>

        {runs.length === 0 ? (
          <div className="flex h-20 items-center gap-2 px-2 text-[12px] text-muted-foreground">
            <History className="size-4" />
            这个任务还没有运行记录
          </div>
        ) : (
          <div className="mt-3">
            {runs.slice(0, 4).map((run, index) => (
              <article
                key={run.id}
                className="flex min-h-10 items-center gap-3 px-2 text-[12px] text-muted-foreground"
              >
                {index === 0 ? (
                  <Circle className="size-2.5 shrink-0 fill-current" strokeWidth={0} />
                ) : (
                  <Archive className="size-3.5 shrink-0" strokeWidth={1.6} />
                )}
                <span className={cn("truncate", index === 0 && "font-medium text-foreground/80")}>
                  {task.name}
                </span>
                <span className="truncate text-muted-foreground/60">{projectLabel(task)}</span>
                <time
                  className="ml-auto shrink-0 text-muted-foreground/60 tabular-nums"
                  dateTime={new Date(run.createdAt).toISOString()}
                >
                  {formatRunAge(run.createdAt)}
                </time>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function SettingsGroup({
  title,
  items,
  className,
}: {
  title: string
  items: Array<{ label: string; value: string }>
  className?: string
}): React.JSX.Element {
  return (
    <section className={className}>
      <h3 className="px-1 text-[13px] font-normal text-muted-foreground/70">{title}</h3>
      <dl className="mt-3 overflow-hidden rounded-2xl border border-border/70 bg-background">
        {items.map((item) => (
          <div
            key={item.label}
            className="flex min-h-[50px] items-center justify-between gap-6 border-b border-border/60 px-4 last:border-b-0"
          >
            <dt className="text-[13px] text-foreground/80">{item.label}</dt>
            <dd className="min-w-0 truncate text-[13px] font-medium text-foreground">
              {item.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
