// Swarm 1.3.3 row 36 (ST-1 item 5): capacity table per diagram family and per width, from REAL engine renders.
//
// Every probe goes through the product's two figure paths, not through a capacity helper. One v2 diagram block
// (with `width: "text" | "full"`) is composed once by composeInlineBlock (compose `mapBlock`, the one width decision
// of row 32: text = 128 mm, full = 166 mm on the A4 DATUM grid) and then goes through:
//   R. the document render: services/render/figures.ts `buildFigures` (pre-render capacity check, then
//      buildDiagramSvgAuto with the template grid and the document language; the raster step runs against a fake
//      render bridge, as test/st1-width-in-compose does, because no Electron is present in tests);
//   P. the preview, which the agent guide names as the machine gate: `renderFigure` of
//      src/mcp-host/local-api/routes/figure-preview-figure.ts.
//
// A path "passes" when it returns and the figure has no defect (any FAIL, GEOM_*, or a code the preview classes as a
// defect: `splitPreviewIssues`). Notices (AUTO_FIT, LABEL_MOVED, CAPACITY_ADAPT, labels not yet checked by a
// person...) do not fail a probe. A path that throws is a refusal; code, check id and message are recorded.
// A probe passes when BOTH paths pass: that is what an agent can get through the gate and into a document.
// Where the two paths disagree, the cell records both numbers (`limit` and `renderLimit`).
//
// The table is generated, never typed: `generateCapacityTable()` scans each dimension upward from its start size,
// and keeps going three sizes past the first failure (sizes are small, so a linear scan costs little and, unlike a
// binary search, it does not assume that passing is monotone; sizes that pass above the limit are recorded).
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { NormBlock, NormDocSnapshot, ResolvedTemplate } from "../../vendor/src/lib/studio/contract"

type J = Record<string, any>

export const WIDTHS = ["text", "full"] as const
export type Width = (typeof WIDTHS)[number]

/** Generator settings shared by every synthetic spec; recorded in the data file. */
export const GENERATOR = {
  nodeLabel: "Simpul <n>" as const,
  edgeLabel: "data" as const,
  edgeKind: "data" as const,
  caption: "Uji kapasitas." as const,
  source: "Sumber sintetis uji." as const,
  language: "ID" as const,
}

export interface PathOutcome {
  /** "pass" = returned, no defect; "defect" = returned with defects; "refused" = the path threw. */
  result: "pass" | "defect" | "refused"
  widthMm?: number
  heightMm?: number
  /** Defect check ids (sorted, unique) of a rendered figure. */
  defects?: string[]
  /** Notice check ids (sorted, unique) of a rendered figure. */
  notices?: string[]
  /** First defect line (check id and detail), for the reader. */
  firstDefect?: string
  /** Refusal: engine error code, check id from details, and the message. */
  code?: string
  checkId?: string
  message?: string
  /** True when the refusal carries the split skeleton of row 51 (`details.split`). */
  split?: boolean
}

/** The document render outcome, plus the preview outcome when the preview does not agree with it. */
export interface ProbeOutcome extends PathOutcome {
  /** Present only when the preview path ends differently from the render path (result, defects or refusal code). */
  preview?: PathOutcome
}

/** Both paths pass: the figure can pass the machine gate and be printed. */
export const passes = (o: ProbeOutcome): boolean => o.result === "pass" && o.preview === undefined

export interface Dimension {
  /** Stable key of the row: `<family>.<what>`. */
  key: string
  family: string
  /** What grows with n, in words a guide can print. */
  varies: string
  /** What stays fixed. */
  fixed: string
  /** First size probed. */
  start: number
  /** Scan stops here even when everything passes (`limit` is then reported with `capped: true`). */
  max: number
  spec: (n: number) => J
}

export interface Cell {
  width: Width
  widthMm: number
  /** Largest n such that every size from `start` to n passes on both paths; 0 when the start size already fails. */
  limit: number
  /** Largest n such that every size from `start` to n passes the document render alone (>= limit). */
  renderLimit: number
  /** True when the scan reached the dimension's `max` without a failure (the limit is then the scan's end, not the engine's). */
  capped: boolean
  /** Outcome at `limit` (the render proof of the number). */
  atLimit: ProbeOutcome | null
  /** Size and outcome one step above the limit. */
  aboveSize: number | null
  above: ProbeOutcome | null
  /** Sizes above the limit that pass again (passing is not monotone there); scanned up to three sizes past the first failure. */
  alsoPass: number[]
  /** Last size probed. */
  scannedTo: number
}

