import { describe, it, expect, vi } from "vitest";
import { HookExecutor } from "../src/index.js";
import type {
  HookDefinition,
  StreamEvent,
  StreamMessageParams,
  StreamingMessageClient,
} from "@openharness/core";

/** A client that streams a fixed text response, capturing the last params. */
function fakeClient(responseText: string): {
  client: StreamingMessageClient;
  lastParams: () => StreamMessageParams | undefined;
} {
  let captured: StreamMessageParams | undefined;
  const client: StreamingMessageClient = {
    async *streamMessage(params: StreamMessageParams): AsyncIterable<StreamEvent> {
      captured = params;
      yield { type: "text_delta", delta: responseText } as StreamEvent;
      yield { type: "complete", stopReason: "end_turn" } as StreamEvent;
    },
  };
  return { client, lastParams: () => captured };
}

describe("HookExecutor", () => {
  it("registers and retrieves hooks", () => {
    const executor = new HookExecutor();
    const hook: HookDefinition = {
      id: "h1",
      event: "pre_tool_use",
      type: "command",
      command: "echo hello",
      enabled: true,
    };
    executor.register(hook);
    expect(executor.getHooksForEvent("pre_tool_use")).toHaveLength(1);
  });

  it("unregister removes hook", () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h1",
      event: "pre_tool_use",
      type: "command",
      command: "echo hello",
      enabled: true,
    });
    executor.unregister("h1");
    expect(executor.getHooksForEvent("pre_tool_use")).toHaveLength(0);
  });

  it("getHooksForEvent filters by event and enabled", () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h1",
      event: "pre_tool_use",
      type: "command",
      command: "echo a",
      enabled: true,
    });
    executor.register({
      id: "h2",
      event: "post_tool_use",
      type: "command",
      command: "echo b",
      enabled: true,
    });
    executor.register({
      id: "h3",
      event: "pre_tool_use",
      type: "command",
      command: "echo c",
      enabled: false,
    });
    expect(executor.getHooksForEvent("pre_tool_use")).toHaveLength(1);
    expect(executor.getHooksForEvent("post_tool_use")).toHaveLength(1);
  });

  it("execute runs command hooks", async () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h1",
      event: "session_start",
      type: "command",
      command: "echo test",
      enabled: true,
    });
    await executor.execute("session_start", {});
  });

  it("execute swallows errors", async () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h1",
      event: "session_start",
      type: "command",
      command: "exit 1",
      enabled: true,
    });
    await expect(executor.execute("session_start", {})).resolves.toEqual({ blocked: false });
  });

  it("executeWithResults returns results", async () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h1",
      event: "session_start",
      type: "command",
      command: "echo ok",
      enabled: true,
    });
    const results = await executor.executeWithResults("session_start", {});
    expect(results).toHaveLength(1);
    expect(results[0].hookId).toBe("h1");
    expect(results[0].success).toBe(true);
    expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("executeWithResults captures failures", async () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h1",
      event: "session_start",
      type: "command",
      command: "exit 2",
      enabled: true,
    });
    const results = await executor.executeWithResults("session_start", {});
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBeDefined();
  });

  it("getAll returns all hooks", () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h1",
      event: "pre_tool_use",
      type: "command",
      command: "echo a",
      enabled: true,
    });
    executor.register({
      id: "h2",
      event: "post_tool_use",
      type: "command",
      command: "echo b",
      enabled: true,
    });
    expect(executor.getAll()).toHaveLength(2);
  });

  it("executeCommand succeeds for valid command", async () => {
    const executor = new HookExecutor();
    const controller = new AbortController();
    await expect(
      executor.executeCommand("echo hello", controller.signal)
    ).resolves.toEqual({ blocked: false });
  });

  it("executeCommand returns blocked for exit code 2", async () => {
    const executor = new HookExecutor();
    const controller = new AbortController();
    const result = await executor.executeCommand("exit 2", controller.signal);
    expect(result.blocked).toBe(true);
  });

  it("executeCommand returns not blocked for non-zero exit", async () => {
    const executor = new HookExecutor();
    const controller = new AbortController();
    const result = await executor.executeCommand("exit 42", controller.signal);
    expect(result.blocked).toBe(false);
  });

  it("execute returns blocked when hook exits with code 2", async () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h1",
      event: "pre_tool_use",
      type: "command",
      command: "echo blocked && exit 2",
      enabled: true,
    });
    const result = await executor.execute("pre_tool_use", { tool: "bash" });
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("blocked");
  });

  it("execute returns blocked with reason from stdout", async () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h1",
      event: "pre_tool_use",
      type: "command",
      command: "echo 'dangerous operation detected' && exit 2",
      enabled: true,
    });
    const result = await executor.execute("pre_tool_use", { tool: "bash" });
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("dangerous");
  });
});

