import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";

const shared = {
  bundle: true,
  // Native addons must resolve from their own package directories at runtime.
  external: ["node-pty", "sharp", "better-sqlite3"],
  platform: "node",
  target: "node20",
  logLevel: "info",
};

await Promise.all([
  build({
    ...shared,
    entryPoints: ["src/index.ts"],
    outfile: "dist/index.js",
    format: "esm",
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  }),
  build({
    ...shared,
    entryPoints: ["src/kernel-entry.ts"],
    outfile: "dist/kernel.js",
    format: "esm",
  }),
]);

await mkdir("dist/native-tools", { recursive: true });
await cp("src/native-tools/host-entry.mjs", "dist/native-tools/host-entry.mjs");
