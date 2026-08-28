import type {
  DesktopSessionMessage,
  DesktopSessionPart,
  DesktopSessionRun,
} from "@shared/session-types"

export interface ConversationTurn {
  id: string
  createdAt: number
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
  const turnsByRunId = new Map<string, ConversationTurn>()
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
      const existingTurn = inputId ? turnsByInputId.get(inputId) : undefined
      if (existingTurn) {
        existingTurn.userMessage = message
        existingTurn.userParts = messageParts
        existingTurn.createdAt = Math.min(existingTurn.createdAt, message.createdAt)
        latestTurn = existingTurn
        if (message.runId) {
          if (!existingTurn.runIds.includes(message.runId)) existingTurn.runIds.push(message.runId)
          turnsByRunId.set(message.runId, existingTurn)
        }
        continue
      }
      const turn = createTurn(message, messageParts, inputId)
      entries.push({ type: "turn", turn })
      latestTurn = turn
      if (inputId) turnsByInputId.set(inputId, turn)
      if (message.runId) turnsByRunId.set(message.runId, turn)
      continue
    }

    let turn = inputId ? turnsByInputId.get(inputId) : undefined
    if (!turn && !inputId) turn = latestTurn
    if (!turn) {
      turn = createTurn(undefined, [], inputId, message.id)
      entries.push({ type: "turn", turn })
      latestTurn = turn
      if (inputId) turnsByInputId.set(inputId, turn)
    }

    turn.assistantMessages.push(message)
    turn.assistantParts.push(...messageParts)
    turn.createdAt = Math.min(turn.createdAt, message.createdAt)
    if (message.runId) {
      if (!turn.runIds.includes(message.runId)) turn.runIds.push(message.runId)
      turnsByRunId.set(message.runId, turn)
    }
    if (inputId && !turn.inputId) {
      turn.inputId = inputId
      turnsByInputId.set(inputId, turn)
    }
  }

  for (const run of runs) {
    const turn =
      (run.inputId ? turnsByInputId.get(run.inputId) : undefined) ?? turnsByRunId.get(run.id)
    if (turn) {
      if (!turn.runIds.includes(run.id)) turn.runIds.push(run.id)
      turnsByRunId.set(run.id, turn)
      continue
    }
    if (run.status !== "failed" || messages.length > 0) continue
    const failedTurn = createTurn(undefined, [], run.inputId, `failed-run-${run.id}`, run.createdAt)
    failedTurn.runIds.push(run.id)
    entries.push({ type: "turn", turn: failedTurn })
  }

  entries.sort(compareEntries)

  return entries
}

function createTurn(
  userMessage: DesktopSessionMessage | undefined,
  userParts: DesktopSessionPart[],
  inputId?: string,
  fallbackId?: string,
  fallbackCreatedAt = Number.MAX_SAFE_INTEGER
): ConversationTurn {
  return {
    id: inputId ?? userMessage?.id ?? fallbackId ?? "empty-turn",
    createdAt: userMessage?.createdAt ?? fallbackCreatedAt,
    inputId,
    runIds: [],
    userMessage,
    userParts,
    assistantMessages: [],
    assistantParts: [],
  }
}

function compareEntries(left: ConversationEntry, right: ConversationEntry): number {
  const leftCreatedAt = left.type === "system" ? left.system.message.createdAt : left.turn.createdAt
  const rightCreatedAt =
    right.type === "system" ? right.system.message.createdAt : right.turn.createdAt
  return leftCreatedAt - rightCreatedAt
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
