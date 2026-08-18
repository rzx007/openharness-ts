import { describe, expect, it, vi } from "vitest";
import { createWebFetchTool } from "../fetch.js";
import { createWebSearchTool } from "../search.js";
import {
  WebProviderError,
  type WebFetchRequest,
  type WebRuntimeLike,
  type WebSearchRequest,
} from "../types.js";

describe("web tools", () => {
  it("blocks WebFetch when sandbox network.mode is none", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("should not reach host fetch");
    });
    const tool = createWebFetchTool(runtime({ fetch }));

    const result = await tool.execute(
      { url: "https://example.com" },
      {
        cwd: process.cwd(),
        settings: {
          sandbox: {
            enabled: true,
            backend: "docker",
            network: { mode: "none" },
          },
        } as never,
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("web_fetch failed [network_denied]"),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks WebSearch when sandbox network.mode is none", async () => {
    const search = vi.fn(async () => {
      throw new Error("should not reach host search");
    });
    const tool = createWebSearchTool(runtime({ search }));

    const result = await tool.execute(
      { query: "secrets" },
      {
        cwd: process.cwd(),
        settings: {
          sandbox: {
            enabled: true,
            backend: "docker",
            network: { mode: "none" },
          },
        } as never,
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("web_search failed [network_denied]"),
    });
    expect(search).not.toHaveBeenCalled();
  });

  it("allows WebFetch when sandbox network.mode is bridge", async () => {
    const tool = createWebFetchTool(runtime({
      async fetch() {
        return {
          provider: "test-fetch",
          url: "https://example.com",
          status: 200,
          statusText: "OK",
          ok: true,
          contentType: "text/plain",
          body: "ok",
          truncated: false,
        };
      },
    }));

    const result = await tool.execute(
      { url: "https://example.com" },
      {
        cwd: process.cwd(),
        settings: {
          sandbox: {
            enabled: true,
            backend: "docker",
            network: { mode: "bridge" },
          },
        } as never,
      },
    );

    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("ok"),
    });
  });

  it("keeps the WebSearch result rendering stable", async () => {
    const tool = createWebSearchTool(runtime({
      async search(request) {
        expect(request).toEqual({ query: "openharness", maxResults: 3 });
        return {
          provider: "test-search",
          sources: [{
            title: "OpenHarness",
            url: "https://example.com",
            snippet: "A result",
          }],
        };
      },
    }));

    const result = await tool.execute({ query: "openharness", maxResults: 3 }, { cwd: process.cwd() });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: [
        "Search results for: openharness",
        "1. OpenHarness",
        "   URL: https://example.com",
        "   A result",
      ].join("\n"),
    });
  });

  it("renders structured provider errors with their error code", async () => {
    const tool = createWebSearchTool(runtime({
      async search() {
        throw new WebProviderError("parse_failed", "unexpected markup");
      },
    }));

    const result = await tool.execute({ query: "x" }, { cwd: process.cwd() });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "web_search failed [parse_failed]: unexpected markup",
    });
  });

  it("keeps WebFetch headers and body rendering stable", async () => {
    const tool = createWebFetchTool(runtime({
      async fetch(request) {
        expect(request).toEqual({
          url: "https://example.com",
          maxChars: 12000,
          format: "text",
        });
        return {
          provider: "test-fetch",
          url: "https://example.com/final",
          status: 200,
          statusText: "OK",
          ok: true,
          contentType: "text/plain",
          body: "Hello",
          truncated: false,
        };
      },
    }));

    const result = await tool.execute({ url: "https://example.com" }, { cwd: process.cwd() });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "URL: https://example.com/final\nStatus: 200\nContent-Type: text/plain\n\nHello",
    });
  });

  it("marks non-2xx fetch results with a distinct HTTP error code", async () => {
    const tool = createWebFetchTool(runtime({
      async fetch() {
        return {
          provider: "test-fetch",
          url: "https://example.com/missing",
          status: 404,
          statusText: "Not Found",
          ok: false,
          contentType: "text/plain",
          body: "missing",
          truncated: false,
        };
      },
    }));

    const result = await tool.execute({ url: "https://example.com/missing" }, { cwd: process.cwd() });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "web_fetch failed [http_status]: HTTP 404 Not Found",
    });
  });
});

function runtime(overrides: {
  search?: (request: WebSearchRequest, signal?: AbortSignal) => ReturnType<WebRuntimeLike["search"]>;
  fetch?: (request: WebFetchRequest, signal?: AbortSignal) => ReturnType<WebRuntimeLike["fetch"]>;
}): WebRuntimeLike {
  return {
    search: overrides.search ?? (async () => {
      throw new Error("Unexpected search call");
    }),
    fetch: overrides.fetch ?? (async () => {
      throw new Error("Unexpected fetch call");
    }),
  };
}