export interface CapacityRow {
  key: string
  family: string
  varies: string
  fixed: string
  start: number
  max: number
  cells: Cell[]
}

export interface CapacityTable {
  generator: typeof GENERATOR
  path: string
  rows: CapacityRow[]
}

// ---------------------------------------------------------------------------------------------- spec generators

const node = (id: string, n: number | string, cls: J, extra: J = {}): J => ({ id, label: typeof n === "number" ? `Simpul ${n}` : n, class: cls, ...extra })
const edge = (from: string, to: string): J => ({ from, to, kind: GENERATOR.edgeKind, label: GENERATOR.edgeLabel })
const range = (n: number) => Array.from({ length: n }, (_, i) => i)

/** Tiered families (layered, topology, stack): `tiers` tiers of `perTier` nodes; node i of a tier feeds node i below. */
function tiered(family: string, tiers: number, perTier: number): J {
  const nodes = range(tiers).flatMap((t) => range(perTier).map((i) => node(`t${t}n${i}`, t * perTier + i + 1, { tier: t })))
  const edges = range(tiers - 1).flatMap((t) => range(perTier).map((i) => edge(`t${t}n${i}`, `t${t + 1}n${i}`)))
  return { family, nodes, edges }
}

/** Tiered family with `zones` containers side by side; each container holds one node in each of two tiers. */
function tieredZones(family: string, zones: number): J {
  const s = tiered(family, 2, zones)
  return { ...s, zones: range(zones).map((i) => ({ id: `z${i}`, label: `Wadah ${i + 1}`, members: [`t0n${i}`, `t1n${i}`] })) }
}

/** Flow with a direction: `ranks` ranks of `perRank` nodes; node i of a rank feeds node i of the next (no fan-out). */
function flowRanked(direction: "TB" | "LR", ranks: number, perRank: number): J {
  const nodes = range(ranks).flatMap((r) => range(perRank).map((i) => node(`r${r}n${i}`, r * perRank + i + 1, {})))
  const edges = range(ranks - 1).flatMap((r) => range(perRank).map((i) => edge(`r${r}n${i}`, `r${r + 1}n${i}`)))
  return { family: "flow", direction, nodes, edges }
}

/** Flow without a direction (list order): one chain of n nodes. */
function flowChain(n: number): J {
  return { family: "flow", nodes: range(n).map((i) => node(`f${i}`, i + 1, {})), edges: range(n - 1).map((i) => edge(`f${i}`, `f${i + 1}`)) }
}

/** Swimlane: `lanes` lanes of `perLane` nodes; each lane is a chain, and the last node of a lane hands off straight down to the last node of the next lane. */
function swimlane(lanes: number, perLane: number): J {
  const nodes = range(lanes).flatMap((l) => range(perLane).map((i) => node(`l${l}n${i}`, l * perLane + i + 1, { lane: `Lajur ${l + 1}` })))
  const edges = [
    ...range(lanes).flatMap((l) => range(perLane - 1).map((i) => edge(`l${l}n${i}`, `l${l}n${i + 1}`))),
    ...range(lanes - 1).map((l) => edge(`l${l}n${perLane - 1}`, `l${l + 1}n${perLane - 1}`)),
  ]
  return { family: "swimlane", nodes, edges }
}

/** Sequence: `lifelines` participants on col 0..; `messages` messages going round the neighbours in turn. */
function sequence(lifelines: number, messages: number): J {
  const nodes = range(lifelines).map((i) => node(`p${i}`, i + 1, { col: i }))
  const edges = range(messages).map((m) => {
    const a = m % (lifelines - 1)
    return m % 2 === 0 ? edge(`p${a}`, `p${a + 1}`) : edge(`p${a + 1}`, `p${a}`)
  })
  return { family: "sequence", nodes, edges }
}

/** Single-line diagram: one bus and `branches` feeders. The layout hangs every non-bus node of a bus in ONE row (class.tier is not a layout axis here). */
function sld(branches: number): J {
  const nodes = [node("bus", "Rel bus", { tier: 0 }, { shape: "bus" }), ...range(branches).map((b) => node(`b${b}`, b + 1, { tier: 1 }))]
  return { family: "sld", nodes, edges: range(branches).map((b) => edge("bus", `b${b}`)) }
}

