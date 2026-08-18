export type WebProviderErrorCode =
  | "provider_unavailable"
  | "invalid_request"
  | "network_failure"
  | "network_denied"
  | "http_status"
  | "response_read_failed"
  | "parse_failed"
  | "aborted";

export type WebProviderAvailability =
  | { available: true }
  | { available: false; reason: string };

export interface WebSearchSource {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchRequest {
  query: string;
  maxResults: number;
  searchUrl?: string;
}

export interface WebSearchResult {
  provider: string;
  sources: WebSearchSource[];
}

export type WebFetchFormat = "text" | "markdown" | "html";

export interface WebFetchRequest {
  url: string;
  format: WebFetchFormat;
  maxChars: number;
}

export interface WebFetchProviderRequest {
  url: string;
}

export interface WebFetchProviderResult {
  provider: string;
  url: string;
  status: number;
  statusText: string;
  ok: boolean;
  contentType: string;
  body: string;
}

export interface WebFetchResult extends WebFetchProviderResult {
  truncated: boolean;
}

export interface WebSearchProvider {
  readonly name: string;
  available(): WebProviderAvailability;
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
}

export interface WebFetchProvider {
  readonly name: string;
  available(): WebProviderAvailability;
  fetch(request: WebFetchProviderRequest, signal?: AbortSignal): Promise<WebFetchProviderResult>;
}

export interface WebRuntimeLike {
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
  fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>;
}

export interface WebHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type WebFetchFunction = (
  url: string,
  init: {
    headers: Record<string, string>;
    redirect: "follow";
    signal?: AbortSignal;
  },
) => Promise<WebHttpResponse>;

export class WebProviderError extends Error {
  readonly code: WebProviderErrorCode;
  readonly provider?: string;
  readonly status?: number;
  readonly statusText?: string;
  readonly cause?: unknown;

  constructor(
    code: WebProviderErrorCode,
    message: string,
    options: {
      provider?: string;
      status?: number;
      statusText?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "WebProviderError";
    this.code = code;
    this.provider = options.provider;
    this.status = options.status;
    this.statusText = options.statusText;
    this.cause = options.cause;
  }
}
