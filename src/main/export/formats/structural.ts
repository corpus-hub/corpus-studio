// The two STRUCTURAL exports: the whole project as JSON, and the citation graph.
//
// "Structural" because they describe the corpus itself — its works, rankings and
// edges — rather than the values extracted from it. They are always available,
// for any project, in any domain, which is what separates them from the table
// exports (whose very existence depends on which schemas a project attaches).

import type { DB } from '../../db/connection'
import { exportProject, getProject } from '../../db/repositories'
import type { ExportFormat, ExportSpec } from '../types'

/** Filesystem-safe stem for a project's own name. */
export function projectStem(db: DB, projectId: number, suffix: string): string {
  const project = getProject(db, projectId)
  const slug =
    (project?.slug ?? project?.name ?? 'project')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'project'
  return `${slug}-${suffix}`
}

export const jsonFormat: ExportFormat<{ kind: 'json' }> = {
  kind: 'json',
  options: () => [
    {
      spec: { kind: 'json' },
      option: {
        id: 'json',
        group: 'Everything in this project',
        format: 'JSON',
        label: 'Everything in this project · JSON',
        description:
          'Papers, rankings, extracted values and their provenance, as one JSON file.',
        extension: 'json'
      }
    }
  ],
  build: async (db, projectId) => ({
    data: exportProject(db, projectId, 'json'),
    extension: 'json',
    filenameStem: projectStem(db, projectId, 'export')
  })
}

export const graphFormat: ExportFormat<{ kind: 'graph' }> = {
  kind: 'graph',
  options: () => [
    {
      spec: { kind: 'graph' },
      option: {
        id: 'graph',
        group: 'Citation graph',
        format: 'JSON',
        label: 'Citation graph · JSON',
        description: 'Nodes and edges of the citation network, for a graph tool.',
        extension: 'json'
      }
    }
  ],
  build: async (db, projectId) => ({
    data: exportProject(db, projectId, 'graph'),
    extension: 'json',
    filenameStem: projectStem(db, projectId, 'graph')
  })
}

/** Both structural formats, in menu order. */
export const structuralFormats: Array<ExportFormat<ExportSpec>> = [
  jsonFormat as ExportFormat<ExportSpec>,
  graphFormat as ExportFormat<ExportSpec>
]
