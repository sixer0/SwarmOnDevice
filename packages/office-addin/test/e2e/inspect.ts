// Oracle for spike S3 and the L4 E2E sessions (test strategy §9.3). Office-independent
// evidence of what a saved .docx/.xlsx contains. Usage, from packages/office-addin:
//
//   bun test/e2e/inspect.ts <file.docx|file.xlsx> [--limit N] [--sheet NAME] [--json]
//
// Word: body paragraphs of word/document.xml (soft breaks <w:br/> shown as "\n" inside a
// paragraph, tabs as "\t"), SHA-256 of the body text (paragraphs joined with "\n"), and
// the text of headers, footers and footnotes.
// Excel: per cell of the active sheet (or --sheet): type (t=), value, formula (<f>),
// style index and number format (numFmtId / formatCode from styles.xml); plus the
// sheet list, selection, dimension and protection.
// Both: the count of "swo1_" across all parts.
// Parts are read with `unzip -p`, so files saved by Office (data descriptors) work.
// The XML is matched with regular expressions tuned to what Word and Excel write
// (prefixed w: for Word, unprefixed SpreadsheetML for Excel); it is not a general parser.

const args = process.argv.slice(2)
const file = args.find((arg, index) => !arg.startsWith("--") && !["--limit", "--sheet"].includes(args[index - 1] ?? ""))
if (!file) {
  console.error("usage: bun test/e2e/inspect.ts <file.docx|file.xlsx> [--limit N] [--sheet NAME] [--json]")
  process.exit(2)
}
const flag = (name: string) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const limit = Number(flag("--limit") ?? 200)
const sheetArg = flag("--sheet")
const asJson = args.includes("--json")

const unzip = (cmd: string[]) => {
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" })
  if (proc.exitCode !== 0) return undefined
  return proc.stdout.toString()
}

const partNames = unzip(["/usr/bin/unzip", "-Z1", file])?.split("\n").filter(Boolean)
if (!partNames) {
  console.error(`cannot read zip: ${file}`)
  process.exit(1)
}
const read = (name: string) => (partNames.includes(name) ? (unzip(["/usr/bin/unzip", "-p", file, name]) ?? "") : "")

const decode = (text: string) =>
  text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")

const attr = (tag: string, name: string) => {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)
  return match ? decode(match[1]) : undefined
}

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")

const swo1 = partNames.reduce((sum, name) => sum + (read(name).match(/swo1_/g)?.length ?? 0), 0)

// ---------- Word ----------

const wordParagraphs = (xml: string) =>
  [...xml.matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)].map((match) =>
    [
      ...(match[1] ?? "")
        .replace(/<w:pPr\b[\s\S]*?<\/w:pPr>/g, "")
        .matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:(?:br|cr)\b[^>]*\/>/g),
    ]
      .map((token) => {
        if (token[1] !== undefined) return decode(token[1])
        if (token[0].startsWith("<w:tab")) return "\t"
        return "\n"
      })
      .join(""),
  )

const inspectWord = () => {
  const body = wordParagraphs(read("word/document.xml"))
  const bodyText = body.join("\n")
  const others = partNames
    .filter((name) => /^word\/(header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(name))
    .map((name) => ({ part: name, text: wordParagraphs(read(name)).filter(Boolean).join(" | ") }))
  if (asJson) {
    console.log(
      JSON.stringify({ file, kind: "docx", paragraphs: body, bodySha256: sha256(bodyText), parts: others, swo1 }, null, 2),
    )
    return
  }
  console.log(`file: ${file}`)
  console.log("kind: docx")
  console.log(`parts: ${partNames.length}`)
  console.log(`paragraphs: ${body.length}`)
  console.log(`body.chars: ${bodyText.length}`)
  body.slice(0, limit).forEach((text, index) => console.log(`p[${index}] ${JSON.stringify(text)}`))
  if (body.length > limit) console.log(`... ${body.length - limit} more paragraphs (raise --limit)`)
  console.log(`body.sha256: ${sha256(bodyText)}`)
  others.forEach((item) => console.log(`${item.part}: ${JSON.stringify(item.text)}`))
  console.log(`swo1_count: ${swo1}`)
}

// ---------- Excel ----------

const BUILTIN_FORMATS: Record<string, string> = {
  "0": "General",
  "1": "0",
  "2": "0.00",
  "3": "#,##0",
  "4": "#,##0.00",
  "9": "0%",
  "10": "0.00%",
  "11": "0.00E+00",
  "12": "# ?/?",
  "13": "# ??/??",
  "14": "mm-dd-yy",
  "15": "d-mmm-yy",
  "16": "d-mmm",
  "17": "mmm-yy",
  "18": "h:mm AM/PM",
  "19": "h:mm:ss AM/PM",
  "20": "h:mm",
  "21": "h:mm:ss",
  "22": "m/d/yy h:mm",
  "37": "#,##0 ;(#,##0)",
  "38": "#,##0 ;[Red](#,##0)",
  "39": "#,##0.00;(#,##0.00)",
  "40": "#,##0.00;[Red](#,##0.00)",
  "45": "mm:ss",
  "46": "[h]:mm:ss",
  "47": "mmss.0",
  "48": "##0.0E+0",
  "49": "@",
}

// Text of an <is> or <si> element: all <t> runs, phonetic runs dropped, _xHHHH_ escapes decoded.
const runText = (xml: string) =>
  [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\/>/g)]
    .map((match) => decode(match[1] ?? ""))
    .join("")
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))

