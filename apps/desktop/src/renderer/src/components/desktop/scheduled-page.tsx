import {
  Bot,
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  Clock3,
  FolderGit2,
  History,
  Pause,
  Play,
  RefreshCw,
  Search,
  TimerReset,
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

const filters: Filter[] = ["all", "active", "paused", "completed"]
const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
})

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
  const filterCounts = useMemo(
    () => ({
      all: tasks.length,
      active: tasks.filter((task) => task.status === "active").length,
      paused: tasks.filter((task) => task.status === "paused").length,
      completed: tasks.filter((task) => task.status === "completed").length,
    }),
    [tasks]
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
      <header className="flex min-h-19 items-center gap-4 border-b border-border/80 px-6 py-3.5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-foreground text-background">
            <CalendarClock className="size-4.5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold tracking-tight">已安排</h1>
              {status?.unread ? (
                <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground">
                  {status.unread} 个结果待查看
                </span>
              ) : null}
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              管理后台 Agent 任务，跟进每一次运行
            </p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            title="刷新任务"
            aria-label="刷新任务"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCw className={cn(loading && "animate-spin")} />
          </Button>
          <Button size="sm" onClick={onStartConversation}>
            <Bot />
            在对话中安排
          </Button>
        </div>
      </header>

      {error ? (
        <div
          className="mx-6 mt-4 flex items-start gap-2 rounded-md bg-destructive/8 px-3 py-2.5 text-xs text-destructive ring-1 ring-destructive/20"
          role="alert"
        >
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-85 max-w-[38%] min-w-70 flex-col border-r border-border/80 bg-muted/15">
          <div className="space-y-3 border-b border-border/70 px-3 py-3">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索任务、项目或指令"
                aria-label="搜索任务"
                className="h-8 bg-background pl-8 text-xs"
              />
            </div>
            <div className="flex items-center gap-0.5" aria-label="任务筛选">
              {filters.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setFilter(value)}
                  aria-pressed={filter === value}
                  className={cn(
                    "flex min-w-0 items-center gap-1 rounded-md px-2 py-1.5 text-[11px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    filter === value
                      ? "bg-background font-medium text-foreground ring-1 ring-border"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  )}
                >
                  <span>{filterLabel(value)}</span>
                  <span className="text-[10px] text-muted-foreground tabular-nums">
                    {filterCounts[value]}
                  </span>
                </button>
              ))}
            </div>
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
              <div className="px-5 py-12 text-center">
                <CalendarClock className="mx-auto size-7 text-muted-foreground/45" />
                <p className="mt-3 text-sm font-medium">没有匹配的任务</p>
                <p className="mx-auto mt-1 max-w-56 text-xs leading-5 text-muted-foreground">
                  调整筛选条件，或在 Agent 对话中创建一个新任务。
                </p>
              </div>
            ) : null}
            {visibleTasks.map((task) => (
              <button
                type="button"
                key={task.id}
                onClick={() => setSelectedId(task.id)}
                aria-current={task.id === selectedId ? "true" : undefined}
                className={cn(
                  "group w-full rounded-lg px-3 py-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  task.id === selectedId
                    ? "bg-background text-foreground ring-1 ring-border"
                    : "text-muted-foreground hover:bg-muted/55 hover:text-foreground"
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                    {task.name}
                  </span>
                  <TaskStatus status={task.status} compact />
                </div>
                <p className="mt-1.5 truncate text-[11px] text-muted-foreground">
                  {recurrenceLabel(task)}
                </p>
                <div className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground/80">
                  <Clock3 className="size-3" />
                  <span>
                    {task.nextRunAt ? `下次 ${formatTime(task.nextRunAt)}` : "没有后续运行"}
                  </span>
                  {task.runCount > 0 ? (
                    <span className="ml-auto tabular-nums">已运行 {task.runCount} 次</span>
                  ) : null}
                </div>
              </button>
            ))}
          </ScrollArea>
        </aside>

        <ScrollArea
          className="min-h-0 min-w-0 flex-1"
          viewportClassName="px-6 py-7 lg:px-8"
          contentClassName="mx-auto max-w-5xl pb-10"
        >
          {selected ? (
            <>
              <div className="flex flex-wrap items-start gap-x-5 gap-y-4">
                <div className="min-w-64 flex-1">
                  <div className="flex items-center gap-2.5">
                    <h2 className="min-w-0 truncate text-xl font-semibold tracking-tight">
                      {selected.name}
                    </h2>
                    <TaskStatus status={selected.status} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span>{recurrenceLabel(selected)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{selected.timezone}</span>
                    {selected.nextRunAt ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>下次运行 {formatTime(selected.nextRunAt)}</span>
                      </>
                    ) : null}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() =>
                      void mutate("run", () => window.desktop.schedules.runNow(selected.id))
                    }
                  >
                    {busy === "run" ? <Spinner /> : <Play />}
                    立即运行
                  </Button>
                  <Button
                    variant="ghost"
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
                    size="icon-sm"
                    className="text-muted-foreground hover:text-destructive"
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
              </div>

              <dl className="mt-7 grid grid-cols-2 overflow-hidden rounded-lg bg-muted/35 ring-1 ring-border/80 lg:grid-cols-4">
                <Info
                  icon={Bot}
                  label="运行方式"
                  value={selected.destination === "chat" ? "返回关联对话" : "每次独立对话"}
                />
                <Info
                  icon={FolderGit2}
                  label="项目"
                  value={selected.projectPaths[0] ?? "关联对话项目"}
                />
                <Info
                  icon={TimerReset}
                  label="执行环境"
                  value={selected.executionMode === "worktree" ? "独立 worktree" : "本地项目"}
                />
                <Info icon={History} label="累计运行" value={`${selected.runCount} 次`} />
              </dl>

              <section className="mt-7 overflow-hidden rounded-lg bg-background ring-1 ring-border/80">
                <div className="flex items-center justify-between border-b border-border/70 bg-muted/25 px-4 py-3">
                  <h3 className="text-xs font-semibold">每次运行的指令</h3>
                  <span className="text-[10px] text-muted-foreground">发送给 Agent</span>
                </div>
                <p className="max-w-[75ch] px-4 py-4 text-[13px] leading-6 whitespace-pre-wrap text-foreground/90">
                  {selected.prompt}
                </p>
              </section>

              <section className="mt-8">
                <div className="flex items-baseline gap-2">
                  <h3 className="text-sm font-semibold">最近运行</h3>
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {runs.length} 条记录
                  </span>
                </div>
                <div className="mt-3 overflow-hidden rounded-lg bg-background ring-1 ring-border/80">
                  {runs.length === 0 ? (
                    <div className="grid min-h-36 place-items-center px-4 text-center">
                      <div>
                        <History className="mx-auto size-6 text-muted-foreground/45" />
                        <p className="mt-2 text-xs text-muted-foreground">这个任务还没有运行记录</p>
                      </div>
                    </div>
                  ) : null}
                  {runs.map((run, index) => (
                    <article
                      key={run.id}
                      className={cn(
                        "grid grid-cols-[auto_minmax(0,1fr)] gap-3 px-4 py-4 [content-visibility:auto]",
                        index > 0 && "border-t border-border/70"
                      )}
                    >
                      <RunStatusIcon status={run.status} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-medium">{runStatusLabel(run.status)}</span>
                          <time
                            className="text-muted-foreground"
                            dateTime={new Date(run.createdAt).toISOString()}
                          >
                            {formatTime(run.createdAt)}
                          </time>
                          {run.unread ? (
                            <span className="ml-auto flex items-center gap-1.5 text-[10px] font-medium text-primary">
                              <span className="size-1.5 rounded-full bg-primary" />
                              新结果
                            </span>
                          ) : null}
                        </div>
                        {run.summary || run.error ? (
                          <p
                            className={cn(
                              "mt-2 line-clamp-5 max-w-[80ch] font-mono text-[11px] leading-5 whitespace-pre-wrap",
                              run.error ? "text-destructive" : "text-muted-foreground"
                            )}
                          >
                            {run.summary ?? run.error}
                          </p>
                        ) : (
                          <p className="mt-2 text-xs text-muted-foreground">暂无运行摘要</p>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            </>
          ) : (
            <div className="grid min-h-[60vh] place-items-center text-center">
              <div>
                <Clock3 className="mx-auto size-8 text-muted-foreground/40" />
                <p className="mt-3 text-sm font-medium">选择一个已安排任务</p>
                <p className="mt-1 text-xs text-muted-foreground">查看配置、运行状态与历史结果</p>
              </div>
            </div>
          )}
        </ScrollArea>
      </div>
    </section>
  )
}

function TaskStatus({
  status,
  compact = false,
}: {
  status: DesktopScheduledTask["status"]
  compact?: boolean
}): React.JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full font-medium",
        compact ? "px-1.5 py-0.5 text-[9px]" : "px-2 py-0.5 text-[10px]",
        status === "active"
          ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400"
          : status === "paused"
            ? "bg-amber-500/12 text-amber-700 dark:text-amber-400"
            : "bg-muted text-muted-foreground"
      )}
    >
      <span className="size-1 rounded-full bg-current" />
      {filterLabel(status)}
    </span>
  )
}

