// Swarm 1.3.3 row 50 (ST-4; register 03 sections 2, 6, 7; contract row 26). Off-page connectors are paired across
// the figures of a document at render, and both labels are written by the engine from the real figure numbers.
//
// Replay R5 (research/05_replay_inventory.md): u1 Gambar 2.1 and 2.2, byte copies in ./fixtures. The two authored
// labels were "ke Gambar 2 · FW-01" and "dari Gambar 1 · FW-01" (the figures are 2.1 and 2.2) and the document
// rendered. Here the same two blocks sit in chapter 2 of a synthetic document, so they are numbered 2.1 and 2.2.
//
// Pure: no store, no port; the raster step runs against a fake render bridge (as st1-width-in-compose).
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { NormBlock, NormDocSnapshot, ResolvedTemplate } from "../../vendor/src/lib/studio/contract"

type J = Record<string, any>
const L = path.resolve(import.meta.dir, "..", "..", "vendor", "src", "lib", "studio")
const K = await import("../ported/renderers/_kit")
const S = await import("../ported/structure/_kit")
const { composeV2 } = await import("../../vendor/src/lib/studio/services/compose")
const { renderSnapshot } = await import("../../vendor/src/lib/studio/services/render/pure/render")
const { applyRenderScope } = await import("../../vendor/src/lib/studio/services/render/pure/scope")
const P = await import("../../vendor/src/lib/studio/services/render/offpage-pairs")
const runtime = await import(path.join(L, "engine", "browser", "runtime.ts"))

const fixture = (name: string): J => JSON.parse(readFileSync(path.join(import.meta.dir, "fixtures", name), "utf8")) as J
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const A = "gbr-situs"
const B = "gbr-wan"
const KEY = "FW-01"

/** The R5 blocks with explicit block ids; `ref` only when asked. */
function r5(refs?: { a?: J | null; b?: J | null }): [J, J] {
  const a: J = { ...clone(fixture("r5_u1_gambar_2_1.json")), id: A }
  const b: J = { ...clone(fixture("r5_u1_gambar_2_2.json")), id: B }
  const ra = refs?.a === undefined ? (refs ? { figure: B, key: KEY } : null) : refs.a
  const rb = refs?.b === undefined ? (refs ? { figure: A, key: KEY } : null) : refs.b
  if (ra) a.spec.nodes.find((n: J) => n.id === "offp").ref = ra
  if (rb) b.spec.nodes.find((n: J) => n.id === "offp2").ref = rb
  return [a, b]
}

const t = (text: string) => ({ text })
const small = (id: string, caption = "Alur kecil sintetis."): J => ({
  type: "diagram",
  id,
  caption: t(caption),
  source: t("Sumber sintetis uji."),
  spec: {
    family: "layered",
    labels_verified: true,
    nodes: [
      { id: "a", label: "Alfa", shape: "box", class: { tier: 1 } },
      { id: "b", label: "Bravo", shape: "box", class: { tier: 2 } },
    ],
    edges: [{ from: "a", to: "b", kind: "data", label: "uji" }],
  },
})

/** Chapter 2 holds `blocks2`; chapter 1 optionally `blocks1`. */
function compose(blocks2: J[], blocks1?: J[], meta?: J): NormDocSnapshot {
  const doc = S.e1()
  if (meta) Object.assign(doc.meta, meta)
  if (blocks1) doc.sections.content.chapters[0].sections[0].blocks = [{ type: "paragraph", text: "Paragraf bab satu." }, ...blocks1]
  doc.sections.content.chapters[1].sections[0].blocks = [{ type: "paragraph", id: "par-awal", text: "Paragraf sebelum gambar." }, ...blocks2]
  const slots = S.datumSlots()
  const { template: _t, ...sub } = doc
  return composeV2({ source: S.merge(sub, undefined, { slots }).doc, skeleton: S.skeletonInput(slots), params: S.defaultParams() }).snapshot as unknown as NormDocSnapshot
}

