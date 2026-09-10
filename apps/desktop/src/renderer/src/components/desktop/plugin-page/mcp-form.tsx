import { useId } from "react"
import { Plus, Trash2 } from "lucide-react"
import { Button } from "@renderer/components/ui/button"
import { Input } from "@renderer/components/ui/input"
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@renderer/components/ui/field"
import { ToggleGroup, ToggleGroupItem } from "@renderer/components/ui/toggle-group"
import type { McpForm, McpPairs } from "./mcp-config"

function AddRowButton({
  children,
  onClick,
}: {
  children: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      className="h-8 w-full rounded-lg bg-muted/70 text-muted-foreground hover:bg-muted hover:text-foreground"
      onClick={onClick}
    >
      <Plus data-icon="inline-start" />
      {children}
    </Button>
  )
}

function RemoveRowButton({
  label,
  onClick,
}: {
  label: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="shrink-0 text-muted-foreground"
      aria-label={label}
      onClick={onClick}
    >
      <Trash2 />
    </Button>
  )
}

function StringRows({
  label,
  addLabel,
  values,
  onChange,
  errorId,
  invalid,
}: {
  label: string
  addLabel: string
  values: string[]
  onChange: (values: string[]) => void
  errorId?: string
  invalid?: boolean
}): React.JSX.Element {
  const id = useId()
  const rows = values.length ? values : [""]
  return (
    <FieldSet className="gap-2">
      <FieldLegend variant="label">{label}</FieldLegend>
      <FieldGroup className="gap-2">
        {rows.map((value, index) => (
          <Field key={index} orientation="horizontal" data-invalid={invalid}>
            <FieldLabel className="sr-only" htmlFor={`${id}-${index}`}>
              {label} {index + 1}
            </FieldLabel>
            <Input
              id={`${id}-${index}`}
              value={value}
              aria-invalid={invalid}
              aria-describedby={invalid ? errorId : undefined}
              onChange={(event) => {
                const next = values.length ? [...values] : [""]
                next[index] = event.target.value
                onChange(next)
              }}
            />
            <RemoveRowButton
              label={`移除${label} ${index + 1}`}
              onClick={() => onChange(values.filter((_, item) => item !== index))}
            />
          </Field>
        ))}
      </FieldGroup>
      <AddRowButton onClick={() => onChange(values.length ? [...values, ""] : ["", ""])}>
        {addLabel}
      </AddRowButton>
    </FieldSet>
  )
}

function PairRows({
  label,
  addLabel,
  values,
  onChange,
  errorId,
  invalid,
}: {
  label: string
  addLabel: string
  values: McpPairs
  onChange: (values: McpPairs) => void
  errorId?: string
  invalid?: boolean
}): React.JSX.Element {
  const id = useId()
  const rows = values.length ? values : [["", ""]]
  function update(index: number, column: 0 | 1, value: string): void {
    const next: McpPairs = values.length
      ? values.map((pair): [string, string] => [pair[0], pair[1]])
      : [["", ""]]
    next[index][column] = value
    onChange(next)
  }
  return (
    <FieldSet className="gap-2">
      <FieldLegend variant="label">{label}</FieldLegend>
      <FieldGroup className="gap-2">
        {rows.map(([key, value], index) => (
          <Field key={index} orientation="horizontal" data-invalid={invalid}>
            <FieldLabel className="sr-only" htmlFor={`${id}-${index}-key`}>
              {label} {index + 1} 键
            </FieldLabel>
            <Input
              id={`${id}-${index}-key`}
              aria-label={`${label} ${index + 1} 键`}
              placeholder="键"
              value={key}
              aria-invalid={invalid}
              aria-describedby={invalid ? errorId : undefined}
              onChange={(event) => update(index, 0, event.target.value)}
            />
            <FieldLabel className="sr-only" htmlFor={`${id}-${index}-value`}>
              {label} {index + 1} 值
            </FieldLabel>
            <Input
              id={`${id}-${index}-value`}
              aria-label={`${label} ${index + 1} 值`}
              placeholder="值"
              value={value}
              aria-invalid={invalid}
              aria-describedby={invalid ? errorId : undefined}
              onChange={(event) => update(index, 1, event.target.value)}
            />
            <RemoveRowButton
              label={`移除${label} ${index + 1}`}
              onClick={() => onChange(values.filter((_, item) => item !== index))}
            />
          </Field>
        ))}
      </FieldGroup>
      <AddRowButton
        onClick={() =>
          onChange(
            values.length
              ? [...values, ["", ""]]
              : [
                  ["", ""],
                  ["", ""],
                ]
          )
        }
      >
        {addLabel}
      </AddRowButton>
    </FieldSet>
  )
}

