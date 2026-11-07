// Deliverables panel helpers (row 132; masterplan/01_specs_mission_control_ui.md §6 items 32-34, §7, §12; C101, C102, C127).
// Pure: the row 129 view model -> what each deliverable line shows, and what a click does. The view never re-derives.
import { fileNameOf, isStudioOutputName } from "../file-preview-policy"
import type { DeliverableFormat, DeliverableStatus, MissionDeliverableVM, MissionVM } from "./mission-model"

export type DeliverableLine = {
  documentId: string
  /** agent-written; rendered as text only (§12) */
  name: string
  /** the format tile: the first of PDF, DOCX, HTML; "-" when the current revision has no PRIMARY output */
  tile: DeliverableFormat | "-"
  /** the other formats, shown as "+ DOCX + HTML" */
  extra: DeliverableFormat[]
  /** TaskRef: the linked row's title, "-" without a row link (§7.1) */
  taskRef: string
  rowId?: string
  rev: string
  status: DeliverableStatus
  /** U24 (C127 ruling 1): any state other than verified shows Unverified */
  verified: boolean
  /** project path the click opens in a file tab, or null = the not-in-project state (§7.3 step 5) */
  path: string | null
  /** this deliverable's row is the selected row/agent of the HQ deck */
  selected: boolean
}

// §12: the only path ever opened is docs/<mission id>/<name>, name = the delivered DATUM title name (row 165D) or the
// C51 final name. The model built it from a listed, plain file name; this re-checks the shape and the Studio output
// name (C102, row 165D: C51 or DATUM form), so a Studio PDF/HTML opens rendered in the tab.
const PROJECT_PATH = /^docs\/[^/\\\u0000-\u001f]+\/[^/\\\u0000-\u001f]+$/

export function openablePath(path: string | null | undefined): string | null {
  if (!path || !PROJECT_PATH.test(path) || path.includes("..")) return null
  // Row 165E (C192): the path was built from the Studio store's delivered name (mission-model.ts), so the name check
  // suffices here; the mission poll registers the same path for the file tab (../studio-output-registry.ts).
  return isStudioOutputName(fileNameOf(path)) ? path : null
}

export function deliverableLine(d: MissionDeliverableVM, selectedRow: string | undefined): DeliverableLine {
  return {
    documentId: d.documentId,
    name: d.title,
    tile: d.formats[0] ?? "-",
    extra: d.formats.slice(1),
    taskRef: d.rowTitle ?? "-",
    rowId: d.rowId,
    rev: d.docRev,
    status: d.status,
    verified: d.verified === true,
    path: openablePath(d.projectPath),
    selected: !!selectedRow && d.rowId === selectedRow,
  }
}

export function deliverableLines(model: Pick<MissionVM, "deliverables"> | null | undefined, selectedRow?: string) {
  return (model?.deliverables ?? []).map((d) => deliverableLine(d, selectedRow))
}

/** `n/m final` (§7.2): Final count over all deliverables. Final already requires verified (row 129). */
export function finalTally(model: Pick<MissionVM, "deliverables"> | null | undefined) {
  const list = model?.deliverables ?? []
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
}

/** §6 item 34: a click selects the linked row (always, when linked) and opens the file when it is in the project. */
export function activateDeliverable(line: DeliverableLine, actions: DeliverableActions): "opened" | "not-in-project" {
  if (line.rowId) actions.selectRow?.(line.rowId)
  const path = openablePath(line.path)
  if (!path || !actions.openFile) return "not-in-project"
  actions.openFile(path)
  return "opened"
}
