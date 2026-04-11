import type { ToolDefinition } from "@openharness/core";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export const webSearchTool: ToolDefinition = {
  name: "WebSearch",
  description: "Search the web and return compact top results with titles, URLs, and snippets.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query." },
      maxResults: {
        type: "number",
        description: "Maximum number of results (1-10).",
        default: 5,
      },
      searchUrl: {
        type: "string",
        description: "Optional override for the HTML search endpoint.",
      },
    },
    required: ["query"],
  },
  async execute(input) {
    const query = input.query as string;
    const maxResults = ((input.maxResults as number) ?? 5);
    const endpoint =
      (input.searchUrl as string) || "https://html.duckduckgo.com/html/";

    try {
      const response = await fetch(
        `${endpoint}?q=${encodeURIComponent(query)}`,
        {
          headers: { "User-Agent": "OpenHarness/0.1" },
          redirect: "follow",
          signal: AbortSignal.timeout(20_000),
        }
      );
      if (!response.ok) {
        return {
          content: [
            {
              type: "text",
              text: `web_search failed: HTTP ${response.status}`,
            },
          ],
          isError: true,
        };
      }
      const body = await response.text();
      const results = parseSearchResults(body, maxResults);
      if (!results.length) {
        return {
          content: [{ type: "text", text: "No search results found." }],
          isError: true,
        };
      }
      const lines = [`Search results for: ${query}`];
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        lines.push(`${i + 1}. ${r.title}`);
        lines.push(`   URL: ${r.url}`);
        if (r.snippet) lines.push(`   ${r.snippet}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `web_search failed: ${error}` }],
        isError: true,
      };
    }
  },
};

function parseSearchResults(body: string, limit: number): SearchResult[] {
  const snippets: string[] = [];
  const snippetRe =
    /<(?:a|div|span)[^>]+class="[^"]*(?:result__snippet|result-snippet)[^"]*"[^>]*>(.*?)<\/(?:a|div|span)>/gis;
  let m: RegExpExecArray | null;
  while ((m = snippetRe.exec(body)) !== null) {
    snippets.push(cleanHtml(m[1]!));
  }

  const results: SearchResult[] = [];
  const anchorRe = /<a([^>]+)>([\s\S]*?)<\/a>/gi;
  let idx = 0;
  let m2: RegExpExecArray | null;
  while ((m2 = anchorRe.exec(body)) !== null) {
    const attrs = m2[1]!;
    const titleHtml = m2[2]!;
    const classMatch = /class="([^"]+)"/i.exec(attrs);
    if (!classMatch) continue;
    const classNames = classMatch[1]!;
    if (
      !classNames.includes("result__a") &&
      !classNames.includes("result-link")
    )
      continue;
    const hrefMatch = /href="([^"]+)"/i.exec(attrs);
    if (!hrefMatch) continue;
    const title = cleanHtml(titleHtml);
    const url = normalizeResultUrl(hrefMatch[1]!);
    const snippet = idx < snippets.length ? snippets[idx]! : "";
    idx++;
    if (title && url) {
      results.push({ title, url, snippet });
    }
    if (results.length >= limit) break;
  }
  return results;
}

function normalizeResultUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl, "https://duckduckgo.com");
    if (
      parsed.hostname.endsWith("duckduckgo.com") &&
      parsed.pathname.startsWith("/l/")
    ) {
      const uddg = parsed.searchParams.get("uddg");
      if (uddg) return decodeURIComponent(uddg);
    }
  } catch {
    // not a valid URL, return as-is
  }
  return rawUrl;
}

function cleanHtml(fragment: string): string {
  let text = fragment.replace(/<[^>]+>/g, " ");
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}
