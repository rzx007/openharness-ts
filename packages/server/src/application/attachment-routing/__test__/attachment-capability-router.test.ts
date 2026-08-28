import type { SessionInputAttachmentRecord } from "@openharness/protocol";
import { describe, expect, it, vi } from "vitest";

import { AttachmentCapabilityRouter } from "../attachment-capability-router.js";

function attachment(
  assetId: string,
  seq: number,
  overrides: Partial<SessionInputAttachmentRecord> = {},
): SessionInputAttachmentRecord {
  return {
    id: `ref-${assetId}`,
    sessionId: "session-1",
    inputId: "input-1",
    assetId,
    seq,
    intent: "auto",
    displayName: `${assetId}.png`,
    mediaType: "image/png",
    sizeBytes: 4,
    metadata: {},
    createdAt: 1,
    ...overrides,
  };
}

function harness() {
  const resolveReadyContentPath = vi.fn(async (assetId: string) => ({
    assetId,
    path: `D:/daemon/blobs/${assetId}`,
    mediaType: "image/png",
    sizeBytes: 4,
  }));
  return {
    resolveReadyContentPath,
    router: new AttachmentCapabilityRouter({ resolveReadyContentPath }),
  };
}

describe("AttachmentCapabilityRouter", () => {
  it("routes unsupported image models to an explicit ImageToText resource hint", async () => {
    const { router, resolveReadyContentPath } = harness();
    const result = await router.route({
      text: "读一下票据",
      attachments: [attachment("receipt", 0)],
      modelCapabilities: { image: "unsupported" },
      providerCapabilities: { image: "native", imageMediaTypes: ["image/png"] },
      availableTools: ["ImageToText"],
      imageToTextHostAvailable: true,
    } as any);

    expect(resolveReadyContentPath).not.toHaveBeenCalled();
    expect(result.decisions).toEqual([
      expect.objectContaining({ assetId: "receipt", route: "image_to_text_tool" }),
    ]);
    expect(result.content).toEqual([
      { type: "text", text: "读一下票据" },
      { type: "text", text: expect.stringContaining("ImageToText") },
    ]);
    expect((result.content[1] as { text: string }).text).toContain("receipt");
  });

  it("blocks OCR fallback before provider execution when ImageToText is filtered out", async () => {
    const { router } = harness();
    await expect(router.route({
      text: "read",
      attachments: [attachment("receipt", 0)],
      modelCapabilities: { image: "unsupported" },
      providerCapabilities: { image: "native", imageMediaTypes: ["image/png"] },
      availableTools: [],
      imageToTextHostAvailable: true,
    } as any)).rejects.toMatchObject({ code: "attachment_ocr_tool_unavailable" });
  });
  it.each(["unknown", "unsupported"] as const)("falls back when model image support is %s", async (image) => {
    const { router, resolveReadyContentPath } = harness();
    await expect(
      router.route({
        text: "describe",
        attachments: [attachment("a", 0)],
        modelCapabilities: { image },
        providerCapabilities: {
          image: "native",
          imageMediaTypes: ["image/png"],
        },
        availableTools: ["ImageToText"],
        imageToTextHostAvailable: true,
      }),
    ).resolves.toMatchObject({ decisions: [{ route: "image_to_text_tool" }] });
    expect(resolveReadyContentPath).not.toHaveBeenCalled();
  });

  it.each(["unknown", "unsupported"] as const)("falls back when provider image support is %s", async (image) => {
    const { router } = harness();
    await expect(
      router.route({
        text: "",
        attachments: [attachment("a", 0)],
        modelCapabilities: { image: "native" },
        providerCapabilities: { image, imageMediaTypes: ["image/png"] },
        availableTools: ["ImageToText"],
        imageToTextHostAvailable: true,
      }),
    ).resolves.toMatchObject({ decisions: [{ route: "image_to_text_tool" }] });
  });

  it("routes explicit OCR and OCR-compatible media without blob I/O", async () => {
    const { router, resolveReadyContentPath } = harness();
    await expect(
      router.route({
        text: "read",
        attachments: [attachment("ocr", 0, { intent: "ocr" })],
        modelCapabilities: { image: "native" },
        providerCapabilities: {
          image: "native",
          imageMediaTypes: ["image/png"],
        },
        availableTools: ["ImageToText"],
        imageToTextHostAvailable: true,
      }),
    ).resolves.toMatchObject({ decisions: [{ route: "image_to_text_tool" }] });
    await expect(
      router.route({
        text: "read",
        attachments: [attachment("bmp", 0, { mediaType: "image/bmp" })],
        modelCapabilities: { image: "native" },
        providerCapabilities: { image: "native", imageMediaTypes: ["image/png"] },
        availableTools: ["ImageToText"],
        imageToTextHostAvailable: true,
      }),
    ).resolves.toMatchObject({ decisions: [{ route: "image_to_text_tool" }] });
    expect(resolveReadyContentPath).not.toHaveBeenCalled();
  });

  it("blocks unsupported content before blob I/O", async () => {
    const { router, resolveReadyContentPath } = harness();
    await expect(
      router.route({
        text: "read",
        attachments: [
          attachment("pdf", 0, {
            displayName: "a.pdf",
            mediaType: "application/pdf",
          }),
        ],
        modelCapabilities: { image: "native" },
        providerCapabilities: {
          image: "native",
          imageMediaTypes: ["image/png"],
        },
      }),
    ).rejects.toMatchObject({ code: "attachment_kind_unsupported" });
    expect(resolveReadyContentPath).not.toHaveBeenCalled();
  });

  it("materializes text and images in stable attachment order", async () => {
    const { router } = harness();
    await expect(
      router.route({
        text: "compare",
        attachments: [attachment("second", 2), attachment("first", 1)],
        modelCapabilities: { image: "native" },
        providerCapabilities: {
          image: "native",
          imageMediaTypes: ["image/png"],
        },
      }),
    ).resolves.toMatchObject({
      content: [
        { type: "text", text: "compare" },
        { type: "image", source: { path: "D:/daemon/blobs/first" } },
        { type: "image", source: { path: "D:/daemon/blobs/second" } },
      ],
    });
  });

  it("does not expose partial blocks when one blob fails", async () => {
    const resolveReadyContentPath = vi
      .fn()
      .mockResolvedValueOnce({
        assetId: "a",
        path: "D:/daemon/blobs/a",
        mediaType: "image/png",
        sizeBytes: 4,
      })
      .mockRejectedValueOnce(new Error("missing blob"));
    const router = new AttachmentCapabilityRouter({ resolveReadyContentPath });

    await expect(
      router.route({
        text: "",
        attachments: [attachment("a", 0), attachment("b", 1)],
        modelCapabilities: { image: "native" },
        providerCapabilities: {
          image: "native",
          imageMediaTypes: ["image/png"],
        },
      }),
    ).rejects.toMatchObject({
      code: "attachment_materialization_failed",
      assetIds: ["a", "b"],
    });
  });

  it("stops before materialization when already aborted", async () => {
    const { router, resolveReadyContentPath } = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      router.route({
        text: "",
        attachments: [attachment("a", 0)],
        modelCapabilities: { image: "native" },
        providerCapabilities: {
          image: "native",
          imageMediaTypes: ["image/png"],
        },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "attachment_routing_aborted" });
    expect(resolveReadyContentPath).not.toHaveBeenCalled();
  });
});
