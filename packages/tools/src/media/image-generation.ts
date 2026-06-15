import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ToolDefinition } from "@openharness/core";
import { loadSettings } from "@openharness/core";

const IMAGES_DIR = join(homedir(), ".openharness", "images");

export const imageGenerationTool: ToolDefinition = {
  name: "ImageGeneration",
  description:
    "Generate an image from a text prompt using an OpenAI-compatible images API (e.g. DALL-E 3). " +
    "Returns the path of the saved image file.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Text description of the image to generate.",
      },
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
      model: {
        type: "string",
        description: 'Model override, e.g. "dall-e-3". Defaults to "dall-e-3".',
      },
      n: {
        type: "number",
        description: "Number of images to generate (1–4). Default: 1.",
      },
    },
    required: ["prompt"],
  },
  async execute(input) {
    const prompt = input.prompt as string;
    const size = (input.size as string | undefined) ?? "1024x1024";
    const quality = (input.quality as string | undefined) ?? "standard";
    const n = Math.min(Math.max(Math.round((input.n as number | undefined) ?? 1), 1), 4);
    const modelOverride = input.model as string | undefined;

    const settings = await loadSettings();
    const apiKey = settings.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "";
    const baseUrl = (settings.imageGenerationBaseUrl ?? settings.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
    const model = modelOverride ?? "dall-e-3";

    try {
      const res = await fetch(`${baseUrl}/v1/images/generations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, prompt, size, quality, n, response_format: "b64_json" }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!res.ok) {
        const body = await res.text();
        return {
          content: [{ type: "text", text: `image_generation API error ${res.status}: ${body}` }],
          isError: true,
        };
      }

      const json = (await res.json()) as {
        data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
      };

      if (!json.data?.length) {
        return { content: [{ type: "text", text: "image_generation: no images returned" }], isError: true };
      }

      await mkdir(IMAGES_DIR, { recursive: true });

      const savedPaths: string[] = [];
      for (const item of json.data) {
        const ts = Date.now();
        const filename = `image-${ts}-${savedPaths.length}.png`;
        const filePath = join(IMAGES_DIR, filename);

        if (item.b64_json) {
          await writeFile(filePath, Buffer.from(item.b64_json, "base64"));
        } else if (item.url) {
          // fallback: download from URL
          const imgRes = await fetch(item.url, { signal: AbortSignal.timeout(60_000) });
          if (imgRes.ok) {
            const buf = Buffer.from(await imgRes.arrayBuffer());
            await writeFile(filePath, buf);
          } else {
            savedPaths.push(`(download failed: ${item.url})`);
            continue;
          }
        } else {
          continue;
        }
        savedPaths.push(filePath);
      }

      const revisedPrompt = json.data[0]?.revised_prompt;
      let text = savedPaths.map((p, i) => `Image ${i + 1}: ${p}`).join("\n");
      if (revisedPrompt) text += `\nRevised prompt: ${revisedPrompt}`;

      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `image_generation failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
};
