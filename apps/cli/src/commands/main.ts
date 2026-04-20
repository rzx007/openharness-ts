import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import type { Settings, StreamEvent } from "@openharness/core";
import { loadSettings, saveSettings as saveSettingsCore, getSkillsDir } from "@openharness/core";
import { CommandRegistry } from "@openharness/commands";
import { HookExecutor } from "@openharness/hooks";
import { McpClientManager } from "@openharness/mcp";
import { MemoryManager } from "@openharness/memory";
import { SkillRegistry, SkillLoader } from "@openharness/skills";
import { ThemeManager } from "@openharness/themes";
import { TaskManager } from "@openharness/services";
import { buildRuntimeSystemPrompt } from "@openharness/prompts";
import { bootstrap } from "../runtime.js";
import { EventRenderer } from "../renderer.js";
import { registerBuiltinCommandsOnRegistry, type SlashCommandContext } from "./slash-commands.js";
import { join } from "node:path";

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
  answer?: string | null;
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
 * 1. 后端主机模式 (backendOnly)
 * 2. TUI 交互模式 (tui)
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

  if (options.backendOnly) {
    await runBackendHost(settings, options);
    return;
  }

  if (options.tui) {
    await runTuiMode(settings, options, prompt);
    return;
  }

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
async function runPrintMode(
  settings: Settings,
  prompt: string,
  options: MainOptions,
): Promise<void> {
  const { join } = await import("node:path");
  const skillRegistry = new SkillRegistry();
  const skillLoader = new SkillLoader(skillRegistry);
  await skillLoader.loadFromDirectory(getSkillsDir());
  await skillLoader.loadFromDirectory(join(process.cwd(), ".openharness", "skills"));

  const bundle = await bootstrap({
    settings,
    cliOverrides: buildCliOverrides(options),
    skillRegistry,
  });

  const renderer = new EventRenderer({
    verbose: options.verbose,
    printMode: true,
  });

  for await (const event of bundle.queryEngine.submitMessage(prompt)) {
    await renderer.render(event);
  }
}

/**
 * 启动 REPL (Read-Eval-Print Loop) 交互模式。
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
  const skillRegistry = new SkillRegistry();
  const skillLoader = new SkillLoader(skillRegistry);
  await skillLoader.loadFromDirectory(getSkillsDir());
  await skillLoader.loadFromDirectory(join(process.cwd(), ".openharness", "skills"));

  const bundle = await bootstrap({
    settings,
    cliOverrides: buildCliOverrides(options),
    skillRegistry,
  });

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

  const mcpManager = new McpClientManager();
  if (currentSettings.mcpServers) {
    await mcpManager.connectAll(currentSettings.mcpServers).catch(() => { });
  }

  const memoryManager = new MemoryManager(1000, memoryDir);
  const memoryFile = join(memoryDir, "memory.json");
  await memoryManager.loadFromFile(memoryFile).catch(() => { });

  const themeManager = new ThemeManager();
  const taskManager = new TaskManager();

  const refreshSystemPrompt = async () => {
    const prompt = await buildRuntimeSystemPrompt({
      customPrompt: currentSettings.systemPrompt,
      cwd: process.cwd(),
      fastMode: currentSettings.fastMode,
      effort: currentSettings.effort,
      passes: currentSettings.passes,
    });
    bundle.queryEngine.setSystemPrompt(prompt);
  };

  const commandRegistry = new CommandRegistry();

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
    mcpManager,
    skillRegistry,
    themeManager,
    taskManager,
    sessionId,
    exitRepl: () => { },
    refreshSystemPrompt,
    getBundle: () => bundle,
  };

  registerBuiltinCommandsOnRegistry(commandRegistry, slashCtx);

  console.log("OpenHarness Interactive Mode");
  console.log(`Model: ${currentModel}`);
  console.log(`Session: ${sessionId}`);
  console.log("Type /help for commands, or Ctrl+C to exit.\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  const renderer = new EventRenderer({
    verbose: options.verbose,
  });

  const processLine = async (line: string): Promise<void> => {
    const input = line.trim();
    if (!input) return;

    if (input === "exit" || input === "quit") {
      await saveSessionSnapshot(sessionId, bundle.queryEngine, currentModel);
      rl.close();
      return;
    }

    if (input.startsWith("/")) {
      const spaceIdx = input.indexOf(" ");
      const cmdName = spaceIdx >= 0 ? input.slice(0, spaceIdx) : input;
      const argsStr = spaceIdx >= 0 ? input.slice(spaceIdx + 1) : "";
      const result = await commandRegistry.execute(cmdName, {
        args: parseCommandArgs(argsStr),
        raw: input,
      });

      if (result.output === "__EXIT__") {
        await saveSessionSnapshot(sessionId, bundle.queryEngine, currentModel);
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
        process.stderr.write(`Error: ${err.message}\n`);
      }
    }

    rl.prompt();
  };

  rl.on("line", (line) => {
    processLine(line).catch((err) => {
      process.stderr.write(`Fatal: ${err}\n`);
    });
  });

  rl.on("close", () => {
    process.exit(0);
  });

  rl.prompt();
}

/**
 * 启动 TUI (Terminal User Interface)模式。
 * 
 * 此模式通过 spawn 子进程启动前端界面，并将当前进程作为后端服务运行。
 * 它构建必要的命令行参数和环境变量配置，以便前端能够正确连接和控制后端。
 * 
 * @param settings - 当前加载的应用设置
 * @param options - 命令行选项，用于构建后端启动参数
 * @param prompt - 可选的初始提示词，传递给前端
 * @returns Promise<void>
 */
