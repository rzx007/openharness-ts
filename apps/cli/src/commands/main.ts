import * as readline from "node:readline";
import type { Settings } from "@openharness/core";
import { loadSettings } from "@openharness/core";
import { bootstrap } from "../runtime.js";
import { EventRenderer } from "../renderer.js";

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
}

export async function mainAction(
  prompt: string | undefined,
  options: MainOptions,
): Promise<void> {
  const overrides: Partial<Settings> = {};
  if (options.model) overrides.model = options.model;
  if (options.apiFormat) overrides.apiFormat = options.apiFormat as Settings["apiFormat"];
  if (options.permissionMode) overrides.permissionMode = options.permissionMode as Settings["permissionMode"];
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
    cliOverrides: {
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      provider: options.provider,
      systemPrompt: options.systemPrompt,
      permissionMode: options.permissionMode,
      maxTurns: options.maxTurns,
      dangerouslySkipPermissions: options.dangerouslySkipPermissions,
      allowedTools: options.allowedTools,
      disallowedTools: options.disallowedTools,
    },
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
    cliOverrides: {
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      provider: options.provider,
      systemPrompt: options.systemPrompt,
      permissionMode: options.permissionMode,
      maxTurns: options.maxTurns,
      dangerouslySkipPermissions: options.dangerouslySkipPermissions,
      allowedTools: options.allowedTools,
      disallowedTools: options.disallowedTools,
    },
  });

  console.log("OpenHarness Interactive Mode");
  console.log(`Model: ${settings.model}`);
  console.log("Type your message and press Enter. Ctrl+C to exit.\n");

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
      rl.close();
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
    cliOverrides: {
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      provider: options.provider,
      systemPrompt: options.systemPrompt,
      permissionMode: options.permissionMode,
      maxTurns: options.maxTurns,
      dangerouslySkipPermissions: options.dangerouslySkipPermissions,
      allowedTools: options.allowedTools,
      disallowedTools: options.disallowedTools,
    },
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
