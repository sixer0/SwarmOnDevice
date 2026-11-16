import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { address, type ExcelValue } from "../excel"
import { excelHost } from "./excel"
import { memoryExcelHost, memoryWordHost } from "./memory"
import { wordHost } from "./word"

// ---------- fake Office.js object model (WordApi / ExcelApi 1.1 subset) ----------

type Op = [string, ...unknown[]]

function installOffice(sets: string[]) {
  Object.assign(globalThis, {
    Office: { context: { requirements: { isSetSupported: (name: string, version: string) => sets.includes(`${name} ${version}`) } } },
  })
}

function installWord(doc: { selection: string; body: string; fail?: boolean }) {
  const ops: Op[] = []
  const selection = {
    text: "",
    load: () => ops.push(["load", "selection"]),
    insertText: (text: string, location: string) => ops.push(["insertText", text, location]),
  }
  const body = { text: "", load: () => ops.push(["load", "body"]) }
  const context = {
    document: { getSelection: () => selection, body },
    sync: async () => {
      if (doc.fail) throw Object.assign(new Error("GeneralException"), { code: "GeneralException" })
      selection.text = doc.selection
      body.text = doc.body
      ops.push(["sync"])
    },
  }
  Object.assign(globalThis, { Word: { run: (batch: (ctx: typeof context) => Promise<unknown>) => batch(context) } })
  return ops
}

type Sheet = { name: string; cells: Map<string, ExcelValue>; ops: Op[]; multi?: boolean }

class FakeRange {
  constructor(
    readonly sheet: Sheet,
    readonly rowIndex: number,
    readonly columnIndex: number,
    readonly rowCount: number,
    readonly columnCount: number,
  ) {
    if (rowIndex < 0 || columnIndex < 0 || rowIndex + rowCount > 1_048_576) throw new Error("InvalidArgument")
  }
  get address() {
    return `${this.sheet.name}!` + address(this.rowIndex, this.columnIndex, this.rowCount, this.columnCount)
  }
  get values() {
    return Array.from({ length: this.rowCount }, (_, r) =>
      Array.from(
        { length: this.columnCount },
        (_, c) => this.sheet.cells.get(address(this.rowIndex + r, this.columnIndex + c, 1, 1)) ?? "",
      ),
    )
  }
  set values(value: ExcelValue[][]) {
    this.sheet.ops.push(["values", this.address, value])
    value.forEach((row, r) =>
      row.forEach((cell, c) => this.sheet.cells.set(address(this.rowIndex + r, this.columnIndex + c, 1, 1), cell)),
    )
  }
  set numberFormat(value: (string | null)[][]) {
    this.sheet.ops.push(["numberFormat", this.address, value])
  }
  load(fields: string) {
    this.sheet.ops.push(["load", this.address, fields])
  }
  select() {
    this.sheet.ops.push(["select", this.address])
  }
  getLastRow() {
    return new FakeRange(this.sheet, this.rowIndex + this.rowCount - 1, this.columnIndex, 1, this.columnCount)
  }
  getOffsetRange(rows: number, columns: number) {
    return new FakeRange(this.sheet, this.rowIndex + rows, this.columnIndex + columns, this.rowCount, this.columnCount)
  }
  getCell(row: number, column: number) {
    return new FakeRange(this.sheet, this.rowIndex + row, this.columnIndex + column, 1, 1)
  }
  getBoundingRect(other: FakeRange) {
    const top = Math.min(this.rowIndex, other.rowIndex)
    const left = Math.min(this.columnIndex, other.columnIndex)
    const bottom = Math.max(this.rowIndex + this.rowCount, other.rowIndex + other.rowCount)
    const right = Math.max(this.columnIndex + this.columnCount, other.columnIndex + other.columnCount)
    return new FakeRange(this.sheet, top, left, bottom - top, right - left)
  }
}

function installExcel(input: {
  selection: [number, number, number, number]
  cells?: Record<string, ExcelValue>
  multi?: boolean
  sheet?: string
}) {
  const sheet: Sheet = { name: input.sheet ?? "Sheet1", cells: new Map(Object.entries(input.cells ?? {})), ops: [], multi: input.multi }
  const selected = new FakeRange(sheet, ...input.selection)
  const context = {
    workbook: {
      getSelectedRange: () => selected,
      worksheets: { getActiveWorksheet: () => ({ getUsedRange: () => new FakeRange(sheet, 0, 0, 2, 2) }) },
    },
    sync: async () => {
      if (sheet.multi) throw Object.assign(new Error("InvalidSelection"), { code: "InvalidSelection" })
      sheet.ops.push(["sync"])
    },
  }
  Object.assign(globalThis, { Excel: { run: (batch: (ctx: typeof context) => Promise<unknown>) => batch(context) } })
  return sheet
}

