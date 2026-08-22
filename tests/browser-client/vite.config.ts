import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const fixtureDir = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = resolve(fixtureDir, "../..");

export default defineConfig({
  root: fixtureDir,
  resolve: {
    alias: {
      "@openharness/client": resolve(repositoryRoot, "packages/client/src/index.ts"),
      "@openharness/protocol": resolve(repositoryRoot, "packages/protocol/src/index.ts"),
      "@openharness/jobs": resolve(repositoryRoot, "packages/jobs/src/index.ts"),
      "@openharness/terminal": resolve(repositoryRoot, "packages/terminal/src/index.ts"),
    },
  },
  build: {
    outDir: resolve(repositoryRoot, ".cache/browser-client-build"),
    emptyOutDir: true,
  },
});
