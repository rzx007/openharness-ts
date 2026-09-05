import { forwardRef } from "react"

import { cn } from "@renderer/lib/utils"
import type { DesktopContextUsageSnapshot } from "@shared/context-usage-types"

import {
  CONTEXT_BUCKET_COLORS,
  formatContextPercentLabel,
  nonEmptyBuckets,
} from "./context-usage-format"

export const ContextUsageRing = forwardRef<
  HTMLButtonElement,
  {
    snapshot: DesktopContextUsageSnapshot | null
    className?: string
    onClick?: () => void
  }
>(function ContextUsageRing({ snapshot, className, onClick }, ref) {
  const percentFull = snapshot?.percentFull ?? null
  const overflow = percentFull != null && percentFull > 1
  const label = formatContextPercentLabel(percentFull)
  const fill = percentFull == null ? 0 : Math.min(Math.max(percentFull, 0), 1)
  const size = 28
  const stroke = 3
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const segments = snapshot ? nonEmptyBuckets(snapshot) : []
  const total = segments.reduce((sum, bucket) => sum + bucket.tokens, 0)

  let offset = 0
  const arcs =
    percentFull != null && total > 0
      ? segments.map((bucket) => {
          const arcLength = circumference * (bucket.tokens / total) * fill
          const node = (
            <circle
              key={bucket.id}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={CONTEXT_BUCKET_COLORS[bucket.id]}
              strokeWidth={stroke}
              strokeDasharray={`${arcLength} ${circumference - arcLength}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          )
          offset += arcLength
          return node
        })
      : null

  return (
    <button
      ref={ref}
      type="button"
      aria-label={`Context ${label}`}
      title="Context usage"
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        overflow && "text-destructive hover:text-destructive",
        className
      )}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="shrink-0">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.18}
          strokeWidth={stroke}
        />
        {arcs}
      </svg>
      <span className="min-w-[2.25rem] tabular-nums">{label}</span>
    </button>
  )
})
