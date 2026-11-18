// @ts-nocheck fixtures are loose records (same convention as the ported suites); checked at run time.
// Swarm 1.3.3 row 52 (ST-5, register 03 s2 and s7 `PLACEHOLDER_UNFILLED`): an unfilled `{{key}}` in a diagram spec is
// refused when the spec is checked (validateSpec, so the build of preview and render) and is never printed verbatim.
import { describe, expect, test } from "bun:test"
import * as core from "@/lib/studio/engine/diagram/core"
import { PLACEHOLDER_CHECK_ID, unfilledPlaceholders } from "@/lib/studio/engine/diagram/core/spec"
import { splitSkeletonOf } from "@/lib/studio/engine/diagram/build/capacity"

const base = () => ({
  $schema: "studio.diagram/v1",
  family: "flow",
  id: "9.1",
  title: "Alur uji.",
  classification: "BIASA",
  width_mm: 166,
  apparatus: "page",
  labels_verified: true,
  sources: ["Uji row 52"],
  nodes: [
    { id: "a", label: "Gudang utama", class: { col: 0, row: 0 } },
    { id: "b", label: "Pemeriksaan mutu", class: { col: 0, row: 1 } },
  ],
  edges: [{ from: "a", to: "b", kind: "data", label: "kirim" }],
})
const failsOf = (s: unknown) => core.validateSpec(s as never, { release: false }).filter((i) => i.status === "FAIL")

describe("row 52: the scanner names the field path and the token", () => {
  // [field, mutate, pointer, token]
  const CASES: Array<[string, (s: any) => void, string, string]> = [
    ["node label", (s) => (s.nodes[0].label = "Gudang {{nama}}"), "/nodes/0/label", "{{nama}}"],
    ["node sub", (s) => (s.nodes[1].sub = "{{dems.pengguna}} orang"), "/nodes/1/sub", "{{dems.pengguna}}"],
    ["node tag", (s) => (s.nodes[0].tag = "{{REQ-01}}"), "/nodes/0/tag", "{{REQ-01}}"],
    ["edge label", (s) => (s.edges[0].label = "{{isi}}"), "/edges/0/label", "{{isi}}"],
    ["title", (s) => (s.title = "Alur {{sistem}}."), "/title", "{{sistem}}"],
    ["source row", (s) => (s.sources = ["Manual {{rev}}"]), "/sources/0", "{{rev}}"],
    ["key row", (s) => (s.legend = ["utuh data", "putus {{arti}}"]), "/legend/1", "{{arti}}"],
    ["note row", (s) => (s.notes = ["Nilai {{x_1}} adalah asumsi."]), "/notes/0", "{{x_1}}"],
    ["zone label", (s) => (s.zones = [{ id: "z", label: "Zona {{z}}", members: ["a"] }]), "/zones/0/label", "{{z}}"],
    ["ref.figure", (s) => (s.nodes[1] = { ...s.nodes[1], shape: "offpage", ref: { figure: "{{id_blok_bagian_2}}", key: "S1" } }), "/nodes/1/ref/figure", "{{id_blok_bagian_2}}"],
    ["ref.key", (s) => (s.nodes[1] = { ...s.nodes[1], shape: "offpage", ref: { figure: "blk-2", key: "{{kunci}}" } }), "/nodes/1/ref/key", "{{kunci}}"],
    ["spaces inside the braces", (s) => (s.nodes[0].sub = "{{ sai.gpu.vram }} GB"), "/nodes/0/sub", "{{ sai.gpu.vram }}"],
  ]
  for (const [name, mutate, pointer, token] of CASES) {
    test(`${name}: refused at ${pointer} naming ${token}`, () => {
      const s = base()
      mutate(s)
      expect(unfilledPlaceholders(s).map((u) => [u.pointer, u.token])).toEqual([[pointer, token]])
      const fails = failsOf(s)
      expect(fails[0].checkId).toBe("PLACEHOLDER_UNFILLED")
      expect(fails[0].pointer).toBe(pointer)
      expect(fails[0].detail).toContain(token)
      expect(fails[0].detail).toContain(pointer)
      // the build refusal (what preview and render run) carries the same id and field
      let thrown: any
      try {
        core.assertValidSpec(s as never, { release: false })
      } catch (e) {
        thrown = e
      }
      expect(thrown?.name).toBe("DiagramDefect")
      expect(thrown.checkId).toBe("PLACEHOLDER_UNFILLED")
      expect(thrown.pointer).toBe(pointer)
    })
  }

  test("the id is the register name and is listed first in SPEC_CHECK_IDS", () => {
    expect(PLACEHOLDER_CHECK_ID).toBe("PLACEHOLDER_UNFILLED")
    expect(core.SPEC_CHECK_IDS[0]).toBe("PLACEHOLDER_UNFILLED")
  })

  test("the placeholder is the named defect even when it also breaks another check (id, title)", () => {
    const s = base()
    s.id = "{{nomor}}"
    s.title = "{{judul}}"
    const fails = failsOf(s)
    expect(fails[0].checkId).toBe("PLACEHOLDER_UNFILLED")
    expect(fails[0].detail).toContain("{{nomor}}")
    expect(fails[0].detail).toContain("{{judul}}")
    expect(fails.filter((f) => f.checkId === "PLACEHOLDER_UNFILLED")).toHaveLength(1) // one refusal lists every token
  })

  test("several tokens: all listed with their fields, at most 8 itemised, the rest counted", () => {
    const s = base()
    s.notes = Array.from({ length: 11 }, (_, i) => `catatan {{k${i}}}`)
    const d = failsOf(s)[0].detail as string
    expect(unfilledPlaceholders(s)).toHaveLength(11)
    expect(d).toContain("11 penanda")
    expect(d).toContain("{{k7}} di /notes/7")
    expect(d).not.toContain("{{k8}}")
    expect(d).toContain("3 lagi")
  })
})

