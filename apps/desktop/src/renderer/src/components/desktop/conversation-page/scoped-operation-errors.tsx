import { CircleAlert } from "lucide-react"

import { Alert, AlertDescription } from "@renderer/components/ui/alert"

export function ScopedOperationError({
  error,
}: {
  error: string | null
}): React.JSX.Element | null {
  if (!error) return null

  return (
    <Alert variant="destructive" aria-live="assertive">
      <CircleAlert />
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  )
}
