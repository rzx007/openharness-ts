import * as readline from "node:readline";
import type { Settings } from "@openharness/core";
import { loadSettings } from "@openharness/core";
import { CommandRegistry } from "@openharness/commands";
import { bootstrap } from "../runtime.js";
import { EventRenderer } from "../renderer.js";
import { registerBuiltinCommands } from "./slash-commands.js";

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

  const commandRegistry = new CommandRegistry();
  registerBuiltinCommands(commandRegistry, () => bundle.queryEngine, () => currentModel);

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

async function runBackendHost(
  settings: Settings,
  options: MainOptions,
): Promise<void> {
  const { ProtocolHost } = await import("@openharness/core");
  const bundle = await bootstrap({
    settings,
    cliOverrides: buildCliOverrides(options),
  });

  const host = new ProtocolHost();

  for await (const request of host.listen<{ type: string; content?: string }>()) {
    if (request.type === "submit_line" && request.content) {
      const events: unknown[] = [];
      for await (const event of bundle.queryEngine.submitMessage(request.content)) {
        events.push(event);
        await host.emit({ type: "stream_event", event });
      }
      await host.emit({ type: "turn_complete", events: events.length });
    }
  }
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
