import { randomUUID } from "node:crypto";
import type { ContentBlock, RuntimeBundle, Settings } from "@openharness/core";
import { loadSettings, getProjectMemoryDir, getSkillsDir, getDataDir } from "@openharness/core";
import { CommandRegistry } from "@openharness/commands";
import { MemoryManager } from "@openharness/memory";
import { SkillRegistry, SkillLoader, findProjectSkillDirs, type SkillDefinition } from "@openharness/skills";
import { buildRuntimeSystemPrompt } from "@openharness/prompts";
import { resolveToolPath } from "@openharness/tools";
import { CredentialStorage } from "@openharness/auth";
import { bootstrap } from "../runtime";
import { loadPluginContributions, registerPluginHooks, registerPluginTools, getLoadedPlugins } from "../plugin-contributions";
import { updateRulesFromSession } from "@openharness/personalization";
import { updateSessionMemoryFile } from "@openharness/services";
import { isSwarmWorker } from "@openharness/swarm";
import { isCoordinatorMode } from "@openharness/coordinator";
import { buildSwarmWorkerPermissionPrompt } from "../swarm-permission";
import { EventRenderer } from "../renderer";
import { formatApiError } from "../format-error";
import { resolveBun } from "./resolveBun";
import { VERSION } from "../version";
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

export type MainEntryMode = "dry-run" | "task-worker" | "tui" | "print";

/** Pure entry routing for tests and mainAction. */
export function resolveMainEntryMode(
  prompt: string | undefined,
  options: Pick<MainOptions, "dryRun" | "taskWorker" | "tui" | "print">,
): MainEntryMode {
  if (options.dryRun) return "dry-run";
  if (options.taskWorker) return "task-worker";
  if (options.tui) return "tui";
  if (options.print && prompt) return "print";
  if (prompt) return "print";
  return "tui";
}

function rejectInteractiveContinueResume(options: MainOptions): void {
  if (!options.continue && !options.resume) return;
  console.error(
    "`--continue` / `--resume` are not available for interactive TUI.\n" +
      "Use TUI `/sessions` or `/resume` for daemon sessions.\n" +
      "Example: ohs",
  );
  process.exit(1);
}

/**
 * 应用程序的主入口点，根据提供的选项和提示决定执行模式。
 *
 * 模式优先级：
 * 1. dry-run / task-worker
 * 2. TUI（`--tui` 或默认无 prompt）— 启动/attach daemon，再 spawn opentui 前端
 * 3. print（`-p` 或存在 prompt）— ensure daemon + Session API headless client
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

  const mode = resolveMainEntryMode(prompt, options);

  if (mode === "dry-run") {
    const { runDryRun } = await import("../dry-run");
    await runDryRun(settings, options);
    return;
  }

  if (mode === "task-worker") {
    await runTaskWorker(settings, options);
    return;
  }

  if (mode === "print") {
    await runPrintMode(settings, prompt!, options);
    return;
  }

  rejectInteractiveContinueResume(options);
  await runTuiMode(settings, options, prompt);
}

/**
 * 用户 headless print：ensure daemon + Session API（见 `print-session.ts`）。
 */
async function runPrintMode(
  settings: Settings,
  prompt: string,
  options: MainOptions,
): Promise<void> {
  const { runPrintSession } = await import("../print-session.js");
  const path = await import("node:path");
  await runPrintSession(settings, prompt, {
    model: options.model ?? settings.model,
    cwd: options.cwd ? path.resolve(options.cwd) : process.cwd(),
    verbose: options.verbose,
    outputFormat: options.outputFormat,
    dangerouslySkipPermissions: options.dangerouslySkipPermissions,
    permissionMode: options.permissionMode,
    maxTurns: options.maxTurns ?? settings.maxTurns,
    systemPrompt: options.systemPrompt,
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
    effort: options.effort,
    continue: options.continue,
    resume: options.resume,
  });
}

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

/**
 * 启动 TUI (Terminal User Interface) 模式。
 *
 * 本进程仅作**启动器**（默认 `ohs` 与显式 `ohs --tui`）：spawn opentui 前端（Bun 运行时）子进程，经
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
  const { ensureLocalDaemon } = await import("../ensure-daemon.js");
  const daemon = await ensureLocalDaemon();

  const frontendConfig = JSON.stringify({
    daemon: {
      url: daemon.url,
      token: daemon.token,
      cwd: options.cwd ? path.resolve(options.cwd) : process.cwd(),
      model: options.model ?? settings.model,
      permissionMode: options.permissionMode ?? settings.permission.mode,
      maxTurns: options.maxTurns ?? settings.maxTurns,
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

function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${timestamp}-${rand}`;
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
