import { describe, expect, it } from "vitest";

import { RequestTraceRegistry } from "./request-trace-registry.js";

describe("RequestTraceRegistry", () => {
  it("validates and reuses an incoming request trace id", () => {
    const traces = new RequestTraceRegistry();
    const request = new Request("http://localhost/sessions");

    expect(traces.assign(request, "trace-1")).toBe("trace-1");
    expect(traces.get(request)).toBe("trace-1");
  });

  it("creates and retains a trace id when none was assigned", () => {
    const traces = new RequestTraceRegistry();
    const request = new Request("http://localhost/sessions");

    const traceId = traces.get(request);

    expect(traceId).toBeTruthy();
    expect(traces.get(request)).toBe(traceId);
  });
});
