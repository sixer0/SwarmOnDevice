// Swarm 1.2.6 row 115 (01g section 5.1 / 5.3): the L layer of the acceptance session, local only. It reads the real
// evidence from folders named ONLY by environment variables, writes ONLY under ACC_LOCAL, and prints numbers, codes
// and figure numbers, never a caption, label, file name or value of the evidence. Nothing it produces is committed.
//   ACC_REV_D    Rev D root (holds naskah-revd/bab-*.md)
//   ACC_REV_E    Rev E root (holds mata/<set>/*.svg|png, terbit/*.html, eksperimen/png/*.png)
//   ACC_LOCAL    private scratch folder (mode 700), outside the repository and outside /docs
//   ACC_STUDIO_COPY  optional: a COPY of the Studio store file (opened read-only here)
//   ACC_DOC      optional: the Studio document id of the real specs in that copy
// Run (sandbox off: Electron, Unix socket, port):
//   cd packages/datum-studio && ACC_REV_D=… ACC_REV_E=… ACC_LOCAL=… bun run test/acceptance/run_local.local.ts
// Output: $ACC_LOCAL/result_l.json and `[acc115L] …` lines. Flows F1, F2, F3, F4 (14.1 at TB), F6 (one real PNG).
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { AccSession, checkIdsIn, errCode, figureFit, flowF6, Ledger, okCall, PKG, sha256, t11Geometry, workRoot, type S } from "./session_115.acc"

const need = (k: string) => {
  const v = process.env[k]
  if (!v || !existsSync(v)) throw new Error(`${k} must name an existing folder`)
  return v
}
const REV_D = need("ACC_REV_D")
const REV_E = need("ACC_REV_E")
const LOCAL = workRoot("ACC_LOCAL")
const FIG_RE = /^\S+ (\d{1,2}\.\d{1,2})\b.*\.(svg|png)$/

/** Figure number -> file, per evidence set; file names stay in memory only. */
function twins(set: string, ext: "svg" | "png"): Map<string, string> {
  const dir = path.join(REV_E, "mata", set)
  const out = new Map<string, string>()
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir)) {
    const m = FIG_RE.exec(f)
    if (m && m[2] === ext) out.set(m[1], path.join(dir, f))
  }
  return out
}
const pngSize = (p: string) => {
  const b = readFileSync(p)
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
}
const viewBox = (svg: string) => {
  const m = /viewBox="\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)\s*"/.exec(svg)
  return m ? { w: Number(m[3]), h: Number(m[4]) } : null
}

// F1 L. Calibration figures (row 24 mapping, t03_k1..k7 / n1) with their designed kinds; every other twin is hold-out.
const CALIBRATION: Array<[string, string, string[]]> = [
  ["e3", "2.2", ["stubSegment", "arrowTangent"]],
  ["loop3r2", "1.3", ["stubSegment", "edgeEntryCollision"]],
  ["loop3r2", "4.2", ["stubSegment", "arrowTangent"]],
  ["loop3r2", "6.2", ["stubSegment"]],
  ["loop3r2", "9.1", ["stubSegment", "arrowTangent", "edgeEntryCollision"]],
  ["loop3r2", "13.2", ["stubSegment"]],
  ["loop4", "18.2", ["stubSegment"]],
]
const NEGATIVE: Array<[string, string]> = [["loop4", "1.1"]]

