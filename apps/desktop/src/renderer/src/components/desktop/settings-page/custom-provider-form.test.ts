import { describe, expect, it } from "vitest"

import { validateCustomProviderForm } from "./custom-provider-form"

const validForm = {
  id: "office-gateway",
  displayName: " Office Gateway ",
  baseUrl: "https://gateway.example/v1",
  apiKey: " secret ",
  models: [{
    key: "model-1",
    id: "team-model",
    displayName: " Team Model ",
    imageInputSupport: "native" as const,
  }],
  headers: [{ key: "header-1", name: " X-Tenant ", value: " desktop " }],
}

describe("validateCustomProviderForm", () => {
  it("normalizes a valid custom provider form", () => {
    expect(validateCustomProviderForm(validForm)).toEqual({
      ok: true,
      value: {
        id: "office-gateway",
        displayName: "Office Gateway",
        baseUrl: "https://gateway.example/v1",
        apiFormat: "openai",
        apiKey: "secret",
        models: [{
          id: "team-model",
          displayName: "Team Model",
          imageInputSupport: "native",
        }],
        headers: { "X-Tenant": "desktop" },
      },
    })
  })

  it("rejects an invalid provider ID", () => {
    expect(validateCustomProviderForm({ ...validForm, id: "Open AI" })).toEqual({
      ok: false,
      field: "id",
      message: "供应商 ID 只能包含小写字母、数字、连字符或下划线。",
    })
  })

  it("requires at least one complete model", () => {
    expect(validateCustomProviderForm({ ...validForm, models: [] })).toEqual({
      ok: false,
      field: "models",
      message: "请至少添加一个模型。",
    })
    expect(validateCustomProviderForm({
      ...validForm,
      models: [{
        key: "model-1",
        id: "",
        displayName: "Empty",
        imageInputSupport: "unknown",
      }],
    })).toMatchObject({ ok: false, field: "models" })
  })

  it("rejects duplicate model IDs and incomplete header rows", () => {
    expect(validateCustomProviderForm({
      ...validForm,
      models: [
        { key: "model-1", id: "same", displayName: "One", imageInputSupport: "unknown" },
        { key: "model-2", id: "same", displayName: "Two", imageInputSupport: "unsupported" },
      ],
    })).toMatchObject({ ok: false, field: "models" })
    expect(validateCustomProviderForm({
      ...validForm,
      headers: [{ key: "header-1", name: "X-Tenant", value: "" }],
    })).toMatchObject({ ok: false, field: "headers" })
  })

  it("keeps unsupported and unknown image declarations instead of guessing from IDs", () => {
    expect(validateCustomProviderForm({
      ...validForm,
      models: [
        { key: "model-1", id: "gpt-4o", displayName: "Vision off", imageInputSupport: "unsupported" },
        { key: "model-2", id: "custom-vl", displayName: "Unknown", imageInputSupport: "unknown" },
      ],
    })).toMatchObject({
      ok: true,
      value: {
        models: [
          { id: "gpt-4o", displayName: "Vision off", imageInputSupport: "unsupported" },
          { id: "custom-vl", displayName: "Unknown", imageInputSupport: "unknown" },
        ],
      },
    })
  })
})
