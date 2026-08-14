import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

import { app } from 'electron'

import type { PetPosition } from '../../../shared/ipc-channels'

interface PetPreferences {
  alwaysOnTop: boolean
  ignoreMouseEvents: boolean
  position: PetPosition | null
}

const defaults: PetPreferences = {
  alwaysOnTop: true,
  ignoreMouseEvents: false,
  position: null
}

export function getPetPreferences(): PetPreferences {
  const filePath = getPetPreferencesPath()
  if (!existsSync(filePath)) return defaults

  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<PetPreferences>
    return {
      alwaysOnTop: typeof raw.alwaysOnTop === 'boolean' ? raw.alwaysOnTop : defaults.alwaysOnTop,
      ignoreMouseEvents:
        typeof raw.ignoreMouseEvents === 'boolean'
          ? raw.ignoreMouseEvents
          : defaults.ignoreMouseEvents,
      position: isPetPosition(raw.position) ? raw.position : defaults.position
    }
  } catch {
    return defaults
  }
}

export function patchPetPreferences(patch: Partial<PetPreferences>): PetPreferences {
  const next = { ...getPetPreferences(), ...patch }
  const filePath = getPetPreferencesPath()

  try {
    writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8')
  } catch (error) {
    console.warn('[pet] failed to persist preferences', error)
  }

  return next
}

function getPetPreferencesPath(): string {
  return join(app.getPath('userData'), 'desktop-pet.json')
}

function isPetPosition(value: unknown): value is PetPosition {
  if (!value || typeof value !== 'object') return false
  const position = value as Partial<PetPosition>
  return typeof position.x === 'number' && typeof position.y === 'number'
}