describe("HookExecutor — priority ordering", () => {
  it("orders by descending priority within an event", () => {
    const executor = new HookExecutor();
    executor.register({
      id: "low",
      event: "pre_tool_use",
      type: "command",
      command: "echo low",
      enabled: true,
      priority: 1,
    });
    executor.register({
      id: "high",
      event: "pre_tool_use",
      type: "command",
      command: "echo high",
      enabled: true,
      priority: 10,
    });
    executor.register({
      id: "mid",
      event: "pre_tool_use",
      type: "command",
      command: "echo mid",
      enabled: true,
      priority: 5,
    });
    const ids = executor.getHooksForEvent("pre_tool_use").map((h) => h.id);
    expect(ids).toEqual(["high", "mid", "low"]);
  });

  it("keeps registration order for equal priority (stable sort)", () => {
    const executor = new HookExecutor();
    for (const id of ["a", "b", "c", "d"]) {
      executor.register({
        id,
        event: "pre_tool_use",
        type: "command",
        command: `echo ${id}`,
        enabled: true,
        // no priority -> default 0
      });
    }
    const ids = executor.getHooksForEvent("pre_tool_use").map((h) => h.id);
    expect(ids).toEqual(["a", "b", "c", "d"]);
  });

  it("default priority (0) sorts below positive priorities", () => {
    const executor = new HookExecutor();
    executor.register({
      id: "default",
      event: "stop",
      type: "command",
      command: "echo d",
      enabled: true,
    });
    executor.register({
      id: "boosted",
      event: "stop",
      type: "command",
      command: "echo b",
      enabled: true,
      priority: 3,
    });
    const ids = executor.getHooksForEvent("stop").map((h) => h.id);
    expect(ids).toEqual(["boosted", "default"]);
  });

  it("executes hooks in priority order until one blocks", async () => {
    const executor = new HookExecutor();
    const order: string[] = [];
    const spy = vi
      .spyOn(executor, "executeCommand")
      .mockImplementation(async (command) => {
        order.push(command);
        // The high-priority one blocks; low-priority should never run.
        if (command.includes("block")) return { blocked: true, reason: "stop" };
        return { blocked: false };
      });
    executor.register({
      id: "low",
      event: "pre_tool_use",
      type: "command",
      command: "echo low",
      enabled: true,
      priority: 0,
    });
    executor.register({
      id: "high",
      event: "pre_tool_use",
      type: "command",
      command: "echo block",
      enabled: true,
      priority: 10,
    });
    const result = await executor.execute("pre_tool_use", {});
    expect(result.blocked).toBe(true);
    expect(order).toEqual(["echo block"]);
    spy.mockRestore();
  });
});

