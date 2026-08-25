import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  ArrowLeft,
  Bot,
  CalendarClock,
  CheckCircle2,
  Circle,
  CircleAlert,
  Clock3,
  FolderGit2,
  History,
  MoreHorizontal,
  Pause,
  Play,
  RefreshCw,
  Search,
  TimerReset,
  Trash2,
  X,
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
const easeOutQuint = [0.22, 1, 0.36, 1] as const
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
  const prefersReducedMotion = useReducedMotion()
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
        current && nextTasks.some((task) => task.id === current) ? current : null
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
  const hasSelection = selected !== null

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
        if (selectedId) {
          setRuns(await window.desktop.schedules.listRuns({ taskId: selectedId, limit: 30 }))
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(null)
      }
    },
    [refresh, selectedId]
  )

  return (
    <section className="flex h-full min-h-0 w-full flex-col bg-background" aria-busy={loading}>
      {error ? (
        <div
          className="mx-8 mt-5 flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/8 px-3 py-2.5 text-xs text-destructive"
          role="alert"
        >
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="flex min-h-0 w-full flex-1 overflow-hidden">
        <motion.div
          layout
          transition={{ layout: { duration: prefersReducedMotion ? 0 : 0.28, ease: easeOutQuint } }}
          style={
            hasSelection
              ? { width: "clamp(30rem, 43vw, 44rem)" }
              : {
                  marginLeft: "clamp(2rem, 18vw, 22rem)",
                  width: "min(46rem, calc(100% - 4rem))",
                }
          }
          className={cn(
            "flex min-h-0 shrink-0 flex-col bg-background",
            hasSelection && "border-r border-border/70"
          )}
        >
          <div className={cn("flex min-h-0 flex-1 flex-col", !hasSelection && "pt-14")}>
            <header className={cn("shrink-0", hasSelection ? "px-5 pt-5 pb-4" : "px-0")}>
              {!hasSelection ? (
                <OverviewHero
                  filter={filter}
                  filterCounts={filterCounts}
                  search={search}
                  status={status}
                  onFilterChange={setFilter}
                  onSearchChange={setSearch}
                  onRefresh={refresh}
                  onStartConversation={onStartConversation}
                  loading={loading}
                />
              ) : (
                <CompactHeader
                  filter={filter}
                  filterCounts={filterCounts}
                  search={search}
                  onFilterChange={setFilter}
                  onSearchChange={setSearch}
                  onRefresh={refresh}
                  loading={loading}
                />
              )}
            </header>

            <ScrollArea
              className="min-h-0 flex-1"
              viewportClassName={cn("min-h-0", hasSelection ? "px-5 pb-5" : "px-0 pb-10")}
              contentClassName={hasSelection ? "space-y-2" : "space-y-1"}
            >
              {loading ? (
                <div className="flex items-center gap-2 px-4 py-8 text-sm text-muted-foreground">
                  <Spinner className="size-4" />
                  正在加载任务…
                </div>
              ) : null}

              {!loading && visibleTasks.length === 0 ? (
                <div
                  className={cn(
                    "text-center",
                    hasSelection
                      ? "rounded-xl border border-dashed border-border/70 px-6 py-14"
                      : "px-6 py-16"
                  )}
                >
                  <CalendarClock className="mx-auto size-8 text-muted-foreground/45" />
                  <p className="mt-3 text-sm font-medium text-foreground">没有匹配的任务</p>
                  <p className="mx-auto mt-1 max-w-64 text-xs leading-5 text-muted-foreground">
                    调整筛选条件，或在 Agent 对话里新建一个任务。
                  </p>
                </div>
              ) : null}

              {visibleTasks.map((task) => {
                const active = task.id === selectedId
                return (
                  <TaskRow
                    key={task.id}
                    task={task}
                    active={active}
                    compact={hasSelection}
                    onSelect={() => setSelectedId(task.id)}
                  />
                )
              })}
            </ScrollArea>
          </div>
        </motion.div>

        <AnimatePresence initial={false}>
          {selected ? (
            <motion.section
              key={selected.id}
              initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, x: 18 }}
              animate={prefersReducedMotion ? { opacity: 1 } : { opacity: 1, x: 0 }}
              exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, x: 18 }}
              transition={{ duration: prefersReducedMotion ? 0.12 : 0.22, ease: easeOutQuint }}
              className="min-h-0 min-w-0 flex-1 bg-muted/16"
            >
              <ScrollArea
                className="h-full min-h-0"
                viewportClassName="px-8 py-6"
                contentClassName="mx-auto max-w-[1080px] pb-8"
              >
                <DetailPanel
                  task={selected}
                  runs={runs}
                  busy={busy}
                  onBack={() => setSelectedId(null)}
                  onRunNow={() =>
                    void mutate("run", () => window.desktop.schedules.runNow(selected.id))
                  }
                  onToggle={() =>
                    void mutate("toggle", () =>
                      window.desktop.schedules.update(selected.id, {
                        status: selected.status === "paused" ? "active" : "paused",
                      })
                    )
                  }
                  onDelete={() =>
                    void mutate("delete", () => window.desktop.schedules.remove(selected.id))
                  }
                />
              </ScrollArea>
            </motion.section>
          ) : null}
        </AnimatePresence>
      </div>
    </section>
  )
}

