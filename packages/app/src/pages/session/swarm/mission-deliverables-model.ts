// Deliverables panel helpers (row 132; masterplan/01_specs_mission_control_ui.md §6 items 32-34, §7, §12; C101, C102, C127).
// Pure: the row 129 view model -> what each deliverable line shows, and what a click does. The view never re-derives.
// 1.2.7 row 26 (U-2; U3, C10, SR7-12): every line found on disk carries `revealAbsPath` for "Reveal in Finder / File
// Explorer" (desktop `reveal-path`, showItemInFolder only); folder lines (origin "folder") are the non-Studio files in
// docs/<m>/11_deliverables/ (legacy, before 1.3.3). Open is an allowlist by final extension; executables and every other type are reveal only.
// 1.3.3 row 72 (MC-8 item 5, U16): each copy in <project>/deliverables/<mission>/ that the host lists (row 71
// `projectFiles`) becomes a `DeliverableLink` with Open (system default app) and Preview (PDF, HTML in the file tab).
// The path rules live here only; the view and row 73's two views call `deliverableLinks` / `runDeliverableLink`.
import { canonicalPathKey } from "@/utils/path-key"
import { fileNameOf, isStudioOutputName } from "../file-preview-policy"
import type { DeliverableStatus, MissionDeliverableVM, MissionVM, ProjectFileWire } from "./mission-model"

type DeliverableOrigin = NonNullable<MissionDeliverableVM["origin"]>

/**
 * LEGACY source (1.3.3 row 153, S5): the numbered export folder that held a mission's final files before 1.3.3 (equals
 * Studio's N7-011, pinned by a test). Missions made earlier still have files there and the export still creates the
 * folder, so the app keeps reading it, as "folder" lines. New finals live in `deliverables/<mission>/` (PROJECT_DELIVERABLES_DIR).
 */
export const MISSION_DELIVERABLES_DIR = "11_deliverables"

export type DeliverableLine = {
  documentId: string
  /** agent-written; rendered as text only (§12); bidi and control characters stripped (SR7-12) */
  name: string
  /** the format tile: the first of PDF, DOCX, HTML; "-" when the current revision has no PRIMARY output; a folder line
   * shows its upper-case extension */
  tile: string
  /** the other formats, shown as "+ DOCX + HTML" */
  extra: string[]
  /** TaskRef: the linked row's title, "-" without a row link (§7.1) */
  taskRef: string
  rowId?: string
  rev: string
  status: DeliverableStatus
  /** U24 (C127 ruling 1): any state other than verified shows Unverified */
  verified: boolean
  /** project path the click opens in a file tab, or null = the not-in-project state (§7.3 step 5) or reveal only */
  path: string | null
  /** N7-022: absolute path for "Reveal in Finder / File Explorer", any format; null when not found or no directory */
  revealAbsPath: string | null
  /** N7-123: a Studio deliverable, or a file placed in docs/<m>/11_deliverables/ that no Studio deliverable claims */
  origin: DeliverableOrigin
  /** this deliverable's row is the selected row/agent of the HQ deck */
  selected: boolean
  /** 1.3.3 row 72: the project copies, newest revision first (host order); empty without a project copy */
  links: DeliverableLink[]
}

// §12: the only path ever opened is docs/<mission id>/<name> (legacy flat) or docs/<mission id>/11_deliverables/<name>
// (N7-019, 1.2.7 U-2), nothing deeper and no "..". A Studio line's name is the delivered DATUM title name (row 165D) or
// the C51 final name (C102, row 165D), so a Studio PDF/HTML opens rendered in the tab. A folder line opens only by the
// SR7-12 allowlist of final extensions; a non-Studio .html opens as code (C101: it is never registered).
// 1.3.3 row 72 (register section 5): also deliverables/<mission id>/<name>, the project copy of row 68.
const PROJECT_PATH =
  /^(?:docs\/[^/\\\u0000-\u001f]+\/(?:11_deliverables\/)?|deliverables\/[^/\\\u0000-\u001f]+\/)[^/\\\u0000-\u001f]+$/

/** Register section 5 `PROJECT_DELIVERABLES_DIR`: the one folder per project that holds every mission's copies. */
export const PROJECT_DELIVERABLES_DIR = "deliverables"
const PROJECT_COPY = /^deliverables\/[^/\\\u0000-\u001f]+\/[^/\\\u0000-\u001f]+$/