async function flowF1(L: Ledger) {
  const used = new Set([...CALIBRATION.map(([s, n]) => `${s}/${n}`), ...NEGATIVE.map(([s, n]) => `${s}/${n}`)])
  const rows: S[] = []
  for (const [set, fig, expected] of CALIBRATION) {
    const svgP = twins(set, "svg").get(fig)
    const pngP = twins(set, "png").get(fig)
    if (!svgP || !pngP) {
      L.check("F1-L", `${set} ${fig}: twin present`, false, null)
      continue
    }
    const svg = readFileSync(svgP, "utf8")
    const vb = viewBox(svg)
    const ps = pngSize(pngP)
    const ratioDiff = vb ? Math.abs(ps.w / ps.h - vb.w / vb.h) / (vb.w / vb.h) : NaN
    L.check("F1-L", `${set} ${fig}: PNG twin aspect = SVG viewBox within 1 %`, ratioDiff <= 0.01, { ratioDiff: +ratioDiff.toFixed(5) })
    const g = await figureFit(svg)
    rows.push({ set, fig, role: "calibration", expected, got: g.failNew, status: g.status })
    L.check("F1-L", `${set} ${fig}: FIGURE_FIT FAIL with a code in the expected set`, g.status === "FAIL" && g.failNew.some((k) => expected.includes(k)), { status: g.status, failNew: g.failNew, expected })
  }
  for (const [set, fig] of NEGATIVE) {
    const svgP = twins(set, "svg").get(fig)
    const g = svgP ? await figureFit(readFileSync(svgP, "utf8")) : null
    rows.push({ set, fig, role: "negative (judge pass)", got: g?.failNew ?? null, status: g?.status ?? null })
    L.check("F1-L", `${set} ${fig}: judge-passed figure has no new-kind FAIL`, !!g && g.failNew.length === 0, { status: g?.status, kinds: g?.kinds })
  }
  // Hold-out (gate M1 S10): twins never used to set the thresholds.
  for (const set of ["loop3r2", "loop4", "loop5"]) {
    for (const [fig, p] of [...twins(set, "svg").entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
      if (used.has(`${set}/${fig}`)) continue
      const g = await figureFit(readFileSync(p, "utf8"))
      rows.push({ set, fig, role: "hold-out", got: g.failNew, status: g.status, kinds: [...new Set(g.kinds)] })
    }
  }
  L.note("F1-L", "table", rows)
  writeFileSync(path.join(LOCAL, "f1_table.json"), JSON.stringify(rows, null, 1))
}

// F2 L. The Rev D naskah figure blocks.
type Naskah = { nomor?: string; jenis: "diagram" | "chart"; caption: string } & S
function naskahBlocks(): Naskah[] {
  const dir = path.join(REV_D, "naskah-revd")
  const out: Naskah[] = []
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".md")).sort()) {
    const text = readFileSync(path.join(dir, f), "utf8")
    for (const m of text.matchAll(/```figur json\n([\s\S]*?)\n```/g)) {
      try {
        out.push(JSON.parse(m[1]))
      } catch {
        /* not a block */
      }
    }
  }
  return out
}
const TOKEN_RE = /^\s*(gambar|figure|fig\.|grafik|bagan|diagram)\s*[A-Z]?\d{1,3}(?:[.\-]\d+)*\b/i
const strip = (c: string) => c.replace(TOKEN_RE, "").replace(/^[\s.:\-–]+/, "").trim()

async function flowF2(s: AccSession, L: Ledger) {
  const { naskahToBlockV2 } = await import("../t01-caption-token/naskah-map")
  const { validateBlockV2 } = await import(path.join(PKG, "vendor/src/lib/studio/services/revisions/v2/body"))
  const all = naskahBlocks()
  const byNo = new Map(all.map((n) => [String(n.nomor), n]))
  const blocks = [...byNo.values()]
  L.note("F2-L", "naskah blocks", { fences: all.length, unique: blocks.length, diagrams: blocks.filter((b) => b.jenis === "diagram").length, charts: blocks.filter((b) => b.jenis === "chart").length, tokenLed: blocks.filter((b) => TOKEN_RE.test(b.caption)).length })
  let validatorHits = 0
  for (const n of blocks) if ((validateBlockV2(naskahToBlockV2(n as never), "/b") as S[]).some((i) => i.checkId === "CAPTION_TOKEN_DUPLICATE")) validatorHits++
  const cr = await s.call("studio_document_create", { template: "datum-nota", mission: s.mission, docKey: "acc115-f2l", title: "Dokumen lokal F2", detail: true })
  const docId = String(cr.document?.id)
  let refused = 0
  const notRefused: string[] = []
  for (const n of blocks) {
    const sub = { $schema: "studio.chapter/v2", target: { documentId: docId }, chapter: { key: "1", title: { text: "Uji" }, sections: [{ title: { text: "Uji" }, blocks: [{ type: "paragraph", text: "Paragraf uji." }, naskahToBlockV2(n as never)] }] } }
    const r = await s.call("studio_chapter_submit", { submission: sub, detail: true })
    if (!okCall(r) && (checkIdsIn(r).includes("CAPTION_TOKEN_DUPLICATE") || r._text.includes("CAPTION_TOKEN_DUPLICATE"))) refused++
    else notRefused.push(`${n.nomor}:${errCode(r)}`)
  }
  L.check("F2-L", `validator: ${blocks.length}/${blocks.length} Rev D blocks carry CAPTION_TOKEN_DUPLICATE`, validatorHits === blocks.length, { validatorHits })
  L.check("F2-L", `chapter submit: ${blocks.length}/${blocks.length} refused CAPTION_TOKEN_DUPLICATE`, refused === blocks.length, { refused, notRefused })
  // One long caption, token removed, as a stand-alone figure (engine-drawn caption): CAPTION_WRAP with the limit.
  const long = blocks.find((b) => b.jenis === "diagram" && strip(b.caption).length > 100)
  if (long) {
    const sub = { $schema: "studio.chapter/v2", target: { documentId: docId }, chapter: { key: "1", title: { text: "Uji" }, sections: [{ title: { text: "Uji" }, blocks: [{ type: "paragraph", text: "Paragraf uji." }, naskahToBlockV2(long as never, strip(long.caption))] }] } }
    const ok = await s.call("studio_chapter_submit", { submission: sub, detail: true })
    const dl = path.join(s.project, "f2l")
    mkdirSync(dl, { recursive: true })
    const pv = await s.call("studio_figure_preview", { documentId: docId, address: "Gambar 1.1", standalone: true, downloadDir: dl })
    const f = readdirSync(dl).find((x) => x.endsWith(".svg"))
    const sc = await import(path.join(PKG, "src/mcp-host/verify/static-checks.ts"))
    const c = f ? sc.checkFigureFit({ format: "SVG", svg: readFileSync(path.join(dl, f), "utf8"), figureKind: "diagram", figureLabel: "Gambar 1.1" }) : null
    const w = ((c?.findings ?? []) as S[]).find((x) => x.code === "CAPTION_WRAP")
    L.check("F2-L", `figure ${long.nomor} (caption ${strip(long.caption).length} chars, token removed): stand-alone FIGURE_FIT FAIL CAPTION_WRAP citing 100`, c?.status === "FAIL" && !!w && /100/.test(String(w.detail)), { submit: errCode(ok), preview: errCode(pv), status: c?.status ?? null, codes: ((c?.findings ?? []) as S[]).map((x) => x.code) })
  }
}

