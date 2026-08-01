import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Settings, StreamingMessageClient } from "@openharness/core";
import { QueryEngine, ToolRegistry, RuntimeBuilder, RuntimeBundle, getConfigDir, resolveGitRepository } from "@openharness/core";
import { AnthropicClient, CodexSubscriptionClient, OpenAICompatibleClient, detectProvider, detectProviderFromEnv, findByName } from "@openharness/api";
import type { BackendType, ProviderSpec } from "@openharness/api";
import { CredentialStorage, loadCodexCredential } from "@openharness/auth";
import { PermissionChecker, READ_ONLY_TOOLS } from "@openharness/permissions";
import { HookExecutor } from "@openharness/hooks";
import { createDefaultToolRegistry } from "@openharness/tools";
import { buildRuntimeSystemPrompt } from "@openharness/prompts";
import { SandboxUnavailableError, startSandboxRuntime } from "@openharness/sandbox";
import type { SandboxRuntimeReporter } from "@openharness/sandbox";
import type { SkillRegistry } from "@openharness/skills";
import {
  getBackendRegistry,
  SubprocessBackend,
  WorktreeManager,
  registerTeammateInTeamFile,
  type GitRunner,
} from "@openharness/swarm";
import { getTaskManager } from "@openharness/services";
import { buildTeammateCommand } from "./teammate.js";
import { startSwarmPermissionResolver, watchTeamForPermissions } from "./swarm-permission.js";

const bundlesWithExitCleanup = new Set<RuntimeBundle>();
let exitCleanupInstalled = false;

export type PermissionPromptFn = (
  toolName: string,
  reason?: string,
  input?: Record<string, unknown>,
) => Promise<boolean>;

export interface BootstrapOptions {
  settings: Settings;
  cwd?: string;
  cliOverrides?: {
    apiKey?: string;
    baseUrl?: string;
    provider?: string;
    model?: string;
    systemPrompt?: string;
    permissionMode?: string;
    maxTurns?: number;
    dangerouslySkipPermissions?: boolean;
    allowedTools?: string;
    disallowedTools?: string;
    effort?: string;
    fastMode?: boolean;
    swarmWorker?: boolean;
    /** 只读工具自动放行(Read/Glob/Grep 等)。channels serve 等无头模式用:
     *  default 模式下 ask 无人确认会全拒,放行只读让"看"可用、"写/执行"仍拒。 */
    autoApproveReadOnly?: boolean;
    /** 显式追加自动放行的工具名(与其他来源合并;denied 类检查仍优先)。 */
    autoApproveTools?: string[];
  };
  permissionPrompt?: PermissionPromptFn;
  skillRegistry?: SkillRegistry;
  credentialStorage?: CredentialStorage;
  sandboxReporter?: SandboxRuntimeReporter;
  sessionId?: string;
}

/**
 * 合并自动放行工具：settings.permission.autoApproveTools（用户显式配置）
 * + swarm worker / autoApproveReadOnly 注入的 READ_ONLY_TOOLS。
 * 空合并返回 undefined（checker 走默认行为）。
 */
export function resolveAutoApproveTools(
  settings: Settings,
  overrides: { swarmWorker?: boolean; autoApproveReadOnly?: boolean; autoApproveTools?: string[] },
): string[] | undefined {
  const merged = new Set([
    ...(settings.permission.autoApproveTools ?? []),
    ...(overrides.autoApproveTools ?? []),
  ]);
  if (overrides.swarmWorker || overrides.autoApproveReadOnly) {
    for (const tool of READ_ONLY_TOOLS) merged.add(tool);
  }
  return merged.size > 0 ? [...merged] : undefined;
}

export function resolveRuntimeModel(
  settings: Settings,
  overrides: { model?: string | undefined },
): string {
  return overrides.model ?? settings.model;
}

