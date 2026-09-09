import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Check } from "lucide-react"
import type {
  DesktopSkillInfo,
  DesktopSkillProject,
  DesktopSkillSnapshot,
} from "@shared/skill-types"
import { Alert, AlertDescription } from "@renderer/components/ui/alert"
import { Separator } from "@renderer/components/ui/separator"
import { Skeleton } from "@renderer/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@renderer/components/ui/tabs"
import { SkillIcon } from "./skill-controls"
import { SkillDetail } from "./skill-detail"

export interface SkillManagerProps {
  query: string
  refreshRequest: number
  projectPath: string
  notify: (message: string) => void
}

export function SkillManager({
  query,
  refreshRequest,
  projectPath,
  notify,
}: SkillManagerProps): React.JSX.Element {
  const api = window.desktop.skills
  const [snapshot, setSnapshot] = useState<DesktopSkillSnapshot | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [category, setCategory] = useState(() => `project:${pathKey(projectPath)}`)
  const requestId = useRef(0)
  const previousRefresh = useRef(refreshRequest)

  const load = useCallback(
    async (announce = false): Promise<void> => {
      const id = ++requestId.current
      try {
        const result = await api.snapshot({ projectPath })
        if (id !== requestId.current) return
        setSnapshot(result)
        setError("")
        if (announce) notify("技能目录已重新加载。")
      } catch (cause) {
        if (id === requestId.current) setError(message(cause))
      } finally {
        if (id === requestId.current) setLoading(false)
      }
    },
    [api, notify, projectPath]
  )

  useEffect(() => {
    // The first read synchronizes this view with the main-process filesystem service.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])
  useEffect(() => {
    if (refreshRequest === previousRefresh.current) return
    previousRefresh.current = refreshRequest
    void load(true)
  }, [load, refreshRequest])

  const skills = snapshot?.skills ?? []
  const categories = useMemo(() => {
    const ordered = snapshot?.projects ?? []
    const current = ordered.find((item) => pathKey(item.path) === pathKey(projectPath))
    return [
      ...(current ? [current] : []),
      { name: "个人", path: "" },
      ...ordered.filter((item) => item !== current),
    ]
  }, [projectPath, snapshot?.projects])
  const activeCategory = categories.some((item) => categoryId(item) === category)
    ? category
    : categoryId(categories[0] ?? { name: "个人", path: "" })
  const needle = query.trim().toLocaleLowerCase()
  const matches = (skill: DesktopSkillInfo): boolean =>
    !needle ||
    `${skill.name} ${skill.description} ${skill.projectName ?? ""}`
      .toLocaleLowerCase()
      .includes(needle)
  const installed = skills.filter(matches)
  const selected = skills.find((skill) => skill.id === selectedId)

  function skillsFor(item: DesktopSkillProject): DesktopSkillInfo[] {
    return skills.filter(
      (skill) =>
        matches(skill) &&
        (item.path
          ? skill.source === "project" && pathKey(skill.projectPath ?? "") === pathKey(item.path)
          : skill.source === "personal")
    )
  }
  async function remove(skill: DesktopSkillInfo): Promise<string | null> {
    try {
      ++requestId.current
      const next = await api.remove({
        id: skill.id,
        expectedContent: skill.content,
        projectPath,
      })
      ++requestId.current
      setSnapshot(next)
      setSelectedId(null)
      notify(`${skill.name} 已删除。`)
      return null
    } catch (cause) {
      return message(cause)
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-8">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {snapshot?.warnings.length ? (
        <Alert>
          <AlertDescription>{snapshot.warnings.join("；")}</AlertDescription>
        </Alert>
      ) : null}
      <section aria-label="已安装技能" className="flex flex-col gap-3">
        <h2 className="text-[15px] font-semibold">已安装</h2>
        <Separator />
        {loading ? (
          <div className="grid grid-cols-1 gap-x-8 gap-y-3 md:grid-cols-2">
            {[1, 2, 3, 4, 5, 6].map((id) => (
              <Skeleton key={id} className="h-14 w-full" />
            ))}
          </div>
        ) : installed.length ? (
          <>
            <SkillRows
              skills={expanded ? installed : installed.slice(0, 6)}
              onOpen={setSelectedId}
            />
            {installed.length > 6 ? (
              <button
                type="button"
                className="self-start rounded-sm px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded
                  ? "收起"
                  : `查看 ${installed
                      .slice(6, 8)
                      .map((skill) => skill.name)
                      .join(
                        "、"
                      )}${installed.length > 7 ? `，另有 ${installed.length - 6} 项` : ""}`}
              </button>
            ) : null}
          </>
        ) : (
          <p className="py-3 text-sm text-muted-foreground">
            {needle ? "没有匹配的技能。" : "没有发现技能。"}
          </p>
        )}
      </section>

      {!loading ? (
        <Tabs
          value={activeCategory}
          onValueChange={(value) => setCategory(String(value))}
          className="gap-5"
        >
          <TabsList
            aria-label="技能来源"
            className="h-auto! max-w-full flex-wrap justify-start gap-1 bg-transparent p-0"
          >
            {categories.map((item) => (
              <TabsTrigger
                key={categoryId(item)}
                value={categoryId(item)}
                title={item.name}
                className="h-8 max-w-full min-w-0 flex-none rounded-full px-3 data-active:border-transparent! data-active:bg-muted! data-active:shadow-none!"
              >
                <span className="truncate">{item.name}</span>
              </TabsTrigger>
            ))}
          </TabsList>
          {categories.map((item) => (
            <TabsContent key={categoryId(item)} value={categoryId(item)}>
              {skillsFor(item).length ? (
                <SkillRows skills={skillsFor(item)} onOpen={setSelectedId} />
              ) : (
                <p className="py-3 text-sm text-muted-foreground">暂无技能</p>
              )}
            </TabsContent>
          ))}
        </Tabs>
      ) : null}

      {selected ? (
        <SkillDetail
          skill={selected}
          notify={notify}
          onClose={() => setSelectedId(null)}
          {...(!selected.readOnly ? { onRemove: () => remove(selected) } : {})}
        />
      ) : null}
    </div>
  )
}

function SkillRows({
  skills,
  onOpen,
}: {
  skills: DesktopSkillInfo[]
  onOpen: (id: string) => void
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2">
      {skills.map((skill) => (
        <button
          key={skill.id}
          type="button"
          data-extension-row
          className="group flex min-h-16 min-w-0 items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => onOpen(skill.id)}
          aria-label={`查看 ${skill.name}，${skill.readOnly ? "只读" : skill.source === "personal" ? "个人" : (skill.projectName ?? "项目")}`}
        >
          <SkillIcon name={skill.name} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm font-medium">{skill.name}</span>
            <span
              className="truncate text-xs leading-5 text-muted-foreground"
              title={skill.description}
            >
              {skill.description}
            </span>
          </span>
          <Check className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      ))}
    </div>
  )
}

function pathKey(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase()
}
function categoryId(project: DesktopSkillProject): string {
  return project.path ? `project:${pathKey(project.path)}` : "personal"
}
function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : "技能操作失败，请重试。"
}
