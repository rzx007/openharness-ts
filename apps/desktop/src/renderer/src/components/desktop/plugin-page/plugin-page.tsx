import { ScrollArea } from "@renderer/components/ui/scroll-area"
import { PluginSettings } from "../settings-page/plugin-settings"

export function PluginPage(): React.JSX.Element {
  return (
    <section className="flex h-full min-h-0 w-full flex-col bg-background">
      <ScrollArea horizontal={false} className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-7 px-8 py-10 lg:px-10">
          <header className="flex flex-col gap-1.5">
            <h1 className="text-xl font-semibold tracking-tight">插件</h1>
            <p className="text-ui-small max-w-2xl leading-5 text-pretty text-muted-foreground">
              查看和控制当前项目可用的原生、转换、本地链接与托管插件。
            </p>
          </header>
          <PluginSettings />
        </div>
      </ScrollArea>
    </section>
  )
}
