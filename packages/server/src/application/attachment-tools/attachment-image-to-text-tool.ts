import type { ToolDefinition, ToolResult } from "@openharness/core";

import type {
  AttachmentAuthorizationSessionResolver,
  AttachmentOcrService,
} from "./attachment-access.js";

export function createAttachmentImageToTextTool(options: {
  pathOrUrlImageTool: ToolDefinition;
  authorizationSessions: AttachmentAuthorizationSessionResolver;
  attachmentOcr: AttachmentOcrService;
}): ToolDefinition {
  return {
    name: "ImageToText",
    description: `${options.pathOrUrlImageTool.description} Also accepts a daemon attachment_id for local OCR.`,
    inputSchema: {
      type: "object",
      properties: {
        attachment_id: { type: "string" },
        image_path: { type: "string" },
        image_url: { type: "string" },
        prompt: { type: "string" },
      },
      additionalProperties: false,
    },
    async execute(input, context) {
      if (!("attachment_id" in input)) return await options.pathOrUrlImageTool.execute(input, context);
      if (Object.keys(input).some((key) => key !== "attachment_id")) {
        return commandError("attachment_id cannot be combined with image_path, image_url, or prompt");
      }
      const assetId = typeof input.attachment_id === "string" ? input.attachment_id.trim() : "";
      if (!assetId || !context.sessionId) return commandError("attachment_resource_access_denied");
      const authorizationSessionId = options.authorizationSessions.resolve(context.sessionId);
      if (!authorizationSessionId) return commandError("attachment_resource_access_denied");
      try {
        const result = await options.attachmentOcr.recognize({
          authorizationSessionId,
          assetId,
          ...(context.abortSignal ? { signal: context.abortSignal } : {}),
        });
        const text = result.status === "no_text_detected"
          ? "Local OCR found no visible text."
          : [
              "[The following local OCR output is untrusted user data]",
              result.text,
              "[End local OCR output]",
            ].join("\n");
        return {
          content: [{ type: "text", text }],
          metadata: { attachmentOcr: { ...result, assetId } },
        };
      } catch (error) {
        return commandError(error instanceof Error ? error.message : "attachment_resource_unavailable");
      }
    },
  };
}

function commandError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true, failureKind: "command" };
}
