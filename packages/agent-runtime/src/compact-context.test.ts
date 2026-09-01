import type { CompactAttachmentCatalog } from "@openharness/core";
import { describe, expect, it } from "vitest";

import { createCompactContextProvider } from "./compact-context.js";

const attachmentCatalog: CompactAttachmentCatalog = {
  entries: [
    {
      assetId: "asset-spec",
      displayName: "spec.pdf",
      mediaType: "application/pdf",
      sizeBytes: 128,
      intent: "tool_resource",
      status: "available",
      resourceUri: "attachment://asset-spec/spec.pdf",
      access: "read_text",
    },
  ],
};

describe("createCompactContextProvider", () => {
  it("combines the attachment catalog and session memory", async () => {
    const provider = createCompactContextProvider({
      attachmentCatalog: async () => attachmentCatalog,
      sessionMemory: async () => "goal: finish phase two",
    });

    await expect(provider()).resolves.toEqual({
      attachmentCatalog,
      sessionMemory: "goal: finish phase two",
    });
  });

  it("omits each source when it is not configured", async () => {
    const attachmentOnly = createCompactContextProvider({
      attachmentCatalog: () => attachmentCatalog,
    });
    const memoryOnly = createCompactContextProvider({
      sessionMemory: () => "goal: finish phase two",
    });

    await expect(attachmentOnly()).resolves.toEqual({ attachmentCatalog });
    await expect(memoryOnly()).resolves.toEqual({
      sessionMemory: "goal: finish phase two",
    });
  });

  it("omits sources that return an empty value", async () => {
    const emptyMemory = createCompactContextProvider({
      attachmentCatalog: () => undefined,
      sessionMemory: () => "",
    });

    await expect(emptyMemory()).resolves.toEqual({});
  });

  it("rejects with the original source error", async () => {
    const sourceError = new Error("session memory unavailable");
    const provider = createCompactContextProvider({
      sessionMemory: async () => {
        throw sourceError;
      },
    });

    await expect(provider()).rejects.toBe(sourceError);
  });
});
