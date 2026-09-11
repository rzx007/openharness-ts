export interface ComposerSkill {
  name: string
  commandName?: string
  path: string
  displayName: string
  description: string
  source?: "bundled" | "user" | "project" | "plugin"
  sourceLabel: string
}
