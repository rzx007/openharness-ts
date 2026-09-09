import { IpcChannels } from "../../../shared/ipc-channels"
import type {
  DesktopSkillRemoveInput,
  DesktopSkillSnapshotInput,
} from "../../../shared/skill-types"
import type { IpcContribution } from "../../core/ipc/types"
import { desktopSkillService } from "./skill-service"

export const skillIpcContribution: IpcContribution = {
  id: "skill",
  register() {
    return [
      {
        channel: IpcChannels.skillSnapshot,
        handler: (_event, input) =>
          desktopSkillService.snapshot(input as DesktopSkillSnapshotInput),
      },
      {
        channel: IpcChannels.skillRemove,
        handler: (_event, input) => desktopSkillService.remove(input as DesktopSkillRemoveInput),
      },
    ]
  },
}