/** Rack elevation: n devices of 1U on rows 0..n-1; `uplink` adds one connector between the first two devices. */
function rack(n: number, uplink: boolean): J {
  return { family: "rack", nodes: range(n).map((i) => node(`u${i}`, i + 1, { row: i }, { u: 1 })), edges: uplink && n > 1 ? [edge("u0", "u1")] : [] }
}

/** Graph: `cols` x `rows` grid; each row is a chain left to right, the first column a chain downward. */
function graph(cols: number, rows: number): J {
  const nodes = range(rows).flatMap((r) => range(cols).map((c) => node(`g${r}c${c}`, r * cols + c + 1, { col: c, row: r })))
  const edges = [...range(rows).flatMap((r) => range(cols - 1).map((c) => edge(`g${r}c${c}`, `g${r}c${c + 1}`))), ...range(rows - 1).map((r) => edge(`g${r}c0`, `g${r + 1}c0`))]
  return { family: "graph", nodes, edges }
}

/** Graph with `zones` containers side by side: column c holds two nodes (rows 0, 1) in container c. */
function graphZones(zones: number): J {
  const s = graph(zones, 2)
  return { ...s, zones: range(zones).map((c) => ({ id: `z${c}`, label: `Wadah ${c + 1}`, members: [`g0c${c}`, `g1c${c}`] })) }
}

/** Contract bound of nodes per diagram (FIGURE_BOUNDS.diagramNodes); a scan never asks for more. */
export const NODE_BOUND = 24

/** Every dimension of the table, in print order. `max` keeps each scan inside the 24-node contract bound. */
export const DIMENSIONS: readonly Dimension[] = [
  { key: "layered.perTier", family: "layered", varies: "simpul per tingkat", fixed: "2 tingkat", start: 1, max: 12, spec: (n) => tiered("layered", 2, n) },
  { key: "layered.tiers", family: "layered", varies: "tingkat", fixed: "2 simpul per tingkat", start: 2, max: 12, spec: (n) => tiered("layered", n, 2) },
  { key: "layered.zones", family: "layered", varies: "wadah berdampingan", fixed: "tiap wadah 2 simpul (1 per tingkat, 2 tingkat)", start: 1, max: 12, spec: (n) => tieredZones("layered", n) },
  { key: "topology.perTier", family: "topology", varies: "simpul per tingkat", fixed: "2 tingkat", start: 1, max: 12, spec: (n) => tiered("topology", 2, n) },
  { key: "topology.tiers", family: "topology", varies: "tingkat", fixed: "2 simpul per tingkat", start: 2, max: 12, spec: (n) => tiered("topology", n, 2) },
  { key: "topology.zones", family: "topology", varies: "wadah berdampingan", fixed: "tiap wadah 2 simpul (1 per tingkat, 2 tingkat)", start: 1, max: 12, spec: (n) => tieredZones("topology", n) },
  { key: "stack.perTier", family: "stack", varies: "simpul per lapis", fixed: "2 lapis", start: 1, max: 12, spec: (n) => tiered("stack", 2, n) },
  { key: "stack.tiers", family: "stack", varies: "lapis", fixed: "1 simpul per lapis", start: 2, max: 24, spec: (n) => tiered("stack", n, 1) },
  { key: "flow.chain", family: "flow", varies: "simpul berantai (tanpa direction)", fixed: "satu rantai", start: 2, max: 24, spec: (n) => flowChain(n) },
  { key: "flow.TB.perRank", family: "flow", varies: "simpul per peringkat (direction TB)", fixed: "2 peringkat", start: 1, max: 12, spec: (n) => flowRanked("TB", 2, n) },
  { key: "flow.TB.ranks", family: "flow", varies: "peringkat (direction TB)", fixed: "1 simpul per peringkat", start: 2, max: 24, spec: (n) => flowRanked("TB", n, 1) },
  { key: "flow.LR.ranks", family: "flow", varies: "peringkat (direction LR)", fixed: "1 simpul per peringkat", start: 2, max: 24, spec: (n) => flowRanked("LR", n, 1) },
  { key: "flow.LR.perRank", family: "flow", varies: "simpul per peringkat (direction LR)", fixed: "2 peringkat", start: 1, max: 12, spec: (n) => flowRanked("LR", 2, n) },
  { key: "swimlane.perLane", family: "swimlane", varies: "simpul per lajur", fixed: "2 lajur", start: 1, max: 12, spec: (n) => swimlane(2, n) },
  { key: "swimlane.lanes", family: "swimlane", varies: "lajur", fixed: "2 simpul per lajur", start: 1, max: 12, spec: (n) => swimlane(n, 2) },
  { key: "swimlane.oneLane", family: "swimlane", varies: "simpul berantai dalam satu lajur", fixed: "1 lajur", start: 2, max: 12, spec: (n) => swimlane(1, n) },
  { key: "sequence.lifelines", family: "sequence", varies: "garis hidup", fixed: "4 pesan", start: 2, max: 24, spec: (n) => sequence(n, 4) },
  { key: "sequence.messages", family: "sequence", varies: "pesan", fixed: "3 garis hidup", start: 1, max: 48, spec: (n) => sequence(3, n) },
  { key: "sld.branches", family: "sld", varies: "cabang (simpul bukan rel) pada satu rel", fixed: "1 rel bus", start: 1, max: 12, spec: (n) => sld(n) },
  { key: "rack.devices", family: "rack", varies: "perangkat 1U", fixed: "satu rak, tanpa konektor", start: 1, max: 24, spec: (n) => rack(n, false) },
  { key: "rack.devicesUplink", family: "rack", varies: "perangkat 1U", fixed: "satu rak, 1 konektor antara dua perangkat pertama", start: 2, max: 24, spec: (n) => rack(n, true) },
  { key: "graph.cols", family: "graph", varies: "kolom", fixed: "1 baris", start: 1, max: 12, spec: (n) => graph(n, 1) },
  { key: "graph.rows", family: "graph", varies: "baris", fixed: "2 kolom", start: 1, max: 12, spec: (n) => graph(2, n) },
  { key: "graph.zones", family: "graph", varies: "wadah berdampingan", fixed: "tiap wadah 1 kolom, 2 baris", start: 1, max: 12, spec: (n) => graphZones(n) },
]

