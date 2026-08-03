/**
 * TUI 前端入口（进程 B，Bun 运行时）。配置经 OPENHARNESS_FRONTEND_CONFIG 注入；
 * daemon 主线由 useServerSync attach。
 * 详见 docs/tui-flow.md 与 docs/client-sync-flow.md。
 */
import { getTheme } from "./theme/builtinThemes";
import { assertSupportedTuiRuntime } from "./runtime";
import type { FrontendConfig } from "./types";

const rawConfig = process.env.OPENHARNESS_FRONTEND_CONFIG;
let config: FrontendConfig;
try {
  const parsed = rawConfig ? JSON.parse(rawConfig) : {};
  config = {
    daemon: parsed.daemon ?? (
      process.env.OPENHARNESS_DAEMON_URL
        ? {
            url: process.env.OPENHARNESS_DAEMON_URL,
            token: process.env.OPENHARNESS_DAEMON_TOKEN ?? null,
            cwd: process.env.OPENHARNESS_DAEMON_CWD ?? null,
            model: process.env.OPENHARNESS_DAEMON_MODEL ?? null,
          }
        : null
    ),
    initial_prompt: parsed.initial_prompt ?? process.env.OPENHARNESS_INITIAL_PROMPT ?? null,
    theme: parsed.theme ?? process.env.OPENHARNESS_THEME ?? "default",
    version: parsed.version ?? null,
  };
} catch {
  config = { daemon: null, theme: "default" };
}

try {
  // OpenTUI 默认 backgroundColor 为 transparent，会透出终端配色；启动时铺上主题底色。
  // Run before importing OpenTUI because its native DLL can crash an unsupported Bun.
  assertSupportedTuiRuntime();
  const [{ createCliRenderer }, { createElement, createRoot }, { App }] = await Promise.all([
    import("@opentui/core"),
    import("@opentui/react"),
    import("./App"),
  ]);
  const initialBg = getTheme(String(config.theme ?? "default")).colors.background;
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    backgroundColor: initialBg,
    onDestroy: () => process.exit(process.exitCode ?? 0),
  });
  createRoot(renderer).render(createElement(App, { config }));
} catch (err) {
  console.error("[openharness] 终端渲染器初始化失败（需要 Bun + 支持的平台）：", err);
  process.exit(1);
}