function Info({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Bot
  label: string
  value: string
}): React.JSX.Element {
  return (
    <div className="min-w-0 px-4 py-3.5 not-last:border-r not-last:border-border/70 max-lg:nth-[2]:border-r-0 max-lg:nth-[n+3]:border-t">
      <dt className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <Icon className="size-3" />
        {label}
      </dt>
      <dd className="mt-1.5 truncate text-xs font-medium" title={value}>
        {value}
      </dd>
    </div>
  )
}

function RunStatusIcon({ status }: { status: DesktopScheduledRun["status"] }): React.JSX.Element {
  if (status === "succeeded") {
    return (
      <span className="grid size-6 place-items-center rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="size-3.5" />
      </span>
    )
  }
  if (status === "running" || status === "queued") {
    return (
      <span className="grid size-6 place-items-center rounded-full bg-primary/8 text-primary">
        <Spinner className="size-3.5" />
      </span>
    )
  }
  return (
    <span className="grid size-6 place-items-center rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-400">
      <CircleAlert className="size-3.5" />
    </span>
  )
}

function filterLabel(value: Filter): string {
  return { all: "全部", active: "运行中", paused: "已暂停", completed: "已完成" }[value]
}

function recurrenceLabel(task: DesktopScheduledTask): string {
  if (task.recurrenceFormat === "once") return `一次性 · ${formatTime(Date.parse(task.recurrence))}`

  const rule = Object.fromEntries(
    task.recurrence
      .replace(/^RRULE:/, "")
      .split(";")
      .map((part) => part.split("=", 2))
  )
  const hour = Number(rule.BYHOUR ?? 0)
  const minute = Number(rule.BYMINUTE ?? 0)
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`

  if (rule.FREQ === "DAILY") return `每天 ${time}`
  if (rule.FREQ === "WEEKLY") return `每周 ${time}`
  if (rule.FREQ === "MONTHLY") return `每月 ${rule.BYMONTHDAY ?? ""} 日 ${time}`.trim()
  return task.recurrence.replace(/^RRULE:/, "")
}

function formatTime(value: number): string {
  return dateTimeFormatter.format(value)
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
