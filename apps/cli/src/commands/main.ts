import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import type { ContentBlock, RuntimeBundle, Settings } from "@openharness/core";
import { loadSettings, saveSettings as saveSettingsCore, getProjectMemoryDir, getSkillsDir, getDataDir } from "@openharness/core";
import { CommandRegistry } from "@openharness/commands";
import { HookExecutor } from "@openharness/hooks";
import { McpClientManager } from "@openharness/mcp";
import { MemoryManager } from "@openharness/memory";
import { SkillRegistry, SkillLoader, findProjectSkillDirs, type SkillDefinition } from "@openharness/skills";
import { ThemeManager } from "@openharness/themes";
import { TaskManager } from "@openharness/services";
import { buildRuntimeSystemPrompt } from "@openharness/prompts";
import { resolveToolPath } from "@openharness/tools";
import { CredentialStorage } from "@openharness/auth";
import { bootstrap, registerSubprocessBackend } from "../runtime";
import type { SandboxRuntimeEvent, SandboxRuntimeReporter } from "@openharness/sandbox";
import { loadPluginContributions, registerPluginHooks, mergePluginMcpServers, registerPluginTools, getLoadedPlugins } from "../plugin-contributions";
import { updateRulesFromSession } from "@openharness/personalization";
import { updateSessionMemoryFile, getSessionMemoryPath, getSessionMemoryContent, sessionMemoryToCompactText } from "@openharness/services";
import { isSwarmWorker } from "@openharness/swarm";
import {
  isCoordinatorMode,
  getCoordinatorTools,
  matchSessionMode,
} from "@openharness/coordinator";
import { buildSwarmWorkerPermissionPrompt } from "../swarm-permission";
import { EventRenderer } from "../renderer";
import { formatApiError } from "../format-error";
import { registerBuiltinCommandsOnRegistry, type SlashCommandContext } from "./slash-commands";
import { resolveBun } from "./resolveBun";
import { VERSION } from "../version";
import { probeDaemonRegistry, terminateDaemonProcess } from "../daemon-lifecycle";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";

type FrontendAttachment = {
  type?: "image" | string | null;
  path?: string | null;
  data?: string | null;
  media_type?: string | null;
  mime_type?: string | null;
};

interface MainOptions {
  model?: string;
  print?: boolean;
  continue?: boolean;
  resume?: string;
  name?: string;
  provider?: string;
  permissionMode?: string;
  maxTurns?: number;
  systemPrompt?: string;
  apiKey?: string;
  baseUrl?: string;
  apiFormat?: string;
  theme?: string;
  mcpConfig?: string;
  cwd?: string;
  effort?: string;
  verbose?: boolean;
  debug?: boolean;
  tui?: boolean;
  dangerouslySkipPermissions?: boolean;
  allowedTools?: string;
  disallowedTools?: string;
  outputFormat?: string;
  appendSystemPrompt?: string;
  bare?: boolean;
  swarmWorker?: boolean;
  taskWorker?: boolean;
  dryRun?: boolean;
  sessionId?: string;
}

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};
const DEFAULT_MAX_IMAGE_ATTACHMENTS = 4;
const DEFAULT_MAX_IMAGE_BYTES = 5_000_000;

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function maxImageAttachments(): number {
  return positiveIntegerEnv("OPENHARNESS_MAX_IMAGE_ATTACHMENTS", DEFAULT_MAX_IMAGE_ATTACHMENTS);
}

function maxImageBytes(): number {
  return positiveIntegerEnv("OPENHARNESS_MAX_IMAGE_BYTES", DEFAULT_MAX_IMAGE_BYTES);
}