afterEach(() => {
  Object.assign(globalThis, { Office: undefined, Word: undefined, Excel: undefined })
})

const writes = (ops: Op[]) => ops.filter((op) => op[0] === "insertText" || op[0] === "values" || op[0] === "numberFormat")

// ---------- U-UI-11 (D6, C22) ----------

describe("U-UI-11 Word Insert plan (D6), in-memory adapter", () => {
  test("selection ending with \\r: one insertText(text + \\n, After)", async () => {
    const host = memoryWordHost({ selection: "Alpha line one.\r" })
    const result = await host.write("insert", "S3-LINE-1\nS3-LINE-2\n")
    expect(result.ok).toBe(true)
    expect(host.doc.calls).toEqual([{ method: "insertText", text: "S3-LINE-1\nS3-LINE-2\n", location: "After" }])
  })

  test("selection without trailing \\r and collapsed selection: text unchanged", async () => {
    const partial = memoryWordHost({ selection: "Alpha line" })
    await partial.write("insert", "S3-LINE-1\nS3-LINE-2")
    expect(partial.doc.calls).toEqual([{ method: "insertText", text: "S3-LINE-1\nS3-LINE-2", location: "After" }])
    const collapsed = memoryWordHost({ selection: "" })
    await collapsed.write("insert", "S3-LINE-1\r\nS3-LINE-2\r\n")
    expect(collapsed.doc.calls).toEqual([{ method: "insertText", text: "S3-LINE-1\nS3-LINE-2", location: "After" }])
  })

  test("Replace keeps the paragraph mark: no break appended", async () => {
    const host = memoryWordHost({ selection: "Delta line four.\r" })
    await host.write("replace", "S3-LINE-1\nS3-LINE-2")
    expect(host.doc.calls).toEqual([{ method: "insertText", text: "S3-LINE-1\nS3-LINE-2", location: "Replace" }])
  })
})

// ---------- Word executor (word.ts) against the fake Word.run ----------

describe("Word executor", () => {
  test("D6 in one Word.run: read selection, then one insertText", async () => {
    installOffice(["WordApi 1.1"])
    const ops = installWord({ selection: "Alpha line one.\r", body: "" })
    const result = await wordHost().write("insert", "S3-LINE-1\nS3-LINE-2")
    expect(result.ok).toBe(true)
    expect(ops).toEqual([["load", "selection"], ["sync"], ["insertText", "S3-LINE-1\nS3-LINE-2\n", "After"], ["sync"]])
  })

  test("collapsed and replace pass the text unchanged", async () => {
    installOffice(["WordApi 1.1"])
    const collapsed = installWord({ selection: "", body: "" })
    await wordHost().write("insert", "one")
    expect(writes(collapsed)).toEqual([["insertText", "one", "After"]])
    const replace = installWord({ selection: "Delta line four.\r", body: "" })
    await wordHost().write("replace", "one\ntwo\n")
    expect(writes(replace)).toEqual([["insertText", "one\ntwo", "Replace"]])
  })

  test("reads selection or body at call time", async () => {
    installOffice(["WordApi 1.1"])
    installWord({ selection: "Sel\r", body: "Body\r\u0002" })
    expect(await wordHost().read("selection")).toEqual({ ok: true, host: "Word", scope: "selection", text: "Sel\r" })
    expect(await wordHost().read("whole")).toEqual({ ok: true, host: "Word", scope: "whole", text: "Body\r\u0002" })
  })

  test("FR-49: a moved selection writes nothing and returns the fresh plan", async () => {
    installOffice(["WordApi 1.1"])
    installWord({ selection: "Alpha\r", body: "" })
    const preview = await wordHost().preview("insert", "x")
    if (!preview.ok) throw new Error("expected a plan")
    const ops = installWord({ selection: "Bravo\r", body: "" })
    const result = await wordHost().write("insert", "x", preview)
    expect(result).toMatchObject({ ok: false, changed: true, plan: { selection: "Bravo\r", text: "x\n" } })
    expect(writes(ops)).toEqual([])
  })

  test("Office errors map to readFailed / writeFailed; WordApi 1.1 missing is refused", async () => {
    installOffice(["WordApi 1.1"])
    installWord({ selection: "", body: "", fail: true })
    expect(await wordHost().read("selection")).toMatchObject({ ok: false, code: "office.error.readFailed" })
    expect(await wordHost().write("insert", "x")).toMatchObject({
      ok: false,
      code: "office.error.writeFailed",
      detail: { code: "GeneralException" },
    })
    installOffice([])
    const ops = installWord({ selection: "", body: "" })
    expect(wordHost().supported()).toBe(false)
    expect(await wordHost().write("insert", "x")).toMatchObject({ ok: false, reason: "unsupported" })
    expect(ops).toEqual([])
  })
})

