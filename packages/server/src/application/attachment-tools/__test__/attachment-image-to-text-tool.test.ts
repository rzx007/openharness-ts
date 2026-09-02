import { describe, expect, it, vi } from "vitest";

import { createAttachmentImageToTextTool } from "../attachment-image-to-text-tool.js";

describe("daemon ImageToText tool", () => {
  it("uses root-authorized OCR for attachments and delegates other images", async () => {
    const defaultExecute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "vision" }] }));
    const recognize = vi.fn(async () => ({
      status: "completed" as const,
      text: "invoice 123",
      representationId: "rep-1",
      processor: "light-ocr" as const,
      processorVersion: "1",
      cached: false,
      lineCount: 1,
      durationMs: 2,
    }));
    const tool = createAttachmentImageToTextTool({
      pathOrUrlImageTool: { name: "ImageToText", description: "vision", inputSchema: {}, execute: defaultExecute },
      authorizationSessions: { resolve: (id) => id === "child" ? "root" : undefined },
      attachmentOcr: { recognize },
    });

    await tool.execute({ image_url: "https://example.com/a.png" }, { cwd: "C:/work", sessionId: "child" });
    expect(defaultExecute).toHaveBeenCalledOnce();

    const result = await tool.execute(
      { attachment_id: "att-1" },
      { cwd: "C:/work", sessionId: "child" },
    );
    expect(recognize).toHaveBeenCalledWith(expect.objectContaining({
      authorizationSessionId: "root", assetId: "att-1",
    }));
    expect((result.content[0] as { text: string }).text).toContain("invoice 123");
    expect(result.metadata).toMatchObject({ attachmentOcr: { assetId: "att-1" } });
  });

  it("rejects mixed attachment input before OCR", async () => {
    const recognize = vi.fn();
    const tool = createAttachmentImageToTextTool({
      pathOrUrlImageTool: { name: "ImageToText", description: "vision", inputSchema: {}, execute: vi.fn() },
      authorizationSessions: { resolve: () => "root" },
      attachmentOcr: { recognize },
    });
    await expect(tool.execute(
      { attachment_id: "att-1", prompt: "describe" },
      { cwd: "C:/work", sessionId: "child" },
    )).resolves.toMatchObject({ isError: true, failureKind: "command" });
    expect(recognize).not.toHaveBeenCalled();
  });
});