function OverviewHero({
  filter,
  filterCounts,
  search,
  status,
  onFilterChange,
  onSearchChange,
  onRefresh,
  onStartConversation,
  loading,
}: {
  filter: Filter
  filterCounts: Record<Filter, number>
  search: string
  status: DesktopScheduledStatus | null
  onFilterChange: (value: Filter) => void
  onSearchChange: (value: string) => void
  onRefresh: () => Promise<void>
  onStartConversation: () => void
  loading: boolean
}): React.JSX.Element {
  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div className="w-full max-w-[34rem]">
          <div className="inline-flex size-12 items-center justify-center rounded-xl bg-foreground text-background">
            <CalendarClock className="size-5.5" strokeWidth={1.7} />
          </div>
          <h1 className="mt-7 text-[2rem] leading-tight font-semibold tracking-[-0.025em] text-foreground">
            已安排的任务
          </h1>
          <p className="mt-2 text-[15px] leading-6 text-muted-foreground">
            让 ChatGPT 安排任务、设置提醒或监测更新。
          </p>
        </div>

        <div className="flex items-center gap-3 pt-1">
          <Button
            variant="ghost"
            size="icon-sm"
            title="刷新任务"
            aria-label="刷新任务"
            onClick={() => void onRefresh()}
            disabled={loading}
            className="size-9 rounded-full text-muted-foreground"
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </Button>
          <Button
            size="sm"
            onClick={onStartConversation}
            className="h-8 rounded-full bg-foreground px-3 text-[12px] font-medium text-background hover:bg-foreground/92"
          >
            <Bot className="size-3.5" />
            在对话中安排
          </Button>
        </div>
      </div>

      <div className="mt-7">
        <FilterTabs filter={filter} counts={filterCounts} onChange={onFilterChange} />
        <SearchBar
          value={search}
          placeholder="搜索已安排任务"
          onChange={onSearchChange}
          className="mt-3 h-10 rounded-xl"
        />
      </div>

      {status?.unread ? (
        <div className="mt-4 text-xs text-muted-foreground">
          <span className="rounded-full bg-muted px-2 py-1 font-medium text-foreground">
            {status.unread}
          </span>
          <span className="ml-2">个结果待查看</span>
        </div>
      ) : null}
    </>
  )
}

function CompactHeader({
  filter,
  filterCounts,
  search,
  onFilterChange,
  onSearchChange,
  onRefresh,
  loading,
}: {
  filter: Filter
  filterCounts: Record<Filter, number>
  search: string
  onFilterChange: (value: Filter) => void
  onSearchChange: (value: string) => void
  onRefresh: () => Promise<void>
  loading: boolean
}): React.JSX.Element {
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span className="inline-flex size-10 items-center justify-center rounded-xl bg-foreground text-background">
              <CalendarClock className="size-4.5" />
            </span>
            <div className="min-w-0">
              <h1 className="text-[18px] font-semibold tracking-[-0.02em] text-foreground">
                已安排
              </h1>
              <p className="mt-0.5 text-[13px] text-muted-foreground">
                管理后台 Agent 任务，跟进每一次运行
              </p>
            </div>
          </div>
        </div>

        <Button
          variant="ghost"
          size="icon-sm"
          title="刷新任务"
          aria-label="刷新任务"
          onClick={() => void onRefresh()}
          disabled={loading}
          className="size-9 rounded-full text-muted-foreground"
        >
          <RefreshCw className={cn("size-4", loading && "animate-spin")} />
        </Button>
      </div>

      <div className="mt-5">
        <FilterTabs filter={filter} counts={filterCounts} onChange={onFilterChange} compact />
        <SearchBar
          value={search}
          placeholder="搜索已安排任务"
          onChange={onSearchChange}
          className="mt-3 h-10 rounded-xl"
        />
      </div>
    </>
  )
}