// ---------------------------------------------------------------------------------------------- the product path

export interface Rendered {
  outcome: ProbeOutcome
  /** SVG of the document render (null when refused). */
  svg: string | null
  /** The error the document render recorded for the figure (null when it rendered). */
  error: unknown
}

export interface Harness {
  widthMm: (w: Width) => number
  /** Render one v2 diagram spec at a width through both product paths. */
  probe: (spec: J, width: Width, opts?: BlockText) => Promise<ProbeOutcome>
  /** Same, returning the SVG and the refusal object too. */
  render: (spec: J, width: Width, opts?: BlockText) => Promise<Rendered>
  /** The engine spec (studio.diagram/v1) compose writes for the block: what the build receives. */
  composed: (spec: J, width: Width, opts?: BlockText) => J
  /** Restores the render bridge transport. Call in afterAll. */
  dispose: () => void
}
export interface BlockText {
  caption?: string
  source?: string
}

const uniq = (xs: string[]) => [...new Set(xs)].sort()
const MSG_MAX = 600
type Issue = { checkId: string; status: string; detail?: string | null }

function refusalOf(e: unknown): PathOutcome {
  const err = e as { code?: unknown; message?: unknown; details?: unknown; name?: unknown }
  const details = (typeof err.details === "object" && err.details !== null ? err.details : {}) as J
  return {
    result: "refused",
    code: typeof err.code === "string" ? err.code : String(err.name ?? "Error"),
    ...(typeof details.checkId === "string" ? { checkId: details.checkId } : {}),
    message: String(err.message ?? e).slice(0, MSG_MAX),
    split: details.split !== undefined && details.split !== null,
  }
}

function returnedOf(size: { widthMm: number; heightMm: number }, defects: Issue[], notices: Issue[]): PathOutcome {
  return {
    result: defects.length === 0 ? "pass" : "defect",
    widthMm: size.widthMm,
    heightMm: Number(size.heightMm.toFixed(3)),
    defects: uniq(defects.map((d) => d.checkId)),
    notices: uniq(notices.map((d) => d.checkId)),
    ...(defects.length > 0 ? { firstDefect: `${defects[0].checkId}: ${defects[0].detail ?? ""}`.slice(0, MSG_MAX) } : {}),
  }
}

const samePath = (a: PathOutcome, b: PathOutcome): boolean => a.result === b.result && a.code === b.code && a.checkId === b.checkId && (a.defects ?? []).join() === (b.defects ?? []).join()