function normalizeMediaType(mediaType: string): string {
  const normalized = mediaType.trim().toLowerCase();
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

function mediaTypeForPath(filePath: string, fallback?: string | null): string {
  if (fallback) return normalizeMediaType(fallback);
  const ext = filePath.split(/[.]/).pop()?.toLowerCase() ?? "";
  const mediaType = IMAGE_MEDIA_TYPES[ext];
  if (!mediaType) {
    throw new Error(`Unsupported image attachment extension: ${ext || "(none)"}`);
  }
  return mediaType;
}

function splitDataUri(data: string, fallbackMediaType: string): { mediaType: string; data: string } {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(data);
  if (!match) return { mediaType: normalizeMediaType(fallbackMediaType), data };
  return { mediaType: normalizeMediaType(match[1]!), data: match[2]! };
}

function assertSupportedImage(mediaType: string): void {
  if (!IMAGE_EXTENSIONS[mediaType]) {
    throw new Error(`Unsupported image attachment type: ${mediaType}`);
  }
}

function assertImageSize(sizeBytes: number): void {
  const limit = maxImageBytes();
  if (sizeBytes > limit) {
    throw new Error(`Image attachment is too large (${sizeBytes} bytes, max ${limit} bytes).`);
  }
}

function imageAttachmentCacheDir(): string {
  return process.env.OPENHARNESS_IMAGE_ATTACHMENT_CACHE_DIR
    ?? join(getDataDir(), "attachments", "images");
}

async function cacheImageBuffer(buffer: Buffer, mediaType: string): Promise<string> {
  const dir = imageAttachmentCacheDir();
  await mkdir(dir, { recursive: true });
  const target = join(dir, `${randomUUID()}.${IMAGE_EXTENSIONS[mediaType] ?? "img"}`);
  await writeFile(target, buffer);
  return target;
}

async function cacheImageFile(filePath: string, mediaType: string): Promise<string> {
  const dir = imageAttachmentCacheDir();
  await mkdir(dir, { recursive: true });
  const target = join(dir, `${randomUUID()}.${IMAGE_EXTENSIONS[mediaType] ?? "img"}`);
  await copyFile(filePath, target);
  return target;
}

async function attachmentToImageBlock(attachment: FrontendAttachment): Promise<ContentBlock | null> {
  const mediaTypeHint = attachment.media_type ?? attachment.mime_type ?? null;
  if (attachment.data) {
    const { mediaType, data } = splitDataUri(attachment.data, mediaTypeHint ?? "image/jpeg");
    assertSupportedImage(mediaType);
    const buffer = Buffer.from(data, "base64");
    assertImageSize(buffer.byteLength);
    const path = await cacheImageBuffer(buffer, mediaType);
    return {
      type: "image",
      source: { type: "file", mediaType, path, sizeBytes: buffer.byteLength },
    };
  }

  if (!attachment.path) return null;
  const filePath = resolveToolPath(attachment.path, process.cwd());
  const mediaType = mediaTypeForPath(filePath, mediaTypeHint);
  assertSupportedImage(mediaType);
  const info = await stat(filePath);
  if (!info.isFile()) {
    throw new Error(`Image attachment is not a file: ${filePath}`);
  }
  assertImageSize(info.size);
  const path = await cacheImageFile(filePath, mediaType);
  return {
    type: "image",
    source: {
      type: "file",
      mediaType,
      path,
      sizeBytes: info.size,
      originalPath: filePath,
    },
  };
}

export async function buildUserContentWithAttachments(
  line: string,
  attachments?: FrontendAttachment[] | null,
): Promise<string | ContentBlock[]> {
  if (!attachments?.length) return line;

  const blocks: ContentBlock[] = [];
  if (line.trim()) blocks.push({ type: "text", text: line });

  let imageCount = 0;
  const imageLimit = maxImageAttachments();
  for (const attachment of attachments) {
    if ((attachment.type ?? "image") !== "image") continue;
    imageCount += 1;
    if (imageCount > imageLimit) {
      throw new Error(`Too many image attachments (max ${imageLimit}).`);
    }
    const block = await attachmentToImageBlock(attachment);
    if (block) blocks.push(block);
  }

  return blocks.length > 0 ? blocks : line;
}

/**
 * 应用程序的主入口点，根据提供的选项和提示决定执行模式。
 * 
 * 该函数首先处理设置覆盖，然后根据标志位依次尝试以下模式：
 * 1. TUI 交互模式 (tui) — 启动/attach daemon，再 spawn opentui 前端
 * 2. 打印/非交互模式 (print 或存在 prompt)
 * 3. REPL 交互模式 (默认)
 * 
 * @param prompt - 用户输入的初始提示词，如果未提供则进入交互模式
 * @param options - 命令行选项配置对象，包含模型、权限、路径等设置
 * @returns Promise<void>
 */
export async function mainAction(
  prompt: string | undefined,
  options: MainOptions,
): Promise<void> {
  if (options.cwd) {
    process.chdir(options.cwd);
  }

  const overrides: Partial<Settings> = {};
  if (options.model) overrides.model = options.model;
  if (options.apiFormat) overrides.apiFormat = options.apiFormat as Settings["apiFormat"];
  if (options.permissionMode) overrides.permission = { mode: options.permissionMode as Settings["permission"]["mode"] };
  if (options.maxTurns) overrides.maxTurns = options.maxTurns;

  const settings = await loadSettings(overrides, { includeProject: true, projectRoot: process.cwd() });

  if (options.debug) {
    console.log("Settings:", JSON.stringify(settings, null, 2));
  }

  // dry-run：预览解析后的运行时配置 + readiness，不创建 client、不调模型。
  // 放在 tui/print 之前，让任何模式下加 --dry-run 都只预览不执行。
  if (options.dryRun) {
    const { runDryRun } = await import("../dry-run");
    await runDryRun(settings, options);
    return;
  }

  // task-worker 模式 = 「stdin 读一行 → 跑一轮 → 退出」(teammate 多轮的承载,
  // send_message 写 stdin 时 TaskManager 懒复活重启本进程)。无 TTY,先于其余模式。
  if (options.taskWorker) {
    await runTaskWorker(settings, options);
    return;
  }

  if (options.tui) {
    await runTuiMode(settings, options, prompt);
    return;
  }

  // print 模式 = 「一次性 Agent 调用 + stdout 流式输出 + 退出」
  if (options.print && prompt) {
    await runPrintMode(settings, prompt, options);
    return;
  }

  if (prompt) {
    await runPrintMode(settings, prompt, options);
    return;
  }

  await runRepl(settings, options);
}

/**
 * 执行打印模式，处理单个提示并输出结果后退出。
 * 
 * 此模式适用于脚本化调用或非交互式环境。它会加载技能，初始化运行时环境，
 * 并将所有事件通过 EventRenderer 渲染到标准输出。
 * 
 * @param settings -当前加载的应用设置
 * @param prompt - 要处理的用户提示词
 * @param options - 命令行选项，用于控制渲染行为（如 verbose）
 * @returns Promise<void>
 */
/**
 * stdin 驱动的无 TTY worker(对齐 Python ui/app.py run_task_worker):
 * 读一行(JSON {text,...} 或纯文本)→ submitMessage 流式 stdout → 退出。
 * 多轮 = TaskManager 懒复活重启 + 写下一行 stdin;重启不保留上下文。
 */
async function runTaskWorker(
  settings: Settings,
  options: MainOptions,
): Promise<void> {
  const skillRegistry = new SkillRegistry();
  await loadSkillsThreeSources(skillRegistry, process.cwd(), settings);
  const credentialStorage = new CredentialStorage();
  const swarmPermissionPrompt =
    options.swarmWorker && isSwarmWorker() ? buildSwarmWorkerPermissionPrompt() : undefined;
  const bundle = await bootstrap({
    settings,
    cliOverrides: buildCliOverrides(options),
    skillRegistry,
    credentialStorage,
    permissionPrompt: swarmPermissionPrompt,
    sessionId: options.sessionId,
  });
  try {
    registerPluginHooks(bundle.hookExecutor);
  await registerPluginTools(bundle.toolRegistry, getLoadedPlugins());
  const renderer = new EventRenderer({ verbose: options.verbose, printMode: true, outputStyle: settings.outputStyle });

  // D.1 Swarm context recovery：从预分配的会话 ID 恢复历史，跨重启保持上下文。
  const workerSessionId = options.sessionId ?? generateSessionId();
  if (options.sessionId) {
    try {
      const { loadSessionById } = await import("@openharness/services");
      const payload = loadSessionById(process.cwd(), options.sessionId);
      if (payload?.messages?.length) {
        bundle.queryEngine.loadMessages(payload.messages as any);
        if (payload.model) bundle.queryEngine.setModel(payload.model);
      }
    } catch {
      // best-effort：快照不存在时静默忽略，从空历史开始
    }
  }

  // 启动时检查自己的 mailbox：若 leader 已发送 shutdown，提前退出，不处理本轮 stdin。
  // worker 每轮运行完即退出，mailbox 在下次懒复活重启时才被检查，这是正常路径。
  if (isSwarmWorker()) {
    const agentName = process.env["CLAUDE_CODE_AGENT_NAME"] ?? "";
    const teamName = process.env["CLAUDE_CODE_TEAM_NAME"] ?? "default";
    if (agentName) {
      try {
        const { TeammateMailbox } = await import("@openharness/swarm");
        const mailbox = new TeammateMailbox(teamName, agentName);
        const pending = await mailbox.readAll();
        const shutdownMsg = pending.find((m) => m.type === "shutdown");
        if (shutdownMsg) {
          await mailbox.markRead(shutdownMsg.id);
          return;
        }
      } catch {
        // mailbox 读取失败时继续正常执行，不阻断 worker
      }
    }
  }

  const line = await readOneStdinLine();
  const decoded = decodeTaskWorkerLine(line);
  if (!decoded) return;

  try {
    for await (const event of bundle.queryEngine.submitMessage(decoded)) {
      await renderer.render(event);
    }
  } catch (err) {
    if (err instanceof Error) {
      process.stderr.write(`${formatApiError(err, settings)}\n`);
    }
    process.exitCode = 1;
    return;
  }

  try {
    updateRulesFromSession(bundle.queryEngine.getHistory());
  } catch {
    // best-effort
  }

  // D.1：每轮结束后保存快照，供下次重启恢复上下文。
  await saveSessionSnapshot(workerSessionId, bundle.queryEngine, settings.model);

  // 轮次结束后读一次 mailbox：消费掉本轮期间积压的 shutdown/其他消息，
  // 并向 leader 推送 idle 通知（leader 据此更新 swarm 状态面板）。
  if (isSwarmWorker()) {
    const agentName = process.env["CLAUDE_CODE_AGENT_NAME"] ?? "";
    const teamName = process.env["CLAUDE_CODE_TEAM_NAME"] ?? "default";
    if (agentName) {
      try {
        const { TeammateMailbox, createIdleNotification } = await import("@openharness/swarm");
        const mailbox = new TeammateMailbox(teamName, agentName);
        const pending = await mailbox.readAll();
        for (const msg of pending) {
          await mailbox.markRead(msg.id);
        }
        // 向 leader 发送 idle 通知
        const leaderMailbox = new TeammateMailbox(teamName, "leader");
        const idleMsg = createIdleNotification(agentName, "leader", "turn complete");
        await leaderMailbox.write(idleMsg);
      } catch {
        // best-effort：通知失败不影响主流程
      }
    }
  }
  } finally {
    closeTaskWorkerInputForExit();
    await bundle.close().catch(() => {});
  }
}

/**
 * 读 stdin 第一行(EOF 返回空串)。chunk 迭代而非 readline(后者在 Windows 管道
 * stdin 下偶现 close 先于 line)。关键:destroyOnReturn:false + pause——若早退时
 * destroy 掉 stdin,leader 在本轮进行中 SendMessage 会撞断管 → TaskManager 误判
 * 死进程而 terminate+重启,杀掉进行中的工作;pause 后句柄不再撑事件循环,
 * 跑完一轮仍可干净退出。
 */
async function readOneStdinLine(): Promise<string> {
  let buffer = "";
  process.stdin.setEncoding("utf-8");
  const iterator = (process.stdin as unknown as {
    iterator(opts: { destroyOnReturn: boolean }): AsyncIterableIterator<string>;
  }).iterator({ destroyOnReturn: false });
  for await (const chunk of iterator) {
    buffer += chunk;
    const idx = buffer.indexOf(String.fromCharCode(10));
    if (idx >= 0) {
      process.stdin.pause();
      return buffer.slice(0, idx);
    }
  }
  return buffer;
}

export function closeTaskWorkerInputForExit(input: NodeJS.ReadStream = process.stdin): void {
  // A task-worker consumes exactly one framed stdin message. Keeping the pipe
  // paused after that frame can keep the child process alive on Windows, so
  // release it once the turn has fully finished and future messages can use
  // TaskManager's lazy restart path.
  try {
    input.pause();
  } catch {
    // best-effort shutdown
  }
  for (const eventName of ["data", "readable", "end"] as const) {
    try {
      input.removeAllListeners(eventName);
    } catch {
      // best-effort shutdown
    }
  }
  try {
    if (!(input as { destroyed?: boolean }).destroyed) {
      input.destroy();
    }
  } catch {
    // best-effort shutdown
  }
}

/**
 * 解码 worker 收到的一行:JSON 对象取 text 字段(send_message 的结构化信封),
 * 非 JSON 按纯文本 prompt(对齐 Python _decode_task_worker_line)。
 */
export function decodeTaskWorkerLine(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const text = (parsed as { text?: unknown }).text;
      if (typeof text === "string") return text.trim();
    }
    // 对齐 Python:无 text 字段的 JSON(或数组/数字)按原始行当 prompt,
    // 而非静默空转(空转还会白烧一次懒复活重启额度)。
  } catch {
    // 纯文本
  }
  return trimmed;
}

