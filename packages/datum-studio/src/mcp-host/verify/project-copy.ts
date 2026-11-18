/**
 * 1.3.3 row 68 (MC-8 items 1-2, 4, 6-7; owner decision U16; register sections 1, 2, 5): after a verified
 * `studio_render` of a whole document, the DOCX, PDF and HTML are copied into the mission's project folder and listed
 * on the mission row, with no `downloadDir` from the agent.
 *
 * Path rule (register section 5). The server computes the destination from stored data only:
 *   <mission.project_dir>/deliverables/<mission id>/<doc number> Rev<letter> rev<N>.<ext>
 * Nothing of the tool input takes part. The mission id must match the mission id pattern; the file name is built by
 * the vendored `datumFileName("", number, letter, ext, revisionNo)` from the stored document number, revision letter
 * and Studio revision number and must pass DATUM_FILENAME_PATTERN (no title, no timestamp, no hash part).
 *
 * Safety.
 * - The project folder must exist (it is never created here) and is resolved to its real path. A project folder
 *   inside the Studio store is refused.
 * - `deliverables` and `deliverables/<mission id>` are created one level at a time. Either one being a symbolic link
 *   (or anything that is not a directory) is refused, and the real path of the final folder must equal the computed
 *   one, so no link can move the copy out of `<project>/deliverables/<mission id>/`.
 * - A file is created with the exclusive flag (`wx`): an existing name is never opened for writing and a link at the
 *   name is never followed. An existing regular file with the same sha256 is left alone; with another sha256 the copy
 *   is refused (OUTPUT_EXISTS). Nothing is ever deleted except a file this call created itself and found damaged.
 * - Every source is checked against the store's sha256 before any write, and every copy is read back and checked
 *   after it. A difference is an error (INTEGRITY_MISMATCH).
 * - All checks of all files run before the first write, so a refusal leaves no partial set.
 *
 * Codes: PROJECT_UNWRITABLE (register section 2) for a project folder that is missing or cannot be written; the
 * store's existing OUTPUT_EXISTS, INTEGRITY_MISMATCH and PATH_OUTSIDE_ROOT for the other refusals. No new code.
 *
 * 1.3.3 row 147 (security review M1, senior review S9). The folder name, file name and containment rule are the store's
 * ONE rule (store/mission/deliverable-path.ts), shared with the gate and the panel. The render hook is handed the
 * calling session's folder: a mission whose project folder is not that folder or inside it (real paths) is refused
 * PATH_OUTSIDE_ROOT with the folder in the message, and nothing is written anywhere else.
 *
 * Seam for row 114 (figure files under `figur/`): `ensureChildDir` and `copyFilesInto` are the same guarded
 * primitives, usable on `ProjectCopyOk.dir`.
 */
import { createHash } from "node:crypto"
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs"
import path from "node:path"
import { DATUM_FILENAME_PATTERN } from "../../../vendor/src/lib/studio/contract/env"
import { datumFileName } from "../../../vendor/src/lib/studio/services/storage/paths"
import { deliverableFileName, deliverablePath, deliverableRelPath, PROJECT_DELIVERABLES_DIR, projectDirOutsideRoot } from "../../store/mission/deliverable-path.ts"
import type { MissionStore } from "../../store/mission/index.ts"
import { nativeProjectDir } from "../../store/mission/mission-store.ts"
import type { RowDeliverable } from "../../store/mission/types.ts"
import type { StoreTx } from "../../store/types.ts"
import { MISSION_ID_PATTERN } from "../mission/schemas.ts"
import type { MissionLog } from "../mission/tool-result.ts"

export { PROJECT_DELIVERABLES_DIR }
/** The row schema's cap on `deliverables` (register section 1). */
/** @internal test seam */
export const ROW_DELIVERABLES_MAX = 100

type ProjectCopyFormat = "DOCX" | "PDF" | "HTML"
const FORMATS: readonly ProjectCopyFormat[] = ["DOCX", "PDF", "HTML"]
const isProjectCopyFormat = (v: unknown): v is ProjectCopyFormat => typeof v === "string" && (FORMATS as readonly string[]).includes(v)

