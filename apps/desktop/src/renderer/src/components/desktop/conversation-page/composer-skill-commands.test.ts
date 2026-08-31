import { describe, expect, it } from "vitest"

import {
  draftForSelectedSkillCommand,
  filterSkillCommands,
  getSkillCommandTrigger,
  parseSelectedSkillCommandDraft,
  skillCommandInvocationLine,
  toComposerSkillCommands,
} from "./composer-skill-commands"

describe("composer skill commands", () => {
  it("maps template skill commands for the composer menu", () => {
    expect(
      toComposerSkillCommands([
        {
          name: "/review",
          description: "Review changes",
          kind: "template",
          source: "skill",
        },
        {
          name: "/project-review",
          description: "Review with project rules",
          kind: "template",
          source: "project",
        },
        {
          name: "/plugin-review",
          description: "Review with plugin rules",
          kind: "template",
          source: "plugin",
        },
        {
          name: "/help",
          description: "Show help",
          kind: "session",
          source: "builtin",
        },
      ])
    ).toEqual([
      {
        name: "/plugin-review",
        label: "plugin review",
        description: "Review with plugin rules",
        sourceLabel: "插件",
      },
      {
        name: "/project-review",
        label: "project review",
        description: "Review with project rules",
        sourceLabel: "项目",
      },
      {
        name: "/review",
        label: "review",
        description: "Review changes",
        sourceLabel: "个人",
      },
    ])
  })

  it("only triggers on a prompt-start slash token", () => {
    expect(getSkillCommandTrigger("/")).toEqual({ query: "" })
    expect(getSkillCommandTrigger("/rev")).toEqual({ query: "rev" })
    expect(getSkillCommandTrigger("hello /rev")).toBeNull()
    expect(getSkillCommandTrigger("/rev now")).toBeNull()
    expect(getSkillCommandTrigger("/rev\nnow")).toBeNull()
  })

  it("filters commands by name and description", () => {
    const commands = toComposerSkillCommands([
      {
        name: "/review",
        description: "Audit current diff",
        kind: "template",
        source: "skill",
      },
      {
        name: "/commit",
        description: "Prepare git changes",
        kind: "template",
        source: "skill",
      },
    ])

    expect(filterSkillCommands(commands, "aud")).toEqual([
      {
        name: "/review",
        label: "review",
        description: "Audit current diff",
        sourceLabel: "个人",
      },
    ])
  })

  it("writes the selected command back as an editable draft prefix", () => {
    expect(
      draftForSelectedSkillCommand({
        name: "/review",
        label: "review",
        description: "Review changes",
        sourceLabel: "个人",
      })
    ).toBe("/review ")
    expect(
      draftForSelectedSkillCommand({
        name: "/review",
        label: "review",
        description: "Review changes",
        sourceLabel: "个人",
        argumentHint: "<path>",
      })
    ).toBe("/review <path>")
  })

  it("parses a selected command draft for rich rendering", () => {
    const command = {
      name: "/review",
      label: "review",
      description: "Review changes",
      sourceLabel: "个人",
    }

    expect(parseSelectedSkillCommandDraft("/review update this", [command])).toEqual({
      command,
      body: " update this",
    })
    expect(parseSelectedSkillCommandDraft("/unknown", [command])).toBeNull()
  })

  it("only returns an invocation line for known skill commands", () => {
    const command = {
      name: "/design-md",
      label: "design md",
      description: "Design markdown output",
      sourceLabel: "个人",
    }

    expect(skillCommandInvocationLine("/design-md make a spec", [command])).toBe(
      "/design-md make a spec"
    )
    expect(skillCommandInvocationLine("/design", [command])).toBeNull()
  })
})
