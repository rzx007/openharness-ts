import type { ContextUsageTip, ContextUsageTipCode } from "./types.js";

const TIP_MESSAGES: Record<ContextUsageTipCode, string> = {
  near_full: "上下文接近满额，建议执行 /compact 或新开对话。",
  overflow_after_model_switch:
    "换模型后估算占用已超过当前窗宽，建议先压缩再继续。",
  static_tools_heavy: "工具与 MCP 定义占用了较大比例的上下文。",
  conversation_omitted: "本次快照未计入对话占用。",
  partial_sources: "部分上下文来源读取失败，快照可能不完整。",
  media_unestimated: "部分媒体无法估值，占用可能被低估。",
  no_context_window: "当前模型没有上下文窗宽元数据，无法计算百分比。",
  stale_or_rebuilt: "占用快照已重建，可能与上一份缓存不同。",
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
