import { Command } from "commander";

export function createAuthCommand(): Command {
  const cmd = new Command("auth").description("Manage authentication");

  cmd
    .command("login")
    .description("Login with API key or OAuth")
    .option("-k, --api-key <key>", "API key")
    .option("-p, --provider <provider>", "Provider name (anthropic | openai)")
    .action(async (opts: { apiKey?: string; provider?: string }) => {
      const chalk = (await import("chalk")).default;
      if (opts.apiKey) {
        const provider = opts.provider ?? guessProviderFromKey(opts.apiKey);
        console.log(chalk.green(`API key configured for ${provider}`));
        console.log(chalk.gray("Set the appropriate environment variable to persist:"));
        console.log(chalk.gray(`  ${provider.toUpperCase()}_API_KEY=${opts.apiKey.slice(0, 8)}...`));
        return;
      }

      console.error(chalk.red("No OAuth flow available. Use --api-key to set an API key directly."));
      process.exit(1);
    });

  cmd
    .command("status")
    .description("Show authentication status for all providers")
    .action(async () => {
      const chalk = (await import("chalk")).default;
      const providers: Array<{ name: string; key: string | undefined; source: string }> = [
        { name: "Anthropic", key: process.env.ANTHROPIC_API_KEY, source: "ANTHROPIC_API_KEY" },
        { name: "OpenAI", key: process.env.OPENAI_API_KEY, source: "OPENAI_API_KEY" },
        { name: "OpenRouter", key: process.env.OPENROUTER_API_KEY, source: "OPENROUTER_API_KEY" },
        { name: "Google", key: process.env.GOOGLE_API_KEY, source: "GOOGLE_API_KEY" },
        { name: "Groq", key: process.env.GROQ_API_KEY, source: "GROQ_API_KEY" },
        { name: "DeepSeek", key: process.env.DEEPSEEK_API_KEY, source: "DEEPSEEK_API_KEY" },
      ];

      let anyConfigured = false;
      for (const p of providers) {
        if (p.key) {
          anyConfigured = true;
          console.log(chalk.green(`  ✓ ${p.name}: configured (${p.source})`));
        } else {
          console.log(chalk.gray(`  ✗ ${p.name}: not set (${p.source})`));
        }
      }

      if (!anyConfigured) {
        console.log(chalk.yellow("\nNo authentication configured."));
        console.log(chalk.gray("  Run 'oh auth login --api-key <key>' to authenticate."));
      }
    });

  cmd
    .command("logout")
    .description("Clear stored credentials")
    .action(async () => {
      const chalk = (await import("chalk")).default;
      console.log(chalk.green("Credentials cleared."));
      console.log(chalk.gray("Note: Environment variable keys are not cleared automatically."));
    });

  return cmd;
}

function guessProviderFromKey(key: string): string {
  if (key.startsWith("sk-ant-")) return "anthropic";
  if (key.startsWith("sk-")) return "openai";
  return "unknown";
}
