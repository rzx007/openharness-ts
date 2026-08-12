import { loadSettings, saveSettings } from "@openharness/core";

import {
  createDaemonSystemService,
  type DaemonSystemService,
  type DaemonSystemServiceState,
} from "./daemon-system-service.js";

export type DaemonAutoStartAction = "none" | "installed" | "started" | "uninstalled";

export interface DaemonAutoStartReconciliation {
  service: DaemonSystemService;
  state: DaemonSystemServiceState;
  action: DaemonAutoStartAction;
}

export async function loadDaemonAutoStart(): Promise<boolean> {
  return (await loadSettings()).daemon?.autoStart ?? false;
}

export async function saveDaemonAutoStart(autoStart: boolean): Promise<void> {
  const settings = await loadSettings();
  await saveSettings({
    ...settings,
    daemon: { ...settings.daemon, autoStart },
  });
}

export function reconcileDaemonAutoStart(
  entry: string,
  autoStart: boolean,
  serveArgs?: string[],
): DaemonAutoStartReconciliation {
  const service = createDaemonSystemService(entry, serveArgs);
  const state = service.status().state;

  if (!autoStart) {
    if (state === "not-installed") return { service, state, action: "none" };
    service.uninstall();
    return { service, state: "not-installed", action: "uninstalled" };
  }

  if (state === "not-installed") {
    service.install();
    return { service, state: "running", action: "installed" };
  }
  if (state === "stopped") {
    service.start();
    return { service, state: "running", action: "started" };
  }
  return { service, state, action: "none" };
}