type ProjectCopyCode = "PROJECT_UNWRITABLE" | "OUTPUT_EXISTS" | "INTEGRITY_MISMATCH" | "PATH_OUTSIDE_ROOT"
interface ProjectCopyFailure {
  ok: false
  code: ProjectCopyCode
  /** The project folder (PROJECT_UNWRITABLE) or the folder the refusal is about. */
  dir: string
  message: string
}
interface ProjectCopyOk {
  ok: true
  /** Absolute real path of `<project>/deliverables/<mission id>`. */
  dir: string
  files: RowDeliverable[]
  written: number
  kept: number
}
/** Why nothing was copied when nothing went wrong. */
type ProjectCopySkipReason = "no-mission" | "not-verified" | "draft" | "no-document-output" | "internal-error"
/** `structuredContent.projectCopy` of the render reply (register section 5, plus the two shapes the register has no line for). */
export type ProjectCopyReply =
  | { ok: true; dir: string; files: RowDeliverable[]; row: string | null; recorded: boolean; note?: string; dropped?: number }
  | ProjectCopyFailure
  | { ok: false; skipped: true; reason: ProjectCopySkipReason; message: string }

interface ProjectCopyDocument {
  documentId: string
  docNumber: string
  docRev: string
  revisionNo: number
}
interface ProjectCopySource {
  format: ProjectCopyFormat
  /** The store's `output_file.sha256`. */
  sha256: string
  bytes: Uint8Array | null
}
/** @internal test seam */
export interface ProjectCopyInput {
  /** The mission's project folder as a disk path (`nativeProjectDir(mission.project_dir)`). */
  projectDir: string
  mission: string
  document: ProjectCopyDocument
  outputs: readonly ProjectCopySource[]
  /** The Studio store root; a project folder inside it is refused. */
  storeRoot?: string
  /** Row 147 (M1): the calling session's folder; when given, a project folder that is not it or inside it is refused. */
  sessionRoot?: string
}

const MISSION_ID = new RegExp(MISSION_ID_PATTERN)
const DATUM_NAME = new RegExp(DATUM_FILENAME_PATTERN)
const SHA256 = /^[0-9a-f]{64}$/
const DOC_REV = /^[0-9A-Za-z]{1,8}$/
const DOCUMENT_ID = /^[a-z0-9]{20,40}$/
const sha256Of = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")

class CopyRefusal extends Error {
  constructor(
    readonly code: ProjectCopyCode,
    readonly dir: string,
    message: string,
  ) {
    super(message)
  }
}
const errno = (e: unknown) => (typeof (e as NodeJS.ErrnoException | null)?.code === "string" ? (e as NodeJS.ErrnoException).code! : "ERROR")

/**
 * Register section 5: `<doc number> Rev<letter> rev<N>.<ext>`, from stored document metadata only. Throws when the
 * metadata does not give exactly that one safe name (a separator, `..`, a letter outside the register's range).
 */
/** @internal test seam */
export function projectFileName(doc: Pick<ProjectCopyDocument, "docNumber" | "docRev" | "revisionNo">, format: ProjectCopyFormat): string {
  if (!isProjectCopyFormat(format)) throw new Error("format is not DOCX, PDF or HTML")
  if (typeof doc.docRev !== "string" || !DOC_REV.test(doc.docRev)) throw new Error("the revision letter is not 1-8 letters or digits")
  if (!Number.isInteger(doc.revisionNo) || doc.revisionNo < 0 || doc.revisionNo > 999999) throw new Error("the Studio revision number is out of range")
  const ext = format.toLowerCase()
  // Row 147 (S9): the store's one name; the vendored DATUM rule must give the very same name, else no copy is made.
  const name = deliverableFileName(doc.docNumber, doc.docRev, doc.revisionNo, format)
  if (path.basename(name) !== name || path.win32.basename(name) !== name || !DATUM_NAME.test(name) || name !== datumFileName("", doc.docNumber, doc.docRev, ext, doc.revisionNo)) throw new Error("the document number does not give a safe file name")
  return name
}

/**
 * Row 114 seam: `child` as a real directory directly inside the real directory `parent`, created when absent. A
 * symbolic link, or anything that is not a directory, at that name is refused.
 */