// ---------- Excel executor (excel.ts) against the fake Excel.run ----------

describe("Excel executor", () => {
  test("insert below the selection: numberFormat, then values, then select()", async () => {
    installOffice(["ExcelApi 1.1"])
    const sheet = installExcel({ selection: [2, 7, 1, 2], cells: { H3: "a", I3: "b" } })
    const result = await excelHost().write("insert", "=SUM(A1)\t42")
    expect(result).toMatchObject({ ok: true, selected: true, plan: { target: { address: "H4:I4" } } })
    expect(sheet.ops.filter((op) => op[0] !== "load" && op[0] !== "sync")).toEqual([
      ["numberFormat", "Sheet1!H4:I4", [["@", null]]],
      ["values", "Sheet1!H4:I4", [["=SUM(A1)", 42]]],
      ["select", "Sheet1!H4:I4"],
    ])
  })

  test("numbers only: no numberFormat assignment", async () => {
    installOffice(["ExcelApi 1.1"])
    const sheet = installExcel({ selection: [0, 0, 1, 2] })
    await excelHost().write("replace", "1\t-2.5")
    expect(writes(sheet.ops)).toEqual([["values", "Sheet1!A1:B1", [[1, -2.5]]]])
  })

  test("replace on one cell grows to the payload; anchor may be non-empty", async () => {
    installOffice(["ExcelApi 1.1"])
    const sheet = installExcel({ selection: [0, 7, 1, 1], cells: { H1: "old" } })
    const result = await excelHost().write("replace", "x\ty")
    expect(result).toMatchObject({ ok: true, plan: { target: { address: "H1:I1" } } })
    expect(sheet.cells.get("H1")).toBe("x")
  })

  test("refusals write nothing (FR-02, FR-17)", async () => {
    installOffice(["ExcelApi 1.1"])
    const busy = installExcel({ selection: [0, 0, 1, 1], cells: { A2: "keep" } })
    expect(await excelHost().write("insert", "x")).toMatchObject({
      ok: false,
      refusal: { code: "office.error.targetNotEmpty" },
    })
    expect(writes(busy.ops)).toEqual([])
    const shape = installExcel({ selection: [0, 0, 2, 2] })
    expect(await excelHost().write("replace", "a\tb\tc")).toMatchObject({
      ok: false,
      refusal: { code: "office.error.shapeMismatch" },
    })
    expect(writes(shape.ops)).toEqual([])
  })

  test("FR-49: another target than the preview writes nothing", async () => {
    installOffice(["ExcelApi 1.1"])
    installExcel({ selection: [0, 0, 1, 1] })
    const preview = await excelHost().preview("insert", "x")
    expect(preview).toMatchObject({ ok: true, target: "Sheet1!A2", plan: { target: { address: "A2" } } })
    const sheet = installExcel({ selection: [4, 1, 1, 1] })
    expect(await excelHost().write("insert", "x", "Sheet1!A2")).toMatchObject({ ok: false, changed: true })
    expect(writes(sheet.ops)).toEqual([])
  })

  test("M8-03a FR-49: same address on another sheet writes nothing and returns the new plan", async () => {
    installOffice(["ExcelApi 1.1"])
    installExcel({ selection: [1, 1, 1, 1], sheet: "Sheet1" })
    const preview = await excelHost().preview("replace", "x")
    if (!preview.ok || !("target" in preview)) throw new Error("expected a plan")
    expect(preview.target).toBe("Sheet1!B2")
    const other = installExcel({ selection: [1, 1, 1, 1], sheet: "Sheet2" })
    const result = await excelHost().write("replace", "x", preview.target)
    expect(result).toMatchObject({ ok: false, changed: true, plan: { ok: true, target: "Sheet2!B2" } })
    expect(writes(other.ops)).toEqual([])
    expect(other.ops.filter((op) => op[0] === "select")).toEqual([])
    const same = installExcel({ selection: [1, 1, 1, 1], sheet: "Sheet1" })
    expect(await excelHost().write("replace", "x", preview.target)).toMatchObject({ ok: true })
    expect(writes(same.ops)).toEqual([["numberFormat", "Sheet1!B2", [["@"]]], ["values", "Sheet1!B2", [["x"]]]])
  })

  test("M8-03a: quoted sheet names keep their identity", async () => {
    installOffice(["ExcelApi 1.1"])
    installExcel({ selection: [0, 0, 1, 1], sheet: "'Q1 Data'" })
    expect(await excelHost().preview("insert", "x")).toMatchObject({ target: "'Q1 Data'!A2" })
  })

  test("reads selection and used range with address and size", async () => {
    installOffice(["ExcelApi 1.1"])
    installExcel({ selection: [1, 1, 1, 2], cells: { B2: 5, C2: "t", A1: "h" } })
    expect(await excelHost().read("selection")).toEqual({
      ok: true,
      host: "Excel",
      scope: "selection",
      address: "Sheet1!B2:C2",
      rowCount: 1,
      columnCount: 2,
      values: [[5, "t"]],
    })
    expect(await excelHost().read("whole")).toMatchObject({ ok: true, address: "Sheet1!A1:B2", values: [["h", ""], ["", 5]] })
  })

  test("multi-area selection: selectionUnsupported; ExcelApi 1.1 missing is refused", async () => {
    installOffice(["ExcelApi 1.1"])
    installExcel({ selection: [0, 0, 1, 1], multi: true })
    expect(await excelHost().read("selection")).toMatchObject({ ok: false, code: "office.error.selectionUnsupported" })
    expect(await excelHost().write("insert", "x")).toMatchObject({ ok: false, code: "office.error.selectionUnsupported" })
    installOffice(["WordApi 1.1"])
    const sheet = installExcel({ selection: [0, 0, 1, 1] })
    expect(excelHost().supported()).toBe(false)
    expect(await excelHost().write("insert", "x")).toMatchObject({ ok: false, reason: "unsupported" })
    expect(sheet.ops).toEqual([])
  })
})