function DetailPanel({
  task,
  runs,
  busy,
  onBack,
  onRunNow,
  onToggle,
  onDelete,
}: {
  task: DesktopScheduledTask
  runs: DesktopScheduledRun[]
  busy: string | null
  onBack: () => void
  onRunNow: () => void
  onToggle: () => void
  onDelete: () => void
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-start justify-between gap-4 pb-5">
        <div className="min-w-0">
          <div className="flex items-start gap-3">
            <h2 className="min-w-0 text-[1.75rem] leading-[1.15] font-semibold tracking-[-0.03em] text-foreground">
              {task.name}
            </h2>
            <StatusBadge status={task.status} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
            <span>{recurrenceShortLabel(task)}</span>
            <span aria-hidden="true">·</span>
            <span>{task.timezone}</span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onBack} className="rounded-lg px-2.5 text-xs">
            <ArrowLeft className="size-3.5" />
            返回总览
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onBack} className="rounded-lg">
            <X className="size-4" />
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl bg-background shadow-[0_18px_48px_rgba(15,23,42,0.09)]">
        <div className="flex min-h-16 items-center justify-between gap-3 border-b border-border/70 px-5 py-3.5">
          <div className="flex items-center gap-3">
            <StatusBadge status={task.status} />
            <span className="text-[15px] font-semibold text-foreground">
              {statusLabel(task.status)}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onRunNow} disabled={busy !== null}>
              {busy === "run" ? <Spinner /> : <Play className="size-3.5" />}
              立即运行
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onToggle}
              disabled={busy !== null || task.status === "completed"}
            >
              {task.status === "paused" ? (
                <Play className="size-3.5" />
              ) : (
                <Pause className="size-3.5" />
              )}
              {task.status === "paused" ? "继续" : "暂停"}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onDelete}
              disabled={busy !== null}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>

        <div className="grid gap-4 p-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="space-y-4">
            <DetailCard title="每次运行的指令" meta="发送给 Agent" className="min-h-[210px]">
              <div className="max-w-[72ch] text-[13px] leading-6 whitespace-pre-wrap text-foreground/92">
                {task.prompt}
              </div>
            </DetailCard>

            <DetailCard title="最近运行" meta={`${runs.length} 条记录`} className="min-h-[220px]">
              {runs.length === 0 ? (
                <div className="grid min-h-[160px] place-items-center text-center">
                  <div>
                    <History className="mx-auto size-6 text-muted-foreground/45" />
                    <p className="mt-2 text-xs text-muted-foreground">这个任务还没有运行记录</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {runs.map((run) => (
                    <article key={run.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-3">
                      <RunStatusIcon status={run.status} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-medium text-foreground">
                            {runStatusLabel(run.status)}
                          </span>
                          <time
                            className="text-muted-foreground"
                            dateTime={new Date(run.createdAt).toISOString()}
                          >
                            {formatTime(run.createdAt)}
                          </time>
                        </div>
                        <p
                          className={cn(
                            "mt-2 line-clamp-5 max-w-[78ch] text-[12px] leading-5 whitespace-pre-wrap",
                            run.error ? "text-destructive" : "font-mono text-muted-foreground"
                          )}
                        >
                          {run.summary ?? run.error ?? "暂无运行摘要"}
                        </p>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </DetailCard>
          </div>

          <div className="space-y-4">
            <InfoBlock
              title="详情"
              items={[
                {
                  icon: Bot,
                  label: "运行于",
                  value: task.destination === "chat" ? "现有聊天" : "每次独立对话",
                },
                {
                  icon: FolderGit2,
                  label: "聊天",
                  value: task.projectPaths[0] ?? "关联对话项目",
                },
                {
                  icon: TimerReset,
                  label: "执行环境",
                  value: task.executionMode === "worktree" ? "独立 worktree" : "本地项目",
                },
              ]}
            />

            <InfoBlock
              title="频率"
              items={[
                { icon: History, label: "重复", value: recurrenceFrequency(task) },
                { icon: Clock3, label: "时间", value: recurrenceTime(task) ?? "按规则执行" },
                {
                  icon: CalendarClock,
                  label: "通知",
                  value: task.nextRunAt ? `下次 ${formatTime(task.nextRunAt)}` : "暂无",
                },
              ]}
            />

            <section className="overflow-hidden rounded-xl border border-border/70 bg-background">
              <div className="border-b border-border/70 px-4 py-3.5">
                <h3 className="text-[14px] font-semibold text-foreground">概览</h3>
              </div>
              <div className="grid grid-cols-2 gap-3 p-4 xl:grid-cols-1">
                <MetricCard label="累计运行" value={`${task.runCount}`} meta="次" />
                <MetricCard
                  label="当前状态"
                  value={statusBlockLabel(task.status)}
                  meta={task.timezone}
                />
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}

function TaskRow({
  task,
  active,
  compact,
  onSelect,
}: {
  task: DesktopScheduledTask
  active: boolean
  compact: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={cn(
        "group w-full rounded-xl border border-transparent text-left transition-[background-color,border-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        active
          ? "border-border/60 bg-background shadow-[0_5px_8px_rgba(15,23,42,0.07)]"
          : compact
            ? "hover:bg-muted/45"
            : "hover:bg-muted/35"
      )}
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

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div
                className={cn(
                  "truncate font-medium text-foreground",
                  compact ? "text-[14px]" : "text-[15px]"
                )}
              >
                {task.name}
              </div>
              <div
                className={cn(
                  "mt-1 text-muted-foreground",
                  compact ? "text-[12px]" : "text-[13px]"
                )}
              >
                {recurrenceShortLabel(task)}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-3">
              <StatusBadge status={task.status} compact />
              {compact && active ? (
                <MoreHorizontal className="size-4 text-muted-foreground/65" />
              ) : null}
            </div>
          </div>

          <div className="mt-2.5 flex items-center justify-between gap-4 text-[12px] text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <Clock3 className="size-3.5" />
              <span>{task.nextRunAt ? formatNextRunLabel(task.nextRunAt) : "没有后续运行"}</span>
            </div>
            <span className="shrink-0">
              {task.runCount > 0 ? `已运行 ${task.runCount} 次` : ""}
            </span>
          </div>
        </div>
      </div>
    </button>
  )
}

function FilterTabs({
  filter,
  counts,
  onChange,
  compact = false,
}: {
  filter: Filter
  counts: Record<Filter, number>
  onChange: (value: Filter) => void
  compact?: boolean
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-1" aria-label="任务筛选">
      {filters.map((value) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          aria-pressed={filter === value}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            compact ? "px-2.5 py-1.5 text-[12px]" : "px-2.5 py-1.5 text-[13px]",
            filter === value
              ? "bg-muted font-medium text-foreground"
              : "text-muted-foreground hover:bg-muted/55 hover:text-foreground"
          )}
        >
          <span>{filterTabLabel(value)}</span>
          <span className="text-[11px] text-muted-foreground tabular-nums">{counts[value]}</span>
        </button>
      ))}
    </div>
  )
}

function SearchBar({
  value,
  placeholder,
  onChange,
  className,
}: {
  value: string
  placeholder: string
  onChange: (value: string) => void
  className?: string
}): React.JSX.Element {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label="搜索任务"
        className={cn(
          "border-border/70 bg-background pl-10 text-[13px] shadow-none placeholder:text-muted-foreground",
          className
        )}
      />
    </div>
  )
}

function DetailCard({
  title,
  meta,
  className,
  children,
}: {
  title: string
  meta?: string
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section
      className={cn("overflow-hidden rounded-xl border border-border/70 bg-background", className)}
    >
      <div className="flex items-center justify-between border-b border-border/70 px-4 py-3.5">
        <h3 className="text-[14px] font-semibold text-foreground">{title}</h3>
        {meta ? <span className="text-[12px] text-muted-foreground">{meta}</span> : null}
      </div>
      <div className="px-4 py-4">{children}</div>
    </section>
  )
}

function InfoBlock({
  title,
  items,
}: {
  title: string
  items: Array<{
    icon: typeof Bot
    label: string
    value: string
  }>
}): React.JSX.Element {
  return (
    <section className="overflow-hidden rounded-xl border border-border/70 bg-background">
      <div className="border-b border-border/70 px-4 py-3.5">
        <h3 className="text-[14px] font-semibold text-foreground">{title}</h3>
      </div>
      <dl>
        {items.map(({ icon: Icon, label, value }) => (
          <div
            key={label}
            className="grid grid-cols-[20px_minmax(0,1fr)] items-start gap-x-3 gap-y-1 border-b border-border/70 px-4 py-3.5 last:border-b-0"
          >
            <Icon className="mt-0.5 size-4 text-muted-foreground/75" />
            <div className="min-w-0">
              <dt className="text-[12px] text-muted-foreground">{label}</dt>
              <dd className="mt-1 truncate text-[14px] font-medium text-foreground" title={value}>
                {value}
              </dd>
            </div>
          </div>
        ))}
      </dl>
    </section>
  )
}

function MetricCard({
  label,
  value,
  meta,
}: {
  label: string
  value: string
  meta?: string
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-border/70 bg-muted/18 px-4 py-4">
      <div className="text-[12px] text-muted-foreground">{label}</div>
      <div className="mt-3 flex items-end gap-2">
        <span className="text-[1.5rem] leading-none font-semibold tracking-[-0.03em] text-foreground">
          {value}
        </span>
        {meta ? <span className="pb-1 text-[12px] text-muted-foreground">{meta}</span> : null}
      </div>
    </div>
  )
}

function StatusBadge({
  status,
  compact = false,
}: {
  status: DesktopScheduledTask["status"]
  compact?: boolean
}): React.JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-muted-foreground",
        compact ? "text-[10px]" : "text-[11px]"
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {statusLabel(status)}
    </span>
  )
}

