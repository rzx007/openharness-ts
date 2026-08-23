import { readFile, writeFile, mkdir } from "node:fs/promises";
import type { Settings } from "../index";
import { getConfigDir, getConfigFilePath, getProjectConfigDir, getProjectSettingsFilePath } from "./paths";

const DEFAULT_SETTINGS: Settings = {
  model: "minimax/minimax-m2.5:free",
  apiFormat: "openai",
  provider: "openrouter",
  maxTokens: 16384,
  maxTurns: 50,
  permission: { mode: "default" },
  memory: {
    enabled: true,
    maxFiles: 5,
    maxEntrypointLines: 200,
    sessionMemoryEnabled: true,
    autoExtractEnabled: true,
    autoExtractMaxRecords: 3,
    autoDreamEnabled: false,
    autoDreamMinHours: 24,
    autoDreamMinSessions: 5,
  },
  sandbox: {
    enabled: false,
    backend: "srt",
    failIfUnavailable: false,
    filesystem: {
      allowRead: ["."],
      denyRead: [],
      allowWrite: ["."],
      denyWrite: [],
      extraAllowedRoots: [],
    },
    network: {
      mode: "none",
      allowedDomains: [],
      deniedDomains: [],
      strictDomainPolicy: false,
    },
    docker: {
      image: "openharness-sandbox:latest",
      autoBuildImage: true,
      cpuLimit: 0,
      memoryLimit: "",
      dns: [],
      extraMounts: [],
      extraEnv: {},
      containerNamePrefix: "openharness-sandbox",
      reuseContainer: false,
    },
    srt: {
      runtimeCommand: "srt",
    },
  },
  daemon: {
    autoStart: false,
  },
  effort: "medium",
  passes: 1,
  outputStyle: "default",
};

type SettingsPatch = Partial<Omit<Settings, "sandbox" | "daemon">> & {
  sandbox?: Partial<NonNullable<Settings["sandbox"]>>;
  daemon?: Partial<NonNullable<Settings["daemon"]>>;
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
  cliOverrides?: Partial<Settings>,
  options: { projectRoot?: string; includeProject?: boolean } = {},
): Promise<Settings> {
  // 从环境变量加载配置
  const envSettings = loadFromEnv();
  // 从配置文件异步加载配置
  const fileSettings = await loadFromFile();
  const projectSettings = options.includeProject
    ? await loadProjectSettings(options.projectRoot)
    : null;

  // 按优先级合并所有配置源
  const merged = {
    ...DEFAULT_SETTINGS,
    ...fileSettings,
    ...projectSettings,
    ...envSettings,
    ...cliOverrides,
  } as Settings;
  merged.memory = {
    ...DEFAULT_SETTINGS.memory,
    ...fileSettings?.memory,
    ...projectSettings?.memory,
    ...envSettings.memory,
    ...cliOverrides?.memory,
    enabled: cliOverrides?.memory?.enabled
      ?? envSettings.memory?.enabled
      ?? projectSettings?.memory?.enabled
      ?? fileSettings?.memory?.enabled
      ?? DEFAULT_SETTINGS.memory?.enabled
      ?? true,
  };
  merged.sandbox = mergeSandboxConfig(
    DEFAULT_SETTINGS.sandbox,
    fileSettings?.sandbox,
    projectSettings?.sandbox,
    envSettings.sandbox,
    cliOverrides?.sandbox,
  );
  merged.daemon = {
    ...DEFAULT_SETTINGS.daemon,
    ...fileSettings?.daemon,
    ...envSettings.daemon,
    ...cliOverrides?.daemon,
  } as NonNullable<Settings["daemon"]>;
  return merged;
}

/**
 * 将设置对象保存为 JSON 文件到用户主目录下的 .openharness 配置文件夹中。
 *
 * @param settings - 要保存的设置对象，将被序列化为格式化的 JSON 字符串。
 * @returns 无返回值（Promise<void>），表示保存操作完成。
 */