export async function bootstrap(options: BootstrapOptions): Promise<RuntimeBundle> {
  const { settings } = options;
  const cwd = options.cwd ?? process.cwd();
  const overrides = options.cliOverrides ?? {};
  const storage = options.credentialStorage ?? new CredentialStorage();

  const apiClient = await resolveApiClient(settings, overrides, storage);

  let toolRegistry = createDefaultToolRegistry();

  const effectiveAllowed = new Set([
    ...(settings.permission.allowedTools ?? []),
    ...(overrides.allowedTools ? overrides.allowedTools.split(",") : []),
  ]);
  const effectiveDenied = new Set([
    ...(settings.permission.deniedTools ?? []),
    ...(overrides.disallowedTools ? overrides.disallowedTools.split(",") : []),
  ]);

  if (effectiveAllowed.size > 0) {
    const filtered = new ToolRegistry();
    for (const tool of toolRegistry.getAll()) {
      if (effectiveAllowed.has(tool.name)) filtered.register(tool);
    }
    toolRegistry = filtered;
  }

  if (effectiveDenied.size > 0) {
    const filtered = new ToolRegistry();
    for (const tool of toolRegistry.getAll()) {
      if (!effectiveDenied.has(tool.name)) filtered.register(tool);
    }
    toolRegistry = filtered;
  }

  const mode = overrides.dangerouslySkipPermissions
    ? "full_auto"
    : (overrides.permissionMode as "default" | "plan" | "full_auto") ?? settings.permission.mode;

  // 自动放行三来源合并:settings.permission.autoApproveTools(用户显式配置,
  // 此前从未接线)+ swarm worker / 无头只读模式注入 READ_ONLY_TOOLS。
  // denied 永远优先于 autoApprove(checker 内保证)。
  const autoApproveTools = resolveAutoApproveTools(settings, overrides);

  const permissionChecker = new PermissionChecker({
    mode,
    allowedTools: [...effectiveAllowed],
    deniedTools: [...effectiveDenied],
    pathRules: settings.permission.pathRules,
    deniedCommands: settings.permission.deniedCommands,
    autoApproveTools,
  });

  const hookExecutor = new HookExecutor();
  const runtimeModel = resolveRuntimeModel(settings, overrides);

  // 自定义 prompt（CLI override）优先，跳过默认 prompt 构建。只在走默认 prompt
  // 时才注入 model 可见的 skills 段，使 print/backend 三模式与 REPL 一致——REPL
  // 由 refreshSystemPrompt 注入，print/backend 走 bootstrap 由此处注入。
  // task-worker 子进程的 systemPrompt 通过 env 传递（避免 Windows argv 长度限制）。
  const envSystemPrompt = process.env["OPENHARNESS_TASK_SYSTEM_PROMPT"] || undefined;
  const systemPrompt = overrides.systemPrompt ?? envSystemPrompt ?? await buildRuntimeSystemPrompt({
    customPrompt: settings.systemPrompt,
    cwd,
    permissionMode: mode,
    fastMode: overrides.fastMode ?? settings.fastMode,
    effort: overrides.effort ?? settings.effort,
    passes: settings.passes,
    skillsList: options.skillRegistry?.modelVisibleList(),
  });

  const engineOptions = {
    maxTurns: overrides.maxTurns ?? settings.maxTurns,
    systemPrompt,
    model: runtimeModel,
    cwd,
    sessionId: options.sessionId,
    settings,
    permissionPrompt: options.permissionPrompt,
    skillRegistry: options.skillRegistry,
  };

  const queryEngine = new QueryEngine(
    apiClient,
    toolRegistry,
    permissionChecker,
    hookExecutor,
    engineOptions,
  );

  // 注册 swarm subprocess 后端（幂等）：让 Agent 工具能真正把子代理拉起为
  // 子进程。teammate 命令由 buildTeammateCommand 构建（继承 model/provider/
  // 权限模式，不暴露 api-key）。
  await registerSubprocessBackend({
    cwd,
    sessionId: options.sessionId,
    settings,
    permissionChecker,
  });
  const bundle = new RuntimeBuilder()
    .setApiClient(apiClient)
    .setToolRegistry(toolRegistry)
    .setPermissionChecker(permissionChecker)
    .setHookExecutor(hookExecutor)
    .setQueryEngine(queryEngine)
    .build(settings);

  await attachSandboxRuntime(bundle, cwd, options.sandboxReporter, options.sessionId);
  return bundle;
}
export async function registerSubprocessBackend(options: {
  cwd: string;
  sessionId?: string;
  settings: Settings;
  permissionChecker: Parameters<typeof startSwarmPermissionResolver>[0];
}): Promise<void> {
  const { cwd, sessionId, settings, permissionChecker } = options;
  const runtimeScope = { cwd, sessionId };
  const backendRegistry = getBackendRegistry(runtimeScope);
  if (backendRegistry.list().includes("subprocess")) return;

  const taskManager = getTaskManager(runtimeScope);
  const repoRoot = await resolveRepoRoot(cwd);
  const worktreeManager = new WorktreeManager({
    runGit: nodeRunGit,
    repoRoot,
    baseDir: computeWorktreeBaseDir(repoRoot, getConfigDir()),
  });
  backendRegistry.register(
    "subprocess",
    new SubprocessBackend({
      taskRunner: {
        createShellTask: (opts) => taskManager.createShellTask({ ...opts, sessionId, type: "agent" }),
        createAgentTask: (opts) => taskManager.createAgentTask({ ...opts, sessionId, type: "agent" }),
        writeToTask: (id, data) => taskManager.writeToTask(id, data),
        stopTask: async (id) => {
          await taskManager.stopTask(id);
        },
      },
      buildCommand: (cfg) => buildTeammateCommand(cfg, settings),
      worktreeManager,
      registerTeammate: (cfg, res) => {
        registerTeammateInTeamFile(cfg.team, {
          agentId: res.agentId,
          name: cfg.name,
          backendType: res.backendType,
          joinedAt: Date.now() / 1000,
          agentType: null,
          model: cfg.model ?? null,
          prompt: cfg.prompt,
          color: null,
          planModeRequired: false,
          sessionId: cfg.sessionId ?? null,
          subscriptions: [],
          isActive: true,
          mode: null,
          tmuxPaneId: "",
          cwd: cfg.cwd,
          worktreePath: res.worktree?.path ?? null,
          permissions: cfg.permissions ?? [],
          status: "active",
        });
        watchTeamForPermissions(cfg.team);
        startSwarmPermissionResolver(permissionChecker, READ_ONLY_TOOLS);
      },
    }),
  );
}

