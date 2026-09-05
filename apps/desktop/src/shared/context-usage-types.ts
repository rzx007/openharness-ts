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

export interface DesktopContextUsageTip {
  code: string
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
