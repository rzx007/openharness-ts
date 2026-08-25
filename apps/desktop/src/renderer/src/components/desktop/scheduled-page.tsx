import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react"
import {
  ArrowLeft,
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
const layoutTransition = {
  layout: {
    duration: 0.22,
    ease: easeOutQuint,
  },
}
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
      {error ? (
        <div
          className="mx-6 mt-4 flex items-start gap-2 rounded-md bg-destructive/8 px-3 py-2.5 text-xs text-destructive ring-1 ring-destructive/20"
          role="alert"
        >
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <LayoutGroup id="scheduled-page">
        <motion.div
          layout
          transition={layoutTransition}
          className={cn(
            "flex min-h-0 flex-1",
            hasSelection ? "gap-0" : "justify-center px-6 pt-7 pb-8 lg:px-10 lg:pt-10 lg:pb-10"
          )}
        >
          <motion.aside
            layout
            transition={layoutTransition}
            className={cn(
              "flex min-h-0 flex-col",
              hasSelection
                ? "w-[min(42rem,44%)] max-w-[42rem] min-w-[23rem] border-r border-border/80 bg-muted/12"
                : "w-full max-w-4xl"
            )}
          >
            <motion.div
              layout
              transition={layoutTransition}
              className={cn(
                "border-border/70",
                hasSelection ? "border-b px-5 pt-4 pb-3" : "px-2 pt-2 pb-4 lg:px-3 lg:pt-4 lg:pb-5"
              )}
            >
              <div className="flex items-start gap-4">
                <motion.div layout transition={layoutTransition} className="min-w-0 flex-1">
                  {!hasSelection ? (
                    <>
                      <div className="inline-flex size-11 items-center justify-center rounded-2xl bg-foreground text-background shadow-sm">
                        <CalendarClock className="size-5" />
                      </div>
                      <h1 className="mt-5 text-[2rem] leading-tight font-semibold tracking-[-0.025em] text-foreground">
                        已安排的任务
                      </h1>
                      <p className="mt-2 max-w-[42rem] text-sm leading-6 text-muted-foreground">
                        让 ChatGPT 安排任务、设置提醒或监测更新。
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="flex items-center gap-2.5">
                        <span className="inline-flex size-8 items-center justify-center rounded-xl bg-foreground text-background">
                          <CalendarClock className="size-4" />
                        </span>
                        <div className="min-w-0">
                          <h1 className="text-base font-semibold tracking-tight text-foreground">
                            已安排
                          </h1>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            管理后台 Agent 任务，跟进每一次运行
                          </p>
                        </div>
                      </div>
                    </>
                  )}
                </motion.div>

                <div className="flex shrink-0 items-center gap-2">
                  {status?.unread ? (
                    <span className="rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary">
                      {status.unread} 个结果待查看
                    </span>
                  ) : null}
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
                  {!hasSelection ? (
                    <Button size="sm" onClick={onStartConversation}>
                      <Bot />
                      在对话中安排
                    </Button>
                  ) : null}
                </div>
              </div>

              <motion.div
                layout
                transition={layoutTransition}
                className={cn("space-y-3", hasSelection ? "mt-4" : "mt-7")}
              >
                <div className="flex items-center gap-1" aria-label="任务筛选">
                  {filters.map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setFilter(value)}
                      aria-pressed={filter === value}
                      className={cn(
                        "flex min-w-0 items-center gap-1 rounded-full px-3 py-1.5 text-[12px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                        filter === value
                          ? "bg-muted font-medium text-foreground"
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

                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="搜索已安排任务"
                    aria-label="搜索任务"
                    className={cn(
                      "bg-background/90 pl-9",
                      hasSelection ? "h-8 text-xs" : "h-10 rounded-2xl text-sm"
                    )}
                  />
                </div>
              </motion.div>
            </motion.div>

            <ScrollArea
              className="min-h-0 flex-1"
              viewportClassName={cn("min-h-0", hasSelection ? "px-3 py-3" : "px-2 py-2")}
              contentClassName={cn("space-y-2", !hasSelection && "pb-8")}
            >
              {loading ? (
                <div className="flex items-center gap-2 px-3 py-6 text-xs text-muted-foreground">
                  <Spinner className="size-4" />
                  正在加载任务…
                </div>
              ) : null}

              {!loading && visibleTasks.length === 0 ? (
                <div
                  className={cn(
                    "text-center",
                    hasSelection
                      ? "rounded-2xl border border-dashed border-border/70 bg-background/60 px-5 py-12"
                      : "px-5 py-14"
                  )}
                >
                  <CalendarClock className="mx-auto size-7 text-muted-foreground/45" />
                  <p className="mt-3 text-sm font-medium">没有匹配的任务</p>
                  <p className="mx-auto mt-1 max-w-56 text-xs leading-5 text-muted-foreground">
                    调整筛选条件，或在 Agent 对话中创建一个新任务。
                  </p>
                </div>
              ) : null}

              {visibleTasks.map((task, index) => {
                const active = task.id === selectedId
                return (
                  <motion.div
                    key={task.id}
                    layout
                    transition={layoutTransition}
                    initial={
                      prefersReducedMotion ? false : { opacity: 0, y: 10, filter: "blur(8px)" }
                    }
                    animate={
                      prefersReducedMotion
                        ? { opacity: 1 }
                        : { opacity: 1, y: 0, filter: "blur(0px)" }
                    }
                    className="relative"
                    style={{ "--i": index } as React.CSSProperties}
                  >
                    {active ? (
                      <motion.div
                        layoutId="scheduled-active-card"
                        transition={{
                          type: "spring",
                          stiffness: 360,
                          damping: 34,
                          mass: 0.85,
                        }}
                        className={cn(
                          "absolute inset-0 rounded-2xl border border-border/80 bg-background shadow-[0_1px_0_rgba(255,255,255,0.04),0_18px_42px_rgba(0,0,0,0.16)]",
                          hasSelection ? "rounded-xl" : "rounded-2xl"
                        )}
                      />
                    ) : null}

                    <button
                      type="button"
                      onClick={() => setSelectedId(task.id)}
                      aria-current={active ? "true" : undefined}
                      className={cn(
                        "group relative z-10 w-full text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                        hasSelection ? "rounded-xl px-3 py-3" : "rounded-2xl px-4 py-4.5",
                        active
                          ? "text-foreground"
                          : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <div
                          className={cn(
                            "mt-0.5 shrink-0 rounded-full border transition-colors",
                            active
                              ? "border-foreground/55 bg-foreground/10"
                              : "border-muted-foreground/35 bg-transparent group-hover:border-foreground/40"
                          )}
                        >
                          <div
                            className={cn(
                              "m-1 size-2 rounded-full transition-colors",
                              active ? "bg-foreground" : "bg-transparent"
                            )}
                          />
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <motion.span
                              layoutId={active ? `scheduled-task-title-${task.id}` : undefined}
                              className={cn(
                                "min-w-0 flex-1 truncate font-medium text-foreground",
                                hasSelection ? "text-[13px]" : "text-[15px]"
                              )}
                            >
                              {task.name}
                            </motion.span>
                            <TaskStatus
                              status={task.status}
                              compact={hasSelection}
                              active={active}
                            />
                          </div>

                          <motion.p
                            layoutId={active ? `scheduled-task-subtitle-${task.id}` : undefined}
                            className={cn(
                              "mt-1 truncate text-muted-foreground",
                              hasSelection ? "text-[11px]" : "text-[12px]"
                            )}
                          >
                            {recurrenceLabel(task)}
                          </motion.p>

                          <div
                            className={cn(
                              "mt-2 flex items-center gap-1.5 text-muted-foreground/82",
                              hasSelection ? "text-[10px]" : "text-[11px]"
                            )}
                          >
                            <Clock3 className="size-3" />
                            <span>
                              {task.nextRunAt
                                ? `下次 ${formatTime(task.nextRunAt)}`
                                : "没有后续运行"}
                            </span>
                            {task.runCount > 0 ? (
                              <span className="ml-auto tabular-nums">
                                已运行 {task.runCount} 次
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </button>
                  </motion.div>
                )
              })}
            </ScrollArea>
          </motion.aside>

          <AnimatePresence initial={false}>
            {selected ? (
              <motion.section
                key={selected.id}
                layout
                initial={
                  prefersReducedMotion
                    ? { opacity: 1 }
                    : { opacity: 0, x: 28, filter: "blur(10px)" }
                }
                animate={
                  prefersReducedMotion ? { opacity: 1 } : { opacity: 1, x: 0, filter: "blur(0px)" }
                }
                exit={
                  prefersReducedMotion ? { opacity: 0 } : { opacity: 0, x: 18, filter: "blur(6px)" }
                }
                transition={{
                  layout: layoutTransition.layout,
                  duration: prefersReducedMotion ? 0.12 : 0.24,
                  ease: easeOutQuint,
                }}
                className="min-h-0 min-w-0 flex-1"
              >
                <ScrollArea
                  className="h-full min-h-0"
                  viewportClassName="px-6 py-5 lg:px-8 lg:py-6"
                  contentClassName="mx-auto flex max-w-5xl flex-col gap-6 pb-8"
                >
                  <motion.div
                    layout
                    transition={layoutTransition}
                    className="flex items-start gap-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2.5">
                        <motion.h2
                          layoutId={`scheduled-task-title-${selected.id}`}
                          className="min-w-0 truncate text-[1.7rem] leading-tight font-semibold tracking-[-0.025em] text-foreground"
                        >
                          {selected.name}
                        </motion.h2>
                        <TaskStatus status={selected.status} active />
                      </div>
                      <motion.div
                        layoutId={`scheduled-task-subtitle-${selected.id}`}
                        className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
                      >
                        <span>{recurrenceLabel(selected)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{selected.timezone}</span>
                        {selected.nextRunAt ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>下次运行 {formatTime(selected.nextRunAt)}</span>
                          </>
                        ) : null}
                      </motion.div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button variant="ghost" size="sm" onClick={() => setSelectedId(null)}>
                        <ArrowLeft />
                        返回总览
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="关闭详情"
                        aria-label="关闭详情"
                        onClick={() => setSelectedId(null)}
                      >
                        <X />
                      </Button>
                    </div>
                  </motion.div>

                  <motion.section
                    layout
                    transition={layoutTransition}
                    className="overflow-hidden rounded-3xl border border-border/70 bg-card/92 shadow-[0_1px_0_rgba(255,255,255,0.05),0_26px_54px_rgba(0,0,0,0.16)]"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-5 py-4">
                      <div className="flex items-center gap-2.5">
                        <TaskStatus status={selected.status} />
                        <span className="text-sm font-medium text-foreground">
                          {selected.status === "active" ? "活跃" : filterLabel(selected.status)}
                        </span>
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
                            void mutate("delete", () =>
                              window.desktop.schedules.remove(selected.id)
                            )
                          }
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </div>

                    <div className="grid gap-6 px-5 py-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(18rem,0.7fr)]">
                      <div className="space-y-6">
                        <section className="overflow-hidden rounded-2xl bg-muted/30 ring-1 ring-border/70">
                          <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
                            <h3 className="text-xs font-semibold text-foreground">
                              每次运行的指令
                            </h3>
                            <span className="text-[10px] text-muted-foreground">发送给 Agent</span>
                          </div>
                          <p className="max-w-[75ch] px-4 py-4 text-[13px] leading-6 whitespace-pre-wrap text-foreground/92">
                            {selected.prompt}
                          </p>
                        </section>

                        <section className="overflow-hidden rounded-2xl bg-muted/18 ring-1 ring-border/70">
                          <div className="flex items-baseline justify-between border-b border-border/70 px-4 py-3">
                            <div className="flex items-baseline gap-2">
                              <h3 className="text-sm font-semibold text-foreground">最近运行</h3>
                              <span className="text-[11px] text-muted-foreground tabular-nums">
                                {runs.length} 条记录
                              </span>
                            </div>
                          </div>

                          {runs.length === 0 ? (
                            <div className="grid min-h-36 place-items-center px-4 text-center">
                              <div>
                                <History className="mx-auto size-6 text-muted-foreground/45" />
                                <p className="mt-2 text-xs text-muted-foreground">
                                  这个任务还没有运行记录
                                </p>
                              </div>
                            </div>
                          ) : (
                            <div>
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
                                      <span className="font-medium">
                                        {runStatusLabel(run.status)}
                                      </span>
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
                                      <p className="mt-2 text-xs text-muted-foreground">
                                        暂无运行摘要
                                      </p>
                                    )}
                                  </div>
                                </article>
                              ))}
                            </div>
                          )}
                        </section>
                      </div>

                      <div className="space-y-4">
                        <section className="overflow-hidden rounded-2xl bg-muted/22 ring-1 ring-border/70">
                          <div className="border-b border-border/70 px-4 py-3">
                            <h3 className="text-xs font-semibold text-foreground">详情</h3>
                          </div>
                          <dl>
                            <Info
                              icon={Bot}
                              label="运行于"
                              value={selected.destination === "chat" ? "现有聊天" : "每次独立对话"}
                            />
                            <Info
                              icon={FolderGit2}
                              label="聊天"
                              value={selected.projectPaths[0] ?? "关联对话项目"}
                            />
                            <Info
                              icon={TimerReset}
                              label="执行环境"
                              value={
                                selected.executionMode === "worktree" ? "独立 worktree" : "本地项目"
                              }
                            />
                          </dl>
                        </section>

                        <section className="overflow-hidden rounded-2xl bg-muted/22 ring-1 ring-border/70">
                          <div className="border-b border-border/70 px-4 py-3">
                            <h3 className="text-xs font-semibold text-foreground">频率</h3>
                          </div>
                          <dl>
                            <Info
                              icon={History}
                              label="重复"
                              value={recurrenceFrequency(selected)}
                            />
                            <Info
                              icon={Clock3}
                              label="时间"
                              value={recurrenceTime(selected) ?? "按规则执行"}
                            />
                            <Info
                              icon={CalendarClock}
                              label="通知"
                              value={
                                selected.nextRunAt
                                  ? `下次 ${formatTime(selected.nextRunAt)}`
                                  : "暂无"
                              }
                            />
                          </dl>
                        </section>

                        <section className="overflow-hidden rounded-2xl bg-muted/18 ring-1 ring-border/70">
                          <div className="border-b border-border/70 px-4 py-3">
                            <h3 className="text-xs font-semibold text-foreground">概览</h3>
                          </div>
                          <div className="grid gap-3 px-4 py-4 sm:grid-cols-2">
                            <Metric label="累计运行" value={`${selected.runCount}`} meta="次" />
                            <Metric
                              label="当前状态"
                              value={filterLabel(selected.status)}
                              meta={selected.timezone}
                            />
                          </div>
                        </section>
                      </div>
                    </div>
                  </motion.section>
                </ScrollArea>
              </motion.section>
            ) : null}
          </AnimatePresence>
        </motion.div>
      </LayoutGroup>
    </section>
  )
}

function TaskStatus({
  status,
  compact = false,
  active = false,
}: {
  status: DesktopScheduledTask["status"]
  compact?: boolean
  active?: boolean
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
            : "bg-muted text-muted-foreground",
        active && "ring-1 ring-current/8"
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
    <div className="flex items-start gap-3 px-4 py-3.5 not-last:border-b not-last:border-border/70">
      <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-background/70 text-muted-foreground">
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <dt className="text-[11px] text-muted-foreground">{label}</dt>
        <dd className="mt-1 truncate text-[13px] font-medium text-foreground" title={value}>
          {value}
        </dd>
      </div>
    </div>
  )
}

function Metric({
  label,
  value,
  meta,
}: {
  label: string
  value: string
  meta?: string
}): React.JSX.Element {
  return (
    <div className="rounded-2xl bg-background/70 px-4 py-3 ring-1 ring-border/60">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="text-xl font-semibold tracking-tight text-foreground">{value}</span>
        {meta ? <span className="text-[11px] text-muted-foreground">{meta}</span> : null}
      </div>
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
  return { all: "全部", active: "活跃", paused: "已暂停", completed: "已完成" }[value]
}

function recurrenceLabel(task: DesktopScheduledTask): string {
  if (task.recurrenceFormat === "once") return `一次性 · ${formatTime(Date.parse(task.recurrence))}`

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
  if (task.recurrenceFormat === "once") {
    return formatTime(Date.parse(task.recurrence))
  }
  const rule = parseRecurrenceRule(task)
  return formatRuleTime(rule)
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
