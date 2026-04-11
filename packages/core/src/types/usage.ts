export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
}

export interface CostTracker {
  addUsage(usage: UsageSnapshot): void;
  getTotal(): UsageSnapshot;
  reset(): void;
}
