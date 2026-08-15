import { clipboard } from "electron"

import { IpcChannels } from "../../../shared/ipc-channels"
import type { IpcContribution } from "../../core/ipc/types"

export const clipboardIpcContribution: IpcContribution = {
  id: "clipboard",
  register() {
    return [
      {
        channel: IpcChannels.clipboardReadText,
        handler: () => clipboard.readText(),
      },
      {
        channel: IpcChannels.clipboardWriteText,
        handler: (_event, text) => clipboard.writeText(String(text)),
      },
    ]
  },
}
