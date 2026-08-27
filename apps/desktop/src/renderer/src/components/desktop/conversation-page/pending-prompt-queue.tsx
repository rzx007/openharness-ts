import { CornerDownRight, GripVertical, Trash2 } from "lucide-react"

import { Button } from "@renderer/components/ui/button"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@renderer/components/ui/item"
import { Spinner } from "@renderer/components/ui/spinner"
import type { DesktopSessionInput, DesktopSessionRun } from "@shared/session-types"

interface PendingPrompt {
  input: DesktopSessionInput
  run: DesktopSessionRun
}

interface LocalPendingSubmission {
  id: string
  sessionId: string
  content: string
  phase: "submitting" | "accepted" | "failed"
  error?: string
}

export function PendingPromptQueue({
  prompts,
  activeRunId,
  actionId,
  localSubmission,
  onPromote,
  onCancel,
}: {
  prompts: PendingPrompt[]
  activeRunId?: string
  actionId: string | null
  localSubmission?: LocalPendingSubmission | null
  onPromote: (inputId: string, queuedRunId: string) => void
  onCancel: (inputId: string, queuedRunId: string) => void
}): React.JSX.Element | null {
  const visibleLocalSubmission =
    localSubmission &&
    localSubmission.phase !== "failed" &&
    !prompts.some(({ input }) => input.id === localSubmission.id)
      ? localSubmission
      : null
  if (prompts.length === 0 && !visibleLocalSubmission) return null

  return (
    <ItemGroup className="gap-1.5" aria-label="待处理消息">
      {visibleLocalSubmission ? (
        <Item key={visibleLocalSubmission.id} variant="outline" size="xs" className="bg-background/95">
          <ItemMedia aria-hidden>
            <Spinner className="size-3.5" />
          </ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle className="max-w-full truncate font-normal">
              {visibleLocalSubmission.content}
            </ItemTitle>
          </ItemContent>
          <ItemActions>
            <span className="text-xs text-muted-foreground">
              {visibleLocalSubmission.phase === "submitting" ? "正在发送" : "等待处理"}
            </span>
          </ItemActions>
        </Item>
      ) : null}
      {prompts.map(({ input, run }) => {
        const promoting = actionId === `promote:${input.id}`
        const cancelling = actionId === `cancel:${input.id}`
        const busy = actionId !== null
        return (
          <Item key={run.id} variant="outline" size="xs" className="bg-background/95">
            <ItemMedia aria-hidden>
              <GripVertical className="size-3.5 text-muted-foreground" />
            </ItemMedia>
            <ItemContent className="min-w-0">
              <ItemTitle className="max-w-full truncate font-normal">{input.content}</ItemTitle>
            </ItemContent>
            <ItemActions>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={!activeRunId || busy}
                onClick={() => onPromote(input.id, run.id)}
              >
                {promoting ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <CornerDownRight data-icon="inline-start" />
                )}
                调整方向
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={busy}
                aria-label="删除待处理消息"
                title="删除待处理消息"
                onClick={() => onCancel(input.id, run.id)}
              >
                {cancelling ? <Spinner /> : <Trash2 />}
              </Button>
            </ItemActions>
          </Item>
        )
      })}
    </ItemGroup>
  )
}
