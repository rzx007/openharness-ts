export interface ConversionBehaviorIdentity {
  sourceDigest: string;
  converterVersion: string;
  targetSchemaVersion: number;
  optionsDigest: string;
  mappingVersion: string;
}
export function needsReconversion(previous: ConversionBehaviorIdentity, current: ConversionBehaviorIdentity): boolean {
  return previous.sourceDigest !== current.sourceDigest
    || previous.converterVersion !== current.converterVersion
    || previous.targetSchemaVersion !== current.targetSchemaVersion
    || previous.optionsDigest !== current.optionsDigest
    || previous.mappingVersion !== current.mappingVersion;
}