/** Build the harness once per test file (composes one synthetic document for the compose context and the template). */
export async function createHarness(): Promise<Harness> {
  const K = await import("../ported/renderers/_kit")
  const S = await import("../ported/structure/_kit")
  const { composeV2 } = await import("../../vendor/src/lib/studio/services/compose")
  const { FIGURE_WIDTH_MM } = await import("../../vendor/src/lib/studio/contract/schema/v2/common.schema")
  const preview = await import("../../src/mcp-host/local-api/routes/figure-preview-figure")
  const { buildFigures } = await import("../../vendor/src/lib/studio/services/render/figures")
  const { InlineSpecReader, createDetachedJob } = await import("../../vendor/src/lib/studio/services/render/pure/job")
  const runtime = await import("../../vendor/src/lib/studio/engine/browser/runtime")

  const slots = S.datumSlots()
  const doc = S.e1() as J
  const anchor = { type: "diagram", caption: { text: "Jangkar." }, source: { text: GENERATOR.source }, spec: flowChain(2) }
  doc.sections.content.chapters[0].sections[0].blocks = [{ type: "paragraph", text: "Paragraf sintetis sebelum figur." }, anchor]
  const { template: _t, ...sub } = doc
  const snap = composeV2({ source: S.merge(sub, undefined, { slots }).doc, skeleton: S.skeletonInput(slots), params: S.defaultParams(), assets: {} }).snapshot as unknown as NormDocSnapshot
  const tpl: ResolvedTemplate = await K.canonicalTemplate()
  const near = (snap.blocks as Array<NormBlock & { pid?: string; slotKey?: string }>).find((b) => b.type === "diagram")
  if (!near) throw new Error("row 36 harness: the anchor diagram block is missing from the composed snapshot")

  // Fake render bridge (no Electron in tests), as test/st1-width-in-compose and test/rel127-verify/rel127-verify-t15:
  // the raster step of buildFigures gets a blank PNG of the size it asked for; the SVG and its lint are the engine's own.
  const HELLO = { ok: true, electron: "42.3.3", chrome: "142.0.0.0", partition: "datum-render", sandbox: true, contextIsolation: true, nodeIntegration: false, javascriptContent: false, network: "blocked", fonts: 20, scripts: ["studio.measure"] }
  const pngs = new Map<string, Uint8Array>()
  const pngOf = (w: number, hh: number): Uint8Array => {
    const k = `${w}x${hh}`
    if (!pngs.has(k)) pngs.set(k, K.makePng(w, hh))
    return pngs.get(k) as Uint8Array
  }
  runtime.setRenderBridgeTransport((async (req: J) => {
    if (req.op === "hello") return HELLO
    if (req.op === "png") {
      writeFileSync(String(req.dst), pngOf(Number(req.width), Number(req.height)))
      return { ok: true, electron: "42.3.3", dst: req.dst, width: req.width, height: req.height }
    }
    return { ok: false, code: "UNKNOWN_OP", message: "?" }
  }) as never)

  const blockOf = (spec: J, width: Width, opts?: BlockText) => ({ type: "diagram", width, caption: { text: opts?.caption ?? GENERATOR.caption }, source: { text: opts?.source ?? GENERATOR.source }, spec })
  const inlineOf = (block: J) => preview.composeInlineBlock(snap as never, block as never, { pid: near.pid ?? near.blockId, slotKey: near.slotKey, artifactLabel: near.artifactLabel, address: near.address })
  const composed: Harness["composed"] = (spec, width, opts) => structuredClone((inlineOf(blockOf(spec, width, opts)).content as J).spec) as J

  /** R: the document render of one block. */
  const documentRender = async (inline: NormBlock): Promise<{ path: PathOutcome; svg: string | null; error: unknown }> => {
    const job = createDetachedJob(["HTML"]) as J
    let recorded: unknown = null
    let recordedText = ""
    const addError = job.addError.bind(job)
    job.addError = (code: string, message: string, format?: unknown, err?: unknown) => {
      if (recorded === null) {
        recorded = err ?? new Error(message)
        recordedText = `${code}: ${message}`
      }
      return addError(code, message, format, err)
    }
    const built = await buildFigures({ snapshot: { ...snap, blocks: [inline] } as never, tpl, tier: "NOTA", job: job as never, reader: new InlineSpecReader({}) })
    if (recorded !== null) {
      const r = refusalOf(recorded)
      return { path: recordedText.includes("raster failed") ? { ...r, message: recordedText.slice(0, MSG_MAX) } : r, svg: null, error: recorded }
    }
    const r = built.svgs[0] as unknown as { svg: string; widthMm: number; heightMm: number; report: { issues: Issue[]; geometry?: unknown[] } }
    const geometry = (Array.isArray(r.report.geometry) ? r.report.geometry : []).filter((g): g is Issue => typeof g === "object" && g !== null && typeof (g as J).checkId === "string")
    const split = preview.splitPreviewIssues([...r.report.issues, ...geometry].filter((i) => i.status !== "PASS"))
    return { path: returnedOf(r, split.defects, split.notices), svg: r.svg, error: null }
  }

  /** P: the preview (machine gate) of the same block. */
  const previewRender = async (inline: NormBlock): Promise<PathOutcome> => {
    try {
      const r = await preview.renderFigure(inline, tpl, { inline: true, withSvg: false, lang: GENERATOR.language })
      return returnedOf(r.size, r.defects as Issue[], r.notices as Issue[])
    } catch (e) {
      return refusalOf(e)
    }
  }

  const render: Harness["render"] = async (spec, width, opts) => {
    let inline: NormBlock
    try {
      inline = inlineOf(blockOf(spec, width, opts))
    } catch (e) {
      return { outcome: refusalOf(e), svg: null, error: e }
    }
    const doc = await documentRender(inline)
    const pre = await previewRender(inline)
    return { outcome: samePath(doc.path, pre) ? doc.path : { ...doc.path, preview: pre }, svg: doc.svg, error: doc.error }
  }
  return { widthMm: (w) => FIGURE_WIDTH_MM[w], composed, probe: async (spec, width, opts) => (await render(spec, width, opts)).outcome, render, dispose: () => runtime.setRenderBridgeTransport(null) }
}

