import type { BrowserWindowConstructorOptions } from "electron"

export function mainWindowChromeOptions(
  platform: NodeJS.Platform
): Pick<BrowserWindowConstructorOptions, "frame" | "titleBarStyle" | "trafficLightPosition"> {
  if (platform === "darwin") {
    return {
      frame: true,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 11 },
    }
  }

  return { frame: false }
}
