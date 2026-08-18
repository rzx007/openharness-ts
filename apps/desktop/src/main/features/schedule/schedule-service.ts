import type { OpenHarnessClient } from "@openharness/client"
import type {
  DesktopScheduledRun,
  DesktopScheduledStatus,
  DesktopScheduledTask,
  ListDesktopScheduledRunsInput,
  UpdateDesktopScheduledTaskInput,
} from "../../../shared/schedule-types"

import { desktopSessionService } from "../session/session-service"

class DesktopScheduleService {
  status(): Promise<DesktopScheduledStatus> {
    return withDaemonRetry((client) => client.getScheduledTaskStatus())
  }

  list(): Promise<DesktopScheduledTask[]> {
    return withDaemonRetry((client) => client.listScheduledTasks())
  }

  update(id: string, input: UpdateDesktopScheduledTaskInput): Promise<DesktopScheduledTask> {
    return withDaemonRetry((client) => client.updateScheduledTask(id, input))
  }

  async remove(id: string): Promise<void> {
    await withDaemonRetry((client) => client.removeScheduledTask(id))
  }

  runNow(id: string): Promise<DesktopScheduledRun> {
    return withDaemonRetry((client) => client.triggerScheduledTask(id))
  }

  listRuns(input: ListDesktopScheduledRunsInput): Promise<DesktopScheduledRun[]> {
    return withDaemonRetry((client) => client.listScheduledRuns(input))
  }

  setRunUnread(id: string, unread: boolean): Promise<DesktopScheduledRun> {
    return withDaemonRetry((client) => client.setScheduledRunUnread(id, unread))
  }
}

export const desktopScheduleService = new DesktopScheduleService()

async function withDaemonRetry<T>(
  operation: (client: OpenHarnessClient) => Promise<T>
): Promise<T> {
  try {
    return await operation(await desktopSessionService.daemonClient())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (
      !message.includes("Failed to fetch") &&
      !message.includes("ECONNREFUSED") &&
      !message.includes("ECONNRESET")
    ) {
      throw error
    }
    return await operation(await desktopSessionService.refreshDaemonClient())
  }
}
