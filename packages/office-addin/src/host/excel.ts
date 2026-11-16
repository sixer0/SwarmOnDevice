// Excel executor (M8-03; FS §5 Excel column, §6.3, FR-01..FR-03, FR-14..FR-19). Thin:
// each call is one Excel.run batch that reads at action time and runs the pure plan of
// ../excel (M8-01). ExcelApi 1.1 members only. This file and memory.ts are the only src
// files that assign `values` or `numberFormat` (U-LINT-02); no formula property is
// ever named (FR-15).
import { OFFICE_CONTEXT_WHOLE } from "../constants"
import { completeWrite, prepareWrite, type Refusal, type WriteAction } from "../excel"
import type { ContextScope } from "../state/prompt"
import { errorDetail, failWith, refusedTarget, unsupported, type ExcelChanged, type ExcelHost } from "./types"

// Reads the selection, then plans the write: target, refusals, assignments (FR-02:
// every check completes before anything is assigned). A selection that cannot be
// loaded (multi-area, FR-19) gives office.error.selectionUnsupported.
async function plan(context: Excel.RequestContext, action: WriteAction, reply: string) {
  const selection = context.workbook.getSelectedRange()
  selection.load("address,rowCount,columnCount,rowIndex,columnIndex")
  const located = await context.sync().then(
    () => undefined,
    (error: unknown) => errorDetail(error),
  )
  if (located)
    return { kind: "failure" as const, failure: { ok: false as const, code: "office.error.selectionUnsupported" as const, detail: located } }

  const area = {
    rowCount: selection.rowCount,
    columnCount: selection.columnCount,
    rowIndex: selection.rowIndex,
    columnIndex: selection.columnIndex,
  }
  // Worksheet identity (M8-03a): the sheet part of the selection's address ("Sheet1",
  // "'My Sheet'"); the cell part never contains "!".
  const sheet = selection.address.slice(0, selection.address.lastIndexOf("!"))
  const refused = (refusal: Refusal) => ({
    kind: "refused" as const,
    refused: {
      ok: false as const,
      host: "Excel" as const,
      refusal,
      target: refusedTarget(action, reply, refusal, sheet, area),
    },
  })
  const prepared = prepareWrite(action, reply, area)
  if (!prepared.ok) return refused(prepared.refusal)

  const target = prepared.target
  const anchor =
    target.anchor === "below" ? selection.getLastRow().getOffsetRange(1, 0).getCell(0, 0) : selection.getCell(0, 0)
  const range = target.check === "none" ? selection : anchor.getBoundingRect(anchor.getCell(target.rows - 1, target.columns - 1))
  if (target.check !== "none") {
    range.load("values")
    await context.sync()
  }
  const complete = completeWrite(prepared, target.check === "none" ? undefined : range.values)
  if (!complete.ok) return refused(complete.refusal)
  return {
    kind: "plan" as const,
    range,
    plan: { ok: true as const, host: "Excel" as const, action, target: `${sheet}!${complete.target.address}`, plan: complete },
  }
}

export function excelHost(): ExcelHost {
  const supported = () => Office.context.requirements.isSetSupported("ExcelApi", "1.1")
  return {
    host: "Excel",
    supported,
    read: (scope: ContextScope) => {
      if (!supported()) return Promise.resolve(unsupported)
      return Excel.run(async (context) => {
        const range =
          scope === OFFICE_CONTEXT_WHOLE
            ? context.workbook.worksheets.getActiveWorksheet().getUsedRange()
            : context.workbook.getSelectedRange()
        range.load("address,rowCount,columnCount")
        const located = await context.sync().then(
          () => undefined,
          (error: unknown) => errorDetail(error),
        )
        if (located && scope !== OFFICE_CONTEXT_WHOLE)
          return { ok: false as const, code: "office.error.selectionUnsupported" as const, detail: located }
        if (located) return { ok: false as const, code: "office.error.readFailed" as const, detail: located }
        range.load("values")
        await context.sync()
        return {
          ok: true as const,
          host: "Excel" as const,
          scope,
          address: range.address,
          rowCount: range.rowCount,
          columnCount: range.columnCount,
          values: range.values,
        }
      }).catch(failWith("office.error.readFailed"))
    },
    preview: (action, reply) => {
      if (!supported()) return Promise.resolve(unsupported)
      return Excel.run(async (context) => {
        const result = await plan(context, action, reply)
        if (result.kind === "failure") return result.failure
        if (result.kind === "refused") return result.refused
        return result.plan
      }).catch(failWith("office.error.readFailed"))
    },
    write: (action, reply, expected) => {
      if (!supported()) return Promise.resolve(unsupported)
      return Excel.run(async (context) => {
        const result = await plan(context, action, reply)
        if (result.kind === "failure") return result.failure
        // FR-49: the preview showed another target; nothing is written until a new confirm.
        const target = result.kind === "plan" ? result.plan.target : undefined
        if (expected !== undefined && target !== expected) {
          const changed: ExcelChanged = {
            ok: false,
            changed: true,
            plan: result.kind === "plan" ? result.plan : result.refused,
          }
          return changed
        }
        if (result.kind === "refused") return result.refused
        // SC-45 / C14: numberFormat before values, in the order of the plan.
        result.plan.plan.assignments.forEach((assignment) => {
          if (assignment.property === "numberFormat") {
            result.range.numberFormat = assignment.value
            return
          }
          result.range.values = assignment.value
        })
        await context.sync()
        // FR-18 (H-4): select the written range; if select() fails the write still stands.
        result.range.select()
        const selected = await context.sync().then(
          () => true,
          () => false,
        )
        return { ok: true as const, host: "Excel" as const, plan: result.plan.plan, selected }
      }).catch(failWith("office.error.writeFailed"))
    },
  }
}