// F3 L. The Rev D HTML (rev 256 render), measured by the same OVERLAP_CLIP code through the real bridge.
async function flowF3(L: Ledger) {
  const dir = path.join(REV_E, "terbit")
  const f = readdirSync(dir).find((x) => /RevD\.html$/.test(x))
  if (!f) return void L.check("F3-L", "Rev D HTML present", false, null)
  const html = readFileSync(path.join(dir, f), "utf8")
  const oc = await import(path.join(PKG, "src/mcp-host/verify/overlap-clip.ts"))
  const t0 = Date.now()
  const r = await oc.runOverlapClip({ format: "HTML", html, pageWidthMm: 210, pageHeightMm: 297 })
  const k = r.check as S
  const cov = k.coverage as S | undefined
  const ratio = cov ? cov.measuredPages / cov.totalPages : NaN
  L.check("F3-L", "Rev D HTML: OVERLAP_CLIP coverage >= 0.90", ratio >= 0.9, { sha256: sha256(html), status: k.status, reason: k.reason ?? null, coverage: cov ?? null, ratio: Number.isFinite(ratio) ? +ratio.toFixed(4) : null, text: oc.overlapCoverageText(k), findings: (k.findings ?? []).length, codes: [...new Set(((k.findings ?? []) as S[]).map((x) => x.code))], bridgeJobs: r.bridgeJobs, ms: Date.now() - t0 })
}

// F4 L. The real 14.1 spec (Studio store copy, read-only) as a ranked flow, direction TB, in the isolated store.
function realSpec(label: string): S | null {
  const db = process.env.ACC_STUDIO_COPY
  const doc = process.env.ACC_DOC
  if (!db || !doc) return null
  const d = new Database(`file:${db}?immutable=1`, { readonly: true }) // a copy, opened immutable: nothing is ever written
  try {
    const row = d
      .query("SELECT b.content AS c, r.revision_no AS n FROM doc_block b JOIN revision r ON r.id = b.revision_id WHERE r.document_id = ? AND b.artifact_label = ? ORDER BY r.revision_no DESC LIMIT 1")
      .get(doc, label) as { c: string; n: number } | null
    return row ? { ...JSON.parse(row.c), _rev: row.n } : null
  } finally {
    d.close()
  }
}

