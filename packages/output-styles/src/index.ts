export interface OutputStyleDefinition {
  id: string;
  name: string;
  description: string;
  format: (content: string) => string;
}

const defaultStyle: OutputStyleDefinition = {
  id: "default",
  name: "Default",
  description: "Plain text output",
  format: (content) => content,
};

export class OutputStyleLoader {
  private styles = new Map<string, OutputStyleDefinition>([
    [defaultStyle.id, defaultStyle],
  ]);

  register(style: OutputStyleDefinition): void {
    this.styles.set(style.id, style);
  }

  get(id: string): OutputStyleDefinition | undefined {
    return this.styles.get(id);
  }

  getAll(): OutputStyleDefinition[] {
    return [...this.styles.values()];
  }
}