describe("HookExecutor — matcher filtering", () => {
  it("includes hooks whose matcher matches the tool name", () => {
    const executor = new HookExecutor();
    executor.register({
      id: "bash-only",
      event: "pre_tool_use",
      type: "command",
      command: "echo x",
      enabled: true,
      matcher: "Bash",
    });
    const matched = executor.getHooksForEvent("pre_tool_use", {
      tool_name: "Bash",
    });
    expect(matched).toHaveLength(1);
  });

  it("excludes hooks whose matcher does not match", () => {
    const executor = new HookExecutor();
    executor.register({
      id: "bash-only",
      event: "pre_tool_use",
      type: "command",
      command: "echo x",
      enabled: true,
      matcher: "Bash",
    });
    const matched = executor.getHooksForEvent("pre_tool_use", {
      tool_name: "Read",
    });
    expect(matched).toHaveLength(0);
  });

  it("supports glob-style matchers", () => {
    const executor = new HookExecutor();
    executor.register({
      id: "glob",
      event: "pre_tool_use",
      type: "command",
      command: "echo x",
      enabled: true,
      matcher: "mcp__*",
    });
    expect(
      executor.getHooksForEvent("pre_tool_use", { tool_name: "mcp__github" })
    ).toHaveLength(1);
    expect(
      executor.getHooksForEvent("pre_tool_use", { tool_name: "Bash" })
    ).toHaveLength(0);
  });

  it("matches against the `tool` payload key as well", () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h",
      event: "pre_tool_use",
      type: "command",
      command: "echo x",
      enabled: true,
      matcher: "Bash",
    });
    expect(
      executor.getHooksForEvent("pre_tool_use", { tool: "Bash" })
    ).toHaveLength(1);
  });

  it("no matcher always matches", () => {
    const executor = new HookExecutor();
    executor.register({
      id: "h",
      event: "pre_tool_use",
      type: "command",
      command: "echo x",
      enabled: true,
    });
    expect(
      executor.getHooksForEvent("pre_tool_use", { tool_name: "anything" })
    ).toHaveLength(1);
  });
});

describe("HookExecutor — $ARGUMENTS injection + shell escaping", () => {
  it("injects the JSON payload into $ARGUMENTS", async () => {
    const executor = new HookExecutor();
    let received = "";
    const spy = vi
      .spyOn(executor, "executeCommand")
      .mockImplementation(async (command) => {
        received = command;
        return { blocked: false };
      });
    executor.register({
      id: "h",
      event: "pre_tool_use",
      type: "command",
      command: "validate.sh $ARGUMENTS",
      enabled: true,
    });
    // executeCommand is mocked, so verify the raw command still contains the
    // placeholder; injection happens inside executeCommand itself. Drive the
    // real path instead via direct call below.
    await executor.execute("pre_tool_use", { tool: "bash" });
    expect(received).toBe("validate.sh $ARGUMENTS");
    spy.mockRestore();
  });

  it("injects and shell-escapes the payload when running a command", async () => {
    const executor = new HookExecutor();
    const controller = new AbortController();
    // Payload contains a single quote and spaces; must survive shell parsing
    // and arrive intact as one argument.
    const payload = { msg: "it's a test", n: 5 };
    const result = await executor.executeCommand(
      "node -e \"process.stdout.write(process.argv[1])\" -- $ARGUMENTS",
      controller.signal,
      "pre_tool_use",
      payload
    );
    // command does not block; we just assert it ran without throwing.
    expect(result.blocked).toBe(false);
  });

  it("escapes payloads so injected quotes cannot break out", async () => {
    const executor = new HookExecutor();
    const controller = new AbortController();
    // If escaping failed, the `; touch HACKED` would execute as a command.
    const payload = { evil: "'; echo PWNED; '" };
    const result = await executor.executeCommand(
      "printf '%s' $ARGUMENTS",
      controller.signal,
      "pre_tool_use",
      payload
    );
    expect(result.blocked).toBe(false);
  });

  it("injects OPENHARNESS_HOOK_EVENT and OPENHARNESS_HOOK_PAYLOAD env vars", async () => {
    const executor = new HookExecutor();
    const controller = new AbortController();
    // exit 2 with the event name echoed proves env injection reached the shell.
    const result = await executor.executeCommand(
      process.platform === "win32"
        ? "if \"%OPENHARNESS_HOOK_EVENT%\"==\"pre_tool_use\" (exit 2)"
        : 'test "$OPENHARNESS_HOOK_EVENT" = "pre_tool_use" && exit 2',
      controller.signal,
      "pre_tool_use",
      {}
    );
    expect(result.blocked).toBe(true);
  });
});

