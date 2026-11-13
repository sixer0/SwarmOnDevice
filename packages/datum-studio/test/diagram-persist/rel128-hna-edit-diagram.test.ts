// Swarm 1.2.8 row 33 (AC-HNA channel c, N8-334): studio_edit { section, append: [{ diagram }] } on a client document
// stores a DiagramV2 block equal to the fixture block; the 6 orders of the diagram keys store a deep-equal block; a bad
// spec is refused with the v2 validator's messages and nothing is written; on a work report the append names the
// client-only rule. Existing append kinds (string, rows) still land. Round trip: document_get returns the block,
// studio_figure_revise succeeds, a second get shows the revision.
// Red at BASE e1f9673772: the append is refused INVALID_ARGUMENT "append blok 1 tidak sah" (no {diagram} block kind).
// Real host over a temp store (hna-host.ts); fixture test/fixtures/syn128/hna_flow_v2.json (synthetic).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { canon, CHANGE, clone, diagramsOf, FIXTURE, newClientDoc, permutations, reorder, reviseRoundTrip, startHost, withoutId, type Host, type S } from "./hna-host"

let h: Host
beforeAll(async () => {
  h = await startHost("edit")
}, 120_000)
afterAll(async () => {
  await h?.close()
})

const append = (documentId: string, blocks: unknown[]) => h.call("studio_edit", { documentId, edits: [{ section: "Pendahuluan", append: blocks }], change: CHANGE })

// Documents are few on purpose: the host rate-limits document creation (RATE_LIMITED 429 on POST /api/studio/documents).
let doc = ""
describe("AC-HNA (c) studio_edit {section, append:[{diagram}]}", () => {
  test("stored as DiagramV2 equal to the fixture block; a string append beside it still lands (CHAR)", async () => {
    doc = await newClientDoc(h, "hna-edit")
    const r = await append(doc, ["Paragraf tambahan sintetis delta echo.", clone(FIXTURE.writeBlock)])
    console.log(`[rel128-hna-c] edit: ok=${r.ok} code=${r.code ?? "-"}`)
    expect(r.ok, r._text).not.toBe(false)
    const content = await h.content(doc)
    const ds = diagramsOf(content)
    expect(ds).toHaveLength(1)
    expect(withoutId(ds[0])).toEqual(FIXTURE.block)
    expect(JSON.stringify(content)).toContain("Paragraf tambahan sintetis delta echo.")
  }, 120_000)

  test("key order: the 6 orders of {spec, caption, source} store a deep-equal block", async () => {
    const orders = permutations(["spec", "caption", "source"])
    expect(orders).toHaveLength(6)
    const other = await newClientDoc(h, "hna-edit-orders")
    for (const [i, order] of orders.entries()) {
      const r = await append(other, [{ diagram: reorder(clone(FIXTURE.writeBlock.diagram), order) }])
      expect(r.ok, `${order.join(",")}: ${r._text}`).not.toBe(false)
      const ds = diagramsOf(await h.content(other))
      expect(ds).toHaveLength(i + 1)
      for (const d of ds) expect(canon(withoutId(d))).toBe(canon(FIXTURE.block))
    }
  }, 180_000)

  test("a bad spec is refused with the v2 validator's messages; nothing is written", async () => {
    const d = clone(FIXTURE.writeBlock)
    d.diagram.spec.nodes = "bukan-larik"
    const r = await append(doc, [d])
    expect(r.ok).toBe(false)
    expect(r.code).toBe("SCHEMA_INVALID")
    expect(r._text).toContain("/diagram/spec/nodes")
    const ds = diagramsOf(await h.content(doc))
    expect(ds).toHaveLength(1)
    expect(withoutId(ds[0])).toEqual(FIXTURE.block)
  }, 60_000)

  test("a work report refuses the {diagram} append naming the client-only rule", async () => {
    const w = await h.call("studio_write", { mission: "2026-11-14_hna", docKey: "hna-edit-report", sections: [{ heading: "Ringkasan", blocks: ["Ringkasan sintetis."] }] })
    expect(w.ok, w._text).not.toBe(false)
    const r = await h.call("studio_edit", { documentId: String(w.documentId), edits: [{ section: "Ringkasan", append: [clone(FIXTURE.writeBlock)] }], change: CHANGE })
    expect(r.ok).toBe(false)
    expect(r._text).toContain("laporan kerja tidak memuat figur; {diagram} hanya untuk dokumen klien")
  }, 60_000)

  test("round trip: document_get returns the block, studio_figure_revise succeeds, a second get shows the revision", async () => {
    await reviseRoundTrip(h, doc)
  }, 60_000)
})
