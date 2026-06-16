import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import type { Settings, StreamEvent } from "@openharness/core";
import { loadSettings, saveSettings as saveSettingsCore, getSkillsDir } from "@openharness/core";
import { CommandRegistry } from "@openharness/commands";
import { HookExecutor } from "@openharness/hooks";
import { McpClientManager } from "@openharness/mcp";
import { MemoryManager } from "@openharness/memory";
import { SkillRegistry, SkillLoader, findProjectSkillDirs, type SkillDefinition } from "@openharness/skills";
import { ThemeManager } from "@openharness/themes";
import { TaskManager, getTaskManager } from "@openharness/services";
import {
  applyTaskEventToSnapshotMap,
  snapshotMapToList,
  type SwarmTeammateSnapshot,
} from "../swarm-status";
import { buildRuntimeSystemPrompt } from "@openharness/prompts";
import { computeToolDiff } from "@openharness/tools";
import { CredentialStorage } from "@openharness/auth";
import { bootstrap } from "../runtime";
import { loadPluginContributions, registerPluginHooks, mergePluginMcpServers, registerPluginTools, getLoadedPlugins } from "../plugin-contributions";
import { updateRulesFromSession } from "@openharness/personalization";
import { updateSessionMemoryFile, getSessionMemoryPath, getSessionMemoryContent, sessionMemoryToCompactText } from "@openharness/services";
import { isSwarmWorker } from "@openharness/swarm";
import { isCoordinatorMode, getCoordinatorTools, matchSessionMode } from "@openharness/coordinator";
import { buildSwarmWorkerPermissionPrompt } from "../swarm-permission";
import { EventRenderer } from "../renderer";
import { formatApiError } from "../format-error";
import { registerBuiltinCommandsOnRegistry, type SlashCommandContext } from "./slash-commands";
import { resolveBun } from "./resolveBun";
import { VERSION } from "../version";
import { join } from "node:path";
import { existsSync } from "node:fs";

type BackendHostEvent = {
  type: string;
  message?: string | null;
  item?: {
    role: string;
    text: string;
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    is_error?: boolean;
  } | null;
  state?: Record<string, unknown> | null;
  tasks?: Array<{ id: string; type: string; status: string; description: string; metadata: Record<string, string> }> | null;
  mcp_servers?: unknown[] | null;
  bridge_sessions?: unknown[] | null;
  commands?: string[] | null;
  /** 斜杠命令明细（名称 + 描述），供前端补全浮窗/命令面板展示 */
  command_details?: Array<{ name: string; description: string }> | null;
  modal?: Record<string, unknown> | null;
  select_options?: Array<{ value: string; label: string; description?: string }> | null;
  tool_name?: string | null;
  tool_input?: Record<string, unknown> | null;
  output?: string | null;
  is_error?: boolean | null;
  todo_markdown?: string | null;
  plan_mode?: string | null;
  swarm_teammates?: unknown[] | null;
  swarm_notifications?: unknown[] | null;
};

