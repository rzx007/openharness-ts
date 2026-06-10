/**
 * TUI 前端入口（进程 B）。配置来自 `OPENHARNESS_FRONTEND_CONFIG`（由 runTuiMode 注入）
 * 或 dev 时的 `OPENHARNESS_BACKEND_COMMAND`；backend 由 useBackendSession spawn。
 * 详见 docs/tui-flow.md。
 */
import React from "react";
import { render } from "ink";
import { App } from "./App";
import type { FrontendConfig } from "./types";

interface IndexConfig extends FrontendConfig {
  theme?: string;
}

const rawConfig = process.env.OPENHARNESS_FRONTEND_CONFIG;
let config: IndexConfig;

if (rawConfig) {
  try {
    const parsed = JSON.parse(rawConfig);
    config = {
      backend_command: parsed.backend_command ?? ["node", "--experimental-strip-types", "placeholder"],
      initial_prompt: parsed.initial_prompt ?? null,
      theme: parsed.theme ?? "default",
    };
  } catch {
    config = {
      backend_command: ["node", "--experimental-strip-types", "placeholder"],
      theme: "default",
    };
  }
} else {
  const backendCmd = process.env.OPENHARNESS_BACKEND_COMMAND;
  const command = backendCmd
    ? backendCmd.split(" ")
    : ["ohs", "--backend-only"];

  config = {
    backend_command: command,
    initial_prompt: process.env.OPENHARNESS_INITIAL_PROMPT ?? null,
    theme: process.env.OPENHARNESS_THEME ?? "default",
  };
}

render(React.createElement(App, { config }));
