import { describe, expect, it, vi } from "vitest";

import type { ToolContext } from "@openharness/core";
import type { ExecutionEnvironmentHandle } from "@openharness/environment";

import { resolveToolPathInContext } from "../environment-path.js";
import { fileReadTool } from "../read.js";

describe("resolveToolPathInContext", () => {
  it("uses the execution environment path namespace", async () => {
    const resolve = vi.fn(async () => ({
      executionPath: "/workspace/src/app.ts",
      hostPath: "D:\\code\\ohs\\src\\app.ts",
      mountPurpose: "workspace" as const,
      mountMode: "rw" as const,
    }));
    const context = {
      cwd: "/workspace",
      environment: {
        paths: { resolve },
      } as unknown as ExecutionEnvironmentHandle,
    } satisfies ToolContext;

    await expect(
      resolveToolPathInContext("src/app.ts", context, "read"),
    ).resolves.toBe("/workspace/src/app.ts");
    expect(resolve).toHaveBeenCalledWith("src/app.ts", "read");
  });

  it("reads through the file system owned by the same environment", async () => {
    const readText = vi.fn(async () => "hello");
    const context = {
      cwd: "/workspace",
      environment: {
        workspace: {
          kind: "wsl",
          hostRoot: "D:\\code\\ohs",
          executionRoot: "/workspace",
        },
        paths: {
          resolve: vi.fn(async (path: string) => ({
            executionPath: `/workspace/${path}`,
            hostPath: `D:\\code\\ohs\\${path}`,
            mountPurpose: "workspace" as const,
            mountMode: "rw" as const,
          })),
        },
        files: {
          stat: vi.fn(async () => ({ isFile: true, isDirectory: false })),
          readText,
        },
      } as unknown as ExecutionEnvironmentHandle,
    } satisfies ToolContext;

    const result = await fileReadTool.execute(
      { file_path: "src/app.ts" },
      context,
    );

    expect(readText).toHaveBeenCalledWith("/workspace/src/app.ts");
    expect(result.content[0]).toMatchObject({ text: "1: hello" });
  });
});