async function runPrintMode(
  settings: Settings,
  prompt: string,
  options: MainOptions,
): Promise<void> {
  // ==================加载并注册技能（三源：bundled < user < project）==================
  const skillRegistry = new SkillRegistry();
  await loadSkillsThreeSources(skillRegistry, process.cwd(), settings);

  // ==================创建凭证存储器==================
  const credentialStorage = new CredentialStorage();

  // ==================创建运行时环境==================
  // swarm worker（teammate 子进程，带 --swarm-worker + swarm env）：permissionPrompt
  // 接文件流——写 pending 请求并阻塞轮询 leader 裁决（D.5）。写操作从「无确认即拒」
  // 变「转 leader 审批」；非 worker 的 print 模式保持无 prompt（ask 即拒）。
  const swarmPermissionPrompt =
    options.swarmWorker && isSwarmWorker() ? buildSwarmWorkerPermissionPrompt() : undefined;
  const bundle = await bootstrap({
    settings,
    cliOverrides: buildCliOverrides(options),
    skillRegistry,
    credentialStorage,
    permissionPrompt: swarmPermissionPrompt,
    sessionId: options.sessionId,
  });
  // 插件 hooks 贡献：bootstrap 后才有 HookExecutor，经缓存二段注册（C.1-R3）。
  registerPluginHooks(bundle.hookExecutor);

  const memoryDir = getProjectMemoryDir(process.cwd());
  const memoryManager = new MemoryManager(1000, memoryDir);
  const memoryFile = join(memoryDir, "memory.json");
  await memoryManager.loadFromFile(memoryFile).catch(() => { });

  const memoryContent =
    settings.memory?.enabled !== false
      ? memoryManager.buildMemoryPrompt(settings.memory?.maxFiles ?? 10)
      : undefined;
  bundle.queryEngine.setSystemPrompt(
    await buildRuntimeSystemPrompt({
      customPrompt: settings.systemPrompt,
      cwd: process.cwd(),
      permissionMode: settings.permission.mode,
      fastMode: settings.fastMode,
      effort: settings.effort,
      passes: settings.passes,
      memoryContent,
      skillsList: skillRegistry.modelVisibleList(),
    }),
  );

  bundle.queryEngine.setMemoryRetriever(async (userInput: string) => {
    if (settings.memory?.enabled === false) return null;
    const maxEntries = settings.memory?.maxFiles ?? 10;
    const { text, ids } = memoryManager.selectRelevantForPrompt(maxEntries, userInput);
    if (!text) return null;
    try {
      if (ids.length > 0) {
        await memoryManager.markMemoryUsed(ids);
      }
    } catch {
      // best-effort
    }
    return text;
  });

  // ==================创建事件渲染器==================
  const renderer = new EventRenderer({
    verbose: options.verbose,
    printMode: true,
    outputStyle: settings.outputStyle,
  });

  // ==================提交消息并渲染事件==================
  try {
    for await (const event of bundle.queryEngine.submitMessage(prompt)) {
      await renderer.render(event);
    }
  } catch (err) {
    if (err instanceof Error) {
      process.stderr.write(`${formatApiError(err, settings)}\n`);
    }
    process.exit(1);
  }

  // 个性化（C.5）：会话结束 best-effort 抽取环境事实，绝不阻塞退出。
  try {
    updateRulesFromSession(bundle.queryEngine.getHistory());
  } catch {
    // best-effort
  }

  await maintainMemoryAfterTurn({
    bundle,
    settings,
    model: settings.model,
    memoryManager,
    memoryDir,
    sessionId: generateSessionId(),
  });
}

