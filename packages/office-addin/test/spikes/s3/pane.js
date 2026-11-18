// @ts-check
// Spike S3 pane (test strategy §8 SP-S3, plan M0-04). Throwaway probe code, not the
// product pane. Every probe logs one JSON line to the page (textContent only, SC-40)
// and to the console with the prefix "[S3]". Reads and writes use only WordApi 1.1 /
// ExcelApi 1.1 members, except where a probe says it checks a newer one.
// Writes follow the spec: Word insertText "After"/"Replace" (FR-04); Excel FR-13 matrix,
// FR-14 cell conversion (C15 number pattern, numberFormat "@" before values, never
// formulas), table 6.3 anchor and refusal rules, FR-18 select() (H-4).

const NUMBER = /^-?\d+(\.\d+)?$/ // C15 RM-01, exactly
const AC33 = "=SUM(A1:A2)\t+1+1\t@x\t-12.5\t42\t3e2\t+7\t.5\tTRUE\t-1"

/** @param {string} id */
const el = (id) => {
  const node = document.getElementById(id)
  if (!node) throw new Error(`missing #${id}`)
  return node
}

/** @param {string} probe @param {unknown} data */
const log = (probe, data) => {
  const line = JSON.stringify({ t: new Date().toISOString(), probe, data })
  console.log("[S3]", line)
  el("log").textContent += line + "\n"
}

/** @param {unknown} error */
const describe = (error) => {
  if (error instanceof OfficeExtension.Error)
    return { name: error.name, code: error.code, message: error.message, debugInfo: error.debugInfo }
  if (error instanceof Error) return { name: error.name, message: error.message }
  return { message: String(error) }
}

/**
 * Runs one probe, logs it, and resolves to the logged result (never rejects).
 * @param {string} probe @param {() => Promise<unknown>} run
 * @returns {Promise<Record<string, unknown>>}
 */
const runProbe = (probe, run) =>
  run()
    .then((data) => ({ ok: true, ...(typeof data === "object" && data !== null ? data : { value: data }) }))
    .catch((error) => ({ ok: false, error: describe(error) }))
    .then((result) => {
      log(probe, result)
      return result
    })

/** @param {string} probe @param {() => Promise<unknown>} run */
const probe = (probe, run) => () => runProbe(probe, run)

/** @param {string} id @param {() => void} handler */
const on = (id, handler) => el(id).addEventListener("click", handler)

// CSP violations (ST-19): the bridge will serve the pane with the RC-6 CSP; any violation is evidence.
document.addEventListener("securitypolicyviolation", (event) =>
  log("csp-violation", {
    blockedURI: event.blockedURI,
    violatedDirective: event.violatedDirective,
    sourceFile: event.sourceFile,
  }),
)

const API_SETS = {
  Word: { name: "WordApi", versions: ["1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7", "1.8", "1.9"] },
  Excel: { name: "ExcelApi", versions: ["1.1", "1.2", "1.3", "1.4", "1.5", "1.7", "1.9", "1.12", "1.17"] },
}

const environment = async () => {
  const context = Office.context
  const host = context.host ? String(context.host) : null
  const sets = host === "Word" || host === "Excel" ? API_SETS[host] : undefined
  const resources = performance.getEntriesByType("resource").map((entry) => entry.name)
  return {
    host,
    platform: context.platform ? String(context.platform) : null,
    diagnostics: context.diagnostics
      ? { host: context.diagnostics.host, platform: context.diagnostics.platform, version: context.diagnostics.version }
      : null,
    displayLanguage: context.displayLanguage,
    contentLanguage: context.contentLanguage,
    partitionKey: context.partitionKey ?? null,
    documentUrl: context.document ? context.document.url : null,
    framed: window.top !== window.self,
    ancestorOrigins: location.ancestorOrigins ? Array.from(location.ancestorOrigins) : null,
    referrer: document.referrer,
    location: location.href,
    userAgent: navigator.userAgent,
    requirementSets: sets
      ? Object.fromEntries(
          sets.versions.map((version) => [`${sets.name} ${version}`, context.requirements.isSetSupported(sets.name, version)]),
        )
      : null,
    scriptOrigins: [...new Set(Array.from(document.scripts).map((script) => (script.src ? new URL(script.src).origin : "inline")))],
    resourceOrigins: [...new Set(resources.map((name) => new URL(name).origin))],
    resources,
  }
}

