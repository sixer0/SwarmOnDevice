// Row 43b (decision C94): readers list a revision's outputs newest first, by the rule row 43a wrote at vendor
// services/storage/files.ts:26 (latest time_created, then highest rowid). Two renders of one revision with different
// bytes give two DOCX rows; R05 (studio_document_get route, src/mcp-host/local-api/db.ts outputsOfRevision) must list
// the newer DOCX first, and SqliteStudioStore.getDocument must return the outputs newest first too.
// Setup copied from row43-output-replace.test.ts (one process under bun; real store, host, render bridge; fake
// PageEngine only; needs the command sandbox off). No network, no model.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync } from "node:fs"
import path from "node:path"
import { startRenderBridge } from "../../../desktop/src/main/datum-render/index.ts"
import { renderWebPreferences } from "../../../desktop/src/main/datum-render/pages.ts"
import { resetBridgePdfReadiness } from "../../vendor/src/lib/studio/services/render"
import { studioStore } from "../../src/store-bridge/db.ts"
import { realPdf, realPng, sha256File, sheetsOf, startHost, type Host } from "./scenario.ts"

type S = Record<string, any>
const PKG = path.resolve(import.meta.dir, "..", "..")
const DESKTOP = path.resolve(PKG, "..", "desktop")
const BASE = path.join(process.env.ROW43_BASE ?? "/private/tmp/claude-501/row43", "newest")
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
    throw new Error("row43b test: globalThis.fetch must not be called")
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
        return { electron: "fake-row43b", chrome: "fake-row43b", partition: "datum-render", sandbox: raster.sandbox, contextIsolation: raster.contextIsolation, nodeIntegration: raster.nodeIntegration, javascriptContent: raster.javascript, network: "blocked" }
      },
    } as never,
  })
  h = await startHost({ phase: "R", pkg: PKG, storeRoot: STORE, work: WORK } as never, (l) => console.log(`[row43b] ${l}`))
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

test("row 43b (C94): R05 and getDocument list the newest output of a revision first", async () => {
  const created = await h.call("studio_document_create", { template: "datum-nota", mission: "2026-11-07_row43b", docKey: "nota-grafik", title: "Nota grafik row 43b" })
  expect(created.ok).toBe(true)
  const id = String(created.documentId)
  const rev = () => Number(h.sql<{ n: number }>("SELECT current_revision_no AS n FROM document WHERE id = ?", [id])[0].n)
  const imp = await h.call("studio_chapter_import_markdown", { documentId: id, chapterKey: "1", markdown: "# Uji\n\nPengukuran titik uji dicatat tiap bulan.\n", submit: true, baseRevisionNo: rev() })
  expect(imp.ok).toBe(true)
  const snap = JSON.parse(h.sql<{ snapshot: string }>("SELECT snapshot FROM revision WHERE document_id = ? AND revision_no = ?", [id, rev()])[0].snapshot) as { blocks: S[] }
  const para = snap.blocks.find((b) => b.type === "paragraph" && typeof b.pid === "string")!
  const ins = await h.local("PATCH", `/api/studio/documents/${id}/paragraphs/${para.pid}`, { op: "insertAfter", baseRevisionNo: rev(), block: CHART, change: { what: "Grafik", why: "uji row 43b", impact: "revisi baru" } })
  expect(ins.status).toBe(200)
  const n = rev()
  const render = async () => {
    const r = await h.call("studio_render", { documentId: id, revisionNo: n, formats: ["docx"] })
    expect(r.ok).toBe(true)
    return ((r.outputs ?? []) as S[])[0]
  }

  const out1 = await render()
  fill = 0x80 // other raster bytes -> a second DOCX row (row 43a)
  const out2 = await render()
  expect(out2.sha256).not.toBe(out1.sha256)
  expect(out2.id).not.toBe(out1.id)

  // The rule itself (files.ts:26): the newest row is the second render's.
  const newest = h.sql<{ id: string }>(
    "SELECT o.id FROM output_file o JOIN revision r ON r.id = o.revision_id WHERE o.document_id = ? AND r.revision_no = ? AND o.format = 'DOCX' AND o.role = 'PRIMARY' ORDER BY o.time_created DESC, o.rowid DESC LIMIT 1",
    [id, n],
  )[0]
  expect(newest.id).toBe(out2.id)

  // R05 through the real host.
  const got = await h.local("GET", `/api/studio/documents/${id}?rev=${n}`)
  expect(got.status).toBe(200)
  const r05 = ((got.body.outputs ?? []) as S[]).filter((o) => String(o.format).toUpperCase() === "DOCX").map((o) => String(o.id))
  console.log(`[row43b] evidence ${JSON.stringify({ first: out1.id, second: out2.id, r05 })}`)
  expect(r05).toEqual([String(out2.id), String(out1.id)])

  // SqliteStudioStore.getDocument (the document's current revision is n).
  const detail = await studioStore().getDocument(id)
  expect(detail).not.toBeNull()
  const sd = detail!.outputs.filter((o) => String(o.format).toUpperCase() === "DOCX").map((o) => o.id)
  console.log(`[row43b] evidence getDocument ${JSON.stringify(sd)}`)
  expect(sd).toEqual([String(out2.id), String(out1.id)])
}, 240_000)