async function flowF4(s: AccSession, L: Ledger) {
  const b = realSpec("Gambar 14.1")
  if (!b) return void L.note("F4-L", "skipped", "no store copy given")
  const rev = b._rev
  delete b._rev
  const nodes = (b.spec?.nodes ?? []) as S[]
  const edges = (b.spec?.edges ?? []) as S[]
  const block = { ...b, spec: { ...b.spec, direction: "TB" } }
  const cr = await s.call("studio_document_create", { template: "datum-nota", mission: s.mission, docKey: "acc115-f4l", title: "Dokumen lokal F4", detail: true })
  const docId = String(cr.document?.id)
  const sub = await s.call("studio_chapter_submit", { submission: { $schema: "studio.chapter/v2", target: { documentId: docId }, chapter: { key: "1", title: { text: "Uji" }, sections: [{ title: { text: "Uji" }, blocks: [{ type: "paragraph", text: "Paragraf uji." }, block] }] } }, detail: true })
  L.check("F4-L", "real 14.1 with direction TB accepted", okCall(sub), { rev, nodes: nodes.length, edges: edges.length, code: errCode(sub), text: okCall(sub) ? "" : sub._text.replace(/\s+/g, " ").slice(0, 200) })
  const pdir = path.join(s.project, "f4l_svg")
  mkdirSync(pdir, { recursive: true })
  const pv = await s.call("studio_figure_preview", { documentId: docId, address: "Gambar 1.1", downloadDir: pdir })
  const sf = readdirSync(pdir).find((x) => x.endsWith(".svg"))
  const svg = sf ? readFileSync(path.join(pdir, sf), "utf8") : ""
  const defects = ((pv.figure?.defects ?? []) as S[]).map((x) => `${x.checkId}:${x.status}`)
  // The four parallel targets = nodes 2..5 in source order (the anonymised twin's n2..n5).
  const rank = nodes.slice(1, 5).map((n) => String(n.id))
  const g = svg ? t11Geometry(svg, rank) : null
  const fit = svg ? await figureFit(svg) : null
  L.check("F4-L", "inline preview (machine gate): no defect", okCall(pv) && defects.length === 0, { code: errCode(pv), defects, widthMm: pv.figure?.size?.widthMm ?? null, heightMm: pv.figure?.size?.heightMm ?? null })
  L.check("F4-L", "the four parallel targets share one rank (y within 0.5 mm), distinct x", !!g && g.sameRank && g.distinctX, g ? { sameRank: g.sameRank, distinctX: g.distinctX, nodes: g.nodes } : null)
  L.check("F4-L", "FIGURE_FIT on the preview SVG: no FAIL", fit?.status !== "FAIL", fit)
  const png = await s.call("studio_figure_preview", { documentId: docId, address: "Gambar 1.1", standalone: true, png: true, downloadDir: path.join(s.project, "f4l") })
  const pf = existsSync(path.join(s.project, "f4l")) ? readdirSync(path.join(s.project, "f4l")).filter((x) => x.endsWith(".png")) : []
  L.check("F4-L", "stand-alone PNG through the real bridge (kept in ACC_LOCAL only)", okCall(png) && pf.length >= 1, { code: errCode(png), pngs: pf.length, sha256: pf[0] ? sha256(readFileSync(path.join(s.project, "f4l", pf[0]))) : null })
}

async function main() {
  const L = new Ledger("acc115L")
  const only = process.env.ACC_FLOWS?.split(",").map((x) => x.trim())
  const want = (f: string) => !only || only.includes(f)
  if (want("F1-L")) await flowF1(L)
  const s = new AccSession(path.join(LOCAL, "sess"), { mission: "2026-11-13_acc115-local" })
  await s.start({ bridge: true })
  try {
    await s.openMission(["F2", "F3", "F4", "F6"])
    for (const [f, fn] of [
      ["F2-L", () => flowF2(s, L)],
      ["F3-L", () => flowF3(L)],
      ["F4-L", () => flowF4(s, L)],
      [
        "F6-L",
        async () => {
          const dir = path.join(REV_E, "eksperimen", "png")
          const p = readdirSync(dir).find((x) => /^\S+-14-1\.png$/.test(x))
          if (!p) return void L.check("F6-L", "14.1 PNG present", false, null)
          L.note("F6-L", "input", { sha256: sha256(readFileSync(path.join(dir, p))) })
          await flowF6(s, L, { png: path.join(dir, p), label: "14.1" })
        },
      ],
    ] as const) {
      if (!want(f)) continue
      await s.resetLimits()
      try {
        await fn()
      } catch (e) {
        L.check(f, "flow ran to the end", false, { error: String(e instanceof Error ? e.message : e).slice(0, 300) })
      }
    }
  } finally {
    L.note("ALL", "electron stop", await s.stop())
  }
  const summary = L.summary()
  writeFileSync(path.join(LOCAL, "result_l.json"), JSON.stringify({ summary, checks: L.checks }, null, 1))
  console.log(`[acc115L] SUMMARY ${JSON.stringify(summary)}`)
  process.exit(L.checks.every((c) => c.pass) ? 0 : 1)
}

if (import.meta.main) await main()
