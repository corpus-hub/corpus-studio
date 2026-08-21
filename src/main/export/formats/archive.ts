// The whole project as one file: the export that can be imported back.
//
// Every other format here answers a question ABOUT the corpus — a table of
// measurements, a citation graph for a graph tool. This one is the corpus: the
// papers, their PDFs, the text, the analyses with their provenance, the
// summaries, the citations and the search index. It exists so a project can move
// to another machine, be handed to a collaborator, or be put somewhere safe.
//
// Registered like any other format, which is the point of the registry: the IPC
// handler, the preload and the export panel need no change, and `writeFile.ts`
// gives it the same atomic tmp -> fsync -> rename save every export inherits.

import { buildProjectArchive } from '../../project-archive/build'
import { projectStem } from './structural'
import type { ExportFormat } from '../types'

export const archiveFormat: ExportFormat<{ kind: 'archive' }> = {
  kind: 'archive',
  options: () => [
    {
      spec: { kind: 'archive' },
      option: {
        id: 'archive',
        group: 'Complete project archive',
        format: 'ZIP',
        label: 'Complete project archive · ZIP',
        // Says what it holds AND what it is for. An export whose only use is
        // stated nowhere gets exported once and never opened; this one has a
        // matching import, and the place to say so is next to the button that
        // makes the file.
        description:
          'Everything: papers, PDFs, analyses, summaries and citations. Import it back from New project to restore the whole project on another machine.',
        extension: 'zip'
      }
    }
  ],
  build: async (db, projectId) => ({
    data: buildProjectArchive(db, projectId),
    extension: 'zip',
    filenameStem: projectStem(db, projectId, 'archive')
  })
}
