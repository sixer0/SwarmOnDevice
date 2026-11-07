// Row 165D: one real store + host + MCP client + render bridge (fake PageEngine only), as test/retrieval/row43-*.
// Needs the command sandbox off (127.0.0.1 port + Unix socket). No network, no model.
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import path from "node:path"
import { startRenderBridge } from "../../../desktop/src/main/datum-render/index.ts"
import { renderWebPreferences } from "../../../desktop/src/main/datum-render/pages.ts"
import { resetBridgePdfReadiness } from "../../vendor/src/lib/studio/services/render"
import { realPdf, realPng, sheetsOf, startHost, type Host } from "../retrieval/scenario.ts"

type S = Record<string, any>
export const PKG = path.resolve(import.meta.dir, "..", "..")
const DESKTOP = path.resolve(PKG, "..", "desktop")

export type Rig = { h: Host; work: string; store: string; project: string; stop(): Promise<void> }

export async function startRig(tag: string): Promise<Rig> {
  const base = path.join(process.env.ROW165D_BASE ?? "/private/tmp/claude-501/row165D", tag)
  mkdirSync(base, { recursive: true })
  const work = realpathSync(mkdtempSync(path.join(base, "r-")))
  const store = path.join(work, "datum-studio")
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error("row165D test: globalThis.fetch must not be called")
  }) as unknown as typeof fetch
  const bridge = await startRenderBridge({
    fontsDir: path.join(DESKTOP, "datum", "datum-house-style", "assets", "fonts"),
    log: () => {},
    baseDir: work,
    engine: {
      async png(job: { width: number; height: number }) {
        return realPng(Math.max(1, Math.round(job.width)), Math.max(1, Math.round(job.height)), 0xff)
      },
      async pdf(job: { html: string; widthMm: number; heightMm: number }) {
        return realPdf(Math.max(1, sheetsOf(job.html)), job.widthMm, job.heightMm)
      },
      async evaluate() {
        throw new Error("layout measurement is not part of this fake")
      },
      info: () => {
        const raster = renderWebPreferences("raster") as S
        return { electron: "fake-row165d", chrome: "fake-row165d", partition: "datum-render", sandbox: raster.sandbox, contextIsolation: raster.contextIsolation, nodeIntegration: raster.nodeIntegration, javascriptContent: raster.javascript, network: "blocked" }
      },
    } as never,
  })
  const h = await startHost({ phase: tag, pkg: PKG, storeRoot: store, work } as never, () => {})
  process.env.DATUM_RENDER_SOCKET = bridge.env.DATUM_RENDER_SOCKET
  process.env.DATUM_RENDER_TOKEN = bridge.env.DATUM_RENDER_TOKEN
  resetBridgePdfReadiness()
  return {
    h,
    work,
    store,
    project: path.join(work, "home", "project-a"),
    async stop() {
      await h.stop()
      await bridge.close()
      delete process.env.DATUM_RENDER_SOCKET
      delete process.env.DATUM_RENDER_TOKEN
      globalThis.fetch = realFetch
    },
  }
}

/** A NOTA (template datum-nota) with one chapter, rendered; returns the document id and the render outputs. */
export async function renderNota(h: Host, o: { mission: string; docKey: string; title: string; formats: string[] }) {
  const created = await h.call("studio_document_create", { template: "datum-nota", mission: o.mission, docKey: o.docKey, title: o.title })
  if (created.ok !== true) throw new Error(`create failed: ${created._text}`)
  const id = String(created.documentId)
  const rev = () => Number(h.sql<{ n: number }>("SELECT current_revision_no AS n FROM document WHERE id = ?", [id])[0]!.n)
  const imp = await h.call("studio_chapter_import_markdown", { documentId: id, chapterKey: "1", markdown: "# Kajian uji\n\nPengukuran titik uji dicatat tiap bulan oleh tim lapangan.\n", submit: true, baseRevisionNo: rev() })
  if (imp.ok !== true) throw new Error(`import failed: ${imp._text}`)
  const r = await h.call("studio_render", { documentId: id, formats: o.formats })
  if (r.ok !== true) throw new Error(`render failed: ${r._text}`)
  return { id, outputs: (r.outputs ?? []) as S[], render: r }
}

/** Absolute store path of an output by id. */
export function storePath(rig: Rig, fileId: unknown): string {
  const row = rig.h.sql<{ rel_path: string }>("SELECT rel_path FROM output_file WHERE id = ?", [fileId])[0]
  if (!row) throw new Error(`no output_file ${String(fileId)}`)
  return path.join(rig.store, row.rel_path)
}
