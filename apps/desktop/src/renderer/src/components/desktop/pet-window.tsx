import { EyeOff } from "lucide-react"
import { useEffect, useState } from "react"

import { Button } from "@renderer/components/ui/button"

export function PetWindow(): React.JSX.Element {
  const [time, setTime] = useState(() => new Date().toLocaleTimeString())

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTime(new Date().toLocaleTimeString())
    }, 1000)

    return () => window.clearInterval(timer)
  }, [])

  return (
    <main className="grid h-screen w-screen place-items-center bg-transparent">
      <section
        className="titlebar-drag flex min-h-24 w-48 items-center gap-3 rounded-xl bg-background/95 p-3 text-foreground shadow-lg ring-1 ring-black/8 backdrop-blur"
        aria-label="OpenHarness 桌面宠物"
      >
        <div className="grid size-11 place-items-center rounded-lg bg-foreground text-sm font-bold text-background">
          OH
        </div>
        <div className="min-w-0">
          <strong className="block truncate text-sm font-semibold">OpenHarness</strong>
          <span className="block text-xs text-ui-muted">{time}</span>
        </div>
      </section>

      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="titlebar-no-drag fixed right-4 bottom-4 shadow-sm"
        onClick={() => void window.desktop.pet.hide()}
      >
        <EyeOff />
        隐藏
      </Button>
    </main>
  )
}
