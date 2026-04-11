import type { ToolDefinition } from "@openharness/core";

export const webFetchTool: ToolDefinition = {
  name: "WebFetch",
  description: "Fetch one web page and return compact readable text.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "HTTP or HTTPS URL to fetch." },
      format: {
        type: "string",
        enum: ["text", "markdown", "html"],
        description: "Response format.",
      },
      maxChars: {
        type: "number",
        description: "Maximum characters to return (500-50000). Default: 12000.",
        default: 12000,
      },
    },
    required: ["url"],
  },
  async execute(input) {
    const url = input.url as string;
    const maxChars = ((input.maxChars as number) ?? 12000);
    const format = (input.format as string) ?? "text";

    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "OpenHarness/0.1" },
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        return {
          content: [
            {
              type: "text",
              text: `web_fetch failed: HTTP ${response.status} ${response.statusText}`,
            },
          ],
          isError: true,
        };
      }

      const contentType = response.headers.get("content-type") ?? "";
      let body = await response.text();

      if (format === "html") {
        // return raw HTML
      } else if (
        contentType.includes("html") &&
        format !== "markdown"
      ) {
        body = htmlToText(body);
      } else if (format === "markdown" && contentType.includes("html")) {
        body = htmlToText(body);
      }

      body = body.trim();
      if (body.length > maxChars) {
        body = body.slice(0, maxChars).trimEnd() + "\n...[truncated]";
      }

      const finalUrl = response.url ?? url;
      const status = response.status;
      const header = [
        `URL: ${finalUrl}`,
        `Status: ${status}`,
        `Content-Type: ${contentType || "(unknown)"}`,
        "",
      ].join("\n");

      return { content: [{ type: "text", text: `${header}\n${body}` }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `web_fetch failed: ${error}` }],
        isError: true,
      };
    }
  },
};

function htmlToText(html: string): string {
  let text = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(/<[^>]+>/g, " ");
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  text = text.replace(/[ \t\r\f\v]+/g, " ").replace(/ \n/g, "\n");
  return text.trim();
}
