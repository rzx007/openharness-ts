import { Hono } from "hono";

import type { SessionEventRecord, SessionStore } from "@openharness/services";

import {
  SSE_HEADERS,
  jsonResponse,
  readCursor,
  readEventCursor,
  readLimit,
  type SseClient,
} from "../support.js";

export class HttpEventHub {
  private readonly encoder = new TextEncoder();
  private readonly sseClients = new Set<SseClient>();

  constructor(private readonly store: Pick<SessionStore, "listEvents">) {}

  get clientCount(): number {
    return this.sseClients.size;
  }

  createRoutes(): Hono {
    return new Hono()
      .get("/", (c) => {
        const events = this.store.listEvents({
          afterSeq: readCursor(c),
          sessionId: c.req.query("sessionId") ?? undefined,
          limit: readLimit(c.req.query("limit")),
        });
        return jsonResponse({ events });
      })
      .get("/stream", (c) => {
        const sessionId = c.req.query("sessionId") ?? undefined;
        let client: SseClient | undefined;

        const stream = new ReadableStream<Uint8Array>({
          start: (controller) => {
            client = { sessionId, controller };
            this.sseClients.add(client);
            controller.enqueue(this.encoder.encode(": connected\n\n"));
            const heartbeat = setInterval(() => this.writeSseComment(client!, "keepalive"), 15_000);
            heartbeat.unref?.();
            client.heartbeat = heartbeat;
            for (const event of this.store.listEvents({ afterSeq: readEventCursor(c), sessionId })) {
              this.writeSse(client, event);
            }
          },
          cancel: () => {
            if (client) this.removeSseClient(client);
          },
        });

        return new Response(stream, { status: 200, headers: SSE_HEADERS });
      });
  }

  broadcastSince(seq: number): void {
    const events = this.store.listEvents({ afterSeq: seq });
    for (const event of events) {
      this.broadcastEvent(event);
    }
  }

  broadcastEvent(event: SessionEventRecord): void {
    for (const client of this.sseClients) {
      if (client.sessionId && event.sessionId && event.sessionId !== client.sessionId) continue;
      this.writeSse(client, event);
    }
  }

  closeClients(): void {
    for (const client of [...this.sseClients]) {
      try {
        client.controller.close();
      } catch {
        // Client may already be gone.
      }
      this.removeSseClient(client);
    }
  }

  private writeSse(client: SseClient, event: SessionEventRecord): void {
    try {
      client.controller.enqueue(
        this.encoder.encode(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
      );
    } catch {
      this.removeSseClient(client);
    }
  }

  private writeSseComment(client: SseClient, comment: string): void {
    try {
      client.controller.enqueue(this.encoder.encode(`: ${comment}\n\n`));
    } catch {
      this.removeSseClient(client);
    }
  }

  private removeSseClient(client: SseClient): void {
    if (client.heartbeat) clearInterval(client.heartbeat);
    this.sseClients.delete(client);
  }
}
