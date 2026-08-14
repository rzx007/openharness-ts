import { BrowserWindow, screen } from 'electron'

import type { PetState } from '../../../shared/ipc-channels'
import type { AppContext } from '../../core/app-context'
import { getPetPreferences, patchPetPreferences } from './pet-preferences'

const PET_WIDTH = 220
const PET_HEIGHT = 220
const PET_MARGIN = 28
const TRANSPARENT_BACKGROUND = '#00000000'

export function createPetWindow(ctx: AppContext): BrowserWindow {
  const existing = ctx.windowManager.get('pet')
  if (existing) return existing

  const preferences = getPetPreferences()
  const win = ctx.windowManager.createWindow({
    id: 'pet',
    route: '/pet',
    paths: ctx.paths,
    options: {
      width: PET_WIDTH,
      height: PET_HEIGHT,
      title: 'OpenHarness Pet',
      frame: false,
      transparent: true,
      backgroundColor: TRANSPARENT_BACKGROUND,
      alwaysOnTop: preferences.alwaysOnTop,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false
    },
    onCreated: (petWindow) => {
      petWindow.setBackgroundColor(TRANSPARENT_BACKGROUND)
      petWindow.setIgnoreMouseEvents(preferences.ignoreMouseEvents, { forward: true })
      petWindow.on('moved', () => persistPetPosition(petWindow))
      petWindow.on('closed', () => persistPetPosition(petWindow))
    }
  })

  win.hide()
  return win
}

export function showPetWindow(ctx: AppContext): void {
  const win = ctx.windowManager.get('pet') ?? createPetWindow(ctx)
  const preferences = getPetPreferences()
  const position = clampPetPosition(preferences.position ?? getDefaultPetPosition())

  win.setBounds({ ...position, width: PET_WIDTH, height: PET_HEIGHT }, false)
  win.setAlwaysOnTop(preferences.alwaysOnTop)
  win.setIgnoreMouseEvents(preferences.ignoreMouseEvents, { forward: true })
  win.show()
}

export function hidePetWindow(ctx: AppContext): void {
  ctx.windowManager.get('pet')?.hide()
}

export function togglePetWindow(ctx: AppContext): PetState {
  const win = ctx.windowManager.get('pet') ?? createPetWindow(ctx)
  if (win.isVisible()) {
    win.hide()
  } else {
    showPetWindow(ctx)
  }

  return getPetState(ctx)
}

export function setPetAlwaysOnTop(ctx: AppContext, value: boolean): PetState {
  patchPetPreferences({ alwaysOnTop: value })
  const win = ctx.windowManager.get('pet')
  win?.setAlwaysOnTop(value)
  return getPetState(ctx)
}

export function setPetIgnoreMouseEvents(ctx: AppContext, value: boolean): PetState {
  patchPetPreferences({ ignoreMouseEvents: value })
  const win = ctx.windowManager.get('pet')
  win?.setIgnoreMouseEvents(value, { forward: true })
  return getPetState(ctx)
}

export function getPetState(ctx: AppContext): PetState {
  const win = ctx.windowManager.get('pet')
  const preferences = getPetPreferences()
  const bounds = win && !win.isDestroyed() ? win.getBounds() : null

  return {
    visible: Boolean(win?.isVisible()),
    alwaysOnTop: preferences.alwaysOnTop,
    ignoreMouseEvents: preferences.ignoreMouseEvents,
    position: bounds ? { x: bounds.x, y: bounds.y } : preferences.position
  }
}

export function syncPetWithMainWindow(ctx: AppContext, mainWindow: BrowserWindow): void {
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
    hidePetWindow(ctx)
  }
}

function persistPetPosition(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const bounds = win.getBounds()
  patchPetPreferences({ position: { x: bounds.x, y: bounds.y } })
}

function getDefaultPetPosition(): { x: number; y: number } {
  const display = screen.getPrimaryDisplay()
  return {
    x: display.workArea.x + display.workArea.width - PET_WIDTH - PET_MARGIN,
    y: display.workArea.y + display.workArea.height - PET_HEIGHT - PET_MARGIN
  }
}

function clampPetPosition(position: { x: number; y: number }): { x: number; y: number } {
  const display = screen.getDisplayNearestPoint(position)
  const minX = display.workArea.x
  const minY = display.workArea.y
  const maxX = display.workArea.x + display.workArea.width - PET_WIDTH
  const maxY = display.workArea.y + display.workArea.height - PET_HEIGHT

  return {
    x: Math.min(Math.max(position.x, minX), maxX),
    y: Math.min(Math.max(position.y, minY), maxY)
  }
}
