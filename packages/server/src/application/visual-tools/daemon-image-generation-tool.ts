import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@openharness/core";

import { createToolAbortScope } from "./tool-abort-scope.js";

const IMAGES_DIR = join(homedir(), ".openharness-ts", "images");
const DEFAULT_MODEL = "agnes-image-2.5-flash";
const DEFAULT_BASE_URL = "https://api.agnes-ai.cn/v1";
const SIZE_VALUES = ["1K", "2K", "3K", "4K"] as const;
const RATIO_VALUES = ["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"] as const;

export function createDaemonImageGenerationTool(): ToolDefinition {
  return {
    name: "ImageGeneration",
    description:
      "Generate or edit an image with Agnes Image 2.5 Flash. Use a text prompt for text-to-image, and optional reference image URLs or data URIs for image-to-image or multi-image composition. Returns saved image paths.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Text instruction for generation or editing." },
        size: {
          type: "string",
          enum: [...SIZE_VALUES],
          description: "Output resolution tier. Default: 1K.",
        },
        ratio: {
          type: "string",
          enum: [...RATIO_VALUES],
          description: "Output aspect ratio used with size. Default: 1:1.",
        },
        images: {
          type: "array",
          items: { type: "string" },
          description: "Reference images as public HTTPS URLs or data:image/...;base64,... URIs.",
        },
        model: {
          type: "string",
          description: `Optional model override. Defaults to ${DEFAULT_MODEL}.`,
        },
      },
      required: ["prompt"],
    },
    async execute(input, context) {
      const prompt = readRequiredString(input.prompt, "prompt");
      if ("error" in prompt) return policyError(prompt.error);
      const size = readEnum(input.size, SIZE_VALUES, "1K");
      if ("error" in size) return policyError(size.error);
      const ratio = readEnum(input.ratio, RATIO_VALUES, "1:1");
      if ("error" in ratio) return policyError(ratio.error);
      const images = readImages(input.images);
      if ("error" in images) return policyError(images.error);
      const model = optionalString(input.model) ?? DEFAULT_MODEL;
      const settings = context.settings;
      if (!settings) {
        return policyError("ImageGeneration is unavailable because runtime settings are missing.");
      }
      const apiKey = settings.apiKey?.trim() ?? "";
      if (!apiKey) {
        return policyError("ImageGeneration is unavailable because no API key is configured.");
      }

      const generationAbortScope = createToolAbortScope(context.abortSignal, 180_000);
      try {
        const response = await fetch(imagesGenerationsUrl(settings.baseUrl ?? DEFAULT_BASE_URL), {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(buildAgnesRequest({
            model,
            prompt: prompt.value,
            size: size.value,
            ratio: ratio.value,
            images: images.value,
          })),
          signal: generationAbortScope.signal,
        });
        if (!response.ok) {
          const body = redactProviderBody(await response.text(), apiKey);
          return {
            content: [{ type: "text", text: `ImageGeneration provider error ${response.status}: ${body}` }],
            isError: true,
            failureKind: "provider",
          };
        }

        const json = await response.json() as {
          data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
        };
        if (!json.data?.length) {
          return { content: [{ type: "text", text: "ImageGeneration: no images returned" }], isError: true };
        }

        await mkdir(IMAGES_DIR, { recursive: true });
        const savedPaths: string[] = [];
        for (const item of json.data) {
          const filePath = join(IMAGES_DIR, `image-${Date.now()}-${savedPaths.length}.png`);
          if (item.b64_json) {
            await writeFile(filePath, Buffer.from(item.b64_json, "base64"));
          } else if (item.url) {
            const downloadAbortScope = createToolAbortScope(context.abortSignal, 60_000);
            try {
              const imageResponse = await fetch(item.url, { signal: downloadAbortScope.signal });
              if (!imageResponse.ok) {
                savedPaths.push(`(download failed: ${item.url})`);
                continue;
              }
              await writeFile(filePath, Buffer.from(await imageResponse.arrayBuffer()));
            } finally {
              downloadAbortScope.dispose();
            }
          } else {
            continue;
          }
          savedPaths.push(filePath);
        }

        const revisedPrompt = json.data[0]?.revised_prompt;
        let text = savedPaths.map((path, index) => `Image ${index + 1}: ${path}`).join("\n");
        if (revisedPrompt) text += `\nRevised prompt: ${revisedPrompt}`;
        return { content: [{ type: "text", text }] };
      } catch {
        const interrupted = context.abortSignal?.aborted === true;
        return {
          content: [{
            type: "text",
            text: interrupted ? "ImageGeneration interrupted" : "ImageGeneration request failed",
          }],
          isError: true,
          failureKind: interrupted ? "interrupted" : "provider",
        };
      } finally {
        generationAbortScope.dispose();
      }
    },
  };
}

function buildAgnesRequest(input: {
  model: string;
  prompt: string;
  size: string;
  ratio: string;
  images: string[];
}): Record<string, unknown> {
  if (input.images.length === 0) {
    return {
      model: input.model,
      prompt: input.prompt,
      size: input.size,
      ratio: input.ratio,
      return_base64: true,
    };
  }
  return {
    model: input.model,
    prompt: input.prompt,
    size: input.size,
    ratio: input.ratio,
    extra_body: {
      image: input.images,
      response_format: "b64_json",
    },
  };
}

function imagesGenerationsUrl(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, "");
  return root.endsWith("/v1") ? `${root}/images/generations` : `${root}/v1/images/generations`;
}

function readRequiredString(value: unknown, field: string): { value: string } | { error: string } {
  if (typeof value !== "string" || !value.trim()) return { error: `${field} is required.` };
  return { value: value.trim() };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): { value: T } | { error: string } {
  if (value === undefined) return { value: fallback };
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return { value: value as T };
  }
  return { error: `Unsupported value: ${String(value)}` };
}

function readImages(value: unknown): { value: string[] } | { error: string } {
  if (value === undefined) return { value: [] };
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    return { error: "images must be an array of image URLs or data URIs." };
  }
  return { value: value.map((item) => item.trim()) };
}

function policyError(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
    failureKind: "policy" as const,
  };
}

function redactProviderBody(body: string, apiKey: string): string {
  const redacted = apiKey ? body.split(apiKey).join("[redacted]") : body;
  return redacted.slice(0, 1_000);
}