export async function saveSettings(settings: Settings): Promise<void> {
  // 构建配置目录和文件路径
  const configDir = getConfigDir();
  const configPath = getConfigFilePath();

  // 确保配置目录存在，若不存在则递归创建
  await mkdir(configDir, { recursive: true });

  // 将设置对象写入 JSON 文件，使用 UTF-8 编码和缩进格式化
  await writeFile(
    configPath,
    JSON.stringify({ ...settings, _formatVersion: 1 }, null, 2),
    "utf-8",
  );
}

export async function loadProjectSettings(projectRoot?: string): Promise<Partial<Settings> | null> {
  return loadSettingsFile(getProjectSettingsFilePath(projectRoot));
}

export async function saveProjectSettings(
  settings: Partial<Settings>,
  projectRoot?: string,
): Promise<void> {
  const configDir = getProjectConfigDir(projectRoot);
  const configPath = getProjectSettingsFilePath(projectRoot);
  await mkdir(configDir, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({ ...settings, _formatVersion: 1 }, null, 2),
    "utf-8",
  );
}

function loadFromEnv(): SettingsPatch {
  const result: SettingsPatch = {};
  const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY;
  if (apiKey !== undefined) result.apiKey = apiKey;
  if (process.env.ANTHROPIC_MODEL !== undefined) result.model = process.env.ANTHROPIC_MODEL;
  if (process.env.OPENHARNESS_MODEL !== undefined) result.model = process.env.OPENHARNESS_MODEL;
  if (process.env.OPENHARNESS_API_FORMAT !== undefined) result.apiFormat = process.env.OPENHARNESS_API_FORMAT as Settings["apiFormat"];
  // 通用 baseUrl 只认 OPENHARNESS_BASE_URL。不要用 ANTHROPIC_BASE_URL ——
  // 它是 Anthropic 专属（很多人为 Claude Code 设了 ANTHROPIC_BASE_URL=api.anthropic.com），
  // 灌进通用 baseUrl 会污染非 Anthropic provider（如 deepseek 的请求被发到 anthropic 端点）。
  // anthropic provider 的 baseURL 由 Anthropic SDK 自行读取 ANTHROPIC_BASE_URL。
  if (process.env.OPENHARNESS_BASE_URL !== undefined) {
    result.baseUrl = process.env.OPENHARNESS_BASE_URL;
  }
  if (process.env.OPENHARNESS_MAX_TOKENS !== undefined) result.maxTokens = parseInt(process.env.OPENHARNESS_MAX_TOKENS, 10);
  if (process.env.OPENHARNESS_MAX_TURNS !== undefined) result.maxTurns = parseInt(process.env.OPENHARNESS_MAX_TURNS, 10);
  const sandbox = buildSandboxEnvOverrides();
  if (sandbox !== undefined) result.sandbox = sandbox;

  return result;
}

