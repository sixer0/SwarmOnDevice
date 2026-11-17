// Swarm 1.3.3 row 53 (ST-5): `external` set on the node itself is read like `class.external` (stroke token ink400);
// when both are present and disagree, the node-level value wins. Row 45 hook: `blockKeyRow` names an authored
// key row that is not printed because legend rows exist (`notice`), instead of dropping it silently.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const PKG = path.resolve(import.meta.dir, "..", "..")
const V = path.join(PKG, "vendor", "src", "lib", "studio")
const core = await import(path.join(V, "engine", "diagram", "core", "index.ts"))
const build = await import(path.join(V, "engine", "diagram", "build", "index.ts"))
const compose = await import(path.join(V, "services", "compose", "index.ts"))
const BCTX = { glyphs: compose.glyphSet(undefined), params: {}, classification: "TERBATAS", artifactLabel: "Gambar 1.1" }
const BLOCK = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "st3-one-key-row", "fixtures", "r3_p1_fig1_block.json"), "utf8"))

const tok = (spec: object) => core.nodeStrokeToken({ spec })

describe("nodeStrokeToken: node-level external", () => {
  test("class.external and node external give the same token", () => {
    expect(tok({ class: { external: true } })).toBe("ink400")
    expect(tok({ external: true })).toBe("ink400")
    expect(tok({})).toBe("ink700")
  })
  test("disagreement: the node-level value wins", () => {
    expect(tok({ external: false, class: { external: true } })).toBe("ink700")
    expect(tok({ external: true, class: { external: false } })).toBe("ink400")
  })
  test("accent and shape rules unchanged", () => {
    expect(tok({ external: true, class: { accent: true } })).toBe("signal")
    expect(tok({ shape: "shadowed" })).toBe("ink400")
    expect(tok({ external: false, shape: "shadowed" })).toBe("ink400")
    expect(tok({ shape: "bus" })).toBe("ink900")
  })
})

describe("SVG", () => {
  // The composed spec as the stand-alone figure reads it (same construction as row 45's test).
  const base = (): any => {
    const { keyRow: _k, ...noKey } = BLOCK
    const { keyRowOnPage: _p, ...composed } = compose.mapBlock(JSON.parse(JSON.stringify(noKey)), "p1", BCTX).spec
    return { ...composed, apparatus: "page", labels_verified: true }
  }
  const withNode = (patch: (n: any) => void): string => {
    const s = base()
    const n = s.nodes.find((x: any) => !x.class?.accent && x.shape !== "shadowed" && x.shape !== "bus") ?? s.nodes[0]
    delete n.external
    if (n.class) delete n.class.external
    patch(n)
    return build.buildDiagramSvg(s, {}).svg
  }
  test("node-level external renders the same SVG as class.external, and differs from neither", () => {
    const none = withNode(() => {})
    const viaClass = withNode((n) => { n.class = { ...(n.class ?? {}), external: true } })
    const viaNode = withNode((n) => { n.external = true })
    expect(viaNode).toBe(viaClass)
    expect(viaNode).not.toBe(none)
  })
  test("node external:false overrides class.external:true (renders as if neither)", () => {
    const none = withNode(() => {})
    const off = withNode((n) => { n.class = { ...(n.class ?? {}), external: true }; n.external = false })
    expect(off).toBe(none)
  })
})

describe("blockKeyRow notice", () => {
  const spec = { legend: ["a = satu", "b = dua"], nodes: [] }
  test("authored key row + legend rows: one notice, code KEYROW_SUPERSEDED", () => {
    const k = core.blockKeyRow(spec, "kalimat penulis")
    const notice = core.keyRowNotice(k)
    expect(k.source).toBe("legend")
    expect(k.authoredSuperseded).toBe(true)
    expect(notice?.code).toBe("KEYROW_SUPERSEDED")
    expect(notice?.message).toContain("legend")
  })
  test("no notice for legend only, authored only, neither, or an authored row equal to the legend text", () => {
    expect(core.keyRowNotice(core.blockKeyRow(spec))).toBeUndefined()
    expect(core.keyRowNotice(core.blockKeyRow({ legend: [], nodes: [] }, "kalimat"))).toBeUndefined()
    expect(core.keyRowNotice(core.blockKeyRow({ legend: [], nodes: [] }))).toBeUndefined()
    expect(core.keyRowNotice(core.blockKeyRow(spec, core.blockKeyRow(spec).text))).toBeUndefined()
  })
})
