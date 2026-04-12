import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import type { Settings, StreamEvent } from "@openharness/core";
import { loadSettings, saveSettings as saveSettingsCore } from "@openharness/core";
import { CommandRegistry } from "@openharness/commands";
import { HookExecutor } from "@openharness/hooks";
import { McpClientManager } from "@openharness/mcp";
import { MemoryManager } from "@openharness/memory";
import { SkillRegistry } from "@openharness/skills";
import { ThemeManager } from "@openharness/themes";
import { TaskManager } from "@openharness/services";
import { buildRuntimeSystemPrompt } from "@openharness/prompts";
import { bootstrap } from "../runtime.js";
import { EventRenderer } from "../renderer.js";
import { registerBuiltinCommandsOnRegistry, type SlashCommandContext } from "./slash-commands.js";

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

async function runPrintMode(
  settings: Settings,
  prompt: string,
  options: MainOptions,
): Promise<void> {
  const bundle = await bootstrap({
    settings,
    cliOverrides: buildCliOverrides(options),
  });

  const renderer = new EventRenderer({
    verbose: options.verbose,
    printMode: true,
  });

  for await (const event of bundle.queryEngine.submitMessage(prompt)) {
    await renderer.render(event);
  }
}

async function runRepl(
  settings: Settings,
  options: MainOptions,
): Promise<void> {
  const bundle = await bootstrap({
    settings,
    cliOverrides: buildCliOverrides(options),
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

  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  const memoryDir = join(homedir(), ".openharness", "data", "memory");

  const mcpManager = new McpClientManager();
  if (currentSettings.mcpServers) {
    await mcpManager.connectAll(currentSettings.mcpServers).catch(() => {});
  }

  const memoryManager = new MemoryManager(1000, memoryDir);
  const memoryFile = join(memoryDir, "memory.json");
  await memoryManager.loadFromFile(memoryFile).catch(() => {});

  const skillRegistry = new SkillRegistry();
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
    exitRepl: () => {},
    refreshSystemPrompt,
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

async function runTuiMode(
  settings: Settings,
  options: MainOptions,
  prompt?: string,
): Promise<void> {
  const { spawn } = await import("node:child_process");
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

  const frontendPath = (await import("node:path")).resolve(
    (await import("node:url")).fileURLToPath(new URL("../../frontend/src/index.tsx", import.meta.url)),
  );

  const child = spawn(process.execPath, ["--import", "tsx", frontendPath], {
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

  const bundle = await bootstrap({
    settings,
    cliOverrides: buildCliOverrides(options),
    permissionPrompt: askPermission,
  });

  const commandRegistry = new CommandRegistry();
  const mcpManager = new McpClientManager();
  const memoryManager = new MemoryManager(1000, "");
  const skillRegistry = new SkillRegistry();
  const themeManager = new ThemeManager();
  const taskManager = new TaskManager();

  const slashCtx: SlashCommandContext = {
    getEngine: () => bundle.queryEngine as any,
    getModel: () => settings.model,
    setModel: (m: string) => { bundle.queryEngine.setModel(m); },
    getSettings: () => settings,
    updateSettings: async () => {},
    hookExecutor: bundle.hookExecutor as HookExecutor,
    memoryManager,
    mcpManager,
    skillRegistry,
    themeManager,
    taskManager,
    sessionId: generateSessionId(),
    exitRepl: () => {},
    refreshSystemPrompt: async () => {},
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

function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${timestamp}-${rand}`;
}

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
