import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Message } from "@openharness/core";
import {
  OpenAICompatibleClient,
  stripThinkBlocks,
  tokenLimitParamForModel,
  convertUserContentToOpenAI,
} from "./openai.js";

describe("stripThinkBlocks", () => {
  it("removes a complete <think> block", () => {
    const [visible, leftover] = stripThinkBlocks("before<think>secret</think>after");
    expect(visible).toBe("beforeafter");
    expect(leftover).toBe("");
  });

  it("removes a multiline <think> block", () => {
    const [visible, leftover] = stripThinkBlocks("a<think>line1\nline2</think>b");
    expect(visible).toBe("ab");
    expect(leftover).toBe("");
  });

  it("holds back an unclosed <think> block", () => {
    const [visible, leftover] = stripThinkBlocks("visible<think>not yet closed");
    expect(visible).toBe("visible");
    expect(leftover).toBe("<think>not yet closed");
  });

  it("holds back a partial opening tag split across chunks", () => {
    const [visible, leftover] = stripThinkBlocks("hello<thi");
    expect(visible).toBe("hello");
    expect(leftover).toBe("<thi");
  });

  it("simulates the full cross-chunk lifecycle", () => {
    // Provider splits "<think>secret</think>" across many chunks.
    const chunks = ["Vis", "ib", "le <thi", "nk>secret", " thoughts</thi", "nk> tail"];
    let buf = "";
    let out = "";
    for (const chunk of chunks) {
      buf += chunk;
      const [visible, leftover] = stripThinkBlocks(buf);
      out += visible;
      buf = leftover;
    }
    out += buf;
    expect(out).toBe("Visible  tail");
  });

  it("passes through plain text untouched", () => {
    const [visible, leftover] = stripThinkBlocks("just normal text");
    expect(visible).toBe("just normal text");
    expect(leftover).toBe("");
  });
});

describe("tokenLimitParamForModel", () => {
  it("uses max_tokens for regular models", () => {
    expect(tokenLimitParamForModel("gpt-4o", 100)).toEqual({ max_tokens: 100 });
    expect(tokenLimitParamForModel("claude-3-5-sonnet", 100)).toEqual({ max_tokens: 100 });
  });

  it("uses max_completion_tokens for gpt-5", () => {
    expect(tokenLimitParamForModel("gpt-5", 200)).toEqual({ max_completion_tokens: 200 });
    expect(tokenLimitParamForModel("gpt-5-mini", 200)).toEqual({ max_completion_tokens: 200 });
  });

  it("uses max_completion_tokens for o1/o3/o4 families", () => {
    expect(tokenLimitParamForModel("o1", 5)).toEqual({ max_completion_tokens: 5 });
    expect(tokenLimitParamForModel("o3-mini", 5)).toEqual({ max_completion_tokens: 5 });
    expect(tokenLimitParamForModel("o4-mini-high", 5)).toEqual({ max_completion_tokens: 5 });
  });

  it("strips provider prefix before matching", () => {
    expect(tokenLimitParamForModel("openai/gpt-5", 10)).toEqual({ max_completion_tokens: 10 });
    expect(tokenLimitParamForModel("openai/gpt-4o", 10)).toEqual({ max_tokens: 10 });
  });

  it("is case insensitive", () => {
    expect(tokenLimitParamForModel("GPT-5", 10)).toEqual({ max_completion_tokens: 10 });
  });
});

describe("convertUserContentToOpenAI", () => {
  it("joins text blocks into a string when no image present", async () => {
    const result = await convertUserContentToOpenAI([
      { type: "text", text: "hello " },
      { type: "text", text: "world" },
    ]);
    expect(result).toBe("hello world");
  });

  it("converts a cached file image block to image_url data URI", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-openai-image-"));
    try {
      const imagePath = join(dir, "cached.png");
      await writeFile(imagePath, Buffer.from([1, 2, 3, 4]));
      const result = await convertUserContentToOpenAI([
        { type: "text", text: "look:" },
        { type: "image", source: { type: "file", mediaType: "image/png", path: imagePath } },
      ]);
      expect(result).toEqual([
        { type: "text", text: "look:" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from([1, 2, 3, 4]).toString("base64")}` } },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("omits empty text blocks in multimodal content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-openai-image-"));
    try {
      const imagePath = join(dir, "cached.jpg");
      await writeFile(imagePath, Buffer.from([5, 6, 7]));
      const result = await convertUserContentToOpenAI([
        { type: "text", text: "" },
        { type: "image", source: { type: "file", mediaType: "image/jpeg", path: imagePath } },
      ]);
      expect(result).toEqual([
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${Buffer.from([5, 6, 7]).toString("base64")}` } },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// Access the private convertMessages via a tiny subclass for reasoning tests.
class TestableClient extends OpenAICompatibleClient {
  build(messages: Message[]): Promise<any> {
    // @ts-expect-error access private for testing
    return this.convertMessages({ model: "gpt-4o", messages });
  }
}

describe("convertMessages reasoning_content gating", () => {
  const ENV = "OPENHARNESS_REQUIRE_EMPTY_REASONING_CONTENT";
  let client: TestableClient;

  beforeEach(() => {
    client = new TestableClient({ apiKey: "test", baseURL: undefined } as any);
    delete process.env[ENV];
  });

  afterEach(() => {
    delete process.env[ENV];
  });

  const toolUseMsg: Message[] = [
    {
      type: "assistant",
      content: "",
      toolUses: [{ type: "tool_use", id: "t1", name: "foo", input: {} }],
    },
  ];

  it("omits empty reasoning_content by default", async () => {
    const out = await client.build(toolUseMsg);
    const assistant = out.find((m: any) => m.role === "assistant");
    expect(assistant.reasoning_content).toBeUndefined();
  });

  it("emits empty reasoning_content when env opt-in is set", async () => {
    process.env[ENV] = "1";
    const out = await client.build(toolUseMsg);
    const assistant = out.find((m: any) => m.role === "assistant");
    expect(assistant.reasoning_content).toBe("");
  });
});

describe("convertMessages image passing", () => {
  it("produces structured image_url content for image user messages", async () => {
    const client = new TestableClient({ apiKey: "test", baseURL: undefined } as any);
    const dir = await mkdtemp(join(tmpdir(), "oh-openai-image-"));
    try {
      const imagePath = join(dir, "cached.png");
      await writeFile(imagePath, Buffer.from([65]));
      const out = await client.build([
        {
          type: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image", source: { type: "file", mediaType: "image/png", path: imagePath } },
          ],
        },
      ]);
      const user = out.find((m: any) => m.role === "user");
      expect(Array.isArray(user.content)).toBe(true);
      expect(user.content).toContainEqual({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${Buffer.from([65]).toString("base64")}` },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
