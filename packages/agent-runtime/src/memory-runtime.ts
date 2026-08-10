import { resolve, isAbsolute, join } from "node:path";

import type { Message, StreamingMessageClient } from "@openharness/core";
import { getProjectMemoryDir } from "@openharness/core";
import {
  DEFAULT_MEMORY_SCOPE,
  DEFAULT_MEMORY_TYPE,
  MemoryManager,
  parseMemoryScope,
  parseMemoryType,
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
  await manager.loadFromFile(join(directory, "memory.json")).catch(() => 0);

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

async function extractMemories(options: {
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
  const transcript = options.messages.slice(-12).map(summarizeMessage).join("\n");
  const prompt = [
    "Extract only durable memories from the recent conversation.",
    "Return JSON with at most 3 records. Existing memory manifest:",
    manifest || "(empty)",
    "",
    "Recent conversation:",
    transcript,
    "",
    'JSON schema: {"memories":[{"title":"...","type":"user|feedback|project|reference","scope":"private|project|team","description":"...","body":"...","tags":["..."]}]}',
  ].join("\n");

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

  const records = parseRecords(finalText);
  const writtenIds: string[] = [];
  const titles: string[] = [];
  for (const record of records) {
    const scope = parseMemoryScope(record.scope) ?? DEFAULT_MEMORY_SCOPE;
    if (scope === "team") continue;
    const entry = await options.manager.add(record.body, record.tags, undefined, {
      name: record.title,
      description: record.description,
      type: parseMemoryType(record.type) ?? DEFAULT_MEMORY_TYPE,
      scope,
    });
    writtenIds.push(entry.id);
    titles.push(record.title);
  }

  return writtenIds.length > 0
    ? { skipped: false, writtenIds, titles }
    : { skipped: true, reason: "no durable memories proposed", writtenIds: [], titles: [] };
}

function hasMemoryWrites(messages: Message[], memoryDir: string, cwd: string): boolean {
  const root = resolve(memoryDir);
  for (const message of messages) {
    if (message.type !== "assistant") continue;
    for (const toolUse of message.toolUses ?? []) {
      if (toolUse.name !== "Write" && toolUse.name !== "Edit") continue;
      const input = toolUse.input as Record<string, unknown>;
      const rawPath = String(input.path ?? input.file_path ?? "");
      if (!rawPath) continue;
      const resolved = resolve(isAbsolute(rawPath) ? rawPath : join(cwd, rawPath));
      if (resolved === root || resolved.startsWith(`${root}\\`) || resolved.startsWith(`${root}/`)) {
        return true;
      }
    }
  }
  return false;
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

function parseRecords(text: string): Array<{
  title: string;
  body: string;
  description: string;
  type: string;
  scope: string;
  tags: string[];
}> {
  const stripped = text.trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const payload = JSON.parse(stripped.slice(start, end + 1)) as { memories?: unknown };
    if (!Array.isArray(payload.memories)) return [];
    return payload.memories.slice(0, 3).flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const row = candidate as Record<string, unknown>;
      const title = String(row.title ?? "").trim();
      const body = String(row.body ?? "").trim();
      if (!title || !body) return [];
      return [{
        title,
        body,
        description: String(row.description ?? "").trim(),
        type: String(row.type ?? ""),
        scope: String(row.scope ?? ""),
        tags: Array.isArray(row.tags) ? row.tags.map((tag) => String(tag).trim()).filter(Boolean) : [],
      }];
    });
  } catch {
    return [];
  }
}
