export interface SelectedProjectGitRefreshScheduler {
  schedule: (force: boolean) => void
  reset: () => void
  dispose: () => void
}

export function createSelectedProjectGitRefreshScheduler(
  refresh: (options: { force: boolean }) => Promise<unknown>,
  delayMs: number
): SelectedProjectGitRefreshScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null
  let force = false
  let disposed = false

  const reset = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    force = false
  }

  return {
    schedule(nextForce) {
      if (disposed) return
      if (timer) clearTimeout(timer)
      force ||= nextForce
      timer = setTimeout(() => {
        timer = null
        const refreshForce = force
        force = false
        void refresh({ force: refreshForce })
      }, delayMs)
    },
    reset,
    dispose() {
      reset()
      disposed = true
    },
  }
}
