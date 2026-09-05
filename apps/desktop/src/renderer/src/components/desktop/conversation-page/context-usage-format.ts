import type {
  DesktopContextBucketId,
  DesktopContextUsageBucket,
  DesktopContextUsageSnapshot,
  DesktopContextUsageTipCode,
} from "@shared/context-usage-types"

/** 八个上下文桶的固定色板（顺序稳定）。 */
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

export const CONTEXT_BUCKET_LABELS_ZH: Record<DesktopContextBucketId, string> = {
  system: "系统提示",
  tools: "工具定义",
  rules: "规则",
  skills: "技能",
  mcp: "MCP 与动态工具",
  subagents: "子代理定义",
  summary: "对话摘要",
  conversation: "对话",
}

const TIP_MESSAGES_ZH: Record<DesktopContextUsageTipCode, string> = {
  near_full: "上下文接近满额，建议执行 /compact 或新开对话。",
  overflow_after_model_switch: "换模型后估算占用已超过当前窗宽，建议先压缩再继续。",
  static_tools_heavy: "工具与 MCP 定义占用了较大比例的上下文。",
  conversation_omitted: "本次快照未计入对话占用。",
  partial_sources: "部分上下文来源读取失败，快照可能不完整。",
  media_unestimated: "部分媒体无法估值，占用可能被低估。",
  no_context_window: "当前模型没有上下文窗宽元数据，无法计算百分比。",
  stale_or_rebuilt: "占用快照已重建，可能与上一份缓存不同。",
}

export function contextBucketLabelZh(id: DesktopContextBucketId, fallback?: string): string {
  return CONTEXT_BUCKET_LABELS_ZH[id] ?? fallback ?? id
}

export function contextTipMessageZh(code: string, fallback?: string): string {
  return TIP_MESSAGES_ZH[code as DesktopContextUsageTipCode] ?? fallback ?? code
}

/** 圆环旁百分比：无窗宽时不展示占位符。 */
export function formatContextPercentLabel(percentFull: number | null): string | null {
  if (percentFull == null) return null
  return `${Math.round(percentFull * 100)}%`
}

export function formatContextPercentFull(percentFull: number | null): string | null {
  if (percentFull == null) return null
  return `${Math.round(percentFull * 100)}% 已用`
}

/** 托盘列表用的 token 缩写。 */
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
    return `约 ${used} Tokens`
  }
  return `约 ${used} / ${formatContextTokensShort(snapshot.contextWindow)} Tokens`
}

export function nonEmptyBuckets(
  snapshot: DesktopContextUsageSnapshot,
): DesktopContextUsageBucket[] {
  return snapshot.buckets.filter((bucket) => bucket.tokens > 0)
}