/**
 * 启动终端 REPL (Read-Eval-Print Loop) 交互模式。
 * 
 * 此模式提供完整的交互式体验，包括会话管理、记忆加载、MCP 连接、
 * 命令注册以及基于 readline 的用户输入处理。支持会话恢复和持久化。
 * 
 * @param settings - 当前加载的应用设置
 * @param options - 命令行选项，影响会话ID生成和行为配置
 * @returns Promise<void>
 */
async function runRepl(
  settings: Settings,
  options: MainOptions,
): Promise<void> {
  const { join } = await import("node:path");

  // ==================加载并注册技能（三源：bundled < user < project）==================
  const skillRegistry = new SkillRegistry();
  await loadSkillsThreeSources(skillRegistry, process.cwd(), settings);

  const credentialStorage = new CredentialStorage();

  const bundle = await bootstrap({
    settings,
    cliOverrides: buildCliOverrides(options),
    skillRegistry,
    credentialStorage,
    sandboxReporter: createSandboxStartupReporter(process.stdout),
  });
  // 插件 hooks 贡献：bootstrap 后才有 HookExecutor，经缓存二段注册（C.1-R3）。
  registerPluginHooks(bundle.hookExecutor);
  // C.1 插件 tools_dir：动态加载插件工具目录，注册进 toolRegistry。
  await registerPluginTools(bundle.toolRegistry, getLoadedPlugins());
  // C.4 coordinator 模式：限制工具集为 orchestration tools。
  if (isCoordinatorMode()) {
    bundle.queryEngine.setAllowedTools(getCoordinatorTools());
  }

  let currentModel = settings.model;
  let sessionId: string | undefined;
  let currentSettings = settings;

  if (options.continue || options.resume) {
    sessionId = await loadSessionAndResume(
      bundle.queryEngine,
      options.resume,
      options.name,
    );
  } else {
    sessionId = generateSessionId();
    if (options.name) {
      sessionId = `${sessionId}:${options.name}`;
    }
  }
  bundle.queryEngine.setSessionId(sessionId);
  await registerSubprocessBackend({
    cwd: process.cwd(),
    sessionId,
    settings,
    permissionChecker: bundle.permissionChecker,
  });

  const memoryDir = getProjectMemoryDir(process.cwd());

  // ==================创建 MCP 客户端==================
  const mcpManager = new McpClientManager();
  // 插件 MCP 贡献合并：用户 settings 同名 server 优先，插件不覆盖（C.1-R3）。
  const mcpServers = mergePluginMcpServers(currentSettings.mcpServers);
  if (Object.keys(mcpServers).length > 0) {
    await mcpManager.connectAll(mcpServers).catch(() => { });
  }
  // MCP 工具注册进 toolRegistry：已连接 server 的工具以 mcp__<server>__<tool>
  // 形式注册，模型可直接调用；注入 mcpManager 使 McpToolCall 元工具可用。
  for (const tool of mcpManager.getAsToolDefinitions()) {
    bundle.toolRegistry.register(tool);
  }
  bundle.queryEngine.setMcpManager(mcpManager);

  // ==================创建 MemoryManager 客户端==================
  const memoryManager = new MemoryManager(1000, memoryDir);
  const memoryFile = join(memoryDir, "memory.json");
  await memoryManager.loadFromFile(memoryFile).catch(() => { });

  // ==================接线 per-turn 相关记忆检索==================
  // 每轮按本轮用户输入选相关记忆，作为瞬态 system-reminder 注入（不进持久历史，
  // 不改写常驻 systemPrompt）。同时对命中的记忆 markMemoryUsed 记使用。
  // 参考 Python prompts/context.py 的 select_relevant_memories + mark_memory_used。
  bundle.queryEngine.setMemoryRetriever(async (userInput: string) => {
    if (currentSettings.memory?.enabled === false) return null;
    const maxEntries = currentSettings.memory?.maxFiles ?? 10;
    // 注入与“标记已使用”取同一批条目：selectRelevantForPrompt 返回它实际
    // 渲染进 text 的那批条目（及其 ids），保证 use_count 反馈与注入一致。
    const { text, ids } = memoryManager.selectRelevantForPrompt(maxEntries, userInput);
    if (!text) return null;
    try {
      if (ids.length > 0) {
        await memoryManager.markMemoryUsed(ids);
      }
    } catch {
      // markMemoryUsed 失败不应阻断本轮注入
    }
    return text;
  });


  // ==================创建主题管理器==================
  const themeManager = new ThemeManager();

  // ==================创建任务管理器==================
  const taskManager = new TaskManager();

  /**
   * 异步刷新系统提示词。
   *
   * 该函数根据当前设置构建运行时系统提示词，并将其更新到查询引擎中。
   */
  const refreshSystemPrompt = async () => {
    // 构建 system-prompt 期的项目记忆段（top-N，无 per-turn query）。
    // 注意：per-turn 按本轮用户输入的相关性检索属于 QueryEngine 轮级管线，
    // 此处只做构建期注入，详见 buildRuntimeSystemPrompt 的 TODO。
    const memoryContent =
      currentSettings.memory?.enabled !== false
        ? memoryManager.buildMemoryPrompt(currentSettings.memory?.maxFiles ?? 10)
        : undefined;

    // 根据当前配置构建运行时系统提示词。skillsList 过滤掉 disableModelInvocation
    // 的技能（model 可见性：模型只看到可被它发现/调用的技能）。
    const prompt = await buildRuntimeSystemPrompt({
      customPrompt: currentSettings.systemPrompt,
      cwd: process.cwd(),
      permissionMode: currentSettings.permission.mode,
      fastMode: currentSettings.fastMode,
      effort: currentSettings.effort,
      passes: currentSettings.passes,
      memoryContent,
      skillsList: skillRegistry.modelVisibleList(),
    });
    // 将生成的提示词设置到查询引擎中
    bundle.queryEngine.setSystemPrompt(prompt);
  };

  // ==================创建slash命令注册器==================
  const commandRegistry = new CommandRegistry();

  // 命令注册器上下文
  const slashCtx: SlashCommandContext = {
    getEngine: () => bundle.queryEngine as any,
    getModel: () => currentModel,
    setModel: (m: string) => { currentModel = m; bundle.queryEngine.setModel(m); },
    getSettings: () => currentSettings,
    updateSettings: async (patch: Partial<Settings>) => {
      currentSettings = { ...currentSettings, ...patch };
      await saveSettingsCore(currentSettings);
    },
    hookExecutor: bundle.hookExecutor as HookExecutor,
    memoryManager,
    memoryDir,
    mcpManager,
    skillRegistry,
    themeManager,
    taskManager,
    sessionId,
    exitRepl: () => { },
    refreshSystemPrompt,
    getBundle: () => bundle,
    credentialStorage,
    // renderer 在下方声明,闭包在命令调用时(已初始化)解析,不存在 TDZ 问题。
    setRendererStyle: (name: string) => { renderer.setStyle(name); },
  };

  // 注册内置命令
  registerBuiltinCommandsOnRegistry(commandRegistry, slashCtx);

  // 启动时刷新一次 system prompt，把（model 可见的）技能段注入。
  // bootstrap 期的 system prompt 不带 skillsList，这里补上。
  await refreshSystemPrompt();

  // B.2 compact attachments：compact 时注入 taskFocus + session_memory checkpoint。
  bundle.queryEngine.setAttachmentsProvider(() => {
    const running = taskManager.listTasks("running");
    const taskFocus = running.length > 0
      ? running.map((t) => t.description).join("; ")
      : undefined;
    const smPath = isSessionMemoryEnabled(currentSettings)
      ? getSessionMemoryPath(process.cwd(), sessionId)
      : undefined;
    const sessionMemory = smPath
      ? sessionMemoryToCompactText(getSessionMemoryContent(smPath)) || undefined
      : undefined;
    return { taskFocus, sessionMemory };
  });

  console.log("OpenHarness Interactive Mode");
  console.log(`Model: ${currentModel}`);
  console.log(`Session: ${sessionId}`);
  console.log("Type /help for commands, or Ctrl+C to exit.\n");


  // 创建逐行读取输入流  readline 接口， 用户在 终端输入
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  // 用于保证 session 快照只保存一次，防止 exit/quit 命令路径与 rl.close 事件路径双写。
  let sessionSaved = false;
  const saveOnce = async () => {
    if (sessionSaved) return;
    sessionSaved = true;
    await saveSessionSnapshot(sessionId, bundle.queryEngine, currentModel);
  };

  const renderer = new EventRenderer({
    verbose: options.verbose,
    outputStyle: settings.outputStyle,
  });

  const processLine = async (line: string): Promise<void> => {
    const input = line.trim();
    if (!input) return;

    if (input === "exit" || input === "quit") {
      await saveOnce();
      rl.close();
      return;
    }

    if (input.startsWith("/")) {
      // 先尝试 user-invocable skill 的 /<skill>（内置命令优先，不被覆盖）。
      // 命中 → 把 skill prompt 当作一次普通输入跑一轮，再 return。
      const skillMatch = matchUserInvocableSkill(
        input,
        skillRegistry,
        (name) => commandRegistry.get(name) !== undefined,
      );
      if (skillMatch) {
        renderer.reset();
        const skillPrompt = buildSkillPrompt(skillMatch.skill, skillMatch.args);
        const overrideModel = skillMatch.skill.model;
        let completed = false;
        if (overrideModel) bundle.queryEngine.setModel(overrideModel);
        try {
          for await (const event of bundle.queryEngine.submitMessage(skillPrompt)) {
            await renderer.render(event);
          }
          completed = true;
        } catch (err) {
          if (err instanceof Error) {
            process.stderr.write(`${formatApiError(err, currentSettings)}\n`);
          }
        } finally {
          if (overrideModel) bundle.queryEngine.setModel(currentModel);
        }
        if (completed) {
          await maintainMemoryAfterTurn({
            bundle,
            settings: currentSettings,
            model: currentModel,
            memoryManager,
            memoryDir,
            sessionId,
          });
        }
        rl.prompt();
        return;
      }

      const spaceIdx = input.indexOf(" ");
      const cmdName = spaceIdx >= 0 ? input.slice(0, spaceIdx) : input;
      const argsStr = spaceIdx >= 0 ? input.slice(spaceIdx + 1) : "";
      const result = await commandRegistry.execute(cmdName, {
        args: parseCommandArgs(argsStr),
        raw: input,
      });

      if (result.output === "__EXIT__") {
        await saveOnce();
        rl.close();
        return;
      }

      if (result.output) {
        process.stdout.write(`${result.output}\n`);
      }
      if (result.error) {
        process.stderr.write(`Error: ${result.error}\n`);
      }
      rl.prompt();
      return;
    }

    renderer.reset();

    let completed = false;
    try {
      for await (const event of bundle.queryEngine.submitMessage(input)) {
        await renderer.render(event);
      }
      completed = true;
    } catch (err) {
      if (err instanceof Error) {
        process.stderr.write(`${formatApiError(err, currentSettings)}\n`);
      }
    }

    // End-of-turn memory maintenance: checkpoint, optional extraction, snapshot, auto-dream.
    if (completed) {
      await maintainMemoryAfterTurn({
        bundle,
        settings: currentSettings,
        model: currentModel,
        memoryManager,
        memoryDir,
        sessionId,
      });
    }

    rl.prompt();
  };

  rl.on("line", (line) => {
    processLine(line).catch((err) => {
      process.stderr.write(`Fatal: ${err}\n`);
    });
  });

  rl.on("close", () => {
    (async () => {
      // 个性化（C.5）：REPL 退出时 best-effort 抽取环境事实。
      try {
        updateRulesFromSession(bundle.queryEngine.getHistory());
      } catch {
        // best-effort
      }
      // Ctrl+C / EOF 退出前保存会话快照（saveOnce 保证只写一次，防止与 exit/quit 双写）。
      await saveOnce();
      process.exit(0);
    })();
  });

  rl.prompt();
}

