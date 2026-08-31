import { app, nativeImage, type BrowserWindow } from "electron"

const BADGE_SIZE = 16
const MAX_BADGE_LABEL = 9

interface BadgeWindow {
  isDestroyed(): boolean
  isFocused(): boolean
  setOverlayIcon(icon: unknown | null, description: string): void
}

interface AttentionBadgeDependencies {
  platform: NodeJS.Platform
  setBadgeCount(count: number): boolean
  createFromBitmap(
    bitmap: Buffer,
    options: { width: number; height: number; scaleFactor: number }
  ): unknown
}

export interface AttentionBadgeController {
  noteUnfocusedAttention(getMainWindow: () => BadgeWindow | null): void
  clearAttention(getMainWindow: () => BadgeWindow | null): void
  getUnreadCount(): number
  renderBadgeBitmap(label: string): Buffer
}

export function createAttentionBadgeController(
  dependencies: AttentionBadgeDependencies
): AttentionBadgeController {
  let unreadCount = 0

  const render = (window: BadgeWindow): void => {
    if (dependencies.platform === "darwin" || dependencies.platform === "linux") {
      dependencies.setBadgeCount(unreadCount)
      return
    }

    const label = unreadCount > MAX_BADGE_LABEL ? "9+" : String(unreadCount)
    const icon = dependencies.createFromBitmap(renderBadgeBitmap(label), {
      width: BADGE_SIZE,
      height: BADGE_SIZE,
      scaleFactor: 1,
    })
    window.setOverlayIcon(icon, `${unreadCount} 条未读通知`)
  }

  return {
    noteUnfocusedAttention(getMainWindow) {
      const window = getMainWindow()
      if (!window || window.isDestroyed() || window.isFocused()) return
      unreadCount += 1
      render(window)
    },
    clearAttention(getMainWindow) {
      unreadCount = 0
      if (dependencies.platform === "darwin" || dependencies.platform === "linux") {
        dependencies.setBadgeCount(0)
      }
      const window = getMainWindow()
      if (dependencies.platform === "win32" && window && !window.isDestroyed()) {
        window.setOverlayIcon(null, "")
      }
    },
    getUnreadCount: () => unreadCount,
    renderBadgeBitmap,
  }
}

const attentionBadge = createAttentionBadgeController({
  platform: process.platform,
  setBadgeCount: (count) => app.setBadgeCount(count),
  createFromBitmap: (bitmap, options) => nativeImage.createFromBitmap(bitmap, options),
})

export function noteUnfocusedAttention(getMainWindow: () => BrowserWindow | null): void {
  attentionBadge.noteUnfocusedAttention(() => adaptWindow(getMainWindow()))
}

export function clearAttention(getMainWindow: () => BrowserWindow | null): void {
  attentionBadge.clearAttention(() => adaptWindow(getMainWindow()))
}

function adaptWindow(window: BrowserWindow | null): BadgeWindow | null {
  if (!window) return null
  return {
    isDestroyed: () => window.isDestroyed(),
    isFocused: () => window.isFocused(),
    setOverlayIcon: (icon, description) =>
      window.setOverlayIcon(icon as Electron.NativeImage | null, description),
  }
}

const GLYPHS: Record<string, readonly string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  "+": ["010", "010", "111", "010", "010"],
}

function renderBadgeBitmap(label: string): Buffer {
  const bitmap = Buffer.alloc(BADGE_SIZE * BADGE_SIZE * 4)
  drawCircle(bitmap)

  const glyphs = [...label].map((character) => GLYPHS[character] ?? GLYPHS["0"])
  const scale = glyphs.length === 1 ? 2 : 1
  const gap = scale
  const width = glyphs.length * 3 * scale + (glyphs.length - 1) * gap
  const height = 5 * scale
  let startX = Math.floor((BADGE_SIZE - width) / 2)
  const startY = Math.floor((BADGE_SIZE - height) / 2)

  for (const glyph of glyphs) {
    drawGlyph(bitmap, glyph, startX, startY, scale)
    startX += 3 * scale + gap
  }
  return bitmap
}

function drawCircle(bitmap: Buffer): void {
  const center = (BADGE_SIZE - 1) / 2
  const radiusSquared = center * center
  for (let y = 0; y < BADGE_SIZE; y += 1) {
    for (let x = 0; x < BADGE_SIZE; x += 1) {
      const distanceSquared = (x - center) ** 2 + (y - center) ** 2
      if (distanceSquared > radiusSquared) continue
      setPixel(bitmap, x, y, 235, 84, 70, 255)
    }
  }
}

function drawGlyph(
  bitmap: Buffer,
  glyph: readonly string[],
  startX: number,
  startY: number,
  scale: number
): void {
  for (let row = 0; row < glyph.length; row += 1) {
    for (let column = 0; column < glyph[row].length; column += 1) {
      if (glyph[row][column] !== "1") continue
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          setPixel(
            bitmap,
            startX + column * scale + dx,
            startY + row * scale + dy,
            255,
            255,
            255,
            255
          )
        }
      }
    }
  }
}

function setPixel(
  bitmap: Buffer,
  x: number,
  y: number,
  red: number,
  green: number,
  blue: number,
  alpha: number
): void {
  const offset = (y * BADGE_SIZE + x) * 4
  bitmap[offset] = blue
  bitmap[offset + 1] = green
  bitmap[offset + 2] = red
  bitmap[offset + 3] = alpha
}
