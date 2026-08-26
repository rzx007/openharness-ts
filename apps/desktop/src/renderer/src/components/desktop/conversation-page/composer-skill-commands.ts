import type { DesktopCommandCatalogEntry } from "@shared/session-types"

export interface ComposerSkillCommand {
  name: string
  label: string
  description: string
  argumentHint?: string
}

export interface SkillCommandTrigger {
  query: string
}

export interface SelectedSkillCommandDraft {
  command: ComposerSkillCommand
  body: string
}

export function toComposerSkillCommands(
  commands: readonly DesktopCommandCatalogEntry[]
): ComposerSkillCommand[] {
  return commands
    .filter((command) => command.source === "skill")
    .map((command) => {
      const name = normalizeCommandName(command.name)
      return {
        name,
        label: commandLabel(name),
        description: command.description?.trim() || "使用此技能处理当前请求",
        ...(command.argumentHint?.trim() ? { argumentHint: command.argumentHint.trim() } : {}),
      }
    })
    .sort((left, right) => left.label.localeCompare(right.label))
}

export function getSkillCommandTrigger(draft: string): SkillCommandTrigger | null {
  if (!draft.startsWith("/")) return null
  if (draft.includes("\n")) return null
  const withoutSlash = draft.slice(1)
  if (/\s/.test(withoutSlash)) return null
  return { query: withoutSlash }
}

export function filterSkillCommands(
  commands: readonly ComposerSkillCommand[],
  query: string,
  limit = 10
): ComposerSkillCommand[] {
  const normalizedQuery = normalizeSearchText(query)
  const scored = commands
    .map((command) => {
      const searchable = [
        command.name,
        command.label,
        command.description,
        command.argumentHint ?? "",
      ].map(normalizeSearchText)
      const score =
        !normalizedQuery || searchable.some((value) => value.startsWith(normalizedQuery))
          ? 0
          : searchable.some((value) => value.includes(normalizedQuery))
            ? 1
            : -1
      return { command, score }
    })
    .filter((entry) => entry.score >= 0)
    .sort(
      (left, right) =>
        left.score - right.score || left.command.label.localeCompare(right.command.label)
    )

  return scored.slice(0, limit).map((entry) => entry.command)
}

export function draftForSelectedSkillCommand(command: ComposerSkillCommand): string {
  const suffix = command.argumentHint ? ` ${command.argumentHint}` : " "
  return `${command.name}${suffix}`
}

export function parseSelectedSkillCommandDraft(
  draft: string,
  commands: readonly ComposerSkillCommand[]
): SelectedSkillCommandDraft | null {
  const matches = commands
    .filter((command) => draft === command.name || draft.startsWith(`${command.name} `))
    .sort((left, right) => right.name.length - left.name.length)
  const command = matches[0]
  if (!command) return null
  if (draft === command.name) return { command, body: "" }
  return { command, body: draft.slice(command.name.length) }
}

export function isKnownSkillCommandDraft(
  draft: string,
  commands: readonly ComposerSkillCommand[]
): boolean {
  return parseSelectedSkillCommandDraft(draft, commands) !== null
}

export function skillCommandInvocationLine(
  draft: string,
  commands: readonly ComposerSkillCommand[]
): string | null {
  return isKnownSkillCommandDraft(draft, commands) ? draft : null
}

function normalizeCommandName(name: string): string {
  const trimmed = name.trim()
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`
}

function commandLabel(name: string): string {
  return (
    name
      .slice(1)
      .replace(/[-_:]+/g, " ")
      .trim() || name
  )
}

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase()
}
