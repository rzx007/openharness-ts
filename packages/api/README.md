# @openharness/api

LLM Provider registry and clients for Anthropic, OpenAI-compatible APIs, and GitHub Copilot.

## 功能

- **Provider Registry**: 21 providers with auto-detection (key prefix → baseURL → model)
- **AnthropicClient**: Native Anthropic SDK streaming client
- **OpenAICompatibleClient**: OpenAI-compatible REST API client
- **CopilotClient**: GitHub Copilot OAuth client

## Providers

| Provider | Backend | Env Key | Default Model |
|---|---|---|---|
| Anthropic | anthropic | ANTHROPIC_API_KEY | claude-sonnet-4-20250514 |
| OpenAI | openai_compat | OPENAI_API_KEY | gpt-4o |
| GitHub Copilot | copilot | GITHUB_TOKEN (OAuth) | gpt-4o |
| DeepSeek | openai_compat | DEEPSEEK_API_KEY | deepseek-chat |
| Gemini | openai_compat | GEMINI_API_KEY | gemini-pro |
| DashScope | openai_compat | DASHSCOPE_API_KEY | qwen-max |
| Moonshot | openai_compat | MOONSHOT_API_KEY | moonshot-v1 |
| MiniMax | openai_compat | MINIMAX_API_KEY | abyss |
| Groq | openai_compat | GROQ_API_KEY | llama-3.1-70b |
| Ollama | openai_compat | - | llama3 |
| ... | | | |

## 使用

```ts
import { detectProvider, PROVIDERS, AnthropicClient } from "@openharness/api";

// 自动检测
const provider = detectProvider("claude-sonnet-4-20250514", "sk-ant-xxx");
if (provider) {
  const client = new provider.createClient({ apiKey: "xxx" });
}

// 或直接使用
const client = new AnthropicClient({ apiKey: process.env.ANTHROPIC_API_KEY });
```

## API

### Registry

- `detectProvider(model?, apiKey?, baseURL?)` - 三级检测
- `findByName(name)` - 按名称查找
- `detectProviderFromEnv(env)` - 从环境变量检测

### Clients

- `AnthropicClient(config)` - Anthropic API
- `OpenAICompatibleClient(config)` - OpenAI 兼容 API
- `CopilotClient(config, options?)` - GitHub Copilot

## 测试

```bash
pnpm --filter @openharness/api test
```