import { FilePlus, FolderPlus, ImagePlus } from "lucide-react"

import type { PlusMenuItem } from "@renderer/components/ui/plus-menu"

export function createComposerAttachmentMenuItems(): PlusMenuItem[] {
  return [
    { id: "file", label: "添加文件", icon: <FilePlus /> },
    { id: "image", label: "添加图片", icon: <ImagePlus /> },
    {
      id: "folder",
      label: "添加文件夹",
      description: "后续版本开放",
      icon: <FolderPlus />,
      disabled: true,
    },
  ]
}
