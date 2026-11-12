// Swarm 1.2.6 row 45 (T-11 contract, SEC-23; spec masterplan/01e_spec_t11.md §3.1, §6.2-6.4, A1 schema part, A15,
// A17, A19; register N-109, N-159, N-165). The diagram spec gains `direction: "TB" | "LR"` for family flow only.
//  - schema (v1 artefact and v2 block) accepts TB/LR, refuses any other value with an enum issue at .../spec/direction;
//  - SEC-23: a non-enum value ("RL; x", "RL", "x", "lr") is refused before any ELK option is built (elkGraphFor spy = 0
//    calls), at the request schema and again in the engine (validateSpec P1-direction) for a spec that skipped it;
//  - P1-direction: direction on another family, or with per_row, refused by validateSpec and the by-construction gate;
//  - compose (v2 -> v1) and adapt-v1 (v1 -> v2) keep the field (allow-lists);
//  - A15: a flow WITHOUT direction is byte-identical to 1.2.5 (golden SVGs captured at e363918a69).
// Layout behaviour of a ranked flow is row 46's; nothing here asserts a ranked layout.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { parsePreviewBody } from "../../src/mcp-host/local-api/routes/figure-preview-request.ts"

const PKG = path.resolve(import.meta.dir, "..", "..")
const STUDIO = path.join(PKG, "vendor", "src", "lib", "studio")
const D = path.join(STUDIO, "engine", "diagram")
const build = await import(path.join(D, "build", "index.ts"))
const core = await import(path.join(D, "core", "index.ts"))
const specMod = await import(path.join(D, "core", "spec.ts"))
const elk = await import(path.join(D, "elk", "index.ts"))
const adapter = await import(path.join(D, "elk", "adapter.ts"))
const ingest = await import(path.join(STUDIO, "services", "ingest", "index.ts"))
const byc = await import(path.join(STUDIO, "services", "ingest", "by-construction.ts"))
const compose = await import(path.join(STUDIO, "services", "compose", "blocks.ts"))
const adapt = await import(path.join(STUDIO, "services", "adapt-v1", "blocks.ts"))

const json = (f: string) => JSON.parse(readFileSync(f, "utf8"))
const clone = <T>(x: T): T => structuredClone(x)
const LEGACY = json(path.join(import.meta.dir, "fixtures", "legacy_fanout_flow.json"))
/** Synthetic layered figure whose original routing has defects, so buildDiagramSvgAuto goes to ELK (row 162). */
const LARGE = json(path.join(PKG, "test", "engine-rev-a", "svg", "fixtures", "row162_large_layered.json"))
const golden = (name: string) => readFileSync(path.join(import.meta.dir, "__golden__", name), "utf8")

type Issue = { pointer: string; keyword: string; message: string; checkId?: string }
const cap = { text: "Uji." }
const src = { text: "SUMBER: uji." }
const v2spec = (over: Record<string, unknown> = {}) => ({
  family: "flow",
  nodes: [
    { id: "a", label: "Awal", class: {} },
    { id: "b", label: "Akhir", class: {} },
  ],
  edges: [{ from: "a", to: "b", kind: "control", label: "lanjut" }],
  ...over,
})
const block = (over: Record<string, unknown> = {}) => ({ type: "diagram", caption: cap, source: src, spec: v2spec(over) })
const preview = (over: Record<string, unknown>) => parsePreviewBody({ block: block(over) })
const failsOf = (issues: Array<{ checkId: string; status: string; pointer?: string; detail?: string }>, id: string) =>
  issues.filter((i) => i.checkId === id && i.status === "FAIL")

let spies: Array<{ mockRestore: () => void }> = []
afterEach(() => {
  for (const s of spies) s.mockRestore()
  spies = []
})
/** The DiagramDefect a build throws (checkId + code), or null when it built. */
const refusalOf = async (p: Promise<unknown>): Promise<{ checkId?: string; code?: string; pointer?: string } | null> => {
  try {
    await p
    return null
  } catch (e) {
    const d = e as { checkId?: string; code?: string; details?: { pointer?: string } }
    return { checkId: d.checkId, code: d.code, pointer: d.details?.pointer }
  }
}
const spyElk = () => {
  const s = spyOn(adapter, "elkGraphFor")
  spies.push(s)
  return s
}

