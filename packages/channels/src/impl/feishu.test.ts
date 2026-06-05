import { describe, it, expect, vi } from "vitest";
import { FeishuAdapter } from "./feishu.js";
import type { ChannelMessage } from "../index.js";

interface CreateCall {
  params: { receive_id_type: string };
  data: { receive_id: string; content: string; msg_type: string };
}

/** Build a FeishuAdapter with a mocked lark client injected. */
function makeAdapter() {
  const adapter = new FeishuAdapter({ appId: "app", appSecret: "secret" });
  const create = vi.fn<(call: CreateCall) => Promise<void>>(async () => {});
  // Inject the mocked client (private field) so send() can run without a real
  // network connection.
  (adapter as unknown as { client: unknown }).client = {
    im: { message: { create } },
  };
  return { adapter, create };
}

function baseMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: "feishu_123_abcd",
    channel: "feishu",
    sender: "ou_sender_open_id",
    content: "hello",
    timestamp: new Date(0),
    ...overrides,
  };
}

describe("FeishuAdapter.send receive_id", () => {
  it("does NOT use the synthetic message id as receive_id", async () => {
    const { adapter, create } = makeAdapter();
    await adapter.send(baseMessage({ id: "feishu_999_zzzz" }));

    const call = create.mock.calls[0]![0] as CreateCall;
    expect(call.data.receive_id).not.toBe("feishu_999_zzzz");
  });

  it("uses replyTo (chat_id) with receive_id_type=chat_id for group replies", async () => {
    const { adapter, create } = makeAdapter();
    await adapter.send(
      baseMessage({ replyTo: "oc_group_chat_123", content: "reply" }),
    );

    const call = create.mock.calls[0]![0] as CreateCall;
    expect(call.params.receive_id_type).toBe("chat_id");
    expect(call.data.receive_id).toBe("oc_group_chat_123");
    expect(call.data.msg_type).toBe("text");
    expect(JSON.parse(call.data.content)).toEqual({ text: "reply" });
  });

  it("uses replyTo (open_id) with receive_id_type=open_id for direct replies", async () => {
    const { adapter, create } = makeAdapter();
    await adapter.send(baseMessage({ replyTo: "ou_user_open_id" }));

    const call = create.mock.calls[0]![0] as CreateCall;
    expect(call.params.receive_id_type).toBe("open_id");
    expect(call.data.receive_id).toBe("ou_user_open_id");
  });

  it("falls back to sender when replyTo is not set", async () => {
    const { adapter, create } = makeAdapter();
    await adapter.send(baseMessage({ replyTo: undefined, sender: "ou_sender" }));

    const call = create.mock.calls[0]![0] as CreateCall;
    expect(call.data.receive_id).toBe("ou_sender");
    expect(call.params.receive_id_type).toBe("open_id");
  });

  it("throws when the client is not connected", async () => {
    const adapter = new FeishuAdapter({ appId: "app", appSecret: "secret" });
    await expect(adapter.send(baseMessage())).rejects.toThrow(
      "Feishu client not connected",
    );
  });
});
