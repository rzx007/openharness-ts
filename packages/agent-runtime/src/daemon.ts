import { join } from "node:path";

import type {
  AgentRunHost,
  ContentBlock,
  Message,
  RuntimeBundle,
  Settings,
  TextBlock,
  ToolUseBlock,
} from "@openharness/core";
import { getProjectMemoryDir } from "@openharness/core";
import { MemoryManager } from "@openharness/memory";
import type {
  SessionCompactResult,
  SessionRememberResult,
  SessionRuntime,
  SessionRuntimeFactory,
  SessionRuntimeRunInput,
  SessionRuntimeRunResult,
  SessionUsageSnapshot,
} from "./host-runtime.js";
import type {
  ReplaceTranscriptMessageInput,
  ReplaceTranscriptPartInput,
  SessionMessagePartRecord,
  SessionMessageRecord,
  SessionRecord,
} from "@openharness/services/session-runtime/types";

import {
  createOpenHarnessAgent,
  type OpenHarnessAgent,
  type OpenHarnessAgentOptions,
} from "./agent.js";
import type { OpenHarnessRuntimeOverrides } from "./default-runtime.js";

type UserMessageContent = Extract<Message, { type: "user" }>["content"];

export interface AgentRuntimeSessionSetup {
  skillRegistry?: OpenHarnessAgentOptions["skillRegistry"];
  credentialStorage?: OpenHarnessAgentOptions["credentialStorage"];
  mcpServers?: OpenHarnessAgentOptions["mcpServers"];
  configureRuntime?(bundle: RuntimeBundle): Promise<void> | void;
}

export interface OpenHarnessAgentRuntimeFactoryOptions {
  settings: Settings;
  getSettings?: () => Settings;
  prepareSession?(context: {
    session: SessionRecord;
    settings: Settings;
  }): Promise<AgentRuntimeSessionSetup> | AgentRuntimeSessionSetup;
}

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

