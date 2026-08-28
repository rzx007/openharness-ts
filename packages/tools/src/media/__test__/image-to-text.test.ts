import { describe, expect, it, vi } from "vitest";

import { imageToTextTool } from "../image-to-text.js";

describe("ImageToText", () => {
  it("accepts exactly one local OCR source and delegates to the host", async () => {
    const recognize = vi.fn(async () => ({
      status: "completed" as const,
      text: "发票号码 123",
      assetId: "att-1",
      representationId: "rep-1",
      processor: "light-ocr" as const,
      processorVersion: "0.5.7",
      cached: false,
      lineCount: 1,
      durationMs: 8,
    }));

    const result = await imageToTextTool.execute(
      { attachment_id: "att-1" },
      { cwd: "C:/work", imageToText: { recognize } } as any,
    );

    expect(recognize).toHaveBeenCalledWith(
      { attachmentId: "att-1" },
      expect.objectContaining({ cwd: "C:/work" }),
    );
    expect(result).toMatchObject({
      metadata: {
        attachmentOcr: {
          assetId: "att-1",
          representationId: "rep-1",
          status: "completed",
        },
      },
    });
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("发票号码 123") });
  });

  it("rejects prompt, multiple sources, and a missing OCR host", async () => {
    await expect(imageToTextTool.execute(
      { attachment_id: "a", prompt: "describe" },
      { cwd: "C:/work", imageToText: { recognize: vi.fn() } } as any,
    )).resolves.toMatchObject({ isError: true });
    await expect(imageToTextTool.execute(
      { attachment_id: "a", image_url: "https://example.com/a.png" },
      { cwd: "C:/work", imageToText: { recognize: vi.fn() } } as any,
    )).resolves.toMatchObject({ isError: true });
    await expect(imageToTextTool.execute(
      { attachment_id: "a" },
      { cwd: "C:/work" } as any,
    )).resolves.toMatchObject({ isError: true, failureKind: "policy" });
  });

  it("returns no_text_detected without inventing a description", async () => {
    const result = await imageToTextTool.execute(
      { attachment_id: "empty" },
      {
        cwd: "C:/work",
        imageToText: {
          recognize: async () => ({
            status: "no_text_detected",
            text: "",
            assetId: "empty",
            representationId: "rep-empty",
            processor: "light-ocr",
            processorVersion: "0.5.7",
            cached: false,
            lineCount: 0,
            durationMs: 2,
          }),
        },
      } as any,
    );

    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toContain("未检测到文字");
    expect((result.content[0] as { text: string }).text).toContain("不能描述图片");
  });
});
