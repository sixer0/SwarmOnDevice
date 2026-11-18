// Swarm 1.3.3 row 26 (ST-4, ST-5; register 03 section 6): the diagram spec contract.
// (a) node `ref` = `{ figure, key }`: `figure` is the block id (pid) of the diagram block the connector continues on,
//     `key` is the pair key (`^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$`). Both required, object closed.
// (b) root `tiers` = `[{ tier: integer >= 0, label }]`, in studio.diagram/v1 and in DiagramSpecV2.
// (c) node-level `external` (boolean) and root `notes` (string list) stay accepted.
// Contract only. The schema states shape; these rules are the engine's and are NOT tested here:
// `ref` only on shape "offpage" and the pair rule (row 50), `tiers` only for layered/topology and `tier` in use (row 56).
import { describe, expect, test } from "bun:test"
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import path from "node:path"
import { BLOCK_AT, probeDoc, setAt } from "../ported/structure/_kit"

const V = path.resolve(import.meta.dir, "..", "..", "vendor", "src", "lib", "studio")
const { validateV2Against, validateAgainst } = await import(path.join(V, "services", "ingest", "validate.ts"))
const diagram = await import(path.join(V, "contract", "schema", "diagram.schema.ts"))
const common = await import(path.join(V, "contract", "schema", "v2", "common.schema.ts"))
const env = await import(path.join(V, "contract", "env.ts"))

type Rec = Record<string, any>
type Issue = { checkId?: string; pointer: string; message: string }
const DIAGRAM = BLOCK_AT(9)

const offpage = (ref: unknown, extra: Rec = {}): Rec => ({ id: "n2", label: "Lanjut", shape: "offpage", class: { tier: 1 }, ref, ...extra })
const v1 = (extra: Rec = {}, nodes?: Rec[]): Rec => ({
  $schema: "studio.diagram/v1",
  family: "layered",
  id: "Gambar 2.1",
  title: "Arsitektur.",
  classification: "INTERNAL",
  width_mm: 128,
  sources: ["Dokumen desain"],
  nodes: nodes ?? [{ id: "n1", label: "Sumber", class: { tier: 0 } }],
  ...extra,
})
const v1Issues = (spec: Rec) => validateAgainst("studio.diagram/v1", spec) as Issue[]
const v1WithRef = (ref: unknown, extra: Rec = {}) => v1Issues(v1({}, [{ id: "n1", label: "Sumber", class: { tier: 0 } }, offpage(ref, extra)]))

/** The probe document's diagram block (chapter 2, block 9) with a replaced spec. */
function v2Issues(spec: Rec) {
  const doc = probeDoc()
  setAt(doc, `${DIAGRAM}/spec`, spec)
  return validateV2Against("studio.doc/v2", doc) as Issue[]
}
const v2Spec = (extra: Rec = {}, nodes?: Rec[]): Rec => ({ family: "layered", nodes: nodes ?? [{ id: "n1", label: "Sumber", class: { tier: 0 } }], ...extra })
const v2WithRef = (ref: unknown) => v2Issues(v2Spec({}, [{ id: "n1", label: "Sumber", class: { tier: 0 } }, offpage(ref)]))

const REF = { figure: "gbr-alur-lanjutan", key: "A" }

describe("row 26 exported names", () => {
  test("pair key pattern and tier cap", () => {
    expect(diagram.DIAGRAM_REF_KEY_PATTERN).toBe("^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$")
    const node = (diagram.diagramSchema as Rec).properties.nodes.items.properties
    expect(node.ref.properties.key.pattern).toBe(diagram.DIAGRAM_REF_KEY_PATTERN)
    // `figure` is a block id: the same pattern as every v2 block `id`.
    expect(node.ref.properties.figure.pattern).toBe(env.PID_PATTERN)
    expect(node.ref.required).toEqual(["figure", "key"])
    expect(node.ref.additionalProperties).toBe(false)
    const tiers = (diagram.diagramSchema as Rec).properties.tiers
    expect(tiers.maxItems).toBe(24)
    expect(tiers.items.required).toEqual(["tier", "label"])
    expect(tiers.items.additionalProperties).toBe(false)
  })

  test("DiagramSpecV2 carries the same `tiers` definition; `ref` comes with nodes", () => {
    const v2 = (common.commonV2Schema as Rec).$defs.DiagramSpecV2.properties
    expect(v2.tiers).toBe((diagram.diagramSchema as Rec).properties.tiers)
    expect(v2.nodes.items.properties.ref).toBe((diagram.diagramSchema as Rec).properties.nodes.items.properties.ref)
  })
})

