import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { ContextTopic } from "@openharness/context";

import { ContextPaths, type ContextDocumentRef } from "./context-paths.js";

interface BackupManifest {
  id: string;
  documents: Array<ContextDocumentRef & { existed: boolean; backupName: string }>;
}

export interface ContextBackupReceipt {
  id: string;
  documents: ContextDocumentRef[];
}

export class ContextBackupService {
  private readonly paths: ContextPaths;

  constructor(private readonly options: { root: string }) {
    this.paths = new ContextPaths(options.root);
  }

  async create(refs: ContextDocumentRef[]): Promise<ContextBackupReceipt> {
    const id = randomUUID();
    const directory = this.backupDirectory(id);
    await mkdir(directory, { recursive: true });
    const documents: BackupManifest["documents"] = [];
    for (const ref of deduplicateRefs(refs)) {
      const backupName = `${ref.scope}--${encodeURIComponent(ref.scopeKey)}--${ref.topic}.md`;
      const source = this.paths.documentFor(ref);
      let existed = true;
      try {
        await copyFile(source, join(directory, backupName));
      } catch (error) {
        if (!isMissing(error)) throw error;
        existed = false;
      }
      documents.push({ ...ref, existed, backupName });
    }
    const manifest: BackupManifest = { id, documents };
    await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return { id, documents: documents.map(({ existed: _existed, backupName: _backupName, ...ref }) => ref) };
  }

  async restore(id: string): Promise<void> {
    const manifest = await this.readManifest(id);
    for (const document of manifest.documents) {
      const target = this.paths.documentFor(document);
      if (!document.existed) {
        await rm(target, { force: true });
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(this.backupDirectory(id), document.backupName), target);
    }
  }

  private async readManifest(id: string): Promise<BackupManifest> {
    assertBackupId(id);
    const parsed = JSON.parse(await readFile(join(this.backupDirectory(id), "manifest.json"), "utf8")) as BackupManifest;
    if (parsed.id !== id || !Array.isArray(parsed.documents)) throw new Error("Invalid context backup manifest");
    for (const document of parsed.documents) this.paths.documentFor(document);
    return parsed;
  }

  private backupDirectory(id: string): string {
    assertBackupId(id);
    return join(this.options.root, ".backups", id);
  }
}

function deduplicateRefs(refs: ContextDocumentRef[]): ContextDocumentRef[] {
  return [...new Map(refs.map((ref) => [`${ref.scope}:${ref.scopeKey}:${ref.topic}`, ref])).values()];
}

function assertBackupId(id: string): void {
  if (!/^[0-9a-f-]{36}$/iu.test(id)) throw new Error("Invalid context backup id");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
