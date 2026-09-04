import type { ContextUsageSnapshot } from "./types.js";

function formatTokenCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatPercent(percentFull: number | null): string {
  if (percentFull == null) return "n/a";
  const pct = percentFull * 100;
  const digits = pct >= 10 ? 0 : pct >= 1 ? 1 : 2;
  return `${pct.toFixed(digits)}% Full`;
}

/**
 * Human-readable CLI/HTTP report for a context usage snapshot.
 * Hides empty buckets; includes tips and source tag.
 */
export function formatContextUsageReport(snapshot: ContextUsageSnapshot): string {
  const lines: string[] = [];
  lines.push(`Context usage (${snapshot.source}):`);
  lines.push(`  Model: ${snapshot.model}`);

  const total = formatTokenCount(snapshot.estimatedInputTokens);
  if (snapshot.contextWindow == null) {
    lines.push(`  ~${total} Tokens (${formatPercent(snapshot.percentFull)})`);
  } else {
    lines.push(
      `  ~${total} / ${formatTokenCount(snapshot.contextWindow)} Tokens (${formatPercent(snapshot.percentFull)})`,
    );
  }

  const nonEmpty = snapshot.buckets.filter((bucket) => bucket.tokens > 0);
  if (nonEmpty.length > 0) {
    lines.push("");
    for (const bucket of nonEmpty) {
      lines.push(`  ${bucket.label}: ${formatTokenCount(bucket.tokens)}`);
    }
  }

  if (snapshot.tips.length > 0) {
    lines.push("");
    lines.push("Tips:");
    for (const tip of snapshot.tips) {
      lines.push(`  - [${tip.code}] ${tip.message}`);
    }
  }

  return lines.join("\n");
}
