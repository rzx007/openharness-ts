import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
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
    const timeout = AbortSignal.timeout(60_000);
    const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
    signal.throwIfAborted();
    let assetId: string;
    if ("attachmentId" in input) {
      assetId = input.attachmentId;
    } else {
      const source = "imagePath" in input
        ? await this.readLocalFile(
          await resolveContainedImagePath(context.cwd, input.imagePath),
          signal,
        )
        : await this.readRemote(input.imageUrl, signal);
      const asset = await this.options.importAttachment({
        displayName: source.displayName,
        ...(source.declaredMediaType
          ? { declaredMediaType: source.declaredMediaType }
          : {}),
        content: source.content,
        signal,
      });
      assetId = asset.id;
    }
    const result = await this.options.recognize({ assetId, signal });
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

/** Keep OCR local reads inside the session cwd (blocks ../, absolute escapes, and symlink escapes). */
export async function resolveContainedImagePath(cwd: string, imagePath: string): Promise<string> {
  const trimmed = imagePath.trim();
  if (!trimmed) throw new Error("ImageToText image_path 不能为空");
  const root = await canonicalizeExistingPath(resolve(cwd));
  const resolved = resolve(root, trimmed);
  const canonical = await canonicalizePossiblyMissingPath(resolved);
  if (!isPathInside(canonical, root)) {
    throw new Error("ImageToText image_path 必须位于会话工作目录内");
  }
  return canonical;
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

async function canonicalizeExistingPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function canonicalizePossiblyMissingPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    const parent = await nearestExistingParent(absolute);
    const parentReal = await canonicalizeExistingPath(parent);
    const tail = relative(parent, absolute);
    return tail ? resolve(parentReal, tail) : parentReal;
  }
}

async function nearestExistingParent(path: string): Promise<string> {
  let current = path;
  while (true) {
    try {
      await stat(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

function isPathInside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
