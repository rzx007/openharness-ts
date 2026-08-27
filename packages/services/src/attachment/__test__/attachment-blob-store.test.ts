import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AttachmentBlobStore } from "../attachment-blob-store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function createStore(now = () => Date.now()): {
  root: string;
  store: AttachmentBlobStore;
} {
  const root = mkdtempSync(join(tmpdir(), "ohs-attachment-blobs-"));
  roots.push(root);
  return { root, store: new AttachmentBlobStore({ root, now }) };
}

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

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
    size += result.value.byteLength;
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

describe("AttachmentBlobStore", () => {
  it("streams content into a hash-addressed blob", async () => {
    const { root, store } = createStore();
    const result = await store.import({
      uploadId: "att-1",
      content: streamOf([bytes("hello"), bytes(" world")]),
      declaredMediaType: "text/plain; charset=utf-8",
      maxBytes: 32,
    });
    const sha256 = createHash("sha256").update("hello world").digest("hex");

    expect(result).toEqual({
      sha256,
      sizeBytes: 11,
      mediaType: "text/plain",
      deduplicated: false,
    });
    expect(existsSync(join(root, "blobs", sha256.slice(0, 2), sha256))).toBe(
      true,
    );
    expect(readdirSync(join(root, "staging"))).toEqual([]);
  });

  it("deduplicates identical bytes without creating a second blob", async () => {
    const { root, store } = createStore();
    const first = await store.import({
      uploadId: "att-1",
      content: streamOf([bytes("same")]),
      declaredMediaType: "text/plain",
      maxBytes: 32,
    });
    const second = await store.import({
      uploadId: "att-2",
      content: streamOf([bytes("same")]),
      declaredMediaType: "text/plain",
      maxBytes: 32,
    });

    expect(first.deduplicated).toBe(false);
    expect(second).toMatchObject({ sha256: first.sha256, deduplicated: true });
    expect(
      readdirSync(join(root, "blobs", first.sha256.slice(0, 2))),
    ).toEqual([first.sha256]);
    expect(readdirSync(join(root, "staging"))).toEqual([]);
  });

  it("cancels the source and removes staging when the byte limit is exceeded", async () => {
    const { root, store } = createStore();
    let cancelled = false;
    const content = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes("too large"));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(
      store.import({ uploadId: "att-big", content, maxBytes: 4 }),
    ).rejects.toMatchObject({ code: "attachment_too_large" });
    expect(cancelled).toBe(true);
    expect(readdirSync(join(root, "staging"))).toEqual([]);
  });

  it("honors an aborted signal and removes staging", async () => {
    const { root, store } = createStore();
    const controller = new AbortController();
    controller.abort();

    await expect(
      store.import({
        uploadId: "att-abort",
        content: streamOf([bytes("ignored")]),
        maxBytes: 32,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "attachment_aborted" });
    expect(readdirSync(join(root, "staging"))).toEqual([]);
  });

  it("opens an inclusive byte range and rejects unsafe hashes", async () => {
    const { store } = createStore();
    const imported = await store.import({
      uploadId: "att-range",
      content: streamOf([bytes("0123456789")]),
      declaredMediaType: "text/plain",
      maxBytes: 32,
    });

    const content = await readAll(store.open(imported.sha256, { start: 2, end: 5 }));
    expect(new TextDecoder().decode(content)).toBe("2345");
    expect(() => store.open("../store.db")).toThrow("attachment_invalid_request");
    expect(() => store.open(imported.sha256, { start: 5, end: 2 })).toThrow(
      "attachment_invalid_request",
    );
  });

  it("removes only expired unowned staging files", async () => {
    const now = 10_000;
    const { root, store } = createStore(() => now);
    const staging = join(root, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "expired.part"), "old");
    writeFileSync(join(staging, "active.part"), "active");
    writeFileSync(join(staging, "fresh.part"), "fresh");
    writeFileSync(join(staging, "diagnostic.txt"), "keep");
    utimesSync(join(staging, "expired.part"), 1, 1);
    utimesSync(join(staging, "active.part"), 1, 1);
    utimesSync(join(staging, "fresh.part"), 9, 9);

    const result = await store.recoverStaging({
      activeNames: new Set(["active.part"]),
      olderThan: 5_000,
    });

    expect(result.removed).toEqual(["expired.part"]);
    expect(result.retained.sort()).toEqual(
      ["active.part", "diagnostic.txt", "fresh.part"].sort(),
    );
    expect(readdirSync(staging).sort()).toEqual(
      ["active.part", "diagnostic.txt", "fresh.part"].sort(),
    );
  });
});
