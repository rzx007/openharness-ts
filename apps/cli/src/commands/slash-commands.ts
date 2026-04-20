import type { CommandRegistry } from "@openharness/commands";
import type { QueryEngine, Settings, Message, RuntimeBundle } from "@openharness/core";
import { saveSettings, getMemoryDir } from "@openharness/core";
import type { McpClientManager } from "@openharness/mcp";
import type { HookExecutor } from "@openharness/hooks";
import type { MemoryManager } from "@openharness/memory";
import type { SkillRegistry } from "@openharness/skills";
import type { ThemeManager } from "@openharness/themes";
import type { TaskManager } from "@openharness/services";
import { buildRuntimeSystemPrompt } from "@openharness/prompts";
import { PROVIDERS, detectProvider, findByName } from "@openharness/api";
import { switchApiClientForBundle, resolveApiKey } from "../runtime.js";

export interface SlashCommandContext {
  getEngine: () => QueryEngine;
  getModel: () => string;
  setModel: (m: string) => void;
  getSettings: () => Settings;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  hookExecutor: HookExecutor;
  memoryManager?: MemoryManager;
  mcpManager?: McpClientManager;
  skillRegistry?: SkillRegistry;
  themeManager?: ThemeManager;
  taskManager?: TaskManager;
  sessionId?: string;
  exitRepl: () => void;
  refreshSystemPrompt: () => Promise<void>;
  getBundle: () => RuntimeBundle;
}

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-3-5-sonnet-20241022": { input: 3, output: 15 },
  "claude-3-7-sonnet-20250219": { input: 3, output: 15 },
  "claude-3-opus-20240229": { input: 15, output: 75 },
  "claude-3-haiku-20240307": { input: 0.25, output: 1.25 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4-turbo": { input: 10, output: 30 },
  "o1": { input: 15, output: 60 },
  "o3-mini": { input: 1.1, output: 4.4 },
  "deepseek-chat": { input: 0.14, output: 0.28 },
  "deepseek-reasoner": { input: 0.55, output: 2.19 },
  "glm-4-plus": { input: 0.7, output: 0.7 },
  "glm-4": { input: 0.7, output: 0.7 },
  "glm-4-flash": { input: 0.1, output: 0.1 },
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): string {
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING["claude-sonnet-4-20250514"]!;
  const cost = (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
  return `$${cost.toFixed(4)}`;
}

function parseArgs(raw: string): string[] {
  return raw.split(/\s+/).filter(Boolean);
}

export function registerBuiltinCommands(ctx: SlashCommandContext): void {
  const { getEngine, getModel, setModel, getSettings, updateSettings, hookExecutor, memoryManager, mcpManager, refreshSystemPrompt, getBundle } = ctx;

  // We'll return a function that registers on a CommandRegistry
  // Actually let's restructure: the caller passes registry, we use ctx for deps
}

export function registerBuiltinCommandsOnRegistry(
  registry: CommandRegistry,
  ctx: SlashCommandContext,
): void {
  const { getEngine, getModel, setModel, getSettings, updateSettings, hookExecutor, memoryManager, mcpManager, refreshSystemPrompt, getBundle } = ctx;

  // ── /help ──────────────────────────────────────────────
  registry.register({
    name: "/help",
    description: "Show available commands",
    aliases: ["/h", "/?"],
    handler: async () => {
      const commands = registry.list();
      const lines = ["Available commands:", ""];
      for (const cmd of commands) {
        const aliases = cmd.aliases?.length ? ` (${cmd.aliases.join(", ")})` : "";
        lines.push(`  ${cmd.name}${aliases} - ${cmd.description}`);
      }
      lines.push("", "Type your message to send to the AI agent.");
      lines.push("Use Ctrl+C or type 'exit' to quit.");
      return { success: true, output: lines.join("\n") };
    },
  });

  // ── /model ─────────────────────────────────────────────
  registry.register({
    name: "/model",
    description: "Show or change the current model",
    args: [{ name: "model", description: "New model name", required: false }],
    handler: async (cmdCtx) => {
      const newModel = cmdCtx.args.model || cmdCtx.args._0;
      if (newModel) {
        const settings = getSettings();
        const apiKey = resolveApiKey(settings);
        const baseURL = settings.baseUrl;
        const newSpec = detectProvider(newModel, apiKey, baseURL);
        const currentSpec = detectProvider(getModel(), apiKey, baseURL);
        const providerChanged = newSpec && currentSpec && newSpec.name !== currentSpec.name;

        if (providerChanged && newSpec) {
          const err = switchApiClientForBundle(getBundle(), newSpec.name, newModel);
          if (err) return { success: false, error: err };
          return { success: true, output: `Model changed to: ${newModel} (provider: ${newSpec.displayName})` };
        }

        setModel(newModel);
        return { success: true, output: `Model changed to: ${newModel}` };
      }
      const settings = getSettings();
      const spec = detectProvider(getModel(), settings.apiKey, settings.baseUrl);
      const providerInfo = spec ? ` (provider: ${spec.displayName})` : "";
      return { success: true, output: `Current model: ${getModel()}${providerInfo}` };
    },
  });

  // ── /provider ──────────────────────────────────────────
  registry.register({
    name: "/provider",
    description: "Show or switch API provider",
    args: [{ name: "provider", description: "Provider name or 'auto'", required: false }],
    handler: async (cmdCtx) => {
      const providerName = cmdCtx.args.provider || cmdCtx.args._0;
      const settings = getSettings();

      if (!providerName) {
        const currentSpec = detectProvider(getModel(), settings.apiKey, settings.baseUrl);
        const lines = ["Available providers:", ""];
        const currentName = settings.provider ?? currentSpec?.name ?? "auto";
        for (const spec of PROVIDERS) {
          const hasKey = settings.apiKeys?.[spec.name] ? true : !!process.env[spec.envKey];
          const marker = spec.name === currentName ? " (active)" : "";
          const keyStatus = spec.envKey ? (hasKey ? "[key]" : "[no key]") : "[local]";
          lines.push(`  ${spec.name.padEnd(14)} ${spec.displayName.padEnd(14)} ${keyStatus}${marker}`);
        }
        lines.push("");
        lines.push(`Current provider: ${currentName}`);
        return { success: true, output: lines.join("\n") };
      }

      if (providerName === "auto") {
        delete getBundle().settings.provider;
        const spec = detectProvider(getModel(), resolveApiKey(settings), settings.baseUrl);
        if (spec) {
          const err = switchApiClientForBundle(getBundle(), spec.name);
          if (err) return { success: false, error: err };
        }
        return { success: true, output: "Provider set to auto-detect" };
      }

      const err = switchApiClientForBundle(getBundle(), providerName);
      if (err) return { success: false, error: err };
      const spec = findByName(providerName);
      return { success: true, output: `Provider switched to: ${spec?.displayName ?? providerName}` };
    },
  });

  // ── /clear ─────────────────────────────────────────────
  registry.register({
    name: "/clear",
    description: "Clear conversation history",
    handler: async () => {
      getEngine().clear();
      return { success: true, output: "Conversation cleared." };
    },
  });

  // ── /compact ───────────────────────────────────────────
  registry.register({
    name: "/compact",
    description: "Summarize conversation to reduce context size",
    handler: async () => {
      await getEngine().compact();
      return { success: true, output: "Conversation compacted." };
    },
  });

  // ── /usage ─────────────────────────────────────────────
  registry.register({
    name: "/usage",
    description: "Show token usage statistics",
    handler: async () => {
      const usage = getEngine().getTotalUsage();
      const history = getEngine().getHistory();
      const lines = [
        "Token usage:",
        `  Input:         ${usage.inputTokens.toLocaleString()}`,
        `  Output:        ${usage.outputTokens.toLocaleString()}`,
        `  Total:         ${(usage.inputTokens + usage.outputTokens).toLocaleString()}`,
        `  Cache write:   ${(usage.cacheCreationTokens ?? 0).toLocaleString()}`,
        `  Cache read:    ${(usage.cacheReadTokens ?? 0).toLocaleString()}`,
        `  Messages:      ${history.length}`,
      ];
      return { success: true, output: lines.join("\n") };
    },
  });

  // ── /session ───────────────────────────────────────────
  registry.register({
    name: "/session",
    description: "Show session info",
    handler: async () => {
      const usage = getEngine().getTotalUsage();
      const settings = getSettings();
      const lines = [
        "Session info:",
        `  Session ID:   ${ctx.sessionId ?? "unknown"}`,
        `  Model:        ${getModel()}`,
        `  Permission:   ${settings.permission.mode}`,
        `  Effort:       ${settings.effort ?? "medium"}`,
        `  Max turns:    ${settings.maxTurns}`,
        `  Input tokens: ${usage.inputTokens.toLocaleString()}`,
        `  Output tokens:${usage.outputTokens.toLocaleString()}`,
        `  CWD:          ${process.cwd()}`,
      ];
      return { success: true, output: lines.join("\n") };
    },
  });

  // ── /exit ──────────────────────────────────────────────
  registry.register({
    name: "/exit",
    description: "Exit the REPL",
    aliases: ["/quit", "/q"],
    handler: async () => {
      return { success: true, output: "__EXIT__" };
    },
  });

  // ═══════════════════════════════════════════════════════
  //  NEW COMMANDS
  // ═══════════════════════════════════════════════════════

  // ── /status ────────────────────────────────────────────
  registry.register({
    name: "/status",
    description: "Show session status overview",
    handler: async () => {
      const usage = getEngine().getTotalUsage();
      const history = getEngine().getHistory();
      const settings = getSettings();
      const lines = [
        "Session Status:",
        `  Model:        ${getModel()}`,
        `  Messages:     ${history.length}`,
        `  Turns used:   ${history.filter((m) => m.type === "assistant").length}`,
        `  Max turns:    ${settings.maxTurns}`,
        `  Input tokens: ${usage.inputTokens.toLocaleString()}`,
        `  Output tokens:${usage.outputTokens.toLocaleString()}`,
        `  Effort:       ${settings.effort ?? "medium"}`,
        `  Passes:       ${settings.passes ?? 1}`,
        `  Permission:   ${settings.permission.mode}`,
        `  Fast mode:    ${settings.fastMode ? "on" : "off"}`,
      ];
      return { success: true, output: lines.join("\n") };
    },
  });

  // ── /cost ──────────────────────────────────────────────
  registry.register({
    name: "/cost",
    description: "Show estimated cost breakdown",
    handler: async () => {
      const usage = getEngine().getTotalUsage();
      const model = getModel();
      const cost = estimateCost(model, usage.inputTokens, usage.outputTokens);
      const lines = [
        "Cost estimate:",
        `  Model:        ${model}`,
        `  Input tokens: ${usage.inputTokens.toLocaleString()}`,
        `  Output tokens:${usage.outputTokens.toLocaleString()}`,
        `  Est. cost:    ${cost}`,
      ];
      if (usage.cacheCreationTokens) {
        lines.push(`  Cache write:  ${usage.cacheCreationTokens.toLocaleString()}`);
      }
      if (usage.cacheReadTokens) {
        lines.push(`  Cache read:   ${usage.cacheReadTokens.toLocaleString()}`);
      }
      return { success: true, output: lines.join("\n") };
    },
  });

  // ── /config ────────────────────────────────────────────
  registry.register({
    name: "/config",
    description: "Show or edit configuration (show | set KEY VALUE)",
    handler: async (cmdCtx) => {
      const args = parseArgs(cmdCtx.raw.replace(/^\/\S+\s*/, ""));
      const sub = args[0];

      if (!sub || sub === "show") {
        const settings = getSettings();
        return { success: true, output: JSON.stringify(settings, null, 2) };
      }

      if (sub === "set" && args.length >= 3) {
        const key = args[1]!;
        const value = args.slice(2).join(" ");
        const settings = getSettings();
        const patch: Record<string, unknown> = {};
        const coerced = coerceConfigValue(key, value);
        if (coerced === undefined) {
          return { success: false, error: `Unknown config key: ${key}` };
        }

        if (key.includes(".")) {
          const parts = key.split(".");
          if (parts[0] === "permission" && parts[1]) {
            const permPatch: Record<string, unknown> = { ...settings.permission };
            (permPatch as any)[parts[1]!] = coerced;
            patch.permission = permPatch;
          } else {
            (patch as any)[parts[0]!] = { ...(settings as any)[parts[0]!], [parts[1]!]: coerced };
          }
        } else {
          (patch as any)[key] = coerced;
        }

        await updateSettings(patch as Partial<Settings>);

        if (key === "effort" || key === "passes" || key === "fastMode" || key === "systemPrompt") {
          await refreshSystemPrompt();
        }
        if (key === "maxTurns" && typeof coerced === "number") {
          getEngine().setMaxTurns(coerced);
        }
        if (key === "model" && typeof coerced === "string") {
          setModel(coerced);
        }

        return { success: true, output: `Set ${key} = ${JSON.stringify(coerced)}` };
      }

      return { success: false, error: "Usage: /config [show | set KEY VALUE]" };
    },
  });

  // ── /permissions ───────────────────────────────────────
  registry.register({
    name: "/permissions",
    description: "Show or set permission mode (default | plan | full_auto)",
    handler: async (cmdCtx) => {
      const args = parseArgs(cmdCtx.raw.replace(/^\/\S+\s*/, ""));
      const mode = args[0];

      if (!mode) {
        const settings = getSettings();
        const lines = [
          "Permission settings:",
          `  Mode:          ${settings.permission.mode}`,
          `  Allowed tools: ${settings.permission.allowedTools?.join(", ") || "(none)"}`,
          `  Denied tools:  ${settings.permission.deniedTools?.join(", ") || "(none)"}`,
          `  Path rules:    ${settings.permission.pathRules?.length ?? 0}`,
          `  Denied cmds:   ${settings.permission.deniedCommands?.join(", ") || "(none)"}`,
        ];
        return { success: true, output: lines.join("\n") };
      }

      if (mode !== "default" && mode !== "plan" && mode !== "full_auto") {
        return { success: false, error: `Invalid mode: ${mode}. Use: default, plan, or full_auto` };
      }

      await updateSettings({ permission: { ...getSettings().permission, mode: mode as any } });
      return { success: true, output: `Permission mode set to: ${mode}` };
    },
  });

  // ── /effort ────────────────────────────────────────────
  registry.register({
    name: "/effort",
    description: "Set reasoning effort level (low | medium | high)",
    handler: async (cmdCtx) => {
      const args = parseArgs(cmdCtx.raw.replace(/^\/\S+\s*/, ""));
      const level = args[0];

      if (!level) {
        return { success: true, output: `Current effort: ${getSettings().effort ?? "medium"}` };
      }

      if (level !== "low" && level !== "medium" && level !== "high") {
        return { success: false, error: `Invalid effort: ${level}. Use: low, medium, or high` };
      }

      await updateSettings({ effort: level as any });
      await refreshSystemPrompt();
      return { success: true, output: `Effort set to: ${level}` };
    },
  });

  // ── /turns ─────────────────────────────────────────────
  registry.register({
    name: "/turns",
    description: "Set max agentic turns (1-512)",
    handler: async (cmdCtx) => {
      const args = parseArgs(cmdCtx.raw.replace(/^\/\S+\s*/, ""));
      const value = args[0];

      if (!value) {
        return { success: true, output: `Current max turns: ${getSettings().maxTurns}` };
      }

      const n = parseInt(value, 10);
      if (isNaN(n) || n < 1 || n > 512) {
        return { success: false, error: "Value must be between 1 and 512" };
      }

      getEngine().setMaxTurns(n);
      await updateSettings({ maxTurns: n });
      return { success: true, output: `Max turns set to: ${n}` };
    },
  });

  // ── /rewind ────────────────────────────────────────────
  registry.register({
    name: "/rewind",
    description: "Remove the last N conversation turns (default 1)",
    args: [{ name: "count", description: "Number of turns to rewind", required: false }],
    handler: async (cmdCtx) => {
      const count = parseInt(cmdCtx.args.count || cmdCtx.args._0 || "1", 10);
      if (isNaN(count) || count < 1) {
        return { success: false, error: "Count must be a positive integer" };
      }

      const engine = getEngine();
      const history = engine.getHistory();
      if (history.length === 0) {
        return { success: false, error: "No messages to rewind" };
      }

      let removed = 0;
      let turns = 0;
      const msgs = [...history];

      while (turns < count && msgs.length > 0) {
        const msg = msgs.pop()!;
        removed++;
        if (msg.type === "user" && (msg as any).content && typeof (msg as any).content === "string" && (msg as any).content.trim()) {
          turns++;
        }
      }

      engine.clear();
      engine.loadMessages(msgs);
      return { success: true, output: `Rewound ${turns} turn(s), removed ${removed} message(s).` };
    },
  });

  // ── /context ───────────────────────────────────────────
  registry.register({
    name: "/context",
    description: "Show the current system prompt sent to the model",
    handler: async () => {
      const settings = getSettings();
      const prompt = await buildRuntimeSystemPrompt({
        customPrompt: settings.systemPrompt,
        cwd: process.cwd(),
        fastMode: settings.fastMode,
        effort: settings.effort,
        passes: settings.passes,
      });

      const lines = [
        "Current system prompt:",
        "─".repeat(60),
        prompt.length > 2000 ? prompt.slice(0, 2000) + "\n... (truncated)" : prompt,
        "─".repeat(60),
        `Total length: ${prompt.length} characters`,
      ];
      return { success: true, output: lines.join("\n") };
    },
  });

  // ── /resume ────────────────────────────────────────────
  registry.register({
    name: "/resume",
    description: "Resume a previous session (latest | <session-id>)",
    handler: async (cmdCtx) => {
      const args = parseArgs(cmdCtx.raw.replace(/^\/\S+\s*/, ""));
      const sessionId = args[0];

      const { readdir, readFile, mkdir } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const dir = join(homedir(), ".openharness", "sessions");

      try {
        await mkdir(dir, { recursive: true });
        const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();

        if (files.length === 0) {
          return { success: false, error: "No saved sessions found." };
        }

        if (!sessionId || sessionId === "latest") {
          const lines = ["Saved sessions:", ""];
          const display = files.slice(-10).reverse();
          for (const f of display) {
            lines.push(`  ${f.replace(/\.json$/, "")}`);
          }
          lines.push("", "Use /resume <session-id> to restore a session.");
          return { success: true, output: lines.join("\n") };
        }

        const target = sessionId.endsWith(".json") ? sessionId : `${sessionId}.json`;
        if (!files.includes(target)) {
          return { success: false, error: `Session not found: ${sessionId}` };
        }

        const raw = await readFile(join(dir, target), "utf-8");
        const snapshot = JSON.parse(raw);
        if (snapshot.messages && Array.isArray(snapshot.messages)) {
          getEngine().clear();
          getEngine().loadMessages(snapshot.messages);
          if (snapshot.model) setModel(snapshot.model);
          return { success: true, output: `Resumed session: ${sessionId} (${snapshot.messages.length} messages)` };
        }
        return { success: false, error: "Invalid session data." };
      } catch (err) {
        return { success: false, error: `Failed to load sessions: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  // ── /export ────────────────────────────────────────────
  registry.register({
    name: "/export",
    description: "Export conversation to a Markdown file",
    handler: async (cmdCtx) => {
      const args = parseArgs(cmdCtx.raw.replace(/^\/\S+\s*/, ""));
      const history = getEngine().getHistory();

      if (history.length === 0) {
        return { success: false, error: "No messages to export." };
      }

      const lines: string[] = [
        `# OpenHarness Conversation Export`,
        ``,
        `Date: ${new Date().toISOString()}`,
        `Model: ${getModel()}`,
        `Session: ${ctx.sessionId ?? "unknown"}`,
        ``,
        `---`,
        ``,
      ];

      for (const msg of history) {
        if (msg.type === "user") {
          const content = typeof (msg as any).content === "string" ? (msg as any).content : JSON.stringify((msg as any).content);
          lines.push(`## User`, ``, content, ``, `---`, ``);
        } else if (msg.type === "assistant") {
          lines.push(`## Assistant`, ``, (msg as any).content || "(no text)", ``);
          if ((msg as any).toolUses?.length) {
            for (const tu of (msg as any).toolUses) {
              lines.push(`**Tool: ${tu.name}**`, "```json", JSON.stringify(tu.input, null, 2), "```", "");
            }
          }
          lines.push(`---`, ``);
        } else if (msg.type === "tool_result") {
          const text = (msg as any).content?.map((c: any) => c.text ?? JSON.stringify(c)).join("\n") ?? "";
          lines.push(`### Tool Result (${(msg as any).isError ? "error" : "ok"})`, "```", text.slice(0, 2000), "```", "");
        }
      }

      const { writeFile, mkdir } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const dir = join(homedir(), ".openharness", "data", "exports");
      await mkdir(dir, { recursive: true });
      const filename = args[0] ?? `export-${Date.now()}.md`;
      const filepath = filename.includes("/") || filename.includes("\\") ? filename : join(dir, filename);
      await writeFile(filepath, lines.join("\n"), "utf-8");

      return { success: true, output: `Conversation exported to: ${filepath}` };
    },
  });

  // ── /doctor ────────────────────────────────────────────
  registry.register({
    name: "/doctor",
    description: "Run environment diagnostics",
    handler: async () => {
      const settings = getSettings();
      const usage = getEngine().getTotalUsage();
      const history = getEngine().getHistory();

      const lines: string[] = [
        "OpenHarness Environment Diagnostic",
        "═".repeat(40),
        "",
        `CWD:            ${process.cwd()}`,
        `Node:           ${process.version}`,
        `Platform:       ${process.platform} ${process.arch}`,
        `Model:          ${getModel()}`,
        `API Format:     ${settings.apiFormat}`,
        `Base URL:       ${settings.baseUrl || "(default)"}`,
        `Permission:     ${settings.permission.mode}`,
        `Max Turns:      ${settings.maxTurns}`,
        `Effort:         ${settings.effort ?? "medium"}`,
        `Passes:         ${settings.passes ?? 1}`,
        `Fast Mode:      ${settings.fastMode ? "on" : "off"}`,
        `Theme:          ${settings.theme ?? "default"}`,
        `Vim Mode:       ${settings.vimMode ? "on" : "off"}`,
        "",
        `Messages:       ${history.length}`,
        `Input tokens:   ${usage.inputTokens.toLocaleString()}`,
        `Output tokens:  ${usage.outputTokens.toLocaleString()}`,
        "",
      ];

      const apiKey = settings.apiKey;
      if (apiKey) {
        const masked = apiKey.length > 8 ? apiKey.slice(0, 4) + "..." + apiKey.slice(-4) : "(set)";
        lines.push(`API Key:        ${masked}`);
      } else {
        lines.push(`API Key:        (not set)`);
      }

      const memoryDir = getMemoryDir();
      lines.push("", `Memory dir:     ${memoryDir}`);

      if (memoryManager) {
        const entries = await memoryManager.getAll();
        lines.push(`Memory entries: ${entries.length}`);
      }

      if (mcpManager) {
        const conns = mcpManager.getConnections();
        lines.push("", "MCP Servers:");
        if (conns.length === 0) {
          lines.push("  (none)");
        } else {
          for (const conn of conns) {
            const status = conn.status === "connected" ? "ok" : conn.status;
            lines.push(`  ${conn.name}: ${status} (${conn.tools.length} tools)`);
          }
        }
      }

      if (settings.hooks?.length) {
        lines.push("", `Hooks: ${settings.hooks.length} configured`);
      }

      return { success: true, output: lines.join("\n") };
    },
  });

  // ── /init ──────────────────────────────────────────────
  registry.register({
    name: "/init",
    description: "Initialize OpenHarness project files",
    handler: async () => {
      const { writeFile, mkdir, access } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const cwd = process.cwd();

      const files: Array<{ path: string; content: string; label: string }> = [
        {
          path: join(cwd, "CLAUDE.md"),
          content: `# Project Rules\n\nAdd your project-specific rules and instructions here.\n`,
          label: "CLAUDE.md",
        },
        {
          path: join(cwd, ".openharness", "README.md"),
          content: `# OpenHarness Config\n\nThis directory contains OpenHarness project configuration.\n`,
          label: ".openharness/README.md",
        },
        {
          path: join(cwd, ".openharness", "memory", "MEMORY.md"),
          content: `# Memory\n\nThis file stores project memory for the AI assistant.\n`,
          label: ".openharness/memory/MEMORY.md",
        },
      ];

      const dirs = [
        join(cwd, ".openharness"),
        join(cwd, ".openharness", "memory"),
        join(cwd, ".openharness", "plugins"),
        join(cwd, ".openharness", "skills"),
      ];

      const lines: string[] = ["Initializing OpenHarness project...", ""];

      for (const dir of dirs) {
        await mkdir(dir, { recursive: true });
      }
      lines.push("  Created directories.");

      for (const file of files) {
        try {
          await access(file.path);
          lines.push(`  Skipped ${file.label} (already exists)`);
        } catch {
          await writeFile(file.path, file.content, "utf-8");
          lines.push(`  Created ${file.label}`);
        }
      }

      lines.push("", "Project initialized successfully.");
      return { success: true, output: lines.join("\n") };
    },
  });

  // ── /version ───────────────────────────────────────────
  registry.register({
    name: "/version",
    description: "Show version info",
    aliases: ["/v"],
    handler: async () => {
      const { readFileSync } = await import("node:fs");
      const { join, dirname } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      try {
        const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
        const raw = readFileSync(pkgPath, "utf-8");
        const pkg = JSON.parse(raw);
        return { success: true, output: `OpenHarness v${pkg.version ?? "0.1.0"}` };
      } catch {
        return { success: true, output: "OpenHarness v0.1.0" };
      }
    },
  });

  // ── /memory ────────────────────────────────────────────
  registry.register({
    name: "/memory",
    description: "Manage project memory (list | show ID | add CONTENT | remove ID)",
    handler: async (cmdCtx) => {
      if (!memoryManager) {
        return { success: false, error: "Memory not available." };
      }

      const args = parseArgs(cmdCtx.raw.replace(/^\/\S+\s*/, ""));
      const sub = args[0];
      const memoryDir = getMemoryDir();

      if (!sub || sub === "list") {
        const entries = await memoryManager.getAll();
        if (entries.length === 0) {
          return { success: true, output: `Memory directory: ${memoryDir}\nNo entries found.` };
        }
        const lines = [`Memory entries (${entries.length}):`, ""];
        for (const entry of entries) {
          const tags = entry.tags?.length ? ` [${entry.tags.join(", ")}]` : "";
          const preview = entry.content.length > 80 ? entry.content.slice(0, 80) + "..." : entry.content;
          lines.push(`  ${entry.id}${tags}: ${preview}`);
        }
        return { success: true, output: lines.join("\n") };
      }

      if (sub === "show" && args[1]) {
        const entry = await memoryManager.get(args[1]);
        if (!entry) {
          return { success: false, error: `Entry not found: ${args[1]}` };
        }
        const lines = [
          `ID:       ${entry.id}`,
          `Created:  ${new Date(entry.createdAt).toISOString()}`,
          `Updated:  ${new Date(entry.updatedAt).toISOString()}`,
          `Tags:     ${entry.tags?.join(", ") ?? "(none)"}`,
          ``,
          entry.content,
        ];
        return { success: true, output: lines.join("\n") };
      }

      if (sub === "add") {
        const content = args.slice(1).join(" ");
        if (!content) {
          return { success: false, error: "Usage: /memory add <content>" };
        }
        const entry = await memoryManager.add(content);
        return { success: true, output: `Memory added: ${entry.id}` };
      }

      if (sub === "remove" && args[1]) {
        const deleted = await memoryManager.delete(args[1]);
        if (!deleted) {
          return { success: false, error: `Entry not found: ${args[1]}` };
        }
        return { success: true, output: `Memory removed: ${args[1]}` };
      }

      return { success: false, error: "Usage: /memory [list | show ID | add CONTENT | remove ID]" };
    },
  });

  // ── /mcp ───────────────────────────────────────────────
  registry.register({
    name: "/mcp",
    description: "Show MCP server connection status",
    handler: async () => {
      if (!mcpManager) {
        const settings = getSettings();
        if (settings.mcpServers && Object.keys(settings.mcpServers).length > 0) {
          return { success: true, output: "MCP servers configured but not connected." };
        }
        return { success: true, output: "No MCP servers configured." };
      }

      const conns = mcpManager.getConnections();
      if (conns.length === 0) {
        return { success: true, output: "No MCP servers connected." };
      }

      const lines = [`MCP Servers (${conns.length}):`, ""];
      for (const conn of conns) {
        const status = conn.status === "connected" ? "OK" : conn.status.toUpperCase();
        lines.push(`  ${conn.name}: ${status}`);
        lines.push(`    Command: ${conn.config.command} ${(conn.config.args ?? []).join(" ")}`);
        lines.push(`    Tools:    ${conn.tools.length}  Resources: ${conn.resources.length}`);
        if (conn.error) {
          lines.push(`    Error:    ${conn.error.message}`);
        }
        lines.push("");
      }
      return { success: true, output: lines.join("\n") };
    },
  });

  // ═══════════════════════════════════════════════════════
  //  BATCH 2: ENHANCED COMMANDS
  // ═══════════════════════════════════════════════════════

  // ── /diff ─────────────────────────────────────────────
  registry.register({
    name: "/diff",
    description: "Show git diff (--stat or full)",
    handler: async (cmdCtx) => {
      const args = parseArgs(cmdCtx.raw.replace(/^\/\S+\s*/, ""));
      const full = args.includes("full");
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(execFile);
      try {
        if (full) {
          const { stdout } = await execAsync("git", ["diff", "HEAD"], { cwd: process.cwd(), maxBuffer: 1024 * 1024 });
          return { success: true, output: stdout || "(no diff)" };
        }
        const { stdout } = await execAsync("git", ["diff", "--stat"], { cwd: process.cwd() });
        return { success: true, output: stdout || "(no changes)" };
      } catch (err) {
        return { success: false, error: `git diff failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  // ── /branch ────────────────────────────────────────────
  registry.register({
    name: "/branch",
    description: "Show current branch or list all branches (show | list)",
    handler: async (cmdCtx) => {
      const args = parseArgs(cmdCtx.raw.replace(/^\/\S+\s*/, ""));
      const sub = args[0];
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(execFile);

      try {
        if (sub === "list") {
          const { stdout } = await execAsync("git", ["branch", "-a"], { cwd: process.cwd() });
          return { success: true, output: stdout || "(no branches)" };
        }
        const { stdout } = await execAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: process.cwd() });
        return { success: true, output: `Current branch: ${stdout.trim()}` };
      } catch (err) {
        return { success: false, error: `git branch failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  // ── /commit ────────────────────────────────────────────
  registry.register({
    name: "/commit",
    description: "Git status or stage-all + commit (MSG)",
    handler: async (cmdCtx) => {
      const rawArgs = cmdCtx.raw.replace(/^\/\S+\s*/, "").trim();
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(execFile);

      try {
        if (!rawArgs) {
          const { stdout } = await execAsync("git", ["status", "--short"], { cwd: process.cwd() });
          return { success: true, output: stdout || "(working tree clean)" };
        }

        await execAsync("git", ["add", "-A"], { cwd: process.cwd() });
        const { stdout } = await execAsync("git", ["commit", "-m", rawArgs], { cwd: process.cwd() });
        return { success: true, output: stdout.trim() };
      } catch (err) {
        return { success: false, error: `git commit failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });

  // ── /hooks ─────────────────────────────────────────────
  registry.register({
    name: "/hooks",
    description: "Show configured hooks",
    handler: async () => {
      const allHooks = hookExecutor.getAll();
      const settings = getSettings();
      const settingsHooks = settings.hooks ?? [];

      if (allHooks.length === 0 && settingsHooks.length === 0) {
        return { success: true, output: "No hooks configured." };
      }

      const lines = ["Hooks:", ""];

      if (allHooks.length > 0) {
        lines.push("Runtime hooks:");
        for (const h of allHooks) {
          const enabled = h.enabled !== false ? "enabled" : "disabled";
          lines.push(`  ${h.id}: ${h.event} (${h.type}) [${enabled}]`);
        }
        lines.push("");
      }

      if (settingsHooks.length > 0) {
        lines.push("Settings hooks:");
        for (const h of settingsHooks) {
          const enabled = h.enabled !== false ? "enabled" : "disabled";
          lines.push(`  ${h.id}: ${h.event} (${h.type}) [${enabled}]`);
        }
      }

      return { success: true, output: lines.join("\n") };
    },
  });

  // ── /skills ────────────────────────────────────────────
  registry.register({
    name: "/skills",
    description: "List or show available skills (list | SKILL_NAME)",
    handler: async (cmdCtx) => {
      const args = parseArgs(cmdCtx.raw.replace(/^\/\S+\s*/, ""));

      if (!ctx.skillRegistry) {
        return { success: false, error: "Skill registry not available." };
      }

      if (args.length > 0 && args[0] !== "list") {
        const skill = ctx.skillRegistry.get(args[0]!);
        if (!skill) {
          return { success: false, error: `Skill not found: ${args[0]}` };
        }
        const lines = [
          `Name:        ${skill.name}`,
          `Description: ${skill.description}`,
          `Source:      ${skill.source ?? "unknown"}`,
          `Path:        ${skill.path}`,
          "",
          skill.content,
        ];
        return { success: true, output: lines.join("\n") };
      }

      const skills = ctx.skillRegistry.getAll();
      if (skills.length === 0) {
        return { success: true, output: "No skills loaded." };
      }

      const lines = [`Skills (${skills.length}):`, ""];
      for (const s of skills) {
        const src = s.source ? ` [${s.source}]` : "";
        lines.push(`  ${s.name}${src}: ${s.description}`);
      }
      return { success: true, output: lines.join("\n") };
    },
  });

  // ── /plan ──────────────────────────────────────────────
  registry.register({
    name: "/plan",
    description: "Toggle plan mode (on | off)",
    handler: async (cmdCtx) => {
      const args = parseArgs(cmdCtx.raw.replace(/^\/\S+\s*/, ""));
      const current = getSettings().permission.mode;
      let newMode: "default" | "plan";

      if (args[0] === "on" || (!args[0] && current !== "plan")) {
        newMode = "plan";
      } else {
        newMode = "default";
      }

      await updateSettings({ permission: { ...getSettings().permission, mode: newMode } });
      return { success: true, output: `Plan mode: ${newMode === "plan" ? "ON (tools will not execute)" : "OFF"}` };
    },
  });

  // ── /fast ──────────────────────────────────────────────
  registry.register({
    name: "/fast",
    description: "Toggle fast mode (on | off | toggle)",
    handler: async (cmdCtx) => {
      const args = parseArgs(cmdCtx.raw.replace(/^\/\S+\s*/, ""));
      const current = getSettings().fastMode ?? false;
      let next: boolean;

      if (args[0] === "on") next = true;
      else if (args[0] === "off") next = false;
      else next = !current;

      await updateSettings({ fastMode: next });
      await refreshSystemPrompt();
      return { success: true, output: `Fast mode: ${next ? "ON" : "OFF"}` };
    },
  });

  // ── /theme ─────────────────────────────────────────────
  registry.register({
    name: "/theme",
    description: "Manage themes (show | list | set NAME)",
    handler: async (cmdCtx) => {
      const args = parseArgs(cmdCtx.raw.replace(/^\/\S+\s*/, ""));
      const sub = args[0];

      if (!sub || sub === "show") {
        const settings = getSettings();
        const name = settings.theme ?? "default";
        if (ctx.themeManager) {
          const theme = ctx.themeManager.get(name);
          if (theme) {
            const lines = [
              `Theme: ${theme.displayName} (${theme.name})`,
              `  Primary:   ${theme.colors.primary}`,
              `  Secondary: ${theme.colors.secondary}`,
              `  Accent:    ${theme.colors.accent}`,
              `  Background:${theme.colors.background}`,
              `  Foreground:${theme.colors.foreground}`,
            ];
            return { success: true, output: lines.join("\n") };
          }
        }
        return { success: true, output: `Current theme: ${name}` };
      }

      if (sub === "list") {
        if (ctx.themeManager) {
          const themes = ctx.themeManager.list();
          const active = ctx.themeManager.getActive().name;
          const lines = themes.map((t) => `  ${t.name === active ? "* " : "  "}${t.name}: ${t.displayName}`);
          return { success: true, output: `Themes:\n${lines.join("\n")}` };
        }
        return { success: true, output: "Theme manager not available." };
      }

      if (sub === "set" && args[1]) {
        const name = args[1]!;
        if (ctx.themeManager) {
          const theme = ctx.themeManager.get(name);
          if (!theme) {
            const available = ctx.themeManager.list().map((t) => t.name).join(", ");
            return { success: false, error: `Unknown theme: ${name}. Available: ${available}` };
          }
          ctx.themeManager.setActive(name);
        }
        await updateSettings({ theme: name });
        return { success: true, output: `Theme set to: ${name}` };
      }

      return { success: false, error: "Usage: /theme [show | list | set NAME]" };
    },
  });

  // ── /tasks ─────────────────────────────────────────────
  registry.register({
    name: "/tasks",
    description: "Manage background tasks (list | show ID | stop ID | run CMD)",
    handler: async (cmdCtx) => {
      if (!ctx.taskManager) {
        return { success: false, error: "Task manager not available." };
      }

      const args = parseArgs(cmdCtx.raw.replace(/^\/\S+\s*/, ""));
      const sub = args[0];
      const tm = ctx.taskManager;

      if (!sub || sub === "list") {
        const tasks = tm.listTasks();
        if (tasks.length === 0) {
          return { success: true, output: "No tasks." };
        }
        const lines = [`Tasks (${tasks.length}):`, ""];
        for (const t of tasks) {
          const age = Math.round((Date.now() - t.createdAt) / 1000);
          lines.push(`  ${t.id} [${t.status}] ${t.type}: ${t.description} (${age}s ago)`);
        }
        return { success: true, output: lines.join("\n") };
      }

      if (sub === "show" && args[1]) {
        const task = tm.getTask(args[1]!);
        if (!task) return { success: false, error: `Task not found: ${args[1]}` };
        const output = tm.readTaskOutput(args[1]!);
        const lines = [
          `Task: ${task.id}`,
          `  Type:        ${task.type}`,
          `  Status:      ${task.status}`,
          `  Description: ${task.description}`,
          `  CWD:         ${task.cwd}`,
          `  Command:     ${task.command ?? "(none)"}`,
          `  Exit code:   ${task.exitCode ?? "(n/a)"}`,
          "",
          "Output:",
          output,
        ];
        return { success: true, output: lines.join("\n") };
      }

      if (sub === "stop" && args[1]) {
        try {
          const task = await tm.stopTask(args[1]!);
          return { success: true, output: `Task ${task.id} stopped.` };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      if (sub === "run" && args.length >= 2) {
        const cmd = args.slice(1).join(" ");
        const task = await tm.createShellTask(cmd, cmd, process.cwd());
        return { success: true, output: `Task started: ${task.id} — ${cmd}` };
      }

      return { success: false, error: "Usage: /tasks [list | show ID | stop ID | run CMD]" };
    },
  });

  // ── /agents ────────────────────────────────────────────
  registry.register({
    name: "/agents",
    description: "Show agent/teammate tasks",
    handler: async () => {
      if (!ctx.taskManager) {
        return { success: true, output: "No task manager available." };
      }

      const tasks = ctx.taskManager.listTasks().filter((t) => t.type === "agent");
      if (tasks.length === 0) {
        return { success: true, output: "No agent tasks." };
      }

      const lines = [`Agent tasks (${tasks.length}):`, ""];
      for (const t of tasks) {
        const status = t.status;
        const age = Math.round((Date.now() - t.createdAt) / 1000);
        lines.push(`  ${t.id} [${status}] ${t.description} (${age}s ago)`);
        if (t.prompt) {
          const preview = t.prompt.length > 80 ? t.prompt.slice(0, 80) + "..." : t.prompt;
          lines.push(`    Prompt: ${preview}`);
        }
      }
      return { success: true, output: lines.join("\n") };
    },
  });
}

function coerceConfigValue(key: string, value: string): unknown {
  switch (key) {
    case "model":
    case "apiFormat":
    case "baseUrl":
    case "systemPrompt":
    case "theme":
    case "outputStyle":
    case "effort":
      return value;

    case "maxTurns":
    case "maxTokens":
    case "passes": {
      const n = parseInt(value, 10);
      return isNaN(n) ? undefined : n;
    }

    case "verbose":
    case "vimMode":
    case "voiceMode":
    case "fastMode":
      if (value === "true" || value === "on") return true;
      if (value === "false" || value === "off") return false;
      return undefined;

    case "permission.mode":
      if (["default", "plan", "full_auto"].includes(value)) return value;
      return undefined;

    default:
      return value;
  }
}