const inspectExcel = () => {
  const workbook = read("xl/workbook.xml")
  const relsXml = read("xl/_rels/workbook.xml.rels")
  const relations = [...relsXml.matchAll(/<Relationship\b[^>]*\/?>/g)].map((match) => ({
    id: attr(match[0], "Id") ?? "",
    type: attr(match[0], "Type") ?? "",
    target: attr(match[0], "Target") ?? "",
  }))
  const resolve = (target: string) => (target.startsWith("/") ? target.slice(1) : `xl/${target}`)
  const relPath = (suffix: string) => {
    const rel = relations.find((item) => item.type.endsWith(suffix))
    return rel ? resolve(rel.target) : ""
  }
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*\/?>/g)].map((match) => {
    const rel = relations.find((item) => item.id === attr(match[0], "r:id"))
    return { name: attr(match[0], "name") ?? "", part: rel ? resolve(rel.target) : "", state: attr(match[0], "state") }
  })
  const activeTab = Number(/<workbookView\b[^>]*\sactiveTab="(\d+)"/.exec(workbook)?.[1] ?? 0)
  const sheet = sheetArg ? sheets.find((item) => item.name === sheetArg) : sheets[activeTab]
  if (!sheet) {
    console.error(`sheet not found: ${sheetArg ?? `activeTab ${activeTab}`}`)
    process.exit(1)
  }
  const shared = [...read(relPath("/sharedStrings")).matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((match) =>
    runText(match[1] ?? ""),
  )
  const styles = read(relPath("/styles"))
  const customFormats = Object.fromEntries(
    [...styles.matchAll(/<numFmt\b[^>]*\/?>/g)].map((match) => [attr(match[0], "numFmtId"), attr(match[0], "formatCode")]),
  )
  const xfs = [...(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? "").matchAll(/<xf\b[^>]*\/?>/g)].map(
    (match) => attr(match[0], "numFmtId") ?? "0",
  )
  const xml = read(sheet.part)
  const cells = [...xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((match) => {
    const tag = `<c${match[1]}>`
    const inner = match[2] ?? ""
    const type = attr(tag, "t") ?? "n"
    const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]
    const formulaMatch = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(inner)
    const style = Number(attr(tag, "s") ?? 0)
    const numFmtId = xfs[style] ?? "0"
    const value = (() => {
      if (type === "s") return shared[Number(raw)] ?? ""
      if (type === "inlineStr") return runText(/<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? "")
      if (type === "b") return raw === "1" ? "TRUE" : raw === undefined ? "" : "FALSE"
      return raw === undefined ? "" : decode(raw)
    })()
    return {
      ref: attr(tag, "r") ?? "?",
      type,
      value,
      formula: formulaMatch ? decode(formulaMatch[2] ?? `(shared ${attr(`<f${formulaMatch[1]}>`, "si") ?? ""})`) : undefined,
      style,
      numFmtId,
      numFmt: customFormats[numFmtId] ?? BUILTIN_FORMATS[numFmtId] ?? `builtin ${numFmtId}`,
    }
  })
  const selectionTag = /<selection\b[^>]*\/?>/.exec(xml)?.[0] ?? ""
  const summary = {
    file,
    kind: "xlsx",
    sheets: sheets.map((item) => item.name),
    activeTab,
    sheet: sheet.name,
    dimension: attr(/<dimension\b[^>]*\/?>/.exec(xml)?.[0] ?? "", "ref") ?? "",
    selection: { activeCell: attr(selectionTag, "activeCell") ?? "", sqref: attr(selectionTag, "sqref") ?? "" },
    protected: /<sheetProtection\b[^>]*\ssheet="(1|true)"/.test(xml),
    cellCount: cells.length,
    swo1,
  }
  if (asJson) {
    console.log(JSON.stringify({ ...summary, cells: cells.slice(0, limit) }, null, 2))
    return
  }
  console.log(`file: ${file}`)
  console.log("kind: xlsx")
  console.log(`parts: ${partNames.length}`)
  console.log(`sheets: ${summary.sheets.map((name) => JSON.stringify(name)).join(", ")} (activeTab ${activeTab})`)
  console.log(`sheet: ${JSON.stringify(sheet.name)} dimension=${summary.dimension} protected=${summary.protected}`)
  console.log(`selection: activeCell=${summary.selection.activeCell} sqref=${summary.selection.sqref}`)
  console.log(`cells: ${cells.length}`)
  cells
    .slice(0, limit)
    .forEach((cell) =>
      console.log(
        `${cell.ref}\tt=${cell.type}\tvalue=${JSON.stringify(cell.value)}\tformula=${cell.formula === undefined ? "-" : JSON.stringify(cell.formula)}\ts=${cell.style}\tnumFmtId=${cell.numFmtId}\tnumFmt=${JSON.stringify(cell.numFmt)}`,
      ),
    )
  if (cells.length > limit) console.log(`... ${cells.length - limit} more cells (raise --limit)`)
  console.log(`swo1_count: ${swo1}`)
}

if (partNames.includes("word/document.xml")) inspectWord()
if (partNames.includes("xl/workbook.xml")) inspectExcel()
if (!partNames.includes("word/document.xml") && !partNames.includes("xl/workbook.xml")) {
  console.error(`not a .docx or .xlsx package: ${file}`)
  process.exit(1)
}
