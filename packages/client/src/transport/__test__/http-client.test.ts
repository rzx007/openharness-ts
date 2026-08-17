import { describe, expect, it, vi } from "vitest";

import { normalizeDaemonBaseUrl, OpenHarnessClient, streamServerSentEvents } from "../http-client.js";
import { syncEvents } from "../../state/sync.js";
import type { SessionEventRecord, SessionRecord, SessionStateSnapshot } from "../../types/index.js";

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
  it("normalizes safe daemon URLs and rejects URL-based credential leaks", () => {
    expect(normalizeDaemonBaseUrl(" https://daemon.example/api/ ")).toBe("https://daemon.example/api");
    expect(() => normalizeDaemonBaseUrl("ftp://daemon.example")).toThrow("http or https");
    expect(() => normalizeDaemonBaseUrl("https://token@daemon.example")).toThrow("must not contain credentials");
    expect(() => normalizeDaemonBaseUrl("https://daemon.example?token=secret")).toThrow("must not contain query");
    expect(() => normalizeDaemonBaseUrl("not-a-url")).toThrow("absolute http or https");
  });

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

  it("calls health without bearer auth", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse({ ok: true });
    };

    const client = new OpenHarnessClient({
      baseUrl: "http://127.0.0.1:3456",
      token: "tok",
      fetch: fetchImpl as typeof fetch,
    });

    await expect(client.health()).resolves.toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:3456/health");
    expect(calls[0]!.init.headers).toEqual({});
  });

  it("lists commands and invokes template commands", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).includes("/commands") && (!init?.method || init.method === "GET")) {
        return jsonResponse({
          commands: [{ name: "/commit", kind: "template", source: "skill", description: "Commit" }],
        });
      }
      if (String(url).includes("/sessions/s1/commands")) {
        return jsonResponse({
          input: { id: "i1", sessionId: "s1", seq: 1, delivery: "queue", content: "PROMPT", metadata: {}, createdAt: 1 },
          command: { name: "/commit", kind: "template", source: "skill" },
        }, 202);
      }
      if (String(url).includes("/sessions/s1") && init?.method === "PATCH") {
        return jsonResponse({
          session: {
            id: "s1",
            cwd: process.cwd(),
            title: "Main",
            model: "new-model",
            status: "idle",
            metadata: { runtime: { model: "new-model" } },
            createdAt: 1,
            updatedAt: 2,
          },
        });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    };

    const client = new OpenHarnessClient({
      baseUrl: "http://127.0.0.1:3456",
      token: "tok",
      fetch: fetchImpl as typeof fetch,
    });

    await expect(client.listCommands({ cwd: "/repo" })).resolves.toEqual([
      { name: "/commit", kind: "template", source: "skill", description: "Commit" },
    ]);
    await expect(client.invokeCommand("s1", { name: "/commit", args: "fix" })).resolves.toMatchObject({
      command: { name: "/commit", kind: "template" },
      input: { content: "PROMPT" },
    });
    await expect(client.updateSession("s1", {
      metadata: { runtime: { model: "new-model" } },
    })).resolves.toMatchObject({ model: "new-model" });
    expect(calls.map((call) => `${call.init.method ?? "GET"} ${call.url}`)).toEqual([
      "GET http://127.0.0.1:3456/commands?cwd=%2Frepo",
      "POST http://127.0.0.1:3456/sessions/s1/commands",
      "PATCH http://127.0.0.1:3456/sessions/s1",
    ]);
  });

  it("uses the daemon Cron endpoints", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const job = {
      id: "cron-1",
      name: "check",
      expression: "* * * * *",
      command: "echo ok",
      cwd: "/repo",
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init: init ?? {} });
      if (init?.method === "PUT") return jsonResponse({ job });
      if (String(url).includes("/cron/runs")) return jsonResponse({ runs: [] });
      return jsonResponse({ jobs: [job] });
    };
    const client = new OpenHarnessClient({
      baseUrl: "http://127.0.0.1:3456",
      token: "tok",
      fetch: fetchImpl as typeof fetch,
    });

    await expect(client.saveCronJob("check", {
      expression: "* * * * *",
      command: "echo ok",
      cwd: "/repo",
    })).resolves.toEqual(job);
    await expect(client.listCronJobs()).resolves.toEqual([job]);
    await expect(client.listCronRuns({ name: "check", limit: 5 })).resolves.toEqual([]);
    expect(calls.map((call) => `${call.init.method ?? "GET"} ${call.url}`)).toEqual([
      "PUT http://127.0.0.1:3456/cron/jobs/check",
      "GET http://127.0.0.1:3456/cron/jobs",
      "GET http://127.0.0.1:3456/cron/runs?name=check&limit=5",
    ]);
  });

  it("serializes the complete Jobs list query", async () => {
    const calls: string[] = [];
    const client = new OpenHarnessClient({
      baseUrl: "http://127.0.0.1:3456",
      token: "tok",
      fetch: (async (url: string | URL | Request) => {
        calls.push(String(url));
        return jsonResponse({ jobs: [] });
      }) as typeof fetch,
    });

    await expect(client.listJobs({
      sessionId: "session-1",
      kinds: ["terminal", "agent"],
      statuses: ["running", "failed"],
      startedAfter: 10,
      limit: 5,
      includeFinished: false,
    })).resolves.toEqual([]);

    expect(calls).toEqual([
      "http://127.0.0.1:3456/jobs?sessionId=session-1&startedAfter=10&limit=5&kinds=terminal%2Cagent&statuses=running%2Cfailed&includeFinished=false",
    ]);
  });

  it("replays an interrupted run through the dedicated, idempotent endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse({
        input: { id: "recovery-i1", sessionId: "s1", seq: 2, delivery: "queue", content: "retry", metadata: {}, createdAt: 2 },
        run: { id: "recovery-r1", sessionId: "s1", inputId: "recovery-i1", status: "pending", metadata: {}, createdAt: 2, updatedAt: 2 },
        source_run: { id: "r1", sessionId: "s1", inputId: "i1", status: "interrupted", metadata: {}, createdAt: 1, updatedAt: 2 },
      }, 202);
    };
    const client = new OpenHarnessClient({
      baseUrl: "http://127.0.0.1:3456",
      token: "tok",
      fetch: fetchImpl as typeof fetch,
    });

    await expect(client.resumeInterruptedRun("s1", "r1", { id: "request-1" })).resolves.toMatchObject({
      run: { id: "recovery-r1" },
      source_run: { id: "r1", status: "interrupted" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:3456/sessions/s1/runs/r1/resume");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ id: "request-1" });
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
    const controller = new AbortController();
    const stream = async function* (): AsyncIterable<SessionEventRecord> {
      yield event(2, "session.created");
      yield event(3, "session.input.admitted");
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    };
    const client = {
      listEvents: async () => [event(1, "session.created"), event(2, "session.message.created")],
      streamEvents: () => stream(),
    } as unknown as OpenHarnessClient;

    const updates: Array<{ seq: number; source: string; lastSeq: number }> = [];
    for await (const update of syncEvents(client, { signal: controller.signal, reconnectDelayMs: () => 0 })) {
      if (!update.event) continue;
      updates.push({ seq: update.event.seq, source: update.source, lastSeq: update.state.lastSeq });
    }

    expect(updates).toEqual([
      { seq: 1, source: "replay", lastSeq: 1 },
      { seq: 2, source: "replay", lastSeq: 2 },
      { seq: 3, source: "live", lastSeq: 3 },
    ]);
  });

  it("reconnects a disconnected live stream from lastSeq cursor", async () => {
    const controller = new AbortController();
    const cursors: Array<number | undefined> = [];
    let attempt = 0;
    const client = {
      listEvents: async () => [event(1, "session.created")],
      streamEvents: (options: { cursor?: number }) => {
        cursors.push(options.cursor);
        attempt += 1;
        if (attempt === 1) {
          return (async function* () {
            yield event(2, "session.message.created");
            throw new Error("stream reset");
          })();
        }
        return (async function* () {
          yield event(3, "session.input.admitted");
          controller.abort();
          throw new DOMException("Aborted", "AbortError");
        })();
      },
    } as unknown as OpenHarnessClient;

    const liveSeqs: number[] = [];
    for await (const update of syncEvents(client, {
      signal: controller.signal,
      reconnectDelayMs: () => 0,
    })) {
      if (update.source === "live" && update.event) liveSeqs.push(update.event.seq);
    }

    expect(cursors).toEqual([1, 2]);
    expect(liveSeqs).toEqual([2, 3]);
  });

  it("does not reconnect after abort", async () => {
    const controller = new AbortController();
    let streamCalls = 0;
    const client = {
      listEvents: async () => [event(1, "session.created")],
      streamEvents: () => {
        streamCalls += 1;
        return (async function* () {
          yield event(2, "session.message.created");
          controller.abort();
          throw new DOMException("The operation was aborted.", "AbortError");
        })();
      },
    } as unknown as OpenHarnessClient;

    const liveSeqs: number[] = [];
    for await (const update of syncEvents(client, {
      signal: controller.signal,
      reconnectDelayMs: () => 0,
    })) {
      if (update.source === "live" && update.event) liveSeqs.push(update.event.seq);
    }

    expect(streamCalls).toBe(1);
    expect(liveSeqs).toEqual([2]);
  });

  it("accepts global seq gaps in a session-filtered stream without re-snapshotting", async () => {
    const controller = new AbortController();
    const session: SessionRecord = {
      id: "s1",
      cwd: "/repo",
      title: "Main",
      model: "m",
      status: "idle",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    };
    const snapshot = (cursor: number): SessionStateSnapshot => ({
      cursor,
      session,
      inputs: [],
      messages: [],
      parts: [],
      runs: [],
      permissions: [],
    });
    let streamAttempt = 0;
    let snapshotCalls = 0;
    const client = {
      getSessionState: async () => {
        snapshotCalls += 1;
        return snapshot(snapshotCalls === 1 ? 1 : 4);
      },
      streamEvents: (options: { cursor?: number }) => {
        streamAttempt += 1;
        if (streamAttempt === 1) {
          expect(options.cursor).toBe(1);
          return (async function* () {
            yield event(2, "session.message.created");
            throw new Error("stream reset");
          })();
        }
        expect(options.cursor).toBe(2);
        return (async function* () {
          yield event(5, "session.run.updated");
          controller.abort();
          throw new DOMException("Aborted", "AbortError");
        })();
      },
    } as unknown as OpenHarnessClient;

    const sources: string[] = [];
    let lastSeq = 0;
    for await (const update of syncEvents(client, {
      sessionId: "s1",
      signal: controller.signal,
      reconnectDelayMs: () => 0,
    })) {
      sources.push(update.source);
      lastSeq = update.state.lastSeq;
    }

    expect(snapshotCalls).toBe(1);
    expect(sources).toContain("reconnecting");
    expect(sources.filter((source) => source === "snapshot")).toHaveLength(1);
    expect(lastSeq).toBe(5);
  });

  it("adds a stable request id when admitting a prompt", async () => {
    const calls: RequestInit[] = [];
    const client = new OpenHarnessClient({
      baseUrl: "http://daemon.test",
      fetch: async (_url, init) => {
        calls.push(init ?? {});
        return jsonResponse({
          input: { id: "server-input", sessionId: "s1", seq: 1, delivery: "queue", content: "hello", metadata: {}, createdAt: 1 },
        }, 202);
      },
    });

    await client.admitPrompt("s1", { content: "hello" });
    const body = JSON.parse(String(calls[0]!.body)) as { id?: string; content: string };
    expect(body.content).toBe("hello");
    expect(body.id).toEqual(expect.any(String));
  });

  it("uses exponential reconnect delay until the stream recovers", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const delays: number[] = [];
    let attempt = 0;
    const client = {
      listEvents: async () => [],
      streamEvents: () => {
        attempt += 1;
        if (attempt < 3) {
          return (async function* () {
            throw new Error(`boom-${attempt}`);
          })();
        }
        return (async function* () {
          yield event(1, "session.created");
          controller.abort();
          throw new DOMException("Aborted", "AbortError");
        })();
      },
    } as unknown as OpenHarnessClient;

    const run = (async () => {
      for await (const update of syncEvents(client, {
        signal: controller.signal,
        reconnectDelayMs: (n) => {
          const ms = 100 * 2 ** n;
          delays.push(ms);
          return ms;
        },
      })) {
        if (update.source === "live") break;
      }
    })();

    await vi.advanceTimersByTimeAsync(0);
    expect(delays).toEqual([100]);
    await vi.advanceTimersByTimeAsync(100);
    expect(delays).toEqual([100, 200]);
    await vi.advanceTimersByTimeAsync(200);
    await run;
    vi.useRealTimers();
  });
});
