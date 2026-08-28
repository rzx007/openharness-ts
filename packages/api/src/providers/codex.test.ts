import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCodexHeaders, CodexSubscriptionClient, resolveCodexUrl } from "./codex";

function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("resolveCodexUrl", () => {
  it("defaults to chatgpt codex responses", () => {
    expect(resolveCodexUrl()).toBe("https://chatgpt.com/backend-api/codex/responses");
  });

  it("normalizes backend-api and codex URLs", () => {
    expect(resolveCodexUrl("https://chatgpt.com/backend-api")).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
    expect(resolveCodexUrl("https://chatgpt.com/backend-api/codex")).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
  });
});

describe("buildCodexHeaders", () => {
  it("extracts chatgpt account id from the access token", () => {
    const token = jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
    });
    const headers = buildCodexHeaders(token);
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    expect(headers["chatgpt-account-id"]).toBe("acct_123");
  });
});

describe("CodexSubscriptionClient phases", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("streams commentary phases and preserves them when replaying assistant messages", async () => {
    const token = jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
    });
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const frames = [
        { type: "response.output_item.added", item: { id: "msg_1", type: "message", phase: "commentary" } },
        { type: "response.output_text.delta", item_id: "msg_1", delta: "Checking the build." },
        { type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 3 } } },
      ];
      return new Response(
        frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }));

    const client = new CodexSubscriptionClient({ apiKey: token });
    const events = [];
    for await (const event of client.streamMessage({
      model: "gpt-test",
      system: "system",
      messages: [{ type: "assistant", content: "Starting.", phase: "commentary" }],
    })) {
      events.push(event);
    }

    expect(events[0]).toEqual({
      type: "text_delta",
      delta: "Checking the build.",
      phase: "commentary",
    });
    expect(requestBody?.input).toEqual([expect.objectContaining({
      type: "message",
      role: "assistant",
      phase: "commentary",
    })]);
  });
});

describe("CodexSubscriptionClient native image input", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends ordered text and image input blocks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-codex-image-"));
    try {
      const imagePath = join(dir, "cached.png");
      await writeFile(imagePath, Buffer.from([9, 8, 7]));
      let requestBody: any;
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(
          `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }));
      const client = new CodexSubscriptionClient({
        apiKey: jwt({
          "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
        }),
      });
      for await (const _ of client.streamMessage({
        model: "gpt-test",
        messages: [{
          type: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image", source: { type: "file", mediaType: "image/png", path: imagePath } },
          ],
        }],
      })) {}

      expect(requestBody.input[0].content).toEqual([
        { type: "input_text", text: "describe" },
        { type: "input_image", image_url: `data:image/png;base64,${Buffer.from([9, 8, 7]).toString("base64")}` },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
