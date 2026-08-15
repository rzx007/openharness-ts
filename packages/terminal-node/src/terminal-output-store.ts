import type { TerminalReadResult } from "@openharness/terminal"

const defaultMaxCharacters = 200_000

export class TerminalOutputStore {
  private data = ""
  private sequence = 0
  private truncated = false

  constructor(private readonly maxCharacters = defaultMaxCharacters) {}

  append(terminalId: string, data: string): TerminalReadResult {
    this.sequence += 1
    this.data += data

    if (this.data.length > this.maxCharacters) {
      this.data = this.data.slice(this.data.length - this.maxCharacters)
      this.truncated = true
    }

    return this.read(terminalId)
  }

  read(terminalId: string): TerminalReadResult {
    return {
      terminalId,
      data: this.data,
      sequence: this.sequence,
      truncated: this.truncated,
    }
  }
}
