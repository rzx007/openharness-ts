import type {
  ScheduledRunRecord,
  ScheduledTaskRecord,
  ScheduledTaskStatusSummary,
  UpdateScheduledTaskInput,
} from "@openharness/client"

export type DesktopScheduledTask = ScheduledTaskRecord
export type DesktopScheduledRun = ScheduledRunRecord
export type DesktopScheduledStatus = ScheduledTaskStatusSummary
export type UpdateDesktopScheduledTaskInput = UpdateScheduledTaskInput

export interface ListDesktopScheduledRunsInput {
  taskId?: string
  unread?: boolean
  limit?: number
}
