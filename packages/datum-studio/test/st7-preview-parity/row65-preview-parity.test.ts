/**
 * Swarm 1.3.3 row 65 (ST-7, B-17): the figure preview runs the render's figure-scoped lint rules and names the rules
 * only a document render can check "belum diperiksa" (`figure.notRun`), never a silent pass.
 *
 * Fixtures: synthetic diagram blocks written here (no document text), composed with the real compose `mapBlock` and
 * previewed with the real `renderFigure`, so the structure checks read the block as a document stores it.
 */
import { describe, expect, test } from "bun:test"
import { mapBlock, glyphSet } from "@/lib/studio/services/compose"
import { LINT_REGISTRY } from "@/lib/studio/registry/lint"
import { lintStructureWith } from "@/lib/studio/engine/lint/structure"
import { findFigureBlock, renderFigure } from "../../src/mcp-host/local-api/routes/figure-preview-figure"
import { PREVIEW_NOT_RUN_PREFIX, RULE_SCOPE, UNMAPPED_REASON, previewLintParity } from "../../src/mcp-host/local-api/routes/figure-preview-parity"

type J = Record<string, unknown>
const params = { "diagram.widthMm": 128 }
const tpl = { params } as never

const node = (id: string, label: string, extra: J = {}) => ({ id, label, shape: "box", class: {}, ...extra })
const edge = (from: string, to: string, label = "data") => ({ from, to, kind: "data", label })
const block = (spec: J): J => ({
  type: "diagram",
  caption: { text: "Alur uji sintetis tahun 2026." },
  source: { text: "SUMBER: uji sintetis 2026." },
  spec: {
    family: "flow",
    direction: "TB",
    classification: "BIASA",
    labels_verified: true,
    sources: ["uji sintetis"],
    nodes: [node("a", "Masuk"), node("b", "Periksa"), node("c", "Simpan")],
    edges: [edge("a", "b"), edge("b", "c")],
    ...spec,
  },
})
const docOf = (tier: string) => ({ schema: "studio.norm/v1", doc: { $schema: "studio.doc/v1", template: { slug: "t" }, meta: { tier, language: "ID", classification: "BIASA" }, chapters: [] }, blocks: [], units: [], numbering: {}, register: {} }) as never

async function preview(b: J, tier = "TERBIT") {
  const content = mapBlock(structuredClone(b) as never, "fig-65", { glyphs: glyphSet(undefined), params, classification: "BIASA", artifactLabel: "Gambar 1.1" })
  const nb = { blockId: "fig-65", pid: "fig-65", address: "1.0.1", artifactLabel: "Gambar 1.1", ordinal: 0, unitKey: "1", type: "diagram", content, textPlain: "", contentSha256: "" }
  return renderFigure(nb as never, tpl, { inline: true, withSvg: true, lang: "ID", document: docOf(tier) } as never)
}
const ids = (xs: ReadonlyArray<{ checkId: string }>) => xs.map((x) => x.checkId)

describe("row 65: render lint rules of one figure run at preview", () => {
  test("two accented nodes: DATUM-26 is a defect at preview (structure lint twin; the build counts accent edges only)", async () => {
    const f = await preview(block({ nodes: [node("a", "Masuk", { class: { accent: true } }), node("b", "Periksa", { class: { accent: true } }), node("c", "Simpan")] }))
    expect(ids(f.defects)).toContain("DATUM-26")
    expect(f.defects.find((d) => d.checkId === "DATUM-26")?.detail).toContain("2 simpul beraksen")
    expect(f.layoutIssueCount).toBeGreaterThan(0)
  })

  test("two symbol dialects by tag: DATUM-35 is a defect at preview", async () => {
    const f = await preview(block({ nodes: [node("a", "Masuk", { tag: "iec:Q1" }), node("b", "Periksa", { tag: "isa:FT-1" }), node("c", "Simpan")] }))
    expect(ids(f.defects)).toContain("DATUM-35")
  })

  test("at NOTA the render does not apply the TERBIT/SERAH structure rules, and neither does the preview", async () => {
    const f = await preview(block({ nodes: [node("a", "Masuk", { class: { accent: true } }), node("b", "Periksa", { class: { accent: true } }), node("c", "Simpan")] }), "NOTA")
    expect(ids(f.issues)).not.toContain("DATUM-26")
  })

  test("a clean figure stays clean: no defect, no layout issue; render-only rules are listed, not passed", async () => {
    const f = await preview(block({}))
    expect(f.defects).toEqual([])
    expect(f.layoutIssueCount).toBe(0)
    const notRun = (f as unknown as { notRun: Array<{ id: string; kind: string; reason: string }> }).notRun
    expect(notRun.map((n) => `${n.kind}:${n.id}`)).toEqual(expect.arrayContaining(["module:scan", "module:language", "rule:DATUM-14", "rule:DATUM-37", "rule:D22"]))
    for (const n of notRun) expect(n.reason.startsWith(PREVIEW_NOT_RUN_PREFIX)).toBe(true)
    expect(notRun.some((n) => n.id === "OFFPAGE_UNPAIRED")).toBe(false)
  })

  test("a diagram with an offpage node: off-page pairing is listed with row 50's wording", async () => {
    const f = await preview(block({ nodes: [node("a", "Masuk"), node("b", "Periksa"), { id: "c", label: "ke Gambar 2", shape: "offpage", class: {} }] }))
    const notRun = (f as unknown as { notRun: Array<{ id: string; kind: string; reason: string }> }).notRun
    expect(notRun.find((n) => n.id === "OFFPAGE_UNPAIRED")).toMatchObject({ kind: "rule", reason: "belum diperiksa: hanya saat render (butuh seluruh dokumen)", cause: "could-not-run" }) // 1.3.3 row 137: the registered rule gets the parity scope reason
  })
})

