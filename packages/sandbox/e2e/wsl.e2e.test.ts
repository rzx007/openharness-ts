import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hostPathToWslPath, preflightWsl, spawnWslProcess } from "../src/index.js";

const maybeDescribe = process.platform === "win32" ? describe : describe.skip;

maybeDescribe("WSL execution environment e2e", () => {
  it("keeps cwd, env, exit codes, and files inside WSL", async (context) => {
    try {
      await preflightWsl();
    } catch (error) {
      context.skip(error instanceof Error ? error.message : String(error));
      return;
    }

    const hostRoot = await mkdtemp(join(tmpdir(), "ohs wsl e2e "));
    const executionRoot = hostPathToWslPath(hostRoot);
    try {
      const success = spawnWslProcess({
        argv: ["/bin/sh", "-lc", "printf '%s|%s' \"$PWD\" \"$OHS_WSL_VALUE\"; printf payload > result.txt"],
        cwd: executionRoot,
        env: { OHS_WSL_VALUE: "works" },
      });
      const output = await collect(success);
      expect(output.code).toBe(0);
      expect(output.stdout).toBe(`${executionRoot}|works`);
      expect(await readFile(join(hostRoot, "result.txt"), "utf8")).toBe("payload");

      const failed = spawnWslProcess({ argv: ["/bin/sh", "-c", "exit 7"], cwd: executionRoot });
      expect((await collect(failed)).code).toBe(7);
    } finally {
      await rm(hostRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

function collect(child: ReturnType<typeof spawnWslProcess>): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout }));
    child.stdin?.end();
  });
}
