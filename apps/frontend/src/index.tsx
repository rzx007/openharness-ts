/**
 * TUI 前端入口（进程 B，Bun 运行时）。配置经 OPENHARNESS_FRONTEND_CONFIG 注入；
 * backend 由 useBackendSession spawn。详见 docs/tui-flow.md。
 */
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./App";
import type { FrontendConfig } from "./types";

const rawConfig = process.env.OPENHARNESS_FRONTEND_CONFIG;
let config: FrontendConfig;
try {
  const parsed = rawConfig ? JSON.parse(rawConfig) : {};
  config = {
    backend_command: parsed.backend_command
      ?? (process.env.OPENHARNESS_BACKEND_COMMAND?.split(" ") ?? ["ohs", "--backend-only"]),
    initial_prompt: parsed.initial_prompt ?? process.env.OPENHARNESS_INITIAL_PROMPT ?? null,
    theme: parsed.theme ?? process.env.OPENHARNESS_THEME ?? "default",
    version: parsed.version ?? null,
  };
} catch {
  config = { backend_command: ["ohs", "--backend-only"], theme: "default" };
}

try {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  createRoot(renderer).render(<App config={config} />);
} catch (err) {
  console.error("[openharness] 终端渲染器初始化失败（需要 Bun + 支持的平台）：", err);
  process.exit(1);
}
