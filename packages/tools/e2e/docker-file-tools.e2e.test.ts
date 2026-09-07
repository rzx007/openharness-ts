import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings, ToolContext } from "@openharness/core";
import { createWorkspaceBinding, type ExecutionEnvironmentHandle } from "@openharness/environment";
import {
  createExecutionEnvironment,
  resolveExecutionEnvironmentConfig,
} from "@openharness/sandbox";
import { bashTool } from "../src/shell/bash.js";
import { createEnvironmentFileSystem } from "../src/file/operations.js";
import { fileEditTool } from "../src/file/edit.js";
import { globTool } from "../src/file/glob.js";
import { fileReadTool } from "../src/file/read.js";
import { fileWriteTool } from "../src/file/write.js";
import { grepTool } from "../src/search/grep.js";
import { lspTool } from "../src/search/lsp.js";

const image = process.env.OPENHARNESS_E2E_DOCKER_FILE_IMAGE ?? "openharness-sandbox:latest";
const autoBuildImage = process.env.OPENHARNESS_E2E_DOCKER_FILE_IMAGE === undefined;
const runDocker = dockerAvailable();
const runWithImage = runDocker && (autoBuildImage || dockerImageAvailable(image));
const maybeDescribe = runWithImage ? describe : describe.skip;

let runtime: ExecutionEnvironmentHandle | undefined;

afterEach(async () => {
  await runtime?.release();
  runtime = undefined;
});

beforeAll(() => {
  if (!runDocker) {
    console.warn("[tools:e2e:docker] skipped: Docker CLI or daemon is unavailable");
    return;
  }
  if (!runWithImage) {
    console.warn(`[tools:e2e:docker] skipped: Docker image ${image} is not available`);
  }
});

maybeDescribe("docker file tools e2e", () => {
  it("runs Shell, file tools, and LSP through a Docker environment", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "oh-tools-docker-e2e-"));
    const sessionId = `tools-docker-${Date.now()}`;
    const settings = dockerSettings();
    try {
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "a.ts"), "export const token = 'needle';\n", "utf8");
      await writeFile(join(cwd, "src", "b.js"), "needle in js\n", "utf8");

      const userSkillsRoot = join(cwd, "user-skills");
      const baseEnvironment = await createExecutionEnvironment({
        config: resolveExecutionEnvironmentConfig({
          surface: "desktop_managed",
          settings,
          cwd,
        }),
        settings,
        binding: createWorkspaceBinding({
          kind: "docker",
          hostRoot: cwd,
          executionRoot: "/workspace",
        }),
        sessionId,
        userSkillsRoot,
      });
      runtime = {
        ...baseEnvironment,
        files: createEnvironmentFileSystem(baseEnvironment, { settings, sessionId }),
      };
      expect(runtime.info).toMatchObject({
        kind: "docker",
        cwd: "/workspace",
        shell: "/bin/sh",
      });

      const context: ToolContext = {
        cwd: "/workspace",
        sessionId,
        settings,
        environment: runtime,
      };
      const pwdResult = await bashTool.execute!({ command: "pwd" }, context);
      expect((pwdResult.content[0] as any).text).toBe("/workspace");

      const writeResult = await fileWriteTool.execute!(
        { file_path: "/workspace/notes.txt", content: "alpha" },
        context,
      );
      expect(writeResult.isError).toBeFalsy();
      expect(await readFile(join(cwd, "notes.txt"), "utf8")).toBe("alpha");

      const readResult = await fileReadTool.execute!(
        { file_path: "/workspace/notes.txt" },
        context,
      );
      expect((readResult.content[0] as any).text).toBe("1: alpha");

      const editResult = await fileEditTool.execute!(
        { file_path: "/workspace/notes.txt", old_string: "alpha", new_string: "beta" },
        context,
      );
      expect(editResult.isError).toBeFalsy();
      expect(await readFile(join(cwd, "notes.txt"), "utf8")).toBe("beta");

      const globResult = await globTool.execute!(
        { pattern: "**/*.ts", path: "/workspace" },
        context,
      );
      expect((globResult.content[0] as any).text).toBe("src/a.ts");

      const grepResult = await grepTool.execute!(
        { pattern: "needle", include: "*.ts", path: "/workspace" },
        context,
      );
      expect((grepResult.content[0] as any).text).toContain("src/a.ts:1:");
      expect((grepResult.content[0] as any).text).not.toContain("src/b.js");

      const lspResult = await lspTool.execute!(
        { operation: "workspace_symbol", query: "token" },
        context,
      );
      expect((lspResult.content[0] as any).text).toContain("src/a.ts:1");

      const skillWrite = await fileWriteTool.execute!(
        { file_path: "/opt/openharness/skills/e2e/SKILL.md", content: "# e2e" },
        context,
      );
      expect(skillWrite.isError).toBeFalsy();
      expect(await readFile(join(userSkillsRoot, "e2e", "SKILL.md"), "utf8")).toBe("# e2e");

      const outsideRead = await fileReadTool.execute!(
        { file_path: "/etc/passwd" },
        context,
      );
      expect(outsideRead).toMatchObject({ isError: true });
      expect((outsideRead.content[0] as any).text).toContain("outside the mounted execution roots");
    } finally {
      await runtime?.release();
      runtime = undefined;
      await rm(cwd, { recursive: true, force: true });
    }
  }, 120_000);
});

function dockerSettings(): Settings {
  return {
    model: "e2e",
    apiFormat: "openai",
    maxTurns: 1,
    permission: { mode: "default" },
    sandbox: {
      enabled: true,
      backend: "docker",
      failIfUnavailable: true,
      network: { mode: "none" },
      docker: {
        image,
        autoBuildImage,
        reuseContainer: false,
      },
    },
  };
}

function dockerAvailable(): boolean {
  if (!hasCommand("docker")) return false;
  const result = spawnSync("docker", ["info"], {
    windowsHide: true,
    stdio: "ignore",
  });
  return result.status === 0;
}

function dockerImageAvailable(candidate: string): boolean {
  const result = spawnSync("docker", ["image", "inspect", candidate], {
    windowsHide: true,
    stdio: "ignore",
  });
  return result.status === 0;
}

function hasCommand(command: string): boolean {
  const result = spawnSync(command, ["--version"], {
    windowsHide: true,
    stdio: "ignore",
  });
  return result.status === 0;
}