async function runTuiMode(
  settings: Settings,
  options: MainOptions,
  prompt?: string,
): Promise<void> {
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
  });

  const cliDir = path.dirname(url.fileURLToPath(import.meta.url));
  const frontendDistPath = path.resolve(cliDir, "../../frontend/dist/index.js");

  const child = spawn(process.execPath, [frontendDistPath], {
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
 * 运行后端主机模式，负责处理来自前端的 JSON-RPC 风格请求。
 * 
 * 此模式通过 stdin/stdout 与前端通信，使用特定的协议格式 OHJSON。
 * 它管理权限请求、问题询问、会话状态同步以及核心查询引擎的执行。
 * 包含并发控制机制以确保输出顺序正确。
 * 
 * @param settings - 当前加载的应用设置
 * @param options - 命令行选项，用于初始化运行时环境
 * @returns Promise<void>
 */
async function runBackendHost(
  settings: Settings,
  options: MainOptions,
): Promise<void> {
  const permissionRequests = new Map<string, Promise<boolean> & { resolve: (v: boolean) => void }>();
  const questionRequests = new Map<string, Promise<string> & { resolve: (v: string) => void }>();
  let busy = false;
  let running = true;
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

  const askPermission = async (toolName: string, reason?: string): Promise<boolean> => {
    const requestId = randomUUID({ disableEntropyCache: true }).replace(/-/g, "");
    let resolve!: (v: boolean) => void;
    const promise = new Promise<boolean>((r) => { resolve = r; }) as Promise<boolean> & { resolve: (v: boolean) => void };
    promise.resolve = resolve;
    permissionRequests.set(requestId, promise);
    await emit({
      type: "modal_request",
      modal: {
        kind: "permission",
        request_id: requestId,
        tool_name: toolName,
        reason: reason ?? null,
      },
    });
    try {
      return await promise;
    } finally {
      permissionRequests.delete(requestId);
    }
  };

  const skillRegistry = new SkillRegistry();
  const skillLoader = new SkillLoader(skillRegistry);
  await skillLoader.loadFromDirectory(getSkillsDir());
  await skillLoader.loadFromDirectory(join(process.cwd(), ".openharness", "skills"));

  const bundle = await bootstrap({
    settings,
    cliOverrides: buildCliOverrides(options),
    permissionPrompt: askPermission,
    skillRegistry,
  });

  const commandRegistry = new CommandRegistry();
  const mcpManager = new McpClientManager();
  const memoryManager = new MemoryManager(1000, "");
  const themeManager = new ThemeManager();
  const taskManager = new TaskManager();

  const slashCtx: SlashCommandContext = {
    getEngine: () => bundle.queryEngine as any,
    getModel: () => settings.model,
    setModel: (m: string) => { bundle.queryEngine.setModel(m); },
    getSettings: () => settings,
    updateSettings: async () => { },
    hookExecutor: bundle.hookExecutor as HookExecutor,
    memoryManager,
    mcpManager,
    skillRegistry,
    themeManager,
    taskManager,
    sessionId: generateSessionId(),
    exitRepl: () => { },
    refreshSystemPrompt: async () => { },
    getBundle: () => bundle,
  };
  registerBuiltinCommandsOnRegistry(commandRegistry, slashCtx);

  const commands = commandRegistry.list().map((c) => `/${c.name}`);

  await emit({
    type: "ready",
    state: buildStatePayload(settings),
    tasks: [],
    mcp_servers: [],
    bridge_sessions: [],
    commands,
  });
  await emit({
    type: "state_snapshot",
    state: buildStatePayload(settings),
    mcp_servers: [],
    bridge_sessions: [],
  });

  const rl = readline.createInterface({ input: process.stdin });
  const requestQueue: FrontendRequest[] = [];
  let requestResolve: ((req: FrontendRequest | null) => void) | null = null;

  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const request = JSON.parse(trimmed) as FrontendRequest;
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
  });

  const nextRequest = (): Promise<FrontendRequest | null> => {
    if (requestQueue.length > 0) return Promise.resolve(requestQueue.shift()!);
    if (!running) return Promise.resolve(null);
    return new Promise<FrontendRequest | null>((resolve) => { requestResolve = resolve; });
  };

  while (running) {
    const request = await nextRequest();
    if (!request || request.type === "shutdown") {
      await emit({ type: "shutdown" });
      break;
    }
    if (request.type === "permission_response") {
      const rid = request.request_id;
      if (rid && permissionRequests.has(rid)) {
        permissionRequests.get(rid)!.resolve(!!request.allowed);
      }
      continue;
    }
    if (request.type === "question_response") {
      const rid = request.request_id;
      if (rid && questionRequests.has(rid)) {
        questionRequests.get(rid)!.resolve(request.answer ?? "");
      }
      continue;
    }
    if (request.type === "list_sessions") {
      await emit({
        type: "select_request",
        modal: { kind: "select", title: "Resume Session", submit_prefix: "/resume " },
        select_options: [],
      });
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

    busy = true;
    try {
      await processLineForHost(line, bundle, emit, lastToolInputs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await emit({ type: "error", message: msg });
    } finally {
      busy = false;
    }
  }

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
async function processLineForHost(
  line: string,
  bundle: any,
  emit: (event: BackendHostEvent) => Promise<void>,
  lastToolInputs: Map<string, Record<string, unknown>>,
): Promise<void> {
  await emit({
    type: "transcript_item",
    item: { role: "user", text: line },
  });

  let assistantText = "";

  try {
    for await (const event of bundle.queryEngine.submitMessage(line) as AsyncIterable<StreamEvent>) {
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
    const msg = err instanceof Error ? err.message : String(err);
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
function buildStatePayload(settings: Settings): Record<string, unknown> {
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
    passes: settings.passes ?? 1,
    mcp_connected: 0,
    mcp_failed: 0,
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
  const sessionId = resumeId ?? await findLatestSessionId();
  if (!sessionId) {
    return generateSessionId();
  }

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
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  const dir = join(homedir(), ".openharness", "sessions");
  try {
    await mkdir(dir, { recursive: true });
    const usage = engine.getTotalUsage();
    const snapshot: SessionSnapshot = {
      id: sessionId,
      messages: [],
      model,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage,
    };
    await writeFile(join(dir, `${sessionId}.json`), JSON.stringify(snapshot, null, 2), "utf-8");
  } catch {
    // silently fail
  }
}
