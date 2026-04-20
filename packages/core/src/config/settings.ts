import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Settings } from "../index";

const DEFAULT_SETTINGS: Settings = {
  model: "claude-sonnet-4-20250514",
  apiFormat: "anthropic",
  maxTokens: 16384,
  maxTurns: 50,
  permission: { mode: "default" },
  memory: { enabled: true, maxFiles: 5, maxEntrypointLines: 200 },
  sandbox: { enabled: false },
  effort: "medium",
  passes: 1,
};

export async function loadSettings(
  cliOverrides?: Partial<Settings>
): Promise<Settings> {
  const envSettings = loadFromEnv();
  const fileSettings = await loadFromFile();

  return {
    ...DEFAULT_SETTINGS,
    ...fileSettings,
    ...envSettings,
    ...cliOverrides,
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  const configDir = join(homedir(), ".openharness");
  const configPath = join(configDir, "settings.json");
  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, JSON.stringify(settings, null, 2), "utf-8");
}

function loadFromEnv(): Partial<Settings> {
  const result: Partial<Settings> = {};
  const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY;
  if (apiKey !== undefined) result.apiKey = apiKey;
  if (process.env.ANTHROPIC_MODEL !== undefined) result.model = process.env.ANTHROPIC_MODEL;
  if (process.env.OPENHARNESS_MODEL !== undefined) result.model = process.env.OPENHARNESS_MODEL;
  if (process.env.OPENHARNESS_API_FORMAT !== undefined) result.apiFormat = process.env.OPENHARNESS_API_FORMAT as Settings["apiFormat"];
  if (process.env.ANTHROPIC_BASE_URL !== undefined || process.env.OPENHARNESS_BASE_URL !== undefined) {
    result.baseUrl = process.env.ANTHROPIC_BASE_URL ?? process.env.OPENHARNESS_BASE_URL;
  }
  if (process.env.OPENHARNESS_MAX_TOKENS !== undefined) result.maxTokens = parseInt(process.env.OPENHARNESS_MAX_TOKENS, 10);
  if (process.env.OPENHARNESS_MAX_TURNS !== undefined) result.maxTurns = parseInt(process.env.OPENHARNESS_MAX_TURNS, 10);

  const apiKeys: Record<string, string> = {};
  const envKeyMap: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    gemini: "GEMINI_API_KEY",
    dashscope: "DASHSCOPE_API_KEY",
    moonshot: "MOONSHOT_API_KEY",
    minimax: "MINIMAX_API_KEY",
    zhipu: "ZHIPUAI_API_KEY",
    groq: "GROQ_API_KEY",
    mistral: "MISTRAL_API_KEY",
    stepfun: "STEPFUN_API_KEY",
    baidu: "QIANFAN_ACCESS_KEY",
    openrouter: "OPENROUTER_API_KEY",
    bedrock: "AWS_ACCESS_KEY_ID",
    vertex: "GOOGLE_APPLICATION_CREDENTIALS",
    aihubmix: "OPENAI_API_KEY",
    siliconflow: "OPENAI_API_KEY",
    volcengine: "OPENAI_API_KEY",
  };
  for (const [provider, envKey] of Object.entries(envKeyMap)) {
    const val = process.env[envKey];
    if (val) apiKeys[provider] = val;
  }
  if (Object.keys(apiKeys).length > 0) result.apiKeys = apiKeys;

  return result;
}

async function loadFromFile(): Promise<Partial<Settings> | null> {
  const configPath = join(homedir(), ".openharness", "settings.json");
  try {
    await access(configPath);
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw) as Partial<Settings>;
  } catch {
    return null;
  }
}