// ---------- Word ----------

/** @param {Word.Font} font */
const fontOf = (font) => ({ name: font.name, size: font.size, bold: font.bold, italic: font.italic, color: font.color })

const wordSelection = () =>
  Word.run(async (context) => {
    const range = context.document.getSelection()
    range.load("text")
    await context.sync()
    return { text: range.text, length: range.text.length }
  })

const wordBody = () =>
  Word.run(async (context) => {
    const body = context.document.body
    body.load("text")
    body.paragraphs.load("items/text")
    await context.sync()
    return {
      paragraphCount: body.paragraphs.items.length,
      paragraphs: body.paragraphs.items.map((item) => item.text),
      text: body.text,
    }
  })

/** @param {"After" | "Replace"} location @param {string} [source] text; default = the text box */
const wordInsert = (location, source) =>
  Word.run(async (context) => {
    const text = (source ?? /** @type {HTMLTextAreaElement} */ (el("w-text")).value).replace(/\r\n/g, "\n").replace(/\n+$/, "")
    const selection = context.document.getSelection()
    const body = context.document.body
    selection.load("text")
    selection.font.load("name,size,bold,italic,color")
    body.paragraphs.load("items")
    await context.sync()
    const before = { selectionText: selection.text, paragraphCount: body.paragraphs.items.length, font: fontOf(selection.font) }
    const inserted = selection.insertText(text, location)
    inserted.load("text")
    inserted.font.load("name,size,bold,italic,color")
    inserted.paragraphs.load("items/text")
    body.paragraphs.load("items")
    await context.sync()
    return {
      location,
      sent: text,
      sentLines: text.split("\n").length,
      before,
      after: {
        paragraphCount: body.paragraphs.items.length,
        paragraphDelta: body.paragraphs.items.length - before.paragraphCount,
        insertedText: inserted.text,
        insertedParagraphs: inserted.paragraphs.items.map((item) => item.text),
        insertedFont: fontOf(inserted.font),
      },
      hint: "H-1: insertedParagraphs.length === sentLines means \\n became paragraphs. H-2: compare fonts. H-5: press Cmd-Z, then W2.",
    }
  })

// ---------- Excel ----------

const excelSelection = () =>
  Excel.run(async (context) => {
    const range = context.workbook.getSelectedRange()
    range.load("address,rowCount,columnCount,values,valueTypes,numberFormat,formulas")
    await context.sync()
    return {
      address: range.address,
      rows: range.rowCount,
      columns: range.columnCount,
      values: range.values,
      valueTypes: range.valueTypes,
      numberFormat: range.numberFormat,
      formulas: range.formulas,
      hint: "H-6: repeat with a Cmd-click multi-area selection; ok:false expected",
    }
  })

const excelUsed = () =>
  Excel.run(async (context) => {
    const sheet = context.workbook.worksheets.getActiveWorksheet()
    const range = sheet.getUsedRange()
    sheet.load("name")
    range.load("address,rowCount,columnCount,values,valueTypes,numberFormat")
    await context.sync()
    return {
      sheet: sheet.name,
      address: range.address,
      rows: range.rowCount,
      columns: range.columnCount,
      values: range.rowCount * range.columnCount <= 400 ? range.values : `(${range.rowCount * range.columnCount} cells, first row) ${JSON.stringify(range.values[0])}`,
      valueTypes: range.rowCount * range.columnCount <= 400 ? range.valueTypes : "(omitted)",
      numberFormat: range.rowCount * range.columnCount <= 400 ? range.numberFormat : "(omitted)",
    }
  })

