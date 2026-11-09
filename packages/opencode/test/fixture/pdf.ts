// Row 203: small hand-written PDFs for the PDF text tests, built from strings so no PDF library is needed.
// simplePdf is a valid PDF with a correct cross-reference table; cidPdf drops two placeholder objects after the
// table is written (their real definitions are in the object stream), which the extractor does not depend on.
import { deflateSync } from "node:zlib"

type Obj = { body: string; stream?: Buffer }

function assemble(objects: Obj[], trailerExtra = "") {
  const chunks: Buffer[] = [Buffer.from("%PDF-1.5\n%\xe2\xe3\xcf\xd3\n", "latin1")]
  const offsets: number[] = []
  let size = chunks[0].length
  objects.forEach((obj, i) => {
    offsets.push(size)
    const parts: Buffer[] = [Buffer.from(`${i + 1} 0 obj\n${obj.body}\n`, "latin1")]
    if (obj.stream) parts.push(Buffer.from("stream\n", "latin1"), obj.stream, Buffer.from("\nendstream\n", "latin1"))
    parts.push(Buffer.from("endobj\n", "latin1"))
    for (const p of parts) {
      chunks.push(p)
      size += p.length
    }
  })
  const xref = [
    "xref",
    `0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n `),
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>`,
    "startxref",
    String(size),
    "%%EOF\n",
  ].join("\n")
  chunks.push(Buffer.from(xref, "latin1"))
  return Buffer.concat(chunks)
}

const stream = (dict: string, data: Buffer, compress: boolean): Obj => {
  const bytes = compress ? deflateSync(data) : data
  return { body: `<< ${dict}${compress ? " /Filter /FlateDecode" : ""} /Length ${bytes.length} >>`, stream: bytes }
}

const escape = (s: string) => s.replace(/[\\()]/g, (c) => "\\" + c)

/** Pages of Helvetica text (one Tj per line), optionally with Flate-compressed content streams. */
export function simplePdf(pages: string[][], options: { compress?: boolean; encrypted?: boolean } = {}) {
  // 1 catalog, 2 pages, 3 font, then per page: page object + content stream.
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")
  const objects: Obj[] = [
    { body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { body: `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} /Resources << /Font << /F1 3 0 R >> >> >>` },
    { body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>" },
  ]
  for (const [i, lines] of pages.entries()) {
    const ops = [
      "BT",
      "/F1 12 Tf",
      "72 720 Td",
      "14 TL",
      ...lines.map((l, k) => (k === 0 ? `(${escape(l)}) Tj` : `T* (${escape(l)}) Tj`)),
      "ET",
    ]
    objects.push({ body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R >>` })
    objects.push(stream("", Buffer.from(ops.join("\n"), "latin1"), options.compress ?? false))
  }
  return assemble(objects, options.encrypted ? "/Encrypt << /Filter /Standard /V 1 /R 2 >> " : "")
}

/**
 * One page set the way Chromium (Skia) writes text: a Type0 / Identity-H font whose 2-byte glyph ids mean nothing
 * without the ToUnicode CMap, Tm per line, TJ with kerning, compressed streams, and the page objects inside a
 * compressed object stream (PDF 1.5).
 */
export function cidPdf(lines: string[]) {
  // Glyph ids: each distinct character gets id 3, 4, 5, ... (as a subset font would).
  const chars = [...new Set(lines.join(""))]
  const gid = new Map(chars.map((c, i) => [c, i + 3]))
  const hex = (n: number, w = 4) => n.toString(16).toUpperCase().padStart(w, "0")
  const cmap = [
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "1 begincodespacerange <0000> <FFFF> endcodespacerange",
    `${chars.length} beginbfchar`,
    ...chars.map((c) => `<${hex(gid.get(c)!)}> <${hex(c.charCodeAt(0))}>`),
    "endbfchar endcmap CMapName currentdict /CMap defineresource pop end end",
  ].join("\n")
  const content = lines
    .map((line, i) => {
      const words = line.split(" ").map((w) => `<${[...w].map((c) => hex(gid.get(c)!)).join("")}>`)
      // Word gaps as kerning (no space glyph), as Skia does for justified text.
      return `BT /F1 11 Tf 1 0 0 1 72 ${700 - i * 16} Tm [${words.join(" -300 ")}] TJ ET`
    })
    .join("\n")
  // Objects: 1 catalog, 2 pages, 3 page (in objstm), 4 font, 5 cidfont, 6 tounicode, 7 content, 8 objstm.
  const inStream = [
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [
      3,
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>",
    ],
  ] as const
  let header = ""
  let bodies = ""
  for (const [num, body] of inStream) {
    header += `${num} ${bodies.length} `
    bodies += body + "\n"
  }
  const objstm = Buffer.from(header + bodies, "latin1")
  const objects: Obj[] = [
    { body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { body: "null" },
    { body: "null" },
    {
      body: "<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Inter /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 6 0 R >>",
    },
    {
      body: "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+Inter /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>",
    },
    stream("", Buffer.from(cmap, "latin1"), true),
    stream("", Buffer.from(content, "latin1"), true),
    stream(`/Type /ObjStm /N ${inStream.length} /First ${header.length}`, objstm, true),
  ]
  // Objects 2 and 3 live in the object stream; the placeholders above keep the numbering and are not "obj" bodies
  // anyone reads: drop them so the object stream is their only definition.
  const pdf = assemble(objects)
    .toString("latin1")
    .replace(/\n2 0 obj\nnull\nendobj\n/, "\n")
    .replace(/\n3 0 obj\nnull\nendobj\n/, "\n")
  return Buffer.from(pdf, "latin1")
}
