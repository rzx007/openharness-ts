import { Braces, Globe, Mail, FolderOpen, Plug, Database } from "lucide-react"
import Github from "@lobehub/icons/es/Github/components/Mono"
import Figma from "@lobehub/icons/es/Figma/components/Color"
import Notion from "@lobehub/icons/es/Notion/components/Mono"
import Google from "@lobehub/icons/es/Google/components/Color"

export function ExtensionIcon({ name }: { name: string }): React.JSX.Element {
  const normalized = name.toLowerCase()
  const icon = normalized.includes("github") ? (
    <Github size={25} />
  ) : normalized.includes("figma") ? (
    <Figma size={25} />
  ) : normalized.includes("notion") ? (
    <Notion size={25} />
  ) : normalized.includes("google") ? (
    <Google size={25} />
  ) : /mail|邮件/.test(normalized) ? (
    <Mail className="size-6" />
  ) : /browser|浏览/.test(normalized) ? (
    <Globe className="size-6" />
  ) : /files|文件/.test(normalized) ? (
    <FolderOpen className="size-6" />
  ) : /database|数据库/.test(normalized) ? (
    <Database className="size-6" />
  ) : /context|检索/.test(normalized) ? (
    <Braces className="size-6" />
  ) : (
    <Plug className="size-6" />
  )
  return (
    <span
      className="grid size-11 shrink-0 place-items-center rounded-xl border border-border/60 bg-background"
      aria-hidden="true"
    >
      {icon}
    </span>
  )
}
