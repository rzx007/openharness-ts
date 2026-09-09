import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 250 * 1024 * 1024;
const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
const MAX_PATH_BYTES = 1_024;
const MAX_DEPTH = 32;
const PRIVATE_PREFIX = "oh-plugin-zip-";
const MANIFEST_PATH = ".openharness-plugin/plugin.json";

export interface ResolvedLocalPluginZip {
  archiveDigest: string;
  candidateRoot: string;
  cleanup(): Promise<void>;
}

interface PlannedEntry {
  entry: yauzl.Entry;
  path: string;
  directory: boolean;
}

class Crc32 {
  private value = 0xffffffff;

  update(chunk: Buffer): void {
    for (const byte of chunk) {
      this.value ^= byte;
      for (let bit = 0; bit < 8; bit += 1) this.value = (this.value >>> 1) ^ (this.value & 1 ? 0xedb88320 : 0);
    }
  }

  digest(): number {
    return (this.value ^ 0xffffffff) >>> 0;
  }
}

function archiveError(message: string): Error {
  return new Error(`Unsafe plugin ZIP: ${message}`);
}

function foldedPath(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function entryType(entry: yauzl.Entry): { directory: boolean; path: string } {
  const raw = entry.fileName;
  const unixType = (entry.externalFileAttributes >>> 16) & 0xf000;
  if (unixType === 0xa000) throw archiveError(`symlink entry is not allowed: ${raw}`);
  if (unixType !== 0 && unixType !== 0x8000 && unixType !== 0x4000) throw archiveError(`special entry type is not allowed: ${raw}`);
  const directory = raw.endsWith("/") || unixType === 0x4000;
  const path = directory && raw.endsWith("/") ? raw.slice(0, -1) : raw;
  return { directory, path };
}

function validatePath(path: string): string[] {
  if (Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES) throw archiveError("entry path exceeds 1,024 bytes");
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[a-zA-Z]:/.test(path)) {
    throw archiveError(`unsafe archive entry path: ${JSON.stringify(path)}`);
  }
  const segments = path.split("/");
  if (segments.length > MAX_DEPTH) throw archiveError(`entry path depth exceeds ${MAX_DEPTH}`);
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || segment.includes(":")) throw archiveError(`unsafe archive entry path: ${JSON.stringify(path)}`);
    if (segment.endsWith(".") || segment.endsWith(" ")) throw archiveError(`unsafe archive entry path: ${JSON.stringify(path)}`);
    if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$|clock\$)(?:\..*)?$/i.test(segment)) {
      throw archiveError(`unsafe archive entry path: ${JSON.stringify(path)}`);
    }
  }
  return segments;
}

function validateEntries(entries: yauzl.Entry[]): PlannedEntry[] {
  const aliases = new Map<string, { path: string; direct: boolean }>();
  const files = new Set<string>();
  const directories = new Set<string>();
  const planned: PlannedEntry[] = [];
  let totalBytes = 0;
  let fileCount = 0;

  for (const entry of entries) {
    if ((entry.generalPurposeBitFlag & 1) !== 0) throw archiveError(`encrypted entry is not allowed: ${entry.fileName}`);
    const { directory, path } = entryType(entry);
    const segments = validatePath(path);
    const folded = foldedPath(path);
    const prior = aliases.get(folded);
    if (prior?.direct || (prior !== undefined && prior.path !== path)) {
      throw archiveError(`duplicate or NFC/case collision: ${prior.path} and ${path}`);
    }
    aliases.set(folded, { path, direct: true });

    if (!directory) {
      fileCount += 1;
      if (fileCount > MAX_FILES) throw archiveError(`archive contains more than ${MAX_FILES.toLocaleString("en-US")} files`);
      if (entry.uncompressedSize > MAX_FILE_BYTES) throw archiveError("single file exceeds 100 MiB");
      totalBytes += entry.uncompressedSize;
      if (totalBytes > MAX_EXTRACTED_BYTES) throw archiveError("archive extraction exceeds 250 MiB");
      if (entry.uncompressedSize > 0 && (entry.compressedSize === 0 || entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO)) {
        throw archiveError(`entry compression ratio exceeds ${MAX_COMPRESSION_RATIO}`);
      }
    }

    if (directory) {
      if (files.has(folded)) throw archiveError(`file-directory conflict at ${path}`);
      directories.add(folded);
    } else {
      if (directories.has(folded)) throw archiveError(`file-directory conflict at ${path}`);
      files.add(folded);
    }
    for (let length = 1; length < segments.length; length += 1) {
      const parentPath = segments.slice(0, length).join("/");
      const parent = foldedPath(parentPath);
      const parentAlias = aliases.get(parent);
      if (parentAlias !== undefined && parentAlias.path !== parentPath) {
        throw archiveError(`duplicate or NFC/case collision: ${parentAlias.path} and ${parentPath}`);
      }
      if (parentAlias === undefined) aliases.set(parent, { path: parentPath, direct: false });
      if (files.has(parent)) throw archiveError(`file-directory conflict at ${path}`);
      directories.add(parent);
    }
    planned.push({ entry, path, directory });
  }
  return planned;
}

