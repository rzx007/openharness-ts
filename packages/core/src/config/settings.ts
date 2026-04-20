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

/**
 * 加载并合并配置设置。
 *
 * 按照以下优先级顺序合并配置（后者覆盖前者）：
 * 1. 默认设置 (DEFAULT_SETTINGS)
 * 2. 文件配置 (loadFromFile)
 * 3. 环境变量配置 (loadFromEnv)
 * 4. CLI 覆盖参数 (cliOverrides)
 *
 * @param cliOverrides - 可选的命令行参数覆盖项，用于部分覆盖最终生成的设置
 * @returns 合并后的完整 Settings 对象
 */
export async function loadSettings(
  cliOverrides?: Partial<Settings>
): Promise<Settings> {
  // 从环境变量加载配置
  const envSettings = loadFromEnv();
  // 从配置文件异步加载配置
  const fileSettings = await loadFromFile();

  // 按优先级合并所有配置源
  return {
    ...DEFAULT_SETTINGS,
    ...fileSettings,
    ...envSettings,
    ...cliOverrides,
  };
}

/**
 * 将设置对象保存为 JSON 文件到用户主目录下的 .openharness 配置文件夹中。
 *
 * @param settings - 要保存的设置对象，将被序列化为格式化的 JSON 字符串。
 * @returns 无返回值（Promise<void>），表示保存操作完成。
 */
export async function saveSettings(settings: Settings): Promise<void> {
  // 构建配置目录和文件路径
  const configDir = join(homedir(), ".openharness");
  const configPath = join(configDir, "settings.json");

  // 确保配置目录存在，若不存在则递归创建
  await mkdir(configDir, { recursive: true });

  // 将设置对象写入 JSON 文件，使用 UTF-8 编码和缩进格式化
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

  return result;
}

/**
 * 从用户主目录下的配置文件中加载设置信息。
 * 
 * 该函数尝试读取位于 `~/.openharness/settings.json` 的配置文件。
 * 如果文件存在且内容合法，则解析并返回部分设置对象；
 * 如果文件不存在、无法访问或解析失败，则返回 null。
 * 
 * @returns {Promise<Partial<Settings> | null>} 解析后的部分设置对象，若加载失败则返回 null
 */
async function loadFromFile(): Promise<Partial<Settings> | null> {
  // 构建配置文件的完整路径
  const configPath = join(homedir(), ".openharness", "settings.json");
  try {
    // 检查配置文件是否存在且可访问
    await access(configPath);
    // 读取配置文件内容并解析为 JSON 对象
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw) as Partial<Settings>;
  } catch {
    // 若发生任何错误（如文件不存在、权限不足、JSON 格式错误等），返回 null
    return null;
  }
}
