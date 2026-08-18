import {
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Pause,
  Play,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react"
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react"

import { Button } from "@renderer/components/ui/button"
import { Input } from "@renderer/components/ui/input"
import { ScrollArea } from "@renderer/components/ui/scroll-area"
import { Spinner } from "@renderer/components/ui/spinner"
import { cn } from "@renderer/lib/utils"
import type {
  DesktopScheduledRun,
  DesktopScheduledStatus,
  DesktopScheduledTask,
} from "@shared/schedule-types"

type Filter = "all" | "active" | "paused" | "completed"

export function ScheduledPage({
  onStartConversation,
}: {
  onStartConversation: () => void
}): React.JSX.Element {
  const [tasks, setTasks] = useState<DesktopScheduledTask[]>([])
  const [runs, setRuns] = useState<DesktopScheduledRun[]>([])
  const [status, setStatus] = useState<DesktopScheduledStatus | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>("all")
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const deferredSearch = useDeferredValue(search.trim().toLocaleLowerCase())

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [nextStatus, nextTasks] = await Promise.all([
        window.desktop.schedules.status(),
        window.desktop.schedules.list(),
      ])
      setStatus(nextStatus)
      setTasks(nextTasks)
      setSelectedId((current) =>
        current && nextTasks.some((task) => task.id === current)
          ? current
          : (nextTasks[0]?.id ?? null)
      )
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const initialTimer = window.setTimeout(() => void refresh(), 0)
    const timer = window.setInterval(() => void refresh(), 20_000)
    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(timer)
    }
  }, [refresh])

  useEffect(() => {
    if (!selectedId) return
    let disposed = false
    void window.desktop.schedules
      .listRuns({ taskId: selectedId, limit: 30 })
      .then(async (nextRuns) => {
        if (disposed) return
        setRuns(nextRuns.map((run) => (run.unread ? { ...run, unread: false } : run)))
        const unreadRuns = nextRuns.filter((run) => run.unread)
        if (unreadRuns.length === 0) return
        await Promise.all(
          unreadRuns.map((run) => window.desktop.schedules.setRunUnread(run.id, false))
        )
        const nextStatus = await window.desktop.schedules.status()
        if (!disposed) setStatus(nextStatus)
      })
      .catch(
        (cause) => !disposed && setError(cause instanceof Error ? cause.message : String(cause))
      )
    return () => {
      disposed = true
    }
  }, [selectedId])

  const selected = useMemo(
    () => tasks.find((task) => task.id === selectedId) ?? null,
    [selectedId, tasks]
  )
  const visibleTasks = useMemo(() => {
    return tasks.filter((task) => {
      if (filter !== "all" && task.status !== filter) return false
      if (!deferredSearch) return true
      return `${task.name}\n${task.prompt}\n${task.projectPaths.join("\n")}`
        .toLocaleLowerCase()
        .includes(deferredSearch)
    })
  }, [deferredSearch, filter, tasks])

  const mutate = useCallback(
    async (key: string, operation: () => Promise<unknown>): Promise<void> => {
      setBusy(key)
      try {
        await operation()
        await refresh()
        if (selectedId)
          setRuns(await window.desktop.schedules.listRuns({ taskId: selectedId, limit: 30 }))
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(null)
      }
    },
    [refresh, selectedId]
  )

  return (
    <section className="flex h-full min-h-0 w-full flex-col bg-conversation" aria-busy={loading}>
      <header className="flex min-h-20 items-center gap-4 border-b border-border px-7 py-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">已安排</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            后台 Agent 任务和需要处理的运行结果
          </p>
        </div>
        <div className="relative ml-auto w-64 max-w-[32vw]">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索任务"
            className="h-8 pl-8"
          />
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw />
          刷新
        </Button>
        <Button size="sm" onClick={onStartConversation}>
          在对话中安排
        </Button>
      </header>

      {error ? (
        <div
          className="mx-7 mt-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[min(390px,38%)] min-w-72 flex-col border-r border-border">
          <div className="flex items-center gap-1 border-b border-border px-4 py-3">
            {(["all", "active", "paused", "completed"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={cn(
                  "rounded-md px-2.5 py-1.5 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  filter === value
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/60"
                )}
              >
                {filterLabel(value)}
              </button>
            ))}
            {status?.unread ? (
              <span className="ml-auto rounded-full bg-primary px-2 py-0.5 text-[10px] text-primary-foreground">
                {status.unread} 未读
              </span>
            ) : null}
          </div>
          <ScrollArea
            className="min-h-0 flex-1"
            viewportClassName="p-2"
            contentClassName="space-y-1"
          >
            {loading ? (
              <div className="flex items-center gap-2 px-3 py-6 text-xs text-muted-foreground">
                <Spinner className="size-4" />
                正在加载任务…
              </div>
            ) : null}
            {!loading && visibleTasks.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <CalendarClock className="mx-auto size-7 text-muted-foreground/50" />
                <p className="mt-3 text-sm font-medium">没有匹配的任务</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  在任意 Agent 对话里描述要做的工作和执行时间。
                </p>
              </div>
            ) : null}
            {visibleTasks.map((task) => (
              <button
                type="button"
                key={task.id}
                onClick={() => setSelectedId(task.id)}
                className={cn(
                  "w-full rounded-md px-3 py-2.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  task.id === selectedId ? "bg-muted" : "hover:bg-muted/55"
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{task.name}</span>
                  <TaskStatus status={task.status} />
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {recurrenceLabel(task)}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground/75">
                  {task.nextRunAt ? `下次 ${formatTime(task.nextRunAt)}` : "没有后续运行"}
                </p>
              </button>
            ))}
          </ScrollArea>
        </aside>

        <ScrollArea
          className="min-h-0 min-w-0 flex-1"
          viewportClassName="p-7"
          contentClassName="mx-auto max-w-4xl"
        >
          {selected ? (
            <>
              <div className="flex items-start gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-lg font-semibold">{selected.name}</h2>
                    <TaskStatus status={selected.status} />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {recurrenceLabel(selected)} · {selected.timezone}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() =>
                    void mutate("run", () => window.desktop.schedules.runNow(selected.id))
                  }
                >
                  {busy === "run" ? <Spinner /> : <Play />}立即运行
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null || selected.status === "completed"}
                  onClick={() =>
                    void mutate("toggle", () =>
                      window.desktop.schedules.update(selected.id, {
                        status: selected.status === "paused" ? "active" : "paused",
                      })
                    )
                  }
                >
                  {selected.status === "paused" ? <Play /> : <Pause />}
                  {selected.status === "paused" ? "继续" : "暂停"}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  title="删除任务"
                  aria-label="删除任务"
                  disabled={busy !== null}
                  onClick={() =>
                    void mutate("delete", () => window.desktop.schedules.remove(selected.id))
                  }
                >
                  <Trash2 />
                </Button>
              </div>

              <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Info
                  label="运行方式"
                  value={selected.destination === "chat" ? "返回关联对话" : "每次独立对话"}
                />
                <Info label="项目" value={selected.projectPaths[0] ?? "关联对话项目"} />
                <Info
                  label="执行环境"
                  value={selected.executionMode === "worktree" ? "独立 worktree" : "本地项目"}
                />
                <Info label="已运行" value={`${selected.runCount} 次`} />
              </div>

              <div className="mt-6 rounded-lg border border-border bg-background/55 p-4">
                <h3 className="text-xs font-semibold text-muted-foreground">每次运行的指令</h3>
                <p className="mt-2 text-sm leading-6 whitespace-pre-wrap">{selected.prompt}</p>
              </div>

              <div className="mt-7">
                <h3 className="text-sm font-semibold">最近运行</h3>
                <div className="mt-3 space-y-2">
                  {runs.length === 0 ? (
                    <p className="rounded-md border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">
                      这个任务还没有运行记录。
                    </p>
                  ) : null}
                  {runs.map((run) => (
                    <article
                      key={run.id}
                      className="rounded-md border border-border bg-background/45 px-4 py-3 [content-visibility:auto]"
                    >
                      <div className="flex items-center gap-2 text-xs">
                        {run.status === "succeeded" ? (
                          <CheckCircle2 className="size-3.5 text-emerald-600" />
                        ) : run.status === "running" ? (
                          <Spinner className="size-3.5" />
                        ) : (
                          <CircleAlert className="size-3.5 text-amber-600" />
                        )}
                        <span className="font-medium">{runStatusLabel(run.status)}</span>
                        <span className="text-muted-foreground">{formatTime(run.createdAt)}</span>
                        {run.unread ? (
                          <span className="ml-auto size-2 rounded-full bg-primary" title="未读" />
                        ) : null}
                      </div>
                      {run.summary || run.error ? (
                        <p className="mt-2 line-clamp-4 text-xs leading-5 whitespace-pre-wrap text-muted-foreground">
                          {run.summary ?? run.error}
                        </p>
                      ) : null}
                    </article>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="grid min-h-72 place-items-center text-center">
              <div>
                <Clock3 className="mx-auto size-8 text-muted-foreground/45" />
                <p className="mt-3 text-sm text-muted-foreground">选择一个已安排任务查看详情</p>
              </div>
            </div>
          )}
        </ScrollArea>
      </div>
    </section>
  )
}

function TaskStatus({ status }: { status: DesktopScheduledTask["status"] }): React.JSX.Element {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[10px]",
        status === "active"
          ? "bg-emerald-500/12 text-emerald-700"
          : status === "paused"
            ? "bg-amber-500/12 text-amber-700"
            : "bg-muted text-muted-foreground"
      )}
    >
      {filterLabel(status)}
    </span>
  )
}

function Info({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="min-w-0 rounded-md border border-border bg-background/45 px-3 py-2.5">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-xs font-medium" title={value}>
        {value}
      </p>
    </div>
  )
}

function filterLabel(value: Filter): string {
  return { all: "全部", active: "活跃", paused: "已暂停", completed: "已完成" }[value]
}

function recurrenceLabel(task: DesktopScheduledTask): string {
  return task.recurrenceFormat === "once"
    ? `一次性 · ${formatTime(Date.parse(task.recurrence))}`
    : task.recurrence.replace(/^RRULE:/, "")
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value)
}

function runStatusLabel(status: DesktopScheduledRun["status"]): string {
  return {
    queued: "等待运行",
    running: "正在运行",
    succeeded: "运行成功",
    failed: "运行失败",
    interrupted: "已中断",
    needs_attention: "需要处理",
    skipped: "已跳过",
  }[status]
}
