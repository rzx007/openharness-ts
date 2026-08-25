import type { ModelsDevCatalog } from "./catalog";

export const CODEX_DEFAULT_MODEL = "gpt-5.6-sol";

export const SPECIAL_PROVIDER_CATALOG: ModelsDevCatalog = {
  codex: {
    id: "codex",
    name: "Codex Subscription",
    models: {
      "gpt-5.6-sol": {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        reasoning: true,
        tool_call: true,
        limit: { context: 1_050_000, output: 128_000 },
      },
      "gpt-5.6-terra": {
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        reasoning: true,
        tool_call: true,
        limit: { context: 1_050_000, output: 128_000 },
      },
      "gpt-5.6-luna": {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        reasoning: true,
        tool_call: true,
        limit: { context: 1_050_000, output: 128_000 },
      },
      "gpt-5.5": {
        id: "gpt-5.5",
        name: "GPT-5.5",
        reasoning: true,
        tool_call: true,
        limit: { context: 1_050_000, output: 128_000 },
      },
      "gpt-5.4": {
        id: "gpt-5.4",
        name: "GPT-5.4",
        reasoning: true,
        tool_call: true,
        limit: { context: 1_050_000, output: 128_000 },
      },
      "gpt-5.4-mini": {
        id: "gpt-5.4-mini",
        name: "GPT-5.4 Mini",
        reasoning: true,
        tool_call: true,
        limit: { context: 400_000, output: 128_000 },
      },
      "gpt-5.3-codex-spark": {
        id: "gpt-5.3-codex-spark",
        name: "GPT-5.3 Codex Spark",
        reasoning: false,
        tool_call: true,
        limit: { context: 128_000, output: 128_000 },
      },
    },
  },
};