function createSandboxStartupReporter(stream: NodeJS.WritableStream): SandboxRuntimeReporter {
  let started = false;
  return (event: SandboxRuntimeEvent) => {
    const line = formatSandboxStartupEvent(event, !started);
    if (!line) return;
    started = true;
    stream.write(`${line}\n`);
  };
}

function formatSandboxStartupEvent(event: SandboxRuntimeEvent, first: boolean): string | undefined {
  switch (event.type) {
    case "start":
      return first
        ? `Preparing ${event.backend === "docker" ? "Docker" : "SRT"} sandbox...`
        : undefined;
    case "check-availability":
      return event.backend === "docker" ? "  Docker: checking" : "  SRT: checking";
    case "check-image":
      return `  Image: checking ${event.image}`;
    case "build-image":
      return `  Image: building ${event.image} from ${event.dockerfile}`;
    case "start-container":
      return `  Container: ${event.reused ? "reusing" : "starting"} ${event.containerName}`;
    case "ready":
      return event.containerName
        ? `Sandbox ready: ${event.containerName}`
        : "Sandbox ready.";
    case "unavailable":
      return `Sandbox unavailable: ${event.reason}`;
    default:
      return undefined;
  }
}

/**
 * 启动 TUI (Terminal User Interface) 模式。
 *
 * 本进程（ohs --tui）仅作**启动器**：spawn opentui 前端（Bun 运行时）子进程，经
 * `OPENHARNESS_FRONTEND_CONFIG` 传入 daemon attach 信息。
 * 前端通过 `useServerSync` 与 daemon 通信。
 * 本进程 stdio inherit 终端给 opentui，等前端退出后 process.exit。详见 docs/tui-flow.md。
 *
 * @param settings - 当前加载的应用设置
 * @param options - 命令行选项，用于启动/attach daemon 并传给前端
 * @param prompt - 可选的初始提示词，写入 frontendConfig.initial_prompt
 * @returns Promise<void>
 */
