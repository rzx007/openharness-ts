import type { ContextUsageSnapshot } from "./types.js";

function formatTokenCount(value: number): string {
  return value.toLocaleString("zh-CN");
}

function formatPercent(percentFull: number | null): string {
  if (percentFull == null) return "不适用";
  const pct = percentFull * 100;
  const digits = pct >= 10 ? 0 : pct >= 1 ? 1 : 2;
  return `${pct.toFixed(digits)}% 已用`;
}

/**
 * 上下文占用快照的人类可读报告（CLI / HTTP）。
 * 隐藏空桶；包含 tips 与来源标记。
 */
export function formatContextUsageReport(snapshot: ContextUsageSnapshot): string {
  const lines: string[] = [];
  lines.push(`上下文占用（${snapshot.source}）：`);
  lines.push(`  模型：${snapshot.model}`);

  const total = formatTokenCount(snapshot.estimatedInputTokens);
  if (snapshot.contextWindow == null) {
    lines.push(`  约 ${total} Tokens（${formatPercent(snapshot.percentFull)}）`);
  } else {
    lines.push(
      `  约 ${total} / ${formatTokenCount(snapshot.contextWindow)} Tokens（${formatPercent(snapshot.percentFull)}）`,
    );
  }

  const nonEmpty = snapshot.buckets.filter((bucket) => bucket.tokens > 0);
  if (nonEmpty.length > 0) {
    lines.push("");
    for (const bucket of nonEmpty) {
      lines.push(`  ${bucket.label}：${formatTokenCount(bucket.tokens)}`);
    }
  }

  if (snapshot.tips.length > 0) {
    lines.push("");
    lines.push("提示：");
    for (const tip of snapshot.tips) {
      lines.push(`  - [${tip.code}] ${tip.message}`);
    }
  }

  return lines.join("\n");
}
