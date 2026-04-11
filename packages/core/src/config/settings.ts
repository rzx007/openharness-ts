import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Settings } from "../index";

const DEFAULT_SETTINGS: Settings = {
  model: "claude-sonnet-4-20250514",
  apiFormat: "anthropic",
  permissionMode: "default",
  maxTurns: 50,
  memory: { enabled: true },
  sandbox: { enabled: false },
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
  if (process.env.OPENHARNESS_MODEL !== undefined) result.model = process.env.OPENHARNESS_MODEL;
  if (process.env.OPENHARNESS_API_FORMAT !== undefined) result.apiFormat = process.env.OPENHARNESS_API_FORMAT as Settings["apiFormat"];
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
