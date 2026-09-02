import type { ToolDefinition } from "@openharness/core";
import { resolveToolPath } from "./path.js";
import { sandboxPathError } from "./sandbox-guard.js";
import { fileOperationsFor } from "./operations.js";
import { isAttachmentUri, parseAttachmentUri } from "./attachment-uri.js";

const MAX_ATTACHMENT_READ_LINES = 2_000;

export const fileReadTool: ToolDefinition = {
  name: "Read",
  description:
    "Read a local file, directory, or OpenHarness attachment:// resource. " +
    "Use Read, not ReadMcpResource, for attachment:// resources.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description:
          "An absolute local path or the exact attachment:// resource URI provided in the conversation.",
      },
      offset: { type: "number", description: "Start line (1-indexed)." },
      limit: { type: "number", description: "Max lines to read." },
    },
    required: ["file_path"],
  },
  async execute(input, context) {
    const rawPath = input.file_path as string;
    const cwd = (context as { cwd?: string } | undefined)?.cwd ?? process.cwd();
    const offset = (input.offset as number) ?? 1;
    const limit = (input.limit as number) ?? 2000;

    try {
      if (isAttachmentUri(rawPath)) {
        const parsed = parseAttachmentUri(rawPath);
        validateAttachmentRange(offset, limit);
        if (!context.attachments) {
          throw new Error("Attachment resources are unavailable in this session");
        }
        const slice = await context.attachments.readText(
          { assetId: parsed.assetId, offset, limit },
          {
            ...(context.sessionId ? { sessionId: context.sessionId } : {}),
            ...(context.abortSignal ? { signal: context.abortSignal } : {}),
          },
        );
        const numbered = slice.content
          .split("\n")
          .map((line, index) => `${slice.startLine + index}: ${line}`)
          .join("\n");
        return {
          content: [{
            type: "text",
            text: `${numbered}${numbered ? "\n" : ""}has_more: ${String(slice.hasMore)}`,
          }],
        };
      }

      const filePath = resolveToolPath(rawPath, cwd);
      const sandboxError = await sandboxPathError(filePath, cwd, "read", context.settings);
      if (sandboxError) {
        return {
          content: [{ type: "text", text: sandboxError }],
          isError: true,
        };
      }

      const operations = fileOperationsFor(context);
      const fileStat = await operations.stat(filePath);
      if (fileStat.isDirectory) {
        const entries = await operations.listDir(filePath);
        const start = Math.max(0, offset - 1);
        const end = start + limit;
        const listed = entries
          .sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
            return a.name.localeCompare(b.name);
          })
          .slice(start, end)
          .map((entry) => `${entry.name}${entry.isDirectory ? "/" : ""}`)
          .join("\n");
        return {
          content: [{ type: "text", text: listed || "(empty directory)" }],
        };
      }

      const content = await operations.readText(filePath);
      const lines = content.split("\n");
      const start = Math.max(0, offset - 1);
      const end = start + limit;
      const slice = lines.slice(start, end);
      const numbered = slice
        .map((line, i) => `${start + i + 1}: ${line}`)
        .join("\n");
      return { content: [{ type: "text", text: numbered }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error reading file: ${error}` }],
        isError: true,
      };
    }
  },
};

function validateAttachmentRange(offset: number, limit: number): void {
  if (!Number.isSafeInteger(offset) || offset < 1) {
    throw new Error("attachment offset must be a positive integer");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ATTACHMENT_READ_LINES) {
    throw new Error(`attachment limit must be between 1 and ${MAX_ATTACHMENT_READ_LINES}`);
  }
}
