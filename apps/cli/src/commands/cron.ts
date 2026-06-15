import { Command } from "commander";
import { join } from "node:path";
import { homedir } from "node:os";

const JOBS_PATH = join(homedir(), ".openharness", "cron_jobs.json");
const PID_PATH = join(homedir(), ".openharness", "cron.pid");
const HISTORY_PATH = join(homedir(), ".openharness", "cron_history.jsonl");
const LOG_DIR = join(homedir(), ".openharness", "cron_logs");

/** Returns the PID of the running daemon, or null if not running. */
async function getDaemonPid(): Promise<number | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    const pid = parseInt(await readFile(PID_PATH, "utf-8"), 10);
    if (isNaN(pid)) return null;
    try {
      process.kill(pid, 0); // throws if process doesn't exist
      return pid;
    } catch {
      return null; // stale PID
    }
  } catch {
    return null;
  }
}

export function createCronCommand(): Command {
  const cmd = new Command("cron").description("Manage cron jobs");

  // ── add ──────────────────────────────────────────────────────────────────

  cmd
    .command("add")
    .description("Add or update a cron job")
    .argument("<name>", "Job name (unique identifier)")
    .argument("<expression>", 'Cron expression, 5 fields e.g. "0 9 * * 1-5"')
    .argument("<command>", "Shell command to run")
    .option("--cwd <dir>", "Working directory for the command")
    .option("--timezone <tz>", 'IANA timezone, e.g. "Asia/Shanghai"')
    .option("--disabled", "Add job in disabled state")
    .action(async (name: string, expression: string, command: string, opts: { cwd?: string; timezone?: string; disabled?: boolean }) => {
      const { getCronScheduler, validateCronExpression } = await import("@openharness/services");

      if (!validateCronExpression(expression)) {
        console.error('Invalid cron expression. Requires 5 fields: "min hour dom month dow"');
        process.exit(1);
      }

      const scheduler = getCronScheduler();
      await scheduler.loadJobs(JOBS_PATH);

      const job = scheduler.upsertJob({
        name,
        expression,
        command,
        cwd: opts.cwd,
        timezone: opts.timezone,
        enabled: !opts.disabled,
      });

      await scheduler.saveJobs(JOBS_PATH);

      const tzNote = opts.timezone ? ` (${opts.timezone})` : "";
      const nextStr = job.nextRun ? new Date(job.nextRun).toLocaleString() : "unknown";
      console.log(`Cron job '${name}' saved. Next run: ${nextStr}${tzNote}`);
    });

  // ── remove ────────────────────────────────────────────────────────────────

  cmd
    .command("remove")
    .description("Remove a cron job")
    .argument("<name>", "Job name")
    .action(async (name: string) => {
      const { getCronScheduler } = await import("@openharness/services");
      const scheduler = getCronScheduler();
      await scheduler.loadJobs(JOBS_PATH);

      const ok = scheduler.deleteByName(name);
      if (!ok) {
        console.error(`Cron job not found: ${name}`);
        process.exit(1);
      }
      await scheduler.saveJobs(JOBS_PATH);
      console.log(`Cron job '${name}' removed.`);
    });

  // ── start ─────────────────────────────────────────────────────────────────

  cmd
    .command("start")
    .description("Start the cron daemon (spawns background process)")
    .action(async () => {
      const existing = await getDaemonPid();
      if (existing !== null) {
        console.log(`Cron daemon already running (PID: ${existing})`);
        return;
      }

      const { spawn } = await import("node:child_process");
      const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "cron", "daemon"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      // Give the daemon a moment to write its PID file
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      const pid = await getDaemonPid();
      if (pid) {
        console.log(`Cron daemon started (PID: ${pid})`);
      } else {
        console.log(`Cron daemon spawned (PID: ${child.pid ?? "unknown"})`);
      }
    });

  // ── stop ──────────────────────────────────────────────────────────────────

  cmd
    .command("stop")
    .description("Stop the cron daemon")
    .action(async () => {
      const pid = await getDaemonPid();
      if (pid === null) {
        console.log("Cron daemon is not running.");
        return;
      }
      try {
        process.kill(pid, "SIGTERM");
        const { unlink } = await import("node:fs/promises");
        await unlink(PID_PATH).catch(() => {});
        console.log(`Cron daemon stopped (PID: ${pid})`);
      } catch (err) {
        console.error(`Failed to stop daemon: ${err}`);
        process.exit(1);
      }
    });

  // ── daemon (internal, spawned by "start") ─────────────────────────────────

  cmd
    .command("daemon")
    .description("Run cron scheduler as a foreground daemon (used by 'start')")
    .action(async () => {
      const { getCronScheduler } = await import("@openharness/services");
      const { writeFile, unlink, mkdir } = await import("node:fs/promises");

      const scheduler = getCronScheduler();
      scheduler.setLogDir(LOG_DIR);

      // Write PID file so "start" and "stop" can track us.
      await mkdir(join(homedir(), ".openharness"), { recursive: true }).catch(() => {});
      await writeFile(PID_PATH, String(process.pid), "utf-8").catch(() => {});

      await scheduler.loadJobs(JOBS_PATH);
      const jobs = scheduler.listJobs();
      let started = 0;
      for (const job of jobs) {
        if (job.enabled) {
          scheduler.start(job.id);
          started++;
        }
      }

      console.log(`[cron-daemon] PID=${process.pid}, ${started} job(s) active`);

      const shutdown = async () => {
        scheduler.stopAll();
        await scheduler.saveHistory(HISTORY_PATH).catch(() => {});
        await unlink(PID_PATH).catch(() => {});
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown());
      process.on("SIGTERM", () => void shutdown());

      // Keep the process alive indefinitely.
      await new Promise<never>(() => {});
    });

  // ── status ────────────────────────────────────────────────────────────────

  cmd
    .command("status")
    .description("Show daemon and scheduler status")
    .action(async () => {
      const pid = await getDaemonPid();
      if (pid !== null) {
        console.log(`Cron daemon: running (PID: ${pid})`);
      } else {
        console.log("Cron daemon: stopped");
      }

      const { getCronScheduler } = await import("@openharness/services");
      const scheduler = getCronScheduler();
      await scheduler.loadJobs(JOBS_PATH);
      const jobs = scheduler.listJobs();
      const enabled = jobs.filter((j) => j.enabled).length;
      console.log(`Jobs: ${jobs.length} total, ${enabled} enabled`);
    });

  // ── list ──────────────────────────────────────────────────────────────────

  cmd
    .command("list")
    .description("List configured cron jobs")
    .action(async () => {
      const { getCronScheduler } = await import("@openharness/services");
      const scheduler = getCronScheduler();
      await scheduler.loadJobs(JOBS_PATH);
      const jobs = scheduler.listJobs();
      if (!jobs.length) {
        console.log("No cron jobs configured.");
        return;
      }
      for (const job of jobs) {
        const state = job.enabled ? "enabled" : "disabled";
        const tzNote = job.timezone ? ` [${job.timezone}]` : "";
        const next = job.nextRun ? ` next=${new Date(job.nextRun).toLocaleString()}` : "";
        console.log(`  ${job.name} [${job.expression}${tzNote}] ${state}${next}`);
        if (job.command) console.log(`    cmd: ${job.command}${job.cwd ? ` (cwd: ${job.cwd})` : ""}`);
      }
    });

  // ── toggle ────────────────────────────────────────────────────────────────

  cmd
    .command("toggle")
    .description("Enable or disable a cron job")
    .argument("<name>", "Job name")
    .argument("<state>", '"on" or "off"')
    .action(async (name: string, state: string) => {
      const { getCronScheduler } = await import("@openharness/services");
      const scheduler = getCronScheduler();
      await scheduler.loadJobs(JOBS_PATH);
      const enabled = state === "on";
      const job = scheduler.setEnabled(name, enabled);
      if (!job) {
        console.error(`Cron job not found: ${name}`);
        process.exit(1);
      }
      await scheduler.saveJobs(JOBS_PATH);
      console.log(`Cron job '${name}' ${enabled ? "enabled" : "disabled"}`);
    });

  // ── history ───────────────────────────────────────────────────────────────

  cmd
    .command("history")
    .description("Show recent cron job execution history")
    .option("-n, --limit <n>", "Number of entries to show", "10")
    .action(async (opts: { limit: string }) => {
      const { readFile } = await import("node:fs/promises");
      const limit = parseInt(opts.limit, 10);
      try {
        const raw = await readFile(HISTORY_PATH, "utf-8");
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
            console.log(`  ${status} [${ts}] ${entry.name ?? entry.job}${entry.output ? ": " + entry.output.slice(0, 120) : ""}`);
          } catch {
            console.log(`  ${line}`);
          }
        }
      } catch {
        console.log("No execution history.");
      }
    });

  // ── logs ──────────────────────────────────────────────────────────────────

  cmd
    .command("logs")
    .description("Show stdout/stderr log for a cron job")
    .argument("<name>", "Job name")
    .option("-n, --lines <n>", "Number of lines to show", "50")
    .action(async (name: string, opts: { lines: string }) => {
      const { readFile } = await import("node:fs/promises");
      const lines = parseInt(opts.lines, 10);
      const logPath = join(LOG_DIR, `${name}.log`);
      try {
        const raw = await readFile(logPath, "utf-8");
        const allLines = raw.trim().split("\n");
        const last = allLines.slice(-lines);
        if (!last.length) {
          console.log(`No logs for '${name}'.`);
          return;
        }
        for (const line of last) {
          console.log(line);
        }
      } catch {
        console.log(`No logs for '${name}'.`);
      }
    });

  return cmd;
}
