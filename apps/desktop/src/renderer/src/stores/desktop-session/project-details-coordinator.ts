export interface ProjectDetailsCoordinator {
  beginSelection(): number
  ownsSelection(generation: number): boolean
  beginDetails(projectId: string): number
  ownsDetails(projectId: string, generation: number): boolean
}

export function createProjectDetailsCoordinator(): ProjectDetailsCoordinator {
  let selectionGeneration = 0
  const detailGenerations = new Map<string, number>()

  return {
    beginSelection() {
      selectionGeneration += 1
      return selectionGeneration
    },
    ownsSelection(generation) {
      return selectionGeneration === generation
    },
    beginDetails(projectId) {
      const generation = (detailGenerations.get(projectId) ?? 0) + 1
      detailGenerations.set(projectId, generation)
      return generation
    },
    ownsDetails(projectId, generation) {
      return detailGenerations.get(projectId) === generation
    },
  }
}
