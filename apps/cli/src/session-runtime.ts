import type { ContentBlock, Message, ToolUseBlock } from "@openharness/core";
import type {
  SessionRuntime,
  SessionRuntimeFactory,
  SessionRuntimeHooks,
  SessionRuntimeRunInput,
  SessionRuntimeRunResult,
} from "@openharness/server";
import type { Settings } from "@openharness/core";
import type { SessionMessagePartRecord, SessionMessageRecord } from "@openharness/services";
import { CredentialStorage } from "@openharness/auth";
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

export interface CliSessionRuntimeFactoryOptions {
  settings: Settings;
}

export function createCliSessionRuntimeFactory(options: CliSessionRuntimeFactoryOptions): SessionRuntimeFactory {
  return {
    async createRuntime({ session, history, parts }) {
      let permissionPrompt: ((toolName: string, reason?: string, input?: Record<string, unknown>) => Promise<boolean>) | undefined;
      const skillRegistry = new SkillRegistry();
      const pluginContributions = await loadSkillsThreeSources(skillRegistry, session.cwd, options.settings);
      const bundle = await bootstrap({
        settings: options.settings,
        cwd: session.cwd,
        sessionId: session.id,
        cliOverrides: {
          // Headless daemon is fail-closed until PermissionBroker is wired.
          permissionMode: options.settings.permission.mode,
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
      const mcpServers = mergePluginMcpServers(options.settings.mcpServers, pluginContributions.plugins);
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
      return new CliSessionRuntime(bundle, (prompt) => {
        permissionPrompt = prompt;
      });
    },
  };
}

class CliSessionRuntime implements SessionRuntime {
  constructor(
    private readonly bundle: Awaited<ReturnType<typeof bootstrap>>,
    private readonly setPermissionPrompt: (
      prompt: ((toolName: string, reason?: string, input?: Record<string, unknown>) => Promise<boolean>) | undefined,
    ) => void,
  ) {}

  async runPrompt(input: SessionRuntimeRunInput, hooks: SessionRuntimeHooks): Promise<SessionRuntimeRunResult> {
    this.setPermissionPrompt((toolName, reason, toolInput) =>
      hooks.askPermission({ toolName, reason, input: toolInput }));
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

  async close(): Promise<void> {
    await this.bundle.close();
  }
}
