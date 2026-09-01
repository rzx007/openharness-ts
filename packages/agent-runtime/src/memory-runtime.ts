import type { Message, StreamingMessageClient } from "@openharness/core";
import { getProjectMemoryDir } from "@openharness/core";
import {
  buildMemoryExtractionPrompt,
  isMemoryWriteToolCall,
  MemoryManager,
  parseMemoryExtractionRecords,
  selectWritableMemoryExtractionRecords,
} from "@openharness/memory";

export interface AgentRememberResult {
  skipped: boolean;
  reason?: string;
  writtenIds: string[];
  titles: string[];
}

export interface AgentMemoryRuntime {
  manager: MemoryManager;
  directory: string;
  retrieve(userInput: string): Promise<string | null>;
  remember(messages: Message[], apiClient: StreamingMessageClient, model: string): Promise<AgentRememberResult>;
}

export async function createAgentMemoryRuntime(
  cwd: string,
  maxFiles: number,
): Promise<AgentMemoryRuntime> {
  const directory = getProjectMemoryDir(cwd);
  const manager = new MemoryManager(1000, directory);

  return {
    manager,
    directory,
    async retrieve(userInput) {
      const selected = manager.selectRelevantForPrompt(maxFiles, userInput);
      if (selected.ids.length > 0) await manager.markMemoryUsed(selected.ids);
      return selected.text || null;
    },
    async remember(messages, apiClient, model) {
      return await extractMemories({
        apiClient,
        model,
        messages,
        manager,
        memoryDir: directory,
        cwd,
      });
    },
  };
}

export async function extractMemories(options: {
  apiClient: StreamingMessageClient;
  model: string;
  messages: Message[];
  manager: MemoryManager;
  memoryDir: string;
  cwd: string;
}): Promise<AgentRememberResult> {
  if (options.messages.length < 2) {
    return { skipped: true, reason: "not enough messages", writtenIds: [], titles: [] };
  }
  if (hasMemoryWrites(options.messages, options.memoryDir, options.cwd)) {
    return {
      skipped: true,
      reason: "main conversation already wrote memory",
      writtenIds: [],
      titles: [],
    };
  }

  const manifest = (await options.manager.getAll())
    .slice(0, 80)
    .map((entry) => `- ${entry.name ?? entry.id}: ${(entry.description ?? "").slice(0, 80)}`)
    .join("\n");
  const transcript = options.messages.slice(-12).map(summarizeMessage);
  const prompt = buildMemoryExtractionPrompt(manifest, transcript);

  let finalText = "";
  for await (const event of options.apiClient.streamMessage({
    model: options.model,
    messages: [{ type: "user", content: prompt }],
    system: [
      "You maintain OpenHarness durable memory.",
      "Save only stable, future-useful facts that are not derivable from current files, git history, or documentation.",
      "Do not save secrets. If nothing is worth saving, return {\"memories\": []}.",
    ].join("\n"),
    maxTokens: 2048,
    tools: [],
  })) {
    if (event.type === "text_delta") finalText += event.delta;
    if (event.type === "complete") break;
  }

  const records = selectWritableMemoryExtractionRecords(
    parseMemoryExtractionRecords(finalText),
  );
  const writtenIds: string[] = [];
  const titles: string[] = [];
  for (const record of records) {
    const entry = await options.manager.add(record.body, record.tags, undefined, {
      name: record.title,
      description: record.description,
      type: record.memoryType,
      scope: record.scope,
    });
    writtenIds.push(entry.id);
    titles.push(record.title);
  }

  return writtenIds.length > 0
    ? { skipped: false, writtenIds, titles }
    : { skipped: true, reason: "no durable memories proposed", writtenIds: [], titles: [] };
}

function hasMemoryWrites(messages: Message[], memoryDir: string, cwd: string): boolean {
  const runMessages = currentRunMessages(messages);
  const memoryWriteIds = new Set<string>();
  for (const message of runMessages) {
    if (message.type !== "assistant") continue;
    for (const toolUse of message.toolUses ?? []) {
      const input = toolUse.input as Record<string, unknown>;
      if (
        toolUse.name === "Remember" ||
        isMemoryWriteToolCall(toolUse.name, input, memoryDir, cwd)
      ) {
        memoryWriteIds.add(toolUse.id);
      }
    }
  }
  return runMessages.some((message) =>
    message.type === "tool_result" &&
    message.isError !== true &&
    memoryWriteIds.has(message.toolUseId)
  );
}

function currentRunMessages(messages: Message[]): Message[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.type === "user") return messages.slice(index);
  }
  return messages;
}

function summarizeMessage(message: Message): string {
  if (message.type === "tool_result") return `tool: ${summarizeContent(message.content)}`;
  const role = message.type;
  const text = typeof message.content === "string" ? message.content : summarizeContent(message.content);
  const tools = message.type === "assistant" && message.toolUses?.length
    ? ` tools=${message.toolUses.map((tool) => tool.name).join(",")}`
    : "";
  return `${role}: ${text.split(/\s+/).filter(Boolean).join(" ").slice(0, 1200)}${tools}`;
}

function summarizeContent(content: Array<{ type: string; text?: string }>): string {
  return content.map((block) => block.type === "text" ? block.text ?? "" : `[${block.type}]`).join(" ");
}
