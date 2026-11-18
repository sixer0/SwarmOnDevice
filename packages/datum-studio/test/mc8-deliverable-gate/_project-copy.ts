// Swarm 1.3.3 row 70 (MC-8, controller ruling): the ONE test helper that gives a document the project copy a verified
// render would have made (row 68), so a test about something else has a row that may go needs-review / done under
// DELIVERABLE_NOT_IN_PROJECT. It runs row 68's own hook (`projectCopyAfterRender`): same folder
// `<project>/deliverables/<mission>/`, same name `<doc number> Rev<letter> rev<N>.<ext>`, same row item on the row named
// by the docKey (`setRowDeliverables`). Input = the newest PRIMARY DOCX / PDF / HTML of the document's CURRENT revision,
// read from the store root.
//
// Two test-only liberties, both stated here: (1) the project folder is created when the test never made it (row 68
// itself never creates it); (2) the sha256 handed to the copier is that of the bytes on disk, because seeded stores hold
// 10-byte stand-ins whose recorded output sha256 is made up; for a real render the two are equal.
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { sha256Hex } from "../../src/store/index.ts"
import { nativeProjectDir } from "../../src/store/mission/mission-store.ts"
import { projectCopyAfterRender, type ProjectCopyStore } from "../../src/mcp-host/verify/project-copy.ts"

type Doc = { revision_no: number; revision_id: string; project_dir: string | null }

/** Copies the current revision of `documentId` into its mission's project folder and records it on its row. Throws when it could not. */
export async function giveProjectCopy(store: ProjectCopyStore, documentId: string): Promise<{ files: string[] }> {
  const found = await store.transaction(async (tx) => {
    const d = tx.get<Doc>(
      `SELECT r.revision_no, r.id AS revision_id, m.project_dir FROM document d JOIN revision r ON r.document_id = d.id AND r.revision_no = d.current_revision_no
         LEFT JOIN mission m ON m.id = d.mission_folder WHERE d.id = ?`,
      [documentId],
    )
    if (!d) throw new Error(`giveProjectCopy: unknown document ${documentId}`)
    const outs = tx.all<{ format: string; rel_path: string }>(
      `SELECT format, rel_path FROM output_file WHERE document_id = ? AND revision_id = ? AND kind = 'document' AND scope_kind = 'DOCUMENT' AND draft = 0 AND role = 'PRIMARY'
        ORDER BY time_created DESC, rowid DESC`,
      [documentId, d.revision_id],
    )
    return { ...d, outs: outs.filter((o, i) => outs.findIndex((x) => x.format === o.format) === i) }
  })
  if (found.project_dir === null) throw new Error(`giveProjectCopy: document ${documentId} belongs to no mission`)
  if (found.outs.length === 0) throw new Error(`giveProjectCopy: document ${documentId} has no PRIMARY output of its current revision (render it first)`)
  mkdirSync(nativeProjectDir(found.project_dir), { recursive: true })
  const outputs = found.outs.map((o) => {
    const bytes = new Uint8Array(readFileSync(join(store.rootDir, o.rel_path)))
    return { format: o.format, role: "PRIMARY", sha256: sha256Hex(bytes), bytes }
  })
  // Row 147 (M1): the hook takes the calling session's folder; here the session is the mission's own project folder.
  const r = await projectCopyAfterRender(store, { documentId, revisionNo: Number(found.revision_no), outputs }, () => undefined, nativeProjectDir(found.project_dir))
  if (r.ok !== true || r.recorded !== true) throw new Error(`giveProjectCopy: ${JSON.stringify(r)}`)
  return { files: r.files.map((f) => f.path) }
}
