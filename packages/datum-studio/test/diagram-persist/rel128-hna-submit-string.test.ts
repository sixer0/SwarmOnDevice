// Swarm 1.2.8 row 33 (AC-HNA channel a, N8-332; D-H8): studio_chapter_submit with `submission` sent as a JSON string
// (some clients serialise nested objects) is parsed ONCE, validated as usual and stored as the same DiagramV2 block as
// the object form; the result carries N8-205 ARGS_PARSED. A string that does not parse, a string of a string and a
// parsed non-object keep INVALID_ARGUMENT `/submission must be object`. Key order: the 6 orders of the submission keys
// ($schema first and last included) store a deep-equal block, as string and as object. Round trip: document_get
// returns the block, studio_figure_revise succeeds, a second get shows the revision.
// Red at BASE e1f9673772: the string form is refused INVALID_ARGUMENT `/submission must be object`.
// Real host over a temp store (hna-host.ts); fixture test/fixtures/syn128/hna_flow_v2.json (synthetic).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { canon, clone, diagramsOf, FIXTURE, newClientDoc, permutations, reorder, reviseRoundTrip, startHost, withoutId, type Host, type S } from "./hna-host"

let h: Host
let doc = ""
beforeAll(async () => {
  h = await startHost("submit")
  doc = await newClientDoc(h, "hna-submit")
}, 120_000)
afterAll(async () => {
  await h?.close()
})

const submission = (): S => {
  const s = clone(FIXTURE.chapter)
  return { $schema: s.$schema, target: { documentId: doc }, chapter: s.chapter }
}
const codes = (r: S): string[] => ((r.warnings ?? []) as Array<{ code: string }>).map((w) => w.code)
async function storedDiagram(): Promise<S> {
  const ds = diagramsOf(await h.content(doc))
  expect(ds).toHaveLength(1)
  return withoutId(ds[0])
}

let reference: S
describe("AC-HNA (a) studio_chapter_submit with a JSON-string submission", () => {
  test("object form (CHAR): the diagram block is stored as DiagramV2 equal to the fixture block", async () => {
    const r = await h.call("studio_chapter_submit", { submission: submission() })
    expect(r.ok, r._text).not.toBe(false)
    expect(codes(r)).not.toContain("ARGS_PARSED")
    reference = await storedDiagram()
    expect(reference).toEqual(FIXTURE.block)
  }, 60_000)

  test("string form: parsed once, stored deep-equal to the object form, ARGS_PARSED warning with the N8-205 text", async () => {
    const r = await h.call("studio_chapter_submit", { submission: JSON.stringify(submission()) })
    console.log(`[rel128-hna-a] string submit: ok=${r.ok} code=${r.code ?? "-"} warnings=${JSON.stringify(codes(r))}`)
    expect(r.ok, r._text).not.toBe(false)
    expect(codes(r)).toContain("ARGS_PARSED")
    expect(r._text).toContain("peringatan ARGS_PARSED: submission berupa teks JSON diurai satu kali; kirim submission sebagai objek")
    expect(await storedDiagram()).toEqual(reference)
  }, 60_000)

  test("key order: 6 orders of {$schema, target, chapter} as string and as object store a deep-equal block", async () => {
    const orders = permutations(["$schema", "target", "chapter"])
    expect(orders).toHaveLength(6)
    expect(orders.some((o) => o[0] === "$schema") && orders.some((o) => o[2] === "$schema")).toBe(true)
    for (const order of orders) {
      for (const form of ["string", "object"] as const) {
        const body = reorder(submission(), order)
        const r = await h.call("studio_chapter_submit", { submission: form === "string" ? JSON.stringify(body) : body })
        expect(r.ok, `${order.join(",")} ${form}: ${r._text}`).not.toBe(false)
        expect(canon(await storedDiagram())).toBe(canon(reference))
      }
    }
  }, 120_000)

  test("a string that does not parse, a string of a string and a parsed non-object keep INVALID_ARGUMENT /submission must be object", async () => {
    const good = JSON.stringify(submission())
    for (const bad of [good.slice(0, -1), JSON.stringify(good), "[1,2]", "42", "null", ""]) {
      const r = await h.call("studio_chapter_submit", { submission: bad })
      expect(r.ok, bad.slice(0, 40)).toBe(false)
      expect(r.code).toBe("INVALID_ARGUMENT")
      expect(JSON.stringify(r.error?.details ?? [])).toContain('"pointer":"/submission"')
      expect(JSON.stringify(r.error?.details ?? [])).toContain("must be object")
      expect(codes(r)).not.toContain("ARGS_PARSED")
    }
  }, 60_000)

  test("a parsed object is validated as usual: a bad diagram spec is refused by the server validator", async () => {
    const s = submission()
    s.chapter.sections[0].blocks[1].spec.nodes = "bukan-larik"
    const r = await h.call("studio_chapter_submit", { submission: JSON.stringify(s) })
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).toContain("/spec/nodes")
    expect(await storedDiagram()).toEqual(reference)
  }, 60_000)

  test("round trip: document_get returns the block, studio_figure_revise succeeds, a second get shows the revision", async () => {
    await reviseRoundTrip(h, doc)
  }, 60_000)
})
