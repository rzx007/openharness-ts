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
  it.each([
    ["unknown", "attachment_model_capability_unknown"],
    ["unsupported", "attachment_model_unsupported"],
  ] as const)("blocks model image support %s", async (image, code) => {
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
      }),
    ).rejects.toMatchObject({ code, assetIds: ["a"], retryable: false });
    expect(resolveReadyContentPath).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown", "attachment_provider_capability_unknown"],
    ["unsupported", "attachment_provider_unsupported"],
  ] as const)("blocks provider image support %s", async (image, code) => {
    const { router } = harness();
    await expect(
      router.route({
        text: "",
        attachments: [attachment("a", 0)],
        modelCapabilities: { image: "native" },
        providerCapabilities: { image, imageMediaTypes: ["image/png"] },
      }),
    ).rejects.toMatchObject({ code, assetIds: ["a"] });
  });

  it("blocks unavailable intents and unsupported content before blob I/O", async () => {
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
      }),
    ).rejects.toMatchObject({ code: "attachment_intent_unavailable" });
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
    await expect(
      router.route({
        text: "read",
        attachments: [attachment("bmp", 0, { mediaType: "image/bmp" })],
        modelCapabilities: { image: "native" },
        providerCapabilities: {
          image: "native",
          imageMediaTypes: ["image/png"],
        },
      }),
    ).rejects.toMatchObject({ code: "attachment_media_type_unsupported" });
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