async function attachSandboxRuntime(
  bundle: RuntimeBundle,
  cwd: string,
  reporter?: SandboxRuntimeReporter,
  sessionId?: string,
): Promise<void> {
  let sandboxRuntime;
  try {
    sandboxRuntime = await startSandboxRuntime({
      settings: bundle.settings,
      cwd,
      sessionId: createSandboxSessionId(cwd, sessionId),
      reporter,
    });
  } catch (error) {
    if (error instanceof SandboxUnavailableError) {
      console.error(formatSandboxUnavailableError(error.message, bundle.settings));
      process.exit(1);
    }
    throw error;
  }
  bundle.sandboxStatus = sandboxRuntime.status;

  if (sandboxRuntime.status.backend !== "docker" || !sandboxRuntime.status.active) {
    return;
  }

  bundle.addCleanup(
    () => sandboxRuntime.stop(),
    () => sandboxRuntime.stopSync(),
  );
  registerExitCleanup(bundle);
}

function createSandboxSessionId(cwd: string, sessionId?: string): string {
  const repoId = createHash("sha1").update(cwd).digest("hex").slice(0, 12);
  const safeSessionId = sessionId?.replace(/[^A-Za-z0-9._-]/g, "_");
  return safeSessionId
    ? `${process.pid}-${repoId}-${safeSessionId}`
    : `${process.pid}-${repoId}-${Date.now().toString(36)}`;
}

export function formatSandboxUnavailableError(reason: string, settings: Settings): string {
  const backend = settings.sandbox?.backend ?? "srt";
  const lines = [
    "",
    `Sandbox is enabled, but the ${backend} backend is not available.`,
    `Reason: ${reason}`,
    "",
    "Next steps:",
  ];

  if (backend === "docker") {
    lines.push(
      "- Install/start Docker Desktop or Docker Engine, then run: ohs sandbox doctor",
      "- Or disable sandbox for this project: ohs sandbox off",
      "- Or allow startup without sandbox: ohs sandbox on --fail-open",
    );
  } else {
    lines.push(
      "- Install @anthropic-ai/sandbox-runtime and required platform dependencies, then run: ohs sandbox doctor",
      "- Or switch to Docker sandbox: ohs sandbox on --backend docker",
      "- Or disable sandbox for this project: ohs sandbox off",
    );
  }

  return lines.join("\n");
}

function registerExitCleanup(bundle: RuntimeBundle): void {
  bundlesWithExitCleanup.add(bundle);
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  process.on("exit", () => {
    for (const runtime of bundlesWithExitCleanup) {
      runtime.closeSync();
    }
    bundlesWithExitCleanup.clear();
  });
}

/**
 * 解析并创建 API 客户端实例。
 *
 * 该函数根据提供的设置、覆盖选项和存储机制，确定正确的 API 密钥、基础 URL、提供商规范以及后端类型，
 * 最终返回相应的流式消息客户端实例。
 *
 * @param settings - 核心配置设置，包含模型、基础 URL、提供商和 API 格式等信息。
 * @param overrides - 可选的引导覆盖选项，用于优先于默认设置配置 CLI 行为（如 baseUrl, provider 等）。
 * @param storage - 可选的凭证存储实例，用于检索 API 密钥；若未提供，则使用默认的 CredentialStorage。
 * @returns 一个解析后的 StreamingMessageClient 实例，用于与选定的后端进行通信。
 */
