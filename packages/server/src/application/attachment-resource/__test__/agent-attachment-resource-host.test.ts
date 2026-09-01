import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AttachmentApplicationService,
  AttachmentBlobStore,
  SessionStore,
} from "@openharness/services";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentAttachmentResourceHost } from "../agent-attachment-resource-host.js";

const roots: string[] = [];
const stores: SessionStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function harness(
  resolveAuthorizationSessionId?: (sessionId: string) => string | undefined,
) {
  const root = await mkdtemp(join(tmpdir(), "oh-attachment-host-"));
  roots.push(root);
  const store = new SessionStore({ path: join(root, "store.db") });
  stores.push(store);
  store.createSession({ id: "session-1", cwd: root, model: "model" });
  store.createSession({ id: "session-2", cwd: root, model: "model" });
  store.createSession({ id: "child-session", cwd: root, model: "model" });
  const attachments = new AttachmentApplicationService({
    store,
    blobs: new AttachmentBlobStore({ root: join(root, "attachments") }),
    id: (() => {
      let next = 0;
      return () => `att_${++next}`;
    })(),
  });
  return {
    store,
    attachments,
    host: createAgentAttachmentResourceHost({
      store,
      attachments,
      resolveAuthorizationSessionId,
    }),
  };
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe("AgentAttachmentResourceHost", () => {
  it("authorizes a live child against its root session while preserving the child context", async () => {
    let childIsLive = true;
    const resolveAuthorizationSessionId = vi.fn((sessionId: string) =>
      childIsLive && sessionId === "child-session" ? "session-1" : undefined
    );
    const { store, attachments, host } = await harness(resolveAuthorizationSessionId);
    const asset = await attachments.import({
      displayName: "root-notes.txt",
      declaredMediaType: "text/plain",
      content: byteStream(new TextEncoder().encode("root attachment")),
    });
    store.admitPrompt({
      id: "root-input",
      sessionId: "session-1",
      content: "read",
      attachments: [{ assetId: asset.id, intent: "auto" }],
    });

    await expect(host.readText(
      { assetId: asset.id, offset: 1, limit: 1 },
      { sessionId: "child-session" },
    )).resolves.toMatchObject({ content: "root attachment" });
    expect(resolveAuthorizationSessionId).toHaveBeenCalledWith("child-session");

    await expect(host.readText(
      { assetId: asset.id, offset: 1, limit: 1 },
      { sessionId: "session-1" },
    )).resolves.toMatchObject({ content: "root attachment" });
    await expect(host.readText(
      { assetId: asset.id, offset: 1, limit: 1 },
      { sessionId: "session-2" },
    )).rejects.toThrow("attachment_resource_access_denied");

    childIsLive = false;
    await expect(host.readText(
      { assetId: asset.id, offset: 1, limit: 1 },
      { sessionId: "child-session" },
    )).rejects.toThrow("attachment_resource_access_denied");
  });

  it("reads only a ready text asset referenced by the current session", async () => {
    const { store, attachments, host } = await harness();
    const asset = await attachments.import({
      displayName: "notes.txt",
      declaredMediaType: "text/plain",
      content: byteStream(new TextEncoder().encode("one\ntwo\nthree")),
    });
    store.admitPrompt({
      id: "input-1",
      sessionId: "session-1",
      content: "read",
      attachments: [{ assetId: asset.id, intent: "auto" }],
    });

    await expect(host.readText(
      { assetId: asset.id, offset: 2, limit: 1 },
      { sessionId: "session-1" },
    )).resolves.toMatchObject({
      content: "two",
      startLine: 2,
      endLine: 2,
      hasMore: true,
      encoding: "utf-8",
    });
    await expect(host.readText(
      { assetId: asset.id, offset: 1, limit: 1 },
      { sessionId: "session-2" },
    )).rejects.toThrow("attachment_resource_access_denied");
  });

  it("rejects referenced documents and ranges beyond the text", async () => {
    const { store, attachments, host } = await harness();
    const document = await attachments.import({
      displayName: "report.pdf",
      declaredMediaType: "application/pdf",
      content: byteStream(new TextEncoder().encode("%PDF-1.7")),
    });
    const text = await attachments.import({
      displayName: "short.txt",
      declaredMediaType: "text/plain",
      content: byteStream(new TextEncoder().encode("only")),
    });
    store.admitPrompt({
      id: "input-1",
      sessionId: "session-1",
      content: "read",
      attachments: [
        { assetId: document.id, intent: "auto" },
        { assetId: text.id, intent: "auto" },
      ],
    });

    await expect(host.readText(
      { assetId: document.id, offset: 1, limit: 1 },
      { sessionId: "session-1" },
    )).rejects.toThrow("attachment_resource_access_denied");
    await expect(host.readText(
      { assetId: text.id, offset: 2, limit: 1 },
      { sessionId: "session-1" },
    )).rejects.toThrow("attachment_resource_range_invalid");
  });

  it("honors cancellation before reading bytes", async () => {
    const { host } = await harness();
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(host.readText(
      { assetId: "att_missing", offset: 1, limit: 1 },
      { sessionId: "session-1", signal: controller.signal },
    )).rejects.toThrow("stopped");
  });
});
