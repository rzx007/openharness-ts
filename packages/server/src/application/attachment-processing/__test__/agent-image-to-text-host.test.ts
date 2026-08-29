import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { AgentImageToTextHostAdapter } from "../agent-image-to-text-host.js";

describe("AgentImageToTextHostAdapter", () => {
  it("uses an existing attachment without importing it again", async () => {
    const recognize = vi.fn(async () => ocrResult());
    const importAttachment = vi.fn();
    const host = new AgentImageToTextHostAdapter({
      importAttachment,
      recognize,
      readLocalFile: vi.fn(),
      downloadRemote: vi.fn(),
    });

    await expect(host.recognize(
      { attachmentId: "att-1" },
      { cwd: "C:/repo", sessionId: "s1" },
    )).resolves.toMatchObject({ assetId: "att-1", status: "completed" });
    expect(importAttachment).not.toHaveBeenCalled();
    expect(recognize).toHaveBeenCalledWith({ assetId: "att-1", signal: expect.any(AbortSignal) });
  });

  it("imports a local path through the attachment service before OCR", async () => {
    const root = await mkdtemp(join(tmpdir(), "ocr-local-"));
    await mkdir(join(root, "images"));
    await writeFile(join(root, "images", "receipt.png"), Buffer.from([1, 2, 3]));
    const importAttachment = vi.fn(async () => ({ id: "att-local" }));
    const readLocalFile = vi.fn(async () => ({
      displayName: "receipt.png",
      content: streamOf(new Uint8Array([1, 2, 3])),
    }));
    const host = new AgentImageToTextHostAdapter({
      importAttachment,
      recognize: async () => ocrResult("att-local"),
      readLocalFile,
      downloadRemote: vi.fn(),
    });

    await host.recognize({ imagePath: "images/receipt.png" }, { cwd: root });
    expect(readLocalFile).toHaveBeenCalledWith(
      resolve(root, "images/receipt.png"),
      expect.any(AbortSignal),
    );
    expect(importAttachment).toHaveBeenCalledWith(expect.objectContaining({
      displayName: "receipt.png",
      signal: expect.any(AbortSignal),
    }));
  });

  it("rejects nested and absolute image_path escapes outside the session cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "ocr-cwd-"));
    const outside = await mkdtemp(join(tmpdir(), "ocr-secret-"));
    await writeFile(join(outside, "secret.png"), Buffer.from([9, 9, 9]));
    await mkdir(join(root, "images"));
    const readLocalFile = vi.fn(async () => ({
      displayName: "secret.png",
      content: streamOf(new Uint8Array([9, 9, 9])),
    }));
    const host = new AgentImageToTextHostAdapter({
      importAttachment: vi.fn(async () => ({ id: "att-leak" })),
      recognize: async () => ocrResult("att-leak"),
      readLocalFile,
      downloadRemote: vi.fn(),
    });

    const nestedEscape = join("images", relative(join(root, "images"), join(outside, "secret.png")));
    await expect(host.recognize(
      { imagePath: nestedEscape },
      { cwd: root },
    )).rejects.toThrow(/工作目录|workspace|cwd|路径/i);

    await expect(host.recognize(
      { imagePath: join(outside, "secret.png") },
      { cwd: root },
    )).rejects.toThrow(/工作目录|workspace|cwd|路径/i);

    expect(readLocalFile).not.toHaveBeenCalled();
  });

  it("rejects image_path symlink escapes that leave the session cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "ocr-link-cwd-"));
    const outside = await mkdtemp(join(tmpdir(), "ocr-link-secret-"));
    const secret = join(outside, "secret.png");
    await writeFile(secret, Buffer.from([7, 7, 7]));
    await symlink(secret, join(root, "leaky.png"));
    const readLocalFile = vi.fn(async () => ({
      displayName: "secret.png",
      content: streamOf(new Uint8Array([7, 7, 7])),
    }));
    const host = new AgentImageToTextHostAdapter({
      importAttachment: vi.fn(async () => ({ id: "att-link" })),
      recognize: async () => ocrResult("att-link"),
      readLocalFile,
      downloadRemote: vi.fn(),
    });

    await expect(host.recognize(
      { imagePath: "leaky.png" },
      { cwd: root },
    )).rejects.toThrow(/工作目录|workspace|cwd|路径/i);
    expect(readLocalFile).not.toHaveBeenCalled();
  });

  it("imports a public URL and rejects non-http protocols", async () => {
    const importAttachment = vi.fn(async () => ({ id: "att-url" }));
    const downloadRemote = vi.fn(async () => ({
      displayName: "scan.jpg",
      declaredMediaType: "image/jpeg",
      content: streamOf(new Uint8Array([4, 5, 6])),
    }));
    const host = new AgentImageToTextHostAdapter({
      importAttachment,
      recognize: async () => ocrResult("att-url"),
      readLocalFile: vi.fn(),
      downloadRemote,
    });

    await host.recognize({ imageUrl: "https://example.com/scan.jpg" }, { cwd: "C:/repo" });
    expect(downloadRemote).toHaveBeenCalledWith(
      new URL("https://example.com/scan.jpg"),
      expect.any(AbortSignal),
    );
    await expect(host.recognize(
      { imageUrl: "file:///etc/passwd" },
      { cwd: "C:/repo" },
    )).rejects.toThrow("HTTP(S)");
  });
});

function ocrResult(assetId = "att-1") {
  return {
    status: "completed" as const,
    text: "hello",
    lines: [],
    representationId: "rep-1",
    processor: "light-ocr" as const,
    processorVersion: "0.5.7" as const,
    cached: false,
    lineCount: 1,
    durationMs: 3,
    assetId,
  };
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}
