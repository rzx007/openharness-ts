import type { DetectionResult, PluginConverter } from "./converter.js";
export class ConverterRegistry {
  private converters = new Map<string, PluginConverter>();
  register(converter: PluginConverter): void { if (this.converters.has(converter.id)) throw new Error(`Duplicate converter: ${converter.id}`); this.converters.set(converter.id, converter); }
  get(id: string): PluginConverter | undefined { return this.converters.get(id); }
  async detect(root: string, explicitId?: string): Promise<{ converter: PluginConverter; detection: DetectionResult }> {
    if (explicitId) { const converter = this.get(explicitId); if (!converter) throw new Error(`Unknown converter: ${explicitId}`); const detection = await converter.detect(root); if (!detection) throw new Error(`Source does not match converter: ${explicitId}`); return { converter, detection }; }
    const matches: Array<{ converter: PluginConverter; detection: DetectionResult }> = [];
    for (const converter of this.converters.values()) { try { const detection = await converter.detect(root); if (detection) matches.push({ converter, detection }); } catch {} }
    matches.sort((a, b) => b.detection.confidence - a.detection.confidence || a.converter.id.localeCompare(b.converter.id));
    if (!matches.length) throw new Error("No plugin converter matched the source");
    if (matches[1] && matches[1].detection.confidence === matches[0]!.detection.confidence) throw new Error("Ambiguous plugin source; specify --from");
    return matches[0]!;
  }
}
