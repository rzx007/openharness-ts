import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.tsx"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  bundle: true,
  platform: "node",
  banner: { js: "#!/usr/bin/env node" },
});