describe("row 45 T-11 schema: direction TB/LR on the diagram spec (A1 schema part)", () => {
  for (const d of ["TB", "LR"]) {
    test(`v2 block (preview body) accepts flow + direction ${d}`, () => {
      const r = preview({ direction: d })
      expect(r.ok ? [] : r.issues).toEqual([])
      expect(r.ok).toBe(true)
    })
    test(`v1 artefact studio.diagram/v1 accepts flow + direction ${d}`, () => {
      expect(ingest.validateSchema("studio.diagram/v1", { ...clone(LEGACY), direction: d })).toEqual([])
    })
    test(`validateSpec: flow + direction ${d} has P1-direction PASS`, () => {
      const issues = core.validateSpec({ ...clone(LEGACY), direction: d }, { release: false })
      expect(failsOf(issues, "P1-direction")).toEqual([])
      expect(issues.some((i: { checkId: string; status: string }) => i.checkId === "P1-direction" && i.status === "PASS")).toBe(true)
    })
  }
  test("SPEC_CHECK_IDS has P1-direction right after P1-sources (N-165)", () => {
    const ids = [...core.SPEC_CHECK_IDS]
    expect(ids.indexOf("P1-direction")).toBe(ids.indexOf("P1-sources") + 1)
  })
  test("legacy spec (no direction): P1-direction not run, `ran` list unchanged (A15 report part)", () => {
    const issues = core.validateSpec(clone(LEGACY), { release: false })
    expect(issues.some((i: { checkId: string }) => i.checkId === "P1-direction")).toBe(false)
    const ran = core.assertValidSpec({ ...clone(LEGACY), direction: "TB" }, { release: true })
    expect(ran.length).toBe(core.assertValidSpec(clone(LEGACY), { release: true }).length + 1)
  })
})

describe("row 45 SEC-23: a non-enum direction is refused before any ELK option is built", () => {
  test("positive control: the spy sees ELK on a layered figure with route defects", async () => {
    const spy = spyElk()
    await elk.buildDiagramSvgAuto(clone(LARGE), { release: false })
    expect(spy.mock.calls.length).toBeGreaterThan(0)
  })
  for (const bad of ["RL; x", "RL", "x", "lr", "BT", "DOWN"]) {
    test(`direction ${JSON.stringify(bad)}: SCHEMA_INVALID enum at .../spec/direction (v2 block and v1 artefact), elkGraphFor never called`, async () => {
      const spy = spyElk()
      const r = preview({ direction: bad })
      expect(r.ok).toBe(false)
      const issues = (r.ok ? [] : r.issues) as Issue[]
      const hit = issues.find((i) => i.pointer === "/block/spec/direction")
      expect(hit?.keyword).toBe("enum")
      expect(hit?.message).toContain('"TB", "LR"')
      const v1 = ingest.validateSchema("studio.diagram/v1", { ...clone(LEGACY), direction: bad }) as Issue[]
      expect(v1.find((i) => i.pointer === "/direction")?.keyword).toBe("enum")
      // Engine defence (spec that skipped the schema): validateSpec refuses P1-direction, so the auto build throws
      // before the ELK branch. LARGE without direction reaches ELK (positive control above).
      const s = { ...clone(LARGE), direction: bad }
      expect(failsOf(core.validateSpec(s, { release: false }), "P1-direction")[0]?.pointer).toBe("/direction")
      expect((await refusalOf(elk.buildDiagramSvgAuto(s, { release: false })))?.checkId).toBe("P1-direction")
      expect(spy.mock.calls.length).toBe(0)
    })
  }
})

