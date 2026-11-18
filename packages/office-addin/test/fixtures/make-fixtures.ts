// Deterministic synthetic Office fixtures for spike S3 and the L4 E2E sessions
// (test strategy §9.3). Usage, from packages/office-addin:
//
//   bun test/fixtures/make-fixtures.ts <out-dir>
//
// Writes the 8 fixtures below into <out-dir>. Two runs give byte-identical files:
// the parts carry no timestamps or random ids (no docProps/core.xml), every staged
// part gets the same fixed mtime, and /usr/bin/zip runs with -X (no extra fields),
// -D (no directory entries), a fixed entry order and TZ=UTC (DOS time is local).
// Pseudo-random text comes from a seeded LCG. No dependency beyond Bun and zip.
import { mkdir, rm, utimes } from "node:fs/promises"
import path from "node:path"

const out = process.argv[2]
if (!out) {
  console.error("usage: bun test/fixtures/make-fixtures.ts <out-dir>")
  process.exit(2)
}

const FIXED_TIME = new Date("2026-01-01T00:00:00Z")
const NS_MAIN_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
const NS_SS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

const esc = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("\t", "&#9;")
    .replaceAll("\n", "&#10;")

// Seeded LCG (Numerical Recipes constants), so generated text never changes.
const lcg = (seed: number) => {
  const state = { value: seed >>> 0 }
  return () => {
    state.value = (Math.imul(state.value, 1664525) + 1013904223) >>> 0
    return state.value / 0x100000000
  }
}

const WORDS =
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat".split(
    " ",
  )

// Paragraphs of lorem-style ASCII until the joined text reaches `chars` characters.
const loremParagraphs = (seed: number, chars: number) => {
  const next = lcg(seed)
  const paragraphs: string[] = []
  const total = { value: 0 }
  while (total.value < chars) {
    const count = 60 + Math.floor(next() * 60)
    const words = Array.from({ length: count }, () => WORDS[Math.floor(next() * WORDS.length)])
    const text = `P${paragraphs.length + 1}. ${words.join(" ")}.`
    paragraphs.push(text)
    total.value += text.length + 1
  }
  return paragraphs
}

const rels = (items: { id: string; type: string; target: string }[]) =>
  XML_HEAD +
  `<Relationships xmlns="${NS_PKG_REL}">` +
  items.map((item) => `<Relationship Id="${item.id}" Type="${item.type}" Target="${item.target}"/>`).join("") +
  "</Relationships>"

// ---------- Word ----------

const wordRun = (text: string) => `<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`
const wordPara = (text: string) => `<w:p>${wordRun(text)}</w:p>`

const docx = (input: { paragraphs: string[]; header?: string; footer?: string; footnote?: string }) => {
  const extras = [
    input.header
      ? { id: "rId1", kind: "header", part: "header1.xml", type: "header", ct: "header+xml" }
      : undefined,
    input.footer
      ? { id: "rId2", kind: "footer", part: "footer1.xml", type: "footer", ct: "footer+xml" }
      : undefined,
    input.footnote
      ? { id: "rId3", kind: "footnotes", part: "footnotes.xml", type: "footnotes", ct: "footnotes+xml" }
      : undefined,
  ].filter((item) => item !== undefined)
  // The footnote reference sits at the end of the third paragraph (or the last one).
  const noteAt = Math.min(2, input.paragraphs.length - 1)
  const body = input.paragraphs
    .map((text, index) =>
      input.footnote && index === noteAt
        ? `<w:p>${wordRun(text)}<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="1"/></w:r></w:p>`
        : wordPara(text),
    )
    .join("")
  const sect =
    "<w:sectPr>" +
    (input.header ? '<w:headerReference w:type="default" r:id="rId1"/>' : "") +
    (input.footer ? '<w:footerReference w:type="default" r:id="rId2"/>' : "") +
    '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>' +
    "</w:sectPr>"
  return [
    {
      name: "[Content_Types].xml",
      data:
        XML_HEAD +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        extras
          .map(
            (item) =>
              `<Override PartName="/word/${item.part}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${item.ct}"/>`,
          )
          .join("") +
        "</Types>",
    },
    {
      name: "_rels/.rels",
      data: rels([{ id: "rId1", type: `${NS_REL}/officeDocument`, target: "word/document.xml" }]),
    },
    {
      name: "word/document.xml",
      data:
        XML_HEAD +
        `<w:document xmlns:w="${NS_MAIN_W}" xmlns:r="${NS_REL}"><w:body>${body}${sect}</w:body></w:document>`,
    },
    {
      name: "word/_rels/document.xml.rels",
      data: rels(extras.map((item) => ({ id: item.id, type: `${NS_REL}/${item.type}`, target: item.part }))),
    },
    ...(input.header
      ? [{ name: "word/header1.xml", data: XML_HEAD + `<w:hdr xmlns:w="${NS_MAIN_W}" xmlns:r="${NS_REL}">${wordPara(input.header)}</w:hdr>` }]
      : []),
    ...(input.footer
      ? [{ name: "word/footer1.xml", data: XML_HEAD + `<w:ftr xmlns:w="${NS_MAIN_W}" xmlns:r="${NS_REL}">${wordPara(input.footer)}</w:ftr>` }]
      : []),
    ...(input.footnote
      ? [
          {
            name: "word/footnotes.xml",
            data:
              XML_HEAD +
              `<w:footnotes xmlns:w="${NS_MAIN_W}" xmlns:r="${NS_REL}">` +
              '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
              '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>' +
              `<w:footnote w:id="1"><w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteRef/></w:r>${wordRun(" " + input.footnote)}</w:p></w:footnote>` +
              "</w:footnotes>",
          },
        ]
      : []),
  ]
}

