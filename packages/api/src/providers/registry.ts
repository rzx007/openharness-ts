import type { StreamingMessageClient, StreamMessageParams, StreamEvent, Message, ToolDefinition } from "@openharness/core";

export interface ProviderConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
}

export interface ProviderSpec {
  id: string;
  name: string;
  envVars: string[];
  defaultModel: string;
  baseURL?: string;
  detect: (env: NodeJS.ProcessEnv) => boolean;
  createClient: (config: ProviderConfig) => StreamingMessageClient;
}

export const PROVIDERS: ProviderSpec[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    envVars: ["ANTHROPIC_API_KEY"],
    defaultModel: "claude-sonnet-4-20250514",
    detect: (env) => !!env.ANTHROPIC_API_KEY,
    createClient: (config) => {
      const { AnthropicClient } = require("./anthropic") as { AnthropicClient: new (c: ProviderConfig) => StreamingMessageClient };
      return new AnthropicClient(config);
    },
  },
  {
    id: "openai",
    name: "OpenAI Compatible",
    envVars: ["OPENAI_API_KEY"],
    defaultModel: "gpt-4o",
    detect: (env) => !!env.OPENAI_API_KEY,
    createClient: (config) => {
      const { OpenAICompatibleClient } = require("./openai") as { OpenAICompatibleClient: new (c: ProviderConfig) => StreamingMessageClient };
      return new OpenAICompatibleClient(config);
    },
  },
];

export function detectProvider(env: NodeJS.ProcessEnv): ProviderSpec | null {
  for (const provider of PROVIDERS) {
    if (provider.detect(env)) return provider;
  }
  return null;
}
