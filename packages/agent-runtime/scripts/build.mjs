import { build } from "esbuild";

const shared = {
  bundle: true,
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