// ---------- Excel ----------

type Cell =
  | { kind: "n"; value: number; style?: number }
  | { kind: "s"; value: string }
  | { kind: "b"; value: boolean }
  | { kind: "e"; value: string; formula: string }

type Sheet = {
  name: string
  cells: Record<string, Cell>
  selection?: string
  protect?: boolean
}

const colName = (index: number): string =>
  index < 26 ? String.fromCharCode(65 + index) : colName(Math.floor(index / 26) - 1) + colName(index % 26)

const parseRef = (ref: string) => {
  const match = /^([A-Z]+)(\d+)$/.exec(ref)
  if (!match) throw new Error(`bad cell ref ${ref}`)
  return {
    col: [...match[1]].reduce((acc, ch) => acc * 26 + ch.charCodeAt(0) - 64, 0) - 1,
    row: Number(match[2]),
  }
}

const cellXml = (ref: string, cell: Cell) => {
  if (cell.kind === "n") return `<c r="${ref}"${cell.style ? ` s="${cell.style}"` : ""}><v>${cell.value}</v></c>`
  if (cell.kind === "b") return `<c r="${ref}" t="b"><v>${cell.value ? 1 : 0}</v></c>`
  if (cell.kind === "e") return `<c r="${ref}" t="e"><f>${esc(cell.formula)}</f><v>${esc(cell.value)}</v></c>`
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(cell.value)}</t></is></c>`
}

const sheetXml = (sheet: Sheet, active: boolean) => {
  const refs = Object.keys(sheet.cells)
    .map((ref) => ({ ref, ...parseRef(ref) }))
    .toSorted((a, b) => a.row - b.row || a.col - b.col)
  const rows = [...new Set(refs.map((item) => item.row))]
  const minCol = Math.min(...refs.map((item) => item.col))
  const maxCol = Math.max(...refs.map((item) => item.col))
  const dimension = refs.length
    ? `${colName(minCol)}${rows[0]}:${colName(maxCol)}${rows[rows.length - 1]}`
    : "A1"
  const selection = sheet.selection ?? "A1"
  const data = rows
    .map(
      (row) =>
        `<row r="${row}">` +
        refs
          .filter((item) => item.row === row)
          .map((item) => cellXml(item.ref, sheet.cells[item.ref]))
          .join("") +
        "</row>",
    )
    .join("")
  return (
    XML_HEAD +
    `<worksheet xmlns="${NS_SS}" xmlns:r="${NS_REL}">` +
    `<dimension ref="${dimension}"/>` +
    `<sheetViews><sheetView${active ? ' tabSelected="1"' : ""} workbookViewId="0">` +
    `<selection activeCell="${selection.split(":")[0]}" sqref="${selection}"/></sheetView></sheetViews>` +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    `<sheetData>${data}</sheetData>` +
    (sheet.protect ? '<sheetProtection sheet="1" objects="1" scenarios="1"/>' : "") +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
    "</worksheet>"
  )
}

// Style 0 General, 1 date (numFmtId 14), 2 text "@" (numFmtId 49).
const STYLES =
  XML_HEAD +
  `<styleSheet xmlns="${NS_SS}">` +
  '<fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>"

const xlsx = (sheets: Sheet[]) => [
  {
    name: "[Content_Types].xml",
    data:
      XML_HEAD +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets
        .map(
          (_, index) =>
            `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join("") +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      "</Types>",
  },
  {
    name: "_rels/.rels",
    data: rels([{ id: "rId1", type: `${NS_REL}/officeDocument`, target: "xl/workbook.xml" }]),
  },
  {
    name: "xl/workbook.xml",
    data:
      XML_HEAD +
      `<workbook xmlns="${NS_SS}" xmlns:r="${NS_REL}">` +
      '<bookViews><workbookView activeTab="0"/></bookViews><sheets>' +
      sheets.map((sheet, index) => `<sheet name="${esc(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("") +
      "</sheets></workbook>",
  },
  {
    name: "xl/_rels/workbook.xml.rels",
    data: rels([
      ...sheets.map((_, index) => ({
        id: `rId${index + 1}`,
        type: `${NS_REL}/worksheet`,
        target: `worksheets/sheet${index + 1}.xml`,
      })),
      { id: `rId${sheets.length + 1}`, type: `${NS_REL}/styles`, target: "styles.xml" },
    ]),
  },
  ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, data: sheetXml(sheet, index === 0) })),
  { name: "xl/styles.xml", data: STYLES },
]

const str = (value: string): Cell => ({ kind: "s", value })
const num = (value: number): Cell => ({ kind: "n", value })

const largeCells = () => {
  const next = lcg(1003)
  return Object.fromEntries(
    Array.from({ length: 10_000 }, (_, r) =>
      Array.from({ length: 10 }, (_, c) => [
        `${colName(c)}${r + 1}`,
        c % 2 === 0 ? num(Math.floor(next() * 100_000) / 100) : str(`r${r + 1}c${c + 1}`),
      ] as const),
    ).flat(),
  )
}

const FIXTURES = [
  {
    file: "fx-word-basic.docx",
    parts: docx({
      paragraphs: ["Alpha line one.", "Bravo line two.", "Charlie line three.", "Delta line four.", "Echo line five."],
      header: "HEADER-SENTINEL-7Q",
      footer: "FOOTER-SENTINEL-7Q",
      footnote: "FOOTNOTE-SENTINEL-7Q",
    }),
  },
  { file: "fx-word-large.docx", parts: docx({ paragraphs: loremParagraphs(1001, 310_000) }) },
  // 2 MiB = 2,097,152 bytes; 2,300,000 ASCII characters keep the JSON-encoded prompt above it.
  { file: "fx-word-huge.docx", parts: docx({ paragraphs: loremParagraphs(1002, 2_300_000) }) },
  {
    file: "fx-excel-types.xlsx",
    parts: xlsx([
      {
        name: "Sheet1",
        selection: "A2",
        cells: {
          A1: str("number"),
          B1: str("boolean"),
          C1: str("empty"),
          D1: str("error"),
          E1: str("tab-and-break"),
          F1: str("date"),
          A2: num(42.5),
          B2: { kind: "b", value: true },
          D2: { kind: "e", value: "#DIV/0!", formula: "1/0" },
          E2: str("left\tright\nsecond line"),
          F2: { kind: "n", value: 45000, style: 1 },
        },
      },
    ]),
  },
  {
    file: "fx-excel-two-sheets.xlsx",
    parts: xlsx([
      {
        name: "Sheet1",
        selection: "B2:D4",
        cells: {
          B2: str("b2"),
          C2: str("c2"),
          D2: str("d2"),
          B3: num(1),
          C3: num(2),
          D3: num(3),
          B4: str("b4"),
          C4: num(-4.25),
          D4: str("d4"),
        },
      },
      { name: "Sheet2", cells: { A1: str("SHEET2-SENTINEL-7Q") } },
    ]),
  },
  { file: "fx-excel-large.xlsx", parts: xlsx([{ name: "Sheet1", cells: largeCells() }]) },
  {
    file: "fx-excel-targets.xlsx",
    parts: xlsx([
      {
        name: "insert",
        selection: "A1:B2",
        cells: { A1: str("sel-a1"), B1: str("sel-b1"), A2: str("sel-a2"), B2: str("sel-b2"), A3: str("A3-NONEMPTY") },
      },
      {
        name: "replace",
        selection: "A1:B2",
        cells: {
          A1: str("blk-a1"),
          B1: str("blk-b1"),
          A2: str("blk-a2"),
          B2: str("blk-b2"),
          D1: str("single-d1"),
          F1: str("col-f1"),
          F2: str("col-f2"),
          F3: str("col-f3"),
        },
      },
    ]),
  },
  {
    file: "fx-excel-protected.xlsx",
    parts: xlsx([
      { name: "Sheet1", protect: true, cells: { A1: str("PROTECTED-SENTINEL-7Q"), A2: num(7) } },
    ]),
  },
]

const outDir = path.resolve(out)
await mkdir(outDir, { recursive: true })

for (const fixture of FIXTURES) {
  const stage = path.join(outDir, `.stage-${fixture.file}`)
  const target = path.join(outDir, fixture.file)
  await rm(stage, { recursive: true, force: true })
  // zip updates an existing archive in place, so always start from nothing.
  await rm(target, { force: true })
  for (const part of fixture.parts) await Bun.write(path.join(stage, part.name), part.data)
  // Fixed mtime on every staged file and directory: zip stores the file mtime as DOS time.
  const dirs = [...new Set(fixture.parts.map((part) => path.dirname(part.name)))]
  for (const item of [...fixture.parts.map((part) => part.name), ...dirs]) {
    await utimes(path.join(stage, item), FIXED_TIME, FIXED_TIME)
  }
  const proc = Bun.spawnSync(
    ["/usr/bin/zip", "-X", "-D", "-q", target, ...fixture.parts.map((part) => part.name)],
    { cwd: stage, env: { ...process.env, TZ: "UTC" }, stdout: "pipe", stderr: "pipe" },
  )
  if (proc.exitCode !== 0) {
    console.error(`zip failed for ${fixture.file}: ${proc.stderr.toString()}`)
    process.exit(1)
  }
  await rm(stage, { recursive: true, force: true })
  console.log(`${fixture.file}\t${Bun.file(target).size} bytes\t${fixture.parts.length} parts`)
}
