export type ModelCatalogItem = {
  model: string;
  label: string;
  provider: string;
  providerName: string;
  hint?: string;
};

export const MODEL_CATALOG: ModelCatalogItem[] = [
  {
    model: "nvidia/nemotron-3.5-lightning:free",
    label: "Nemotron 3.5 Lightning Free",
    provider: "OpenRouter",
    providerName: "openrouter",
    hint: "Free",
  },
  {
    model: "inception/mercury-coder-small-beta",
    label: "Mercury Coder Small Beta",
    provider: "OpenRouter",
    providerName: "openrouter",
  },
  {
    model: "deepseek/deepseek-v4-flash:free",
    label: "DeepSeek V4 Flash Free",
    provider: "OpenRouter",
    providerName: "openrouter",
    hint: "Free",
  },
  {
    model: "deepseek/deepseek-v4-flash",
    label: "DeepSeek V4 flash",
    provider: "DeepSeek",
    providerName: "deepseek",
  },
  {
    model: "deepseek/deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    provider: "DeepSeek",
    providerName: "deepseek",
  },
  {
    model: "glm-4.7",
    label: "GLM-4.7",
    provider: "Zhipu AI",
    providerName: "zhipu",
  },
  {
    model: "glm-5",
    label: "GLM-5",
    provider: "Zhipu AI",
    providerName: "zhipu",
  },
  {
    model: "glm-5.2",
    label: "GLM-5.2",
    provider: "Zhipu AI",
    providerName: "zhipu",
  },
  {
    model: "gpt-5.4",
    label: "GPT-5.4",
    provider: "Codex Subscription",
    providerName: "codex",
  },
  {
    model: "gpt-5.5",
    label: "GPT-5.5",
    provider: "OpenAI",
    providerName: "openai",
  },
  {
    model: "gpt-5.6",
    label: "GPT-5.6",
    provider: "OpenAI",
    providerName: "openai",
  },
  {
    model: "claude-sonnet-4-5",
    label: "Claude Sonnet 4.5",
    provider: "Anthropic",
    providerName: "anthropic",
  },
  {
    model: "gemini-3.1-pro",
    label: "Gemini 3.1 Pro",
    provider: "Gemini",
    providerName: "gemini",
  },
  {
    model: "minimax/minimax-m2.5:free",
    label: "MiniMax M2.5 Free",
    provider: "OpenRouter",
    providerName: "openrouter",
    hint: "Free",
  },
];

export function modelCatalogWithCurrent(model: string | undefined, providerName: string | undefined): ModelCatalogItem[] {
  if (!model || MODEL_CATALOG.some((item) => item.model === model)) return MODEL_CATALOG;
  return [
    {
      model,
      label: model,
      provider: providerName ?? "Current",
      providerName: providerName ?? "",
    },
    ...MODEL_CATALOG,
  ];
}
