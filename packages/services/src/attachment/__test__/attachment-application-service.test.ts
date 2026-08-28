import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionStore } from "../../session-runtime/store.js";
import { AttachmentApplicationService } from "../attachment-application-service.js";
import { AttachmentBlobStore } from "../attachment-blob-store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function createHarness(options: {
  ids?: string[];
  now?: number;
  maxBytesPerFile?: number;
  stagingTtlMs?: number;
} = {}): {
  root: string;
  store: SessionStore;
  service: AttachmentApplicationService;
} {
  const root = mkdtempSync(join(tmpdir(), "ohs-attachment-service-"));
  roots.push(root);
  const store = new SessionStore({ path: join(root, "store.db") });
  const ids = [...(options.ids ?? ["att_test"])];
  const now = () => options.now ?? 1_000;
  const blobs = new AttachmentBlobStore({ root: join(root, "attachments"), now });
  const service = new AttachmentApplicationService({
    store,
    blobs,
    now,
    id: () => ids.shift() ?? "att_unexpected",
    ...(options.maxBytesPerFile !== undefined || options.stagingTtlMs !== undefined
      ? {
          limits: {
            ...(options.maxBytesPerFile !== undefined
              ? {
                  maxBytesPerFile: options.maxBytesPerFile,
                  resumableThresholdBytes: options.maxBytesPerFile,
                }
              : {}),
            ...(options.stagingTtlMs !== undefined
              ? { stagingTtlMs: options.stagingTtlMs }
              : {}),
          },
        }
      : {}),
  });
  return { root, store, service };
}

