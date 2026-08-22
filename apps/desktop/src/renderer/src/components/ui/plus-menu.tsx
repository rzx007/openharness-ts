import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"
import { IconPlus } from "@tabler/icons-react"
import { Liquid } from "liquid-gooey"

import { Button } from "@renderer/components/ui/button"
import { cn } from "@renderer/lib/utils"

const DEFAULT_OPEN = { duration: 550, ease: "cubic-bezier(0.34, 1.56, 0.64, 1)", stagger: 40 }
const DEFAULT_CLOSE = { duration: 250, ease: "cubic-bezier(0.22, 1, 0.36, 1)", stagger: 0 }
const STAGE = { width: 176, height: 160 }

const OFFICIAL_TRIPLET = [
  { x: -38, y: -24 },
  { x: 0, y: -45 },
  { x: 38, y: -24 },
] as const

export type PlusMenuItem = {
  id?: string
  label: string
  icon: ReactNode
  x?: number
  y?: number
  disabled?: boolean
}

export type PlusMenuMotion = {
  openDuration?: number
  openEase?: string
  openStagger?: number
  closeDuration?: number
  closeEase?: string
  closeStagger?: number
  iconFade?: number
  iconDelay?: number
  anticipationDistance?: number
  anticipationDuration?: number
}

export type PlusMenuSelectEvent = {
  item: PlusMenuItem
  index: number
  event: MouseEvent<HTMLButtonElement>
}

export type PlusMenuTriggerEvent = {
  open: boolean
  event: MouseEvent<HTMLButtonElement>
}

export type PlusMenuProps = {
  items: PlusMenuItem[]
  open?: boolean
  defaultOpen?: boolean
  disabled?: boolean
  closeOnSelect?: boolean
  radius?: number
  trigger?: ReactNode
  triggerLabel?: { open: string; closed: string }
  motion?: PlusMenuMotion
  className?: string
  itemClassName?: string
  triggerClassName?: string
  blur?: number
  contrast?: number
  fill?: string
  shadow?: string
  onOpenChange?: (open: boolean) => void
  onOpen?: () => void
  onClose?: () => void
  onSelect?: (payload: PlusMenuSelectEvent) => void
  onTriggerClick?: (payload: PlusMenuTriggerEvent) => void
}

function itemOffset(index: number, count: number, radius: number): { x: number; y: number } {
  if (count === 3) return OFFICIAL_TRIPLET[index] ?? { x: 0, y: -radius }
  if (count <= 1) return { x: 0, y: -radius }
  const start = (-Math.PI * 3) / 4
  const end = -Math.PI / 4
  const angle = start + ((end - start) * index) / (count - 1)
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}

function TriggerButton({
  open,
  disabled,
  trigger,
  triggerLabel,
  className,
  onClick,
}: {
  open: boolean
  disabled: boolean
  trigger?: ReactNode
  triggerLabel: { open: string; closed: string }
  className?: string
  onClick: (event: MouseEvent<HTMLButtonElement>) => void
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className={cn("rounded-full", className)}
      aria-expanded={open}
      aria-haspopup="menu"
      aria-label={open ? triggerLabel.open : triggerLabel.closed}
      disabled={disabled}
      onClick={onClick}
    >
      <span className={cn("inline-flex transition-transform duration-200", open && "rotate-45")}>
        {trigger ?? <IconPlus className="size-5" />}
      </span>
    </Button>
  )
}