function ensureChildDir(parent: string, child: string, projectDir = parent): string {
  if (path.basename(child) !== child || child === "." || child === ".." || child.length === 0) throw new CopyRefusal("PATH_OUTSIDE_ROOT", parent, "the folder name is not one path segment")
  const dir = path.join(parent, child)
  try {
    mkdirSync(dir)
  } catch (e) {
    if (errno(e) !== "EEXIST") throw new CopyRefusal("PROJECT_UNWRITABLE", projectDir, `${errno(e)}: cannot create the folder ${child}`)
  }
  const st = lstatSync(dir, { throwIfNoEntry: false })
  if (!st) throw new CopyRefusal("PROJECT_UNWRITABLE", projectDir, `the folder ${child} could not be created`)
  if (st.isSymbolicLink()) throw new CopyRefusal("PATH_OUTSIDE_ROOT", dir, `${child} is a symbolic link; the copy is only made into a real folder of the project`)
  if (!st.isDirectory()) throw new CopyRefusal("PROJECT_UNWRITABLE", projectDir, `${child} exists and is not a folder`)
  if (realpathSync(dir) !== dir) throw new CopyRefusal("PATH_OUTSIDE_ROOT", dir, `${child} does not resolve inside the project folder`)
  return dir
}

/**
 * Row 114 seam: writes each file into the real directory `dir` under the rules of this module (checks first, exclusive
 * create, read back). Returns how many were written and how many were already there with the same sha256.
 */
function copyFilesInto(dir: string, files: ReadonlyArray<{ name: string; sha256: string; bytes: Uint8Array | null }>, projectDir = dir): { written: number; kept: number } {
  for (const f of files) {
    if (path.basename(f.name) !== f.name || path.win32.basename(f.name) !== f.name || f.name === "." || f.name === "..") throw new CopyRefusal("PATH_OUTSIDE_ROOT", dir, "a file name is not one path segment")
    if (!SHA256.test(f.sha256)) throw new CopyRefusal("INTEGRITY_MISMATCH", dir, "the store gave no sha256 for an output")
    if (!(f.bytes instanceof Uint8Array)) throw new CopyRefusal("INTEGRITY_MISMATCH", dir, "the stored bytes of an output could not be read and checked")
    if (sha256Of(f.bytes) !== f.sha256) throw new CopyRefusal("INTEGRITY_MISMATCH", dir, "the stored bytes of an output do not match the store's sha256")
  }
  const todo = files.filter((f) => !sameFileThere(dir, f.name, f.sha256))
  for (const f of todo) {
    const target = path.join(dir, f.name)
    const fd = (() => {
      try {
        return openSync(target, "wx", 0o644)
      } catch (e) {
        if (errno(e) === "EEXIST") return null
        throw new CopyRefusal("PROJECT_UNWRITABLE", projectDir, `${errno(e)}: cannot create a file in the deliverables folder`)
      }
    })()
    // Another writer made the name between the check and the create: same content is fine, other content is a clash.
    if (fd === null) {
      if (sameFileThere(dir, f.name, f.sha256)) continue
      throw new CopyRefusal("OUTPUT_EXISTS", dir, "a file of this name appeared while copying")
    }
    try {
      for (let at = 0; at < f.bytes!.length; ) at += writeSync(fd, f.bytes!, at, f.bytes!.length - at)
      fsyncSync(fd)
    } catch (e) {
      closeSync(fd)
      unlinkSync(target) // only the file this call created
      throw new CopyRefusal("PROJECT_UNWRITABLE", projectDir, `${errno(e)}: cannot write a file in the deliverables folder`)
    }
    closeSync(fd)
    if (sha256Of(readFileSync(target)) !== f.sha256) {
      unlinkSync(target) // only the file this call created
      throw new CopyRefusal("INTEGRITY_MISMATCH", dir, "the copy read back from the project folder does not match the store's sha256")
    }
  }
  return { written: todo.length, kept: files.length - todo.length }
}

/** True when a regular file of that name with that sha256 is there; throws when the name is taken by anything else. */
function sameFileThere(dir: string, name: string, sha256: string): boolean {
  const target = path.join(dir, name)
  const st = lstatSync(target, { throwIfNoEntry: false })
  if (!st) return false
  if (st.isSymbolicLink()) throw new CopyRefusal("PATH_OUTSIDE_ROOT", dir, "a deliverable name is a symbolic link; it is not followed")
  if (!st.isFile()) throw new CopyRefusal("OUTPUT_EXISTS", dir, "a deliverable name is taken by something that is not a file")
  if (sha256Of(readFileSync(target)) !== sha256) throw new CopyRefusal("OUTPUT_EXISTS", dir, "a file of this name with other content is already in the project folder; it is not overwritten")
  return true
}