const blockOf = (s: NormDocSnapshot, id: string): NormBlock => s.blocks.find((b) => b.blockId === id) as NormBlock
const nodeOf = (s: NormDocSnapshot, id: string, node: string): J => ((blockOf(s, id).content as J).spec.nodes as J[]).find((n) => n.id === node) as J
const svgText = (svg: string): string => svg.replace(/<[^>]+>/g, " ").replace(/&#183;|&#xB7;|&middot;/gi, "·").replace(/\s+/g, " ")

// Fake render bridge (no Electron), as test/st1-width-in-compose.
const HELLO = { ok: true, electron: "42.3.3", chrome: "142.0.0.0", partition: "datum-render", sandbox: true, contextIsolation: true, nodeIntegration: false, javascriptContent: false, network: "blocked", fonts: 20, scripts: ["studio.measure"] }
const fakeBridge = async (req: J) => {
  if (req.op === "hello") return HELLO
  if (req.op === "png") {
    writeFileSync(String(req.dst), K.makePng(Number(req.width), Number(req.height)))
    return { ok: true, electron: "42.3.3", dst: req.dst, width: req.width, height: req.height }
  }
  return { ok: false, code: "UNKNOWN_OP", message: "?" }
}

let tpl: ResolvedTemplate
beforeAll(async () => {
  tpl = await K.canonicalTemplate()
  runtime.setRenderBridgeTransport(fakeBridge)
})
afterAll(() => runtime.setRenderBridgeTransport(null))

const render = (snap: NormDocSnapshot, extra: J = {}) => renderSnapshot(snap as never, tpl, { formats: ["HTML", "SVG"], measureLayout: false, ...extra })

describe("row 50, replay R5: u1 Gambar 2.1 and 2.2", () => {
  test("the fixture is the replay pair: two off-page nodes, different labels, no ref, numbered 2.1 and 2.2", () => {
    const snap = compose(r5())
    expect(snap.numbering[A]).toBe("Gambar 2.1")
    expect(snap.numbering[B]).toBe("Gambar 2.2")
    expect(nodeOf(snap, A, "offp").label).toBe("ke Gambar 2 · FW-01")
    expect(nodeOf(snap, B, "offp2").label).toBe("dari Gambar 1 · FW-01")
    expect(nodeOf(snap, A, "offp").ref).toBeUndefined()
  })

  test("as authored (differing labels, no ref) the document render is refused: no file, OFFPAGE_UNPAIRED for both figures", async () => {
    const r = await render(compose(r5()))
    expect(r.status).toBe("FAILED")
    expect(r.files).toEqual([])
    const msgs = r.errors.map((e) => e.message)
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toStartWith(`OFFPAGE_UNPAIRED: Gambar 2.1 (blok ${A}), simpul "offp"`)
    expect(msgs[1]).toStartWith(`OFFPAGE_UNPAIRED: Gambar 2.2 (blok ${B}), simpul "offp2"`)
    // The message shows the ref to add, with this figure's block id for the twin.
    expect(msgs[0]).toContain(`"ref": {"figure": "<id blok diagram pasangan>", "key": "<kunci sambungan>"}`)
    expect(msgs[0]).toContain(`"ref": {"figure": "${A}", "key": "<kunci yang sama>"}`)
    // Reachable in the lint report without a registry row: FAIL rows, release FAIL.
    const rows = (r.lint?.checks ?? []).filter((c) => c.checkId === "OFFPAGE_UNPAIRED")
    expect(rows.map((c) => c.status)).toEqual(["FAIL", "FAIL"])
    expect(r.lint?.releaseStatus).toBe("FAIL")
  }, 120_000)

  test("with ref on both ends the render passes and both labels are engine-made from the real numbers", async () => {
    const snap = compose(r5({}))
    const r = await render(snap)
    expect(r.errors).toEqual([])
    expect(r.failed).toEqual([])
    const svgs = r.files.filter((f) => f.format === "SVG")
    expect(svgs.map((f) => f.figureLabel)).toEqual(["Gambar 2.1", "Gambar 2.2"])
    const first = svgText(String(svgs[0].data))
    const second = svgText(String(svgs[1].data))
    expect(first).toContain("ke Gambar 2.2 · FW-01")
    expect(second).toContain("dari Gambar 2.1 · FW-01")
    // The authored texts are gone from the drawings.
    expect(first).not.toContain("ke Gambar 2 ·")
    expect(second).not.toContain("dari Gambar 1 ·")
    // The replacement is noted in the job log, once per end.
    const notes = r.log.entries.filter((e) => e.code === "OFFPAGE_LABEL_GENERATED").map((e) => e.message)
    expect(notes).toEqual([
      `off-page connector label generated: Gambar 2.1 node offp: "ke Gambar 2 · FW-01" -> "ke Gambar 2.2 · FW-01"`,
      `off-page connector label generated: Gambar 2.2 node offp2: "dari Gambar 1 · FW-01" -> "dari Gambar 2.1 · FW-01"`,
    ])
    const rows = (r.lint?.checks ?? []).filter((c) => c.checkId === "OFFPAGE_UNPAIRED")
    expect(rows).toEqual([{ checkId: "OFFPAGE_UNPAIRED", status: "PASS", detail: "1 pasang penghubung luar-halaman berpasangan; label dibangkitkan mesin dari nomor gambar" }])
    // The stored snapshot is not written.
    expect(nodeOf(snap, A, "offp").label).toBe("ke Gambar 2 · FW-01")
  }, 120_000)

  test("the two labels have one form: <arah> Gambar <nomor gambar lain> · <kunci>", () => {
    const c = P.checkOffpagePairs(compose(r5({})))
    const a = nodeOf(c.snapshot, A, "offp").label as string
    const b = nodeOf(c.snapshot, B, "offp2").label as string
    const form = /^(ke|dari) Gambar (\d+\.\d+) · (.+)$/
    expect(form.exec(a)?.slice(1)).toEqual(["ke", "2.2", KEY])
    expect(form.exec(b)?.slice(1)).toEqual(["dari", "2.1", KEY])
    expect(c.pairs).toBe(1)
    expect(c.refusals).toEqual([])
  })

  test("renumbering: a figure inserted before the pair changes both printed labels, the specs are the same", () => {
    const [a, b] = r5({})
    const before = P.checkOffpagePairs(compose([a, b]))
    const after = P.checkOffpagePairs(compose([small("gbr-sisip"), clone(a), clone(b)]))
    expect(nodeOf(before.snapshot, A, "offp").label).toBe("ke Gambar 2.2 · FW-01")
    expect(nodeOf(after.snapshot, A, "offp").label).toBe("ke Gambar 2.3 · FW-01")
    expect(nodeOf(after.snapshot, B, "offp2").label).toBe("dari Gambar 2.2 · FW-01")
  })
})

describe("row 50: refusals name both figures and the key", () => {
  test("key mismatch", async () => {
    const snap = compose(r5({ b: { figure: A, key: "FW-1" } }))
    const c = P.checkOffpagePairs(snap)
    expect(c.refusals.map((r) => [r.cause, r.figure, r.otherFigure, r.key])).toEqual([
      ["key-mismatch", "Gambar 2.1", "Gambar 2.2", "FW-01"],
      ["key-mismatch", "Gambar 2.2", "Gambar 2.1", "FW-1"],
    ])
    expect(c.refusals[0].message).toBe(
      `OFFPAGE_UNPAIRED: Gambar 2.1 (blok ${A}), simpul "offp" ref {figure: "${B}", key: "FW-01"}: Gambar 2.2 (blok ${B}) tidak punya simpul offpage dengan ref {figure: "${A}", key: "FW-01"}; kunci yang ada di sana untuk gambar ini: "FW-1". Samakan key di kedua ujung`,
    )
    expect(c.snapshot).toBe(snap)
    const r = await render(snap)
    expect(r.status).toBe("FAILED")
    expect(r.files).toEqual([])
  }, 120_000)

  test("twin missing: only one end carries ref (the other end is also refused for its missing ref)", () => {
    const c = P.checkOffpagePairs(compose(r5({ b: null })))
    expect(c.refusals.map((r) => [r.cause, r.figure, r.node])).toEqual([
      ["ref-missing", "Gambar 2.2", "offp2"],
      ["twin-missing", "Gambar 2.1", "offp"],
    ])
    expect(c.refusals[1].message).toContain(`Gambar 2.2 (blok ${B}) tidak punya simpul offpage kembaran`)
    expect(c.refusals[1].message).toContain(`ref {figure: "${A}", key: "FW-01"}`)
  })

  test("ref to a block that is not in the document", () => {
    const c = P.checkOffpagePairs(compose(r5({ a: { figure: "gbr-tidak-ada", key: KEY } })))
    const r = c.refusals.find((x) => x.blockId === A)
    expect(r?.cause).toBe("figure-missing")
    expect(r?.message).toContain(`"gbr-tidak-ada" bukan id blok diagram di dokumen ini`)
    expect(r?.message).toContain(`Gambar 2.1 (blok ${A})`)
    expect(r?.key).toBe(KEY)
    // The other end points at A, which has no node pointing back with that key.
    expect(c.refusals.find((x) => x.blockId === B)?.cause).toBe("twin-missing")
  })

  test("ref to a block that is not a diagram, and ref to the figure itself", () => {
    const notDiagram = P.checkOffpagePairs(compose(r5({ a: { figure: "par-awal", key: KEY } }))).refusals.find((x) => x.blockId === A)
    expect(notDiagram?.cause).toBe("figure-not-diagram")
    expect(notDiagram?.message).toContain(`blok "par-awal" adalah paragraph, bukan diagram`)
    const self = P.checkOffpagePairs(compose(r5({ a: { figure: A, key: KEY } }))).refusals.find((x) => x.blockId === A)
    expect(self?.cause).toBe("figure-self")
  })

  test("a figure without a number cannot be named: refused", () => {
    const snap = compose(r5({}))
    const bare = { ...snap, numbering: { ...snap.numbering } }
    delete bare.numbering[B]
    const c = P.checkOffpagePairs(bare)
    expect(c.refusals.map((r) => r.cause)).toEqual(["figure-unnumbered", "figure-unnumbered"])
    expect(c.refusals[0].message).toContain(`blok "${B}" tidak bernomor`)
  })

  test("one key on two nodes of the same figure pair", () => {
    const [a, b] = r5({})
    b.spec.nodes.push({ id: "offp3", label: "lagi", shape: "offpage", class: { tier: 1 }, ref: { figure: A, key: KEY } })
    b.spec.edges.push({ from: "offp3", to: "fwc2", kind: "data", label: "uji" })
    const c = P.checkOffpagePairs(compose([a, b]))
    expect(new Set(c.refusals.map((r) => r.cause))).toEqual(new Set(["twin-duplicate"]))
    expect(c.refusals).toHaveLength(3)
    expect(c.refusals[0].message).toContain(`kunci "FW-01" dipakai lebih dari satu simpul offpage di Gambar 2.2 (blok ${B})`)
  })

  test("ref on a node that is not an off-page connector", () => {
    const [a, b] = r5({})
    a.spec.nodes.find((n: J) => n.id === "fw1").ref = { figure: B, key: "X1" }
    const c = P.checkOffpagePairs(compose([a, b]))
    expect(c.refusals.map((r) => [r.cause, r.node])).toEqual([["ref-on-other-shape", "fw1"]])
  })

  test("a single ref-less off-page node (old spec) is refused too", () => {
    const [a] = r5()
    const c = P.checkOffpagePairs(compose([a]))
    expect(c.refusals.map((r) => r.cause)).toEqual(["ref-missing"])
    expect(c.checks).toEqual([{ checkId: "OFFPAGE_UNPAIRED", status: "FAIL", detail: c.refusals[0].message, address: blockOf(compose([a]), A).address as string }])
  })
})

describe("row 50: labels and scope", () => {
  test("a document without off-page nodes is untouched and reports nothing", () => {
    const snap = compose([small("gbr-satu"), small("gbr-dua", "Alur kecil kedua.")])
    const c = P.checkOffpagePairs(snap)
    expect(c.snapshot).toBe(snap)
    expect(c.checks).toEqual([])
    expect(c.pairs).toBe(0)
  })

  test("direction: when both ends read as exits, document order decides (earlier ke, later dari)", () => {
    const [a, b] = r5({})
    const e = b.spec.edges.find((x: J) => x.from === "offp2")
    e.from = "fwc2"
    e.to = "offp2"
    const c = P.checkOffpagePairs(compose([a, b]))
    expect(nodeOf(c.snapshot, A, "offp").label).toBe("ke Gambar 2.2 · FW-01")
    expect(nodeOf(c.snapshot, B, "offp2").label).toBe("dari Gambar 2.1 · FW-01")
  })

  test("direction follows the connectors, not the order: a return connector from the later figure", () => {
    const [a, b] = r5({})
    const ea = a.spec.edges.find((x: J) => x.to === "offp")
    ea.from = "offp"
    ea.to = "fw1"
    const eb = b.spec.edges.find((x: J) => x.from === "offp2")
    eb.from = "fwc2"
    eb.to = "offp2"
    const c = P.checkOffpagePairs(compose([a, b]))
    expect(nodeOf(c.snapshot, A, "offp").label).toBe("dari Gambar 2.2 · FW-01")
    expect(nodeOf(c.snapshot, B, "offp2").label).toBe("ke Gambar 2.1 · FW-01")
  })

  test("EN document: to Figure / from Figure", () => {
    expect(P.offpageLabel("to", "Gambar 2.2", "S1", "EN")).toBe("to Figure 2.2 · S1")
    expect(P.offpageLabel("from", "Gambar 2.1", "S1", "EN")).toBe("from Figure 2.1 · S1")
    expect(P.offpageLabel("to", "Gambar 2.2", "S1")).toBe("ke Gambar 2.2 · S1")
    const c = P.checkOffpagePairs(compose(r5({}), undefined, { language: "EN" }))
    expect(nodeOf(c.snapshot, A, "offp").label).toBe("to Figure 2.2 · FW-01")
  })

  test("pair across chapters: whole document pairs; a chapter draft reports the pair as not checked, not as passed", () => {
    const [a, b] = r5({})
    const snap = compose([b], [a])
    expect([snap.numbering[A], snap.numbering[B]]).toEqual(["Gambar 1.1", "Gambar 2.1"])
    const whole = P.checkOffpagePairs(snap)
    expect(whole.pairs).toBe(1)
    expect(nodeOf(whole.snapshot, A, "offp").label).toBe("ke Gambar 2.1 · FW-01")

    const scope = { kind: "CHAPTER", key: "1" } as const
    const scoped = applyRenderScope(snap as never, scope).snapshot as unknown as NormDocSnapshot
    expect(scoped.blocks.some((x) => x.blockId === B)).toBe(false)
    const draft = P.checkOffpagePairs(scoped, { scope })
    expect(draft.refusals).toEqual([])
    expect(draft.unchecked).toBe(1)
    expect(draft.checks.map((c) => c.status)).toEqual(["NOT_RUN"])
    expect(draft.checks[0].detail).toStartWith("belum diperiksa: Gambar 2.1 (blok gbr-wan) di luar lingkup render")
    expect(nodeOf(draft.snapshot, A, "offp").label).toBe("ke Gambar 2.1 · FW-01")
    // The same scoped snapshot judged as a whole document is refused (the twin is not there).
    expect(P.checkOffpagePairs(scoped).refusals.map((r) => r.cause)).toEqual(["figure-missing"])
  })

  test("stand-alone preview: the pair is reported as not checked, with the register wording", () => {
    const [a] = r5({})
    expect(P.offpagePreviewNotRun(a.spec)).toEqual({ id: "OFFPAGE_UNPAIRED", kind: "rule", reason: "belum diperiksa: hanya saat render" })
    expect(P.offpagePreviewNotRun(small("x").spec)).toBeUndefined()
    expect(P.offpagePreviewNotRun(null)).toBeUndefined()
  })

  test("a block that refers to an artefact: the reader view returns the generated label, the artefact spec is not written", async () => {
    const [a, b] = r5({})
    const snap = compose([a, b])
    const stored = clone((blockOf(snap, B).content as J).spec)
    const ref = { artifactId: "art-wan" }
    const withRef: NormDocSnapshot = { ...snap, blocks: snap.blocks.map((x) => (x.blockId === B ? { ...x, content: { ...(x.content as J), spec: ref } } : x)) }
    const reader = { calls: 0, async diagram(spec: unknown) { this.calls++; return (spec as J).artifactId === "art-wan" ? stored : (spec as never) } }
    const p = await P.pairOffpageConnectors(withRef, reader)
    expect(p.refusals).toEqual([])
    expect(p.pairs).toBe(1)
    expect((blockOf(p.snapshot, B).content as J).spec).toBe(ref)
    const viaView = await p.reader.diagram(ref)
    expect((viaView.nodes as J[]).find((n) => n.id === "offp2")?.label).toBe("dari Gambar 2.1 · FW-01")
    expect(stored.nodes.find((n: J) => n.id === "offp2").label).toBe("dari Gambar 1 · FW-01")
    // An unreadable artefact is left to the figure build; the end that points at it is refused.
    const broken = await P.pairOffpageConnectors(withRef, { async diagram() { throw new Error("ARTIFACT_NOT_FOUND") } })
    expect(broken.refusals.map((r) => r.cause)).toEqual(["figure-missing"])
  })
})
