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

## Provider 完整流程梳理

### 一、注册（静态定义）

`packages/api/src/providers/registry.ts` 中 `PROVIDERS` 数组硬编码了 **20 个 Provider**：

| 类型 | Provider |
|------|----------|
| **Anthropic 原生** | `anthropic` |
| **OpenAI 兼容** | `openai`, `deepseek`, `gemini`, `dashscope(qwen)`, `moonshot`, `minimax`, `zhipu(glm)`, `groq`, `mistral`, `stepfun`, `baidu`, `bedrock`, `vertex` |
| **网关** | `openrouter`, `aihubmix`, `siliconflow`, `volcengine` |
| **本地** | `ollama`, `vllm` |

每个 `ProviderSpec` 定义了：

- `keywords` — 模型名匹配词（如 `["deepseek"]`）
- `envKey` — 对应环境变量（如 `DEEPSEEK_API_KEY`）
- `backendType` — `"anthropic"` 或 `"openai_compat"`
- `defaultBaseURL` — 默认 API 地址
- `detectByKeyPrefix` — API Key 前缀检测（如 `sk-or-` → OpenRouter）
- `detectByBaseKeyword` — Base URL 关键字检测（如 `deepseek` → DeepSeek）

---

### 二、检测（三级优先级）

`detectProvider(model, apiKey, baseURL)` 按优先级检测：

```
1. API Key 前缀 → sk-or-xxx 匹配 OpenRouter, gsk_xxx 匹配 Groq
2. Base URL 关键字 → "deepseek.com" 匹配 DeepSeek, "dashscope" 匹配 DashScope
3. 模型名关键字 → "claude-xxx" 匹配 Anthropic, "gpt-4o" 匹配 OpenAI, "glm-4" 匹配 Zhipu
```

`detectProviderFromEnv(env)` 在前三个都失败时兜底——遍历非 gateway/local/oauth 的 Provider，找到第一个有对应环境变量的。

---

### 三、启动流程（CLI → Bootstrap → Client）

```
用户运行: openharness --model deepseek-chat --api-key sk-xxx
    │
    ▼
mainAction() 解析 CLI flags
    │
    ▼
loadSettings(cliOverrides)  →  合并: 默认值 < 文件 < 环境变量 < CLI参数
    │  结果: Settings = { model: "deepseek-chat", apiKey: "sk-xxx", ... }
    │
    ▼
bootstrap(settings, overrides)
    │
    ▼
resolveApiClient(settings, overrides)
    │
    ├─ 1. --provider 强制指定? → findByName(provider)
    ├─ 2. detectProvider(model, apiKey, baseURL)  ← 三级检测
    └─ 3. detectProviderFromEnv(env)              ← 环境变量兜底
    │
    ▼  得到 ProviderSpec { backendType: "openai_compat", defaultBaseURL: "..." }
    │
    ▼
    backendType === "anthropic"  →  new AnthropicClient({ apiKey, baseURL })
    backendType === "openai_compat"  →  new OpenAICompatibleClient({ apiKey, baseURL, model })
```

---

### 四、运行时切换

**`/model` 命令**（REPL 模式）：

```
用户输入: /model gpt-4o
    │
    ▼  slash-commands.ts → setModel("gpt-4o")
    │
    ▼  queryEngine.setModel("gpt-4o")  ← 只改了模型名
    │
    ⚠️  重新创建 API Client
```