describe("row 65: the route's path (block found in the revision) carries the document's tier", () => {
  test("findFigureBlock remembers the document: TERBIT applies DATUM-26 without passing the document again", async () => {
    const b = block({ nodes: [node("a", "Masuk", { class: { accent: true } }), node("b", "Periksa", { class: { accent: true } }), node("c", "Simpan")] })
    const content = mapBlock(structuredClone(b) as never, "fig-65", { glyphs: glyphSet(undefined), params, classification: "BIASA", artifactLabel: "Gambar 1.1" })
    const nb = { blockId: "fig-65", pid: "fig-65", address: "1.0.1", artifactLabel: "Gambar 1.1", ordinal: 0, unitKey: "1", type: "diagram", content, textPlain: "", contentSha256: "" }
    const snap = { ...(docOf("TERBIT") as unknown as J), blocks: [nb] } as never
    const f = await renderFigure(findFigureBlock(snap, { pid: "fig-65" }), tpl, { inline: false, withSvg: false, lang: "ID" })
    expect(ids(f.defects)).toContain("DATUM-26")
    const nota = await renderFigure(findFigureBlock({ ...(docOf("NOTA") as unknown as J), blocks: [{ ...nb }] } as never, { pid: "fig-65" }), tpl, { inline: false, withSvg: false, lang: "ID" })
    expect(ids(nota.defects)).not.toContain("DATUM-26")
  })
})

