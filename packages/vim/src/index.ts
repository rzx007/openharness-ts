export type VimMode = "normal" | "insert" | "visual" | "command";

export interface VimTransition {
  from: VimMode;
  to: VimMode;
  key: string;
}

export class VimModeHandler {
  private mode: VimMode = "normal";

  getMode(): VimMode {
    return this.mode;
  }

  handleKey(key: string): VimTransition {
    const from = this.mode;

    switch (this.mode) {
      case "normal":
        if (key === "i" || key === "a" || key === "o") this.mode = "insert";
        if (key === "v") this.mode = "visual";
        if (key === ":") this.mode = "command";
        break;
      case "insert":
        if (key === "Escape") this.mode = "normal";
        break;
      case "visual":
        if (key === "Escape") this.mode = "normal";
        break;
      case "command":
        if (key === "Escape" || key === "Enter") this.mode = "normal";
        break;
    }

    return { from, to: this.mode, key };
  }

  reset(): void {
    this.mode = "normal";
  }
}