const excelFormatProbe = () =>
  Excel.run(async (context) => {
    const range = context.workbook.getSelectedRange()
    range.load("address,numberFormat")
    await context.sync()
    return {
      "ExcelApi 1.1": Office.context.requirements.isSetSupported("ExcelApi", "1.1"),
      "ExcelApi 1.2": Office.context.requirements.isSetSupported("ExcelApi", "1.2"),
      address: range.address,
      numberFormat: range.numberFormat,
      selectIsFunction: typeof range.select === "function",
      getBoundingRectIsFunction: typeof range.getBoundingRect === "function",
    }
  })

/** FR-13: reply text to a matrix. @param {string} reply */
const toMatrix = (reply) => {
  const text = reply.replace(/\r\n/g, "\n").replace(/\n+$/, "")
  if (!text.includes("\t")) return [[text]]
  const rows = text.split("\n").map((row) => row.split("\t"))
  const width = Math.max(...rows.map((row) => row.length))
  return rows.map((row) => [...row, ...Array.from({ length: width - row.length }, () => "")])
}

/** @param {"insert" | "replace"} mode @param {string} [source] reply text; default = the text box */
const excelWrite = (mode, source) =>
  Excel.run(async (context) => {
    const matrix = toMatrix(source ?? /** @type {HTMLTextAreaElement} */ (el("x-text")).value)
    const m = matrix.length
    const n = matrix[0].length
    const selection = context.workbook.getSelectedRange()
    selection.load("address,rowCount,columnCount")
    await context.sync()
    const R = selection.rowCount
    const C = selection.columnCount
    const sameShape = m === R && n === C
    if (mode === "replace" && !sameShape && !(R === 1 && C === 1))
      return { mode, refused: "office.error.shapeMismatch", matrix: `${m}x${n}`, selection: `${R}x${C}` }
    // Table 6.3: insert anchors below the last row in the first column; replace at the top-left cell.
    const anchor = mode === "insert" ? selection.getLastRow().getOffsetRange(1, 0).getCell(0, 0) : selection.getCell(0, 0)
    const target = mode === "replace" && sameShape ? selection : anchor.getBoundingRect(anchor.getCell(m - 1, n - 1))
    target.load("address,values")
    await context.sync()
    // Insert: the whole target must be empty. Replace with a one-cell selection: all but the anchor.
    const mustCheck = mode === "insert" || !sameShape
    const blocked = mustCheck
      ? target.values.flatMap((row, i) => row.map((value, j) => ({ i, j, value }))).filter(
          (cell) => cell.value !== "" && !(mode === "replace" && cell.i === 0 && cell.j === 0),
        )
      : []
    if (blocked.length > 0)
      return { mode, refused: "office.error.targetNotEmpty", target: target.address, blocked: blocked.slice(0, 10) }
    // FR-14: numbers by the C15 pattern; every other cell gets numberFormat "@" first, then values.
    const plan = matrix.map((row) => row.map((cell) => (NUMBER.test(cell) ? { number: true, value: Number(cell) } : { number: false, value: cell })))
    plan.forEach((row, i) =>
      row.forEach((cell, j) => {
        if (!cell.number) target.getCell(i, j).numberFormat = [["@"]]
      }),
    )
    target.values = plan.map((row) => row.map((cell) => cell.value))
    await context.sync()
    const selected = await (async () => {
      target.select()
      await context.sync()
      return { ok: true }
    })().catch((error) => ({ ok: false, error: describe(error) }))
    target.load("address,values,valueTypes,numberFormat,formulas")
    await context.sync()
    return {
      mode,
      matrix: `${m}x${n}`,
      selection: `${selection.address} (${R}x${C})`,
      target: target.address,
      written: plan,
      readBack: { values: target.values, valueTypes: target.valueTypes, numberFormat: target.numberFormat, formulas: target.formulas },
      select: selected,
      hint: "AC-33: formulas must equal the text for text cells (no '=' evaluated). H-5: press Cmd-Z, then X1.",
    }
  })

// ---------- wiring ----------