function RunStatusIcon({ status }: { status: DesktopScheduledRun["status"] }): React.JSX.Element {
  if (status === "succeeded") {
    return (
      <span className="grid size-6 place-items-center rounded-full bg-emerald-500/10 text-emerald-600">
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
    <span className="grid size-6 place-items-center rounded-full bg-amber-500/10 text-amber-600">
      <CircleAlert className="size-3.5" />
    </span>
  )
}

function filterTabLabel(value: Filter): string {
  return { all: "全部", active: "活跃", paused: "已暂停", completed: "已完成" }[value]
}

function statusLabel(value: DesktopScheduledTask["status"]): string {
  return { active: "活跃", paused: "已暂停", completed: "已完成" }[value]
}

function statusBlockLabel(value: DesktopScheduledTask["status"]): string {
  return { active: "活跃", paused: "暂停", completed: "完成" }[value]
}

function recurrenceShortLabel(task: DesktopScheduledTask): string {
  if (task.recurrenceFormat === "once") return formatTime(Date.parse(task.recurrence))

  const rule = parseRecurrenceRule(task)
  const time = formatRuleTime(rule)

  if (rule.FREQ === "DAILY") return `每天 ${time}`
  if (rule.FREQ === "WEEKLY") return `每周 ${time}`
  if (rule.FREQ === "MONTHLY") return `每月 ${rule.BYMONTHDAY ?? ""} 日 ${time}`.trim()
  return task.recurrence.replace(/^RRULE:/, "")
}

function recurrenceFrequency(task: DesktopScheduledTask): string {
  if (task.recurrenceFormat === "once") return "一次"
  const rule = parseRecurrenceRule(task)
  return (
    {
      DAILY: "每天",
      WEEKLY: "每周",
      MONTHLY: "每月",
    }[rule.FREQ ?? ""] ?? "自定义规则"
  )
}

function recurrenceTime(task: DesktopScheduledTask): string | null {
  if (task.recurrenceFormat === "once") return formatTime(Date.parse(task.recurrence))
  return formatRuleTime(parseRecurrenceRule(task))
}

function parseRecurrenceRule(task: DesktopScheduledTask): Record<string, string> {
  return Object.fromEntries(
    task.recurrence
      .replace(/^RRULE:/, "")
      .split(";")
      .map((part) => part.split("=", 2))
  )
}

function formatRuleTime(rule: Record<string, string>): string {
  const hour = Number(rule.BYHOUR ?? 0)
  const minute = Number(rule.BYMINUTE ?? 0)
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
}

function formatTime(value: number): string {
  return dateTimeFormatter.format(value)
}

function formatNextRunLabel(value: number): string {
  return `下次 ${formatTime(value)}`
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
