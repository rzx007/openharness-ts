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
  action?: {
    kind: "promote" | "cancel"
    phase: "pending" | "acknowledged" | "failed"
    error?: string
  }
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
  localSubmissions = [],
  onPromote,
  onCancel,
}: {
  prompts: PendingPrompt[]
  activeRunId?: string
  localSubmissions?: LocalPendingSubmission[]
  onPromote: (inputId: string, queuedRunId: string) => void
  onCancel: (inputId: string, queuedRunId: string) => void
}): React.JSX.Element | null {
  const authorityInputIds = new Set(prompts.map(({ input }) => input.id))
  const visibleLocalSubmissions = localSubmissions.filter(
    (submission) => !authorityInputIds.has(submission.id)
  )
  const visiblePrompts = prompts.filter(({ action }) => action?.phase !== "acknowledged")
  if (visiblePrompts.length === 0 && visibleLocalSubmissions.length === 0) return null

  return (
    <ItemGroup className="gap-1.5" aria-label="待处理消息">
      {visibleLocalSubmissions.map((visibleLocalSubmission) => (
        <Item
          key={visibleLocalSubmission.id}
          variant="outline"
          size="xs"
          className="bg-background/95"
        >
          <ItemMedia aria-hidden>
            {visibleLocalSubmission.phase === "failed" ? (
              <span className="text-xs font-semibold text-destructive">!</span>
            ) : (
              <Spinner className="size-3.5" />
            )}
          </ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle className="max-w-full truncate font-normal">
              {visibleLocalSubmission.content}
            </ItemTitle>
            {visibleLocalSubmission.phase === "failed" && visibleLocalSubmission.error ? (
              <p role="alert" className="text-xs leading-snug text-destructive">
                {visibleLocalSubmission.error}
              </p>
            ) : null}
          </ItemContent>
          <ItemActions>
            <span className="text-xs text-muted-foreground">
              {visibleLocalSubmission.phase === "submitting"
                ? "正在发送"
                : visibleLocalSubmission.phase === "accepted"
                  ? "等待处理"
                  : "发送失败"}
            </span>
          </ItemActions>
        </Item>
      ))}
      {visiblePrompts.map(({ input, run, action }) => {
        const promoting = action?.kind === "promote" && action.phase === "pending"
        const cancelling = action?.kind === "cancel" && action.phase === "pending"
        const busy = action?.phase === "pending"
        return (
          <Item key={run.id} variant="outline" size="xs" className="bg-background/95">
            <ItemMedia aria-hidden>
              <GripVertical className="size-3.5 text-muted-foreground" />
            </ItemMedia>
            <ItemContent className="min-w-0">
              <ItemTitle className="max-w-full truncate font-normal">{input.content}</ItemTitle>
              {action?.phase === "failed" && action.error ? (
                <p role="alert" className="text-xs leading-snug text-destructive">
                  {action.error}
                </p>
              ) : null}
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