/** SR7-12: the only types a folder line opens in the file tab (pdf html docx xlsx pptx md txt), case-insensitive. */
const FOLDER_OPEN = new Set(["pdf", "html", "docx", "xlsx", "pptx", "md", "txt"])

/** The final extension of a file name, lower case; "" without one (a leading dot is no extension). */
function extensionOf(name: string) {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
}

// SR7-12: bidi embedding/override/isolate characters and C0/C1 controls never reach a displayed name.
const UNSAFE_DISPLAY = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g
const displayName = (name: string) => name.replace(UNSAFE_DISPLAY, "")

function projectShape(path: string | null | undefined): path is string {
  return !!path && PROJECT_PATH.test(path) && !path.includes("..")
}

export function openablePath(path: string | null | undefined, origin: DeliverableOrigin = "studio"): string | null {
  if (!projectShape(path)) return null
  const name = fileNameOf(path)
  if (origin === "folder") return FOLDER_OPEN.has(extensionOf(name)) ? path : null
  // Row 165E (C192): the path was built from the Studio store's delivered name (mission-model.ts), so the name check
  // suffices here; the mission poll registers the same path for the file tab (../studio-output-registry.ts).
  return isStudioOutputName(name) ? path : null
}

/** N7-022: `<session directory>/<project path>`, joined with the directory's own separator (Windows keeps `\`). */
function revealPathOf(directory: string | undefined, path: string | null | undefined): string | null {
  if (!directory || !projectShape(path)) return null
  const sep = directory.includes("\\") && !directory.includes("/") ? "\\" : "/"
  const root = directory.replace(/[\\/]+$/, "")
  if (!root) return null
  return `${root}${sep}${path.split("/").join(sep)}`
}

// ── 1.3.3 row 72: project copies (MC-8 item 5)

/** One project copy of a deliverable, shaped for a link with two actions. Built only by `deliverableLinks`. */
export type DeliverableLink = {
  /** project-relative path as the host sent it (the link's key) */
  path: string
  /** upper case: PDF, DOCX, HTML */
  format: string
  /** "Rev D · rev 256": revision letter and Studio revision number; "" when the host sent neither */
  revision: string
  /** the revision the mission refers to (the highest Studio revision of the document) */
  latest: boolean
  /** the file is in the project folder now; false = the not-in-project state, no action */
  present: boolean
  /** absolute path handed to the desktop's open-deliverable channel; null = no Open */
  openAbsPath: string | null
  /** session-relative path for the existing file tab (PDF and HTML only); null = no Preview */
  previewPath: string | null
}

export type DeliverableLinkAction = "open" | "preview"

const PREVIEW_FORMATS = new Set(["PDF", "HTML"])
const REV_LETTER = /^[0-9A-Za-z]{1,8}$/

/** `deliverables/<mission>/<name>`: two plain segments below the folder, no dot segment, no hidden name. */
function projectCopyShape(path: unknown): path is string {
  if (typeof path !== "string" || path.length > 1024 || !PROJECT_COPY.test(path)) return false
  return path.split("/").every((part) => part !== "." && part !== ".." && !part.startsWith("."))
}

/** The same file in both spellings: `<directory>/<project path>` and the host's absolute path. */
function isProjectFile(absolutePath: string | undefined, directory: string | undefined, path: string) {
  if (!absolutePath || !directory) return false
  const root = directory.replace(/[\\/]+$/, "")
  if (!root) return false
  return canonicalPathKey(absolutePath) === canonicalPathKey(`${root}/${path}`)
}

function revisionLabel(file: Pick<ProjectFileWire, "docRev" | "revisionNo">) {
  const letter = typeof file.docRev === "string" && REV_LETTER.test(file.docRev) ? `Rev ${file.docRev}` : ""
  const no = Number.isInteger(file.revisionNo) && file.revisionNo! >= 0 ? `rev ${file.revisionNo}` : ""
  return [letter, no].filter(Boolean).join(" · ")
}

/**
 * The links of one deliverable's project copies, in the host's order (newest revision first, then PDF, DOCX, HTML).
 * `directory` = the mission's project folder as the app knows it; `sessionDirectory` = the folder the file tab reads
 * (default: the same). Rules, all fail closed:
 * - Open: present, the document type equals the name's extension (pdf html docx xlsx pptx md txt), the path is
 *   `deliverables/<mission>/<name>`, and the host's absolute path is that same file under `directory`.
 * - Preview: Open's rules, PDF or HTML, a Studio output name, and the project folder is the session's folder (the
 *   file tab reads nowhere else).
 */