export function McpFormFields({
  value,
  onChange,
  error,
  errorId,
}: {
  value: McpForm
  onChange: (value: McpForm) => void
  error: string
  errorId: string
}): React.JSX.Element {
  const id = useId()
  const invalid = (key: string): boolean => Boolean(error && error.includes(key))
  function update<K extends keyof McpForm>(key: K, next: McpForm[K]): void {
    onChange({ ...value, [key]: next })
  }
  function text(
    key: "name" | "command" | "cwd" | "url" | "bearer_token_env_var",
    label: string,
    placeholder: string
  ): React.JSX.Element {
    const bad = invalid(key === "name" ? "名称" : key)
    return (
      <Field data-invalid={bad}>
        <FieldLabel htmlFor={`${id}-${key}`}>{label}</FieldLabel>
        <Input
          id={`${id}-${key}`}
          value={value[key]}
          placeholder={placeholder}
          aria-invalid={bad}
          aria-describedby={bad ? errorId : undefined}
          onChange={(event) => update(key, event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
    )
  }
  return (
    <FieldGroup className="gap-3">
      <section
        data-mcp-form-card
        className="flex flex-col gap-4 rounded-2xl border border-border/80 p-4"
      >
        {text("name", "名称", "MCP server name")}
        <div className="flex items-center justify-between gap-3">
          <FieldLabel id={`${id}-type`} className="mb-0">
            类型
          </FieldLabel>
          <ToggleGroup
            aria-labelledby={`${id}-type`}
            value={[value.type]}
            onValueChange={(next) => {
              if (next[0]) update("type", next[0] as McpForm["type"])
            }}
            spacing={0}
            size="sm"
          >
            <ToggleGroupItem value="stdio" className="rounded-md px-3">
              STDIO
            </ToggleGroupItem>
            <ToggleGroupItem value="http" className="rounded-md px-3">
              流式 HTTP
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </section>
      <section
        data-mcp-form-card
        className="flex flex-col gap-4 rounded-2xl border border-border/80 p-4"
      >
        {value.type === "stdio" ? (
          <>
            {text("command", "启动命令", "openai-dev-mcp serve-sqlite")}
            <StringRows
              label="参数"
              addLabel="添加参数"
              values={value.args}
              onChange={(next) => update("args", next)}
              invalid={invalid("args")}
              errorId={errorId}
            />
            <PairRows
              label="环境变量"
              addLabel="添加环境变量"
              values={value.env}
              onChange={(next) => update("env", next)}
              invalid={invalid("env")}
              errorId={errorId}
            />
            <StringRows
              label="环境变量传递"
              addLabel="添加变量"
              values={value.env_vars}
              onChange={(next) => update("env_vars", next)}
              invalid={invalid("env_vars")}
              errorId={errorId}
            />
            {text("cwd", "工作目录", "~/code")}
          </>
        ) : (
          <>
            {text("url", "URL", "https://mcp.example.com/mcp")}
            {text("bearer_token_env_var", "Bearer 令牌环境变量", "MCP_BEARER_TOKEN")}
            <PairRows
              label="标头"
              addLabel="添加标头"
              values={value.http_headers}
              onChange={(next) => update("http_headers", next)}
              invalid={invalid("http_headers")}
              errorId={errorId}
            />
            <PairRows
              label="来自环境变量的标头"
              addLabel="添加变量"
              values={value.env_http_headers}
              onChange={(next) => update("env_http_headers", next)}
              invalid={invalid("env_http_headers")}
              errorId={errorId}
            />
          </>
        )}
      </section>
    </FieldGroup>
  )
}