function PlusMenu({
  items,
  open: openProp,
  defaultOpen = false,
  disabled = false,
  closeOnSelect = true,
  radius = 45,
  trigger,
  triggerLabel = { open: "Close menu", closed: "Open menu" },
  motion,
  className,
  itemClassName,
  triggerClassName,
  blur = 6,
  contrast = 18,
  fill = "var(--popover)",
  shadow = "0 8px 24px color-mix(in oklch, var(--foreground) 12%, transparent)",
  onOpenChange,
  onOpen,
  onClose,
  onSelect,
  onTriggerClick,
}: PlusMenuProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
  const open = openProp ?? uncontrolledOpen
  const [mounted, setMounted] = useState(open)
  const [expanded, setExpanded] = useState(open)
  const [stage, setStage] = useState<{ left: number; top: number } | null>(null)
  const slotRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const expandFrame = useRef<number>(0)

  const openDuration = motion?.openDuration ?? DEFAULT_OPEN.duration
  const openEase = motion?.openEase ?? DEFAULT_OPEN.ease
  const openStagger = motion?.openStagger ?? DEFAULT_OPEN.stagger
  const closeDuration = motion?.closeDuration ?? DEFAULT_CLOSE.duration
  const closeEase = motion?.closeEase ?? DEFAULT_CLOSE.ease
  const closeStagger = motion?.closeStagger ?? DEFAULT_CLOSE.stagger
  const iconFade = motion?.iconFade ?? 180
  const iconDelay = motion?.iconDelay ?? 120

  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current)
      cancelAnimationFrame(expandFrame.current)
    },
    []
  )

  useLayoutEffect(() => {
    const slot = slotRef.current
    if (!slot) return

    const sync = () => {
      const rect = slot.getBoundingClientRect()
      setStage({
        left: rect.left + rect.width / 2 - STAGE.width / 2,
        top: rect.bottom - STAGE.height,
      })
    }

    sync()
    if (!mounted) return
    window.addEventListener("scroll", sync, true)
    window.addEventListener("resize", sync)
    return () => {
      window.removeEventListener("scroll", sync, true)
      window.removeEventListener("resize", sync)
    }
  }, [mounted])

  useLayoutEffect(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    cancelAnimationFrame(expandFrame.current)

    if (open) {
      setMounted(true)
      setExpanded(false)
      expandFrame.current = requestAnimationFrame(() => {
        expandFrame.current = requestAnimationFrame(() => setExpanded(true))
      })
      return
    }

    setExpanded(false)
    const wait = closeDuration + closeStagger * Math.max(0, items.length - 1) + 80
    closeTimer.current = setTimeout(() => setMounted(false), wait)
  }, [open, closeDuration, closeStagger, items.length])

  const changeOpen = (next: boolean) => {
    if (disabled || next === open) return
    if (openProp === undefined) setUncontrolledOpen(next)
    onOpenChange?.(next)
    if (next) onOpen?.()
    else onClose?.()
  }

  const handleTriggerClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (disabled) return
    const next = !open
    onTriggerClick?.({ open: next, event })
    if (event.defaultPrevented) return
    changeOpen(next)
  }

  const handleSelect = (
    item: PlusMenuItem,
    index: number,
    event: MouseEvent<HTMLButtonElement>
  ) => {
    if (disabled || item.disabled) return
    onSelect?.({ item, index, event })
    if (event.defaultPrevented) return
    if (closeOnSelect && open) {
      changeOpen(false)
    }
  }

  const stagger = expanded ? openStagger : closeStagger
  const transition = expanded
    ? motion?.openDuration
      ? { duration: openDuration, ease: openEase }
      : ("bouncy" as const)
    : { duration: closeDuration, ease: closeEase }

  const menu =
    mounted && stage
      ? createPortal(
          <Liquid
            data-slot="plus-menu"
            data-open={expanded ? "" : undefined}
            blur={blur}
            contrast={contrast}
            fill={fill}
            shadow={shadow}
            filterPadding={32}
            className={cn("plus-menu-stage", className)}
            style={{
              position: "fixed",
              left: stage.left,
              top: stage.top,
              width: STAGE.width,
              height: STAGE.height,
              zIndex: 50,
              pointerEvents: "none",
            }}
          >
            {items.map((item, index) => {
              const offset = itemOffset(index, items.length, radius)
              const x = item.x ?? offset.x
              const y = item.y ?? offset.y
              return (
                <Liquid.Item
                  key={item.id ?? item.label}
                  className="pointer-events-auto absolute bottom-0 left-1/2 ml-[-16px] size-8"
                  x={expanded ? x : 0}
                  y={expanded ? y : 0}
                  transition={transition}
                  delay={index * stagger}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={cn("rounded-full", expanded && "bg-popover", itemClassName)}
                    aria-label={item.label}
                    disabled={disabled || item.disabled}
                    onClick={(event) => handleSelect(item, index, event)}
                  >
                    <span
                      className={cn(
                        "inline-flex transition-opacity",
                        expanded ? "opacity-100" : "opacity-0"
                      )}
                      style={{
                        transitionDuration: `${iconFade}ms`,
                        transitionDelay: expanded ? `${iconDelay + index * stagger}ms` : "0ms",
                      }}
                    >
                      {item.icon}
                    </span>
                  </Button>
                </Liquid.Item>
              )
            })}
            <Liquid.Item className="pointer-events-none absolute bottom-0 left-1/2 ml-[-16px] size-8">
              <div className="size-8 rounded-full bg-popover" />
            </Liquid.Item>
          </Liquid>,
          document.body
        )
      : null

  return (
    <div ref={slotRef} className="relative z-[60] size-8 shrink-0">
      <TriggerButton
        open={open}
        disabled={disabled}
        trigger={trigger}
        triggerLabel={triggerLabel}
        className={triggerClassName}
        onClick={handleTriggerClick}
      />
      {menu}
    </div>
  )
}

export { PlusMenu }
