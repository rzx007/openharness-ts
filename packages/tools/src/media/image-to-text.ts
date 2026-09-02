import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { Settings, ToolDefinition, ToolFailureKind, ToolResult } from "@openharness/core";

import { createToolAbortScope } from "../abort.js";
import { resolveToolPath } from "../file/path.js";

const MAX_DESCRIPTION_TOKENS = 1_024;
const MEDIA_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export const imageToTextTool: ToolDefinition = {
  name: "ImageToText",
  description: "Describe an image or extract visible text with the configured vision model.",
  inputSchema: {
    type: "object",
    properties: {
      image_path: { type: "string", description: "Local jpg, jpeg, png, gif, or webp path." },
      image_url: { type: "string", description: "Public HTTP(S) image URL." },
      prompt: { type: "string", description: "Vision instruction. Defaults to a detailed description." },
    },
    additionalProperties: false,
    oneOf: [{ required: ["image_path"] }, { required: ["image_url"] }],
  },
  async execute(input, context) {
    const parsed = parseInput(input, context.cwd);
    if (typeof parsed === "string") return errorResult(parsed, "command");
    if (!context.settings) {
      return errorResult("ImageToText is unavailable because runtime settings are missing.", "policy");
    }

    let imageBlock: Record<string, unknown>;
    try {
      imageBlock = await buildImageBlock(parsed, context.settings.apiFormat);
    } catch (error) {
      return errorResult(safeMessage(error), "command");
    }

    const abortScope = createToolAbortScope(context.abortSignal, 60_000);
    try {
      return await requestDescription(context.settings, imageBlock, parsed.prompt, abortScope.signal);
    } catch {
      return errorResult(
        context.abortSignal?.aborted ? "ImageToText was interrupted." : "ImageToText request failed.",
        context.abortSignal?.aborted ? "interrupted" : "provider",
      );
    } finally {
      abortScope.dispose();
    }
  },
};

interface ParsedInput {
  imagePath?: string;
  imageUrl?: string;
  prompt: string;
}

function parseInput(input: Record<string, unknown>, cwd: string): ParsedInput | string {
  const allowed = new Set(["image_path", "image_url", "prompt"]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) return `ImageToText does not accept: ${unknown.join(", ")}.`;

  const rawPath = typeof input.image_path === "string" ? input.image_path.trim() : "";
  const imageUrl = typeof input.image_url === "string" ? input.image_url.trim() : "";
  if ((rawPath ? 1 : 0) + (imageUrl ? 1 : 0) !== 1) {
    return "ImageToText requires exactly one of image_path or image_url.";
  }
  if (imageUrl) {
    try {
      const url = new URL(imageUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    } catch {
      return "ImageToText image_url must be an HTTP(S) URL.";
    }
  }
  return {
    ...(rawPath ? { imagePath: resolveToolPath(rawPath, cwd) } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    prompt: typeof input.prompt === "string" && input.prompt.trim()
      ? input.prompt.trim()
      : "Describe this image in detail.",
  };
}

async function buildImageBlock(
  input: ParsedInput,
  apiFormat: Settings["apiFormat"],
): Promise<Record<string, unknown>> {
  if (input.imageUrl) {
    return apiFormat === "anthropic"
      ? { type: "image", source: { type: "url", url: input.imageUrl } }
      : { type: "image_url", image_url: { url: input.imageUrl } };
  }

  const imagePath = input.imagePath!;
  const mediaType = MEDIA_TYPES[extname(imagePath).toLowerCase()];
  if (!mediaType) throw new Error("ImageToText only supports jpg, jpeg, png, gif, and webp files.");
  const data = (await readFile(imagePath)).toString("base64");
  return apiFormat === "anthropic"
    ? { type: "image", source: { type: "base64", media_type: mediaType, data } }
    : { type: "image_url", image_url: { url: `data:${mediaType};base64,${data}` } };
}

async function requestDescription(
  settings: Settings,
  imageBlock: Record<string, unknown>,
  prompt: string,
  signal: AbortSignal,
): Promise<ToolResult> {
  const baseUrl = (settings.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
  const apiKey = settings.apiKey ?? "";
  const anthropic = settings.apiFormat === "anthropic";
  const response = await fetch(`${baseUrl}${anthropic ? "/v1/messages" : "/v1/chat/completions"}`, {
    method: "POST",
    headers: anthropic
      ? { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: settings.model,
      max_tokens: MAX_DESCRIPTION_TOKENS,
      messages: [{ role: "user", content: [imageBlock, { type: "text", text: prompt }] }],
    }),
    signal,
  });
  if (!response.ok) {
    const body = redactProviderBody(await response.text(), apiKey);
    return errorResult(`ImageToText provider error ${response.status}: ${body}`, "provider");
  }

  if (anthropic) {
    const json = await response.json() as { content?: Array<{ type?: string; text?: string }> };
    const text = json.content?.find((item) => item.type === "text")?.text ?? "";
    return { content: [{ type: "text", text: text || "(no description returned)" }] };
  }
  const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = json.choices?.[0]?.message?.content ?? "";
  return { content: [{ type: "text", text: text || "(no description returned)" }] };
}

function redactProviderBody(body: string, apiKey: string): string {
  const redacted = apiKey ? body.split(apiKey).join("[redacted]") : body;
  return redacted.slice(0, 1_000);
}

function errorResult(message: string, failureKind: ToolFailureKind): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true, failureKind };
}

function safeMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "ImageToText could not read the image.";
}
