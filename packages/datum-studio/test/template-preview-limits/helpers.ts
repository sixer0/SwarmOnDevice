// Row 70a test helpers: a real document output (kind 'document', under docs/) made through the store's own API, and
// a census of the kept previews (rows of kind 'preview' and the files under tmp/preview/).
import { existsSync, lstatSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { docNumberSafe, newId, sha256Hex, type RevisionRowsInput, type SqliteStudioStore } from "../../src/store/index.ts"

let seq = 0

function revisionRows(text: string): RevisionRowsInput {
  const ch = newId()
  const sub = newId()
  const block = newId()
  const sectionId = newId()
  const chapterId = newId()
  const subId = newId()
  return {
    identities: [
      { id: ch, pid: "p-ch1", kind: "CHAPTER" },
      { id: sub, pid: "p-s1", kind: "SUBSECTION" },
      { id: block, pid: "p-b1", kind: "BLOCK" },
    ],
    sections: [{ id: sectionId, slot_key: "isi", section_type_key: "chapter", position: 1, filled: 1, payload: null, payload_sha256: "0".repeat(64) }],
    chapters: [{ id: chapterId, doc_section_id: sectionId, identity_id: ch, chapter_key: "bab-1", position: 1, title: { text: "Bab 1" }, content_sha256: "1".repeat(64) }],
    subsections: [{ id: subId, chapter_id: chapterId, identity_id: sub, section_no: 1, title: null, content_sha256: "2".repeat(64) }],
    blocks: [{ doc_section_id: sectionId, chapter_id: chapterId, subsection_id: subId, identity_id: block, pid: "p-b1", address: "1.1.1", ordinal: 1, para_no: 1, type: "paragraph", content: { text }, text_plain: text, content_sha256: sha256Hex(text) }],
  } as RevisionRowsInput
}

/** A document with one revision and one PDF output under docs/ (files first, then the row, as the store requires). */
export async function makeDocumentOutput(store: SqliteStudioStore, templateVersionId: string, tag: string): Promise<{ id: string; relPath: string; abs: string; sha256: string }> {
  seq++
  const what = `row70a ${tag} ${seq}`
  const doc = await store.transaction((tx) =>
    store.createDocument(tx, {
      docNumber: `${String(700 + seq).padStart(3, "0")}/GSP/KT/X/2026`,
      numberSource: "AGENT",
      title: `Dokumen row70a ${seq}`,
      typeCode: "KT",
      classification: "TERBATAS",
      tier: "NOTA",
      templateVersionId,
      createdBy: "swarm",
      revision: { snapshot: { what }, inputSha256: sha256Hex(what), docRev: "A", change: { what, why: "row70a test", impact: "none" }, createdBy: "swarm", rows: revisionRows(what) },
    } as never),
  )
  const rev = (await store.getRevision(doc.id, "latest"))!.revision
  const bytes = new TextEncoder().encode(`%PDF-1.7 row70a ${tag}`)
  const sha = sha256Hex(bytes)
  const relPath = `docs/misi-row70a/studio/${String(seq).padStart(3, "0")}/rev-1/${docNumberSafe(doc.doc_number)}_rev1_20261107T000000Z_${sha.slice(0, 8)}.pdf`
  store.writeOutputBytes(relPath, bytes)
  const row = await store.transaction((tx) =>
    store.putOutput(tx, { kind: "document", documentId: doc.id, revisionId: rev.id, format: "PDF", role: "PRIMARY", relPath, fileName: relPath.split("/").pop()!, bytes: bytes.byteLength, sha256: sha, mime: "application/pdf" }),
  )
  return { id: row.id, relPath, abs: join(store.rootDir, relPath), sha256: sha }
}

/** Write one preview (folder `tmp/preview/<id>/`, `files` names) with its rows, the way preview.ts keepFiles does. */
export async function makePreview(store: SqliteStudioStore, files: string[] = ["GSP Pratinjau Templat.docx"], id: string = crypto.randomUUID()): Promise<{ id: string; relPaths: string[] }> {
  const relPaths: string[] = []
  const written = files.map((name) => {
    const bytes = new TextEncoder().encode(`preview ${id} ${name}`)
    const relPath = `tmp/preview/${id}/${name}`
    store.writeOutputBytes(relPath, bytes)
    relPaths.push(relPath)
    return { relPath, name, bytes }
  })
  await store.transaction(async (tx) => {
    for (const w of written) {
      const format = w.name.endsWith(".pdf") ? "PDF" : w.name.endsWith(".html") ? "HTML" : "DOCX"
      await store.putOutput(tx, { kind: "preview", format, role: "PRIMARY", relPath: w.relPath, fileName: w.name, bytes: w.bytes.byteLength, sha256: sha256Hex(w.bytes), mime: "application/octet-stream" })
    }
  })
  return { id, relPaths }
}

type Reader = { all(sql: string, params?: unknown[]): Array<Record<string, unknown>> }
export function reader(store: SqliteStudioStore): Reader {
  return (store as unknown as { requireReader(): Reader }).requireReader()
}

/** Rows of kind 'preview' and the files on disk under tmp/preview/ (one level of folders, as keepFiles writes). */
export function previewCensus(store: SqliteStudioStore): { rows: string[]; files: string[]; folders: string[]; bytes: number; rowsOfOtherKinds: number } {
  const rows = reader(store)
    .all("SELECT rel_path FROM output_file WHERE kind = 'preview' ORDER BY rel_path")
    .map((r) => String(r.rel_path))
  const dir = join(store.rootDir, "tmp", "preview")
  const files: string[] = []
  const folders: string[] = []
  let bytes = 0
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).sort()) {
      folders.push(f)
      const sub = join(dir, f)
      if (!lstatSync(sub).isDirectory()) continue
      for (const name of readdirSync(sub).sort()) {
        files.push(`tmp/preview/${f}/${name}`)
        bytes += lstatSync(join(sub, name)).size
      }
    }
  }
  const rowsOfOtherKinds = Number(reader(store).all("SELECT count(*) AS n FROM output_file WHERE kind <> 'preview'")[0]?.n ?? 0)
  return { rows, files: files.sort(), folders, bytes, rowsOfOtherKinds }
}
