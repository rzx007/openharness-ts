import type {
  DesktopCommandCatalogEntry,
  DesktopCommandSource,
  SkillInvocationMetadata,
} from "@shared/session-types"

export interface ComposerSkillCommand {
  name: string
  label: string
  description: string
  sourceLabel: string
  source?: DesktopCommandSource
  argumentHint?: string
}

export interface SkillCommandTrigger {
  query: string
}

export interface SelectedSkillCommandDraft {
  command: ComposerSkillCommand
  body: string
}

export interface ParsedSkillCommandInvocation {
  content: string
  skillInvocation: SkillInvocationMetadata
}

export function toComposerSkillCommands(
  commands: readonly DesktopCommandCatalogEntry[]
): ComposerSkillCommand[] {
  return commands
    .filter((command) => command.kind === "template")
    .map((command) => {
      const name = normalizeCommandName(command.name)
      return {
        name,
        label: command.displayName?.trim() || commandLabel(name),
        description: command.description?.trim() || "使用此技能处理当前请求",
        sourceLabel: sourceLabel(command.source),
        ...(command.source ? { source: command.source } : {}),
        ...(command.argumentHint?.trim() ? { argumentHint: command.argumentHint.trim() } : {}),
      }
    })
    .sort(
      (left, right) =>
        sourcePriority(left.source) - sourcePriority(right.source) ||
        left.label.localeCompare(right.label)
    )
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
  limit?: number
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

  const results = scored.map((entry) => entry.command)
  return limit === undefined ? results : results.slice(0, limit)
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

export function parseSkillCommandInvocation(
  draft: string,
  commands: readonly ComposerSkillCommand[]
): ParsedSkillCommandInvocation | null {
  const selected = parseSelectedSkillCommandDraft(draft, commands)
  if (!selected) return null
  const commandName = selected.command.name.replace(/^\//, "")
  const source = skillSource(selected.command.source)
  return {
    content: selected.body.trim(),
    skillInvocation: {
      name: commandName,
      commandName,
      displayName: selected.command.label,
      ...(source ? { source } : {}),
      invocationSource: "slash",
    },
  }
}

function skillSource(
  source: DesktopCommandSource | undefined
): SkillInvocationMetadata["source"] | undefined {
  return source === "bundled" || source === "user" || source === "project" || source === "plugin"
    ? source
    : undefined
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

function sourceLabel(source: DesktopCommandSource | undefined): string {
  if (source === "project") return "项目"
  if (source === "plugin") return "插件"
  if (source === "bundled" || source === "builtin") return "内置"
  return "个人"
}

function sourcePriority(source: DesktopCommandSource | undefined): number {
  if (source === "project") return 0
  if (source === "user") return 1
  if (source === "plugin") return 2
  if (source === "bundled" || source === "builtin") return 3
  return 3
}

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase()
}
