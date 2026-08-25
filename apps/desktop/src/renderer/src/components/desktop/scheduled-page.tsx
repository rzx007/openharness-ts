import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  Archive,
  Bot,
  CalendarClock,
  ChevronDown,
  Circle,
  CircleAlert,
  Clock3,
  ExternalLink,
  History,
  MoreHorizontal,
  Pause,
  Play,
  RefreshCw,
  Search,
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
  onOpenConversation,
}: {
  onStartConversation: () => void
  onOpenConversation: (sessionId?: string) => void
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

      <div
        className={cn(
          "flex min-h-0 w-full flex-1 overflow-hidden",
          !hasSelection && "justify-center px-6"
        )}
      >
        <motion.div
          layout
          transition={{ layout: { duration: prefersReducedMotion ? 0 : 0.28, ease: easeOutQuint } }}
          style={hasSelection ? { width: "clamp(30rem, 43vw, 44rem)" } : undefined}
          className={cn(
            "flex min-h-0 shrink-0 flex-col bg-background",
            hasSelection ? "border-r border-border/70" : "w-full max-w-[46rem]"
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
              className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
            >
              <ScrollArea
                className="min-h-0 flex-1"
                viewportClassName="px-5 pt-4 pb-8"
                contentClassName="pb-4"
              >
                <DetailPanel
                  task={selected}
                  runs={runs}
                  busy={busy}
                  onBack={() => setSelectedId(null)}
                  onToggle={() =>
                    void mutate("toggle", () =>
                      window.desktop.schedules.update(selected.id, {
                        status: selected.status === "paused" ? "active" : "paused",
                      })
                    )
                  }
                />
              </ScrollArea>
              <div className="flex h-14 shrink-0 items-center justify-end border-t border-border/70 bg-background px-5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onOpenConversation(selected.sessionId)}
                  className="h-8 rounded-lg px-3 text-[12px]"
                >
                  打开聊天
                  <ExternalLink className="size-3.5" />
                </Button>
              </div>
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
            <CalendarClock className="size-[22px]" strokeWidth={1.8} aria-hidden="true" />
          </div>
          <h1 className="mt-6 text-[1.75rem] leading-tight font-medium tracking-[-0.015em] text-foreground">
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
              <CalendarClock className="size-[18px]" aria-hidden="true" />
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
  onToggle,
}: {
  task: DesktopScheduledTask
  runs: DesktopScheduledRun[]
  busy: string | null
  onBack: () => void
  onToggle: () => void
}): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[860px]">
      <div className="flex items-center justify-between gap-4">
        <span className="text-[13px] font-medium text-blue-600 dark:text-blue-400">
          {statusLabel(task.status)}
        </span>
        <div className="flex items-center gap-1 text-muted-foreground">
          <span className="grid size-8 place-items-center" aria-hidden="true">
            <MoreHorizontal className="size-4" />
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onToggle}
            disabled={busy !== null || task.status === "completed"}
            title={task.status === "paused" ? "继续任务" : "暂停任务"}
            aria-label={task.status === "paused" ? "继续任务" : "暂停任务"}
            className="size-8 rounded-lg text-muted-foreground"
          >
            {busy === "toggle" ? (
              <Spinner className="size-3.5" />
            ) : task.status === "paused" ? (
              <Play className="size-3.5" />
            ) : (
              <Pause className="size-3.5" />
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
        className="mt-7 h-[258px] rounded-2xl border border-border/70 bg-muted/10"
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
          { label: "聊天", value: task.name },
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
            <dd className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-foreground">
              <span className="truncate">{item.value}</span>
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            </dd>
          </div>
        ))}
      </dl>
    </section>
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

function filterTabLabel(value: Filter): string {
  return { all: "全部", active: "活跃", paused: "已暂停", completed: "已完成" }[value]
}

function statusLabel(value: DesktopScheduledTask["status"]): string {
  return { active: "活跃", paused: "已暂停", completed: "已完成" }[value]
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

function projectLabel(task: DesktopScheduledTask): string {
  const path = task.projectPaths[0]
  return path?.split(/[\\/]/).filter(Boolean).at(-1) ?? "关联项目"
}

function formatRunAge(createdAt: number): string {
  const days = Math.floor((Date.now() - createdAt) / 86_400_000)
  if (days <= 0) return "今天"
  return `${days} 天`
}
