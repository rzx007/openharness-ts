export type ConversionFidelity = "exact" | "adapted" | "unsupported" | "blocked";
export interface ConverterDiagnostic { severity: "info" | "warning" | "error"; code: string; message: string; component?: string; }
export interface ConversionItem { id: string; sourceKind: string; sourcePath?: string; targetKind?: string; fidelity: ConversionFidelity; reason?: string; requiredApprovals?: string[]; }
export interface ConversionPlan { schemaVersion: 1; converterId: string; converterVersion: string; sourceFormat: string; sourceDigest: string; optionsDigest: string; mappingVersion: string; items: ConversionItem[]; diagnostics: ConverterDiagnostic[]; }
export interface ConversionReport { schemaVersion: 1; status: "success" | "partial" | "blocked" | "failed"; items: ConversionItem[]; diagnostics: ConverterDiagnostic[]; }
export interface SourceInspection { root: string; format: string; identity: { id: string; name: string; version: string }; inventory: Record<string, string[]>; diagnostics: ConverterDiagnostic[]; }
export interface DetectionResult { converterId: string; confidence: number; evidence: string[]; }
export interface PluginConverter {
  id: string; version: string; sourceFormat: string;
  detect(root: string): Promise<DetectionResult | null>;
  inspect(root: string): Promise<SourceInspection>;
  plan(inspection: SourceInspection, options?: Record<string, unknown>): Promise<ConversionPlan>;
  convert(input: { inspection: SourceInspection; plan: ConversionPlan; output: string; approvals?: string[] }): Promise<ConversionReport>;
}
