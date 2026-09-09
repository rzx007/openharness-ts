export type McpConfig = Record<string, unknown>
export interface McpEntry {
  name: string
  config: McpConfig
}
export interface McpDocument {
  servers: McpEntry[]
  extras: McpConfig
  wrapped: boolean
}
type ParseOptions = { allowIncomplete?: boolean; existingNames?: string[] }
type StorageAccess = Pick<Storage, "getItem" | "setItem">
export type McpPairs = [string, string][]

function object(value: unknown): value is McpConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// JSON.parse silently discards duplicate keys. Check the already syntax-validated
// token stream too, including escaped names, before importing any configuration.
function checkDuplicateKeys(text: string): void {
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]|[^\s{}[\]:,]+/g) ?? []
  let cursor = 0
  function visit(): void {
    const token = tokens[cursor++]
    if (token === "{") {
      const names = new Set<string>()
      while (tokens[cursor] !== "}") {
        const name = JSON.parse(tokens[cursor++]) as string
        if (names.has(name)) throw new Error(`JSON 中存在重复字段或名称：${name}`)
        names.add(name)
        cursor++ // colon
        visit()
        if (tokens[cursor] === ",") cursor++
      }
      cursor++
    } else if (token === "[") {
      while (tokens[cursor] !== "]") {
        visit()
        if (tokens[cursor] === ",") cursor++
      }
      cursor++
    }
  }
  visit()
}

export function mcpTransport(config: McpConfig): "stdio" | "http" {
  return config.type === "http" || (config.type === undefined && config.url !== undefined)
    ? "http"
    : "stdio"
}

export function validateMcpEntry(entry: McpEntry, allowIncomplete = false): void {
  const { name, config } = entry
  const fail = (message: string): never => {
    throw new Error(`${name || "未命名服务器"}：${message}`)
  }
  if (!allowIncomplete && !name.trim()) fail("名称不能为空")
  if (config.type !== undefined && config.type !== "stdio" && config.type !== "http")
    fail("type 只能是 stdio 或 http")
  if (config.type === undefined && config.command !== undefined && config.url !== undefined)
    fail("同时包含 command 和 url 时，请明确指定 type")
  const transport = mcpTransport(config)
  for (const key of ["command", "url", "cwd", "bearer_token_env_var"] as const) {
    if (config[key] !== undefined && typeof config[key] !== "string") fail(`${key} 必须是字符串`)
  }
  for (const key of ["args", "env_vars"] as const) {
    const value = config[key]
    if (value !== undefined && (!Array.isArray(value) || value.some((v) => typeof v !== "string")))
      fail(`${key} 必须是字符串数组`)
    if (
      !allowIncomplete &&
      transport === "stdio" &&
      key === "env_vars" &&
      Array.isArray(value) &&
      value.some((v: string) => !v.trim())
    )
      fail("env_vars 中的变量名不能为空")
  }
  for (const key of ["env", "http_headers", "env_http_headers"] as const) {
    const value = config[key]
    if (value === undefined) continue
    if (!object(value)) fail(`${key} 必须是键值对象`)
    const active = key === "env" ? transport === "stdio" : transport === "http"
    for (const [k, v] of Object.entries(value as McpConfig)) {
      if (typeof v !== "string") fail(`${key}.${k} 必须是字符串`)
      if (!allowIncomplete && active && !k.trim()) fail(`${key} 的键不能为空`)
      if (!allowIncomplete && active && key === "env_http_headers" && !(v as string).trim())
        fail(`${key}.${k} 的环境变量名不能为空`)
    }
  }
  if (config.enabled !== undefined && typeof config.enabled !== "boolean")
    fail("enabled 必须是布尔值")
  if (allowIncomplete) return
  const required = transport === "stdio" ? "command" : "url"
  if (typeof config[required] !== "string" || !(config[required] as string).trim())
    fail(`${required} 不能为空`)
  if (
    transport === "http" &&
    config.bearer_token_env_var !== undefined &&
    !(config.bearer_token_env_var as string).trim()
  )
    fail("bearer_token_env_var 不能为空；不需要时请删除此字段")
  if (transport === "http" && config.url !== undefined) {
    try {
      const url = new URL(config.url as string)
      if (!["http:", "https:"].includes(url.protocol) || !url.hostname) throw new Error()
    } catch {
      fail("url 必须是有效的 http:// 或 https:// URL")
    }
  }
}

export function parseMcpJson(text: string, options: ParseOptions = {}): McpDocument {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `JSON 语法错误：${error instanceof Error ? error.message : "请检查括号、引号和逗号"}`
    )
  }
  checkDuplicateKeys(text)
  if (!object(value)) throw new Error("配置必须是 JSON 对象")
  let servers: McpEntry[]
  let extras: McpConfig = {}
  const wrapped = Object.hasOwn(value, "mcpServers")
  if (wrapped) {
    const { mcpServers, ...rest } = value
    if (!object(mcpServers)) throw new Error("mcpServers 必须是名称与配置组成的对象")
    servers = Object.entries(mcpServers).map(([name, config]) => {
      if (!object(config)) throw new Error(`${name} 的配置必须是对象`)
      return { name, config }
    })
    extras = rest
  } else {
    const { name, ...config } = value
    if (typeof name !== "string") throw new Error("单个配置必须包含字符串 name 字段")
    servers = [{ name, config }]
  }
  if (!servers.length) throw new Error("请添加至少一个 MCP 服务器")
  const names = new Set<string>()
  const existing = new Set((options.existingNames ?? []).map((name) => name.trim()))
  for (const entry of servers) {
    validateMcpEntry(entry, options.allowIncomplete)
    const key = entry.name.trim()
    if (names.has(key)) throw new Error(`名称重复：${key || "空名称"}`)
    if (existing.has(key)) throw new Error(`名称已存在：${key}。请使用其他名称，或编辑已有配置。`)
    names.add(key)
  }
  return { servers, extras, wrapped }
}