function candidateWrapper(entries: PlannedEntry[]): string | undefined {
  const candidates = entries
    .filter((entry) => !entry.directory)
    .flatMap((entry) => {
      if (entry.path === MANIFEST_PATH) return [undefined];
      const segments = entry.path.split("/");
      return segments.length === 3 && segments[1] === ".openharness-plugin" && segments[2] === "plugin.json" ? [segments[0]] : [];
    });
  if (candidates.length !== 1) throw archiveError("archive must contain exactly one manifest at its root or under one wrapper directory");
  const wrapper = candidates[0];
  if (wrapper !== undefined && entries.some((entry) => entry.path !== wrapper && !entry.path.startsWith(`${wrapper}/`))) {
    throw archiveError(`wrapper archive contains an entry outside ${wrapper}`);
  }
  return wrapper;
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolveZip, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: false }, (error, zip) => {
      if (error || !zip) reject(error ?? archiveError("could not open ZIP")); else resolveZip(zip);
    });
  });
}

function closeQuietly(zip: yauzl.ZipFile): void {
  try { zip.close(); } catch { /* already closed */ }
}

function readCentralDirectory(path: string): Promise<yauzl.Entry[]> {
  return openZip(path).then((zip) => new Promise((resolveEntries, reject) => {
    const entries: yauzl.Entry[] = [];
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      closeQuietly(zip);
      if (error) reject(error); else resolveEntries(entries);
    };
    zip.on("error", finish);
    zip.on("end", () => finish());
    zip.on("entry", (entry) => {
      entries.push(entry);
      try { zip.readEntry(); } catch (error) { finish(error as Error); }
    });
    try { zip.readEntry(); } catch (error) { finish(error as Error); }
  }));
}

async function copyAndHash(source: string, privateRoot: string): Promise<{ path: string; digest: string }> {
  const target = join(privateRoot, "source.zip");
  const hash = createHash("sha256");
  let copied = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      copied += chunk.length;
      if (copied > MAX_SOURCE_BYTES) callback(archiveError("source ZIP exceeds 100 MiB"));
      else { hash.update(chunk); callback(null, chunk); }
    },
  });
  await pipeline(createReadStream(source), counter, createWriteStream(target, { flags: "wx" }));
  return { path: target, digest: hash.digest("hex") };
}

function extractFile(zip: yauzl.ZipFile, entry: yauzl.Entry, destination: string): Promise<void> {
  return new Promise((resolveFile, reject) => {
    zip.openReadStream(entry, (openError, stream) => {
      if (openError || !stream) { reject(openError ?? archiveError(`could not read ${entry.fileName}`)); return; }
      const crc = new Crc32();
      let bytes = 0;
      const output = createWriteStream(destination, { flags: "wx" });
      const fail = (error: Error) => { stream.destroy(); output.destroy(); reject(error); };
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > entry.uncompressedSize || bytes > MAX_FILE_BYTES) fail(archiveError(`actual byte count exceeds declared size for ${entry.fileName}`));
        else crc.update(chunk);
      });
      stream.on("error", (error) => reject(error));
      output.on("error", (error) => reject(error));
      output.on("finish", () => {
        if (bytes !== entry.uncompressedSize) reject(archiveError(`actual byte count does not match declared size for ${entry.fileName}`));
        else if (crc.digest() !== (entry.crc32 >>> 0)) reject(archiveError(`CRC mismatch for ${entry.fileName}`));
        else resolveFile();
      });
      stream.pipe(output);
    });
  });
}

function extractEntries(path: string, destination: string, planned: PlannedEntry[]): Promise<void> {
  return openZip(path).then((zip) => new Promise((resolveExtraction, reject) => {
    let index = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      closeQuietly(zip);
      if (error) reject(error); else resolveExtraction();
    };
    zip.on("error", finish);
    zip.on("end", () => index === planned.length ? finish() : finish(archiveError("ZIP entry list changed during extraction")));
    zip.on("entry", async (entry) => {
      try {
        const expected = planned[index++];
        if (!expected || expected.entry.fileName !== entry.fileName) throw archiveError("ZIP entry list changed during extraction");
        const target = join(destination, ...expected.path.split("/"));
        if (expected.directory) await mkdir(target, { recursive: true });
        else { await mkdir(dirname(target), { recursive: true }); await extractFile(zip, entry, target); }
        zip.readEntry();
      } catch (error) { finish(error as Error); }
    });
    try { zip.readEntry(); } catch (error) { finish(error as Error); }
  }));
}

async function cleanupPrivateRoot(root: string): Promise<void> {
  if (resolve(dirname(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), PRIVATE_PREFIX))) throw archiveError("refusing to clean an unknown temporary directory");
  await rm(root, { recursive: true, force: true });
}

export async function resolveLocalPluginZip(source: string): Promise<ResolvedLocalPluginZip> {
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw archiveError("source must be a regular file, not a link");
  if (sourceInfo.size > MAX_SOURCE_BYTES) throw archiveError("source ZIP exceeds 100 MiB");
  const privateRoot = await mkdtemp(join(tmpdir(), PRIVATE_PREFIX));
  try {
    const copied = await copyAndHash(source, privateRoot);
    const planned = validateEntries(await readCentralDirectory(copied.path));
    const wrapper = candidateWrapper(planned);
    const extracted = join(privateRoot, "contents");
    await mkdir(extracted);
    await extractEntries(copied.path, extracted, planned);
    return {
      archiveDigest: copied.digest,
      candidateRoot: wrapper === undefined ? extracted : join(extracted, wrapper),
      cleanup: () => cleanupPrivateRoot(privateRoot),
    };
  } catch (error) {
    await cleanupPrivateRoot(privateRoot);
    throw error;
  }
}