// ---------------------------------------------------------------------------------------------- the scan

/** Sizes probed past the first failure, to see whether a larger size passes again. */
export const SCAN_PAST_FAILURE = 3

async function scan(h: Harness, d: Dimension, width: Width): Promise<Cell> {
  let limit = 0
  let renderLimit = 0
  let renderOpen = true
  let atLimit: ProbeOutcome | null = null
  let above: ProbeOutcome | null = null
  let aboveSize: number | null = null
  const alsoPass: number[] = []
  let n = d.start
  for (; n <= d.max; n++) {
    const o = await h.probe(d.spec(n), width)
    if (renderOpen && o.result === "pass") renderLimit = n
    else renderOpen = false
    if (above === null) {
      if (passes(o)) {
        limit = n
        atLimit = o
        continue
      }
      above = o
      aboveSize = n
    } else if (passes(o)) alsoPass.push(n)
    if (aboveSize !== null && n >= aboveSize + SCAN_PAST_FAILURE) break
  }
  return { width, widthMm: h.widthMm(width), limit, renderLimit, capped: above === null, atLimit, aboveSize, above, alsoPass, scannedTo: Math.min(n, d.max) }
}

export const TABLE_COMMENT =
  "Generated by test/st1-capacity-table/capacity-harness.ts (Swarm 1.3.3 row 36). Do not edit by hand: the test regenerates this table from engine renders and compares. To accept an engine change: ROW36_WRITE=1 bun test test/st1-capacity-table/row36-capacity-table.test.ts"

export const TABLE_PATH =
  "v2 diagram block (width text|full) -> composeInlineBlock -> R: buildFigures (document render) and P: renderFigure (preview, the machine gate); pass = both return with no defect; `preview` is recorded where P differs from R"

export async function generateCapacityTable(h: Harness, dims: readonly Dimension[] = DIMENSIONS): Promise<CapacityTable> {
  const rows: CapacityRow[] = []
  for (const d of dims) {
    const cells: Cell[] = []
    for (const w of WIDTHS) cells.push(await scan(h, d, w))
    rows.push({ key: d.key, family: d.family, varies: d.varies, fixed: d.fixed, start: d.start, max: d.max, cells })
  }
  return { generator: GENERATOR, path: TABLE_PATH, rows }
}

export const DATA_FILE = path.resolve(import.meta.dir, "capacity-table.json")
export const FIXTURE_FILE = path.resolve(import.meta.dir, "gambar-16-6.fixture.json")
export const readJson = (file: string): J => JSON.parse(readFileSync(file, "utf8")) as J

const pathText = (p: PathOutcome): string => (p.result === "refused" ? `${p.code}${p.checkId ? `/${p.checkId}` : ""}` : p.result === "defect" ? (p.defects ?? []).join(",") : "lolos")

