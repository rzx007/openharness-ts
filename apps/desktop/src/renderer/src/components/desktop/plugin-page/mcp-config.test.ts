import { describe, expect, it } from "vitest"
import {
  parseMcpJson,
  serializeMcpDocument,
  toMcpForm,
  fromMcpForm,
  loadMcpStorage,
  saveMcpStorage,
  mcpStorageKey,
} from "./mcp-config"

describe("MCP configuration", () => {
  it("validates only active transport semantics while preserving inactive fields", () => {
    const doc = parseMcpJson(
      '{"name":"switchable","type":"http","url":"","bearer_token_env_var":"","command":"node"}',
      { allowIncomplete: true }
    )
    const form = toMcpForm(doc.servers[0])
    form.type = "stdio"
    const saved = parseMcpJson(serializeMcpDocument({ ...doc, servers: [fromMcpForm(form)] }))
    expect(saved.servers[0].config).toEqual({
      type: "stdio",
      command: "node",
      url: "",
      bearer_token_env_var: "",
    })
    const back = toMcpForm(saved.servers[0])
    back.type = "http"
    expect(() =>
      parseMcpJson(serializeMcpDocument({ ...doc, servers: [fromMcpForm(back)] }))
    ).toThrow("url")
  })

  it("rejects duplicate names created in the batch form before serializing", () => {
    const doc = parseMcpJson('{"mcpServers":{"one":{"command":"node"},"two":{"command":"bun"}}}')
    const forms = doc.servers.map(toMcpForm)
    forms[1].name = "one"
    expect(() => serializeMcpDocument({ ...doc, servers: forms.map(fromMcpForm) })).toThrow("重复")
  })

  it("imports a mixed batch without losing unknown fields or disabled state", () => {
    const doc = parseMcpJson(
      JSON.stringify({
        note: { owner: "team" },
        mcpServers: {
          local: {
            command: "node",
            args: ["server.js", ""],
            env: { EMPTY: "" },
            env_vars: ["PATH"],
            cwd: "D:/work",
            custom: { retry: 3 },
            enabled: false,
          },
          remote: {
            url: "https://example.com/mcp",
            bearer_token_env_var: "TOKEN",
            http_headers: { Accept: "application/json" },
            env_http_headers: { Authorization: "AUTH" },
          },
        },
      })
    )
    expect(doc.servers.map((s) => s.name)).toEqual(["local", "remote"])
    expect(JSON.parse(serializeMcpDocument(doc))).toEqual({
      note: { owner: "team" },
      mcpServers: {
        local: {
          command: "node",
          args: ["server.js", ""],
          env: { EMPTY: "" },
          env_vars: ["PATH"],
          cwd: "D:/work",
          custom: { retry: 3 },
          enabled: false,
        },
        remote: {
          url: "https://example.com/mcp",
          bearer_token_env_var: "TOKEN",
          http_headers: { Accept: "application/json" },
          env_http_headers: { Authorization: "AUTH" },
        },
      },
    })
  })

  it("round-trips a single server and changes only edited form fields", () => {
    const doc = parseMcpJson(
      '{"name":"local","command":"node","env":{},"cwd":"","custom":{"nested":[1,true]}}'
    )
    const form = toMcpForm(doc.servers[0])
    expect(fromMcpForm(form)).toEqual(doc.servers[0])
    form.command = "bun"
    expect(fromMcpForm(form)).toEqual({
      name: "local",
      config: { command: "bun", env: {}, cwd: "", custom: { nested: [1, true] } },
    })
    expect(JSON.parse(serializeMcpDocument(doc))).toEqual({
      name: "local",
      command: "node",
      env: {},
      cwd: "",
      custom: { nested: [1, true] },
    })
  })

  it.each([
    ['{"name":', "JSON"],
    ["[]", "对象"],
    ['{"mcpServers":[]}', "对象"],
    ['{"mcpServers":{}}', "至少"],
    ['{"mcpServers":{"a":null}}', "对象"],
    ['{"name":" ","command":"node"}', "名称"],
    ['{"name":"a","command":" "}', "command"],
    ['{"name":"a","type":"http"}', "url"],
    ['{"name":"a","url":"file:///tmp/server"}', "http"],
    ['{"name":"a","url":"https://"}', "URL"],
    ['{"name":"a","command":"node","url":"https://example.com"}', "type"],
    ['{"name":"a","command":"node","args":{}}', "args"],
    ['{"name":"a","command":"node","args":[4]}', "args"],
    ['{"name":"a","command":"node","env":[]}', "env"],
    ['{"name":"a","command":"node","env":{"X":3}}', "env"],
    ['{"name":"a","command":"node","env_vars":[""]}', "env_vars"],
    ['{"name":"a","command":"node","cwd":4}', "cwd"],
    ['{"name":"a","url":"https://example.com","bearer_token_env_var":" "}', "bearer_token"],
    ['{"name":"a","url":"https://example.com","env_http_headers":{"Auth":""}}', "env_http_headers"],
    ['{"name":"a","url":"https://example.com","http_headers":[]}', "http_headers"],
    ['{"name":"a","command":"node","enabled":"false"}', "enabled"],
    ['{"name":"a","type":"websocket","url":"https://example.com"}', "type"],
    ['{"mcpServers":{"a":{"command":"node"}," a ":{"command":"bun"}}}', "重复"],
    ['{"mcpServers":{"a":{"command":"node"},"a":{"command":"bun"}}}', "重复"],
    ['{"mcpServers":{"a":{"command":"node"},"\\u0061":{"command":"bun"}}}', "重复"],
  ])("rejects invalid or ambiguous input %s", (input, message) => {
    expect(() => parseMcpJson(input)).toThrow(message)
  })

  it("rejects existing names and duplicate form keys before overwriting anything", () => {
    expect(() =>
      parseMcpJson('{"name":"taken","command":"node"}', { existingNames: ["taken"] })
    ).toThrow("已存在")
    const form = toMcpForm(parseMcpJson('{"name":"local","command":"node"}').servers[0])
    form.env = [
      ["TOKEN", "one"],
      ["TOKEN", "two"],
    ]
    expect(() => fromMcpForm(form)).toThrow("重复")
    form.env = [["", "value"]]
    expect(() => fromMcpForm(form)).toThrow("不能为空")
  })

  it("allows incomplete required values in the editor but validates them at save", () => {
    const doc = parseMcpJson('{"name":"","command":""}', { allowIncomplete: true })
    expect(toMcpForm(doc.servers[0]).command).toBe("")
    expect(() => parseMcpJson(serializeMcpDocument(doc))).toThrow()
  })
})

