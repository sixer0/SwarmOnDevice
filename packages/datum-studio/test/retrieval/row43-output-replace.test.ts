// Row 43 finding F1, fixed by row 43a (decision C92; decision U6; store spec masterplan/01_specs_studio_store.md:357
// "a revision folder only gains files, and the sha8 in the name plus output_file.sha256 make each file
// content-identified"; src/store/files.ts:10 "A final path is never overwritten with different bytes").
//
// A stored output of a revision must stay retrievable after that revision is rendered again. This test renders a
// revision with a chart as DOCX, then renders the same revision again after the chart raster changed (the bridge's
// PageEngine returns other PNG bytes, as a different Chromium after an app update would), and asks for the FIRST
// output by its id and sha. Before row 43a this FAILED: vendor services/storage/files.ts writeOutput renamed the new
// bytes onto the same title-based rel_path and UPDATEd the row in place (log STORAGE_OUTPUT_REPLACED).
// Required since row 43a: other bytes = a NEW file `<stem>_<sha8>.docx` and a NEW output_file row, the old file and
// row unchanged and still verifying; identical bytes = the existing row reused (no new row, no new file); the newest
// output of a revision is the row with the latest time_created (then rowid).
//
// One process under bun; real store, host, MCP client, render bridge; fake PageEngine only. Needs the command
// sandbox off (127.0.0.1 port + Unix socket). No network, no model.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync } from "node:fs"
import path from "node:path"
import { startRenderBridge } from "../../../desktop/src/main/datum-render/index.ts"
import { renderWebPreferences } from "../../../desktop/src/main/datum-render/pages.ts"
import { resetBridgePdfReadiness } from "../../vendor/src/lib/studio/services/render"
import { realPdf, realPng, sha256File, sheetsOf, startHost, type Host } from "./scenario.ts"

type S = Record<string, any>
const PKG = path.resolve(import.meta.dir, "..", "..")
const DESKTOP = path.resolve(PKG, "..", "desktop")
const BASE = path.join(process.env.ROW43_BASE ?? "/private/tmp/claude-501/row43", "replace")
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "r-")))
const STORE = path.join(WORK, "datum-studio")
const CHART = {
  type: "chart",
  code: "P-02",
  data: { shape: "categorical", points: [{ label: "Jan", value: 12 }, { label: "Feb", value: 15 }, { label: "Mar", value: 9 }] },
  unit: "titik",
  caption: { text: "Titik uji per bulan" },
  source: { text: "Buku log stasiun" },
}

let fill = 0xff
let pngJobs = 0
let bridge: Awaited<ReturnType<typeof startRenderBridge>>
let h: Host
const realFetch = globalThis.fetch

beforeAll(async () => {
  globalThis.fetch = (async () => {
    throw new Error("row43 replace test: globalThis.fetch must not be called")
  }) as unknown as typeof fetch
  bridge = await startRenderBridge({
    fontsDir: path.join(DESKTOP, "datum", "datum-house-style", "assets", "fonts"),
    log: () => {},
    baseDir: WORK,
    engine: {
      async png(job: { width: number; height: number }) {
        pngJobs++
        return realPng(Math.max(1, Math.round(job.width)), Math.max(1, Math.round(job.height)), fill)
      },
      async pdf(job: { html: string; widthMm: number; heightMm: number }) {
        return realPdf(Math.max(1, sheetsOf(job.html)), job.widthMm, job.heightMm)
      },
      async evaluate() {
        throw new Error("layout measurement is not part of this fake")
      },
      info: () => {
        const raster = renderWebPreferences("raster") as S
        return { electron: "fake-row43", chrome: "fake-row43", partition: "datum-render", sandbox: raster.sandbox, contextIsolation: raster.contextIsolation, nodeIntegration: raster.nodeIntegration, javascriptContent: raster.javascript, network: "blocked" }
      },
    } as never,
  })
  h = await startHost({ phase: "R", pkg: PKG, storeRoot: STORE, work: WORK } as never, (l) => console.log(`[row43 replace] ${l}`))
  process.env.DATUM_RENDER_SOCKET = bridge.env.DATUM_RENDER_SOCKET
  process.env.DATUM_RENDER_TOKEN = bridge.env.DATUM_RENDER_TOKEN
  resetBridgePdfReadiness()
}, 120_000)

afterAll(async () => {
  await h?.stop()
  await bridge?.close()
  delete process.env.DATUM_RENDER_SOCKET
  delete process.env.DATUM_RENDER_TOKEN
  globalThis.fetch = realFetch
})