async function runTuiMode(
  settings: Settings,
  options: MainOptions,
  prompt?: string,
): Promise<void> {
  const bun = resolveBun();
  if (!bun) {
    console.error(
      "openharness TUI 需要 Bun 运行时（opentui 原生渲染器）。\n" +
      "安装：https://bun.sh — Windows: powershell -c \"irm bun.sh/install.ps1 | iex\"\n" +
      "或使用 -p/--print 模式无 TUI 运行。",
    );
    process.exit(1);
  }

  const { spawn } = await import("node:child_process");
  const path = await import("node:path");
  const url = await import("node:url");
  const cliPath = process.argv[1];
  if (!cliPath) throw new Error("Cannot locate CLI entrypoint.");
  const daemonProbeOptions = {
    expectedVersion: VERSION,
    minimumStartedAt: (await stat(cliPath)).mtimeMs,
  };
  const {
    clearDaemonRegistry,
    readDaemonRegistry,
  } = await import("@openharness/server");

  const waitForDaemonRegistry = async (): Promise<NonNullable<ReturnType<typeof readDaemonRegistry>>> => {
    for (let i = 0; i < 40; i += 1) {
      const registry = readDaemonRegistry();
      if (registry && await probeDaemonRegistry(registry, daemonProbeOptions) === "ready") return registry;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("The OpenHarness daemon was not ready after starting ohs serve.");
  };

  let daemon = readDaemonRegistry();
  const daemonStatus = daemon ? await probeDaemonRegistry(daemon, daemonProbeOptions) : "unreachable";
  if (!daemon || daemonStatus !== "ready") {
    if (daemon && daemonStatus === "stale") terminateDaemonProcess(daemon.pid);
    clearDaemonRegistry();
    const serveArgs = [cliPath, "serve", "--register", "--host", "127.0.0.1", "--port", "0"];
    const daemonChild = spawn(process.execPath, serveArgs, { detached: true, stdio: "ignore", windowsHide: true });
    daemonChild.unref();
    daemon = await waitForDaemonRegistry();
  }

  const frontendConfig = JSON.stringify({
    daemon: {
      url: daemon.url,
      token: daemon.token,
      cwd: options.cwd ? path.resolve(options.cwd) : process.cwd(),
      model: options.model ?? settings.model,
    },
    initial_prompt: prompt ?? null,
    theme: options.theme ?? "default",
    version: VERSION,
  });

  const cliDir = path.dirname(url.fileURLToPath(import.meta.url));
  let root = cliDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(root, "apps"))) break;
    root = path.dirname(root);
  }
  const frontendDistPath = path.join(root, "apps", "frontend", "dist", "index.js");

  // 启动 TUI 前清空当前终端（含滚动历史），让 Ink 界面从干净屏幕开始渲染。
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  }

  const child = spawn(bun, [frontendDistPath], {
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      OPENHARNESS_FRONTEND_CONFIG: frontendConfig,
    },
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

// End-of-turn memory maintenance shared by interactive and print runtimes.
export function isSessionMemoryEnabled(settings: Settings): boolean {
  return settings.memory?.enabled !== false && settings.memory?.sessionMemoryEnabled !== false;
}

export function isMemoryAutoExtractEnabled(settings: Settings): boolean {
  return settings.memory?.enabled !== false && settings.memory?.autoExtractEnabled !== false;
}

export function memoryAutoExtractMaxRecords(settings: Settings): number {
  const configured = settings.memory?.autoExtractMaxRecords;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return 3;
}

export async function buildMemoryExtractionManifest(
  memoryManager: MemoryManager,
  limit = 80,
): Promise<string> {
  return (await memoryManager.getAll())
    .slice(0, limit)
    .map((entry) => {
      const name = String(entry.metadata?.name ?? entry.id);
      const description = String(entry.metadata?.description ?? "").slice(0, 80);
      return `- ${name}: ${description}`;
    })
    .join("\n");
}

async function maybeExtractMemoriesAfterTurn(options: {
  bundle: RuntimeBundle;
  settings: Settings;
  model: string;
  memoryManager: MemoryManager;
  memoryDir: string;
  cwd: string;
}): Promise<void> {
  if (!isMemoryAutoExtractEnabled(options.settings)) return;

  try {
    const history = options.bundle.queryEngine.getHistory() as any[];
    if (history.length < 2) return;

    const { extractMemoriesFromTurn } = await import("@openharness/services");
    await extractMemoriesFromTurn({
      apiClient: options.bundle.apiClient,
      model: options.model,
      messages: history,
      manager: options.memoryManager,
      existingManifest: await buildMemoryExtractionManifest(options.memoryManager),
      memoryDir: options.memoryDir,
      cwd: options.cwd,
      maxRecords: memoryAutoExtractMaxRecords(options.settings),
    });
  } catch {
    // Memory extraction is opportunistic and must never disturb the main turn.
  }
}

async function maybeRunAutoDreamAfterTurn(options: {
  settings: Settings;
  model: string;
  memoryManager: MemoryManager;
  memoryDir: string;
  cwd: string;
  sessionId?: string;
}): Promise<void> {
  if (!options.settings.memory?.enabled || !options.settings.memory.autoDreamEnabled) return;

  try {
    const { executeAutoDream, getProjectSessionDir } = await import("@openharness/services");
    const stale = await options.memoryManager.findStaleCandidates();
    const staleSection = stale.length
      ? stale
        .slice(0, 20)
        .map((entry) => `- ${entry.id}: ${entry.id}.md (importance=${entry.importance ?? 0}, updated_at=${new Date(entry.updatedAt).toISOString().slice(0, 10)})`)
        .join("\n")
      : undefined;

    await executeAutoDream({
      cwd: options.cwd,
      settings: options.settings,
      memoryDir: options.memoryDir,
      sessionDir: getProjectSessionDir(options.cwd),
      model: options.model,
      currentSessionId: options.sessionId,
      appLabel: "openharness",
      staleSection,
    });
  } catch {
    // Auto-dream is a background maintenance hook; failures stay silent here.
  }
}

async function maintainMemoryAfterTurn(options: {
  bundle: RuntimeBundle;
  settings: Settings;
  model: string;
  memoryManager: MemoryManager;
  memoryDir: string;
  sessionId?: string;
}): Promise<void> {
  const cwd = process.cwd();

  if (isSessionMemoryEnabled(options.settings)) {
    try {
      updateSessionMemoryFile(cwd, options.bundle.queryEngine.getHistory(), { sessionId: options.sessionId });
    } catch {
      // best-effort
    }
  }

  await maybeExtractMemoriesAfterTurn({
    bundle: options.bundle,
    settings: options.settings,
    model: options.model,
    memoryManager: options.memoryManager,
    memoryDir: options.memoryDir,
    cwd,
  });

  await saveSessionSnapshot(options.sessionId, options.bundle.queryEngine, options.model);

  await maybeRunAutoDreamAfterTurn({
    settings: options.settings,
    model: options.model,
    memoryManager: options.memoryManager,
    memoryDir: options.memoryDir,
    cwd,
    sessionId: options.sessionId,
  });
}

/**
 * 根据命令行选项构建 CLI 覆盖配置对象。
 * 
 * @param options - 命令行选项
 * @returns 包含 API 密钥、基础 URL、提供商、系统提示等覆盖值的对象
 */
function buildCliOverrides(options: MainOptions) {
  return {
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    provider: options.provider,
    model: options.model,
    systemPrompt: options.systemPrompt,
    permissionMode: options.permissionMode,
    maxTurns: options.maxTurns,
    dangerouslySkipPermissions: options.dangerouslySkipPermissions,
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
    effort: options.effort,
    fastMode: options.bare ? true : undefined,
    swarmWorker: options.swarmWorker,
  };
}

/**
 * 解析命令参数字符串为键值对对象。
 * 
 * 支持 key=value 格式，以及位置参数（第一个参数视为 model，其余视为 _index）。
 * 
 * @param argsStr - 原始参数字符串
 * @returns Record<string, string> 解析后的参数映射
 */
function parseCommandArgs(argsStr: string): Record<string, string> {
  const args: Record<string, string> = {};
  if (!argsStr) return args;
  const parts = argsStr.split(/\s+/);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.includes("=")) {
      const [k, ...v] = part.split("=");
      args[k!] = v.join("=");
    } else if (i === 0) {
      args["model"] = part;
      args["_0"] = part;
    } else {
      args[`_${i}`] = part;
    }
  }
  return args;
}

