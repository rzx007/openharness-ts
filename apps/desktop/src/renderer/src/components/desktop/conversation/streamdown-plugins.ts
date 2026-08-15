import type { CustomRenderer, PluginConfig } from "streamdown"

import { MermaidDiagram } from "./mermaid-diagram"

const customRenderers: CustomRenderer[] = [
  {
    component: MermaidDiagram,
    language: ["mermaid", "mmd"],
  },
]

export const streamdownPlugins: PluginConfig = {
  renderers: customRenderers,
}
