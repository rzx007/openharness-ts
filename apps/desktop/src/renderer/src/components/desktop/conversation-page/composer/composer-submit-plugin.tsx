import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext"
import { useEffect } from "react"
import { COMMAND_PRIORITY_LOW, KEY_ENTER_COMMAND } from "lexical"

export function ComposerSubmitPlugin({ onSubmit }: { onSubmit: () => void }): null {
  const [editor] = useLexicalComposerContext()
  useEffect(
    () => editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event: KeyboardEvent | null) => {
        if (!event || event.shiftKey || event.defaultPrevented) return false
        event.preventDefault()
        onSubmit()
        return true
      },
      COMMAND_PRIORITY_LOW,
    ),
    [editor, onSubmit],
  )
  return null
}
