import { spawn } from "node:child_process"

import {
  clearDaemonRegistry,
  createBearerToken,
  readDaemonRegistry,
  startOpenHarnessDaemon,
  writeDaemonRegistry,
  shouldStartManagedDaemon,
} from "@openharness/server/daemon-host"
import { app } from "electron"

export type DesktopDaemonMode = "service" | "watchdog"

export function resolveDesktopDaemonMode(argv: readonly string[]): DesktopDaemonMode | null {
  if (argv.includes("--daemon-service")) return "service"
  if (argv.includes("--daemon-watchdog")) return "watchdog"
  return null
}

export async function runDesktopDaemonEntry(mode: DesktopDaemonMode): Promise<void> {
  if (mode === "watchdog") {
    if (await registeredDaemonHealthy()) return
    if (!(await shouldStartManagedDaemon())) return
    const args = app.isPackaged ? ["--daemon-service"] : [app.getAppPath(), "--daemon-service"]
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    })
    child.unref()
    return
  }

  while (await registeredDaemonHealthy()) {
    await delay(2_000)
  }
  clearDaemonRegistry()
  const token = createBearerToken()
  const { server, listen } = await startOpenHarnessDaemon({
    host: "127.0.0.1",
    port: 0,
    token,
    version: app.getVersion(),
    executionSurface: "desktop_managed",
  })
  writeDaemonRegistry({
    url: listen.url,
    pid: process.pid,
    token,
    storePath: server.store.path,
    startedAt: Date.now(),
    version: app.getVersion(),
  })

  await new Promise<void>((resolve) => {
    const close = (): void => {
      clearDaemonRegistry()
      void server.close().finally(resolve)
    }
    process.once("SIGINT", close)
    process.once("SIGTERM", close)
  })
}

async function registeredDaemonHealthy(): Promise<boolean> {
  const registry = readDaemonRegistry()
  if (!registry) return false
  try {
    const response = await fetch(`${registry.url}/health`, {
      headers: { authorization: `Bearer ${registry.token}` },
      signal: AbortSignal.timeout(1_500),
    })
    return response.ok
  } catch {
    return false
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