/**
 * 生成唯一的会话 ID。
 * 
 * 基于时间戳和随机数生成简短的唯一标识符。
 * 
 * @returns string 生成的会话 ID
 */
function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${timestamp}-${rand}`;
}

/**
 * 加载并恢复之前的会话状态。
 * 
 * 如果提供了 resumeId，则尝试加载该会话；否则查找最新的会话。
 * 如果找到有效的会话快照，则将消息加载到引擎中并设置模型。
 * 
 * @param engine - 查询引擎实例
 * @param resumeId - 可选的指定恢复会话 ID
 * @param _name - 可选的会话名称（当前未使用）
 * @returns Promise<string> 恢复后的会话 ID
 */
async function loadSessionAndResume(
  engine: any,
  resumeId?: string,
  _name?: string,
): Promise<string> {
  const { loadSessionSnapshot: loadLatest, loadSessionById } = await import("@openharness/services");
  const payload = resumeId ? loadSessionById(process.cwd(), resumeId) : loadLatest(process.cwd());
  if (payload) {
    engine.loadMessages(payload.messages);
    if (payload.model) engine.setModel(payload.model);
    const modeMsg = matchSessionMode(payload.session_mode);
    if (modeMsg) console.log(modeMsg);
    console.log(`Resumed session: ${payload.session_id} (${payload.message_count} messages)`);
    return payload.session_id;
  }

  return generateSessionId();
}

/**
 * 保存当前会话快照到磁盘。
 * 
 * 包含会话 ID、消息历史、模型信息和 Token 使用情况。
 * 如果保存失败，错误将被静默忽略。
 * 
 * @param sessionId - 会话 ID
 * @param engine - 查询引擎实例，用于获取消息和使用情况
 * @param model - 当前使用的模型名称
 * @returns Promise<void>
 */
async function saveSessionSnapshot(
  sessionId: string | undefined,
  engine: any,
  model: string,
): Promise<void> {
  if (!sessionId) return;
  try {
    // E.6 存储增强：项目分目录 + latest/id 双写 + 完整消息历史（旧实现存空数组）。
    const { saveSessionSnapshot: save } = await import("@openharness/services");
    save({
      cwd: process.cwd(),
      model,
      systemPrompt: "",
      messages: engine.getHistory(),
      usage: engine.getTotalUsage() as Record<string, unknown>,
      sessionId,
      toolMetadata: engine.getToolMetadata?.() as Record<string, unknown> | undefined,
      sessionMode: isCoordinatorMode() ? "coordinator" : undefined,
    });
  } catch {
    // silently fail
  }
}

/**
 * 三源加载技能到给定 registry：bundled（最先）→ user（getSkillsDir）→
 * project（cwd/.openharness/skills + cwd/.claude/skills）。register 是覆盖语义，
 * 同名后者覆盖前者，故顺序即优先级：bundled < user < project。
 * 1. 创建 SkillRegistry 实例
       ↓
 * 2. 调用 registerBundled() 加载内置技能
       ↓
 * 3. 创建 SkillLoader(registry)
       ↓
 * 4. 调用 loadFromDirectory("/path/to/skills")
       ↓
 * 5. 对每个 .md 文件：
       ├─ readFile() 读取内容
       ├─ parseSkillMarkdown() 解析元数据
       ├─ 构建 SkillDefinition 对象
       └─ registry.register() 注册到内存
       ↓
  * 6. 通过 registry.get(name) 查询和使用技能
 */
export async function loadSkillsThreeSources(
  skillRegistry: SkillRegistry,
  cwd: string,
  settings?: Settings,
) {
  skillRegistry.registerBundled();
  const pluginContributions = settings
    ? await loadPluginContributions(skillRegistry, settings, cwd)
    : { plugins: [], warnings: [] };
  // 插件贡献插在 bundled 之后、user/project 之前：bundled < plugin < user < project
  // （register 覆盖语义）。信任门控告警直接打到 stderr，三模式一致。
  for (const warning of pluginContributions.warnings) {
    process.stderr.write(`[plugins] ${warning}\n`);
  }
  const loader = new SkillLoader(skillRegistry);
  await loader.loadFromDirectory(getSkillsDir(), { source: "user" });
  // 从 cwd 向上遍历到 git-root，收集所有层级的 project skill 目录（低优先→高优先）。
  const projectSkillDirs = await findProjectSkillDirs(cwd);
  for (const dir of projectSkillDirs) {
    await loader.loadFromDirectory(dir, { source: "project" });
  }
  return pluginContributions;
}

/**
 * 判断输入 `/<word> [args]` 是否命中一个 user-invocable 的技能，命中则返回
 * {skill, args}（args 为去掉命令名后的剩余串），否则返回 null。
 *
 * 规则（内置命令优先）：
 * - 先解析 cmdName=`/<word>`、word=去掉前导 `/`。
 * - 若 cmdName 是内置命令（isBuiltinCommand 为 true）→ 返回 null（内置优先，
 *   不被 skill 覆盖，如 /help）。
 * - 否则按 word 命中 skill（精确名 / 小写 / 首字母大写 / commandName）且该 skill
 *   userInvocable → 返回 {skill, args}；否则 null。
 */
export function matchUserInvocableSkill(
  input: string,
  skillRegistry: SkillRegistry,
  isBuiltinCommand: (name: string) => boolean,
): { skill: SkillDefinition; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const spaceIdx = trimmed.indexOf(" ");
  const cmdName = spaceIdx >= 0 ? trimmed.slice(0, spaceIdx) : trimmed;
  const args = spaceIdx >= 0 ? trimmed.slice(spaceIdx + 1).trim() : "";
  const word = cmdName.slice(1);
  if (!word) return null;

  // 内置命令优先：不被 skill 覆盖。
  if (isBuiltinCommand(cmdName)) return null;

  // 按名解析 skill（对齐 Skill 工具的容错取法），并匹配 commandName。
  const skill = skillRegistry.resolve(word);
  if (!skill || !skill.userInvocable) return null;

  return { skill, args };
}

/**
 * 把一个 user-invocable 技能构造成一次注入引擎的 prompt：skill.content
 * 为主体，args 非空时在末尾追加一段 `## Arguments`。
 */
