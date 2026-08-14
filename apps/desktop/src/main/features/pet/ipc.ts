import { IpcChannels } from '../../../shared/ipc-channels'
import type { IpcContribution } from '../../core/ipc/types'
import {
  getPetState,
  hidePetWindow,
  setPetAlwaysOnTop,
  setPetIgnoreMouseEvents,
  showPetWindow,
  togglePetWindow
} from './window'

export const petIpcContribution: IpcContribution = {
  id: 'pet',
  register(ctx) {
    return [
      {
        channel: IpcChannels.petShow,
        handler: () => showPetWindow(ctx)
      },
      {
        channel: IpcChannels.petHide,
        handler: () => hidePetWindow(ctx)
      },
      {
        channel: IpcChannels.petToggle,
        handler: () => togglePetWindow(ctx)
      },
      {
        channel: IpcChannels.petGetState,
        handler: () => getPetState(ctx)
      },
      {
        channel: IpcChannels.petSetAlwaysOnTop,
        handler: (_event, value) => setPetAlwaysOnTop(ctx, value === true)
      },
      {
        channel: IpcChannels.petSetIgnoreMouseEvents,
        handler: (_event, value) => setPetIgnoreMouseEvents(ctx, value === true)
      }
    ]
  }
}
