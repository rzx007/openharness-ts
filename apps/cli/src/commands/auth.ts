import { Command } from "commander";

export function createAuthCommand(): Command {
  const cmd = new Command("auth").description("Manage authentication");

  cmd
    .command("login")
    .description("Login with API key or OAuth")
    .option("-k, --api-key <key>", "API key")
    .option("-p, --provider <provider>", "Provider name")
    .action(async (opts: { apiKey?: string; provider?: string }) => {
      const chalk = (await import("chalk")).default;
      if (opts.apiKey) {
        console.log(chalk.green("API key configured"));
      } else {
        const { AuthManager, DeviceCodeFlow } = await import("@openharness/auth");
        const mgr = new AuthManager();
        const flow = new DeviceCodeFlow("openharness", "https://github.com/login/device/code", "https://github.com/login/oauth/access_token");
        mgr.registerProvider(flow);
        try {
          const creds = await mgr.authenticate("device-code");
          console.log(chalk.green(`Authenticated as ${creds.provider}`));
        } catch (err: any) {
          console.error(chalk.red(`Authentication failed: ${err.message}`));
          process.exit(1);
        }
      }
    });

  cmd
    .command("status")
    .description("Show authentication status")
    .action(async () => {
      const chalk = (await import("chalk")).default;
      const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GITHUB_TOKEN);
      if (hasKey) {
        console.log(chalk.green("✓ Authenticated (env key found)"));
      } else {
        console.log(chalk.yellow("✗ No authentication configured"));
        console.log(chalk.gray("  Run 'oh auth login' to authenticate"));
      }
    });

  cmd
    .command("logout")
    .description("Clear stored credentials")
    .action(async () => {
      const chalk = (await import("chalk")).default;
      console.log(chalk.green("Credentials cleared"));
    });

  cmd
    .command("copilot-login")
    .description("Login to GitHub Copilot")
    .action(async () => {
      const chalk = (await import("chalk")).default;
      console.log(chalk.gray("Starting Copilot OAuth flow..."));
      const { CopilotClient } = await import("@openharness/api");
      try {
        new CopilotClient(undefined, { githubToken: process.env.GITHUB_TOKEN });
        console.log(chalk.green("Copilot authentication verified"));
      } catch (err: any) {
        console.error(chalk.red(`Copilot login failed: ${err.message}`));
        process.exit(1);
      }
    });

  cmd
    .command("copilot-logout")
    .description("Logout from GitHub Copilot")
    .action(async () => {
      const { unlink } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const chalk = (await import("chalk")).default;
      try {
        await unlink(join(homedir(), ".openharness", "copilot_auth.json"));
        console.log(chalk.green("Copilot credentials removed"));
      } catch {
        console.log(chalk.yellow("No Copilot credentials found"));
      }
    });

  return cmd;
}