// ---------- in-memory Excel adapter parity ----------

describe("in-memory Excel adapter", () => {
  test("same plan as the executor; writes cells, formats and selects the target", async () => {
    const host = memoryExcelHost({ selection: { rowIndex: 2, columnIndex: 7, rowCount: 1, columnCount: 2 } })
    const result = await host.write("insert", "=SUM(A1)\t42")
    expect(result).toMatchObject({ ok: true, plan: { target: { address: "H4:I4" } } })
    expect(host.book.calls.map((call) => call.method)).toEqual(["numberFormat", "values", "select"])
    expect(host.book.cells.get("H4")).toBe("=SUM(A1)")
    expect(host.book.formats.get("H4")).toBe("@")
    expect(host.book.formats.has("I4")).toBe(false)
    expect(await host.read("selection")).toMatchObject({ address: "Sheet1!H4:I4", values: [["=SUM(A1)", 42]] })
  })

  test("M8-03a: sheet switch between preview and write writes nothing", async () => {
    const host = memoryExcelHost({ selection: { rowIndex: 1, columnIndex: 1, rowCount: 1, columnCount: 1 } })
    const preview = await host.preview("replace", "x")
    if (!preview.ok) throw new Error("expected a plan")
    expect(preview.target).toBe("Sheet1!B2")
    host.book.sheet = "Sheet2"
    expect(await host.write("replace", "x", preview.target)).toMatchObject({
      ok: false,
      changed: true,
      plan: { target: "Sheet2!B2" },
    })
    expect(host.book.calls).toEqual([])
  })

  test("refusal, multi-area and fault", async () => {
    const busy = memoryExcelHost({ cells: { A2: "keep" } })
    expect(await busy.write("insert", "x")).toMatchObject({ refusal: { code: "office.error.targetNotEmpty" } })
    expect(busy.book.calls).toEqual([])
    expect(await memoryExcelHost({ selection: "multi" }).read("selection")).toMatchObject({
      code: "office.error.selectionUnsupported",
    })
    expect(await memoryExcelHost({ fault: "write" }).write("insert", "x")).toMatchObject({
      code: "office.error.writeFailed",
    })
  })
})

// ---------- U-LINT-02, adapter part ----------

describe("U-LINT-02 (adapter part): only the host adapters write to the document", () => {
  test("no other src file calls insertText or assigns values / numberFormat", async () => {
    const root = path.resolve(import.meta.dir, "..")
    const allowed = ["host/word.ts", "host/excel.ts", "host/memory.ts"]
    const files = Array.from(new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: root })).filter(
      (file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx") && !allowed.includes(file),
    )
    expect(files.length).toBeGreaterThan(5)
    const pattern = /insertText|\.values\s*=(?!=)|\.numberFormat\s*=(?!=)|\[\s*["'](values|numberFormat)["']\s*\]\s*=(?!=)/
    const offenders = (
      await Promise.all(files.map(async (file) => ({ file, text: await Bun.file(path.join(root, file)).text() })))
    )
      .filter((entry) => pattern.test(entry.text))
      .map((entry) => entry.file)
    expect(offenders).toEqual([])
  })

  test("the adapters name no formula property (FR-15)", async () => {
    const root = path.resolve(import.meta.dir)
    const texts = await Promise.all(["word.ts", "excel.ts", "memory.ts"].map((file) => Bun.file(path.join(root, file)).text()))
    texts.forEach((text) => expect(text).not.toMatch(/formulas/))
  })
})
