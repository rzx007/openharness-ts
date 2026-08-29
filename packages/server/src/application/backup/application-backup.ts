import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { SessionStore } from "@openharness/services";

export interface BackupSourceDirectories {
  artifacts?: string;
  memory?: string;
  executionOutput?: string;
  attachments?: string;
}

export interface ApplicationBackupManifest {
  version: 1 | 2;
  backupId: string;
  createdAt: number;
  database: "database.sqlite";
  directories: Record<"artifacts" | "memory" | "execution-output" | "attachments", boolean>;
  attachments?: {
    assets: number;
    uniqueBlobs: number;
    physicalBytes: number;
  };
  recovery: {
    reviveLiveProcesses: false;
    closeActiveRecordsOnStartup: true;
  };
}

export async function createApplicationBackup(input: {
  store: SessionStore;
  destination: string;
  sources?: BackupSourceDirectories;
}): Promise<ApplicationBackupManifest> {
  const destination = resolve(input.destination);
  if (existsSync(destination) && readdirSync(destination).length > 0) {
    throw new Error(`Backup destination is not empty: ${destination}`);
  }
  for (const source of [input.sources?.artifacts, input.sources?.memory, input.sources?.executionOutput]) {
    if (source) assertDestinationOutsideSource(destination, source);
  }
  if (input.sources?.attachments) assertDestinationOutsideSource(destination, input.sources.attachments);
  const attachmentStats = validateAttachmentFiles(
    input.store,
    input.sources?.attachments,
  );
  mkdirSync(destination, { recursive: true });
  await input.store.backupDatabase(join(destination, "database.sqlite"));
  const directories = {
    artifacts: copyOptionalDirectory(input.sources?.artifacts, join(destination, "artifacts")),
    memory: copyOptionalDirectory(input.sources?.memory, join(destination, "memory")),
    "execution-output": copyOptionalDirectory(
      input.sources?.executionOutput,
      join(destination, "execution-output"),
    ),
    attachments: copyOptionalDirectory(
      input.sources?.attachments,
      join(destination, "attachments"),
    ),
  };
  const manifest: ApplicationBackupManifest = {
    version: 2,
    backupId: randomUUID(),
    createdAt: Date.now(),
    database: "database.sqlite",
    directories,
    attachments: attachmentStats,
    recovery: {
      reviveLiveProcesses: false,
      closeActiveRecordsOnStartup: true,
    },
  };
  writeFileSync(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  writeFileSync(
    join(destination, "checksums.json"),
    JSON.stringify(checksumsFor(destination, ["checksums.json"]), null, 2) + "\n",
    "utf-8",
  );
  validateBackupAttachmentFiles(destination, manifest);
  return manifest;
}

export function restoreApplicationBackup(input: {
  source: string;
  storePath: string;
  destinations?: BackupSourceDirectories;
}): ApplicationBackupManifest {
  const source = resolve(input.source);
  const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf-8")) as ApplicationBackupManifest;
  if (![1, 2].includes(manifest.version) || manifest.database !== "database.sqlite") {
    throw new Error("Unsupported backup manifest");
  }
  if (!isDirectoryManifest(manifest.directories)) {
    throw new Error("Invalid backup directory manifest");
  }
  verifyChecksums(source);
  validateBackupAttachmentFiles(source, manifest);
  const storePath = resolve(input.storePath);
  if (existsSync(storePath)) throw new Error(`Restore Store already exists: ${storePath}`);
  preflightRestoreDirectory(input.destinations?.artifacts, manifest.directories.artifacts);
  preflightRestoreDirectory(input.destinations?.memory, manifest.directories.memory);
  preflightRestoreDirectory(
    input.destinations?.executionOutput,
    manifest.directories["execution-output"],
  );
  preflightRestoreDirectory(input.destinations?.attachments, manifest.directories.attachments);
  mkdirSync(dirname(storePath), { recursive: true });
  cpSync(join(source, manifest.database), storePath);
  restoreOptionalDirectory(source, "artifacts", input.destinations?.artifacts, manifest.directories.artifacts);
  restoreOptionalDirectory(source, "memory", input.destinations?.memory, manifest.directories.memory);
  restoreOptionalDirectory(
    source,
    "execution-output",
    input.destinations?.executionOutput,
    manifest.directories["execution-output"],
  );
  restoreOptionalDirectory(
    source,
    "attachments",
    input.destinations?.attachments,
    manifest.directories.attachments,
  );
  return manifest;
}

function copyOptionalDirectory(source: string | undefined, destination: string): boolean {
  if (!source || !existsSync(source) || !statSync(source).isDirectory()) return false;
  cpSync(resolve(source), destination, { recursive: true });
  return true;
}

function assertDestinationOutsideSource(destination: string, source: string): void {
  const sourceRoot = resolve(source);
  const nested = relative(sourceRoot, destination);
  if (nested === "" || (!nested.startsWith("..") && !isAbsolute(nested))) {
    throw new Error(`Backup destination cannot be inside a source directory: ${destination}`);
  }
}

function restoreOptionalDirectory(
  sourceRoot: string,
  name: string,
  destination: string | undefined,
  present: boolean,
): void {
  if (!present || !destination) return;
  const resolved = resolve(destination);
  mkdirSync(dirname(resolved), { recursive: true });
  cpSync(join(sourceRoot, name), resolved, { recursive: true });
}

function preflightRestoreDirectory(destination: string | undefined, present: boolean): void {
  if (!present || !destination) return;
  const resolved = resolve(destination);
  if (!existsSync(resolved)) return;
  const stat = statSync(resolved);
  if (!stat.isDirectory() || readdirSync(resolved).length > 0) {
    throw new Error(`Restore directory is not empty: ${resolved}`);
  }
}

function checksumsFor(root: string, excluded: string[]): Record<string, string> {
  const checksums: Record<string, string> = {};
  for (const path of walkFiles(root)) {
    const name = relative(root, path).replaceAll("\\", "/");
    if (excluded.includes(name)) continue;
    checksums[name] = createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return checksums;
}

function verifyChecksums(root: string): void {
  const expected = JSON.parse(readFileSync(join(root, "checksums.json"), "utf-8")) as Record<string, string>;
  const actual = checksumsFor(root, ["checksums.json"]);
  const names = Object.keys(actual).sort();
  const expectedNames = Object.keys(expected).sort();
  if (
    names.length !== expectedNames.length ||
    names.some((name, index) => name !== expectedNames[index] || actual[name] !== expected[name])
  ) {
    throw new Error("Backup checksum verification failed");
  }
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Backup contains unsupported filesystem entry: ${path}`);
  }
  return files.sort();
}

function isDirectoryManifest(value: unknown): value is ApplicationBackupManifest["directories"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.artifacts === "boolean" &&
    typeof candidate.memory === "boolean" &&
    typeof candidate["execution-output"] === "boolean" &&
    (typeof candidate.attachments === "boolean" || candidate.attachments === undefined);
}

function validateAttachmentFiles(
  store: SessionStore,
  attachmentsRoot: string | undefined,
): NonNullable<ApplicationBackupManifest["attachments"]> {
  const assets = store.listAttachments({ includeDeleted: true })
    .filter((asset) => asset.sha256 && asset.sizeBytes !== undefined);
  const unique = new Map<string, number>();
  for (const asset of assets) unique.set(asset.sha256!, asset.sizeBytes!);
  if (unique.size > 0 && !attachmentsRoot) {
    throw new Error(`Attachment backup is incomplete: missing attachment directory for ${assets[0]!.id}`);
  }
  let physicalBytes = 0;
  for (const [sha256, expectedSize] of unique) {
    const path = join(resolve(attachmentsRoot!), "blobs", sha256.slice(0, 2), sha256);
    if (!existsSync(path)) {
      const asset = assets.find((candidate) => candidate.sha256 === sha256)!;
      throw new Error(`Attachment backup is incomplete: missing blob for ${asset.id}`);
    }
    const stat = statSync(path);
    if (!stat.isFile() || stat.size !== expectedSize) {
      const asset = assets.find((candidate) => candidate.sha256 === sha256)!;
      throw new Error(`Attachment backup is incomplete: corrupt blob for ${asset.id}`);
    }
    physicalBytes += stat.size;
  }
  return { assets: assets.length, uniqueBlobs: unique.size, physicalBytes };
}

function validateBackupAttachmentFiles(
  source: string,
  manifest: ApplicationBackupManifest,
): void {
  const database = new SessionStore({ path: join(source, manifest.database) });
  try {
    const stats = validateAttachmentFiles(
      database,
      manifest.directories.attachments ? join(source, "attachments") : undefined,
    );
    if (manifest.version === 1 && stats.assets > 0) {
      throw new Error("Attachment backup is incomplete: version 1 backup contains attachment records without blobs");
    }
    if (manifest.version === 2 && manifest.attachments && (
      manifest.attachments.assets !== stats.assets ||
      manifest.attachments.uniqueBlobs !== stats.uniqueBlobs ||
      manifest.attachments.physicalBytes !== stats.physicalBytes
    )) {
      throw new Error("Attachment backup manifest does not match its database and blobs");
    }
  } finally {
    database.close();
  }
}