/** The copy itself (no store access): path rule, checks, write, read back. Never throws. */
/** @internal test seam */
export function copyToProject(input: ProjectCopyInput): ProjectCopyOk | ProjectCopyFailure {
  const projectDir = typeof input.projectDir === "string" ? input.projectDir : ""
  try {
    if (typeof input.mission !== "string" || !MISSION_ID.test(input.mission)) throw new CopyRefusal("PATH_OUTSIDE_ROOT", projectDir, "the mission id is not a mission id")
    const doc = input.document
    const named = input.outputs.map((o) => {
      try {
        return { ...o, name: projectFileName(doc, o.format) }
      } catch (e) {
        throw new CopyRefusal("PATH_OUTSIDE_ROOT", projectDir, e instanceof Error ? e.message : "the document metadata does not give a safe file name")
      }
    })
    // Sources are checked before the project folder is touched (copyFilesInto repeats this; here nothing exists yet).
    for (const o of named) {
      if (!SHA256.test(o.sha256) || !(o.bytes instanceof Uint8Array) || sha256Of(o.bytes) !== o.sha256) throw new CopyRefusal("INTEGRITY_MISMATCH", projectDir, `the stored ${o.format} could not be read back with the store's sha256`)
    }
    if (!path.isAbsolute(projectDir)) throw new CopyRefusal("PROJECT_UNWRITABLE", projectDir, "the mission's project folder is not an absolute path")
    const st = statSync(projectDir, { throwIfNoEntry: false })
    if (!st || !st.isDirectory()) throw new CopyRefusal("PROJECT_UNWRITABLE", projectDir, "the mission's project folder does not exist")
    const project = realpathSync(projectDir)
    const storeRoot = input.storeRoot && statSync(input.storeRoot, { throwIfNoEntry: false }) ? realpathSync(input.storeRoot) : null
    if (storeRoot !== null && (project === storeRoot || project.startsWith(storeRoot + path.sep))) throw new CopyRefusal("PATH_OUTSIDE_ROOT", projectDir, "the mission's project folder is inside the Studio store")
    if (input.sessionRoot !== undefined) {
      const outside = projectDirOutsideRoot(projectDir, input.sessionRoot)
      if (outside !== null) throw new CopyRefusal("PATH_OUTSIDE_ROOT", projectDir, `the mission's project folder is outside the folder of this session: ${outside}; nothing is copied`)
    }
    const dir = ensureChildDir(ensureChildDir(project, PROJECT_DELIVERABLES_DIR, projectDir), input.mission, projectDir)
    if (dir !== path.join(project, PROJECT_DELIVERABLES_DIR, input.mission)) throw new CopyRefusal("PATH_OUTSIDE_ROOT", dir, "the deliverables folder does not resolve inside the project folder")
    // Row 147 (S9): every target passes the same containment rule the gate and the panel read with.
    for (const o of named) {
      const at = deliverablePath(project, input.mission, deliverableRelPath(input.mission, o.name))
      if (!at.ok) throw new CopyRefusal(at.reason === "link" ? "PATH_OUTSIDE_ROOT" : "OUTPUT_EXISTS", dir, at.reason === "link" ? `${at.at} is a symbolic link; it is not followed` : `${at.reason === "not-file" ? at.at : o.name} is taken by something that is not a file`)
    }
    const counts = copyFilesInto(dir, named, projectDir)
    const files = named.map((o): RowDeliverable => ({
      path: deliverableRelPath(input.mission, o.name),
      format: o.format,
      docRev: doc.docRev,
      revisionNo: doc.revisionNo,
      sha256: o.sha256,
      latest: true,
      ...(DOCUMENT_ID.test(doc.documentId) ? { documentId: doc.documentId } : {}),
    }))
    return { ok: true, dir, files, ...counts }
  } catch (e) {
    if (e instanceof CopyRefusal) return { ok: false, code: e.code, dir: e.dir, message: e.message }
    return { ok: false, code: "PROJECT_UNWRITABLE", dir: projectDir, message: `${errno(e)}: the project folder could not be used` }
  }
}

/**
 * The row's list after a copy: an item of the same path is replaced, older items stay. `latest` (register section 1)
 * is true on the items of the highest Studio revision listed for that document; items without a `documentId` keep
 * their mark. Above the row cap the oldest items that are not latest leave the LIST (their files stay on disk).
 */
