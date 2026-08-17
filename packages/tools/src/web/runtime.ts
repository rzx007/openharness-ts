import {
  WebProviderError,
  type WebFetchProvider,
  type WebFetchRequest,
  type WebFetchResult,
  type WebRuntimeLike,
  type WebSearchProvider,
  type WebSearchRequest,
  type WebSearchResult,
} from "./types.js";

export interface WebRuntimeOptions {
  searchProvider?: WebSearchProvider;
  fetchProvider?: WebFetchProvider;
}

export class WebRuntime implements WebRuntimeLike {
  readonly searchProvider?: WebSearchProvider;
  readonly fetchProvider?: WebFetchProvider;

  constructor(options: WebRuntimeOptions = {}) {
    this.searchProvider = options.searchProvider;
    this.fetchProvider = options.fetchProvider;
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const provider = requireProvider(this.searchProvider, "search");
    assertAvailable(provider);
    try {
      return await provider.search(request, signal);
    } catch (error) {
      throw normalizeProviderError(error, provider.name, signal);
    }
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const provider = requireProvider(this.fetchProvider, "fetch");
    assertAvailable(provider);
    try {
      const result = await provider.fetch({ url: request.url }, signal);
      let body = result.body;
      if (request.format !== "html" && result.contentType.includes("html")) {
        body = htmlToText(body);
      }
      body = body.trim();

      const truncated = body.length > request.maxChars;
      if (truncated) {
        body = body.slice(0, request.maxChars).trimEnd() + "\n...[truncated]";
      }

      return { ...result, body, truncated };
    } catch (error) {
      throw normalizeProviderError(error, provider.name, signal);
    }
  }
}

function requireProvider<T extends { name: string }>(provider: T | undefined, capability: string): T {
  if (provider) return provider;
  throw new WebProviderError(
    "provider_unavailable",
    `No ${capability} provider is configured.`,
  );
}

function assertAvailable(provider: { name: string; available(): { available: boolean; reason?: string } }): void {
  const availability = provider.available();
  if (availability.available) return;
  throw new WebProviderError(
    "provider_unavailable",
    availability.reason ?? `${provider.name} is unavailable.`,
    { provider: provider.name },
  );
}

function normalizeProviderError(
  error: unknown,
  provider: string,
  signal?: AbortSignal,
): WebProviderError {
  if (error instanceof WebProviderError) return error;
  if (signal?.aborted) {
    return new WebProviderError("aborted", abortMessage(signal), {
      provider,
      cause: error,
    });
  }
  return new WebProviderError(
    "network_failure",
    error instanceof Error ? error.message : String(error),
    { provider, cause: error },
  );
}

function abortMessage(signal: AbortSignal): string {
  return signal.reason instanceof Error
    ? signal.reason.message
    : "Web request was aborted.";
}

export function htmlToText(html: string): string {
  let text = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeHtmlEntities(text);
  text = text.replace(/[ \t\r\f\v]+/g, " ").replace(/ \n/g, "\n");
  return text.trim();
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
