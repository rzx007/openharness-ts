import { ChevronDown, Goal, Pause, Trash2, X } from "lucide-react"
import { useState } from "react"
import { Button } from "@renderer/components/ui/button"
import type { DesktopSessionGoalActionInput, SessionGoal } from "@shared/session-types"

const labels: Record<SessionGoal["status"], string> = {
  active: "正在推进目标",
  waiting_user: "目标等待你的处理",
  blocked: "目标暂时受阻",
  paused: "已暂停的目标",
  completed: "目标已完成",
  cancelled: "目标已取消",
}

export function GoalBanner({
  goal,
  busy,
  stopping,
  onAction,
  onEdit,
  onDismiss,
}: {
  goal: SessionGoal
  busy: boolean
  stopping: boolean
  onAction: (
    input: Pick<
      DesktopSessionGoalActionInput,
      "action" | "additionalAutoTurns" | "questionId" | "response"
    >
  ) => void
  onEdit: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [additionalAutoTurns, setAdditionalAutoTurns] = useState(20)
  const [response, setResponse] = useState("")
  const terminal = goal.status === "completed" || goal.status === "cancelled"
  const quotaExhausted = goal.autoTurnsUsed >= goal.maxAutoTurns
  const validQuota =
    Number.isSafeInteger(additionalAutoTurns) &&
    additionalAutoTurns > 0 &&
    goal.maxAutoTurns + additionalAutoTurns <= 1000
  const resume = (): void =>
    onAction({ action: "resume", ...(quotaExhausted ? { additionalAutoTurns } : {}) })
  return (
    <div className="rounded-xl border border-border/70 bg-background/95 px-3 text-sm shadow-sm">
      <div className="flex min-h-10 items-center gap-2">
        <Goal className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">
          {stopping ? "正在停止目标" : labels[goal.status]}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{goal.objective}</span>
        {goal.status === "active" ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={busy}
            aria-label="暂停目标"
            onClick={() => onAction({ action: "pause" })}
          >
            <Pause />
          </Button>
        ) : null}
        {goal.status === "paused" || goal.status === "blocked" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy || stopping}
            onClick={() => (quotaExhausted ? setExpanded(true) : resume())}
          >
            {goal.status === "blocked" ? "检查并继续" : "继续"}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={expanded ? "收起目标详情" : "展开目标详情"}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronDown />
        </Button>
        {terminal ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="收起目标"
            onClick={onDismiss}
          >
            <X />
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={busy}
            aria-label="取消目标"
            onClick={() => onAction({ action: "cancel" })}
          >
            <Trash2 />
          </Button>
        )}
      </div>
      {goal.reason || goal.wait ? (
        <div className="pb-2 text-xs text-muted-foreground">
          {goal.wait?.kind === "user" ? goal.wait.question : goal.reason}
          {goal.wait?.kind === "approval" ? " 请处理上方对应的授权请求。" : null}
        </div>
      ) : null}
      {expanded ? (
        <div className="space-y-3 border-t py-3">
          <p className="break-words whitespace-pre-wrap">{goal.objective}</p>
          <p className="text-xs text-muted-foreground">
            自动续跑 {goal.autoTurnsUsed} / {goal.maxAutoTurns} 次
          </p>
          {goal.evidence.length > 0 ? (
            <ul className="list-disc space-y-1 pl-4 text-xs">
              {goal.evidence.map((item, index) => (
                <li key={index} className="break-words">
                  {item}
                </li>
              ))}
            </ul>
          ) : null}
          {!terminal ? (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onEdit}>
              编辑目标
            </Button>
          ) : null}
          {quotaExhausted && !terminal ? (
            <div className="flex items-center gap-2 text-xs">
              <label>
                增加额度{" "}
                <input
                  aria-label="增加自动续跑额度"
                  type="number"
                  min={1}
                  max={1000 - goal.maxAutoTurns}
                  step={1}
                  disabled={busy}
                  value={additionalAutoTurns}
                  onChange={(event) => setAdditionalAutoTurns(Number(event.target.value))}
                  className="w-16 rounded border px-1"
                />
              </label>
              {goal.status === "paused" || goal.status === "blocked" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy || stopping || !validQuota}
                  onClick={resume}
                >
                  增加额度并继续
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {goal.status === "waiting_user" && goal.wait?.kind === "user" ? (
        <form
          key={goal.wait.questionId}
          className="flex flex-wrap items-center gap-2 border-t py-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (
              goal.wait?.kind !== "user" ||
              busy ||
              !response.trim() ||
              (quotaExhausted && (!expanded || !validQuota))
            )
              return
            onAction({
              action: "resume",
              questionId: goal.wait.questionId,
              response: response.trim(),
              ...(quotaExhausted ? { additionalAutoTurns } : {}),
            })
          }}
        >
          <input
            aria-label="回答目标问题"
            placeholder="填写答复以继续"
            disabled={busy}
            value={response}
            onChange={(event) => setResponse(event.target.value)}
            className="min-w-0 flex-1 rounded border px-2 py-1 text-xs"
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={busy || !response.trim() || (quotaExhausted && (!expanded || !validQuota))}
          >
            {quotaExhausted ? "增加额度并答复" : "答复并继续"}
          </Button>
          {quotaExhausted && !expanded ? (
            <span className="text-xs">额度已用完，请先展开详情增加额度。</span>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              if (goal.wait?.kind === "user")
                onAction({ action: "confirm", questionId: goal.wait.questionId })
            }}
          >
            确认目标已完成
          </Button>
        </form>
      ) : null}
    </div>
  )
}
