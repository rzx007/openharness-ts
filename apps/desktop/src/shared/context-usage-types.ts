export type DesktopContextBucketId =
  | "system"
  | "tools"
  | "rules"
  | "skills"
  | "mcp"
  | "subagents"
  | "summary"
  | "conversation"

export interface DesktopContextUsageBucket {
  id: DesktopContextBucketId
  label: string
  tokens: number
}

export type DesktopContextUsageTipCode =
  | "near_full"
  | "overflow_after_model_switch"
  | "static_tools_heavy"
  | "conversation_omitted"
  | "partial_sources"
  | "media_unestimated"
  | "no_context_window"
  | "stale_or_rebuilt"

export interface DesktopContextUsageTip {
  code: DesktopContextUsageTipCode | (string & {})
  message: string
}

export interface DesktopContextUsageSnapshot {
  model: string
  contextWindow: number | null
  outputLimit?: number | null
  estimatedInputTokens: number
  percentFull: number | null
  estimator: "heuristic_v1"
  buckets: DesktopContextUsageBucket[]
  tips: DesktopContextUsageTip[]
  computedAt: string
  source: "live_assembly" | "session_cache" | "static_only"
}
