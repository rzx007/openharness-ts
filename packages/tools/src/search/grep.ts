import type { ToolDefinition } from "@openharness/core";
import { fallbackGrep, fileOperationsFor } from "../file/operations.js";
import { resolveToolPath } from "../file/path.js";
import { sandboxPathError } from "../file/sandbox-guard.js";

export const grepTool: ToolDefinition = {
  name: "Grep",
  description:
    "Search file contents using regular expressions. Returns matching file:line:content entries.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for." },
      path: { type: "string", description: "Directory or file to search in." },
      include: {
        type: "string",
        description: 'File glob pattern to include (e.g. "*.ts").',
      },
      caseSensitive: {
        type: "boolean",
        description: "Whether the search is case-sensitive. Default: true.",
        default: true,
      },
      limit: {
        type: "number",
        description: "Maximum number of matches. Default: 200.",
        default: 200,
      },
    },
    required: ["pattern"],
  },
  async execute(input, context) {
    const pattern = input.pattern as string;
    const cwd = context.cwd ?? process.cwd();
    const basePath = resolveToolPath((input.path as string) ?? cwd, cwd);
    const include = input.include as string | undefined;
    const caseSensitive = (input.caseSensitive as boolean) ?? true;
    const limit = (input.limit as number) ?? 200;

    try {
      const sandboxError = await sandboxPathError(basePath, cwd, "read", context.settings);
      if (sandboxError) {
        return {
          content: [{ type: "text", text: sandboxError }],
          isError: true,
        };
      }

      const operations = fileOperationsFor(context);
      const rgResult = await operations.grep(basePath, pattern, {
        include,
        caseSensitive,
        limit,
      });
      if (rgResult !== null) {
        return {
          content: [
            {
              type: "text",
              text: rgResult.length > 0 ? rgResult.join("\n") : "(no matches)",
            },
          ],
        };
      }

      const results = await fallbackGrep(
        basePath,
        pattern,
        include,
        caseSensitive,
        limit,
        operations,
      );
      return {
        content: [
          {
            type: "text",
            text: results.length > 0 ? results.join("\n") : "(no matches)",
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error}` }],
        isError: true,
      };
    }
  },
};
