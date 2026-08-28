import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";

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

    await host.recognize({ imagePath: "images/receipt.png" }, { cwd: "C:/repo" });
    expect(readLocalFile).toHaveBeenCalledWith(
      resolve("C:/repo", "images/receipt.png"),
      expect.any(AbortSignal),
    );
    expect(importAttachment).toHaveBeenCalledWith(expect.objectContaining({
      displayName: "receipt.png",
      signal: expect.any(AbortSignal),
    }));
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
