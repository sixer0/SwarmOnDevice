// @ts-nocheck fixtures are loose records (same convention as the ported suites); checked at run time.
// Swarm 1.3.3 row 52 (ST-5): replay of the 33 round-1 specs (R3). Those that printed a `{{key}}` verbatim are refused
// with PLACEHOLDER_UNFILLED; the others get no such refusal. The specs are read from SWARM_REPLAY_DIR/R3_round1_specs
// (row 146: never from a fixed path; skipped when the variable is unset).
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { useStudioEnv } from "../ported/_env"
import { replayInputs } from "../replay-dir"
import { DIAGRAM_LAYOUTS } from "@/lib/studio/contract/dispatch"
import { buildDiagramSvgRaw, buildDiagramSvgWith } from "@/lib/studio/engine/diagram/build"
import { unfilledPlaceholders, validateSpec } from "@/lib/studio/engine/diagram/core/spec"

useStudioEnv()

const REPLAY = replayInputs("row 52 replay R3", ["R3_round1_specs"] as const)
const R3 = REPLAY.paths[0]
const OPTS = { release: false, keyLabel: "KUNCI" }
// Same wrapping as test/st5-doubled-sumber/row55-doubled-sumber.test.ts: compose adds id, title, width and sources.
const fromBlock = (raw: any) => ({ $schema: "studio.diagram/v1", id: "1.1", title: raw.caption.text, classification: "TERBATAS", width_mm: 166, ...raw.spec, sources: [raw.source.text], apparatus: "page" })
const files = !REPLAY.present ? [] : readdirSync(R3).flatMap((d) => readdirSync(path.join(R3, d)).filter((f) => f.endsWith(".json")).map((f) => `${d}/${f}`)).sort()
const rawOf = (f: string) => JSON.parse(readFileSync(path.join(R3, f), "utf8"))
// 32 of the 33 files are diagram blocks ({caption, source, spec}); p5-siber-proses holds one chart record ({chart,
// riwayat}), which has no diagram spec: it is scanned as it is (no token) and never built here.
const isDiagram = (f: string) => rawOf(f).spec !== undefined
const load = (f: string) => (isDiagram(f) ? fromBlock(rawOf(f)) : rawOf(f))
const textOf = (svg: string) => [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map((m) => m[1].replace(/<[^>]+>/g, "")).join("\n")

// What the round-1 report names (issue B-13: four figures and one table). The table is not a diagram spec and is not
// in R3: not verifiable from this replay input.
const EXPECTED: Record<string, [string, string]> = {
  "p4-perangkat-lunak-data-ai/18.1.json": ["/nodes/0/sub", "{{dems.pengguna}}"],
  "p4-perangkat-lunak-data-ai/18.3.json": ["/nodes/4/sub", "{{dems.kafka.brokers}}"],
  "p4-perangkat-lunak-data-ai/21.1.json": ["/nodes/6/sub", "{{sai.gpu.vram}}"],
  "p4-perangkat-lunak-data-ai/21.2.json": ["/nodes/0/sub", "{{rag.chunk}}"],
}

describe.skipIf(!REPLAY.present)("row 52 replay R3: 33 round-1 specs", () => {
  test("33 files; exactly the four specs that carry a `{{key}}` are refused, naming field and token", () => {
    expect(files).toHaveLength(33)
    expect(files.filter(isDiagram)).toHaveLength(32)
    const refused: Record<string, [string, string]> = {}
    for (const f of files) {
      const found = unfilledPlaceholders(load(f))
      if (!isDiagram(f)) {
        expect([f, found]).toEqual([f, []])
        continue
      }
      const first = validateSpec(load(f), { release: false }).find((i) => i.status === "FAIL")
      if (found.length === 0) {
        expect([f, first?.checkId === "PLACEHOLDER_UNFILLED"]).toEqual([f, false])
        continue
      }
      expect([f, first?.checkId]).toEqual([f, "PLACEHOLDER_UNFILLED"])
      expect(found).toHaveLength(1)
      expect(first.pointer).toBe(found[0].pointer)
      expect(first.detail).toContain(found[0].token)
      refused[f] = [found[0].pointer, found[0].token]
    }
    console.log(`[row52] R3: ${files.length} specs, ${Object.keys(refused).length} refused with PLACEHOLDER_UNFILLED: ${JSON.stringify(refused)}`)
    expect(refused).toEqual(EXPECTED)
  })

  for (const [f, [pointer, token]] of Object.entries(EXPECTED)) {
    test(`${f}: the build throws PLACEHOLDER_UNFILLED (${token} at ${pointer}); without the check the token is drawn verbatim`, () => {
      let thrown: any
      try {
        buildDiagramSvgRaw(load(f), OPTS)
      } catch (e) {
        thrown = e
      }
      expect(thrown?.checkId).toBe("PLACEHOLDER_UNFILLED")
      expect(thrown.pointer).toBe(pointer)
      expect(thrown.message).toContain(token)
      // BEFORE (1.3.2 behaviour): the same build with this one check left out of the validation. Either the SVG
      // carries the token as text (printed verbatim), or another rule refused the spec for a different reason.
      const before = { validate: (s, o) => validateSpec(s, o).filter((i) => i.checkId !== "PLACEHOLDER_UNFILLED"), layouts: DIAGRAM_LAYOUTS }
      let svg: string | null = null
      let other: any
      try {
        svg = buildDiagramSvgWith(load(f), OPTS, before).svg
      } catch (e) {
        other = e
      }
      console.log(`[row52] ${f} before: ${svg === null ? `refused by ${other?.checkId ?? other?.message}` : textOf(svg).includes(token) ? `SVG prints ${token}` : "SVG without the token"}`)
      if (svg !== null) expect(textOf(svg)).toContain(token)
    })
  }

  test("filled, the four specs lose the refusal (the token replaced by a value)", () => {
    for (const [f, [, token]] of Object.entries(EXPECTED)) {
      const filled = JSON.parse(JSON.stringify(load(f)).replaceAll(token, "12"))
      expect(validateSpec(filled, { release: false }).filter((i) => i.checkId === "PLACEHOLDER_UNFILLED")).toEqual([])
    }
  })
})
