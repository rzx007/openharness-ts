import { stat } from "node:fs/promises";

import type { SessionStore } from "@openharness/services";

export class ProjectApplicationService {
  constructor(private readonly store: SessionStore) {}

  list(options: { includeArchived?: boolean } = {}) {
    return this.store.listProjects(options);
  }

  async inspect(path: string) {
    await this.assertDirectory(path);
    return this.store.inspectProject(path);
  }

  rename(projectId: string, name: string) {
    return this.store.renameProject(projectId, name);
  }

  setPinned(projectId: string, pinned: boolean) {
    return this.store.setProjectPinned(projectId, pinned);
  }

  setDefaultShell(projectId: string, shell: string | null) {
    return this.store.setProjectDefaultShell(projectId, shell);
  }

  async rebind(projectId: string, path: string) {
    await this.assertDirectory(path);
    return this.store.rebindProject(projectId, path);
  }

  archive(projectId: string) {
    return this.store.archiveProject(projectId);
  }

  private async assertDirectory(path: string): Promise<void> {
    if (!(await stat(path)).isDirectory()) {
      throw new Error("path is not a directory");
    }
  }
}
