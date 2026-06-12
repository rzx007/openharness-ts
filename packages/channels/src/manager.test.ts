import { describe, it, expect, vi } from "vitest";
import { MessageBus, type OutboundMessage } from "./bus/queue.js";
import { ChannelManager } from "./manager.js";
import { ChannelBridge, type BridgeEngine } from "./bridge.js";
import type { ChannelAdapter, ChannelMessage } from "./index.js";

/** 可注入收发的假 adapter。 */
function makeAdapter(name: string, opts: { failConnect?: boolean } = {}) {
  let handler: ((m: ChannelMessage) => void) | undefined;
  const sent: ChannelMessage[] = [];
  const adapter: ChannelAdapter = {
    name,
    async connect() {
      if (opts.failConnect) throw new Error(`${name} boom`);
    },
    async disconnect() {},
    async send(m) {
      sent.push(m);
    },
    onMessage(h) {
      handler = h;
    },
  };
  return {
    adapter,
    sent,
    emit(m: Partial<ChannelMessage>) {
      handler?.({
        id: "m1",
        channel: name,
        sender: "u1",
        content: "hi",
        timestamp: new Date(0),
        ...m,
      });
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("ChannelManager", () => {
  it("入站经 ACL 进 bus(允许的 sender)", async () => {
    const bus = new MessageBus();
    const fake = makeAdapter("t");
    const mgr = new ChannelManager([fake.adapter], bus, {
      allowFrom: { t: ["u1"] },
    });
    await mgr.startAll();
    fake.emit({ sender: "u1", content: "hello", replyTo: "chat9" });
    const msg = await bus.consumeInbound();
    expect(msg.channel).toBe("t");
    expect(msg.senderId).toBe("u1");
    expect(msg.chatId).toBe("chat9"); // replyTo 优先作会话目标
    expect(msg.content).toBe("hello");
    await mgr.stopAll();
  });

  it("ACL 拒绝:不在 allowFrom 或列表为空都不进 bus", async () => {
    const bus = new MessageBus();
    const fake = makeAdapter("t");
    const mgr = new ChannelManager([fake.adapter], bus, {
      allowFrom: { t: [] },
    });
    await mgr.startAll();
    fake.emit({ sender: "u1" });
    fake.emit({ sender: "stranger" });
    await tick();
    expect(bus.inboundSize).toBe(0);
    await mgr.stopAll();
  });

  it("出站按 channel 路由到对应 adapter", async () => {
    const bus = new MessageBus();
    const a = makeAdapter("a");
    const b = makeAdapter("b");
    const mgr = new ChannelManager([a.adapter, b.adapter], bus, {
      allowFrom: { a: ["*"], b: ["*"] },
    });
    await mgr.startAll();
    bus.publishOutbound({ channel: "b", chatId: "c2", content: "reply" });
    await tick();
    expect(a.sent).toHaveLength(0);
    expect(b.sent).toHaveLength(1);
    expect(b.sent[0]!.content).toBe("reply");
    expect(b.sent[0]!.replyTo).toBe("c2"); // chatId 映射回 replyTo
    await mgr.stopAll();
  });

  it("单 adapter connect 失败不拖垮整体,状态带 lastError", async () => {
    const bus = new MessageBus();
    const ok = makeAdapter("ok");
    const bad = makeAdapter("bad", { failConnect: true });
    const mgr = new ChannelManager([ok.adapter, bad.adapter], bus, {
      allowFrom: { ok: ["*"], bad: ["*"] },
    });
    await mgr.startAll();
    const status = mgr.getStatus();
    expect(status.ok!.running).toBe(true);
    expect(status.bad!.running).toBe(false);
    expect(status.bad!.lastError).toMatch(/boom/);
    await mgr.stopAll();
  });

  it("progress 元数据门控:sendProgress=false 时丢弃 _progress 消息", async () => {
    const bus = new MessageBus();
    const fake = makeAdapter("t");
    const mgr = new ChannelManager([fake.adapter], bus, {
      allowFrom: { t: ["*"] },
      sendProgress: false,
    });
    await mgr.startAll();
    bus.publishOutbound({
      channel: "t",
      chatId: "c",
      content: "thinking…",
      metadata: { _progress: true },
    });
    bus.publishOutbound({ channel: "t", chatId: "c", content: "real" });
    await tick();
    expect(fake.sent.map((m) => m.content)).toEqual(["real"]);
    await mgr.stopAll();
  });

  it("tool_hint 门控独立于 progress 门控(四象限)", async () => {
    const bus = new MessageBus();
    const fake = makeAdapter("t");
    // sendToolHints=false 但 sendProgress 默认 true:
    // 丢 hint 类 progress,放普通 progress。
    const mgr = new ChannelManager([fake.adapter], bus, {
      allowFrom: { t: ["*"] },
      sendToolHints: false,
    });
    await mgr.startAll();
    bus.publishOutbound({
      channel: "t",
      chatId: "c",
      content: "using Bash…",
      metadata: { _progress: true, _tool_hint: true },
    });
    bus.publishOutbound({
      channel: "t",
      chatId: "c",
      content: "thinking…",
      metadata: { _progress: true },
    });
    await tick();
    expect(fake.sent.map((m) => m.content)).toEqual(["thinking…"]);
    await mgr.stopAll();
  });

  it("startAll 重入保护:二次调用不另起分发循环", async () => {
    const bus = new MessageBus();
    const fake = makeAdapter("t");
    const mgr = new ChannelManager([fake.adapter], bus, { allowFrom: { t: ["*"] } });
    await mgr.startAll();
    await mgr.startAll(); // 不应泄漏旧循环
    bus.publishOutbound({ channel: "t", chatId: "c", content: "once" });
    await tick();
    expect(fake.sent).toHaveLength(1);
    await mgr.stopAll();
  });

  it("空 allowFrom 在启动时给告警", async () => {
    const warnings: string[] = [];
    const bus = new MessageBus();
    const fake = makeAdapter("t");
    const mgr = new ChannelManager([fake.adapter], bus, {
      allowFrom: {},
      onWarning: (w) => warnings.push(w),
    });
    await mgr.startAll();
    expect(warnings.some((w) => w.includes("allowFrom"))).toBe(true);
    await mgr.stopAll();
  });
});

describe("ChannelBridge", () => {
  function makeEngine(deltas: string[], opts: { fail?: boolean } = {}): BridgeEngine {
    return {
      // eslint-disable-next-line @typescript-eslint/require-await
      async *submitMessage() {
        if (opts.fail) throw new Error("engine down");
        for (const d of deltas) yield { type: "text_delta" as const, delta: d };
        yield { type: "complete" as const, stopReason: "end_turn" };
      },
    };
  }

  it("消费 inbound,聚合 text_delta,发布 outbound", async () => {
    const bus = new MessageBus();
    const bridge = new ChannelBridge({ engine: makeEngine(["he", "llo"]), bus });
    bridge.start();
    bus.publishInbound({
      channel: "t",
      senderId: "u1",
      chatId: "c1",
      content: "hi",
      timestamp: new Date(0),
      media: [],
      metadata: {},
    });
    const out: OutboundMessage = await bus.consumeOutbound();
    expect(out.channel).toBe("t");
    expect(out.chatId).toBe("c1");
    expect(out.content).toBe("hello");
    expect(out.metadata?._session_key).toBe("t:c1");
    await bridge.stop();
  });

  it("引擎抛错回复对齐 Python 的错误文案", async () => {
    const bus = new MessageBus();
    const bridge = new ChannelBridge({ engine: makeEngine([], { fail: true }), bus });
    bridge.start();
    bus.publishInbound({
      channel: "t",
      senderId: "u1",
      chatId: "c1",
      content: "hi",
      timestamp: new Date(0),
      media: [],
      metadata: {},
    });
    const out = await bus.consumeOutbound();
    expect(out.content).toBe("[Error: failed to process your message]");
    await bridge.stop();
  });

  it("空回复不发布", async () => {
    const bus = new MessageBus();
    const engine = makeEngine(["  ", ""]);
    const spy = vi.spyOn(bus, "publishOutbound");
    const bridge = new ChannelBridge({ engine, bus });
    bridge.start();
    bus.publishInbound({
      channel: "t",
      senderId: "u1",
      chatId: "c1",
      content: "hi",
      timestamp: new Date(0),
      media: [],
      metadata: {},
    });
    await tick();
    await tick();
    expect(bus.inboundSize).toBe(0); // 确认消息确实被消费(防 bridge 没跑的假绿)
    expect(spy).not.toHaveBeenCalled();
    await bridge.stop();
  });

  it("单条处理抛错不杀循环,经 onWarning 上报", async () => {
    const bus = new MessageBus();
    const warnings: string[] = [];
    const engine: BridgeEngine = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async *submitMessage(content: string) {
        if (content === "boom") throw new Error("engine down");
        yield { type: "text_delta" as const, delta: "ok" };
      },
    };
    const bridge = new ChannelBridge({ engine, bus, onWarning: (w) => warnings.push(w) });
    bridge.start();
    const base = {
      channel: "t",
      senderId: "u1",
      chatId: "c1",
      timestamp: new Date(0),
      media: [],
      metadata: {},
    };
    bus.publishInbound({ ...base, content: "boom" });
    bus.publishInbound({ ...base, content: "fine" });
    const first = await bus.consumeOutbound();
    const second = await bus.consumeOutbound();
    expect(first.content).toBe("[Error: failed to process your message]");
    expect(second.content).toBe("ok"); // 循环还活着
    expect(warnings.some((w) => w.includes("engine down"))).toBe(true);
    await bridge.stop();
  });

  it("stop 后不再消费", async () => {
    const bus = new MessageBus();
    const bridge = new ChannelBridge({ engine: makeEngine(["x"]), bus });
    bridge.start();
    await bridge.stop();
    bus.publishInbound({
      channel: "t",
      senderId: "u1",
      chatId: "c1",
      content: "hi",
      timestamp: new Date(0),
      media: [],
      metadata: {},
    });
    await tick();
    expect(bus.inboundSize).toBe(1); // 无人消费
  });
});
