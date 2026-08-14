import type {
  DesktopSessionMessage,
  DesktopSessionPart,
  DesktopSessionRun,
} from "@shared/session-types"

export interface ConversationTurn {
  id: string
  inputId?: string
  runIds: string[]
  userMessage?: DesktopSessionMessage
  userParts: DesktopSessionPart[]
  assistantMessages: DesktopSessionMessage[]
  assistantParts: DesktopSessionPart[]
}

export type ConversationEntry =
  | { type: "turn"; turn: ConversationTurn }
  | {
      type: "system"
      system: { id: string; message: DesktopSessionMessage; parts: DesktopSessionPart[] }
    }

export function buildConversationEntries(
  messages: DesktopSessionMessage[],
  parts: DesktopSessionPart[],
  runs: DesktopSessionRun[]
): ConversationEntry[] {
  const partsByMessage = groupPartsByMessage(parts)
  const inputIdByRunId = new Map(runs.map((run) => [run.id, run.inputId]))
  const turnsByInputId = new Map<string, ConversationTurn>()
  const entries: ConversationEntry[] = []
  let latestTurn: ConversationTurn | undefined

  for (const message of [...messages].sort(compareMessages)) {
    const messageParts = partsByMessage.get(message.id) ?? []
    if (message.role === "system") {
      entries.push({
        type: "system",
        system: { id: message.id, message, parts: messageParts },
      })
      continue
    }

    const inputId =
      message.inputId ?? (message.runId ? inputIdByRunId.get(message.runId) : undefined)
    if (message.role === "user") {
      const turn = createTurn(message, messageParts, inputId)
      entries.push({ type: "turn", turn })
      latestTurn = turn
      if (inputId) turnsByInputId.set(inputId, turn)
      continue
    }

    let turn = inputId ? turnsByInputId.get(inputId) : undefined
    if (!turn) turn = latestTurn
    if (!turn) {
      turn = createTurn(undefined, [], inputId, message.id)
      entries.push({ type: "turn", turn })
      latestTurn = turn
      if (inputId) turnsByInputId.set(inputId, turn)
    }

    turn.assistantMessages.push(message)
    turn.assistantParts.push(...messageParts)
    if (message.runId && !turn.runIds.includes(message.runId)) turn.runIds.push(message.runId)
    if (inputId && !turn.inputId) {
      turn.inputId = inputId
      turnsByInputId.set(inputId, turn)
    }
  }

  return entries
}

function createTurn(
  userMessage: DesktopSessionMessage | undefined,
  userParts: DesktopSessionPart[],
  inputId?: string,
  fallbackId?: string
): ConversationTurn {
  return {
    id: inputId ?? userMessage?.id ?? fallbackId ?? "empty-turn",
    inputId,
    runIds: [],
    userMessage,
    userParts,
    assistantMessages: [],
    assistantParts: [],
  }
}

function groupPartsByMessage(parts: DesktopSessionPart[]): Map<string, DesktopSessionPart[]> {
  const grouped = new Map<string, DesktopSessionPart[]>()
  for (const part of parts) {
    const current = grouped.get(part.messageId) ?? []
    current.push(part)
    grouped.set(part.messageId, current)
  }
  for (const current of grouped.values()) current.sort((a, b) => a.seq - b.seq)
  return grouped
}

function compareMessages(a: DesktopSessionMessage, b: DesktopSessionMessage): number {
  return a.seq - b.seq || a.createdAt - b.createdAt
}