test("row 43a (F1 fixed): re-rendering a revision with other raster bytes adds a new output; the first stays retrievable; identical bytes reuse their row", async () => {
  const created = await h.call("studio_document_create", { template: "datum-nota", mission: "2026-11-07_row43", docKey: "nota-grafik", title: "Nota grafik row 43" })
  expect(created.ok).toBe(true)
  const id = String(created.documentId)
  const rev = () => Number(h.sql<{ n: number }>("SELECT current_revision_no AS n FROM document WHERE id = ?", [id])[0].n)
  const imp = await h.call("studio_chapter_import_markdown", { documentId: id, chapterKey: "1", markdown: "# Uji\n\nPengukuran titik uji dicatat tiap bulan.\n", submit: true, baseRevisionNo: rev() })
  expect(imp.ok).toBe(true)
  const snap = JSON.parse(h.sql<{ snapshot: string }>("SELECT snapshot FROM revision WHERE document_id = ? AND revision_no = ?", [id, rev()])[0].snapshot) as { blocks: S[] }
  const para = snap.blocks.find((b) => b.type === "paragraph" && typeof b.pid === "string")!
  const ins = await h.local("PATCH", `/api/studio/documents/${id}/paragraphs/${para.pid}`, { op: "insertAfter", baseRevisionNo: rev(), block: CHART, change: { what: "Grafik", why: "uji row 43", impact: "revisi baru" } })
  expect(ins.status).toBe(200)
  const n = rev()

  type Row = { id: string; rel_path: string; file_name: string; sha256: string; render_job_id: string; time_created: number }
  const rowOf = (fileId: unknown) => h.sql<Row>("SELECT id, rel_path, file_name, sha256, render_job_id, time_created FROM output_file WHERE id = ?", [fileId])[0]
  const docRows = () => Number(h.sql<{ n: number }>("SELECT count(*) AS n FROM output_file WHERE document_id = ?", [id])[0].n)
  const render = async () => {
    const r = await h.call("studio_render", { documentId: id, revisionNo: n, formats: ["docx"] })
    expect(r.ok).toBe(true)
    return ((r.outputs ?? []) as S[])[0]
  }

  const out1 = await render()
  const row1 = rowOf(out1.id)
  const revDir = path.dirname(path.join(STORE, row1.rel_path))
  copyFileSync(path.join(STORE, row1.rel_path), path.join(WORK, "first.docx"))
  const pngAfterFirst = pngJobs
  const rowsAfterFirst = docRows()

  fill = 0x80 // the chart raster changes (e.g. another Chromium after an app update)
  const out2 = await render()
  const row2 = rowOf(out2.id)
  const rowsAfterSecond = docRows()
  const row1Now = rowOf(out1.id)
  const verify1 = await h.call("studio_file_verify", { fileId: out1.id, expectedSha256: out1.sha256 })
  const verify2 = await h.call("studio_file_verify", { fileId: out2.id, expectedSha256: out2.sha256 })

  // Identical bytes again (same raster as render 2, then as render 1): the existing rows are reused.
  const out3 = await render()
  const rowsAfterThird = docRows()
  fill = 0xff
  const out4 = await render()
  const rowsAfterFourth = docRows()
  const newest = h.sql<{ id: string }>(
    "SELECT o.id FROM output_file o JOIN revision r ON r.id = o.revision_id WHERE o.document_id = ? AND r.revision_no = ? AND o.format = 'DOCX' AND o.role = 'PRIMARY' ORDER BY o.time_created DESC, o.rowid DESC LIMIT 1",
    [id, n],
  )[0]
  const evidence = {
    revisionNo: n,
    pngJobs: { first: pngAfterFirst, total: pngJobs },
    first: { id: out1.id, sha256: out1.sha256, relPath: row1.rel_path },
    second: { id: out2.id, sha256: out2.sha256, relPath: row2.rel_path },
    third: { id: out3.id, sha256: out3.sha256 },
    fourth: { id: out4.id, sha256: out4.sha256 },
    row1Now,
    diskFirst: sha256File(path.join(STORE, row1.rel_path)),
    diskSecond: sha256File(path.join(STORE, row2.rel_path)),
    rows: { afterFirst: rowsAfterFirst, afterSecond: rowsAfterSecond, afterThird: rowsAfterThird, afterFourth: rowsAfterFourth },
    revFolder: readdirSync(revDir).sort(),
    newest: newest?.id ?? null,
    verifyFirst: { ok: verify1.ok ?? null, code: verify1.code ?? null, verified: verify1.verified ?? null },
    verifySecond: { ok: verify2.ok ?? null, code: verify2.code ?? null, verified: verify2.verified ?? null },
  }
  console.log(`[row43 replace] evidence ${JSON.stringify(evidence)}`)
  // Precondition of the finding: the second render produced other bytes.
  expect(out2.sha256).not.toBe(out1.sha256)
  // Other bytes: a NEW row and a NEW file `<stem>_<sha8>.docx` in the same revision folder.
  expect(out2.id).not.toBe(out1.id)
  expect(rowsAfterSecond).toBe(rowsAfterFirst + 1)
  expect(path.dirname(row2.rel_path)).toBe(path.dirname(row1.rel_path))
  expect(row2.file_name).toBe(`${row1.file_name.replace(/\.docx$/, "")}_${String(out2.sha256).slice(0, 8)}.docx`)
  expect(evidence.diskSecond).toBe(out2.sha256)
  // U6 / store spec :357: the first output of the revision is untouched, by id, path, sha and job.
  expect(row1Now).toEqual(row1)
  expect(evidence.diskFirst).toBe(out1.sha256)
  expect(verify1.ok).toBe(true)
  expect(verify1.verified).toBe(true)
  expect(verify2.ok).toBe(true)
  expect(verify2.verified).toBe(true)
  // Identical bytes: no duplicate row, no new file; the same ids come back.
  expect(out3.sha256).toBe(out2.sha256)
  expect(out3.id).toBe(out2.id)
  expect(rowsAfterThird).toBe(rowsAfterSecond)
  expect(out4.sha256).toBe(out1.sha256)
  expect(out4.id).toBe(out1.id)
  expect(rowsAfterFourth).toBe(rowsAfterSecond)
  expect(evidence.revFolder.filter((f) => f.endsWith(".docx"))).toEqual([row1.file_name, row2.file_name].sort())
  // The newest output of the revision by creation is the second render's row.
  expect(row2.time_created).toBeGreaterThanOrEqual(row1.time_created)
  expect(evidence.newest).toBe(out2.id)
}, 240_000)
