// Swarm 1.2.8 row 33 (AC-HNA channel b, N8-333): studio_write (client document, template) with a section block
// `{ diagram: { spec, caption, source } }` (N8-206) stores a DiagramV2 block equal to the fixture block; the 6 orders of
// the diagram keys store a deep-equal block; a bad spec is refused with the v2 validator's messages and nothing is
// written; spec and artifactId together or neither are refused; a work report (no template) names the client-only
// rule instead of "blok tidak dikenal". Round trip: document_get returns the block, studio_figure_revise succeeds, a
// second get shows the revision. Budget: vendor default tools/list < 30 000 B, host < 74 000 B, descriptions <= 450.
// Red at BASE e1f9673772: the block is refused INVALID_ARGUMENT by the studio_write schema (no {diagram} block kind;
// "blok tidak dikenal" in write-content.ts / write-client.ts behind it).
// Real host over a temp store (hna-host.ts); fixture test/fixtures/syn128/hna_flow_v2.json (synthetic).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { canon, clone, diagramsOf, FIXTURE, META, permutations, reorder, reviseRoundTrip, startHost, withoutId, type Host, type S } from "./hna-host"

const MISSION = "2026-11-14_hna"
let h: Host
beforeAll(async () => {
  h = await startHost("write")
}, 120_000)
afterAll(async () => {
  await h?.close()
})

const sections = (diagram: S): S[] => [
  { heading: "Pendahuluan", blocks: ["Paragraf pembuka sintetis alfa bravo charlie."] },
  { heading: "Uraian uji diagram", blocks: ["Paragraf sintetis sebelum diagram.", { diagram }] },
]
const write = (docKey: string, diagram: S) => h.call("studio_write", { mission: MISSION, docKey, template: "datum-nota", meta: META, sections: sections(diagram) })
const errText = (r: S): string => JSON.stringify(r)

let doc = ""
describe("AC-HNA (b) studio_write with a {diagram} block", () => {
  test("stored as DiagramV2 equal to the fixture block (spec untouched, caption and source as InlineV2)", async () => {
    const r = await write("hna-write", clone(FIXTURE.writeBlock.diagram))
    console.log(`[rel128-hna-b] write: ok=${r.ok} code=${r.code ?? "-"}`)
    expect(r.ok, r._text).not.toBe(false)
    doc = String(r.documentId)
    const ds = diagramsOf(await h.content(doc))
    expect(ds).toHaveLength(1)
    expect(withoutId(ds[0])).toEqual(FIXTURE.block)
  }, 120_000)

  test("key order: the 6 orders of {spec, caption, source} store a deep-equal block", async () => {
    const orders = permutations(["spec", "caption", "source"])
    expect(orders).toHaveLength(6)
    for (const order of orders) {
      const r = await write("hna-write", reorder(clone(FIXTURE.writeBlock.diagram), order))
      expect(r.ok, `${order.join(",")}: ${r._text}`).not.toBe(false)
      expect(String(r.documentId)).toBe(doc)
      const ds = diagramsOf(await h.content(doc))
      expect(ds).toHaveLength(1)
      expect(canon(withoutId(ds[0]))).toBe(canon(FIXTURE.block))
    }
  }, 180_000)

  test("a bad spec is refused with the v2 validator's messages; the stored block is unchanged", async () => {
    const d = clone(FIXTURE.writeBlock.diagram)
    d.spec.nodes = "bukan-larik"
    const r = await write("hna-write", d)
    expect(r.ok).toBe(false)
    expect(r.code).toBe("CONTENT_INVALID")
    expect(errText(r)).toContain("SCHEMA_INVALID")
    expect(errText(r)).toContain("/diagram/spec/nodes")
    const ds = diagramsOf(await h.content(doc))
    expect(withoutId(ds[0])).toEqual(FIXTURE.block)
  }, 60_000)

  test("spec XOR artifactId: both, or neither, is refused by the validator", async () => {
    const both = { ...clone(FIXTURE.writeBlock.diagram), artifactId: "cmartifact0000000000000001" }
    const neither = { caption: "Alur sintetis.", source: "Sumber sintetis uji." }
    for (const d of [both, neither]) {
      const r = await write("hna-write-xor", d)
      expect(r.ok, JSON.stringify(d).slice(0, 60)).toBe(false)
      expect(errText(r)).toContain("SCHEMA_INVALID")
    }
  }, 60_000)

  test("a work report (no template) refuses {diagram} naming the client-only rule, not 'blok tidak dikenal'", async () => {
    const r = await h.call("studio_write", { mission: MISSION, docKey: "hna-report", sections: [{ heading: "Ringkasan", blocks: ["Ringkasan sintetis.", clone(FIXTURE.writeBlock)] }] })
    expect(r.ok).toBe(false)
    expect(r.code).toBe("INVALID_ARGUMENT")
    expect(r._text).toContain("laporan kerja tidak memuat figur; {diagram} hanya untuk dokumen klien")
    expect(r._text).not.toContain("blok tidak dikenal")
  }, 60_000)

  test("round trip: document_get returns the block, studio_figure_revise succeeds, a second get shows the revision", async () => {
    await reviseRoundTrip(h, doc)
  }, 60_000)

  test("budget: vendor default tools/list < 30 000 B, host < 74 000 B, vendor descriptions <= 450", async () => {
    const hostBytes = await h.toolsBytes()
    const { connect } = await import("../ported/mcp/mcp-harness")
    const c = await connect({ env: { STUDIO_MCP_TOOLSETS: "reports,documents,query" } })
    const vendorBytes = Buffer.byteLength(JSON.stringify(await c.client.listTools()))
    const { TOOLS } = await import("../../vendor/scripts/studio/mcp/tools")
    const longest = Math.max(...(TOOLS as ReadonlyArray<{ description: string }>).map((t) => t.description.length))
    console.log(`[rel128-hna-b] tools/list vendor default ${vendorBytes} B, host ${hostBytes} B, longest vendor description ${longest}`)
    expect(vendorBytes).toBeLessThan(30_000)
    expect(hostBytes).toBeLessThan(74_000)
    expect(longest).toBeLessThanOrEqual(450)
  }, 60_000)
})
