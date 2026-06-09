import { defineConfig } from "vitest/config";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packagesDir = resolve(__dirname, "packages");
const aliases: Record<string, string> = {};

for (const name of readdirSync(packagesDir)) {
  const pkgDir = resolve(packagesDir, name);
  try {
    const raw = readFileSync(resolve(pkgDir, "package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    if (pkg.name?.startsWith("@openharness/")) {
      aliases[pkg.name] = resolve(pkgDir, "src", "index.ts");
    }
  } catch {}
}

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    // 不少测试会 spawn 真实子进程（bash/grep/glob、task、swarm teammate 等）。
    // turbo 并行跑全量时 CPU 争抢可能让子进程变慢；默认 5s/用例偏紧，给足余量
    // 避免环境抖动导致的偶发超时（非断言失败）。
    testTimeout: 20000,
    hookTimeout: 20000,
  },
  resolve: {
    alias: aliases,
  },
});