/** What happens one step above the limit, in one phrase. */
export function aboveText(c: Cell): string {
  if (c.above === null) return "-"
  const r = pathText(c.above)
  return `${c.aboveSize}: ${c.above.preview ? `render ${r}; pratinjau ${pathText(c.above.preview)}` : r}`
}

/** One line per dimension, for the report and the guide: per width the limit and what happens one step above. */
export function summaryLines(t: CapacityTable): string[] {
  const cellText = (c: Cell) => {
    const lim = `${c.capped ? ">= " : ""}${c.limit}${c.renderLimit !== c.limit ? ` (render ${c.renderLimit})` : ""}${c.alsoPass.length ? ` (juga ${c.alsoPass.join(", ")})` : ""}`
    return `${lim} | ${aboveText(c)}`
  }
  return t.rows.map((r) => `| ${r.key} | ${r.varies} | ${r.fixed} | ${r.cells.map(cellText).join(" | ")} |`)
}

// ---------------------------------------------------------------------------------------------- Gambar 16.6 (R8)

/**
 * Deviations from the manual's figure that the engine's spec rules force before capacity can be measured at all.
 * Each is applied in turn; the outcome before it is recorded, so the data file shows why it was needed.
 */
export const G166_DEVIATIONS = {
  D1: "the one connector the manual prints without a label (WAN edge -> FED-01) gets the label 'video' (its key entry)",
  D2: "five line styles become four: 'evidence' (dash-dot, one connector) is drawn with the 'control/API' style (dashed, one connector)",
  D3: "the WAN container, which holds no node on the sheet, is left out (three containers remain); its note stays as a figure note",
  D4: "the CORE label (86 characters on one line in the manual) is shortened to 'CORE-01 / CORE-02 · L3 stack' with sub 'VLAN 110/120/10 · MSTP + VRRP'",
} as const
export type G166Deviation = keyof typeof G166_DEVIATIONS

const G166_KIND: Readonly<Record<string, string>> = { solid: "data", dashed: "control", dotted: "sync", accent: "accent", "dash-dot": "verify" }
export const G166_FAMILIES = ["topology", "layered", "graph"] as const
export type G166Family = (typeof G166_FAMILIES)[number]

/** Maps the transcription to a v2 diagram spec: rows of the sheet are tiers (topology, layered) or col/row (graph). */
export function gambar166Spec(fx: J, family: G166Family, dev: readonly G166Deviation[]): J {
  const has = (d: G166Deviation) => dev.includes(d)
  const cls = (n: J) => (family === "graph" ? { col: n.col, row: n.row } : { tier: n.row })
  const nodes = (fx.nodes as J[]).map((n) =>
    has("D4") && n.id === "core"
      ? { id: n.id, label: "CORE-01 / CORE-02 · L3 stack", sub: "VLAN 110/120/10 · MSTP + VRRP", class: cls(n) }
      : { id: n.id, label: n.label, ...(n.sub ? { sub: n.sub } : {}), ...(n.shape ? { shape: n.shape } : {}), class: cls(n) },
  )
  const kindOf = (style: string) => (has("D2") && style === "dash-dot" ? "control" : G166_KIND[style])
  // The manual prints the medium (OS2 2F) and the load as two texts on the uplinks; an edge has one label.
  const edges = (fx.edges as J[]).map((e) => ({ from: e.from, to: e.to, kind: kindOf(e.style), label: e.label === "" ? (has("D1") ? "video" : "") : e.medium ? `${e.medium} · ${e.label}` : e.label }))
  const zones = (fx.containers as J[])
    .map((c) => ({ id: c.id, label: c.label, members: (fx.nodes as J[]).filter((n) => n.container === c.id).map((n) => n.id) }))
    .filter((z) => !has("D3") || z.members.length > 0)
  const legend = has("D2")
    ? ["solid video", "dashed control/API, evidence", "dotted standby / logs", "aksen WAN subject path"]
    : (fx.key as J[]).map((k) => `${k.style === "accent" ? "aksen" : k.style} ${k.text}`)
  const notes = (fx.containers as J[]).filter((c) => c.note).map((c) => c.note as string)
  return { family, nodes, edges, zones, legend, notes }
}

export interface G166Case {
  name: string
  family: G166Family
  deviations: G166Deviation[]
  sheets: number
  /** One outcome per sheet, in order. */
  outcomes: ProbeOutcome[]
  /** For a split: the cut the skeleton of row 51 chose. */
  split?: { axis: string; pairs: Array<{ key: string; from: string; to: string }>; nodesPerPart: number[] } | { absent: true }
}

