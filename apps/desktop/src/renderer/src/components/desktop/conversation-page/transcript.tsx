import { Fragment, useMemo } from "react"

import { messageTextContent } from "./message-content"
import { AssistantMessage } from "./message/assistant-message"
import { buildConversationEntries } from "./message/conversation-turn-model"
import { visibleTranscriptParts } from "./transcript-visibility"
import { Marker, MarkerContent, MarkerIcon } from "@renderer/components/ui/marker"
import { MessageScrollerItem } from "@renderer/components/ui/message-scroller"
import { Spinner } from "@renderer/components/ui/spinner"
import type {
  DesktopSessionMessage,
  DesktopSessionPart,
  DesktopSessionRun,
} from "@shared/session-types"
import { AssistantMessageActions, MessageBlock, RunErrorNotice } from "./message-block"

export function ConversationTranscript({
  messages,
  parts,
  runs,
  running,
  canEditLastUserMessage,
  onEditLastUserMessage,
  onCopyAssistantMessage,
  onForkAssistantMessage,
  onOpenFile,
  canOpenReview,
  onOpenReview,
  onOpenTerminal,
  showReasoning = true,
}: {
  messages: DesktopSessionMessage[]
  parts: DesktopSessionPart[]
  runs: DesktopSessionRun[]
  running: boolean
  canEditLastUserMessage: boolean
  onEditLastUserMessage: (content: string) => void
  onCopyAssistantMessage: (content: string) => void
  onForkAssistantMessage?: (messageId: string) => void
  onOpenFile: (path: string, line?: number) => void
  canOpenReview: boolean
  onOpenReview: (path?: string) => void
  onOpenTerminal: (terminalId: string) => void
  showReasoning?: boolean
}): React.JSX.Element {
  const visibleParts = useMemo(
    () => visibleTranscriptParts(parts, showReasoning),
    [parts, showReasoning]
  )
  const entries = useMemo(
    () => buildConversationEntries(messages, visibleParts, runs),
    [messages, visibleParts, runs]
  )
  const lastTurn = [...entries].reverse().find((entry) => entry.type === "turn")
  const lastUserMessage = [...entries]
    .reverse()
    .flatMap((entry) =>
      entry.type === "turn" && entry.turn.userMessage ? [entry.turn.userMessage] : []
    )[0]
  const failedRuns = runs.filter((run) => run.status === "failed")

  if (messages.length === 0 && !running && failedRuns.length === 0) {
    return (
      <MessageScrollerItem>
        <div className="flex min-h-80 items-center justify-center text-sm text-ui-muted">
          这个会话还没有消息
        </div>
      </MessageScrollerItem>
    )
  }

  return (
    <>
      {entries.map((entry) => {
        if (entry.type === "system") {
          return (
            <MessageScrollerItem key={entry.system.id} messageId={entry.system.id}>
              <MessageBlock
                message={entry.system.message}
                parts={entry.system.parts}
                streaming={false}
                onOpenFile={onOpenFile}
                canOpenReview={canOpenReview}
                onOpenReview={onOpenReview}
                onOpenTerminal={onOpenTerminal}
              />
            </MessageScrollerItem>
          )
        }
        const turnFailures = failedRuns.filter(
          (run) =>
            entry.turn.runIds.includes(run.id) ||
            (Boolean(run.inputId) && run.inputId === entry.turn.inputId)
        )
        return (
          <Fragment key={entry.turn.id}>
            {entry.turn.userMessage ? (
              <MessageScrollerItem
                messageId={entry.turn.userMessage.id}
                scrollAnchor
                className="pt-2"
              >
                <MessageBlock
                  message={entry.turn.userMessage}
                  parts={entry.turn.userParts}
                  streaming={false}
                  userActions={{
                    canEdit:
                      canEditLastUserMessage && entry.turn.userMessage.id === lastUserMessage?.id,
                    onEdit: onEditLastUserMessage,
                  }}
                  onOpenFile={onOpenFile}
                  canOpenReview={canOpenReview}
                  onOpenReview={onOpenReview}
                  onOpenTerminal={onOpenTerminal}
                />
              </MessageScrollerItem>
            ) : null}
            {entry.turn.assistantMessages.length > 0 ? (
              <MessageScrollerItem
                messageId={entry.turn.assistantMessages.at(-1)?.id ?? `${entry.turn.id}-assistant`}
                className="group/msg min-w-0"
              >
                <AssistantMessage
                  parts={entry.turn.assistantParts}
                  streaming={running && entry === lastTurn}
                  onOpenFile={onOpenFile}
                  canOpenReview={canOpenReview}
                  onOpenReview={onOpenReview}
                  onOpenTerminal={onOpenTerminal}
                />
                {running && entry === lastTurn ? null : (
                  <AssistantMessageActions
                    message={entry.turn.assistantMessages.at(-1)}
                    content={messageTextContent(entry.turn.assistantParts)}
                    disabled={false}
                    onCopy={onCopyAssistantMessage}
                    onFork={onForkAssistantMessage}
                  />
                )}
              </MessageScrollerItem>
            ) : null}
            {turnFailures.map((run) => (
              <MessageScrollerItem key={run.id} messageId={`run-error-${run.id}`}>
                <RunErrorNotice error={run.error} />
              </MessageScrollerItem>
            ))}
          </Fragment>
        )
      })}
      {running ? (
        <MessageScrollerItem messageId="conversation-running-status text-foreground/30">
          <Marker>
            <MarkerIcon>
              <Spinner />
            </MarkerIcon>
            <MarkerContent className="shimmer">正在处理</MarkerContent>
          </Marker>
        </MessageScrollerItem>
      ) : null}
    </>
  )
}
