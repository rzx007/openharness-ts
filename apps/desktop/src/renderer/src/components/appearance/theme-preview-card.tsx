import { Check } from "lucide-react"

import { cn } from "@renderer/lib/utils"

import type { AppearanceTheme } from "./appearance-preferences"

const THEME_LABELS: Record<AppearanceTheme, string> = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
}

export function ThemePreviewCard({
  theme,
  selected,
}: {
  theme: AppearanceTheme
  selected: boolean
}): React.JSX.Element {
  const dark = theme === "dark"
  const background = dark ? "#1B1B1B" : "#F7F7F7"
  const panel = dark ? "#F4F4F4" : "#FFFFFF"
  const sidebar = dark ? "#545454" : "#D9D9D9"
  const line = dark ? "#C7C7C7" : "#B8B8B8"

  return (
    <span className="flex w-full flex-col gap-2">
      <span
        aria-hidden="true"
        className="relative flex h-24 w-full overflow-hidden rounded-md border"
        style={{
          background:
            theme === "system"
              ? "linear-gradient(90deg, #F7F7F7 0 50%, #1B1B1B 50% 100%)"
              : background,
        }}
      >
        <span className="w-[32%] opacity-85" style={{ backgroundColor: sidebar }} />
        <span
          className="absolute right-2 bottom-0 left-[24%] h-[68%] rounded-t-md"
          style={{ backgroundColor: panel }}
        >
          <span
            className="mt-3 ml-3 block h-1.5 w-12 rounded-full"
            style={{ backgroundColor: line }}
          />
          <span
            className="mt-2 ml-3 block h-1.5 w-20 rounded-full opacity-60"
            style={{ backgroundColor: line }}
          />
          <span
            className="mt-2 ml-3 block h-1.5 w-14 rounded-full opacity-45"
            style={{ backgroundColor: line }}
          />
        </span>
      </span>
      <span className="flex items-center justify-between gap-2 text-sm">
        <span>{THEME_LABELS[theme]}</span>
        <Check
          aria-hidden="true"
          className={cn("transition-opacity", selected ? "opacity-100" : "opacity-0")}
        />
      </span>
    </span>
  )
}
