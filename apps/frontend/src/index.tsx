import React from "react";
import { render } from "ink";
import { App } from "./App";

interface FrontendConfig {
  backendCommand?: string;
  theme?: string;
}

const config: FrontendConfig = {
  backendCommand: process.env.OPENHARNESS_BACKEND_COMMAND,
  theme: process.env.OPENHARNESS_THEME,
};

render(React.createElement(App, { config }));
