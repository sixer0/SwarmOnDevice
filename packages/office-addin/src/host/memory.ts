// In-memory host adapters for component tests (M8-03). Same contract as word.ts and
// excel.ts and the same pure plans (planWordWrite, ../excel prepareWrite/completeWrite);
// the document is a string (Word) or a cell map (Excel), and every executor call is
// recorded in `calls` so a test can assert what would reach Office.js.
import { OFFICE_CONTEXT_WHOLE } from "../constants"
import { address, completeWrite, prepareWrite, type ExcelValue, type Refusal, type WriteAction } from "../excel"
import type { ContextScope } from "../state/prompt"
import { refusedTarget, unsupported, type ExcelChanged, type ExcelHost, type HostFailure, type WordAnchor, type WordHost } from "./types"
import { planWordWrite, sameAnchor, samePlan } from "./word"

type MemoryFault = "read" | "write"

// ---------- Word ----------

type WordCall = { method: "insertText"; text: string; location: "After" | "Replace" }

type MemoryWordDoc = {
  body: string
  // Selection text as Word returns it ("" = collapsed; a whole paragraph ends with "\r").
  selection: string
  // Location identity of the selection (M8-03c). A test moves the caret or picks another
  // range with the same text by changing it; the preview anchor records it.
  position: number
  supported: boolean
  fault?: MemoryFault
  calls: WordCall[]
  // M8-03d: every anchor released, by `release` or consumed by `write` (as word.ts does).
  releases: WordAnchor[]
}

const fault = (code: HostFailure["code"]): HostFailure => ({
  ok: false,
  code,
  detail: { name: "MemoryFault", message: "simulated Office.js error" },
})

export function memoryWordHost(
  input: Partial<Omit<MemoryWordDoc, "calls" | "releases">> = {},
): WordHost & { doc: MemoryWordDoc } {
  const doc: MemoryWordDoc = { body: "", selection: "", position: 0, supported: true, ...input, calls: [], releases: [] }
  return {
    host: "Word",
    doc,
    supported: () => doc.supported,
    read: async (scope: ContextScope) => {
      if (!doc.supported) return unsupported
      if (doc.fault === "read") return fault("office.error.readFailed")
      return { ok: true, host: "Word", scope, text: scope === OFFICE_CONTEXT_WHOLE ? doc.body : doc.selection }
    },
    preview: async (action, reply) => {
      if (!doc.supported) return unsupported
      if (doc.fault === "read") return fault("office.error.readFailed")
      return { ...planWordWrite(action, reply, doc.selection), anchor: { kind: "memory" as const, position: doc.position } }
    },
    write: async (action, reply, expected) => {
      if (!doc.supported) return unsupported
      // Like word.ts, a write consumes the previewed anchor on every path.
      if (expected?.anchor) doc.releases.push(expected.anchor)
      if (doc.fault) return fault("office.error.writeFailed")
      const anchor = { kind: "memory" as const, position: doc.position }
      const plan = planWordWrite(action, reply, doc.selection)
      const moved = expected?.anchor !== undefined && !sameAnchor(expected.anchor, anchor)
      if (expected && (moved || !samePlan(plan, expected))) return { ok: false, changed: true, plan: { ...plan, anchor } }
      doc.calls.push({ method: "insertText", text: plan.text, location: plan.location })
      return { ok: true, host: "Word", plan }
    },
    release: async (plan) => {
      if (plan.anchor) doc.releases.push(plan.anchor)
    },
  }
}

// ---------- Excel ----------

type ExcelCall =
  | { method: "numberFormat" | "values"; address: string; value: (string | number | null)[][] }
  | { method: "select"; address: string }

type MemorySelection = { rowIndex: number; columnIndex: number; rowCount: number; columnCount: number }

type MemoryWorkbook = {
  // Cell values keyed by A1 address ("B2"); a missing key is an empty cell "".
  cells: Map<string, ExcelValue>
  formats: Map<string, string>
  // Active worksheet name; a test switches sheets by changing it (M8-03a). The cell map
  // is per workbook, so a switch only changes the identity, not the cells.
  sheet: string
  // "multi" simulates a multi-area selection (FR-19).
  selection: MemorySelection | "multi"
  supported: boolean
  fault?: MemoryFault
  calls: ExcelCall[]
}

function grid(book: MemoryWorkbook, area: MemorySelection) {
  return Array.from({ length: area.rowCount }, (_, r) =>
    Array.from(
      { length: area.columnCount },
      (_, c) => book.cells.get(address(area.rowIndex + r, area.columnIndex + c, 1, 1)) ?? "",
    ),
  )
}

