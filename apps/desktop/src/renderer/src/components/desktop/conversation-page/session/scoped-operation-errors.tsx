import { CircleAlert } from "lucide-react"

import { Alert, AlertDescription } from "@renderer/components/ui/alert"

export function ScopedOperationError({
  error,
  onDismiss,
}: {
  error: string | null
  onDismiss?: () => void
}): React.JSX.Element | null {
  if (!error) return null

  return (
    <Alert variant="destructive" aria-live="assertive">
      <CircleAlert />
      <AlertDescription>
        {error}
        {onDismiss ? (
          <button type="button" className="ml-2 underline" onClick={onDismiss}>
            关闭
          </button>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}
