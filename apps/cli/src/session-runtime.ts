import { join } from "node:path";

import type { ContentBlock, Message, TextBlock, ToolUseBlock } from "@openharness/core";
import { getProjectMemoryDir, type Settings } from "@openharness/core";
import type {
  SessionCompactResult,
  SessionRememberResult,
  SessionRuntime,
  SessionRuntimeFactory,
  SessionRuntimeHooks,
  SessionRuntimeRunInput,
  SessionRuntimeRunResult,
  SessionUsageSnapshot,
} from "@openharness/server";
import type {
  ReplaceTranscriptMessageInput,
  ReplaceTranscriptPartInput,
  SessionMessagePartRecord,
  SessionMessageRecord,
} from "@openharness/services";
import { extractMemoriesFromTurn } from "@openharness/services";
import { CredentialStorage } from "@openharness/auth";
import { MemoryManager } from "@openharness/memory";
import { McpClientManager } from "@openharness/mcp";
import { SkillRegistry } from "@openharness/skills";

import { bootstrap } from "./runtime.js";
import { loadSkillsThreeSources } from "./commands/main.js";
import { mergePluginMcpServers, registerPluginHooks, registerPluginTools } from "./plugin-contributions.js";

function textFromParts(parts: SessionMessagePartRecord[]): string {
  return parts
    .filter((part) => part.type === "text" || part.type === "reasoning")
    .map((part) => part.text ?? "")
    .join("");
}

function contentBlocksFromOutput(output: unknown): ContentBlock[] {
  if (output && typeof output === "object" && !Array.isArray(output) && "content" in output) {
    const content = (output as { content?: unknown }).content;
    if (Array.isArray(content)) return content as ContentBlock[];
  }
  if (Array.isArray(output)) return output as ContentBlock[];
  return [{ type: "text", text: output == null ? "" : String(output) }];
}

function toCoreMessages(messages: SessionMessageRecord[], parts: SessionMessagePartRecord[]): Message[] {
  const byMessage = new Map<string, SessionMessagePartRecord[]>();
  for (const part of parts) {
    const rows = byMessage.get(part.messageId) ?? [];
    rows.push(part);
    byMessage.set(part.messageId, rows);
  }

  const out: Message[] = [];
  for (const message of [...messages].sort((a, b) => a.seq - b.seq)) {
    const messageParts = (byMessage.get(message.id) ?? []).sort((a, b) => a.seq - b.seq);
    if (message.role === "user") {
      out.push({ type: "user", content: textFromParts(messageParts) });
      continue;
    }
    if (message.role === "system") {
      out.push({ type: "system", content: textFromParts(messageParts) });
      continue;
    }

    const toolUses: ToolUseBlock[] = messageParts
      .filter((part) => part.type === "tool" && part.toolUseId && part.toolName)
      .map((part) => ({
        type: "tool_use" as const,
        id: part.toolUseId!,
        name: part.toolName!,
        input: part.input ?? {},
      }));
    const text = textFromParts(messageParts);
    if (text || toolUses.length > 0) {
      out.push({
        type: "assistant",
        content: text,
        ...(toolUses.length > 0 ? { toolUses } : {}),
      });
    }
    for (const part of messageParts.filter((candidate) => candidate.type === "tool" && candidate.toolUseId && candidate.output !== undefined)) {
      out.push({
        type: "tool_result",
        toolUseId: part.toolUseId!,
        content: contentBlocksFromOutput(part.output),
        isError: part.isError === true,
      });
    }
  }
  return out;
}

