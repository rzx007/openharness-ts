/** Lightweight token → USD estimate for /usage and /cost. */

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-3-5-sonnet-20241022": { input: 3, output: 15 },
  "claude-3-7-sonnet-20250219": { input: 3, output: 15 },
  "claude-3-opus-20240229": { input: 15, output: 75 },
  "claude-3-haiku-20240307": { input: 0.25, output: 1.25 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4-turbo": { input: 10, output: 30 },
  o1: { input: 15, output: 60 },
  "o3-mini": { input: 1.1, output: 4.4 },
  "deepseek-chat": { input: 0.14, output: 0.28 },
  "deepseek-reasoner": { input: 0.55, output: 2.19 },
  "glm-4-plus": { input: 0.7, output: 0.7 },
  "glm-4": { input: 0.7, output: 0.7 },
  "glm-4-flash": { input: 0.1, output: 0.1 },
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): string {
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING["claude-sonnet-4-20250514"]!;
  const cost = (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
  return `$${cost.toFixed(4)}`;
}