on("env", probe("environment", environment))
on("clear-log", () => {
  el("log").textContent = ""
})
on("select-log", () => {
  const selection = window.getSelection()
  if (!selection) return
  selection.selectAllChildren(el("log"))
})
on("w-selection", probe("word.selection", wordSelection))
on("w-body", probe("word.body", wordBody))
on("w-after", probe("word.insertText.After", () => wordInsert("After")))
on("w-replace", probe("word.insertText.Replace", () => wordInsert("Replace")))
on("x-selection", probe("excel.selectedRange", excelSelection))
on("x-used", probe("excel.usedRange", excelUsed))
on("x-format", probe("excel.numberFormat", excelFormatProbe))
on("x-insert", probe("excel.write.insert", () => excelWrite("insert")))
on("x-replace", probe("excel.write.replace", () => excelWrite("replace")))
const replyBox = /** @type {HTMLTextAreaElement} */ (el("x-text"))
replyBox.value = AC33

// ---------- command channel (row 33b, C20) ----------
// The controller appends lines to <OUT>/s3-queue.txt; the server hands them out one per
// GET /s3/next. A line is a probe id plus an optional argument: "0", "W1", "W2",
// "W3 <text>", "W4 <text>", "X1", "X2", "X3", "X4 <cells>", "X5 <cells>". The argument uses
// the text-box format (tab = cell, newline = row); a queue line holds one line, so the
// escapes \t, \n and \\ are decoded. No argument = the current text-box value.
// Each result is POSTed as {"probe": id, "result": ...} to /pane/log (same origin, CSP
// connect-src 'self'), where the server writes it to access.log as a "pane-report".

/** @param {string} text */
const unescapeArg = (text) => text.replace(/\\([tn\\])/g, (_, c) => (c === "t" ? "\t" : c === "n" ? "\n" : "\\"))

/** @type {Record<string, { name: string, run: (arg: string | undefined) => Promise<unknown> }>} */
const COMMANDS = {
  0: { name: "environment", run: () => environment() },
  W1: { name: "word.selection", run: () => wordSelection() },
  W2: { name: "word.body", run: () => wordBody() },
  W3: { name: "word.insertText.After", run: (arg) => wordInsert("After", arg) },
  W4: { name: "word.insertText.Replace", run: (arg) => wordInsert("Replace", arg) },
  X1: { name: "excel.selectedRange", run: () => excelSelection() },
  X2: { name: "excel.usedRange", run: () => excelUsed() },
  X3: { name: "excel.numberFormat", run: () => excelFormatProbe() },
  X4: { name: "excel.write.insert", run: (arg) => excelWrite("insert", arg) },
  X5: { name: "excel.write.replace", run: (arg) => excelWrite("replace", arg) },
}

/** @param {unknown} report */
const post = (report) =>
  fetch("/pane/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report) })
    .then((response) => {
      if (!response.ok) log("channel.post", { ok: false, status: response.status })
    })
    .catch((error) => log("channel.post", { ok: false, error: describe(error) }))

/** @param {string} line */
const runCommand = async (line) => {
  const space = line.indexOf(" ")
  const id = (space === -1 ? line : line.slice(0, space)).toUpperCase()
  const arg = space === -1 ? undefined : unescapeArg(line.slice(space + 1))
  const command = COMMANDS[id]
  if (!command) return post({ probe: id, cmd: line, result: { ok: false, error: { message: `unknown command ${id}` } } })
  const result = await runProbe(command.name, () => command.run(arg))
  return post({ probe: id, cmd: line, result })
}

const POLL_MS = 1000
const poll = async () => {
  const cmd = await fetch("/s3/next", { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : { cmd: null }))
    .then((body) => (body && typeof body.cmd === "string" ? body.cmd : null))
    .catch(() => null)
  el("channel").textContent = cmd ? `channel: running ${cmd}` : "channel: polling"
  if (cmd) await runCommand(cmd)
  setTimeout(poll, POLL_MS)
}

Office.onReady().then(async (info) => {
  const host = info.host ? String(info.host) : "none"
  el("status").textContent = `ready: host=${host} platform=${info.platform ? String(info.platform) : "none"}`
  if (host === "Word") el("word").hidden = false
  if (host === "Excel") el("excel").hidden = false
  log("onReady", { host, platform: info.platform ? String(info.platform) : null })
  const result = await runProbe("environment", environment)
  await post({ probe: "0", cmd: "onload", result })
  return poll()
})
