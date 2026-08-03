import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { Command } from "commander";

import {
  daemonPidAlive,
  probeDaemonRegistry,
  terminateDaemonProcess,
} from "../daemon-lifecycle.js";
import { VERSION } from "../version.js";

interface ServeOptions {
  host?: string;
  port?: number;
  token?: string;
  allowOrigin?: string[];
  storePath?: string;
  register?: boolean;
}

export function isLoopbackHost(host: string | undefined): boolean {
  const normalized = (host ?? "127.0.0.1").trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function assertSafeDaemonBinding(options: Pick<ServeOptions, "host" | "token">): void {
  if (!isLoopbackHost(options.host) && !options.token) {
    throw new Error("A non-loopback daemon requires an explicit --token");
  }
}

async function runServe(options: ServeOptions): Promise<void> {
  const {
    clearDaemonRegistry,
    createBearerToken,
    readDaemonRegistry,
    startOpenHarnessServer,
    writeDaemonRegistry,
  } = await import("@openharness/server");
  const { loadSettings } = await import("@openharness/core");
  const { createCliSessionRuntimeFactory } = await import("../session-runtime.js");
  const { createCliCommandCatalog } = await import("../command-catalog.js");
  const {
    createCliAgentPersonaService,
    createCliAuthService,
    createCliContextService,
    createCliDreamService,
    createCliGitService,
    createCliHooksService,
    createCliMemoryService,
    createCliOutputStyleService,
    createCliPluginService,
    createCliProfileService,
    createCliProjectInitService,
    createCliProviderService,
    createCliSettingsService,
  } = await import("../daemon-services.js");

  assertSafeDaemonBinding(options);
  const token = options.token ?? createBearerToken();
  const settings = await loadSettings({});
  const settingsRef = { current: settings };
  const { server, listen } = await startOpenHarnessServer({
    host: options.host,
    port: options.port,
    token,
    allowedOrigins: options.allowOrigin,
    storePath: options.storePath,
    runtimeFactory: createCliSessionRuntimeFactory({
      settings,
      getSettings: () => settingsRef.current,
    }),
    commandCatalog: createCliCommandCatalog(() => settingsRef.current),
    settingsService: createCliSettingsService(settingsRef),
    providerService: createCliProviderService(settingsRef),
    memoryService: createCliMemoryService(),
    authService: createCliAuthService(),
    contextService: createCliContextService(settingsRef),
    dreamService: createCliDreamService(settingsRef),
    profileService: createCliProfileService(),
    outputStyleService: createCliOutputStyleService(),
    projectInitService: createCliProjectInitService(),
    pluginService: createCliPluginService(settingsRef),
    agentPersonaService: createCliAgentPersonaService(),
    hooksService: createCliHooksService(settingsRef),
    gitService: createCliGitService(),
    version: VERSION,
  });

  if (options.register) {
    writeDaemonRegistry({
      url: listen.url,
      pid: process.pid,
      token,
      storePath: server.store.path,
      startedAt: Date.now(),
      version: VERSION,
    });
  }

  console.log(`[daemon] listening ${listen.url}`);
  if (options.register) console.log("[daemon] registry written");

  await new Promise<void>((resolve) => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      void (async () => {
        await server.close();
        const registry = readDaemonRegistry();
        if (registry?.pid === process.pid) clearDaemonRegistry();
        resolve();
      })();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

export function createServeCommand(): Command {
  return new Command("serve")
    .description("Start the OpenHarness daemon/server runtime in the foreground")
    .option("--host <host>", "Host to bind", "127.0.0.1")
    .option("--port <port>", "Port to bind", (value) => Number.parseInt(value, 10), 0)
    .option("--token <token>", "Bearer token; generated when omitted")
    .option("--allow-origin <origin...>", "Allow browser requests from exact origin(s)")
    .option("--store-path <path>", "Session store path")
    .option("--register", "Write daemon registry for clients to attach")
    .action(async (options: ServeOptions) => {
      await runServe(options);
    });
}

export function createDaemonCommand(): Command {
  const cmd = new Command("daemon").description("Manage the OpenHarness daemon/server runtime");

  cmd
    .command("start")
    .description("Start the daemon in the background")
    .option("--host <host>", "Host to bind", "127.0.0.1")
    .option("--port <port>", "Port to bind", (value) => Number.parseInt(value, 10), 0)
    .option("--token <token>", "Bearer token; generated when omitted")
    .option("--allow-origin <origin...>", "Allow browser requests from exact origin(s)")
    .option("--store-path <path>", "Session store path")
    .action(async (options: ServeOptions) => {
      assertSafeDaemonBinding(options);
      const { clearDaemonRegistry, readDaemonRegistry } = await import("@openharness/server");
      const entry = process.argv[1];
      if (!entry) {
        console.error("Cannot locate CLI entrypoint.");
        process.exit(1);
      }
      const probeOptions = { expectedVersion: VERSION, minimumStartedAt: statSync(entry).mtimeMs };
      const existing = readDaemonRegistry();
      const existingStatus = existing ? await probeDaemonRegistry(existing, probeOptions) : "unreachable";
      if (existing && existingStatus === "ready") {
        console.log(`Daemon already running at ${existing.url} (PID: ${existing.pid})`);
        return;
      }
      if (existing && existingStatus === "stale") terminateDaemonProcess(existing.pid);
      clearDaemonRegistry();

      const args = [...process.execArgv, entry, "serve", "--register", "--host", options.host ?? "127.0.0.1"];
      if (options.port !== undefined) args.push("--port", String(options.port));
      if (options.token) args.push("--token", options.token);
      for (const origin of options.allowOrigin ?? []) args.push("--allow-origin", origin);
      if (options.storePath) args.push("--store-path", options.storePath);

      const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
      await new Promise((resolve) => setTimeout(resolve, 500));

      const registry = readDaemonRegistry();
      if (registry && await probeDaemonRegistry(registry, probeOptions) === "ready") {
        console.log(`Daemon started at ${registry.url} (PID: ${registry.pid})`);
      } else {
        console.log(`Daemon spawned (PID: ${child.pid ?? "unknown"}); registry not ready yet.`);
      }
    });

  cmd
    .command("status")
    .description("Show daemon status")
    .action(async () => {
      const { readDaemonRegistry } = await import("@openharness/server");
      const registry = readDaemonRegistry();
      if (!registry) {
        console.log("Daemon: stopped");
        return;
      }
      const entry = process.argv[1];
      const probe = await probeDaemonRegistry(registry, {
        expectedVersion: VERSION,
        ...(entry ? { minimumStartedAt: statSync(entry).mtimeMs } : {}),
      });
      console.log(`Daemon: ${probe} (PID: ${registry.pid})`);
      console.log(`URL: ${registry.url}`);
      console.log(`Store: ${registry.storePath}`);
      console.log(`Version: ${registry.version}`);
    });

  cmd
    .command("stop")
    .description("Stop the daemon")
    .action(async () => {
      const { clearDaemonRegistry, readDaemonRegistry } = await import("@openharness/server");
      const registry = readDaemonRegistry();
      if (!registry) {
        console.log("Daemon is not running.");
        return;
      }
      if (daemonPidAlive(registry.pid)) {
        terminateDaemonProcess(registry.pid);
        console.log(`Daemon stopped (PID: ${registry.pid})`);
      } else {
        console.log(`Daemon registry was stale (PID: ${registry.pid})`);
      }
      clearDaemonRegistry();
    });

  return cmd;
}
