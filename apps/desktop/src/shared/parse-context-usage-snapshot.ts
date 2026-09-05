import type {
  DesktopContextBucketId,
  DesktopContextUsageBucket,
  DesktopContextUsageSnapshot,
  DesktopContextUsageTip,
} from "./context-usage-types"

const BUCKET_IDS = new Set<DesktopContextBucketId>([
  "system",
  "tools",
  "rules",
  "skills",
  "mcp",
  "subagents",
  "summary",
  "conversation",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function parseBucket(value: unknown): DesktopContextUsageBucket | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== "string" || !BUCKET_IDS.has(value.id as DesktopContextBucketId)) {
    return null
  }
  if (typeof value.label !== "string") return null
  if (typeof value.tokens !== "number" || !Number.isFinite(value.tokens)) return null
  return {
    id: value.id as DesktopContextBucketId,
    label: value.label,
    tokens: value.tokens,
  }
}

function parseTip(value: unknown): DesktopContextUsageTip | null {
  if (!isRecord(value)) return null
  if (typeof value.code !== "string" || typeof value.message !== "string") return null
  return { code: value.code, message: value.message }
}

export function parseDesktopContextUsageSnapshot(
  value: unknown
): DesktopContextUsageSnapshot | null {
  if (!isRecord(value)) return null
  if (typeof value.model !== "string") return null
  if (!(typeof value.contextWindow === "number" || value.contextWindow === null)) return null
  if (typeof value.estimatedInputTokens !== "number") return null
  if (!(typeof value.percentFull === "number" || value.percentFull === null)) return null
  if (value.estimator !== "heuristic_v1") return null
  if (!Array.isArray(value.buckets) || !Array.isArray(value.tips)) return null
  if (typeof value.computedAt !== "string") return null
  if (
    value.source !== "live_assembly" &&
    value.source !== "session_cache" &&
    value.source !== "static_only"
  ) {
    return null
  }

  const buckets: DesktopContextUsageBucket[] = []
  for (const item of value.buckets) {
    const bucket = parseBucket(item)
    if (!bucket) return null
    buckets.push(bucket)
  }

  const tips: DesktopContextUsageTip[] = []
  for (const item of value.tips) {
    const tip = parseTip(item)
    if (!tip) return null
    tips.push(tip)
  }

  return {
    model: value.model,
    contextWindow: value.contextWindow,
    outputLimit:
      typeof value.outputLimit === "number" ||
      value.outputLimit === null ||
      value.outputLimit === undefined
        ? (value.outputLimit as number | null | undefined)
        : undefined,
    estimatedInputTokens: value.estimatedInputTokens,
    percentFull: value.percentFull,
    estimator: "heuristic_v1",
    buckets,
    tips,
    computedAt: value.computedAt,
    source: value.source,
  }
}