export async function resolveApiClient(
  settings: Settings,
  overrides?: BootstrapOptions["cliOverrides"],
  storage?: CredentialStorage,
): Promise<StreamingMessageClient> {
  const resolvedStorage = storage ?? new CredentialStorage();
  const apiKey = await resolveApiKey(settings, overrides, resolvedStorage);
  const providerName = overrides?.provider ?? settings.provider;
  const rawBaseURL = overrides?.baseUrl ?? settings.baseUrl;
  const baseURL = providerName
    ? resolveProviderScopedBaseUrl(rawBaseURL, providerName)
    : rawBaseURL;
  const runtimeModel = resolveRuntimeModel(settings, overrides ?? {});

  // 按优先级顺序解析提供商规范：首先尝试通过名称查找，其次基于模型和凭据检测，最后尝试从环境变量检测
  let spec: ProviderSpec | undefined;
  if (providerName) {
    spec = findByName(providerName);
  }
  if (!spec) {
    spec = detectProvider(runtimeModel, apiKey, baseURL);
  }
  if (!spec) {
    spec = detectProviderFromEnv(process.env);
  }

  // 确定后端类型：优先使用提供商规范中的类型，否则根据 API 格式推断
  const backendType: BackendType = spec?.backendType ?? resolveBackendFromFormat(settings.apiFormat);

  switch (backendType) {
    case "codex":
      return new CodexSubscriptionClient({
        apiKey,
        baseURL: baseURL ?? spec?.defaultBaseURL,
        model: runtimeModel,
      });
    case "openai_compat":
      return new OpenAICompatibleClient({
        apiKey,
        baseURL: baseURL ?? spec?.defaultBaseURL,
        model: runtimeModel,
      });
    case "anthropic":
    default:
      return new AnthropicClient({
        apiKey,
        baseURL,
      });
  }
}

/**
 * 根据指定的提供商名称和模型，为运行时 Bundle 切换 API 客户端。
 *
 * 该函数会解析必要的 API 密钥，根据提供商类型实例化新的流式消息客户端，
 * 并更新 Bundle 中的客户端实例及相关设置。
 *
 * @param bundle - 运行时 Bundle 对象，用于承载和更新 API 客户端及配置。
 * @param providerName - 目标 API 提供商的名称，用于查找对应的规格配置。
 * @param model - 可选的目标模型名称。如果提供，将更新 Bundle 的设置和查询引擎模型。
 * @param storage - 可选的凭证存储对象。如果未提供，将使用默认的 CredentialStorage 实例。
 * @returns 如果操作成功返回 null；如果找不到指定的提供商，则返回错误信息字符串。
 */
export async function switchApiClientForBundle(
  bundle: RuntimeBundle,
  providerName: string,
  model?: string,
  storage?: CredentialStorage,
): Promise<string | null> {
  const resolvedStorage = storage ?? new CredentialStorage();
  const settings = { ...bundle.settings };

  if (model) {
    settings.model = model;
  }
  settings.provider = providerName;

  // 解析 API 密钥并查找提供商规格配置
  const apiKey = await resolveApiKey(settings, undefined, resolvedStorage);
  const spec = findByName(providerName);
  if (!spec) return `Unknown provider: ${providerName}`;

  const baseURL = resolveProviderScopedBaseUrl(settings.baseUrl, providerName) ?? spec.defaultBaseURL;
  const backendType: BackendType = spec.backendType;

  let newClient: StreamingMessageClient;
  // 根据后端类型实例化相应的 API 客户端
  switch (backendType) {
    case "codex":
      newClient = new CodexSubscriptionClient({
        apiKey,
        baseURL: baseURL || undefined,
        model: settings.model,
      });
      break;
    case "openai_compat":
      newClient = new OpenAICompatibleClient({
        apiKey,
        baseURL: baseURL || undefined,
        model: settings.model,
      });
      break;
    case "anthropic":
    default:
      newClient = new AnthropicClient({
        apiKey,
        baseURL: baseURL || undefined,
      });
      break;
  }

  // 更新 Bundle 的客户端实例、提供商设置以及可选的模型配置
  bundle.switchApiClient(newClient);
  bundle.settings.provider = providerName;
  bundle.settings.baseUrl = resolveProviderScopedBaseUrl(bundle.settings.baseUrl, providerName);
  if (model) {
    bundle.settings.model = model;
    bundle.queryEngine.setModel(model);
  }

  return null;
}

