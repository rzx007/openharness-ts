import { Bot, RefreshCw, Search } from "lucide-react"

import { Button } from "@renderer/components/ui/button"
import { Input } from "@renderer/components/ui/input"
import { cn } from "@renderer/lib/utils"
import type { DesktopScheduledStatus } from "@shared/schedule-types"
import { scheduledFilters, type ScheduledFilter } from "./types"
import { filterTabLabel } from "./utils"

export function ScheduledHeader({
  compact,
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
  compact: boolean
  filter: ScheduledFilter
  filterCounts: Record<ScheduledFilter, number>
  search: string
  status: DesktopScheduledStatus | null
  onFilterChange: (value: ScheduledFilter) => void
  onSearchChange: (value: string) => void
  onRefresh: () => Promise<void>
  onStartConversation: () => void
  loading: boolean
}): React.JSX.Element {
  return (
    <>
      <div
        className={cn(
          "flex items-start justify-between gap-4",
          !compact && "text-sidebar-foreground"
        )}
      >
        <div className={cn("min-w-0", !compact && "w-full max-w-136")}>
          <h1
            className={cn(
              "leading-tight font-normal tracking-[-0.015em] text-foreground",
              compact ? "text-[1.25rem]" : "mt-6 text-[1.75rem]"
            )}
          >
            已安排的任务
          </h1>
          <p
            className={cn(
              "text-muted-foreground",
              compact ? "mt-0.5 text-[13px]" : "mt-2 text-[15px] leading-6"
            )}
          >
            让 ChatGPT 安排任务、设置提醒或监测更新。
          </p>
        </div>

        <div className={cn("flex shrink-0 items-center gap-3", !compact && "pt-1")}>
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

      <div className={cn("space-y-3", compact ? "mt-5" : "mt-7")}>
        <FilterTabs filter={filter} counts={filterCounts} onChange={onFilterChange} />
        <SearchBar
          value={search}
          placeholder="搜索已安排任务"
          onChange={onSearchChange}
          className="h-10 rounded-xl"
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

function FilterTabs({
  filter,
  counts,
  onChange,
}: {
  filter: ScheduledFilter
  counts: Record<ScheduledFilter, number>
  onChange: (value: ScheduledFilter) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-1" aria-label="任务筛选">
      {scheduledFilters.map((value) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          aria-pressed={filter === value}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
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
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
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
