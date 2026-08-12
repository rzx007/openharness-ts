import { resolve } from "node:path";

import { OpenHarnessClient, type CronRunRecord } from "@openharness/client";
import { Command } from "commander";

import { ensureLocalDaemon } from "../ensure-daemon.js";

async function connect(): Promise<{ client: OpenHarnessClient; pid: number }> {
  const daemon = await ensureLocalDaemon();
  return {
    client: new OpenHarnessClient({ baseUrl: daemon.url, token: daemon.token }),
    pid: daemon.pid,
  };
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function printRun(run: CronRunRecord, includeOutput = true): void {
  const finished = run.finishedAt ? new Date(run.finishedAt).toLocaleString() : "running";
  console.log(`  ${run.status.padEnd(11)} [${finished}] ${run.jobName} (${run.cause})`);
  if (includeOutput && run.output) {
    for (const line of run.output.split("\n")) console.log(`    ${line}`);
  }
}

export function createCronCommand(): Command {
  const cmd = new Command("cron").description("Manage daemon-hosted scheduled commands");

  cmd
    .command("add")
    .description("Add or update a scheduled command")
    .argument("<name>", "Unique job name")
    .argument("<expression>", 'Five-field cron expression, for example "0 9 * * 1-5"')
    .argument("<command>", "Shell command to run")
    .option("--cwd <dir>", "Working directory", process.cwd())
    .option("--timezone <tz>", 'IANA timezone, for example "Asia/Shanghai"')
    .option("--disabled", "Save without scheduling the job")
    .action(async (
      name: string,
      expression: string,
      command: string,
      options: { cwd: string; timezone?: string; disabled?: boolean },
    ) => {
      const { client } = await connect();
      const job = await client.saveCronJob(name, {
        expression,
        command,
        cwd: resolve(options.cwd),
        timezone: options.timezone,
        enabled: !options.disabled,
      });
      const next = job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "disabled";
      console.log(`Cron job '${job.name}' saved. Next run: ${next}`);
    });

  cmd
    .command("remove")
    .description("Remove a scheduled command")
    .argument("<name>", "Job name")
    .action(async (name: string) => {
      const { client } = await connect();
      await client.removeCronJob(name);
      console.log(`Cron job '${name}' removed.`);
    });

  cmd
    .command("status")
    .description("Show the main daemon and Cron status")
    .action(async () => {
      const { client, pid } = await connect();
      const status = await client.getCronStatus();
      console.log(`Main daemon: running (PID: ${pid})`);
      console.log(`Cron jobs: ${status.jobs} total, ${status.enabled} enabled, ${status.active} running now`);
    });

  cmd
    .command("list")
    .description("List scheduled commands")
    .action(async () => {
      const { client } = await connect();
      const jobs = await client.listCronJobs();
      if (jobs.length === 0) {
        console.log("No cron jobs configured.");
        return;
      }
      for (const job of jobs) {
        const next = job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "disabled";
        const timezone = job.timezone ? `, ${job.timezone}` : "";
        console.log(`  ${job.name}: ${job.expression}${timezone} (${job.enabled ? "enabled" : "disabled"})`);
        console.log(`    ${job.command}`);
        console.log(`    cwd=${job.cwd}, next=${next}`);
      }
    });

  cmd
    .command("toggle")
    .description("Enable or disable a scheduled command")
    .argument("<name>", "Job name")
    .argument("<state>", 'Either "on" or "off"')
    .action(async (name: string, state: string) => {
      if (state !== "on" && state !== "off") throw new Error('state must be either "on" or "off"');
      const { client } = await connect();
      const job = await client.setCronJobEnabled(name, state === "on");
      console.log(`Cron job '${name}' ${job.enabled ? "enabled" : "disabled"}.`);
    });

  cmd
    .command("run")
    .description("Run a scheduled command now")
    .argument("<name>", "Job name")
    .action(async (name: string) => {
      const { client } = await connect();
      const run = await client.triggerCronJob(name);
      printRun(run);
      if (run.status !== "succeeded") process.exitCode = 1;
    });

  cmd
    .command("history")
    .description("Show recent Cron runs")
    .argument("[name]", "Only show one job")
    .option("-n, --limit <n>", "Number of runs", "10")
    .action(async (name: string | undefined, options: { limit: string }) => {
      const { client } = await connect();
      const runs = await client.listCronRuns({ name, limit: positiveInteger(options.limit, "limit") });
      if (runs.length === 0) {
        console.log("No Cron runs recorded.");
        return;
      }
      for (const run of runs) printRun(run, false);
    });

  cmd
    .command("logs")
    .description("Show saved output from recent runs of one job")
    .argument("<name>", "Job name")
    .option("-n, --limit <n>", "Number of runs", "10")
    .action(async (name: string, options: { limit: string }) => {
      const { client } = await connect();
      const runs = await client.listCronRuns({ name, limit: positiveInteger(options.limit, "limit") });
      if (runs.length === 0) {
        console.log(`No runs recorded for '${name}'.`);
        return;
      }
      for (const run of runs) printRun(run);
    });

  return cmd;
}