describe("row 65: completeness against the registry", () => {
  test("every structure and render rule of the registry has a preview scope", () => {
    const unmapped = LINT_REGISTRY.filter((d) => d.module === "structure" || d.module === "render").map((d) => d.id).filter((id) => RULE_SCOPE[id] === undefined)
    expect(unmapped).toEqual([])
  })

  test("every figure-scoped render rule is either run or listed for a diagram and for a chart (none passes silently)", async () => {
    // 1.3.3 row 137: OFFPAGE_UNPAIRED is a registered structure rule, which parity lists only for a figure that holds an offpage node, so the
    // parity is built from the offpage block (not from block({})) and the loop below still covers every rule with no skip.
    const offpageBlock = block({ nodes: [node("a", "Masuk"), node("b", "Periksa"), { id: "c", label: "ke Gambar 2", shape: "offpage", class: {} }] })
    const f = await preview(offpageBlock, "SERAH")
    const content = mapBlock(structuredClone(offpageBlock) as never, "fig-65", { glyphs: glyphSet(undefined), params, classification: "BIASA", artifactLabel: "Gambar 1.1" })
    const p = previewLintParity({ block: { blockId: "fig-65", address: "1.0.1", artifactLabel: "Gambar 1.1", ordinal: 0, unitKey: "1", type: "diagram", content, textPlain: "", contentSha256: "" }, spec: (content as unknown as J).spec, svg: { svg: f.svg!, widthMm: f.size.widthMm, heightMm: f.size.heightMm, report: { issues: [], checksRun: [] } } as never, tpl, snapshot: docOf("SERAH") })
    const listed = new Set(p.notRun.filter((n) => n.kind === "rule").map((n) => n.id))
    for (const d of LINT_REGISTRY) {
      if (d.module !== "structure" && d.module !== "render") continue
      const scope = RULE_SCOPE[d.id]
      if (scope === "none" || !d.tiers.includes("SERAH")) continue
      expect([d.id, p.ran.includes(d.id) || listed.has(d.id)]).toEqual([d.id, true])
    }
    // the preview reply carries the same list
    const notRun = (f as unknown as { notRun: Array<{ id: string }> }).notRun
    for (const id of listed) expect(notRun.some((n) => n.id === id)).toBe(true)
  })

  test("a rule classed 'none' never reports into a figure block (independent of the table: run on a one-figure document)", () => {
    const b = block({ nodes: [node("a", "Masuk 1.250 unit", { class: { accent: true } }), node("b", "Periksa 12:30", { tag: "iec:Q1" }), node("c", "Simpan", { tag: "isa:F1" })] })
    b.caption = { text: "Alur 1.250 unit pukul 12:30 dengan dua ribu (2.500) lembar." }
    const content = mapBlock(structuredClone(b) as never, "fig-65", { glyphs: glyphSet(undefined), params, classification: "BIASA", artifactLabel: "Gambar 1.1" }) as unknown as J
    const doc = { $schema: "studio.doc/v1", template: { slug: "t" }, meta: { tier: "SERAH", language: "ID", classification: "BIASA" }, chapters: [{ key: "1", title: { text: "" }, intro: [{ ...content, blockId: "fig-65" }] }] }
    const none = LINT_REGISTRY.filter((d) => d.module === "structure" && RULE_SCOPE[d.id] === "none").map((d) => d.id)
    const rows = lintStructureWith({ schema: "studio.norm/v1", doc, blocks: [], units: [], numbering: {}, register: {} } as never, tpl, "SERAH", { only: none, includeOutOfTier: true })
    expect(rows.filter((r) => r.status !== "PASS" && r.status !== "NOT_RUN" && (r.pointer ?? "").startsWith("/chapters/0/intro/0")).map((r) => r.checkId)).toEqual([])
  })

  test("a rule the preview does not know yet is listed as not checked, never passed", () => {
    const fake = { ...LINT_REGISTRY.find((d) => d.id === "DATUM-26")!, id: "DATUM-99-ROW65-PROBE" }
    ;(LINT_REGISTRY as unknown as unknown[]).push(fake)
    try {
      const p = previewLintParity({ block: { blockId: "b", address: null, ordinal: 0, unitKey: "1", type: "diagram", content: {}, textPlain: "", contentSha256: "" }, spec: {}, svg: { svg: "<svg xmlns=\"http://www.w3.org/2000/svg\"/>", widthMm: 10, heightMm: 10, report: { issues: [], checksRun: [] } } as never, tpl, snapshot: docOf("SERAH") })
      expect(p.notRun.find((n) => n.id === fake.id)).toMatchObject({ kind: "rule", reason: UNMAPPED_REASON })
      expect(p.ran).not.toContain(fake.id)
    } finally {
      ;(LINT_REGISTRY as unknown as unknown[]).pop()
    }
  })

  test("the one-figure document gives the same DATUM-26 finding as the structure lint of a real document holding the block", async () => {
    const b = block({ nodes: [node("a", "Masuk", { class: { accent: true } }), node("b", "Periksa", { class: { accent: true } }), node("c", "Simpan")] })
    const content = mapBlock(structuredClone(b) as never, "fig-65", { glyphs: glyphSet(undefined), params, classification: "BIASA", artifactLabel: "Gambar 1.1" }) as unknown as J
    const para = { type: "paragraph", blockId: "p1", inline: { text: "Teks pengantar." } }
    const doc = { $schema: "studio.doc/v1", template: { slug: "t" }, meta: { tier: "TERBIT", language: "ID", classification: "BIASA" }, chapters: [{ key: "1", title: "Bab", intro: [para, { ...content, blockId: "fig-65" }] }] }
    const real = lintStructureWith({ schema: "studio.norm/v1", doc, blocks: [], units: [], numbering: {}, register: {} } as never, tpl, "TERBIT", { only: ["DATUM-26"] })
    const f = await preview(b)
    expect(f.defects.filter((d) => d.checkId === "DATUM-26").map((d) => d.detail)).toEqual(real.filter((r) => r.status === "FAIL").map((r) => r.detail ?? null))
  })
})
