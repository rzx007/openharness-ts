import { describe, expect, it } from "vitest"

import {
  draftForSelectedSkillCommand,
  filterSkillCommands,
  getSkillCommandTrigger,
  parseSkillCommandInvocation,
  parseSelectedSkillCommandDraft,
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
          source: "user",
        },
        {
          name: "/project-review",
          displayName: "Project Reviewer",
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
          name: "/plan",
          description: "Plan the work",
          kind: "template",
          source: "bundled",
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
        name: "/project-review",
        label: "Project Reviewer",
        description: "Review with project rules",
        sourceLabel: "项目",
        source: "project",
      },
      {
        name: "/review",
        label: "review",
        description: "Review changes",
        sourceLabel: "个人",
        source: "user",
      },
      {
        name: "/plugin-review",
        label: "plugin review",
        description: "Review with plugin rules",
        sourceLabel: "插件",
        source: "plugin",
      },
      {
        name: "/plan",
        label: "plan",
        description: "Plan the work",
        sourceLabel: "内置",
        source: "bundled",
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
        source: "user",
      },
      {
        name: "/commit",
        description: "Prepare git changes",
        kind: "template",
        source: "user",
      },
    ])

    expect(filterSkillCommands(commands, "aud")).toEqual([
      {
        name: "/review",
        label: "review",
        description: "Audit current diff",
        sourceLabel: "个人",
        source: "user",
      },
    ])
  })

  it("returns all matching commands without a default limit", () => {
    const commands = Array.from({ length: 15 }, (_, index) => ({
      name: `/skill-${index}`,
      description: `Skill ${index}`,
      kind: "template" as const,
      source: "user" as const,
    }))

    expect(filterSkillCommands(toComposerSkillCommands(commands), "")).toHaveLength(15)
    expect(filterSkillCommands(toComposerSkillCommands(commands), "", 10)).toHaveLength(10)
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

  it("turns a known skill draft into prompt content and invocation metadata", () => {
    const command = {
      name: "/design-md",
      label: "design md",
      description: "Design markdown output",
      sourceLabel: "个人",
      source: "user" as const,
    }

    expect(parseSkillCommandInvocation("/design-md make a spec", [command])).toEqual({
      content: "make a spec",
      skillInvocation: {
        name: "design-md",
        commandName: "design-md",
        displayName: "design md",
        source: "user",
        invocationSource: "slash",
      },
    })
    expect(parseSkillCommandInvocation("/design-md", [command])).toEqual({
      content: "",
      skillInvocation: {
        name: "design-md",
        commandName: "design-md",
        displayName: "design md",
        source: "user",
        invocationSource: "slash",
      },
    })
    expect(parseSkillCommandInvocation("/design", [command])).toBeNull()
  })
})