function buildSandboxEnvOverrides(): Partial<NonNullable<Settings["sandbox"]>> | undefined {
  const sandbox: Partial<NonNullable<Settings["sandbox"]>> = {};
  if (process.env.OPENHARNESS_SANDBOX_ENABLED !== undefined) {
    sandbox.enabled = parseBooleanEnv(process.env.OPENHARNESS_SANDBOX_ENABLED);
  }
  if (process.env.OPENHARNESS_SANDBOX_BACKEND !== undefined) {
    const backend = process.env.OPENHARNESS_SANDBOX_BACKEND;
    if (backend === "srt" || backend === "docker") sandbox.backend = backend;
  }
  if (process.env.OPENHARNESS_SANDBOX_FAIL_IF_UNAVAILABLE !== undefined) {
    sandbox.failIfUnavailable = parseBooleanEnv(
      process.env.OPENHARNESS_SANDBOX_FAIL_IF_UNAVAILABLE,
    );
  }
  if (process.env.OPENHARNESS_SANDBOX_NETWORK_MODE !== undefined) {
    const mode = process.env.OPENHARNESS_SANDBOX_NETWORK_MODE;
    if (mode === "none" || mode === "bridge" || mode === "host" || mode === "proxy") {
      sandbox.network = { mode };
    }
  }
  if (process.env.OPENHARNESS_SANDBOX_DOCKER_IMAGE !== undefined) {
    sandbox.docker = { image: process.env.OPENHARNESS_SANDBOX_DOCKER_IMAGE };
  }
  const dockerEnv: NonNullable<NonNullable<Settings["sandbox"]>["docker"]> = {
    ...(sandbox.docker ?? {}),
  };
  if (process.env.OPENHARNESS_SANDBOX_DOCKER_DNS !== undefined) {
    dockerEnv.dns = parseListEnv(process.env.OPENHARNESS_SANDBOX_DOCKER_DNS);
  }
  const extraEnv: Record<string, string> = { ...(dockerEnv.extraEnv ?? {}) };
  if (process.env.OPENHARNESS_SANDBOX_HTTP_PROXY !== undefined) {
    extraEnv.HTTP_PROXY = process.env.OPENHARNESS_SANDBOX_HTTP_PROXY;
    extraEnv.http_proxy = process.env.OPENHARNESS_SANDBOX_HTTP_PROXY;
  }
  if (process.env.OPENHARNESS_SANDBOX_HTTPS_PROXY !== undefined) {
    extraEnv.HTTPS_PROXY = process.env.OPENHARNESS_SANDBOX_HTTPS_PROXY;
    extraEnv.https_proxy = process.env.OPENHARNESS_SANDBOX_HTTPS_PROXY;
  }
  if (process.env.OPENHARNESS_SANDBOX_NO_PROXY !== undefined) {
    extraEnv.NO_PROXY = process.env.OPENHARNESS_SANDBOX_NO_PROXY;
    extraEnv.no_proxy = process.env.OPENHARNESS_SANDBOX_NO_PROXY;
  }
  if (Object.keys(extraEnv).length > 0) dockerEnv.extraEnv = extraEnv;
  if (Object.keys(dockerEnv).length > 0) sandbox.docker = dockerEnv;
  return Object.keys(sandbox).length > 0 ? sandbox : undefined;
}

function parseBooleanEnv(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function parseListEnv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergeSandboxConfig(
  ...configs: Array<Partial<NonNullable<Settings["sandbox"]>> | undefined | null>
): Settings["sandbox"] {
  const result: NonNullable<Settings["sandbox"]> = { enabled: false };
  for (const config of configs) {
    if (!config) continue;
    const filesystem = result.filesystem;
    const network = result.network;
    const docker = result.docker;
    const srt = result.srt;
    Object.assign(result, config);
    result.filesystem = { ...filesystem, ...config.filesystem };
    result.network = { ...network, ...config.network };
    result.docker = { ...docker, ...config.docker };
    result.srt = { ...srt, ...config.srt };
  }
  return result;
}

/**
 * 从用户主目录下的配置文件中加载设置信息。
 * 
 * 该函数尝试读取位于 `~/.openharness-ts/settings.json` 的配置文件。
 * 如果文件存在且内容合法，则解析并返回部分设置对象；
 * 如果文件不存在、无法访问或解析失败，则返回 null。
 * 
 * @returns {Promise<Partial<Settings> | null>} 解析后的部分设置对象，若加载失败则返回 null
 */
async function loadFromFile(): Promise<Partial<Settings> | null> {
  // 构建配置文件的完整路径
  const configPath = getConfigFilePath();
  return loadSettingsFile(configPath);
}

async function loadSettingsFile(configPath: string): Promise<Partial<Settings> | null> {
  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Settings file must contain a JSON object: ${configPath}`);
    }
    const settings = parsed as Partial<Settings> & {
      _formatVersion?: unknown;
      sandbox?: { runtime?: unknown };
    };
    if (settings._formatVersion !== 1) {
      throw new Error(
        `Unsupported settings format ${String(settings._formatVersion)} in ${configPath}; expected 1`,
      );
    }
    if (settings.sandbox && "runtime" in settings.sandbox) {
      throw new Error(`Unsupported settings field sandbox.runtime in ${configPath}; use sandbox.backend`);
    }
    const { _formatVersion: _discardedFormatVersion, ...currentSettings } = settings;
    return currentSettings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
