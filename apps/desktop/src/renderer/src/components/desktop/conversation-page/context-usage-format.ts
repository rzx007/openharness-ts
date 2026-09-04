import type {
  DesktopContextBucketId,
  DesktopContextUsageSnapshot,
} from "@shared/context-usage-types"

/** Fixed palette for the 8 context buckets (stable order). */
export const CONTEXT_BUCKET_COLORS: Record<DesktopContextBucketId, string> = {
  system: "#5B8DEF",
  tools: "#7C6AF2",
  rules: "#2BB3A3",
  skills: "#E2A03B",
  mcp: "#D977C2",
  subagents: "#6B7280",
  summary: "#34A853",
  conversation: "#EA4335",
}

export function formatContextPercentLabel(percentFull: number | null): string {
  if (percentFull == null) return "—"
  return `${Math.round(percentFull * 100)}%`
}

export function formatContextPercentFull(percentFull: number | null): string {
  if (percentFull == null) return "—"
  return `${Math.round(percentFull * 100)}% Full`
}

/** Token count with K abbreviation for tray list alignment. */
export function formatContextTokensShort(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  const k = tokens / 1000
  if (k >= 100) return `${Math.round(k)}K`
  const rounded = Math.round(k * 10) / 10
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}K`
}

export function formatContextTokensSummary(snapshot: DesktopContextUsageSnapshot): string {
  const used = formatContextTokensShort(snapshot.estimatedInputTokens)
  if (snapshot.contextWindow == null) {
    return `~${used} Tokens`
  }
  return `~${used} / ${formatContextTokensShort(snapshot.contextWindow)} Tokens`
}

export function nonEmptyBuckets(snapshot: DesktopContextUsageSnapshot) {
  return snapshot.buckets.filter((bucket) => bucket.tokens > 0)
}
