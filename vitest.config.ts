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
  },
  resolve: {
    alias: aliases,
  },
});
