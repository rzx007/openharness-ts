import { describe, expect, it, vi } from "vitest"

import { IpcChannels } from "../../../shared/ipc-channels"
import type { DesktopUpdateState } from "../../../shared/update-types"
import { createUpdaterIpcContribution } from "./ipc"

describe("updater IPC contribution", () => {
  it("routes state, download, and install commands through the updater service", async () => {
    const state: DesktopUpdateState = { status: "available", version: "1.4.0" }
    const service = {
      getState: vi.fn(() => state),
      download: vi.fn(async () => undefined),
      install: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    }
    const contribution = createUpdaterIpcContribution({ service, broadcast: vi.fn() })
    const registrations = contribution.register({} as never)
    const handler = (channel: string) =>
      registrations.find((registration) => registration.channel === channel)!.handler

    expect(handler(IpcChannels.updateGetState)({} as never)).toEqual(state)
    await handler(IpcChannels.updateDownload)({} as never)
    await handler(IpcChannels.updateInstall)({} as never)

    expect(service.download).toHaveBeenCalledOnce()
    expect(service.install).toHaveBeenCalledOnce()
  })

  it("broadcasts only update state DTOs emitted by the service", () => {
    let subscriber: ((state: DesktopUpdateState) => void) | undefined
    const broadcast = vi.fn()
    const service = {
      getState: vi.fn((): DesktopUpdateState => ({ status: "idle" })),
      download: vi.fn(async () => undefined),
      install: vi.fn(),
      subscribe: vi.fn((listener: (state: DesktopUpdateState) => void) => {
        subscriber = listener
        return () => undefined
      }),
    }

    createUpdaterIpcContribution({ service, broadcast })
    subscriber!({ status: "downloaded", version: "2.0.0" })

    expect(broadcast).toHaveBeenCalledWith({ status: "downloaded", version: "2.0.0" })
  })
})