describe("row 26 baseline: the specs used here are valid without the new fields", () => {
  test("studio.diagram/v1", () => expect(v1Issues(v1())).toEqual([]))
  test("DiagramSpecV2 in a studio.doc/v2 document", () => expect(v2Issues(v2Spec())).toEqual([]))
})

describe("row 26 `ref` on a node", () => {
  test("accepted: { figure: <block id>, key }", () => {
    expect(v1WithRef(REF)).toEqual([])
    expect(v2WithRef(REF)).toEqual([])
  })

  test.each(["A", "a1", "K.2", "ke_gardu-2", "9", "A".repeat(32)])("accepted key %p", (key) => {
    expect(v1WithRef({ figure: "gbr-2", key })).toEqual([])
  })

  // Rows are one-element arrays: a bare array value would be spread into the arguments.
  test.each([[""], ["-A"], [".A"], ["_A"], ["A B"], ["A/B"], ["A".repeat(33)], ["é"], [7], [null], [["A"]]])("refused key %p", (key) => {
    expect(v1WithRef({ figure: "gbr-2", key }).length).toBeGreaterThan(0)
    expect(v2WithRef({ figure: "gbr-2", key }).length).toBeGreaterThan(0)
  })

  test.each(["gbr-2", "a1b", "0-9", "a".repeat(64)])("accepted figure %p (a block id)", (figure) => {
    expect(v1WithRef({ figure, key: "A" })).toEqual([])
  })

  // A printed number is not a block id: the label is made by the engine from the real figure number.
  test.each(["Gambar 2.2", "2.2", "Gbr-2", "ab", "-ab", "a".repeat(65), "", 2.2, null])("refused figure %p", (figure) => {
    expect(v1WithRef({ figure, key: "A" }).length).toBeGreaterThan(0)
    expect(v2WithRef({ figure, key: "A" }).length).toBeGreaterThan(0)
  })

  test("refused: missing `figure` or `key`, an extra name, a non-object", () => {
    for (const bad of [{ figure: "gbr-2" }, { key: "A" }, {}, { ...REF, label: "ke Gambar 2.2" }, { ...REF, number: "2.2" }, "gbr-2#A", ["gbr-2", "A"], null, true]) {
      expect(v1WithRef(bad).length).toBeGreaterThan(0)
      expect(v2WithRef(bad).length).toBeGreaterThan(0)
    }
  })

  test("pointer of a refusal names the field", () => {
    expect(v1WithRef({ figure: "gbr-2", key: "A B" }).map((i) => i.pointer)).toContain("/nodes/1/ref/key")
    expect(v1WithRef({ figure: "Gambar 2.2", key: "A" }).map((i) => i.pointer)).toContain("/nodes/1/ref/figure")
  })

  test("`ref` is a node field only: refused on the root, in `class`, on an edge and on a zone", () => {
    expect(v1Issues(v1({ ref: REF })).length).toBeGreaterThan(0)
    expect(v1Issues(v1({}, [{ id: "n1", label: "Sumber", class: { tier: 0, ref: REF } }])).length).toBeGreaterThan(0)
    expect(v1Issues(v1({ edges: [{ from: "n1", to: "n1", kind: "data", label: "", ref: REF }] })).length).toBeGreaterThan(0)
    expect(v1Issues(v1({ zones: [{ id: "z", label: "Zona", members: ["n1"], ref: REF }] })).length).toBeGreaterThan(0)
  })
})