export function transcriptToCoreMessages(
  messages: SessionMessageRecord[],
  parts: SessionMessagePartRecord[],
): Message[] {
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
    for (const part of messageParts.filter(
      (candidate) => candidate.type === "tool" && candidate.toolUseId && candidate.output !== undefined,
    )) {
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

export function coreMessagesToTranscript(messages: Message[]): ReplaceTranscriptMessageInput[] {
  const out: ReplaceTranscriptMessageInput[] = [];
  for (const message of messages) {
    if (message.type === "user") {
      out.push({
        role: "user",
        parts: [{ type: "text", status: "completed", text: userContentToText(message.content) }],
      });
      continue;
    }
    if (message.type === "system") {
      out.push({
        role: "system",
        parts: [{ type: "text", status: "completed", text: message.content }],
      });
      continue;
    }
    if (message.type === "assistant") {
      const transcriptParts: ReplaceTranscriptPartInput[] = [];
      if (message.content) {
        transcriptParts.push({ type: "text", status: "completed", text: message.content });
      }
      for (const toolUse of message.toolUses ?? []) {
        transcriptParts.push({
          type: "tool",
          status: "completed",
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          input: toolUse.input,
        });
      }
      if (transcriptParts.length === 0) {
        transcriptParts.push({ type: "text", status: "completed", text: "" });
      }
      out.push({ role: "assistant", parts: transcriptParts });
      continue;
    }

    let attached = false;
    for (let index = out.length - 1; index >= 0; index -= 1) {
      const row = out[index]!;
      if (row.role !== "assistant") continue;
      const part = row.parts.find(
        (candidate) => candidate.type === "tool" && candidate.toolUseId === message.toolUseId,
      );
      if (!part) continue;
      part.output = { content: message.content };
      part.isError = message.isError === true;
      attached = true;
      break;
    }
    if (!attached) {
      out.push({
        role: "assistant",
        parts: [{
          type: "tool",
          status: "completed",
          toolUseId: message.toolUseId,
          toolName: "unknown",
          output: { content: message.content },
          isError: message.isError === true,
        }],
      });
    }
  }
  return out;
}

function runtimeOverridesFromSession(session: SessionRecord): OpenHarnessRuntimeOverrides {
  const permissionMode = session.metadata.permissionMode;
  const effort = session.metadata.effort;
  return {
    permissionMode: permissionMode === "default" || permissionMode === "plan" || permissionMode === "full_auto"
      ? permissionMode
      : undefined,
    systemPrompt:
      typeof session.metadata.systemPrompt === "string"
        ? session.metadata.systemPrompt
        : undefined,
    maxTurns:
      typeof session.metadata.maxTurns === "number"
        ? session.metadata.maxTurns
        : undefined,
    allowedTools: Array.isArray(session.metadata.allowedTools)
      ? session.metadata.allowedTools.filter((tool): tool is string => typeof tool === "string")
      : undefined,
    disallowedTools: Array.isArray(session.metadata.disallowedTools)
      ? session.metadata.disallowedTools.filter((tool): tool is string => typeof tool === "string")
      : undefined,
    effort: effort === "low" || effort === "medium" || effort === "high" ? effort : undefined,
  };
}

export function createOpenHarnessAgentRuntimeFactory(
  options: OpenHarnessAgentRuntimeFactoryOptions,
): SessionRuntimeFactory {
  const getSettings = options.getSettings ?? (() => options.settings);
  return {
    async createRuntime({ session, history, parts }) {
      const settings = getSettings();
      const setup = await options.prepareSession?.({ session, settings }) ?? {};
      const agent = await createOpenHarnessAgent({
        settings,
        cwd: session.cwd,
        sessionId: session.id,
        overrides: runtimeOverridesFromSession(session),
        skillRegistry: setup.skillRegistry,
        credentialStorage: setup.credentialStorage,
        mcpServers: setup.mcpServers,
        configureRuntime: setup.configureRuntime,
      });
      try {
        agent.loadHistory(transcriptToCoreMessages(history, parts));
        return new AgentSessionRuntime(agent, session.cwd, getSettings);
      } catch (error) {
        await agent.close();
        throw error;
      }
    },
  };
}

export class AgentSessionRuntime implements SessionRuntime {
  constructor(
    private readonly agent: OpenHarnessAgent,
    private readonly cwd: string,
    private readonly getSettings: () => Settings,
  ) {}

  async runPrompt(input: SessionRuntimeRunInput, host: AgentRunHost): Promise<SessionRuntimeRunResult> {
    if (input.session.model) this.agent.runtime.queryEngine.setModel(input.session.model);
    let lastWake = 0;
    for await (const _event of this.agent.submitMessage(input.input.content, {
      signal: input.signal,
      pullFollowUps: () => {
        if (input.wakeCount() <= lastWake) return [];
        lastWake = input.wakeCount();
        return input.drainSteeredInputs().map((row) => row.content);
      },
      host,
    })) {
      if (input.signal.aborted) throw new Error("Run interrupted");
    }
    if (input.signal.aborted) throw new Error("Run interrupted");
    return { messages: [] };
  }

  inspect() {
    return {
      mcpServers: this.agent.getMcpConnections().map((connection) => ({
        name: connection.name,
        status: connection.status,
        toolCount: connection.tools.length,
        resourceCount: connection.resources.length,
        command: connection.config.command
          ? `${connection.config.command} ${(connection.config.args ?? []).join(" ")}`.trim()
          : connection.config.url,
        ...(connection.error ? { error: connection.error.message } : {}),
      })),
      hooks: (this.agent.runtime.hookExecutor.getAll?.() ?? []).map((hook) => ({
        id: hook.id,
        event: hook.event,
        type: hook.type,
        enabled: hook.enabled !== false,
        origin: "runtime" as const,
      })),
    };
  }

  async compact(): Promise<SessionCompactResult> {
    const history = await this.agent.compact();
    return {
      messageCount: history.length,
      transcript: coreMessagesToTranscript(history),
    };
  }

  getUsage(): SessionUsageSnapshot {
    const usage = this.agent.getUsage();
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.cacheCreationTokens !== undefined
        ? { cacheCreationTokens: usage.cacheCreationTokens }
        : {}),
      ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
      messageCount: this.agent.getHistory().length,
    };
  }

  async remember(): Promise<SessionRememberResult> {
    const { extractMemoriesFromTurn } = await import("@openharness/services/memory-extract");
    const memoryDir = getProjectMemoryDir(this.cwd);
    const manager = new MemoryManager(1000, memoryDir);
    await manager.loadFromFile(join(memoryDir, "memory.json")).catch(() => {});
    const manifest = (await manager.getAll())
      .slice(0, 80)
      .map((entry) => `- ${String(entry.metadata?.name ?? entry.id)}: ${String(entry.metadata?.description ?? "").slice(0, 80)}`)
      .join("\n");
    const result = await extractMemoriesFromTurn({
      apiClient: this.agent.runtime.apiClient,
      model: this.getSettings().model,
      messages: this.agent.getHistory(),
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
    await this.agent.close();
  }
}
