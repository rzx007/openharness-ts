import type { ContextUsageTip, ContextUsageTipCode } from "./types.js";

const TIP_MESSAGES: Record<ContextUsageTipCode, string> = {
  near_full:
    "Context is nearly full. Consider running /compact or starting a new conversation.",
  overflow_after_model_switch:
    "Estimated input exceeds the current model context window after a model switch. Consider compacting first.",
  static_tools_heavy:
    "Tool and MCP definitions use a large share of the context window.",
  conversation_omitted:
    "Conversation usage was not included in this snapshot.",
  partial_sources:
    "Some context sources could not be read; the snapshot may be incomplete.",
  media_unestimated:
    "Some media could not be estimated and may be undercounted.",
  no_context_window:
    "The current model has no context window metadata; percentage cannot be calculated.",
  stale_or_rebuilt:
    "The usage snapshot was rebuilt and may differ from the previous cache.",
};

export function createTip(code: ContextUsageTipCode): ContextUsageTip {
  return { code, message: TIP_MESSAGES[code] };
}

export interface TipEvaluationInput {
  estimatedInputTokens: number;
  contextWindow: number | null;
  toolsTokens: number;
  mcpTokens: number;
  modelSwitch?: { previousContextWindow: number };
}

export function evaluateTips(input: TipEvaluationInput): ContextUsageTip[] {
  const tips: ContextUsageTip[] = [];
  const { estimatedInputTokens, contextWindow, toolsTokens, mcpTokens, modelSwitch } = input;

  if (contextWindow == null) {
    tips.push(createTip("no_context_window"));
    return tips;
  }

  const paddedTotal = Math.ceil((estimatedInputTokens * 4) / 3);

  if (paddedTotal >= contextWindow * 0.85) {
    tips.push(createTip("near_full"));
  }

  if (modelSwitch != null && estimatedInputTokens > contextWindow) {
    tips.push(createTip("overflow_after_model_switch"));
  }

  if (toolsTokens + mcpTokens >= contextWindow * 0.2) {
    tips.push(createTip("static_tools_heavy"));
  }

  return tips;
}
