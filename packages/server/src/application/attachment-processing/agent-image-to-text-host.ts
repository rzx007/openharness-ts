import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Readable } from "node:stream";

import type {
  AgentImageToTextHost,
  AgentImageToTextInput,
  AgentImageToTextResult,
} from "@openharness/core";
import type {
  AttachmentApplicationService,
  ImportAttachmentInput,
  LocalOcrResult,
} from "@openharness/services";

import { downloadRemoteImage, type ImportedImageSource } from "./safe-remote-image.js";

export interface AgentImageToTextHostAdapterOptions {
  importAttachment(input: ImportAttachmentInput): Promise<{ id: string }>;
  recognize(input: { assetId: string; signal?: AbortSignal }): Promise<LocalOcrResult>;
  readLocalFile?(path: string, signal?: AbortSignal): Promise<ImportedImageSource>;
  downloadRemote?(url: URL, signal?: AbortSignal): Promise<ImportedImageSource>;
}

export class AgentImageToTextHostAdapter implements AgentImageToTextHost {
  private readonly readLocalFile: NonNullable<AgentImageToTextHostAdapterOptions["readLocalFile"]>;
  private readonly downloadRemote: NonNullable<AgentImageToTextHostAdapterOptions["downloadRemote"]>;

  constructor(private readonly options: AgentImageToTextHostAdapterOptions) {
    this.readLocalFile = options.readLocalFile ?? readLocalImage;
    this.downloadRemote = options.downloadRemote ?? downloadRemoteImage;
  }

  async recognize(
    input: AgentImageToTextInput,
    context: { cwd: string; sessionId?: string; signal?: AbortSignal },
  ): Promise<AgentImageToTextResult> {
    context.signal?.throwIfAborted();
    let assetId: string;
    if ("attachmentId" in input) {
      assetId = input.attachmentId;
    } else {
      const source = "imagePath" in input
        ? await this.readLocalFile(resolve(context.cwd, input.imagePath), context.signal)
        : await this.readRemote(input.imageUrl, context.signal);
      const asset = await this.options.importAttachment({
        displayName: source.displayName,
        ...(source.declaredMediaType
          ? { declaredMediaType: source.declaredMediaType }
          : {}),
        content: source.content,
        signal: context.signal,
      });
      assetId = asset.id;
    }
    const result = await this.options.recognize({ assetId, signal: context.signal });
    return { ...result, assetId };
  }

  private async readRemote(rawUrl: string, signal?: AbortSignal): Promise<ImportedImageSource> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error("ImageToText image_url 不是有效 URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("ImageToText image_url 只允许 HTTP(S) 地址");
    }
    return await this.downloadRemote(url, signal);
  }
}

export function createAgentImageToTextHost(options: {
  attachments: AttachmentApplicationService;
  recognize(input: { assetId: string; signal?: AbortSignal }): Promise<LocalOcrResult>;
}): AgentImageToTextHost {
  return new AgentImageToTextHostAdapter({
    importAttachment: (input) => options.attachments.import(input),
    recognize: options.recognize,
  });
}

async function readLocalImage(path: string, signal?: AbortSignal): Promise<ImportedImageSource> {
  signal?.throwIfAborted();
  const info = await stat(path);
  if (!info.isFile()) throw new Error("ImageToText image_path 必须指向普通文件");
  const stream = createReadStream(path, { signal });
  return {
    displayName: basename(path) || "image",
    content: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
  };
}
