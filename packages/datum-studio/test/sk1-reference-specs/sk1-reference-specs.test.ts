// Swarm 1.3.3 row 89 (SK-1): the eight candidate reference specs through the engine, specs untouched.
// Product path: row 49's helper (document render and preview). No spec states a width, so "text" (128 mm) is the
// width of record; "full" (166 mm) is recorded as information only. The test asserts only that a result was recorded
// and writes results.md next to itself.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { keyLineText } from "@/lib/studio/engine/front/texts"
import { caseMismatches, edgeLabelsOnBorder, onHatch, struckFootRows } from "../st3-round2-replay/_counts"
import { createProduct, type PathResult, type Product, type Width } from "../st3-round2-replay/_product"

type J = Record<string, any>
const FIX = path.join(import.meta.dir, "fixtures")
const FILES = readdirSync(FIX).filter((f) => f.startsWith("spec_") && f.endsWith(".json")).sort()
const PATHS = ["document", "preview"] as const
const rows: string[] = []
let product: Product
let recorded = 0

const keyWord = () => (product.lang === "EN" ? "KEY" : "KUNCI")

function cell(x: PathResult, spec: J): string {
  if (x.refusal || !x.svg) return `REFUSED ${x.refusal?.code ?? "NO_SVG"}${x.refusal?.checkId ? ` (${x.refusal.checkId})` : ""}: ${(x.refusal?.message ?? "no svg").replace(/\|/g, "/").replace(/\n/g, " ")}`
  const wording = (row: string) => keyLineText(row, product.lang)
  const c = caseMismatches(spec, x.svg, keyWord(), wording)
  const counts = `struck ${struckFootRows(x.svg).length}, hatch ${onHatch(x.svg).length}, border ${edgeLabelsOnBorder(x.svg).length}, case ${c.mismatches.length}`
  return `BUILT ${x.widthMm} mm; defects [${x.defects.join(", ")}]; notices [${x.notices.join(", ")}]; ${counts}`
}

beforeAll(async () => {
  product = await createProduct()
  for (const f of FILES) {
    const block = JSON.parse(readFileSync(path.join(FIX, f), "utf8")) as J
    for (const width of ["text", "full"] as Width[]) {
      const out = await product.render(block, width)
      for (const p of PATHS) {
        rows.push(`| ${f.replace(/^spec_|\.json$/g, "")} | ${block.spec.family} | ${width} | ${p} | ${cell(out[p], block.spec)} |`)
        recorded++
      }
    }
  }
  const md = ["| spec | family | width | path | result |", "|---|---|---|---|---|", ...rows].join("\n") + "\n"
  writeFileSync(path.join(import.meta.dir, "results.md"), md)
  console.log(md)
}, 180000)
afterAll(() => product?.dispose())

describe("row 89: eight candidate reference specs, result recorded", () => {
  test("every spec has a recorded result on both paths at both widths", () => {
    expect(FILES.length).toBe(8)
    expect(recorded).toBe(32)
  })
})
