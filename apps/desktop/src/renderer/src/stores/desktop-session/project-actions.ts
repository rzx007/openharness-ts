import type { DesktopProject } from "@shared/session-types"

import {
  beginScopedOperation,
  errorMessage,
  failScopedOperation,
  removeScopedOperation,
} from "./error-state"
import { samePath, upsertProject } from "./helpers"
import type {
  DesktopOperation,
  DesktopSessionState,
  DesktopStoreContext,
  ProjectActions,
} from "./types"

const selectedProjectGitRefreshTtlMs = 5_000

export function createProjectActions(context: DesktopStoreContext): ProjectActions {
  const { get, set } = context
  const projectGitGenerations = new Map<string, number>()
  const advanceProjectGitGeneration = (projectId: string): number => {
    const generation = (projectGitGenerations.get(projectId) ?? 0) + 1
    projectGitGenerations.set(projectId, generation)
    return generation
  }
  const ownsProjectGitGeneration = (projectId: string, generation: number): boolean =>
    projectGitGenerations.get(projectId) === generation && get().selectedProject?.id === projectId

  const beginAppOperation = (target: string): string => {
    const operationId = globalThis.crypto.randomUUID()
    set((state) => ({
      appOperations: beginScopedOperation(state.appOperations, appOperation(operationId, target)),
    }))
    return operationId
  }
  const finishAppOperation = (operationId: string): void => {
    set((state) => ({
      appOperations: removeScopedOperation(state.appOperations, operationId),
    }))
  }
  const failAppOperation = (operationId: string, error: unknown): void => {
    set((state) => ({
      appOperations: failScopedOperation(
        state.appOperations,
        operationId,
        errorMessage(error),
        Date.now()
      ),
    }))
  }
  const beginProjectOperation = (projectId: string, target: string): string => {
    const operationId = globalThis.crypto.randomUUID()
    set((state) => ({
      projectOperations: {
        ...state.projectOperations,
        [projectId]: beginScopedOperation(
          state.projectOperations[projectId] ?? {},
          projectOperation(operationId, projectId, target)
        ),
      },
    }))
    return operationId
  }
  const finishProjectOperation = (projectId: string, operationId: string): void => {
    set((state) => ({
      projectOperations: replaceProjectOperationBucket(
        state.projectOperations,
        projectId,
        removeScopedOperation(state.projectOperations[projectId] ?? {}, operationId)
      ),
    }))
  }
  const failProjectOperation = (projectId: string, operationId: string, error: unknown): void => {
    set((state) => ({
      projectOperations: {
        ...state.projectOperations,
        [projectId]: failScopedOperation(
          state.projectOperations[projectId] ?? {},
          operationId,
          errorMessage(error),
          Date.now()
        ),
      },
    }))
  }
  const isCurrentProjectOperation = (projectId: string, operationId: string): boolean => {
    const operation = get().projectOperations[projectId]?.[operationId]
    return get().selectedProject?.id === projectId && operation?.phase === "pending"
  }

  return {
    async chooseProject() {
      const operationId = beginAppOperation("choose-project")
      try {
        const details = await window.desktop.sessions.chooseProject()
        if (!details) {
          finishAppOperation(operationId)
          return
        }
        set((state) => ({
          projects: upsertProject(state.projects, details.project),
          workspaceMode: "project",
          selectedProject: details.project,
          selectedProjectGit: details.git ?? Boolean(details.branch || details.branches?.length),
          selectedProjectGitCheckedAt: Date.now(),
          branch: details.branch,
          branches: details.branches ?? [],
          appOperations: removeScopedOperation(state.appOperations, operationId),
        }))
      } catch (error) {
        failAppOperation(operationId, error)
        throw error
      }
    },

    async selectProject(project) {
      const gitGeneration = advanceProjectGitGeneration(project.id)
      set({
        selectedProject: project,
        workspaceMode: "project",
        selectedProjectGit: false,
        selectedProjectGitCheckedAt: null,
        branch: null,
        branches: [],
      })
      const operationId = beginProjectOperation(project.id, "select-project")
      try {
        const details = await window.desktop.sessions.inspectProject(project.path)
        if (
          !isCurrentProjectOperation(project.id, operationId) ||
          !ownsProjectGitGeneration(project.id, gitGeneration)
        ) {
          finishProjectOperation(project.id, operationId)
          return
        }
        set((state) => ({
          projects: upsertProject(state.projects, details.project),
          selectedProject: details.project,
          selectedProjectGit: details.git ?? Boolean(details.branch || details.branches?.length),
          selectedProjectGitCheckedAt: Date.now(),
          branch: details.branch,
          branches: details.branches ?? [],
          projectOperations: replaceProjectOperationBucket(
            state.projectOperations,
            project.id,
            removeScopedOperation(state.projectOperations[project.id] ?? {}, operationId)
          ),
        }))
      } catch (error) {
        failProjectOperation(project.id, operationId, error)
        throw error
      }
    },

    selectOutsideProject() {
      set({
        workspaceMode: "outside_project",
        selectedProject: null,
        selectedProjectGit: false,
        selectedProjectGitCheckedAt: null,
        branch: null,
        branches: [],
      })
    },

    async refreshSelectedProjectGit(options) {
      const { selectedProject, selectedProjectGitCheckedAt } = get()
      if (!selectedProject) {
        set({
          selectedProjectGit: false,
          selectedProjectGitCheckedAt: null,
          branch: null,
          branches: [],
        })
        return false
      }
      if (
        !options?.force &&
        selectedProjectGitCheckedAt !== null &&
        Date.now() - selectedProjectGitCheckedAt < selectedProjectGitRefreshTtlMs
      ) {
        return get().selectedProjectGit
      }
      const gitGeneration = advanceProjectGitGeneration(selectedProject.id)
      const operationId = beginProjectOperation(selectedProject.id, "refresh-project-git")
      try {
        const details = await window.desktop.sessions.inspectProject(selectedProject.path)
        if (
          !isCurrentProjectOperation(selectedProject.id, operationId) ||
          !ownsProjectGitGeneration(selectedProject.id, gitGeneration)
        ) {
          finishProjectOperation(selectedProject.id, operationId)
          return get().selectedProjectGit
        }
        const git = details.git ?? Boolean(details.branch || details.branches?.length)
        set((state) => ({
          projects: upsertProject(state.projects, details.project),
          selectedProject: details.project,
          selectedProjectGit: git,
          selectedProjectGitCheckedAt: Date.now(),
          branch: details.branch,
          branches: details.branches ?? [],
          projectOperations: replaceProjectOperationBucket(
            state.projectOperations,
            selectedProject.id,
            removeScopedOperation(state.projectOperations[selectedProject.id] ?? {}, operationId)
          ),
        }))
        return git
      } catch (error) {
        failProjectOperation(selectedProject.id, operationId, error)
        if (ownsProjectGitGeneration(selectedProject.id, gitGeneration)) {
          set({
            selectedProjectGit: false,
            selectedProjectGitCheckedAt: Date.now(),
            branch: null,
            branches: [],
          })
        }
        return false
      }
    },

    async checkoutBranch(branch) {
      const selectedProject = get().selectedProject
      if (!selectedProject) return
      const gitGeneration = advanceProjectGitGeneration(selectedProject.id)
      await withProjectOperation(
        selectedProject,
        "checkout-branch",
        beginProjectOperation,
        finishProjectOperation,
        failProjectOperation,
        async (operationId) => {
          const details = await window.desktop.sessions.checkoutBranch({
            path: selectedProject.path,
            branch,
          })
          if (
            isCurrentProjectOperation(selectedProject.id, operationId) &&
            ownsProjectGitGeneration(selectedProject.id, gitGeneration)
          ) {
            set((state) => projectDetailsState(state, details))
          }
        }
      )
    },

    async createAndCheckoutBranch(branch) {
      const selectedProject = get().selectedProject
      if (!selectedProject) return
      const gitGeneration = advanceProjectGitGeneration(selectedProject.id)
      await withProjectOperation(
        selectedProject,
        "create-branch",
        beginProjectOperation,
        finishProjectOperation,
        failProjectOperation,
        async (operationId) => {
          const details = await window.desktop.sessions.createBranch({
            path: selectedProject.path,
            branch,
          })
          if (
            isCurrentProjectOperation(selectedProject.id, operationId) &&
            ownsProjectGitGeneration(selectedProject.id, gitGeneration)
          ) {
            set((state) => projectDetailsState(state, details))
          }
        }
      )
    },

    async renameProject(path, name) {
      const normalizedName = name.replace(/\s+/g, " ").trim()
      if (!normalizedName) return
      const existing = get().projects.find((project) => samePath(project.path, path))
      if (!existing) return
      await withProjectOperation(
        existing,
        "rename-project",
        beginProjectOperation,
        finishProjectOperation,
        failProjectOperation,
        async () => {
          const project = await window.desktop.sessions.renameProject({
            projectId: existing.id,
            name: normalizedName,
          })
          set((state) => ({
            projects: upsertProject(state.projects, project),
            selectedProject: samePath(state.selectedProject?.path ?? "", path)
              ? project
              : state.selectedProject,
          }))
        }
      )
    },

    async togglePinProject(path) {
      const existing = get().projects.find((project) => samePath(project.path, path))
      if (!existing) return
      await withProjectOperation(
        existing,
        "toggle-pin-project",
        beginProjectOperation,
        finishProjectOperation,
        failProjectOperation,
        async () => {
          const project = await window.desktop.sessions.setProjectPinned({
            projectId: existing.id,
            pinned: !existing.pinnedAt,
          })
          set((state) => ({
            projects: upsertProject(state.projects, project),
            selectedProject: samePath(state.selectedProject?.path ?? "", path)
              ? project
              : state.selectedProject,
          }))
        }
      )
    },

    async setProjectDefaultShell(path, shell) {
      const existing = get().projects.find((project) => samePath(project.path, path))
      if (!existing) return
      const normalizedShell = shell?.replace(/\s+/g, " ").trim() || null
      await withProjectOperation(
        existing,
        "set-project-default-shell",
        beginProjectOperation,
        finishProjectOperation,
        failProjectOperation,
        async () => {
          const project = await window.desktop.sessions.setProjectDefaultShell({
            projectId: existing.id,
            shell: normalizedShell,
          })
          set((state) => ({
            projects: upsertProject(state.projects, project),
            selectedProject: samePath(state.selectedProject?.path ?? "", path)
              ? project
              : state.selectedProject,
          }))
        }
      )
    },

    async removeProject(path) {
      const existing = get().projects.find((project) => samePath(project.path, path))
      if (!existing) return
      await withProjectOperation(
        existing,
        "remove-project",
        beginProjectOperation,
        finishProjectOperation,
        failProjectOperation,
        async () => {
          await window.desktop.sessions.removeProject(existing.id)
          set((state) => {
            const projects = state.projects.filter((project) => !samePath(project.path, path))
            const removedSelected = samePath(state.selectedProject?.path ?? "", path)
            return {
              projects,
              selectedProject: removedSelected ? (projects[0] ?? null) : state.selectedProject,
              workspaceMode:
                removedSelected && projects.length === 0 ? "outside_project" : state.workspaceMode,
              selectedProjectGit: removedSelected ? false : state.selectedProjectGit,
              selectedProjectGitCheckedAt: removedSelected
                ? null
                : state.selectedProjectGitCheckedAt,
              branch: removedSelected ? null : state.branch,
              branches: removedSelected ? [] : state.branches,
              projectOperations: removeProjectOperationBucket(state.projectOperations, existing.id),
            }
          })
          const project = get().selectedProject
          if (project)
            await get()
              .selectProject(project)
              .catch(() => undefined)
        }
      )
    },

    async rebindProject(projectId) {
      const existing = get().projects.find((project) => project.id === projectId)
      if (!existing) return
      await withProjectOperation(
        existing,
        "rebind-project",
        beginProjectOperation,
        finishProjectOperation,
        failProjectOperation,
        async () => {
          const project = await window.desktop.sessions.rebindProject(projectId)
          if (!project) return
          set((state) => ({
            projects: upsertProject(state.projects, project),
            selectedProject:
              state.selectedProject?.id === projectId ? project : state.selectedProject,
          }))
        }
      )
    },
  }
}