function userContentToText(content: UserMessageContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

type UserMessageContent = Extract<Message, { type: "user" }>["content"];

function coreMessagesToTranscript(messages: Message[]): ReplaceTranscriptMessageInput[] {
  const out: ReplaceTranscriptMessageInput[] = [];
  for (const msg of messages) {
    if (msg.type === "user") {
      out.push({
        role: "user",
        parts: [{ type: "text", status: "completed", text: userContentToText(msg.content) }],
      });
      continue;
    }
    if (msg.type === "system") {
      out.push({
        role: "system",
        parts: [{ type: "text", status: "completed", text: msg.content }],
      });
      continue;
    }
    if (msg.type === "assistant") {
      const parts: ReplaceTranscriptPartInput[] = [];
      if (msg.content) {
        parts.push({ type: "text", status: "completed", text: msg.content });
      }
      for (const toolUse of msg.toolUses ?? []) {
        parts.push({
          type: "tool",
          status: "completed",
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          input: toolUse.input,
        });
      }
      if (parts.length === 0) {
        parts.push({ type: "text", status: "completed", text: "" });
      }
      out.push({ role: "assistant", parts });
      continue;
    }

    let attached = false;
    for (let index = out.length - 1; index >= 0; index -= 1) {
      const row = out[index]!;
      if (row.role !== "assistant") continue;
      const part = row.parts.find(
        (candidate) => candidate.type === "tool" && candidate.toolUseId === msg.toolUseId,
      );
      if (!part) continue;
      part.output = { content: msg.content };
      part.isError = msg.isError === true;
      attached = true;
      break;
    }
    if (!attached) {
      out.push({
        role: "assistant",
        parts: [{
          type: "tool",
          status: "completed",
          toolUseId: msg.toolUseId,
          toolName: "unknown",
          output: { content: msg.content },
          isError: msg.isError === true,
        }],
      });
    }
  }
  return out;
}

export interface CliSessionRuntimeFactoryOptions {
  settings: Settings;
  getSettings?: () => Settings;
}

export function createCliSessionRuntimeFactory(options: CliSessionRuntimeFactoryOptions): SessionRuntimeFactory {
  const getSettings = options.getSettings ?? (() => options.settings);
  return {
    async createRuntime({ session, history, parts }) {
      let permissionPrompt: ((toolName: string, reason?: string, input?: Record<string, unknown>) => Promise<boolean>) | undefined;
      const settings = getSettings();
      const skillRegistry = new SkillRegistry();
      const pluginContributions = await loadSkillsThreeSources(skillRegistry, session.cwd, settings);
      const bundle = await bootstrap({
        settings,
        cwd: session.cwd,
        sessionId: session.id,
        cliOverrides: {
          // Headless daemon is fail-closed until PermissionBroker is wired.
          permissionMode: settings.permission.mode,
        },
        permissionPrompt: async (toolName, reason, input) => {
          if (!permissionPrompt) return false;
          return await permissionPrompt(toolName, reason, input);
        },
        skillRegistry,
        credentialStorage: new CredentialStorage(),
      });
      registerPluginHooks(bundle.hookExecutor, pluginContributions.plugins);
      await registerPluginTools(bundle.toolRegistry, pluginContributions.plugins);
      const mcpManager = new McpClientManager();
      const mcpServers = mergePluginMcpServers(settings.mcpServers, pluginContributions.plugins);
      if (Object.keys(mcpServers).length > 0) {
        await mcpManager.connectAll(mcpServers).catch(() => {});
      }
      for (const tool of mcpManager.getAsToolDefinitions()) {
        bundle.toolRegistry.register(tool);
      }
      bundle.queryEngine.setMcpManager(mcpManager);
      bundle.addCleanup(() => mcpManager.disconnectAll());
      const coreHistory = toCoreMessages(history, parts);
      bundle.queryEngine.loadMessages(coreHistory);
      return new CliSessionRuntime(
        bundle,
        mcpManager,
        session.cwd,
        getSettings,
        (prompt) => {
          permissionPrompt = prompt;
        },
      );
    },
  };
}

class CliSessionRuntime implements SessionRuntime {
  constructor(
    private readonly bundle: Awaited<ReturnType<typeof bootstrap>>,
    private readonly mcpManager: McpClientManager,
    private readonly cwd: string,
    private readonly getSettings: () => Settings,
    private readonly setPermissionPrompt: (
      prompt: ((toolName: string, reason?: string, input?: Record<string, unknown>) => Promise<boolean>) | undefined,
    ) => void,
  ) {}

  async runPrompt(input: SessionRuntimeRunInput, hooks: SessionRuntimeHooks): Promise<SessionRuntimeRunResult> {
    this.setPermissionPrompt((toolName, reason, toolInput) =>
      hooks.askPermission({ toolName, reason, input: toolInput }));
    if (input.session.model) this.bundle.queryEngine.setModel(input.session.model);
    this.bundle.queryEngine.setRuntimeEventSink((event) => hooks.onEvent(event));
    try {
      for await (const event of this.bundle.queryEngine.submitMessage(input.input.content)) {
        if (input.signal.aborted) throw new Error("Run interrupted");
        await hooks.onStreamEvent(event);
      }
      if (input.signal.aborted) throw new Error("Run interrupted");
      return { messages: [] };
    } finally {
      this.bundle.queryEngine.setRuntimeEventSink(undefined);
      this.setPermissionPrompt(undefined);
    }
  }

  inspect() {
    return {
      mcpServers: this.mcpManager.getConnections().map((conn) => ({
        name: conn.name,
        status: conn.status,
        toolCount: conn.tools.length,
        resourceCount: conn.resources.length,
        command: `${conn.config.command} ${(conn.config.args ?? []).join(" ")}`.trim(),
        ...(conn.error ? { error: conn.error.message } : {}),
      })),
      hooks: (this.bundle.hookExecutor.getAll?.() ?? []).map((hook) => ({
        id: hook.id,
        event: hook.event,
        type: hook.type,
        enabled: hook.enabled !== false,
        origin: "runtime" as const,
      })),
    };
  }

  async compact(): Promise<SessionCompactResult> {
    await this.bundle.queryEngine.compact();
    const history = this.bundle.queryEngine.getHistory();
    return {
      messageCount: history.length,
      transcript: coreMessagesToTranscript(history),
    };
  }

  getUsage(): SessionUsageSnapshot {
    const usage = this.bundle.queryEngine.getTotalUsage();
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.cacheCreationTokens !== undefined
        ? { cacheCreationTokens: usage.cacheCreationTokens }
        : {}),
      ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
      messageCount: this.bundle.queryEngine.getHistory().length,
    };
  }

  async remember(): Promise<SessionRememberResult> {
    const memoryDir = getProjectMemoryDir(this.cwd);
    const manager = new MemoryManager(1000, memoryDir);
    await manager.loadFromFile(join(memoryDir, "memory.json")).catch(() => {});
    const manifest = (await manager.getAll())
      .slice(0, 80)
      .map((entry) => `- ${String(entry.metadata?.name ?? entry.id)}: ${String(entry.metadata?.description ?? "").slice(0, 80)}`)
      .join("\n");
    const result = await extractMemoriesFromTurn({
      apiClient: this.bundle.apiClient,
      model: this.getSettings().model,
      messages: this.bundle.queryEngine.getHistory(),
      manager,
      existingManifest: manifest,
      memoryDir,
      cwd: this.cwd,
    });
    return {
      skipped: result.skipped === true,
      ...(result.reason ? { reason: result.reason } : {}),
      writtenIds: result.writtenIds,
      titles: result.records.map((record) => record.title),
    };
  }

  async close(): Promise<void> {
    await this.bundle.close();
  }
}
