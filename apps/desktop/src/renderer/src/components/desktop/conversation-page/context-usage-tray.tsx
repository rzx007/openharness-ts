import type { DesktopContextUsageSnapshot } from "@shared/context-usage-types"

import {
  CONTEXT_BUCKET_COLORS,
  contextBucketLabelZh,
  contextTipMessageZh,
  formatContextPercentFull,
  formatContextTokensShort,
  formatContextTokensSummary,
  nonEmptyBuckets,
} from "./context-usage-format"

export function ContextUsageTray({
  snapshot,
}: {
  snapshot: DesktopContextUsageSnapshot
}): React.JSX.Element {
  const visibleBuckets = nonEmptyBuckets(snapshot)
  const total = visibleBuckets.reduce((sum, bucket) => sum + bucket.tokens, 0)
  const overflow = snapshot.percentFull != null && snapshot.percentFull > 1
  const percentFullLabel = formatContextPercentFull(snapshot.percentFull)

  return (
    <div className="flex w-72 flex-col gap-3 p-1 text-sm" role="dialog" aria-label="上下文">
      <div className="px-1.5 pt-1">
        <h2 className="text-sm font-medium text-foreground">上下文</h2>
        <div className="mt-1 flex items-baseline justify-between gap-2">
          {percentFullLabel != null ? (
            <span
              className={
                overflow
                  ? "text-sm font-medium text-destructive"
                  : "text-sm font-medium text-foreground"
              }
            >
              {percentFullLabel}
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">占用明细</span>
          )}
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatContextTokensSummary(snapshot)}
          </span>
        </div>
      </div>

      <div
        className="mx-1.5 flex h-1.5 overflow-hidden rounded-full bg-muted"
        aria-hidden={visibleBuckets.length === 0}
      >
        {visibleBuckets.map((bucket) => {
          const widthPct = total > 0 ? (bucket.tokens / total) * 100 : 0
          return (
            <div
              key={bucket.id}
              title={contextBucketLabelZh(bucket.id, bucket.label)}
              style={{
                width: `${widthPct}%`,
                backgroundColor: CONTEXT_BUCKET_COLORS[bucket.id],
              }}
              className="h-full min-w-0"
            />
          )
        })}
      </div>

      <ul className="flex flex-col gap-1 px-1.5">
        {visibleBuckets.map((bucket) => (
          <li key={bucket.id} className="flex items-center gap-2 text-xs">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: CONTEXT_BUCKET_COLORS[bucket.id] }}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate text-foreground">
              {contextBucketLabelZh(bucket.id, bucket.label)}
            </span>
            <span className="tabular-nums text-muted-foreground">
              {formatContextTokensShort(bucket.tokens)}
            </span>
          </li>
        ))}
      </ul>

      {snapshot.tips.length > 0 ? (
        <ul className="flex flex-col gap-1.5 border-t border-border px-1.5 pt-2 pb-1">
          {snapshot.tips.map((tip) => (
            <li key={tip.code} className="text-xs leading-snug text-muted-foreground">
              {contextTipMessageZh(tip.code, tip.message)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
