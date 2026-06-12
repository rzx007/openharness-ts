import { spawnSync } from "node:child_process";

/** 解析 bun 可执行文件。Windows 下 libuv 不应用 PATHEXT，须显式尝试 bun.exe。 */
export function resolveBun(): string | null {
  const candidates = process.platform === "win32" ? ["bun.exe", "bun"] : ["bun"];
  for (const cmd of candidates) {
    const r = spawnSync(cmd, ["--version"], { stdio: "ignore" });
    if (r.error == null && r.status === 0) return cmd;
  }
  return null;
}
