import type { Settings } from "@openharness/core";
import { loadSettings } from "@openharness/core";
import chalk from "chalk";

interface MainOptions {
  model?: string;
  print?: boolean;
  continue?: boolean;
  resume?: string;
  provider?: string;
  permissionMode?: string;
  backendOnly?: boolean;
}

export async function mainAction(
  prompt: string | undefined,
  options: MainOptions
): Promise<void> {
  const overrides: Partial<Settings> = {};

  if (options.model) overrides.model = options.model;
  if (options.provider) overrides.apiFormat = options.provider as Settings["apiFormat"];
  if (options.permissionMode)
    overrides.permissionMode = options.permissionMode as Settings["permissionMode"];

  const settings = await loadSettings(overrides);

  if (options.backendOnly) {
    console.log(chalk.gray("Starting backend host..."));
    // TODO: run backend host for TUI
    return;
  }

  if (options.print && prompt) {
    console.log(chalk.gray("Running in print mode..."));
    // TODO: run print mode
    return;
  }

  console.log(chalk.cyan("OpenHarness") + chalk.gray(" v0.1.0"));
  console.log(chalk.gray(`Model: ${settings.model}`));
  console.log();

  if (prompt) {
    console.log(chalk.white("> " + prompt));
    // TODO: submit prompt to engine
  }

  // TODO: start interactive REPL
  console.log(chalk.gray("Interactive mode not yet implemented."));
}
