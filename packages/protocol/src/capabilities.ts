export interface ProtocolVersion {
  version: number;
}

export interface ServerCapabilities {
  serverVersion: string;
  protocol: ProtocolVersion;
  features: Record<string, number>;
}

export interface ClientProtocolSupport {
  version: number;
}

export interface ProtocolCompatibility {
  compatible: boolean;
  reason?: string;
}

export function parseServerCapabilities(value: unknown): ServerCapabilities {
  if (!isRecord(value)) throw new Error("Capabilities response must be an object");
  if (typeof value.serverVersion !== "string") throw new Error("serverVersion must be a string");
  if (!isRecord(value.protocol)) throw new Error("protocol must be an object");
  const version = positiveInteger(value.protocol.version, "protocol.version");
  if (!isRecord(value.features)) throw new Error("features must be an object");
  const features: Record<string, number> = {};
  for (const [name, version] of Object.entries(value.features)) {
    features[name] = positiveInteger(version, `features.${name}`);
  }
  return { serverVersion: value.serverVersion, protocol: { version }, features };
}

export function checkProtocolCompatibility(
  server: ServerCapabilities,
  client: ClientProtocolSupport,
): ProtocolCompatibility {
  if (client.version !== server.protocol.version) {
    return {
      compatible: false,
      reason: `Client protocol ${client.version} does not match server protocol ${server.protocol.version}`,
    };
  }
  return { compatible: true };
}

export function supportsFeature(
  capabilities: ServerCapabilities,
  feature: string,
  minimumVersion = 1,
): boolean {
  return (capabilities.features[feature] ?? 0) >= minimumVersion;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${field} must be a positive integer`);
  return Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