export function deliverableLinks(
  files: readonly ProjectFileWire[] | null | undefined,
  directory?: string,
  sessionDirectory: string | undefined = directory,
): DeliverableLink[] {
  return (files ?? []).flatMap((file) => {
    if (!file || typeof file.path !== "string" || typeof file.format !== "string") return []
    const format = displayName(file.format).toUpperCase()
    const shaped = projectCopyShape(file.path)
    const ext = shaped ? extensionOf(fileNameOf(file.path)) : ""
    const openable =
      file.present === true &&
      shaped &&
      FOLDER_OPEN.has(ext) &&
      ext === format.toLowerCase() &&
      isProjectFile(file.absolutePath, directory, file.path)
    const previewable =
      openable &&
      PREVIEW_FORMATS.has(format) &&
      openablePath(file.path, "studio") !== null &&
      isProjectFile(file.absolutePath, sessionDirectory, file.path)
    return [
      {
        path: displayName(file.path),
        format,
        revision: revisionLabel(file),
        latest: file.latest === true,
        present: file.present === true,
        openAbsPath: openable ? file.absolutePath! : null,
        previewPath: previewable ? file.path : null,
      },
    ]
  })
}

export type DeliverableLinkActions = {
  /** `(abs) => platform.openDeliverable(abs)`: the desktop checks the path again and opens it in the default app */
  openSystem?: (absPath: string) => void
  /** opens the session-relative path in the existing file tab and shows the pane */
  previewFile?: (path: string) => void
}

/** The actions a link offers; with `actions`, only those that have a handler (no desktop bridge = no Open). */
export function linkActions(link: DeliverableLink, actions?: DeliverableLinkActions): DeliverableLinkAction[] {
  const open = link.present && link.openAbsPath !== null && (!actions || !!actions.openSystem)
  const preview = link.present && link.previewPath !== null && (!actions || !!actions.previewFile)
  return [...(open ? (["open"] as const) : []), ...(preview ? (["preview"] as const) : [])]
}

/** Runs one action of a link; false when the link does not offer it. The path is passed as data, nothing is built. */
export function runDeliverableLink(link: DeliverableLink, action: DeliverableLinkAction, actions: DeliverableLinkActions) {
  if (!linkActions(link, actions).includes(action)) return false
  if (action === "open") actions.openSystem!(link.openAbsPath!)
  else actions.previewFile!(link.previewPath!)
  return true
}

/** Consecutive links of one revision, so the view prints the revision once: latest first, older after. */
export function linkGroups(links: readonly DeliverableLink[]) {
  const groups: Array<{ revision: string; latest: boolean; links: DeliverableLink[] }> = []
  for (const link of links) {
    const last = groups[groups.length - 1]
    if (last && last.revision === link.revision && last.latest === link.latest) last.links.push(link)
    else groups.push({ revision: link.revision, latest: link.latest, links: [link] })
  }
  return groups
}

/** The links of the revision the mission refers to (for a compact place such as the decision card). */
export const latestLinks = (links: readonly DeliverableLink[]) => links.filter((link) => link.latest)

/** Row 73's entry: the links of a row's deliverable(s), or of one document, from the same view model. */
export function missionDeliverableLinks(
  model: Pick<MissionVM, "deliverables"> | null | undefined,
  of: { rowId?: string; documentId?: string },
  directory?: string,
  sessionDirectory: string | undefined = directory,
): DeliverableLink[] {
  if (!of.rowId && !of.documentId) return []
  return (model?.deliverables ?? [])
    .filter((d) => (of.documentId ? d.documentId === of.documentId : d.rowId === of.rowId))
    .flatMap((d) => deliverableLinks(d.projectFiles, directory, sessionDirectory))
}