/** @internal test seam */
export function mergeRowDeliverables(existing: readonly RowDeliverable[], fresh: readonly RowDeliverable[]): { list: RowDeliverable[]; dropped: number } {
  const paths = new Set(fresh.map((f) => f.path))
  const all = [...existing.filter((d) => !paths.has(d.path)), ...fresh]
  const newest = new Map<string, number>()
  for (const d of all) if (d.documentId !== undefined && typeof d.revisionNo === "number") newest.set(d.documentId, Math.max(newest.get(d.documentId) ?? -1, d.revisionNo))
  const marked = all.map((d) => (d.documentId === undefined ? d : { ...d, latest: d.revisionNo === newest.get(d.documentId) }))
  const over = marked.length - ROW_DELIVERABLES_MAX
  if (over <= 0) return { list: marked, dropped: 0 }
  const drop = new Set(
    marked
      .map((d, i) => ({ d, i }))
      .filter((x) => !x.d.latest)
      .sort((a, b) => (a.d.revisionNo ?? -1) - (b.d.revisionNo ?? -1) || a.i - b.i)
      .slice(0, over)
      .map((x) => x.i),
  )
  return { list: marked.filter((_, i) => !drop.has(i)), dropped: drop.size }
}

/** The store calls the hook needs (the installed SqliteStudioStore has them; `missions` is absent in narrow test stores). */
export interface ProjectCopyStore {
  readonly rootDir: string
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>
  readonly missions?: Pick<MissionStore, "rowContract" | "setRowDeliverables">
}
interface ProjectCopyRender {
  documentId: string
  revisionNo: number
  /** The PRIMARY outputs of this render (any format; only DOCX, PDF, HTML are copied). */
  outputs: ReadonlyArray<{ format: string; role: string; sha256: string; bytes: Uint8Array | null }>
}

/** Spec mission control §7.1: an owned document's row is in its docKey, `row-<rowId>-<slug>` (deliverables.ts ROW_KEY). */
const ROW_KEY = /^row-([1-9][0-9]{0,3}[a-z]?)-(.+)$/
const skip = (reason: ProjectCopySkipReason, message: string): ProjectCopyReply => ({ ok: false, skipped: true, reason, message })
export const projectCopySkipped = skip

/**
 * The hook of the render wrapper: finds the document's mission, project folder and row in the store, copies, and
 * records the files on the row through `setRowDeliverables` (row 5). Never throws; every refusal goes to the host log.
 * The mission is the document's owner (`document.mission_folder`); a document without one is not copied.
 * `sessionRoot` (row 147, M1): the calling session's folder (`HostToolSession.fileRoot`); the copy is made only into a
 * project folder that is that folder or inside it.
 */
