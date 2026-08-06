import { cpSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
const externals = [...new Set([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.peerDependencies || {}),
  // Native addon: it must resolve beside the installed package, never from dist.
  "better-sqlite3",
])].filter((d) => !d.startsWith("@openharness/"));

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "node",
  format: "esm",
  sourcemap: "external",
  external: externals,
  plugins: [{
    name: "node-punycode-shim",
    setup(build) {
      build.onResolve({ filter: /^punycode$/ }, () => ({
        path: resolve("src/shims/punycode.cjs"),
      }));
    },
  }],
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

for (const output of result.outputs) {
  if (output.path.endsWith("index.js")) {
    const content = "#!/usr/bin/env node\n" + await output.text();
    await Bun.write(output.path, content);
  }
}

// Store migrations are runtime assets: source execution and the bundled CLI both
// resolve them next to the SessionStore module.
rmSync("dist/migrations", { recursive: true, force: true });
cpSync("../../packages/services/src/session-runtime/migrations", "dist/migrations", { recursive: true });

console.log(`Build complete: ${result.outputs.length} files`);