describe("row 45 P1-direction: flow only, never with per_row (A17, N-159)", () => {
  test("validateSpec: layered + direction -> P1-direction at /direction naming class.tier and graph + class.col/row", () => {
    const f = failsOf(core.validateSpec({ ...clone(LARGE), direction: "TB" }, { release: false }), "P1-direction")
    expect(f).toHaveLength(1)
    expect(f[0].pointer).toBe("/direction")
    expect(f[0].detail).toContain("direction hanya untuk family flow (family 'layered')")
    expect(f[0].detail).toContain("class.tier")
    expect(f[0].detail).toContain("graph + class.col/row")
  })
  test("validateSpec: flow + per_row + direction -> P1-direction at /per_row", () => {
    const f = failsOf(core.validateSpec({ ...clone(LEGACY), per_row: 3, direction: "LR" }, { release: false }), "P1-direction")
    expect(f.map((x: { pointer?: string }) => x.pointer)).toEqual(["/per_row"])
    expect(f[0].detail).toContain("pakai salah satu")
  })
  test("build refuses layered + direction (DiagramDefect, P1-direction) and never runs ELK", async () => {
    const spy = spyElk()
    const r = await refusalOf(elk.buildDiagramSvgAuto({ ...clone(LARGE), direction: "TB" }, { release: false }))
    expect(r?.checkId).toBe("P1-direction")
    expect(r?.code).toBe("BY_CONSTRUCTION_FAILED")
    expect(spy.mock.calls.length).toBe(0)
  })
  test("by-construction (submit): same id and text, pointer .../spec/direction and .../spec/per_row; legacy spec gives nothing", () => {
    const doc = {
      chapters: [
        {
          key: "1",
          blocks: [
            block(),
            { ...block(), spec: v2spec({ family: "layered", direction: "TB" }) },
            { ...block(), spec: v2spec({ family: "graph", direction: "LR" }) },
            block({ direction: "LR", per_row: 2 }),
            block({ direction: "TB" }),
            { type: "diagram", caption: cap, source: src, spec: { artifactId: "x", direction: "TB" } },
          ],
        },
      ],
    }
    const issues = byc.diagramDirectionIssues(doc, "") as Issue[]
    expect(issues.map((i) => [i.pointer, i.checkId, i.keyword])).toEqual([
      ["/chapters/0/blocks/1/spec/direction", "P1-direction", "byConstruction"],
      ["/chapters/0/blocks/2/spec/direction", "P1-direction", "byConstruction"],
      ["/chapters/0/blocks/3/spec/per_row", "P1-direction", "byConstruction"],
    ])
    expect(issues[0].message).toBe(`P1-direction: ${specMod.directionIssue({ family: "layered", direction: "TB" }).detail}`)
    expect(issues[1].message).toContain("kolom diatur class.col/row; hapus direction")
  })
  test("by-construction error is 422 BY_CONSTRUCTION_FAILED with the P1-direction issue as details", () => {
    const issues = byc.diagramDirectionIssues({ blocks: [{ ...block(), spec: v2spec({ family: "stack", direction: "TB" }) }] }, "/sections/content")
    const e = byc.byConstructionError(issues)
    expect(e.code).toBe("BY_CONSTRUCTION_FAILED")
    expect(e.httpStatus).toBe(422)
    expect((e.details as Issue[])[0].pointer).toBe("/sections/content/blocks/0/spec/direction")
  })
})

describe("row 45 copies: compose and adapt-v1 keep direction (A19)", () => {
  const ctx = { artifactLabel: "Gambar 1.1", classification: "BIASA" }
  test("compose diagramSpec copies direction into the v1 build spec", () => {
    const out = compose.diagramSpec(v2spec({ direction: "LR" }), "Judul uji.", "SUMBER: uji.", 166, ctx)
    expect(out.direction).toBe("LR")
    expect(ingest.validateSchema("studio.diagram/v1", out)).toEqual([])
  })
  test("compose without direction: no direction key (legacy JSON unchanged)", () => {
    const out = compose.diagramSpec(v2spec(), "Judul uji.", "SUMBER: uji.", 128, ctx)
    expect(Object.keys(out)).not.toContain("direction")
  })
  test("adapt-v1 round trip keeps direction and records no dropped field", () => {
    const dropped: string[] = []
    const rec = { rest: (o: Record<string, unknown>, keep: string[], p: string) => { for (const k of Object.keys(o)) if (!keep.includes(k)) dropped.push(`${p}/${k}`) } }
    const v1 = compose.diagramSpec(v2spec({ direction: "TB" }), "Judul uji.", "SUMBER: uji.", 128, ctx)
    const back = adapt.adaptDiagramSpec({ ...v1 }, "/spec", rec as never)
    expect(back.direction).toBe("TB")
    expect(dropped.filter((d) => d.endsWith("/direction"))).toEqual([])
  })
})

describe("row 45 A15: a flow without direction is byte-identical to 1.2.5 (golden at e363918a69)", () => {
  const FIX = path.join(PKG, "test", "ported", "_fixtures", "tests", "parity", "fixtures", "diagram")
  const cases: Record<string, unknown> = { dg_flow: json(path.join(FIX, "dg_flow.json")), dg_flow_wrapped: json(path.join(FIX, "dg_flow_wrapped.json")), legacy_fanout_flow: LEGACY }
  for (const [name, spec] of Object.entries(cases)) {
    test(`${name}: buildDiagramSvg and buildDiagramSvgAuto equal the base bytes`, async () => {
      expect(build.buildDiagramSvg(clone(spec), { release: false }).svg).toBe(golden(`${name}.svg`))
      expect((await elk.buildDiagramSvgAuto(clone(spec), { release: false })).svg).toBe(golden(`${name}.auto.svg`))
    })
  }
  test("legacy_fanout_flow with per_row 3 equals the base bytes", () => {
    expect(build.buildDiagramSvg({ ...clone(LEGACY), per_row: 3 }, { release: false }).svg).toBe(golden("legacy_fanout_flow.per_row3.svg"))
  })
})
