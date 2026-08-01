import { describe, expect, it } from "vitest";

import { OpenHarnessClient, streamServerSentEvents } from "./client.js";
import { syncEvents } from "./sync.js";
import type { SessionEventRecord, SessionRecord } from "./types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function event(seq: number, type = "daemon.test"): SessionEventRecord {
  return { id: `e${seq}`, seq, type, payload: {}, createdAt: seq };
}

describe("OpenHarnessClient", () => {
  it("calls typed API endpoints with bearer auth and JSON bodies", async () => {
    const session: SessionRecord = {
      id: "s1",
      cwd: process.cwd(),
      title: "Main",
      model: "m",
      status: "idle",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    };
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse({ session });
    };

    const client = new OpenHarnessClient({
      baseUrl: "http://127.0.0.1:3456/",
      token: "tok",
      fetch: fetchImpl as typeof fetch,
    });

    await expect(client.createSession({ id: "s1", cwd: process.cwd(), model: "m", title: "Main" })).resolves.toEqual(
      session,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:3456/sessions");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toMatchObject({
      authorization: "Bearer tok",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ id: "s1", model: "m" });
  });

  it("parses server-sent event frames and ignores comments", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(": connected\n\n"));
        controller.enqueue(encoder.encode(`id: 1\nevent: session.created\ndata: ${JSON.stringify(event(1))}\n\n`));
        controller.enqueue(encoder.encode(`id: 2\nevent: session.run.updated\ndata: ${JSON.stringify(event(2))}\n\n`));
        controller.close();
      },
    });

    const events: SessionEventRecord[] = [];
    for await (const parsed of streamServerSentEvents(async () => stream)) events.push(parsed);

    expect(events.map((item) => item.seq)).toEqual([1, 2]);
  });

  it("merges replayed and live events while suppressing live duplicates", async () => {
    const stream = async function* (): AsyncIterable<SessionEventRecord> {
      yield event(2, "session.created");
      yield event(3, "session.input.admitted");
    };
    const client = {
      listEvents: async () => [event(1, "session.created"), event(2, "session.message.created")],
      streamEvents: () => stream(),
    } as unknown as OpenHarnessClient;

    const updates: Array<{ seq: number; source: string; lastSeq: number }> = [];
    for await (const update of syncEvents(client)) {
      updates.push({ seq: update.event.seq, source: update.source, lastSeq: update.state.lastSeq });
    }

    expect(updates).toEqual([
      { seq: 1, source: "replay", lastSeq: 1 },
      { seq: 2, source: "replay", lastSeq: 2 },
      { seq: 3, source: "live", lastSeq: 3 },
    ]);
  });
});
