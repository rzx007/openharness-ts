import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { ToolDefinition } from "@openharness/core";
import { loadSettings } from "@openharness/core";

const MAX_DESCRIPTION_TOKENS = 1024;

async function toBase64DataUrl(imagePath: string): Promise<{ type: "base64"; mediaType: string; data: string }> {
  const buf = await readFile(imagePath);
  const ext = imagePath.split(".").pop()?.toLowerCase() ?? "jpeg";
  const mediaTypeMap: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };
  const mediaType = mediaTypeMap[ext] ?? "image/jpeg";
  return { type: "base64", mediaType, data: buf.toString("base64") };
}

export const imageToTextTool: ToolDefinition = {
  name: "ImageToText",
  description:
    "Describe or extract text from an image using a vision model. " +
    "Useful when the current model cannot process images directly. " +
    "Accepts a local file path or a public image URL.",
  inputSchema: {
    type: "object",
    properties: {
      image_path: {
        type: "string",
        description: "Absolute path to a local image file (jpg/png/gif/webp).",
      },
      image_url: {
        type: "string",
        description: "Public URL of an image. Used when image_path is not provided.",
      },
      prompt: {
        type: "string",
        description:
          'Instruction for the vision model, e.g. "describe this image" or "extract all text". ' +
          'Defaults to "Describe this image in detail."',
      },
    },
  },
  async execute(input) {
    const imagePath = input.image_path as string | undefined;
    const imageUrl = input.image_url as string | undefined;
    const prompt = (input.prompt as string | undefined) ?? "Describe this image in detail.";

    if (!imagePath && !imageUrl) {
      return { content: [{ type: "text", text: "image_to_text: provide image_path or image_url" }], isError: true };
    }

    const settings = await loadSettings();
    const model = settings.visionModel ?? settings.model;
    const apiKey = settings.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "";
    const baseUrl = (settings.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
    const apiFormat = settings.apiFormat ?? "openai";

    // Build image content block
    let imageBlock: Record<string, unknown>;
    if (imagePath) {
      if (!existsSync(imagePath)) {
        return { content: [{ type: "text", text: `image_to_text: file not found: ${imagePath}` }], isError: true };
      }
      const { type, mediaType, data } = await toBase64DataUrl(imagePath);
      if (apiFormat === "anthropic") {
        imageBlock = { type: "image", source: { type, media_type: mediaType, data } };
      } else {
        imageBlock = {
          type: "image_url",
          image_url: { url: `data:${mediaType};base64,${data}` },
        };
      }
    } else {
      if (apiFormat === "anthropic") {
        imageBlock = { type: "image", source: { type: "url", url: imageUrl } };
      } else {
        imageBlock = { type: "image_url", image_url: { url: imageUrl } };
      }
    }

    try {
      let responseText: string;

      if (apiFormat === "anthropic") {
        const res = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model,
            max_tokens: MAX_DESCRIPTION_TOKENS,
            messages: [
              {
                role: "user",
                content: [imageBlock, { type: "text", text: prompt }],
              },
            ],
          }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) {
          const body = await res.text();
          return { content: [{ type: "text", text: `image_to_text API error ${res.status}: ${body}` }], isError: true };
        }
        const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
        responseText = json.content?.find((b) => b.type === "text")?.text ?? "";
      } else {
        // OpenAI-compatible
        const res = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            max_tokens: MAX_DESCRIPTION_TOKENS,
            messages: [
              {
                role: "user",
                content: [imageBlock, { type: "text", text: prompt }],
              },
            ],
          }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) {
          const body = await res.text();
          return { content: [{ type: "text", text: `image_to_text API error ${res.status}: ${body}` }], isError: true };
        }
        const json = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        responseText = json.choices?.[0]?.message?.content ?? "";
      }

      return { content: [{ type: "text", text: responseText || "(no description returned)" }] };
    } catch (err) {
      return { content: [{ type: "text", text: `image_to_text failed: ${(err as Error).message}` }], isError: true };
    }
  },
};