function used(book: MemoryWorkbook): MemorySelection {
  const filled = [...book.cells.entries()]
    .filter((entry) => entry[1] !== "" && entry[1] !== null && entry[1] !== undefined)
    .map((entry) => /^([A-Z]+)(\d+)$/.exec(entry[0]))
    .filter((match) => match !== null)
    .map((match) => ({
      row: Number(match[2]) - 1,
      column: [...match[1]].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1,
    }))
  if (filled.length === 0) return { rowIndex: 0, columnIndex: 0, rowCount: 1, columnCount: 1 }
  const top = Math.min(...filled.map((cell) => cell.row))
  const left = Math.min(...filled.map((cell) => cell.column))
  return {
    rowIndex: top,
    columnIndex: left,
    rowCount: Math.max(...filled.map((cell) => cell.row)) - top + 1,
    columnCount: Math.max(...filled.map((cell) => cell.column)) - left + 1,
  }
}

function planFor(book: MemoryWorkbook, action: WriteAction, reply: string, selection: MemorySelection) {
  const prepared = prepareWrite(action, reply, selection)
  const refused = (refusal: Refusal) => ({
    ok: false as const,
    host: "Excel" as const,
    refusal,
    target: refusedTarget(action, reply, refusal, book.sheet, selection),
  })
  if (!prepared.ok) return refused(prepared.refusal)
  const target = prepared.target
  const values =
    target.check === "none"
      ? undefined
      : grid(book, {
          rowIndex: target.rowIndex ?? 0,
          columnIndex: target.columnIndex ?? 0,
          rowCount: target.rows,
          columnCount: target.columns,
        })
  const complete = completeWrite(prepared, values)
  if (!complete.ok) return refused(complete.refusal)
  return { ok: true as const, host: "Excel" as const, action, target: `${book.sheet}!${complete.target.address}`, plan: complete }
}

export function memoryExcelHost(
  input: Partial<Omit<MemoryWorkbook, "calls" | "cells" | "formats">> & { cells?: Record<string, ExcelValue> } = {},
): ExcelHost & { book: MemoryWorkbook } {
  const book: MemoryWorkbook = {
    selection: { rowIndex: 0, columnIndex: 0, rowCount: 1, columnCount: 1 },
    sheet: "Sheet1",
    supported: true,
    ...input,
    cells: new Map(Object.entries(input.cells ?? {})),
    formats: new Map(),
    calls: [],
  }
  return {
    host: "Excel",
    book,
    supported: () => book.supported,
    read: async (scope: ContextScope) => {
      if (!book.supported) return unsupported
      if (scope !== OFFICE_CONTEXT_WHOLE && book.selection === "multi")
        return fault("office.error.selectionUnsupported")
      if (book.fault === "read") return fault("office.error.readFailed")
      const area = scope === OFFICE_CONTEXT_WHOLE || book.selection === "multi" ? used(book) : book.selection
      return {
        ok: true,
        host: "Excel",
        scope,
        address: `${book.sheet}!` + address(area.rowIndex, area.columnIndex, area.rowCount, area.columnCount),
        rowCount: area.rowCount,
        columnCount: area.columnCount,
        values: grid(book, area),
      }
    },
    preview: async (action, reply) => {
      if (!book.supported) return unsupported
      if (book.selection === "multi") return fault("office.error.selectionUnsupported")
      if (book.fault === "read") return fault("office.error.readFailed")
      return planFor(book, action, reply, book.selection)
    },
    write: async (action, reply, expected) => {
      if (!book.supported) return unsupported
      if (book.selection === "multi") return fault("office.error.selectionUnsupported")
      if (book.fault) return fault("office.error.writeFailed")
      const result = planFor(book, action, reply, book.selection)
      const target = result.ok ? result.target : undefined
      if (expected !== undefined && target !== expected) {
        const changed: ExcelChanged = { ok: false, changed: true, plan: result }
        return changed
      }
      if (!result.ok) return result
      const plan = result.plan
      const at = plan.target.address ?? ""
      const origin = { row: plan.target.rowIndex ?? 0, column: plan.target.columnIndex ?? 0 }
      const key = (r: number, c: number) => address(origin.row + r, origin.column + c, 1, 1)
      plan.assignments.forEach((assignment) => {
        book.calls.push({ method: assignment.property, address: at, value: assignment.value })
        if (assignment.property === "values") {
          assignment.value.forEach((row, r) => row.forEach((value, c) => book.cells.set(key(r, c), value)))
          return
        }
        assignment.value.forEach((row, r) =>
          row.forEach((value, c) => {
            if (value !== null) book.formats.set(key(r, c), value)
          }),
        )
      })
      book.calls.push({ method: "select", address: at })
      book.selection = {
        rowIndex: origin.row,
        columnIndex: origin.column,
        rowCount: plan.target.rows,
        columnCount: plan.target.columns,
      }
      return { ok: true, host: "Excel", plan, selected: true }
    },
  }
}
