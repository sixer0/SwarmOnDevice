// Deliverables panel helpers (row 132; masterplan/01_specs_mission_control_ui.md §6 items 32-34, §7, §12; C101, C102, C127).
// Pure: the row 129 view model -> what each deliverable line shows, and what a click does. The view never re-derives.
// 1.2.7 row 26 (U-2; U3, C10, SR7-12): every line found on disk carries `revealAbsPath` for "Reveal in Finder / File
// Explorer" (desktop `reveal-path`, showItemInFolder only); folder lines (origin "folder") are the non-Studio files in
// docs/<m>/11_deliverables/. Open is an allowlist by final extension; executables and every other type are reveal only.
import { fileNameOf, isStudioOutputName } from "../file-preview-policy"
import type { DeliverableStatus, MissionDeliverableVM, MissionVM } from "./mission-model"

type DeliverableOrigin = NonNullable<MissionDeliverableVM["origin"]>

/** N7-018: the numbered export folder that holds a mission's deliverables (equals Studio's N7-011, pinned by a test). */
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
}

// §12: the only path ever opened is docs/<mission id>/<name> (legacy flat) or docs/<mission id>/11_deliverables/<name>
// (N7-019, 1.2.7 U-2), nothing deeper and no "..". A Studio line's name is the delivered DATUM title name (row 165D) or
// the C51 final name (C102, row 165D), so a Studio PDF/HTML opens rendered in the tab. A folder line opens only by the
// SR7-12 allowlist of final extensions; a non-Studio .html opens as code (C101: it is never registered).
const PROJECT_PATH = /^docs\/[^/\\\u0000-\u001f]+\/(?:11_deliverables\/)?[^/\\\u0000-\u001f]+$/

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

export function deliverableLine(
  d: MissionDeliverableVM,
  selectedRow: string | undefined,
  directory?: string,
): DeliverableLine {
  const origin: DeliverableOrigin = d.origin ?? "studio"
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
    path: openablePath(d.projectPath, origin),
    revealAbsPath: revealPathOf(directory, d.projectPath),
    origin,
    selected: !!selectedRow && d.rowId === selectedRow,
  }
}

export function deliverableLines(
  model: Pick<MissionVM, "deliverables"> | null | undefined,
  selectedRow?: string,
  directory?: string,
) {
  return (model?.deliverables ?? []).map((d) => deliverableLine(d, selectedRow, directory))
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
