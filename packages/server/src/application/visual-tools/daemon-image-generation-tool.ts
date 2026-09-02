import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@openharness/core";

import { createToolAbortScope } from "./tool-abort-scope.js";

const IMAGES_DIR = join(homedir(), ".openharness-ts", "images");

export function createDaemonImageGenerationTool(): ToolDefinition {
  return {
    name: "ImageGeneration",
    description:
      "Generate an image from a text prompt using an OpenAI-compatible images API. Returns the saved image paths.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Text description of the image to generate." },
        size: {
          type: "string",
          enum: ["256x256", "512x512", "1024x1024", "1792x1024", "1024x1792"],
          description: "Image dimensions. Default: 1024x1024.",
        },
        quality: {
          type: "string",
          enum: ["standard", "hd"],
          description: "Image quality. Default: standard.",
        },
        model: { type: "string", description: "Optional model override. Defaults to dall-e-3." },
        n: { type: "number", description: "Number of images to generate from 1 to 4. Default: 1." },
      },
      required: ["prompt"],
    },
    async execute(input, context) {
      const prompt = input.prompt as string;
      const size = (input.size as string | undefined) ?? "1024x1024";
      const quality = (input.quality as string | undefined) ?? "standard";
      const n = Math.min(Math.max(Math.round((input.n as number | undefined) ?? 1), 1), 4);
      const model = (input.model as string | undefined) ?? "dall-e-3";
      const settings = context.settings;
      if (!settings) {
        return {
          content: [{ type: "text", text: "ImageGeneration is unavailable because runtime settings are missing." }],
          isError: true,
          failureKind: "policy",
        };
      }

      const apiKey = settings.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "";
      const baseUrl = (settings.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
      const generationAbortScope = createToolAbortScope(context.abortSignal, 120_000);

      try {
        const response = await fetch(`${baseUrl}/v1/images/generations`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, prompt, size, quality, n, response_format: "b64_json" }),
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

function redactProviderBody(body: string, apiKey: string): string {
  const redacted = apiKey ? body.split(apiKey).join("[redacted]") : body;
  return redacted.slice(0, 1_000);
}
