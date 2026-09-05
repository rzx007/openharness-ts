import { estimateTokens } from "../utils/token-counter.js";
import { evaluateTips } from "./tips.js";
import type {
  AssembleContextUsageInput,
  ContextBucketId,
  ContextUsageBucket,
  ContextUsageSnapshot,
} from "./types.js";

const BUCKET_ORDER: readonly { id: ContextBucketId; label: string }[] = [
  { id: "system", label: "System prompt" },
  { id: "tools", label: "Tool definitions" },
  { id: "rules", label: "Rules" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP & dynamic tools" },
  { id: "subagents", label: "Subagent definitions" },
  { id: "summary", label: "Summarized conversation" },
  { id: "conversation", label: "Conversation" },
];

function segmentTokens(text: string, mediaTokens?: number): number {
  return estimateTokens(text) + (mediaTokens ?? 0);
}

export function assembleContextUsageSnapshot(
  input: AssembleContextUsageInput,
): ContextUsageSnapshot {
  const tokenByBucket = new Map<ContextBucketId, number>(
    BUCKET_ORDER.map(({ id }) => [id, 0]),
  );

  for (const segment of input.segments) {
    const current = tokenByBucket.get(segment.bucket) ?? 0;
    tokenByBucket.set(
      segment.bucket,
      current + segmentTokens(segment.text, segment.mediaTokens),
    );
  }

  const buckets: ContextUsageBucket[] = BUCKET_ORDER.map(({ id, label }) => ({
    id,
    label,
    tokens: tokenByBucket.get(id) ?? 0,
  }));

  const estimatedInputTokens = buckets.reduce((sum, bucket) => sum + bucket.tokens, 0);
  const percentFull =
    input.contextWindow == null
      ? null
      : estimatedInputTokens / input.contextWindow;

  const autoTips = evaluateTips({
    estimatedInputTokens,
    contextWindow: input.contextWindow,
    toolsTokens: tokenByBucket.get("tools") ?? 0,
    mcpTokens: tokenByBucket.get("mcp") ?? 0,
    modelSwitch: input.modelSwitch,
  });

  const tips = [...autoTips, ...(input.extraTips ?? [])];

  return {
    model: input.model,
    contextWindow: input.contextWindow,
    outputLimit: input.outputLimit,
    estimatedInputTokens,
    percentFull,
    estimator: "heuristic_v1",
    buckets,
    tips,
    computedAt: new Date().toISOString(),
    source: input.source,
  };
}
