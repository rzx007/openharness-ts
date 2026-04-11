import { Command } from "commander";

export function createCronCommand(): Command {
  const cmd = new Command("cron").description("Manage cron jobs");

  cmd
    .command("start")
    .description("Start the cron scheduler daemon")
    .action(async () => {
      const { getCronScheduler } = await import("@openharness/services");
      const scheduler = getCronScheduler();
      const jobs = scheduler.listJobs();
      let started = 0;
      for (const job of jobs) {
        if (job.enabled && !job.running) {
          scheduler.start(job.id);
          started++;
        }
      }
      console.log(`Cron scheduler started (${started} jobs activated)`);
    });

  cmd
    .command("stop")
    .description("Stop the cron scheduler daemon")
    .action(async () => {
      const { getCronScheduler } = await import("@openharness/services");
      const scheduler = getCronScheduler();
      scheduler.stopAll();
      console.log("Cron scheduler stopped");
    });

  cmd
    .command("status")
    .description("Show scheduler status")
    .action(async () => {
      const { getCronScheduler } = await import("@openharness/services");
      const scheduler = getCronScheduler();
      const jobs = scheduler.listJobs();
      const running = jobs.filter((j) => j.running).length;
      const enabled = jobs.filter((j) => j.enabled).length;
      console.log(`Scheduler: ${running > 0 ? "running" : "stopped"}`);
      console.log(`Jobs: ${jobs.length} total, ${enabled} enabled, ${running} active`);
    });

  cmd
    .command("list")
    .description("List cron jobs")
    .action(async () => {
      const { getCronScheduler } = await import("@openharness/services");
      const scheduler = getCronScheduler();
      const jobs = scheduler.listJobs();
      if (!jobs.length) {
        console.log("No cron jobs configured.");
        return;
      }
      for (const job of jobs) {
        const state = job.enabled ? "enabled" : "disabled";
        const runState = job.running ? " [running]" : "";
        console.log(`  ${job.name} [${job.expression}] ${state}${runState} cmd=${job.command}`);
      }
    });

  cmd
    .command("toggle")
    .description("Enable or disable a cron job")
    .argument("<name>", "Job name")
    .argument("<state>", "on or off")
    .action(async (name: string, state: string) => {
      const { getCronScheduler } = await import("@openharness/services");
      const scheduler = getCronScheduler();
      const enabled = state === "on";
      const job = scheduler.setEnabled(name, enabled);
      if (!job) {
        console.error(`Cron job not found: ${name}`);
        process.exit(1);
      }
      console.log(`Cron job '${name}' ${enabled ? "enabled" : "disabled"}`);
    });

  cmd
    .command("history")
    .description("Show recent cron job execution history")
    .option("-n, --limit <n>", "Number of entries", "10")
    .action(async (opts: { limit: string }) => {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const limit = parseInt(opts.limit, 10);
      const historyPath = join(homedir(), ".openharness", "cron_history.jsonl");
      try {
        const raw = await readFile(historyPath, "utf-8");
        const lines = raw.trim().split("\n").filter(Boolean).slice(-limit);
        if (!lines.length) {
          console.log("No execution history.");
          return;
        }
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            const ts = new Date(entry.timestamp).toLocaleString();
            const status = entry.success ? "✓" : "✗";
            console.log(`  ${status} [${ts}] ${entry.name ?? entry.job}: ${entry.output ?? ""}`);
          } catch {
            console.log(`  ${line}`);
          }
        }
      } catch {
        console.log("No execution history.");
      }
    });

  cmd
    .command("logs")
    .description("Show logs for a cron job")
    .argument("<name>", "Job name")
    .option("-n, --lines <n>", "Number of lines", "50")
    .action(async (name: string, opts: { lines: string }) => {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const lines = parseInt(opts.lines, 10);
      const logPath = join(homedir(), ".openharness", "cron_logs", `${name}.log`);
      try {
        const raw = await readFile(logPath, "utf-8");
        const allLines = raw.trim().split("\n");
        const last = allLines.slice(-lines);
        if (!last.length) {
          console.log(`No logs for ${name}.`);
          return;
        }
        for (const line of last) {
          console.log(line);
        }
      } catch {
        console.log(`No logs for ${name}.`);
      }
    });

  return cmd;
}
