import { describe, expect, it } from "vitest"
import {
  normalizeSessionUserInputItems,
  sessionUserInputText,
  validateSessionUserInputItems,
} from "./session-input-items.js"

describe("session input items", () => {
  it("merges adjacent text and preserves skill order", () => {
    const items = normalizeSessionUserInputItems([
      { type: "text", text: "使用 " },
      { type: "text", text: "这个 " },
      { type: "skill", name: "writing-plans", path: "D:/skills/writing-plans/SKILL.md", displayName: "Writing Plans" },
      { type: "text", text: " 写计划" },
    ])
    expect(items).toEqual([
      { type: "text", text: "使用 这个 " },
      { type: "skill", name: "writing-plans", path: "D:/skills/writing-plans/SKILL.md", displayName: "Writing Plans" },
      { type: "text", text: " 写计划" },
    ])
    expect(sessionUserInputText(items)).toBe("使用 这个 $writing-plans 写计划")
  })

  it("removes empty text items", () => {
    expect(normalizeSessionUserInputItems([
      { type: "text", text: "" },
      { type: "skill", name: "writing-plans", path: "D:/skills/writing-plans/SKILL.md" },
      { type: "text", text: "" },
    ])).toEqual([
      { type: "skill", name: "writing-plans", path: "D:/skills/writing-plans/SKILL.md" },
    ])
  })

  it("rejects more than 32 skill items", () => {
    expect(() => validateSessionUserInputItems(
      Array.from({ length: 33 }, (_, index) => ({ type: "skill" as const, name: `s${index}`, path: `D:/s${index}/SKILL.md` }))
    )).toThrowError(/skill_item_limit_exceeded/)
  })

  it("accepts 256 items but rejects 257", () => {
    const items = Array.from({ length: 256 }, (_, index) => ({ type: "mention" as const, name: `m${index}`, path: `D:/m${index}` }))
    expect(validateSessionUserInputItems(items)).toEqual(items)
    expect(() => validateSessionUserInputItems([
      ...items,
      { type: "mention", name: "m256", path: "D:/m256" },
    ])).toThrowError(/item_limit_exceeded/)
  })

  it("accepts 32 skill items", () => {
    const items = Array.from({ length: 32 }, (_, index) => ({ type: "skill" as const, name: `s${index}`, path: `D:/s${index}/SKILL.md` }))
    expect(validateSessionUserInputItems(items)).toEqual(items)
  })

  it("measures text limits as UTF-8 bytes", () => {
    expect(validateSessionUserInputItems([{ type: "text", text: "a".repeat(1024 * 1024) }]))
      .toEqual([{ type: "text", text: "a".repeat(1024 * 1024) }])
    expect(() => validateSessionUserInputItems([{ type: "text", text: "a".repeat(1024 * 1024 + 1) }]))
      .toThrowError(/text_byte_limit_exceeded/)
  })

  it("rejects control characters and oversized names", () => {
    expect(() => validateSessionUserInputItems([{ type: "text", text: "line\nbreak" }]))
      .toThrowError(/invalid_text/)
    expect(() => validateSessionUserInputItems([{
      type: "skill",
      name: "s".repeat(129),
      path: "D:/skills/skill.md",
    }])).toThrowError(/name_limit_exceeded/)
  })

  it("keeps consecutive skills and adjacent punctuation in canonical text", () => {
    const items = normalizeSessionUserInputItems([
      { type: "skill", name: "first", path: "D:/first" },
      { type: "text", text: "," },
      { type: "skill", name: "second", path: "D:/second" },
      { type: "mention", name: "third", path: "D:/third" },
      { type: "text", text: "!" },
    ])
    expect(sessionUserInputText(items)).toBe("$first,$second$third!")
  })
})