describe("row 26 `tiers` on the root", () => {
  const TIERS = [
    { tier: 0, label: "Lapis akses" },
    { tier: 1, label: "Lapis inti" },
  ]

  test("accepted in v1 and v2, for layered and topology", () => {
    expect(v1Issues(v1({ tiers: TIERS }))).toEqual([])
    expect(v1Issues(v1({ family: "topology", tiers: TIERS }))).toEqual([])
    expect(v2Issues(v2Spec({ tiers: TIERS }))).toEqual([])
    expect(v2Issues(v2Spec({ family: "topology", tiers: TIERS }))).toEqual([])
  })

  test("accepted: an empty list, 24 entries, a 300-character label", () => {
    expect(v1Issues(v1({ tiers: [] }))).toEqual([])
    expect(v1Issues(v1({ tiers: Array.from({ length: 24 }, (_, i) => ({ tier: i, label: `Lapis ${i}` })) }))).toEqual([])
    expect(v1Issues(v1({ tiers: [{ tier: 0, label: "L".repeat(300) }] }))).toEqual([])
  })

  test.each([
    ["25 entries", Array.from({ length: 25 }, (_, i) => ({ tier: i, label: `Lapis ${i}` }))],
    ["negative tier", [{ tier: -1, label: "Lapis" }]],
    ["fractional tier", [{ tier: 0.5, label: "Lapis" }]],
    ["string tier", [{ tier: "0", label: "Lapis" }]],
    ["missing tier", [{ label: "Lapis" }]],
    ["missing label", [{ tier: 0 }]],
    ["empty label", [{ tier: 0, label: "" }]],
    ["301-character label", [{ tier: 0, label: "L".repeat(301) }]],
    ["numeric label", [{ tier: 0, label: 3 }]],
    ["extra name", [{ tier: 0, label: "Lapis", id: "t0" }]],
    ["alias name `name`", [{ tier: 0, name: "Lapis" }]],
    ["list of strings", ["Lapis akses", "Lapis inti"]],
    ["object keyed by tier", { 0: "Lapis akses" }],
    ["string", "Lapis akses"],
  ])("refused: %s", (_name, tiers) => {
    expect(v1Issues(v1({ tiers })).length).toBeGreaterThan(0)
    expect(v2Issues(v2Spec({ tiers })).length).toBeGreaterThan(0)
  })

  test("`tiers` is a root field only: refused on a node and in `class`", () => {
    expect(v1Issues(v1({}, [{ id: "n1", label: "Sumber", class: { tier: 0 }, tiers: TIERS }])).length).toBeGreaterThan(0)
    expect(v1Issues(v1({}, [{ id: "n1", label: "Sumber", class: { tier: 0, tiers: TIERS } }])).length).toBeGreaterThan(0)
  })
})

describe("row 26 kept fields: node `external`, root `notes`", () => {
  test("node-level `external` is a boolean, beside `class.external`", () => {
    expect(v1Issues(v1({}, [{ id: "n1", label: "Sumber", external: true, class: { tier: 0 } }]))).toEqual([])
    expect(v1Issues(v1({}, [{ id: "n1", label: "Sumber", external: false, class: { tier: 0, external: true } }]))).toEqual([])
    expect(v2Issues(v2Spec({}, [{ id: "n1", label: "Sumber", external: true, class: { tier: 0 } }]))).toEqual([])
    for (const bad of ["true", 1, null, {}]) {
      expect(v1Issues(v1({}, [{ id: "n1", label: "Sumber", external: bad, class: { tier: 0 } }])).length).toBeGreaterThan(0)
    }
  })

  test("`notes` is a list of at most 24 strings of at most 1000 characters", () => {
    expect(v1Issues(v1({ notes: ["Catatan satu", "Catatan dua"] }))).toEqual([])
    expect(v2Issues(v2Spec({ notes: ["Catatan satu"] }))).toEqual([])
    expect(v1Issues(v1({ notes: Array.from({ length: 24 }, (_, i) => `Catatan ${i}`) }))).toEqual([])
    expect(v1Issues(v1({ notes: Array.from({ length: 25 }, (_, i) => `Catatan ${i}`) })).length).toBeGreaterThan(0)
    expect(v1Issues(v1({ notes: ["x".repeat(1001)] })).length).toBeGreaterThan(0)
    expect(v1Issues(v1({ notes: "Catatan" })).length).toBeGreaterThan(0)
    expect(v1Issues(v1({ notes: [{ text: "Catatan" }] })).length).toBeGreaterThan(0)
    expect(v2Issues(v2Spec({ notes: [7] })).length).toBeGreaterThan(0)
  })
})

describe("row 26 closed objects stay closed", () => {
  test("unknown names next to the new fields are still refused", () => {
    expect(v1Issues(v1({ tierLabels: ["Lapis"] })).length).toBeGreaterThan(0)
    expect(v1Issues(v1({ layers: [{ tier: 0, label: "Lapis" }] })).length).toBeGreaterThan(0)
    expect(v1Issues(v1({}, [{ id: "n1", label: "Sumber", class: { tier: 0 }, offpage: REF }])).length).toBeGreaterThan(0)
    expect(v1Issues(v1({}, [{ id: "n1", label: "Sumber", class: { tier: 0 }, target: "gbr-2" }])).length).toBeGreaterThan(0)
    expect(v2Issues(v2Spec({ tierLabels: ["Lapis"] })).length).toBeGreaterThan(0)
  })
})