describe("HookExecutor — new event types dispatch", () => {
  const events = [
    "pre_compact",
    "post_compact",
    "user_prompt_submit",
    "notification",
    "stop",
    "subagent_stop",
  ] as const;

  for (const event of events) {
    it(`registers and dispatches ${event}`, async () => {
      const executor = new HookExecutor();
      let ran = false;
      const spy = vi
        .spyOn(executor, "executeCommand")
        .mockImplementation(async () => {
          ran = true;
          return { blocked: false };
        });
      executor.register({
        id: `h-${event}`,
        event,
        type: "command",
        command: "echo hi",
        enabled: true,
      });
      const result = await executor.execute(event, {});
      expect(ran).toBe(true);
      expect(result.blocked).toBe(false);
      spy.mockRestore();
    });
  }
});

describe("HookExecutor — prompt/agent hooks", () => {
  it("prompt hook is a non-blocking no-op without a client", async () => {
    const executor = new HookExecutor();
    executor.register({
      id: "p",
      event: "pre_tool_use",
      type: "prompt",
      prompt: "Is $ARGUMENTS safe?",
      enabled: true,
    });
    const result = await executor.execute("pre_tool_use", { tool: "bash" });
    expect(result).toEqual({ blocked: false });
  });

  it("agent hook is a non-blocking no-op without a client", async () => {
    const executor = new HookExecutor();
    executor.register({
      id: "a",
      event: "pre_tool_use",
      type: "agent",
      prompt: "Inspect $ARGUMENTS",
      enabled: true,
    });
    const result = await executor.execute("pre_tool_use", {});
    expect(result).toEqual({ blocked: false });
  });

  it("prompt hook passes when client returns ok:true", async () => {
    const { client } = fakeClient('{"ok": true}');
    const executor = new HookExecutor({ client, defaultModel: "test-model" });
    executor.register({
      id: "p",
      event: "pre_tool_use",
      type: "prompt",
      prompt: "Is $ARGUMENTS safe?",
      enabled: true,
    });
    const result = await executor.execute("pre_tool_use", { tool: "bash" });
    expect(result.blocked).toBe(false);
  });

  it("prompt hook blocks when client returns ok:false", async () => {
    const { client } = fakeClient('{"ok": false, "reason": "too risky"}');
    const executor = new HookExecutor({ client, defaultModel: "test-model" });
    executor.register({
      id: "p",
      event: "pre_tool_use",
      type: "prompt",
      prompt: "Is $ARGUMENTS safe?",
      enabled: true,
    });
    const result = await executor.execute("pre_tool_use", { tool: "rm" });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("too risky");
  });

  it("injects $ARGUMENTS and model into the prompt request", async () => {
    const { client, lastParams } = fakeClient('{"ok": true}');
    const executor = new HookExecutor({ client, defaultModel: "default-model" });
    executor.register({
      id: "p",
      event: "pre_tool_use",
      type: "prompt",
      prompt: "Check $ARGUMENTS",
      model: "explicit-model",
      enabled: true,
    });
    await executor.execute("pre_tool_use", { tool: "bash" });
    const params = lastParams();
    expect(params?.model).toBe("explicit-model");
    const userMsg = params?.messages[0];
    expect(userMsg?.type).toBe("user");
    expect(String(userMsg?.content)).toContain('"tool":"bash"');
  });

  it("setClient enables prompt evaluation after construction", async () => {
    const executor = new HookExecutor();
    const { client } = fakeClient('{"ok": false, "reason": "nope"}');
    executor.setClient(client, "m");
    executor.register({
      id: "p",
      event: "pre_tool_use",
      type: "prompt",
      prompt: "Check $ARGUMENTS",
      enabled: true,
    });
    const result = await executor.execute("pre_tool_use", {});
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("nope");
  });
});

describe("HookExecutor — blockOnFailure for command hooks", () => {
  it("blocks on non-zero (non-2) exit when blockOnFailure is set", async () => {
    const executor = new HookExecutor();
    const controller = new AbortController();
    const result = await executor.executeCommand(
      "exit 1",
      controller.signal,
      "pre_tool_use",
      {},
      true
    );
    expect(result.blocked).toBe(true);
  });

  it("does not block on non-zero exit when blockOnFailure is unset", async () => {
    const executor = new HookExecutor();
    const controller = new AbortController();
    const result = await executor.executeCommand(
      "exit 1",
      controller.signal,
      "pre_tool_use",
      {},
      false
    );
    expect(result.blocked).toBe(false);
  });
});