export interface G166Result {
  fixture: { nodes: number; containers: number; edges: number }
  width: Width
  deviations: typeof G166_DEVIATIONS
  cases: G166Case[]
  /** True when some case renders the whole figure in at most two sheets with no refusal and no defect on both paths. */
  passesInAtMostTwoSheets: boolean
  /** True when some such case uses the manual's content unchanged (no deviation). */
  passesUnchanged: boolean
}

const PART_FIELDS = ["zones", "legend", "notes", "tiers", "direction"] as const
const G166_PART_IDS = ["g16-6-a", "g16-6-b"] as const

/** Renders the acceptance figure at `full`: step by step through the forced deviations, then per family, then split. */
export async function generateGambar166(h: Harness, fx: J): Promise<G166Result> {
  const { splitSkeletonOf } = await import("../../vendor/src/lib/studio/engine/diagram/build/capacity")
  const text = { caption: fx.caption as string, source: fx.sourceLine as string }
  const cases: G166Case[] = []
  const one = async (name: string, family: G166Family, deviations: G166Deviation[]) => {
    cases.push({ name, family, deviations, sheets: 1, outcomes: [await h.probe(gambar166Spec(fx, family, deviations), "full", text)] })
  }
  const split = async (name: string, family: G166Family, deviations: G166Deviation[]) => {
    const sk = splitSkeletonOf(h.composed(gambar166Spec(fx, family, deviations), "full", text) as never) as J | undefined
    if (!sk) {
      cases.push({ name, family, deviations, sheets: 2, outcomes: [], split: { absent: true } })
      return
    }
    const outcomes: ProbeOutcome[] = []
    for (const [i, part] of (sk.specs as J[]).entries()) {
      // The agent's step from the row 51 guide line: give both blocks an id and fill the two placeholders.
      const filled = JSON.parse(JSON.stringify(part).replaceAll(sk.placeholders[0], G166_PART_IDS[0]).replaceAll(sk.placeholders[1], G166_PART_IDS[1])) as J
      const v2: J = { family: filled.family, nodes: filled.nodes, edges: filled.edges }
      for (const k of PART_FIELDS) if (filled[k] !== undefined) v2[k] = filled[k]
      outcomes.push(await h.probe(v2, "full", { caption: `Polres–Polda VMS architecture, part ${i + 1} of 2.`, source: text.source }))
    }
    cases.push({
      name,
      family,
      deviations,
      sheets: 2,
      outcomes,
      split: { axis: String(sk.axis), pairs: (sk.pairs as J[]).map((p) => ({ key: p.key, from: p.from, to: p.to })), nodesPerPart: (sk.specs as J[]).map((s) => s.nodes.length) },
    })
  }
  await one("as transcribed", "topology", [])
  await one("D1", "topology", ["D1"])
  await one("D1 + D2", "topology", ["D1", "D2"])
  for (const f of G166_FAMILIES) await one(`one sheet, ${f}, D1-D3`, f, ["D1", "D2", "D3"])
  for (const f of G166_FAMILIES) await split(`two sheets (row 51 skeleton), ${f}, D1-D3`, f, ["D1", "D2", "D3"])
  for (const f of G166_FAMILIES) await one(`one sheet, ${f}, D1-D4`, f, ["D1", "D2", "D3", "D4"])
  for (const f of G166_FAMILIES) await split(`two sheets (row 51 skeleton), ${f}, D1-D4`, f, ["D1", "D2", "D3", "D4"])
  const clean = (c: G166Case) => c.outcomes.length === c.sheets && c.outcomes.every(passes)
  return {
    fixture: { nodes: (fx.nodes as J[]).length, containers: (fx.containers as J[]).length, edges: (fx.edges as J[]).length },
    width: "full",
    deviations: G166_DEVIATIONS,
    cases,
    passesInAtMostTwoSheets: cases.some(clean),
    passesUnchanged: cases.some((c) => clean(c) && c.deviations.length === 0),
  }
}

export interface DataFile {
  $comment: string
  capacity: CapacityTable
  gambar16_6: G166Result
}

export async function generateDataFile(h: Harness): Promise<DataFile> {
  return { $comment: TABLE_COMMENT, capacity: await generateCapacityTable(h), gambar16_6: await generateGambar166(h, readJson(FIXTURE_FILE)) }
}

/** Stable text form of the data file (what is written and what is compared). */
export const serialise = (d: DataFile): string => `${JSON.stringify(d, null, 2)}\n`
