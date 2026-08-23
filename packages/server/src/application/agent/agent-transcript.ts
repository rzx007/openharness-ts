import type { ContentBlock, Message, TextBlock, ToolUseBlock } from "@openharness/core";
import type {
  ReplaceTranscriptMessageInput,
  ReplaceTranscriptPartInput,
  SessionMessagePartRecord,
  SessionMessageRecord,
} from "@openharness/protocol";

type UserMessageContent = Extract<Message, { type: "user" }>["content"];

export function transcriptToAgentMessages(
  messages: SessionMessageRecord[],
  parts: SessionMessagePartRecord[],
): Message[] {
  const byMessage = new Map<string, SessionMessagePartRecord[]>();
  for (const part of parts) {
    const rows = byMessage.get(part.messageId) ?? [];
    rows.push(part);
    byMessage.set(part.messageId, rows);
  }

  const output: Message[] = [];
  for (const message of [...messages].sort((a, b) => a.seq - b.seq)) {
    const messageParts = (byMessage.get(message.id) ?? []).sort((a, b) => a.seq - b.seq);
    if (message.role === "user") {
      output.push({ type: "user", content: textFromParts(messageParts) });
      continue;
    }
    if (message.role === "system") {
      output.push({ type: "system", content: textFromParts(messageParts) });
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
      output.push({
        type: "assistant",
        content: text,
        ...(toolUses.length > 0 ? { toolUses } : {}),
      });
    }
    for (const part of messageParts.filter(
      (candidate) => candidate.type === "tool" && candidate.toolUseId && candidate.output !== undefined,
    )) {
      output.push({
        type: "tool_result",
        toolUseId: part.toolUseId!,
        content: contentBlocksFromOutput(part.output),
        isError: part.isError === true,
      });
    }
  }
  return output;
}

export function agentMessagesToTranscript(messages: Message[]): ReplaceTranscriptMessageInput[] {
  const output: ReplaceTranscriptMessageInput[] = [];
  for (const message of messages) {
    if (message.type === "user") {
      output.push({
        role: "user",
        parts: [{ type: "text", status: "completed", text: userContentToText(message.content) }],
      });
      continue;
    }
    if (message.type === "system") {
      output.push({
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
      output.push({ role: "assistant", parts: transcriptParts });
      continue;
    }

    let attached = false;
    for (let index = output.length - 1; index >= 0; index -= 1) {
      const row = output[index]!;
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
      output.push({
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
  return output;
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

function userContentToText(content: UserMessageContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}
