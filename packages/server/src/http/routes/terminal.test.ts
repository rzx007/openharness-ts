import type { TerminalEventListener } from "@openharness/terminal";
import { describe, expect, it, vi } from "vitest";

import type { DaemonTerminalService } from "../../terminal/index.js";
import { TerminalHttpEventHub } from "./terminal.js";

describe("TerminalHttpEventHub", () => {
  it("closes active terminal SSE clients during daemon shutdown", async () => {
    let listener: TerminalEventListener | undefined;
    const unsubscribe = vi.fn();
    const terminals = {
      subscribe(next: TerminalEventListener) {
        listener = next;
        return unsubscribe;
      },
    } as unknown as DaemonTerminalService;
    const hub = new TerminalHttpEventHub(terminals);
    const response = hub.createStream();
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Expected an SSE response body");

    const connected = await reader.read();
    expect(new TextDecoder().decode(connected.value)).toContain("connected");
    expect(listener).toBeTypeOf("function");
    expect(hub.clientCount).toBe(1);

    hub.closeClients();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(hub.clientCount).toBe(0);
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });
});