export function serializeMcpDocument(doc: McpDocument): string {
  const names = new Set<string>()
  for (const server of doc.servers) {
    const name = server.name.trim()
    if (names.has(name)) throw new Error(`名称重复：${name || "空名称"}`)
    names.add(name)
  }
  if (!doc.wrapped && doc.servers.length === 1) {
    return JSON.stringify({ ...doc.servers[0].config, name: doc.servers[0].name }, null, 2)
  }
  return JSON.stringify(
    { ...doc.extras, mcpServers: Object.fromEntries(doc.servers.map((s) => [s.name, s.config])) },
    null,
    2
  )
}

export interface McpForm {
  original: McpEntry
  name: string
  type: "stdio" | "http"
  command: string
  args: string[]
  env: McpPairs
  env_vars: string[]
  cwd: string
  url: string
  bearer_token_env_var: string
  http_headers: McpPairs
  env_http_headers: McpPairs
}

export function toMcpForm(entry: McpEntry): McpForm {
  const c = entry.config
  return {
    original: entry,
    name: entry.name,
    type: mcpTransport(c),
    command: (c.command as string) ?? "",
    args: (c.args as string[]) ?? [],
    env: Object.entries((c.env as Record<string, string>) ?? {}),
    env_vars: (c.env_vars as string[]) ?? [],
    cwd: (c.cwd as string) ?? "",
    url: (c.url as string) ?? "",
    bearer_token_env_var: (c.bearer_token_env_var as string) ?? "",
    http_headers: Object.entries((c.http_headers as Record<string, string>) ?? {}),
    env_http_headers: Object.entries((c.env_http_headers as Record<string, string>) ?? {}),
  }
}

export function fromMcpForm(form: McpForm): McpEntry {
  const config = { ...form.original.config }
  const initial = toMcpForm(form.original)
  for (const key of [
    "type",
    "command",
    "args",
    "env_vars",
    "cwd",
    "url",
    "bearer_token_env_var",
    "env",
    "http_headers",
    "env_http_headers",
  ] as const) {
    if (JSON.stringify(form[key]) === JSON.stringify(initial[key])) continue
    if (key === "env" || key === "http_headers" || key === "env_http_headers") {
      const names = new Set<string>()
      for (const [name] of form[key]) {
        if (!name.trim()) throw new Error(`${key} 的键不能为空；请填写或移除此行`)
        const normalized = key === "env" ? name : name.toLowerCase()
        if (names.has(normalized)) throw new Error(`${key} 中存在重复键：${name}`)
        names.add(normalized)
      }
      config[key] = Object.fromEntries(form[key])
    } else if ((key === "cwd" || key === "bearer_token_env_var") && form[key] === "") {
      delete config[key]
    } else {
      config[key] = form[key]
    }
  }
  return { name: form.name, config }
}

export const mcpStorageKey = (projectPath: string): string =>
  `openharness:mcp:local:v1:${JSON.stringify(projectPath)}`
export const emptyMcpDocument = (): McpDocument => ({ servers: [], extras: {}, wrapped: true })

export function loadMcpStorage(
  storage: StorageAccess,
  projectPath: string
): { document: McpDocument; raw: string | null } {
  const raw = storage.getItem(mcpStorageKey(projectPath))
  if (raw === null) return { document: emptyMcpDocument(), raw }
  const value: unknown = JSON.parse(raw)
  if (!object(value) || value.version !== 1 || !object(value.document))
    throw new Error("本机 MCP 配置格式无效，原始数据已保留")
  const document = value.document
  if (!Array.isArray(document.servers) || !object(document.extras))
    throw new Error("本机 MCP 配置格式无效，原始数据已保留")
  const servers = document.servers.map((s: unknown): McpEntry => {
    if (!object(s) || typeof s.name !== "string" || !object(s.config))
      throw new Error("本机 MCP 配置格式无效")
    return { name: s.name, config: s.config }
  })
  if (servers.length)
    parseMcpJson(serializeMcpDocument({ servers, extras: document.extras, wrapped: true }))
  return { document: { servers, extras: document.extras, wrapped: true }, raw }
}

export function saveMcpStorage(
  storage: StorageAccess,
  projectPath: string,
  document: McpDocument,
  expectedRaw: string | null
): string {
  if (storage.getItem(mcpStorageKey(projectPath)) !== expectedRaw)
    throw new Error("本机配置已被其他窗口修改，请刷新后重试；当前编辑内容已保留")
  if (document.servers.length) parseMcpJson(serializeMcpDocument({ ...document, wrapped: true }))
  const raw = JSON.stringify({ version: 1, document: { ...document, wrapped: true } })
  storage.setItem(mcpStorageKey(projectPath), raw)
  return raw
}