type FrontendRequest = {
  type: string;
  line?: string | null;
  request_id?: string | null;
  allowed?: boolean | null;
  /** 权限确认的批准范围："once"（本次）| "session"（整个会话该工具放行）。 */
  scope?: string | null;
  answer?: string | null;
  /** delete_session 请求携带的会话 ID。 */
  session_id?: string | null;
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
  backendOnly?: boolean;
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

interface SessionSnapshot {
  id: string;
  name?: string;
  messages: Array<{ type: string; content: string }>;
  model: string;
  createdAt: number;
  updatedAt: number;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * 应用程序的主入口点，根据提供的选项和提示决定执行模式。
 * 
 * 该函数首先处理设置覆盖，然后根据标志位依次尝试以下模式：
 * 1. 后端主机模式 (backendOnly) — TUI 的前端会 spawn 此模式；也可单独调试
 * 2. TUI 交互模式 (tui) — spawn Ink 前端，前端再 spawn backend-only（见 docs/tui-flow.md）
 * 3. 打印/非交互模式 (print 或存在 prompt)
 * 4. REPL 交互模式 (默认)
 * 
 * @param prompt - 用户输入的初始提示词，如果未提供则进入交互模式
 * @param options - 命令行选项配置对象，包含模型、权限、路径等设置
 * @returns Promise<void>
 */
export async function mainAction(
  prompt: string | undefined,
  options: MainOptions,
): Promise<void> {
  const overrides: Partial<Settings> = {};
  if (options.model) overrides.model = options.model;
  if (options.apiFormat) overrides.apiFormat = options.apiFormat as Settings["apiFormat"];
  if (options.permissionMode) overrides.permission = { mode: options.permissionMode as Settings["permission"]["mode"] };
  if (options.maxTurns) overrides.maxTurns = options.maxTurns;

  const settings = await loadSettings(overrides);

  if (options.cwd) {
    process.chdir(options.cwd);
  }

  if (options.debug) {
    console.log("Settings:", JSON.stringify(settings, null, 2));
  }

  // dry-run：预览解析后的运行时配置 + readiness，不创建 client、不调模型。
  // 放在 backendOnly/tui/print 之前，让任何模式下加 --dry-run 都只预览不执行。
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

  if (options.backendOnly) {
    await runBackendHost(settings, options);
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
  });
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
    process.exit(1);
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
  });
  // 插件 hooks 贡献：bootstrap 后才有 HookExecutor，经缓存二段注册（C.1-R3）。
  registerPluginHooks(bundle.hookExecutor);

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
  });
  // 插件 hooks 贡献：bootstrap 后才有 HookExecutor，经缓存二段注册（C.1-R3）。
  registerPluginHooks(bundle.hookExecutor);
  // C.1 插件 tools_dir：动态加载插件工具目录，注册进 toolRegistry。
  await registerPluginTools(bundle.toolRegistry, getLoadedPlugins());
  // C.4 coordinator 模式：限制工具集为 Agent/SendMessage/TaskStop。
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

  const { homedir } = await import("node:os");
  const memoryDir = join(homedir(), ".openharness", "data", "memory");

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
    const smPath = getSessionMemoryPath(process.cwd(), sessionId);
    const sessionMemory = sessionMemoryToCompactText(getSessionMemoryContent(smPath)) || undefined;
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
        if (overrideModel) bundle.queryEngine.setModel(overrideModel);
        try {
          for await (const event of bundle.queryEngine.submitMessage(skillPrompt)) {
            await renderer.render(event);
          }
        } catch (err) {
          if (err instanceof Error) {
            process.stderr.write(`${formatApiError(err, currentSettings)}\n`);
          }
        } finally {
          if (overrideModel) bundle.queryEngine.setModel(currentModel);
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

    try {
      for await (const event of bundle.queryEngine.submitMessage(input)) {
        await renderer.render(event);
      }
    } catch (err) {
      if (err instanceof Error) {
        process.stderr.write(`${formatApiError(err, currentSettings)}\n`);
      }
    }

    // 会话记忆 checkpoint（E.6）：每轮后写确定性快照，compact 连续性的底座。
    try {
      updateSessionMemoryFile(process.cwd(), bundle.queryEngine.getHistory(), { sessionId });
    } catch {
      // best-effort
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

/**
 * 启动 TUI (Terminal User Interface) 模式。
 *
 * 本进程（ohs --tui）仅作**启动器**：spawn opentui 前端（Bun 运行时）子进程，经
 * `OPENHARNESS_FRONTEND_CONFIG` 传入 `backend_command`（含 `--backend-only` 及 CLI flags）。
 * 由前端 `useBackendSession` 再 spawn BackendHost 子进程；OHJSON 协议在前后端 pipe 间通信。
 * 本进程 stdio inherit 终端给 opentui，等前端退出后 process.exit。详见 docs/tui-flow.md。
 *
 * @param settings - 当前加载的应用设置
 * @param options - 命令行选项，写入 backend_command 供 BackendHost 使用
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

  const args = [cliPath, "--backend-only"];
  if (options.model) args.push("-m", options.model);
  if (options.provider) args.push("--provider", options.provider);
  if (options.permissionMode) args.push("--permission-mode", options.permissionMode);
  if (options.maxTurns) args.push("--max-turns", String(options.maxTurns));
  if (options.systemPrompt) args.push("-s", options.systemPrompt);
  if (options.apiKey) args.push("--api-key", options.apiKey);
  if (options.baseUrl) args.push("--base-url", options.baseUrl);
  if (options.apiFormat) args.push("--api-format", options.apiFormat);
  if (options.theme) args.push("--theme", options.theme);
  if (options.cwd) args.push("--cwd", options.cwd);
  if (options.effort) args.push("--effort", options.effort);
  if (options.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
  if (options.allowedTools) args.push("--allowed-tools", options.allowedTools);
  if (options.disallowedTools) args.push("--disallowed-tools", options.disallowedTools);
  if (options.bare) args.push("--bare");

  const frontendConfig = JSON.stringify({
    backend_command: [process.execPath, ...args],
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
    env: {
      ...process.env,
      OPENHARNESS_FRONTEND_CONFIG: frontendConfig,
    },
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

/**
 * 运行 BackendHost（`ohs --backend-only`）。
 *
 * TUI 下由 Ink 前端 spawn 的本进程；也可单独运行用于协议调试。经 stdin/stdout
 * 与前端通信：出站 `OHJSON:{...}\n`，入站 JSON 行（FrontendRequest）。负责
 * bootstrap、权限 modal（askPermission）、斜杠命令本地路由、QueryEngine 流式 emit。
 * emit 带 writeLock 串行化。详见 docs/tui-flow.md 与 docs/permission-flow.md。
 *
 * @param settings - 当前加载的应用设置
 * @param options - 命令行选项，用于初始化运行时环境
 * @returns Promise<void>
 */
async function runBackendHost(
  settings: Settings,
  options: MainOptions,
): Promise<void> {
  // Mutable copy — updated by /permissions, /model etc. so mode changes take effect immediately.
  let currentSettings = settings;
  const permissionRequests = new Map<string, Promise<boolean> & { resolve: (v: boolean) => void }>();
  const questionRequests = new Map<string, Promise<string> & { resolve: (v: string) => void }>();
  // 会话级批准：用户对某工具选过"整个会话"后，该工具后续 ask 直接放行（按工具名粒度）。
  const approvedForSessionTools = new Set<string>();
  // request_id → toolName，供 permission_response 在 scope==="session" 时登记会话批准。
  const pendingPermissionTools = new Map<string, string>();
  let busy = false;
  let interruptRequested = false;
  let running = true;
  // 当前会话 ID：每轮对话后保存快照供 /sessions 列表与恢复；/resume 后切到目标 id。
  let currentSessionId = generateSessionId();
  const lastToolInputs = new Map<string, Record<string, unknown>>();

  const writeLock = { locked: false, queue: [] as Array<() => void> };
  const acquireWrite = async (): Promise<void> => {
    if (!writeLock.locked) { writeLock.locked = true; return; }
    return new Promise<void>((resolve) => { writeLock.queue.push(resolve); });
  };
  const releaseWrite = (): void => {
    if (writeLock.queue.length > 0) {
      writeLock.queue.shift()!();
    } else {
      writeLock.locked = false;
    }
  };

  const emit = async (event: BackendHostEvent): Promise<void> => {
    await acquireWrite();
    try {
      const payload = `OHJSON:${JSON.stringify(event)}\n`;
      const buf = (process.stdout as any).buffer;
      if (buf && typeof buf.write === "function" && typeof buf.flush === "function") {
        buf.write(payload);
        buf.flush();
      } else {
        process.stdout.write(payload);
      }
    } finally {
      releaseWrite();
    }
  };

  // ── swarm_status: 订阅 teammate 任务生命周期，点亮前端 SwarmPanel ──
  // 关键：subprocess swarm 后端（runtime.ts bootstrap 里）用的是全局
  // getTaskManager() 单例，而非下方 host 局部 new 的 TaskManager。必须订阅同一
  // 个单例，才能收到 teammate 任务的 created/completed 事件。
  const swarmSnapshots = new Map<string, SwarmTeammateSnapshot>();
  const swarmTaskManager = getTaskManager();
  const emitSwarmStatus = async (): Promise<void> => {
    // listener 回调是 sync，这里 fire-and-forget；emit 自身带 writeLock 串行化，
    // 不会与主循环 emit 抢锁出问题。错误被吞，绝不冒泡成未处理拒绝。
    try {
      await emit({
        type: "swarm_status",
        swarm_teammates: snapshotMapToList(swarmSnapshots),
      });
    } catch {
      /* emit 失败不应影响 teammate 执行 */
    }
  };
  const unregisterSwarmListener = swarmTaskManager.registerTaskListener((task, event) => {
    const changed = applyTaskEventToSnapshotMap(swarmSnapshots, task, event);
    if (changed) void emitSwarmStatus();
  });

  const askPermission = async (
    toolName: string,
    reason?: string,
    input?: Record<string, unknown>,
  ): Promise<boolean> => {
    // full_auto 模式：直接放行，不弹权限框（尊重运行时 /permissions full_auto 变更）。
    if (currentSettings.permission?.mode === "full_auto") return true;
    // 会话级批准：之前对该工具选过"整个会话"则直接放行，不再弹框。
    if (approvedForSessionTools.has(toolName)) return true;

    const requestId = randomUUID({ disableEntropyCache: true }).replace(/-/g, "");

    // Edit/Write 改文件前算 unified diff 预览；失败/无改动则不带 diff，回退普通确认。
    let diff: string | null = null;
    let diffPath: string | null = null;
    if (input) {
      try {
        const preview = await computeToolDiff(toolName, input);
        if (preview) {
          diff = preview.diff;
          diffPath = preview.path;
        }
      } catch {
        /* 预览计算失败不应阻断权限确认 */
      }
    }

    let resolve!: (v: boolean) => void;
    const promise = new Promise<boolean>((r) => { resolve = r; }) as Promise<boolean> & { resolve: (v: boolean) => void };
    promise.resolve = resolve;
    permissionRequests.set(requestId, promise);
    pendingPermissionTools.set(requestId, toolName);
    await emit({
      type: "modal_request",
      modal: {
        kind: "permission",
        request_id: requestId,
        tool_name: toolName,
        reason: reason ?? null,
        diff,
        diff_path: diffPath,
      },
    });
    try {
      return await promise;
    } finally {
      permissionRequests.delete(requestId);
      pendingPermissionTools.delete(requestId);
    }
  };

  // 加载并注册技能（三源：bundled < user < project）
  const skillRegistry = new SkillRegistry();
  await loadSkillsThreeSources(skillRegistry, process.cwd(), settings);

  const credentialStorage = new CredentialStorage();

  const bundle = await bootstrap({
    settings,
    cliOverrides: buildCliOverrides(options),
    permissionPrompt: askPermission,
    skillRegistry,
    credentialStorage,
  });
  // 插件 hooks 贡献：bootstrap 后才有 HookExecutor，经缓存二段注册（C.1-R3）。
  registerPluginHooks(bundle.hookExecutor);
  // C.1 插件 tools_dir：动态加载插件工具目录，注册进 toolRegistry。
  await registerPluginTools(bundle.toolRegistry, getLoadedPlugins());
  // C.4 coordinator 模式：限制工具集为 Agent/SendMessage/TaskStop。
  if (isCoordinatorMode()) {
    bundle.queryEngine.setAllowedTools(getCoordinatorTools());
  }

  const commandRegistry = new CommandRegistry();
  const mcpManager = new McpClientManager();
  // BackendHost MCP 连接：与 REPL 对称，合并插件 MCP 后 connectAll，
  // 已连接 server 的工具以 mcp__<server>__<tool> 形式注册进 toolRegistry。
  const mcpServersHost = mergePluginMcpServers(currentSettings.mcpServers);
  if (Object.keys(mcpServersHost).length > 0) {
    await mcpManager.connectAll(mcpServersHost).catch(() => { });
  }
  for (const tool of mcpManager.getAsToolDefinitions()) {
    bundle.toolRegistry.register(tool);
  }
  bundle.queryEngine.setMcpManager(mcpManager);
  const { homedir } = await import("node:os");
  const memoryDir = join(homedir(), ".openharness", "data", "memory");
  const memoryManager = new MemoryManager(1000, memoryDir);
  const memoryFile = join(memoryDir, "memory.json");
  await memoryManager.loadFromFile(memoryFile).catch(() => { });
  const themeManager = new ThemeManager();
  const taskManager = new TaskManager();

  const slashCtx: SlashCommandContext = {
    getEngine: () => bundle.queryEngine as any,
    getModel: () => currentSettings.model,
    setModel: (m: string) => { bundle.queryEngine.setModel(m); },
    getSettings: () => currentSettings,
    updateSettings: async (patch: Partial<Settings>) => {
      currentSettings = { ...currentSettings, ...patch };
      // Keep bundle.settings in sync so processLineForHost state_snapshots reflect new mode.
      bundle.settings = currentSettings;
      await emit({
        type: "state_snapshot",
        state: buildStatePayload(currentSettings, mcpManager),
        mcp_servers: [],
        bridge_sessions: [],
      });
    },
    hookExecutor: bundle.hookExecutor as HookExecutor,
    memoryManager,
    memoryDir,
    mcpManager,
    skillRegistry,
    themeManager,
    taskManager,
    sessionId: currentSessionId,
    exitRepl: () => { },
    refreshSystemPrompt: async () => { },
    getBundle: () => bundle,
    credentialStorage,
  };
  registerBuiltinCommandsOnRegistry(commandRegistry, slashCtx);

  const commands = buildHostCommandList(commandRegistry, skillRegistry);

  await emit({
    type: "ready",
    state: buildStatePayload(settings, mcpManager),
    tasks: [],
    mcp_servers: [],
    bridge_sessions: [],
    commands,
    command_details: buildHostCommandDetails(commandRegistry, skillRegistry),
  });
  await emit({
    type: "state_snapshot",
    state: buildStatePayload(settings, mcpManager),
    mcp_servers: [],
    bridge_sessions: [],
  });

  // B.2 compact attachments：compact 时注入 taskFocus + session_memory checkpoint。
  bundle.queryEngine.setAttachmentsProvider(() => {
    const running = taskManager.listTasks("running");
    const taskFocus = running.length > 0
      ? running.map((t) => t.description).join("; ")
      : undefined;
    const smPath = getSessionMemoryPath(process.cwd(), currentSessionId);
    const sessionMemory = sessionMemoryToCompactText(getSessionMemoryContent(smPath)) || undefined;
    return { taskFocus, sessionMemory };
  });

  // B.5 per-turn 相关记忆检索：与 REPL 模式对称，每轮按用户输入相关性检索记忆。
  bundle.queryEngine.setMemoryRetriever(async (userInput: string) => {
    if (currentSettings.memory?.enabled === false) return null;
    const maxEntries = currentSettings.memory?.maxFiles ?? 10;
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

  const rl = readline.createInterface({ input: process.stdin });
  const requestQueue: FrontendRequest[] = [];
  let requestResolve: ((req: FrontendRequest | null) => void) | null = null;

  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const request = JSON.parse(trimmed) as FrontendRequest;
      if (request.type === "interrupt") {
        interruptRequested = true;
        return;
      }
      // permission_response / question_response 在 processLineForHost 持有主循环期间到达。
      // 此时 requestResolve 为 null，若入队则主循环无法消费（死锁）。
      // 直接在此 resolve 对应 Promise，让 askPermission / askQuestion 继续执行。
      if (request.type === "permission_response") {
        const rid = request.request_id;
        if (rid && permissionRequests.has(rid)) {
          const tool = pendingPermissionTools.get(rid);
          pendingPermissionTools.delete(rid);
          const allowed = !!request.allowed;
          if (allowed && request.scope === "session" && tool) {
            approvedForSessionTools.add(tool);
          }
          permissionRequests.get(rid)!.resolve(allowed);
          permissionRequests.delete(rid);
        }
        return;
      }
      if (request.type === "question_response") {
        const rid = request.request_id;
        if (rid && questionRequests.has(rid)) {
          questionRequests.get(rid)!.resolve(request.answer ?? "");
          questionRequests.delete(rid);
        }
        return;
      }
      if (requestResolve) {
        requestResolve(request);
        requestResolve = null;
      } else {
        requestQueue.push(request);
      }
    } catch (exc) {
      emit({ type: "error", message: `Invalid request: ${exc}` });
    }
  });

  rl.on("close", () => {
    running = false;
    if (requestResolve) {
      requestResolve(null);
      requestResolve = null;
    }
    // stdin 关闭（前端退出 / Ctrl+C）：把所有挂起的权限/问题请求当拒绝/空串处理，
    // 防止 askPermission / askQuestion 的 Promise 永远悬挂导致进程卡死。
    for (const [, promise] of permissionRequests) {
      promise.resolve(false);
    }
    permissionRequests.clear();
    pendingPermissionTools.clear();
    for (const [, promise] of questionRequests) {
      promise.resolve("");
    }
    questionRequests.clear();
  });

  const nextRequest = (): Promise<FrontendRequest | null> => {
    if (requestQueue.length > 0) return Promise.resolve(requestQueue.shift()!);
    if (!running) return Promise.resolve(null);
    return new Promise<FrontendRequest | null>((resolve) => { requestResolve = resolve; });
  };

  while (running) {
    const request = await nextRequest();
    if (!request || request.type === "shutdown") {
      // 个性化（C.5）：backend 关停时 best-effort 抽取环境事实。
      try {
        updateRulesFromSession(bundle.queryEngine.getHistory());
      } catch {
        // best-effort
      }
      await emit({ type: "shutdown" });
      break;
    }
    if (request.type === "list_sessions") {
      let options: Array<{ value: string; label: string; description?: string }> = [];
      try {
        const { listSessionSnapshots } = await import("@openharness/services");
        options = listSessionSnapshots(process.cwd()).map((s) => ({
          value: s.session_id,
          label: s.summary || "(empty session)",
          description: formatSessionMeta(s),
        }));
      } catch {
        // best-effort：列不出来就给空列表
      }
      if (options.length === 0) {
        // 前端会丢弃空 select_options 且 Home 路由不渲染 transcript，故用 error → toast 可见。
        await emit({ type: "error", message: "暂无已保存的会话" });
        continue;
      }
      await emit({
        type: "select_request",
        modal: { kind: "select", title: "Sessions", submit_prefix: "/resume " },
        select_options: options,
      });
      continue;
    }
    if (request.type === "delete_session") {
      const sid = request.session_id;
      if (sid) {
        try {
          const { deleteSessionById, listSessionSnapshots } = await import("@openharness/services");
          deleteSessionById(process.cwd(), sid);
          // 删除后刷新列表，继续显示对话框；列表为空则关闭
          const options = listSessionSnapshots(process.cwd()).map((s) => ({
            value: s.session_id,
            label: s.summary || "(empty session)",
            description: formatSessionMeta(s),
          }));
          if (options.length === 0) {
            await emit({ type: "error", message: "已删除，暂无其他会话" });
          } else {
            await emit({
              type: "select_request",
              modal: { kind: "select", title: "Sessions", submit_prefix: "/resume " },
              select_options: options,
            });
          }
        } catch {
          await emit({ type: "error", message: "删除会话失败" });
        }
      }
      continue;
    }
    if (request.type !== "submit_line") {
      await emit({ type: "error", message: `Unknown request type: ${request.type}` });
      continue;
    }
    if (busy) {
      await emit({ type: "error", message: "Session is busy" });
      continue;
    }
    const line = (request.line ?? "").trim();
    if (!line) continue;

    // /resume <id>：恢复历史会话到当前引擎，并把消息回放成 transcript（在通用 slash
    // 路由前拦截——host 版 /resume 只 loadMessages 不 emit transcript，前端会看不到历史）。
    const resumeMatch = line.match(/^\/resume\s+(\S+)$/);
    if (resumeMatch?.[1]) {
      const resumeId = resumeMatch[1];
      try {
        const { loadSessionById } = await import("@openharness/services");
        const payload = loadSessionById(process.cwd(), resumeId);
        if (!payload) {
          await emit({ type: "transcript_item", item: { role: "system", text: `Session not found: ${resumeId}` } });
          await emit({ type: "line_complete" });
          continue;
        }
        bundle.queryEngine.loadMessages(payload.messages as any);
        if (payload.model) bundle.queryEngine.setModel(payload.model);
        currentSessionId = payload.session_id;
        await emit({ type: "clear_transcript" });
        for (const item of messagesToTranscriptItems(payload.messages)) {
          await emit({ type: "transcript_item", item });
        }
        await emit({
          type: "transcript_item",
          item: { role: "system", text: `Resumed session ${payload.session_id} (${payload.message_count} messages)` },
        });
        await emit({
          type: "state_snapshot",
          state: buildStatePayload(currentSettings, mcpManager),
          mcp_servers: [],
          bridge_sessions: [],
        });
      } catch (err) {
        await emit({ type: "error", message: `Failed to resume: ${err instanceof Error ? err.message : String(err)}` });
      }
      await emit({ type: "line_complete" });
      continue;
    }

    // 先尝试 user-invocable skill 的 /<skill>（内置命令优先）。命中 → 注入 skill
    // prompt 跑一轮（emit 事件），与普通输入同路径；busy 标志处理与下方一致。
    if (line.startsWith("/")) {
      const skillMatch = matchUserInvocableSkill(
        line,
        skillRegistry,
        (name) => commandRegistry.get(name) !== undefined,
      );
      if (skillMatch) {
        busy = true;
        interruptRequested = false;
        const overrideModel = skillMatch.skill.model;
        if (overrideModel) bundle.queryEngine.setModel(overrideModel);
        try {
          const skillPrompt = buildSkillPrompt(skillMatch.skill, skillMatch.args);
          await processLineForHost(skillPrompt, bundle, emit, lastToolInputs, currentSettings, () => interruptRequested);
        } catch (err) {
          const msg = err instanceof Error ? formatApiError(err, settings) : String(err);
          await emit({ type: "error", message: msg });
        } finally {
          busy = false;
          if (overrideModel) bundle.queryEngine.setModel(currentSettings.model);
        }
        await saveSessionSnapshot(currentSessionId, bundle.queryEngine, currentSettings.model);
        continue;
      }
    }

    // 斜杠命令在后端本地路由（对齐 REPL），不发给模型。
    if (line.startsWith("/")) {
      await emit({ type: "transcript_item", item: { role: "user", text: line } });
      const outcome = await runHostSlashCommand(line, commandRegistry);
      if (outcome.exit) {
        await emit({ type: "shutdown" });
        running = false;
        break;
      }
      if (outcome.clearTranscript) {
        await emit({ type: "clear_transcript" });
      }
      if (outcome.output) {
        await emit({ type: "transcript_item", item: { role: "system", text: outcome.output } });
      }
      if (outcome.error) {
        await emit({ type: "transcript_item", item: { role: "system", text: `Error: ${outcome.error}` } });
      }
      await emit({ type: "line_complete" });
      continue;
    }

    busy = true;
    interruptRequested = false;
    try {
      await processLineForHost(line, bundle, emit, lastToolInputs, currentSettings, () => interruptRequested);
    } catch (err) {
      const msg = err instanceof Error ? formatApiError(err, settings) : String(err);
      await emit({ type: "error", message: msg });
    } finally {
      busy = false;
    }
    // session_memory checkpoint：compact 连续性底座，与 REPL 模式对称。
    try {
      updateSessionMemoryFile(process.cwd(), bundle.queryEngine.getHistory(), { sessionId: currentSessionId });
    } catch {
      // best-effort
    }
    await saveSessionSnapshot(currentSessionId, bundle.queryEngine, currentSettings.model);
  }

  // 退出/shutdown：注销 swarm listener，避免泄漏与对已关闭 stdout 的写入。
  unregisterSwarmListener();
  rl.close();
}

/**
 * 处理后端主机模式下接收到的单行用户输入。
 * 
 * 该函数将用户消息提交给查询引擎，监听流式事件，并将相应的事件类型
 * （如文本增量、工具使用、错误等转换为后端协议事件并通过 emit 发送。
 * 它还特别处理 TodoWrite 工具的结果以更新待办事项列表显示。
 * 
 * @param line - 用户输入的原始文本行
 * @param bundle - 包含查询引擎和其他核心服务的运行时Bundle对象
 * @param emit - 用于向后端发送事件的回调函数
 * @param lastToolInputs - 存储最近一次工具调用输入的Map，用于后续处理
 * @returns Promise<void>
 */
/** /sessions 列表条目的副标题：相对日期 + 消息数 + 模型。 */
export function formatSessionMeta(s: { created_at: number; message_count: number; model: string }): string {
  const parts: string[] = [];
  if (s.created_at) {
    // created_at 是 Unix 秒；转本地日期时间，精简显示。
    const d = new Date(s.created_at * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    parts.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`);
  }
  parts.push(`${s.message_count} msg${s.message_count === 1 ? "" : "s"}`);
  if (s.model) parts.push(s.model);
  return parts.join(" · ");
}

/**
 * 把已存储的会话消息（Anthropic Message[]）回放成前端 TranscriptItem[]。
 * user/assistant 文本、tool_use 摘要、tool_result 输出分别映射，跳过空白块。
 */
export function messagesToTranscriptItems(messages: unknown[]): Array<{
  role: "system" | "user" | "assistant" | "tool" | "tool_result" | "log";
  text: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  is_error?: boolean;
}> {
  const items: Array<{
    role: "system" | "user" | "assistant" | "tool" | "tool_result" | "log";
    text: string;
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    is_error?: boolean;
  }> = [];

  for (const raw of messages) {
    const msg = raw as { role?: string; type?: string; content?: unknown } | null;
    if (!msg) continue;
    const role = msg.role ?? msg.type ?? "system";

    if (typeof msg.content === "string") {
      const text = msg.content.trim();
      if (text) items.push({ role: role === "assistant" ? "assistant" : "user", text });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      const b = block as
        | { type?: string; text?: string; name?: string; input?: unknown; content?: unknown; is_error?: boolean }
        | null;
      if (!b) continue;
      if (b.type === "text" && typeof b.text === "string") {
        const text = b.text.trim();
        if (text) items.push({ role: role === "assistant" ? "assistant" : "user", text });
      } else if (b.type === "tool_use" && typeof b.name === "string") {
        items.push({
          role: "tool",
          text: `${b.name} ${JSON.stringify(b.input ?? {})}`,
          tool_name: b.name,
          tool_input: (b.input ?? {}) as Record<string, unknown>,
        });
      } else if (b.type === "tool_result") {
        const content = typeof b.content === "string"
          ? b.content
          : Array.isArray(b.content)
            ? (b.content as Array<{ text?: string }>).map((c) => c?.text ?? "").join("\n")
            : JSON.stringify(b.content ?? "");
        items.push({ role: "tool_result", text: content, is_error: !!b.is_error });
      }
    }
  }

  return items;
}

async function processLineForHost(
  line: string,
  bundle: any,
  emit: (event: BackendHostEvent) => Promise<void>,
  lastToolInputs: Map<string, Record<string, unknown>>,
  settings: Settings,
  shouldInterrupt?: () => boolean,
): Promise<void> {
  await emit({
    type: "transcript_item",
    item: { role: "user", text: line },
  });

  let assistantText = "";

  try {
    for await (const event of bundle.queryEngine.submitMessage(line) as AsyncIterable<StreamEvent>) {
      if (shouldInterrupt?.()) break;
      if (event.type === "text_delta") {
        await emit({ type: "assistant_delta", message: event.delta });
        assistantText += event.delta;
      } else if (event.type === "tool_use_start") {
        const tu = event.toolUse;
        lastToolInputs.set(tu.name, tu.input ?? {});
        await emit({
          type: "tool_started",
          tool_name: tu.name,
          tool_input: tu.input,
          item: {
            role: "tool",
            text: `${tu.name} ${JSON.stringify(tu.input ?? {})}`,
            tool_name: tu.name,
            tool_input: tu.input,
          },
        });
      } else if (event.type === "tool_use_end") {
        const result = event.result;
        const outputText = result.content?.map((b: any) => b.text ?? "").join("\n") ?? "";
        const isError = !!result.isError;
        await emit({
          type: "tool_completed",
          tool_name: (result as any).toolName ?? "unknown",
          output: outputText,
          is_error: isError,
          item: {
            role: "tool_result",
            text: outputText,
            tool_name: (result as any).toolName ?? "unknown",
            is_error: isError,
          },
        });
        await emit({
          type: "state_snapshot",
          state: buildStatePayload(bundle.settings),
          mcp_servers: [],
          bridge_sessions: [],
        });

        const toolName = (result as any).toolName ?? "";
        if (toolName === "TodoWrite" || toolName === "todo_write") {
          const toolInput = lastToolInputs.get(toolName) ?? {};
          const todos = (toolInput as any).todos ?? (toolInput as any).content ?? [];
          if (Array.isArray(todos) && todos.length > 0) {
            const lines: string[] = [];
            for (const item of todos) {
              if (typeof item === "object" && item !== null) {
                const checked = (item as any).status
                  ? ["done", "completed", "x", true].includes((item as any).status)
                  : false;
                const text = (item as any).content ?? (item as any).text ?? String(item);
                lines.push(`- [${checked ? "x" : " "}] ${text}`);
              }
            }
            if (lines.length > 0) {
              await emit({ type: "todo_update", todo_markdown: lines.join("\n") });
            }
          } else {
            const mdLines = outputText.split("\n").filter((l: string) => l.trim().startsWith("- ["));
            if (mdLines.length > 0) {
              await emit({ type: "todo_update", todo_markdown: mdLines.join("\n") });
            }
          }
        }
      } else if (event.type === "error") {
        const err = event.error;
        await emit({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? formatApiError(err, settings) : String(err);
    await emit({ type: "error", message: msg });
  }

  const finalText = assistantText.trim();
  await emit({
    type: "assistant_complete",
    message: finalText,
    item: { role: "assistant", text: finalText },
  });
  await emit({
    type: "state_snapshot",
    state: buildStatePayload(bundle.settings),
    mcp_servers: [],
    bridge_sessions: [],
  });
  await emit({ type: "line_complete" });
}

/**
 * 构建当前应用状态的有效载荷对象，用于前端显示或状态同步。
 * 
 * @param settings - 当前应用设置
 * @returns Record<string, unknown> 包含模型、CWD、认证状态、主题等信息的状态对象
 */
function buildStatePayload(settings: Settings, mcpManager?: McpClientManager): Record<string, unknown> {
  const connections = mcpManager?.getConnections() ?? [];
  const mcp_connected = connections.filter((c) => c.status === "connected").length;
  const mcp_failed = connections.filter((c) => c.status === "error").length;
  return {
    model: settings.model,
    cwd: process.cwd(),
    provider: "unknown",
    auth_status: settings.apiKey ? "configured" : "missing",
    base_url: settings.baseUrl ?? null,
    permission_mode: settings.permission?.mode ?? "default",
    theme: settings.theme ?? "default",
    vim_enabled: settings.vimMode ?? false,
    voice_enabled: settings.voiceMode ?? false,
    voice_available: false,
    fast_mode: settings.fastMode ?? false,
    effort: settings.effort ?? "medium",
    output_style: settings.outputStyle ?? "default",
    passes: settings.passes ?? 1,
    mcp_connected,
    mcp_failed,
    input_tokens: 0,
    output_tokens: 0,
  };
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
  // 新存储优先（项目分目录；--continue 走 latest.json，--resume <id> 走 named）。
  try {
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
  } catch {
    // 回退旧平铺存储
  }

  // 向后兼容：旧平铺 <sessionsDir>/<id>.json——仅显式 --resume <id> 时回退。
  // 裸 --continue 不回退全局平铺池（会串到别的项目的会话）。
  if (!resumeId) {
    return generateSessionId();
  }
  const sessionId = resumeId;

  const snapshot = await loadSessionSnapshot(sessionId);
  if (snapshot) {
    engine.loadMessages(snapshot.messages);
    if (snapshot.model) engine.setModel(snapshot.model);
    console.log(`Resumed session: ${sessionId} (${snapshot.messages.length} messages)`);
    return sessionId;
  }

  return generateSessionId();
}

/**
 * 查找最新的会话 ID。
 * 
 * 读取会话目录下的 JSON 文件，按文件名排序后返回最新的一个。
 * 
 * @returns Promise<string | undefined> 最新会话 ID，如果没有则返回 undefined
 */
async function findLatestSessionId(): Promise<string | undefined> {
  const { readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  const dir = join(homedir(), ".openharness", "sessions");
  try {
    const files = await readdir(dir);
    const jsonFiles = files.filter((f) => f.endsWith(".json")).sort().reverse();
    if (!jsonFiles.length) return undefined;
    return jsonFiles[0]!.replace(/\.json$/, "");
  } catch {
    return undefined;
  }
}

/**
 * 从磁盘加载会话快照数据。
 * 
 * @param id - 会话 ID
 * @returns Promise<SessionSnapshot | undefined> 会话快照对象，如果加载失败则返回 undefined
 */
async function loadSessionSnapshot(id: string): Promise<SessionSnapshot | undefined> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  const path = join(homedir(), ".openharness", "sessions", `${id}.json`);
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as SessionSnapshot;
  } catch {
    return undefined;
  }
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
): Promise<void> {
  skillRegistry.registerBundled();
  // 插件贡献插在 bundled 之后、user/project 之前：bundled < plugin < user < project
  // （register 覆盖语义）。信任门控告警直接打到 stderr，三模式一致。
  if (settings) {
    const { warnings } = await loadPluginContributions(skillRegistry, settings, cwd);
    for (const warning of warnings) {
      process.stderr.write(`[plugins] ${warning}\n`);
    }
  }
  const loader = new SkillLoader(skillRegistry);
  await loader.loadFromDirectory(getSkillsDir());
  // 从 cwd 向上遍历到 git-root，收集所有层级的 project skill 目录（低优先→高优先）。
  const projectSkillDirs = await findProjectSkillDirs(cwd);
  for (const dir of projectSkillDirs) {
    await loader.loadFromDirectory(dir);
  }
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
  let skill =
    skillRegistry.get(word) ??
    skillRegistry.get(word.toLowerCase()) ??
    skillRegistry.get(word.charAt(0).toUpperCase() + word.slice(1));
  if (!skill) {
    for (const s of skillRegistry.getAll()) {
      if (s.commandName && s.commandName === word) {
        skill = s;
        break;
      }
    }
  }
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
export function buildHostCommandList(
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
 * 命名与去重规则同 {@link buildHostCommandList}：内置命令优先，追加 user-invocable 技能。
 */
export function buildHostCommandDetails(
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

export interface HostSlashOutcome {
  exit?: boolean;
  clearTranscript?: boolean;
  output?: string;
  error?: string;
}

/**
 * 在 TUI 后端主机里路由斜杠命令（对齐 REPL 的 processLine 斜杠分支）。
 * 返回 host 应当 emit 的结果，由调用方翻译成 OHJSON 事件。**不调用模型。**
 */
export async function runHostSlashCommand(
  line: string,
  registry: CommandRegistry,
): Promise<HostSlashOutcome> {
  const spaceIdx = line.indexOf(" ");
  const name = spaceIdx >= 0 ? line.slice(0, spaceIdx) : line;
  const argsStr = spaceIdx >= 0 ? line.slice(spaceIdx + 1) : "";
  const result = await registry.execute(name, {
    args: parseCommandArgs(argsStr),
    raw: line,
  });
  if (result.output === "__EXIT__") return { exit: true };
  return {
    output: result.output ? result.output : undefined,
    error: result.error,
    clearTranscript: name === "/clear" || name === "/new",
  };
}