function appOperation(id: string, target: string): Omit<DesktopOperation, "phase"> {
  return { id, kind: "project-action", sessionId: null, target, startedAt: Date.now() }
}

function projectOperation(
  id: string,
  projectId: string,
  target: string
): Omit<DesktopOperation, "phase"> {
  return { id, kind: "project-action", sessionId: null, projectId, target, startedAt: Date.now() }
}

async function withProjectOperation<T>(
  project: DesktopProject,
  target: string,
  begin: (projectId: string, target: string) => string,
  finish: (projectId: string, operationId: string) => void,
  fail: (projectId: string, operationId: string, error: unknown) => void,
  action: (operationId: string) => Promise<T>
): Promise<T> {
  const operationId = begin(project.id, target)
  try {
    const result = await action(operationId)
    finish(project.id, operationId)
    return result
  } catch (error) {
    fail(project.id, operationId, error)
    throw error
  }
}

function replaceProjectOperationBucket(
  projectOperations: Record<string, Record<string, DesktopOperation>>,
  projectId: string,
  operations: Record<string, DesktopOperation>
): Record<string, Record<string, DesktopOperation>> {
  if (Object.keys(operations).length > 0) return { ...projectOperations, [projectId]: operations }
  return removeProjectOperationBucket(projectOperations, projectId)
}

function removeProjectOperationBucket(
  projectOperations: Record<string, Record<string, DesktopOperation>>,
  projectId: string
): Record<string, Record<string, DesktopOperation>> {
  if (!projectOperations[projectId]) return projectOperations
  const remaining = { ...projectOperations }
  delete remaining[projectId]
  return remaining
}

function projectDetailsState(
  state: { projects: DesktopProject[] },
  details: Awaited<ReturnType<typeof window.desktop.sessions.inspectProject>>
): Pick<
  DesktopSessionState,
  | "projects"
  | "selectedProject"
  | "selectedProjectGit"
  | "selectedProjectGitCheckedAt"
  | "branch"
  | "branches"
> {
  return {
    projects: upsertProject(state.projects, details.project),
    selectedProject: details.project,
    selectedProjectGit: details.git ?? Boolean(details.branch || details.branches?.length),
    selectedProjectGitCheckedAt: Date.now(),
    branch: details.branch,
    branches: details.branches ?? [],
  }
}
