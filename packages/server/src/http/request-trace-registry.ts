import { randomUUID } from "node:crypto";

import { normalizeTraceId } from "./support.js";

/** Owns request-scoped trace ids shared by middleware and HTTP routes. */
export class RequestTraceRegistry {
  private readonly traceIds = new WeakMap<Request, string>();

  assign(request: Request, incomingTraceId?: string): string {
    const traceId = normalizeTraceId(incomingTraceId) ?? randomUUID();
    this.traceIds.set(request, traceId);
    return traceId;
  }

  get(request: Request): string {
    return this.traceIds.get(request) ?? this.assign(request);
  }
}
