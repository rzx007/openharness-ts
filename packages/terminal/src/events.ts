export type TerminalEventListener = (event: TerminalEvent) => void

export type TerminalEvent =
  | { type: "data"; terminalId: string; data: string; sequence: number }
  | { type: "status"; terminalId: string; status: "stopping" | "killed" }
  | { type: "exit"; terminalId: string; exitCode: number | null }
  | { type: "title"; terminalId: string; title: string }
  | { type: "error"; terminalId: string; message: string }

export class TerminalEventBus {
  private readonly listeners = new Set<TerminalEventListener>()

  subscribe(listener: TerminalEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(event: TerminalEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  clear(): void {
    this.listeners.clear()
  }
}