describe("row 52: a filled spec passes and its report is unchanged", () => {
  test("no token: no PLACEHOLDER_UNFILLED entry at all, `ran` equals the list of 1.3.2", () => {
    const issues = core.validateSpec(base() as never, { release: false })
    expect(issues.some((i) => i.checkId === "PLACEHOLDER_UNFILLED")).toBe(false)
    expect(issues.filter((i) => i.status === "FAIL")).toEqual([])
    expect(core.assertValidSpec(base() as never, { release: false })).not.toContain("PLACEHOLDER_UNFILLED")
  })

  test("the filled R3 form passes: `48 GB` where `{{sai.gpu.vram}} GB` stood", () => {
    const s = base()
    s.nodes[0].sub = "{{sai.gpu.vram}} GB"
    expect(failsOf(s)[0]?.checkId).toBe("PLACEHOLDER_UNFILLED")
    s.nodes[0].sub = "48 GB"
    expect(failsOf(s)).toEqual([])
  })

  // The escape rule: only `{{key}}` with a bare key (letters, digits, _ . -) is a placeholder. Text that is not that
  // form is printed as written; a literal bare key in double braces is written with a space between the braces.
  for (const literal of ["{ {nama} }", "{nama}", "{{}}", "{{a b}}", "{{#each item}}", "{{ .Values.x | quote }}", "a }} b {{", "${nama}", "{{{nama}}", "f(x) = {x | x > 0}"]) {
    test(`not a placeholder, printed as written: ${literal}`, () => {
      const s = base()
      s.nodes[0].sub = literal
      s.notes = [literal]
      const expected = literal === "{{{nama}}" ? 2 : 0 // `{{nama}}` inside a third brace is still the token
      expect(unfilledPlaceholders(s)).toHaveLength(expected)
    })
  }

  test("non-string values and odd shapes never throw (numbers, null, nested arrays, a non-object spec)", () => {
    expect(unfilledPlaceholders(null)).toEqual([])
    expect(unfilledPlaceholders("{{x}}")).toEqual([])
    expect(unfilledPlaceholders({ nodes: [null, 3, ["{{x}}"], { u: 2, class: { tier: 1 } }] }).map((u) => u.pointer)).toEqual(["/nodes/2/0"])
  })

  test("a key longer than 64 characters is not the register form (not matched)", () => {
    expect(unfilledPlaceholders({ title: `{{${"k".repeat(64)}}}` })).toHaveLength(1)
    expect(unfilledPlaceholders({ title: `{{${"k".repeat(65)}}}` })).toHaveLength(0)
  })
})

describe("row 52: the split skeleton of row 51 (ST-4) is caught while its placeholders are unfilled", () => {
  const wide = () => ({
    ...base(),
    family: "graph",
    width_mm: 128,
    nodes: Array.from({ length: 7 }, (_, i) => ({ id: `g${i + 1}`, label: `Simpul ${i + 1}`, class: { col: i, row: 0 } })),
    edges: Array.from({ length: 6 }, (_, i) => ({ from: `g${i + 1}`, to: `g${i + 2}`, kind: "data", label: "alir" })),
  })

  test("both parts are refused with PLACEHOLDER_UNFILLED at /nodes/<i>/ref/figure; filled, the refusal is gone", () => {
    const split = splitSkeletonOf(wide() as never)
    expect(split).toBeDefined()
    expect(split!.placeholders).toEqual(["{{id_blok_bagian_1}}", "{{id_blok_bagian_2}}"])
    const [p1, p2] = split!.specs as any[]
    for (const [part, token] of [[p1, "{{id_blok_bagian_2}}"], [p2, "{{id_blok_bagian_1}}"]] as const) {
      const found = unfilledPlaceholders(part)
      expect(found.length).toBeGreaterThan(0)
      for (const u of found) {
        expect(u.pointer).toMatch(/^\/nodes\/\d+\/ref\/figure$/)
        expect(u.token).toBe(token)
      }
      const fails = failsOf(part)
      expect(fails[0].checkId).toBe("PLACEHOLDER_UNFILLED")
      expect(fails[0].detail).toContain(token)
    }
    const fill = (part: any, id: string) => JSON.parse(JSON.stringify(part).replaceAll(/\{\{id_blok_bagian_[12]\}\}/g, id))
    expect(failsOf(fill(p1, "blk-bagian-2")).filter((f) => f.checkId === "PLACEHOLDER_UNFILLED")).toEqual([])
    expect(failsOf(fill(p2, "blk-bagian-1")).filter((f) => f.checkId === "PLACEHOLDER_UNFILLED")).toEqual([])
  })
})
