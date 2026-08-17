import { Fragment, useMemo } from "react"

import { AssistantMessage } from "@renderer/components/desktop/conversation/assistant-message"
import { buildConversationEntries } from "@renderer/components/desktop/conversation/conversation-turn-model"
import { Marker, MarkerContent, MarkerIcon } from "@renderer/components/ui/marker"
import { MessageScrollerItem } from "@renderer/components/ui/message-scroller"
import { Spinner } from "@renderer/components/ui/spinner"
import type {
  DesktopSessionMessage,
  DesktopSessionPart,
  DesktopSessionRun,
} from "@shared/session-types"
import {
  AssistantMessageActions,
  MessageBlock,
  messageTextContent,
  RunErrorNotice,
} from "./message-block"

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
  onOpenTerminal,
}: {
  messages: DesktopSessionMessage[]
  parts: DesktopSessionPart[]
  runs: DesktopSessionRun[]
  running: boolean
  canEditLastUserMessage: boolean
  onEditLastUserMessage: (content: string) => void
  onCopyAssistantMessage: (content: string) => void
  onForkAssistantMessage: (messageId: string) => void
  onOpenFile: (path: string, line?: number) => void
  onOpenTerminal: (terminalId: string) => void
}): React.JSX.Element {
  const entries = useMemo(
    () => buildConversationEntries(messages, parts, runs),
    [messages, parts, runs]
  )
  const lastTurn = [...entries].reverse().find((entry) => entry.type === "turn")
  const lastUserMessage = [...entries]
    .reverse()
    .flatMap((entry) =>
      entry.type === "turn" && entry.turn.userMessage ? [entry.turn.userMessage] : []
    )[0]
  const failedRuns = runs.filter((run) => run.status === "failed")
  const attachedRunIds = new Set(
    entries.flatMap((entry) => {
      if (entry.type !== "turn") return []
      return failedRuns
        .filter(
          (run) =>
            entry.turn.runIds.includes(run.id) ||
            (Boolean(run.inputId) && run.inputId === entry.turn.inputId)
        )
        .map((run) => run.id)
    })
  )
  const unattachedFailures = failedRuns.filter((run) => !attachedRunIds.has(run.id))

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
                  onOpenTerminal={onOpenTerminal}
                />
                <AssistantMessageActions
                  message={entry.turn.assistantMessages.at(-1)}
                  content={messageTextContent(entry.turn.assistantParts)}
                  disabled={running && entry === lastTurn}
                  onCopy={onCopyAssistantMessage}
                  onFork={onForkAssistantMessage}
                />
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
      {unattachedFailures.map((run) => (
        <MessageScrollerItem key={run.id} messageId={`run-error-${run.id}`}>
          <RunErrorNotice error={run.error} />
        </MessageScrollerItem>
      ))}
      {running ? (
        <MessageScrollerItem messageId="conversation-running-status">
          <Marker>
            <MarkerIcon>
              <Spinner />
            </MarkerIcon>
            <MarkerContent>OpenHarness 正在处理</MarkerContent>
          </Marker>
        </MessageScrollerItem>
      ) : null}
    </>
  )
}
