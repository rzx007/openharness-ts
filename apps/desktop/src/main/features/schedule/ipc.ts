import { IpcChannels } from "../../../shared/ipc-channels"
import type {
  CreateDesktopScheduledTaskInput,
  ListDesktopScheduledRunsInput,
  UpdateDesktopScheduledTaskInput,
} from "../../../shared/schedule-types"
import type { IpcContribution } from "../../core/ipc/types"
import { desktopScheduleService } from "./schedule-service"

export const scheduleIpcContribution: IpcContribution = {
  id: "schedule",
  register() {
    return [
      { channel: IpcChannels.scheduleStatus, handler: () => desktopScheduleService.status() },
      { channel: IpcChannels.scheduleList, handler: () => desktopScheduleService.list() },
      {
        channel: IpcChannels.scheduleCreate,
        handler: (_event, input) =>
          desktopScheduleService.create(input as CreateDesktopScheduledTaskInput),
      },
      {
        channel: IpcChannels.scheduleUpdate,
        handler: (_event, id, input) =>
          desktopScheduleService.update(String(id), input as UpdateDesktopScheduledTaskInput),
      },
      {
        channel: IpcChannels.scheduleRemove,
        handler: (_event, id) => desktopScheduleService.remove(String(id)),
      },
      {
        channel: IpcChannels.scheduleRunNow,
        handler: (_event, id) => desktopScheduleService.runNow(String(id)),
      },
      {
        channel: IpcChannels.scheduleListRuns,
        handler: (_event, input) =>
          desktopScheduleService.listRuns(input as ListDesktopScheduledRunsInput),
      },
      {
        channel: IpcChannels.scheduleSetRunUnread,
        handler: (_event, id, unread) =>
          desktopScheduleService.setRunUnread(String(id), Boolean(unread)),
      },
    ]
  },
}