export function deliverableLine(
  d: MissionDeliverableVM,
  selectedRow: string | undefined,
  directory?: string,
  sessionDirectory: string | undefined = directory,
): DeliverableLine {
  const origin: DeliverableOrigin = d.origin ?? "studio"
  const links = origin === "studio" ? deliverableLinks(d.projectFiles, directory, sessionDirectory) : []
  // 1.3.3 row 72: without a docs/<m>/ copy, the line's own click and Reveal use the latest project copy.
  const current = latestLinks(links)
  const ext = origin === "folder" ? extensionOf(d.title).toUpperCase() : ""
  return {
    documentId: d.documentId,
    name: displayName(d.title),
    tile: origin === "folder" ? ext || "-" : (d.formats[0] ?? "-"),
    extra: d.formats.slice(1),
    taskRef: d.rowTitle ?? "-",
    rowId: d.rowId,
    rev: d.docRev,
    status: d.status,
    verified: d.verified === true,
    path: openablePath(d.projectPath, origin) ?? current.find((link) => link.previewPath)?.previewPath ?? null,
    revealAbsPath:
      revealPathOf(directory, d.projectPath) ?? current.find((link) => link.openAbsPath)?.openAbsPath ?? null,
    origin,
    selected: !!selectedRow && d.rowId === selectedRow,
    links,
  }
}

export function deliverableLines(
  model: Pick<MissionVM, "deliverables"> | null | undefined,
  selectedRow?: string,
  directory?: string,
  sessionDirectory: string | undefined = directory,
) {
  return (model?.deliverables ?? []).map((d) => deliverableLine(d, selectedRow, directory, sessionDirectory))
}

/** `n/m final` (§7.2): Final count over all deliverables. Final already requires verified (row 129). */
export function finalTally(model: Pick<MissionVM, "deliverables"> | null | undefined) {
  // 1.2.7 U-2 (N7-123): folder lines carry no status and never count.
  const list = (model?.deliverables ?? []).filter((d) => d.origin !== "folder")
  return { final: list.filter((d) => d.status === "final" && d.verified === true).length, total: list.length }
}

/** "+ DOCX + HTML · Contract tests · Rev A" (V6:375). */
export function lineMeta(line: Pick<DeliverableLine, "extra" | "taskRef" | "rev">) {
  const extra = line.extra.length > 0 ? `+ ${line.extra.join(" + ")} · ` : ""
  return `${extra}${line.taskRef} · ${line.rev}`
}

export type DeliverableActions = {
  /** shared HQ selection (row 130/131 deck): select the linked row/agent */
  selectRow?: (rowId: string) => void
  /** opens a session-relative path in the existing file tab: `(p) => openTab(file.tab(p))` (session-side-panel.tsx:747) */
  openFile?: (path: string) => void
  /** 1.2.7 row 58e (L-2): after the file tab is opened, show the review/file pane with that tab active; called only for
   * a document line that opened (never for reveal or an executable). */
  openPane?: (path: string) => void
  /** N7-023: `(abs) => platform.revealPath(abs)`: desktop reveal-path, showItemInFolder only (never opens, U3) */
  revealFile?: (absPath: string) => void
}

/** §6 item 34: a click selects the linked row (always, when linked) and opens the file when it is in the project. */
export function activateDeliverable(line: DeliverableLine, actions: DeliverableActions): "opened" | "not-in-project" {
  if (line.rowId) actions.selectRow?.(line.rowId)
  const path = openablePath(line.path, line.origin)
  if (!path || !actions.openFile) return "not-in-project"
  actions.openFile(path)
  actions.openPane?.(path)
  return "opened"
}

// ── 1.3.3 row 73: the same links on the decision card, the row view and the mission summary

/**
 * The documents an open decision concerns: deliverables of the rows the request blocks (`blockingRows`, as the host
 * sent them) that have at least one project copy. Order of the model's deliverables. Nothing comes from decision text.
 */
export function decisionDocumentIds(model: Pick<MissionVM, "decision" | "deliverables"> | null | undefined) {
  const rows = new Set(model?.decision?.blockingRows ?? [])
  if (!model || rows.size === 0) return []
  return model.deliverables
    .filter((d) => d.rowId !== undefined && rows.has(d.rowId) && (d.projectFiles?.length ?? 0) > 0)
    .map((d) => d.documentId)
}

/** The document ids of the mission summary: every deliverable with a project copy, once. */
export const summaryDocumentIds = (model: Pick<MissionVM, "deliverables"> | null | undefined) =>
  (model?.deliverables ?? []).filter((d) => (d.projectFiles?.length ?? 0) > 0).map((d) => d.documentId)
