import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getConfigDir } from "@openharness/core";

export interface ModelsDevCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface ModelsDevModel {
  id?: string;
  name?: string;
  family?: string;
  release_date?: string;
  attachment?: boolean;
  reasoning?: boolean;
  temperature?: boolean;
  tool_call?: boolean;
  cost?: ModelsDevCost;
  limit?: {
    context?: number;
    input?: number;
    output?: number;
  };
  modalities?: {
    input?: string[];
    output?: string[];
  };
  status?: "alpha" | "beta" | "deprecated";
}

export interface ModelsDevProvider {
  id?: string;
  name?: string;
  env?: string[];
  api?: string;
  npm?: string;
  models?: Record<string, ModelsDevModel>;
}

export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

const DEFAULT_MODELS_URL = "https://models.dev/api.json";

export const CODEX_DEFAULT_MODEL = "gpt-5.6-sol";

const FALLBACK_CATALOG: ModelsDevCatalog = {
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
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    models: {
      "deepseek-v4-flash": {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        reasoning: true,
        tool_call: true,
        limit: { context: 1_000_000, output: 384_000 },
      },
      "deepseek-v4-pro": {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        reasoning: true,
        tool_call: true,
        limit: { context: 1_000_000, output: 384_000 },
      },
    },
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    models: {
      "nvidia/nemotron-3.5-lightning:free": {
        id: "nvidia/nemotron-3.5-lightning:free",
        name: "Nemotron 3.5 Lightning Free",
        reasoning: false,
        tool_call: true,
        cost: { input: 0, output: 0 },
        limit: { context: 128_000, output: 32_000 },
      },
      "deepseek/deepseek-chat-v3.1:free": {
        id: "deepseek/deepseek-chat-v3.1:free",
        name: "DeepSeek V3.1 Free",
        reasoning: false,
        tool_call: true,
        cost: { input: 0, output: 0 },
        limit: { context: 128_000, output: 32_000 },
      },
      "minimax/minimax-m2.5:free": {
        id: "minimax/minimax-m2.5:free",
        name: "MiniMax M2.5 Free",
        reasoning: false,
        tool_call: true,
        cost: { input: 0, output: 0 },
        limit: { context: 128_000, output: 32_000 },
      },
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-5.4": {
        id: "gpt-5.4",
        name: "GPT-5.4",
        reasoning: true,
        tool_call: true,
        limit: { context: 1_050_000, output: 128_000 },
      },
      "gpt-4.1": {
        id: "gpt-4.1",
        name: "GPT-4.1",
        reasoning: false,
        tool_call: true,
        limit: { context: 1_000_000, output: 32_000 },
      },
    },
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-sonnet-4-5": {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        reasoning: true,
        tool_call: true,
        limit: { context: 200_000, output: 64_000 },
      },
    },
  },
  gemini: {
    id: "gemini",
    name: "Gemini",
    models: {
      "gemini-2.5-pro": {
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        reasoning: true,
        tool_call: true,
        limit: { context: 1_000_000, output: 64_000 },
      },
    },
  },
  zhipu: {
    id: "zhipu",
    name: "Zhipu AI",
    models: {
      "glm-4.5": {
        id: "glm-4.5",
        name: "GLM-4.5",
        reasoning: true,
        tool_call: true,
        limit: { context: 128_000, output: 32_000 },
      },
      "glm-4.7": {
        id: "glm-4.7",
        name: "GLM-4.7",
        reasoning: true,
        tool_call: true,
        limit: { context: 128_000, output: 32_000 },
      },
      "glm-5": {
        id: "glm-5",
        name: "GLM-5",
        reasoning: true,
        tool_call: true,
        limit: { context: 128_000, output: 32_000 },
      },
    },
  },
};

function modelsCachePath(): string {
  return join(getConfigDir(), "cache", "models-dev.json");
}

function modelsUrl(): string {
  return process.env.OPENHARNESS_MODELS_URL?.trim() || DEFAULT_MODELS_URL;
}

function configuredCatalogPath(): string | undefined {
  return process.env.OPENHARNESS_MODELS_PATH?.trim() || undefined;
}

async function readJsonFile(path: string): Promise<ModelsDevCatalog | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as ModelsDevCatalog;
  } catch {
    return undefined;
  }
}

function isUsableCatalog(value: ModelsDevCatalog | undefined): value is ModelsDevCatalog {
  return !!value && Object.keys(value).length > 0;
}

function withFallbackProviders(catalog: ModelsDevCatalog): ModelsDevCatalog {
  const merged: ModelsDevCatalog = { ...FALLBACK_CATALOG };
  for (const [id, provider] of Object.entries(catalog)) {
    const fallback = FALLBACK_CATALOG[id];
    merged[id] = fallback
      ? {
        ...fallback,
        ...provider,
        models: { ...fallback.models, ...provider.models },
      }
      : provider;
  }
  return merged;
}

export class ModelCatalogService {
  private loaded: ModelsDevCatalog | undefined;

  async load(): Promise<ModelsDevCatalog> {
    if (this.loaded) return this.loaded;

    const configuredPath = configuredCatalogPath();
    if (configuredPath) {
      const configured = await readJsonFile(configuredPath);
      if (isUsableCatalog(configured)) {
        this.loaded = configured;
        return configured;
      }
    }

    const cached = await readJsonFile(modelsCachePath());
    if (process.env.OPENHARNESS_DISABLE_MODELS_FETCH) {
      this.loaded = isUsableCatalog(cached) ? withFallbackProviders(cached) : FALLBACK_CATALOG;
      return this.loaded;
    }

    try {
      const response = await fetch(modelsUrl(), {
        headers: { "User-Agent": "openharness-ts/models-catalog" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Models.dev request failed: ${response.status}`);
      const text = await response.text();
      const parsed = JSON.parse(text) as ModelsDevCatalog;
      if (!isUsableCatalog(parsed)) throw new Error("Models.dev returned an empty catalog");
      await mkdir(dirname(modelsCachePath()), { recursive: true });
      await writeFile(modelsCachePath(), JSON.stringify(parsed, null, 2) + "\n", "utf-8");
      this.loaded = withFallbackProviders(parsed);
      return this.loaded;
    } catch {
      this.loaded = isUsableCatalog(cached) ? withFallbackProviders(cached) : FALLBACK_CATALOG;
      return this.loaded;
    }
  }
}

export function createModelCatalogService(): ModelCatalogService {
  return new ModelCatalogService();
}