export function buildSkillPrompt(skill: SkillDefinition, args: string): string {
  const base = skill.content;
  const trimmedArgs = args.trim();
  if (!trimmedArgs) return base;
  return `${base.trimEnd()}\n\n## Arguments\n${trimmedArgs}\n`;
}

/**
 * 构建"给模型看"的技能列表（进 system prompt 的 skillsList 来源）。
 *
 * @deprecated 薄封装，直接转发 {@link SkillRegistry.modelVisibleList}。新代码请
 * 直接调用 `skillRegistry.modelVisibleList()`。保留此导出仅为兼容既有测试/调用。
 */
export function buildModelVisibleSkillsList(
  skillRegistry: SkillRegistry,
): Array<{ name: string; description: string }> {
  return skillRegistry.modelVisibleList();
}

/**
 * 构建发给前端的斜杠命令列表。命令注册名本身已带前导 "/"（如 "/help"），
 * 因此不要再额外加 "/"（否则会出现 "//help" 双斜杠 bug）。
 *
 * 若传入 skillRegistry，则追加 user-invocable 技能的 `/<name>`（去重，内置命令
 * 名优先：与已有命令同名的 skill 不重复加入）。注意命令列表是给用户看的，
 * user-invocable 即可出现，即使 disableModelInvocation（那只挡模型不挡用户）。
 */
export function buildSlashCommandList(
  registry: CommandRegistry,
  skillRegistry?: SkillRegistry,
): string[] {
  const names = registry.list().map((c) => c.name);
  if (!skillRegistry) return names;

  const seen = new Set(names);
  for (const skill of skillRegistry.getAll()) {
    if (!skill.userInvocable) continue;
    const cmd = `/${skill.commandName ?? skill.name}`;
    if (seen.has(cmd)) continue; // 内置命令名优先，不重复
    seen.add(cmd);
    names.push(cmd);
  }
  return names;
}

/**
 * 构建发给前端的斜杠命令明细（名称 + 描述），供补全浮窗 / 命令面板展示。
 * 命名与去重规则同 {@link buildSlashCommandList}：内置命令优先，追加 user-invocable 技能。
 */
export function buildSlashCommandDetails(
  registry: CommandRegistry,
  skillRegistry?: SkillRegistry,
): Array<{ name: string; description: string }> {
  const details = registry.list().map((c) => ({ name: c.name, description: c.description ?? "" }));
  if (!skillRegistry) return details;

  const seen = new Set(details.map((d) => d.name));
  for (const skill of skillRegistry.getAll()) {
    if (!skill.userInvocable) continue;
    const cmd = `/${skill.commandName ?? skill.name}`;
    if (seen.has(cmd)) continue;
    seen.add(cmd);
    details.push({ name: cmd, description: skill.description ?? "" });
  }
  return details;
}