export async function projectCopyAfterRender(store: ProjectCopyStore, render: ProjectCopyRender, log: MissionLog, sessionRoot: string): Promise<ProjectCopyReply> {
  const source = "studio_render.projectCopy"
  const context = { documentId: render.documentId, revisionNo: render.revisionNo }
  try {
    const outputs = render.outputs.filter((o) => o.role === "PRIMARY" && isProjectCopyFormat(o.format)).map((o) => ({ format: o.format as ProjectCopyFormat, sha256: o.sha256, bytes: o.bytes }))
    if (outputs.length === 0) return skip("no-document-output", "this render made no DOCX, PDF or HTML of the document")
    const found = await store.transaction(async (tx) => {
      const d = tx.get<{ doc_number: string; mission_folder: string | null; mission_doc_key: string | null; doc_rev: string | null }>(
        "SELECT d.doc_number, d.mission_folder, d.mission_doc_key, r.doc_rev FROM document d LEFT JOIN revision r ON r.document_id = d.id AND r.revision_no = ? WHERE d.id = ?",
        [render.revisionNo, render.documentId],
      )
      if (!d || !d.mission_folder) return null
      const m = tx.get<{ project_dir: string }>("SELECT project_dir FROM mission WHERE id = ?", [d.mission_folder])
      if (!m) return null
      const keyed = d.mission_doc_key ? (ROW_KEY.exec(d.mission_doc_key)?.[1] ?? null) : null
      const linked = keyed ?? tx.get<{ row_id: string | null }>("SELECT row_id FROM mission_document WHERE mission_id = ? AND document_id = ? ORDER BY revision_no DESC, time_linked DESC LIMIT 1", [d.mission_folder, render.documentId])?.row_id ?? null
      const row = linked !== null && tx.get("SELECT 1 AS x FROM mission_row WHERE mission_id = ? AND row_id = ?", [d.mission_folder, linked]) ? linked : null
      return { mission: d.mission_folder, projectDir: m.project_dir, docNumber: d.doc_number, docRev: d.doc_rev ?? "", row }
    })
    if (!found) return skip("no-mission", "the document belongs to no mission, so no project folder is known")
    const copied = copyToProject({
      projectDir: nativeProjectDir(found.projectDir),
      mission: found.mission,
      document: { documentId: render.documentId, docNumber: found.docNumber, docRev: found.docRev, revisionNo: render.revisionNo },
      outputs,
      storeRoot: store.rootDir,
      sessionRoot,
    })
    if (!copied.ok) {
      log("error", source, `project copy refused: ${copied.code}`, { ...context, mission: found.mission, row: found.row, code: copied.code, dir: copied.dir, message: copied.message })
      return copied
    }
    const base = { ok: true as const, dir: copied.dir }
    const missions = store.missions
    if (found.row === null || !missions) {
      log("warn", source, "project copy made; no mission row to record it on", { ...context, mission: found.mission, files: copied.files.map((f) => f.path) })
      return { ...base, files: copied.files, row: null, recorded: false, note: "the document is linked to no row of its mission (docKey row-<id>-<slug>)" }
    }
    const row = found.row
    try {
      const merged = await store.transaction(async (tx) => {
        const before = missions.rowContract(found.mission, row, tx).deliverables
        const next = mergeRowDeliverables(before, copied.files)
        if (JSON.stringify(next.list) !== JSON.stringify(before)) missions.setRowDeliverables(tx, found.mission, row, next.list)
        return next
      })
      const paths = new Set(copied.files.map((f) => f.path))
      log("info", source, "project copy made and recorded", { ...context, mission: found.mission, row, written: copied.written, kept: copied.kept, dropped: merged.dropped })
      return { ...base, files: merged.list.filter((d) => paths.has(d.path)), row, recorded: true, ...(merged.dropped > 0 ? { dropped: merged.dropped } : {}) }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      const code = typeof (e as { code?: unknown } | null)?.code === "string" ? String((e as { code: string }).code) : "ERROR"
      log("error", source, "project copy made but the row could not be updated", { ...context, mission: found.mission, row, code, message: err.message, stack_trace: err.stack })
      return { ...base, files: copied.files, row, recorded: false, note: `the row's deliverables list could not be updated (${/^[A-Z][A-Z0-9_]{1,60}$/.test(code) ? code : "ERROR"})` }
    }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    log("error", source, "project copy failed inside Studio", { ...context, message: err.message, stack_trace: err.stack })
    return skip("internal-error", "the project copy failed inside Studio; the host log has the cause")
  }
}

const SAFE_PATH = /^[A-Za-z0-9 _.,()@:/\\-]{1,512}$/
const plain = (s: string) => s.replace(/[^A-Za-z0-9 _.,:;()@'/\\-]/g, "?").slice(0, 300)

/** Reply text of `projectCopy`: safe characters only (vendor rule MCP-D4); the full object is in structuredContent. */
export function projectCopyLines(r: ProjectCopyReply): string[] {
  if (r.ok) {
    const folder = r.files[0] ? r.files[0].path.slice(0, r.files[0].path.lastIndexOf("/") + 1) : ""
    const where = r.recorded ? `row ${plain(r.row ?? "?")} deliverables updated` : `not recorded on a row: ${plain(r.note ?? "no row")}`
    return [
      `project copy: OK ${r.files.length} files in ${SAFE_PATH.test(folder) ? folder : "the project deliverables folder"} (${where})`,
      ...(SAFE_PATH.test(r.dir) ? [`  folder: ${r.dir}`] : []),
      ...r.files.map((f) => `  ${f.format} ${SAFE_PATH.test(f.path) ? f.path : "?"} sha256=${SHA256.test(f.sha256) ? f.sha256 : "?"}${f.latest ? " latest" : ""}`),
      ...(r.dropped ? [`  ${r.dropped} older items left the row's list (the files stay in the folder)`] : []),
    ]
  }
  if ("skipped" in r) return [`project copy: none (${r.reason}: ${plain(r.message)})`]
  return [
    `project copy: FAILED ${r.code} ${plain(r.message)}`,
    `  folder: ${plain(r.dir)}`,
    r.code === "PROJECT_UNWRITABLE"
      ? "  next: only the person can fix the project folder; ask with studio_mission_request_decision. The Studio store files listed above are complete."
      : "  next: nothing was overwritten; the Studio store files listed above are complete. Tell the person which file is in the way.",
  ]
}