describe("AttachmentApplicationService", () => {
  it("imports ready assets and reuses identical blob bytes", async () => {
    const { root, store, service } = createHarness({
      ids: ["att_first", "att_second"],
    });
    try {
      const first = await service.import({
        displayName: "a.txt",
        declaredMediaType: "text/plain",
        content: streamOf([bytes("hello")]),
      });
      const second = await service.import({
        displayName: "copy.txt",
        declaredMediaType: "text/plain",
        content: streamOf([bytes("hello")]),
      });

      expect(first).toMatchObject({
        id: "att_first",
        status: "ready",
        mediaType: "text/plain",
        sizeBytes: 5,
      });
      expect(second).toMatchObject({
        id: "att_second",
        status: "ready",
        sha256: first.sha256,
      });
      const opened = await service.openContent(first.id);
      expect(opened.sha256).toBe(first.sha256);
      await expect(service.resolveReadyContentPath(first.id)).resolves.toEqual({
        assetId: first.id,
        path: join(
          root,
          "attachments",
          "blobs",
          first.sha256!.slice(0, 2),
          first.sha256!,
        ),
        mediaType: "text/plain",
        sizeBytes: 5,
      });
      expect(
        existsSync(
          join(
            root,
            "attachments",
            "blobs",
            first.sha256!.slice(0, 2),
            first.sha256!,
          ),
        ),
      ).toBe(true);
    } finally {
      store.close();
    }
  });

  it("records a failed asset when blob import exceeds the limit", async () => {
    const { root, store, service } = createHarness({
      ids: ["att_failed"],
      maxBytesPerFile: 4,
    });
    try {
      await expect(
        service.import({
          displayName: "large.txt",
          declaredMediaType: "text/plain",
          content: streamOf([bytes("too large")]),
        }),
      ).rejects.toMatchObject({ code: "attachment_too_large" });
      expect(store.getAttachment("att_failed")).toMatchObject({
        status: "failed",
        failureCode: "attachment_too_large",
      });
      await expect(
        service.import({
          displayName: "large-again.txt",
          content: streamOf([bytes("too large")]),
        }),
      ).rejects.not.toThrow(root);
    } finally {
      store.close();
    }
  });

  it("logically deletes ready assets and hides their content", async () => {
    const { store, service } = createHarness({ ids: ["att_delete"] });
    try {
      const asset = await service.import({
        displayName: "delete.txt",
        declaredMediaType: "text/plain",
        content: streamOf([bytes("x")]),
      });

      expect(service.delete(asset.id).status).toBe("deleted");
      expect(() => service.get(asset.id)).toThrow("attachment_not_found");
      await expect(service.openContent(asset.id)).rejects.toThrow(
        "attachment_not_found",
      );
    } finally {
      store.close();
    }
  });

  it("protects referenced assets until the final conversation reference is removed", async () => {
    const { root, store, service } = createHarness({ ids: ["att_shared"] });
    try {
      const asset = await service.import({
        displayName: "shared.txt",
        declaredMediaType: "text/plain",
        content: streamOf([bytes("shared bytes")]),
      });
      store.createSession({ id: "parent", cwd: process.cwd(), model: "m" });
      store.createSession({ id: "child", cwd: process.cwd(), model: "m" });
      store.admitPrompt({
        id: "parent-input",
        sessionId: "parent",
        content: "parent",
        attachments: [{ assetId: asset.id }],
      });
      store.admitPrompt({
        id: "child-input",
        sessionId: "child",
        content: "child",
        attachments: [{ assetId: asset.id }],
      });
      const blobPath = join(
        root,
        "attachments",
        "blobs",
        asset.sha256!.slice(0, 2),
        asset.sha256!,
      );

      expect(() => service.delete(asset.id)).toThrow(
        "attachment_in_use: attachment is referenced by a conversation",
      );
      store.deleteSessionTree("child");
      expect(() => service.delete(asset.id)).toThrow(
        "attachment_in_use: attachment is referenced by a conversation",
      );
      store.deleteSessionTree("parent");

      expect(service.delete(asset.id)).toMatchObject({
        id: "att_shared",
        status: "deleted",
      });
      expect(existsSync(blobPath)).toBe(true);
    } finally {
      store.close();
    }
  });

  it("classifies interrupted imports and removes expired staging on recovery", async () => {
    const { root, store, service } = createHarness({
      now: 10_000,
      stagingTtlMs: 5_000,
    });
    const staging = join(root, "attachments", "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "att_interrupted.part"), "partial");
    utimesSync(join(staging, "att_interrupted.part"), 1, 1);
    writeFileSync(join(staging, "att_current.part"), "partial");
    utimesSync(join(staging, "att_current.part"), 9, 9);
    mkdirSync(join(staging, "att_unsafe.part"));
    store.createImportingAttachment({
      id: "att_interrupted",
      displayName: "partial.bin",
      stagingName: "att_interrupted.part",
      createdAt: 100,
    });
    store.createImportingAttachment({
      id: "att_current",
      displayName: "current.bin",
      stagingName: "att_current.part",
      createdAt: 9_000,
    });
    store.createImportingAttachment({
      id: "att_missing",
      displayName: "missing.bin",
      stagingName: "att_missing.part",
      createdAt: 9_000,
    });
    store.createImportingAttachment({
      id: "att_unsafe",
      displayName: "unsafe.bin",
      stagingName: "att_unsafe.part",
      createdAt: 9_000,
    });

    try {
      const result = await service.recover();

      expect(store.getAttachment("att_interrupted")).toMatchObject({
        status: "failed",
        failureCode: "attachment_storage_failed",
      });
      expect(store.getAttachment("att_current")).toMatchObject({
        status: "failed",
        failureCode: "attachment_aborted",
      });
      expect(store.getAttachment("att_missing")).toMatchObject({
        status: "failed",
        failureCode: "attachment_storage_failed",
      });
      expect(store.getAttachment("att_unsafe")).toMatchObject({
        status: "failed",
        failureCode: "attachment_storage_failed",
      });
      expect(result).toEqual({
        failedImportIds: [
          "att_interrupted",
          "att_current",
          "att_missing",
          "att_unsafe",
        ],
        removedStagingNames: ["att_interrupted.part"],
        retainedStagingNames: ["att_current.part", "att_unsafe.part"],
      });
      expect(existsSync(join(staging, "att_interrupted.part"))).toBe(false);
      expect(existsSync(join(staging, "att_current.part"))).toBe(true);
    } finally {
      store.close();
    }
  });
});