describe("project-local MCP storage", () => {
  function storage() {
    const values = new Map<string, string>()
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
    }
  }

  it("isolates projects, reloads disabled entries and exports an importable document", () => {
    const target = storage()
    const doc = parseMcpJson('{"name":"local","command":"node","enabled":false}')
    saveMcpStorage(target, "D:/one", doc, null)
    expect(loadMcpStorage(target, "D:/one").document.servers[0].config.enabled).toBe(false)
    expect(loadMcpStorage(target, "D:/two").document.servers).toEqual([])
    expect(
      parseMcpJson(serializeMcpDocument(loadMcpStorage(target, "D:/one").document)).servers[0].name
    ).toBe("local")
  })

  it("keeps corrupted storage untouched and reports it", () => {
    const target = storage()
    target.setItem(mcpStorageKey("p"), "corrupt")
    expect(() => loadMcpStorage(target, "p")).toThrow()
    expect(target.getItem(mcpStorageKey("p"))).toBe("corrupt")
  })

  it("prevents a stale editor from overwriting another window's saved changes", () => {
    const target = storage()
    const doc = parseMcpJson('{"name":"local","command":"node"}')
    saveMcpStorage(target, "p", doc, null)
    expect(() => saveMcpStorage(target, "p", doc, null)).toThrow("刷新")
  })

  it("propagates a failed write so the UI cannot claim the change was saved", () => {
    const doc = parseMcpJson('{"name":"local","command":"node"}')
    expect(() =>
      saveMcpStorage(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error("Quota exceeded")
          },
        },
        "p",
        doc,
        null
      )
    ).toThrow("Quota exceeded")
  })
})
