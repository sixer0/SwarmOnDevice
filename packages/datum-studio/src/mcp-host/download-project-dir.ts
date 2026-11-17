/**
 * Swarm 1.3.3 row 69/77 (MC-8): the project folder a project-relative `downloadDir` is read against.
 *
 * `studio_file_verify` knows a rendered file, `studio_figure_preview` a document. Both lead to the mission that owns
 * the document (`document.mission_folder`, the same owner the project copy of project-copy.ts uses) and to that
 * mission's `project_dir`. A document without a mission, an unknown id, or a store error gives null: the vendored
 * safety check then refuses the relative path ("tidak punya folder proyek"); nothing is ever read from the working
 * directory. The folder is only a candidate: safety.ts still requires it to be inside the session folder.
 */
import { nativeProjectDir } from "../store/mission/mission-store.ts"
import type { StoreTx } from "../store/types.ts"

export interface DownloadProjectStore {
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>
}

export type DownloadProjectRef = { documentId?: string; fileId?: string }

export function downloadProjectDirOf(store: DownloadProjectStore): (ref: DownloadProjectRef) => Promise<string | null> {
  return async (ref) => {
    try {
      const dir = await store.transaction(async (tx) => {
        const documentId =
          typeof ref.documentId === "string" && ref.documentId !== ""
            ? ref.documentId
            : typeof ref.fileId === "string" && ref.fileId !== ""
              ? (tx.get<{ document_id: string | null }>("SELECT document_id FROM output_file WHERE id = ?", [ref.fileId])?.document_id ?? null)
              : null
        if (documentId === null) return null
        const d = tx.get<{ mission_folder: string | null }>("SELECT mission_folder FROM document WHERE id = ?", [documentId])
        if (!d || !d.mission_folder) return null
        return tx.get<{ project_dir: string | null }>("SELECT project_dir FROM mission WHERE id = ?", [d.mission_folder])?.project_dir ?? null
      })
      return typeof dir === "string" && dir !== "" ? nativeProjectDir(dir) : null
    } catch {
      // No project folder known = the relative path is refused by the tool; the absolute form is unaffected.
      return null
    }
  }
}