/**
 * 解析并获取 API Key。
 * 
 * 按照以下优先级顺序查找 API Key：
 * 1. 显式提供的覆盖配置或设置中的 apiKey。
 * 2. 根据提供商名称从存储中加载，或从对应的环境变量中获取。
 * 3. 根据模型和基础 URL 自动检测提供商，从存储中加载或从对应的环境变量中获取。
 * 4. 回退到常见的默认环境变量（Anthropic 或 OpenAI）。
 * 5. 优先级：显式 key → settings.apiKey → credentialStorage[providerName] → env[spec.envKey] → detectedProvider storage → ANTHROPIC/OPENAI env fallback → 空 string
 *    不再做模糊 fallback（不取 apiKeys 第一个值）
 * @param settings - 应用设置对象，包含默认的 apiKey、provider、model 和 baseUrl。
 * @param overrides - 可选的命令行覆盖选项，用于优先于 settings 的配置。
 * @param storage - 可选的凭证存储实例，用于持久化或读取 API Key。如果未提供，将创建一个新的默认实例。
 * @returns 解析后的 API Key 字符串，如果未找到则返回空字符串。
 */
export async function resolveApiKey(
  settings: Settings,
  overrides?: BootstrapOptions["cliOverrides"],
  storage?: CredentialStorage,
): Promise<string> {
  // 优先使用显式指定的 apiKey（来自覆盖配置或设置）
  const explicit = overrides?.apiKey ?? settings.apiKey;
  if (explicit) return explicit;

  const resolvedStorage = storage ?? new CredentialStorage();
  const runtimeModel = resolveRuntimeModel(settings, overrides ?? {});

  // 尝试根据指定的提供商名称获取 API Key（从存储或环境变量）
  const providerName = overrides?.provider ?? settings.provider;
  if (providerName) {
    if (providerName === "codex") {
      try {
        return (await loadCodexCredential()).value;
      } catch {
        return "";
      }
    }
    const stored = await resolvedStorage.loadApiKey(providerName);
    if (stored) return stored;
    const spec = findByName(providerName);
    if (spec?.envKey && process.env[spec.envKey]) return process.env[spec.envKey]!;
  }

  // 尝试通过模型和基础 URL 自动检测提供商，并获取对应的 API Key
  const spec = detectProvider(runtimeModel, undefined, settings.baseUrl);
  if (spec) {
    const stored = await resolvedStorage.loadApiKey(spec.name);
    if (stored) return stored;
    if (spec.envKey && process.env[spec.envKey]) return process.env[spec.envKey]!;
  }

  // 最后回退到常用的默认环境变量
  const envFallback = process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY;
  if (envFallback) return envFallback;

  return "";
}

export function resolveProviderScopedBaseUrl(
  baseURL: string | undefined,
  providerName: string | undefined,
): string | undefined {
  if (!baseURL || !providerName) return baseURL;
  const detected = detectProvider("", undefined, baseURL);
  if (detected && detected.name !== providerName) return undefined;
  return baseURL;
}

function resolveBackendFromFormat(format: string): BackendType {
  switch (format) {
    case "openai": return "openai_compat";
    default: return "anthropic";
  }
}

// ---------------------------------------------------------------------------
// Worktree wiring helpers (D.3)
// ---------------------------------------------------------------------------

/**
 * 计算某个 repo 的 worktree 存放根：`<configDir>/worktrees/<repoId>`。
 *
 * repoId 用 repoRoot 路径的 sha1 前 12 位，避免不同仓库的 worktree 互相串扰，
 * 且不暴露绝对路径。归一化路径分隔符 + Windows 下小写，让同一仓库始终落到同一目录。
 */
export function computeWorktreeBaseDir(repoRoot: string, configDir: string): string {
  const normalized = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  const repoId = createHash("sha1").update(key).digest("hex").slice(0, 12);
  return join(configDir, "worktrees", repoId);
}

/**
 * 注入给 WorktreeManager 的 git 运行器：用 node child_process spawn 'git'。
 *
 * 用参数数组（非 shell 拼接）避免注入/转义问题，跨平台安全；捕获 {code, stdout, stderr}。
 */
export const nodeRunGit: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    // GIT_TERMINAL_PROMPT=0：禁止 git 弹凭据提示而挂起子进程（与测试 realRunGit 一致，
    // 也对齐 Python _run_git）。数组传参（非 shell 拼接）避免注入/转义问题。
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      resolve({ code: 127, stdout, stderr: stderr || (err as Error).message });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

/**
 * 解析 *cwd* 所在 Git 仓库的顶层目录，不启动 Git 子进程。
 * 失败（非 git 仓库 / git 不可用）回退到 cwd 本身。
 */
export async function resolveRepoRoot(cwd: string): Promise<string> {
  return resolveGitRepository(cwd)?.root ?? cwd;
}
