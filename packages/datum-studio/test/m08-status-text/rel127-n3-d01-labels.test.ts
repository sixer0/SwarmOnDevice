// Swarm 1.2.7 row 35b (N-3, AC-N3, register N7-098 / N7-063 / K7-09): one labelled count per lint code.
// Fixture: test/fixtures/syn127/n3_d01_150.json (SERAH, 3 chapters x 50 paragraphs with one untracked decimal-comma
// number each = 150 D01 findings). The real structure lint gives 100 itemised D01 rows plus one summary (carrier) row
// with findingsAll; studio_document_status reads that lint record.
// BASE (04067a9d02): "FAIL per kode: ... D01=101" (the carrier row counted as a finding), no "D01: total" line, and
// the lint line's finding count is the FAIL row count over all codes, not the sum of the per-code totals.
import { beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { connect, reply } from "../ported/mcp/mcp-harness"
import { canonicalTemplate, makeDoc, snapshotOf } from "../ported/engine-core/fixtures"
import { lintStructure } from "../../vendor/src/lib/studio/engine/lint/structure"
import { summarizeLint } from "../../vendor/src/lib/studio/registry/lint-explain"

type Rec = Record<string, any>
const DOC = "cmvdoc00000000000000rel127n3"
const FIX = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "fixtures", "syn127", "n3_d01_150.json"), "utf8")) as Rec

function fixtureDoc(): Rec {
  const doc = makeDoc({ tier: "SERAH" }) as unknown as Rec
  doc.chapters = (FIX.chapters as Rec[]).map((c) => ({ title: c.chapter.title, sections: c.chapter.sections }))
  return doc
}

function lintOf(doc: Rec): Rec {
  const snap = snapshotOf(doc as never)
  return { tier: "SERAH", releaseStatus: "FAIL", banner: "x", checks: lintStructure(snap, canonicalTemplate(), "SERAH") }
}

async function status(lint: Rec, args: Rec = {}) {
  const body = {
    document: { id: DOC, docNumber: "000/UJI/KT/XI/2026", title: "Dokumen uji N-3", currentRevisionNo: 7, releaseStatus: "FAIL" },
    revision: { revisionNo: 7 },
    completeness: { status: "COMPLETE" },
    outputs: [],
    lint,
  }
  const f = async (url: string) =>
    reply(
      new URL(url).pathname.endsWith("/completeness")
        ? { status: 200, body: { documentId: DOC, completeness: { status: "COMPLETE", revisionNo: 7, fullRenderAllowed: true, slots: [], missingRequired: [], nextSteps: [] } } }
        : { status: 200, body },
    )
  const { call } = await connect({ fetch: f as never, env: { STUDIO_AGENT_ID: "cod-n3" } })
  return call("studio_document_status", { documentId: DOC, ...args })
}

/** "FAIL per kode" values as a map. */
const perCode = (text: string): Map<string, number> => {
  const line = /FAIL per kode: ([^\n]*)/.exec(text)?.[1] ?? ""
  return new Map([...line.matchAll(/([A-Z0-9_-]+)=(\d+)/g)].map((m) => [m[1]!, Number(m[2])]))
}

let LINT: Rec
beforeAll(() => {
  LINT = lintOf(fixtureDoc())
})

describe("N-3: D01 counts carry one label each (fixture n3_d01_150)", () => {
  test("fixture gives 100 itemised D01 rows plus one carrier row of 150 findings", () => {
    const d01 = (LINT.checks as Rec[]).filter((c) => c.checkId === "D01")
    const carrier = d01.find((c) => Array.isArray(c.findingsAll))
    expect(carrier).toBeDefined()
    expect(carrier!.findingsAll.length).toBe(150)
    expect(d01.filter((c) => c.status === "FAIL" && !Array.isArray(c.findingsAll)).length).toBe(100)
  })

  test("(a)-(d) plain status: D01=150, labelled total line, no D01=101, lint count = sum of per-code totals", async () => {
    const r = await status(LINT)
    console.log(`[rel127-n3] ${r.text.split("\n").filter((l: string) => /FAIL per kode|D01: total|lint: FAIL \(/.test(l)).join(" | ")}`)
    expect(r.text).toMatch(/FAIL per kode: [^\n]*\bD01=150\b/) // (a)
    expect(r.text).toContain("D01: total 150 (dirinci 100, tidak dirinci 50)") // (b)
    expect(r.text).not.toMatch(/\bD01=101\b/) // (c)
    const sum = [...perCode(r.text).values()].reduce((a, b) => a + b, 0)
    const n = Number(/lint: FAIL \(dijalankan; (\d+) temuan/.exec(r.text)?.[1])
    expect(n).toBe(sum) // (d)
    expect(r.data.lint.findingsTotal).toBe(sum)
    // Every count on the plain lint lines is labelled (total / dirinci / tidak dirinci / temuan / tercantum / kode=).
    const plain = r.text.split("\n").filter((l: string) => /^  (lint: |FAIL per kode|[A-Z0-9_-]+: total )/.test(l))
    expect(plain.length).toBeGreaterThanOrEqual(3)
    for (const l of plain) {
      const stripped = l
        .replace(/\b[A-Z0-9_-]+=\d+/g, "")
        .replace(/\btotal \d+/g, "")
        .replace(/\b(dirinci|tidak dirinci) \d+/g, "")
        .replace(/\b\d+ (temuan|tercantum|kode)\b/g, "")
      expect({ line: l, rest: stripped.match(/\b\d+\b/g) }).toEqual({ line: l, rest: null })
    }
  })

  test("(e) findingsPage.total for D01 = 150 = the D01 value of FAIL per kode", async () => {
    const r = await status(LINT, { findings: { checkId: "D01", limit: 10 } })
    expect(r.data.findingsPage.total).toBe(150)
    expect(perCode(r.text).get("D01")).toBe(r.data.findingsPage.total)
  })

  test("the '+N temuan lain' line counts the findings not shown (real total minus listed)", async () => {
    const r = await status(LINT)
    const listed = (r.data.lint.findings as Rec[]).length
    const m = /- \(\+(\d+) temuan lain; detail=true\)/.exec(r.text)
    if (m) expect(Number(m[1])).toBe(r.data.lint.findingsTotal - listed)
    // A listed summary row stands for its unitemised rest (50), the itemised rows for one finding each.
    const all = summarizeLint(LINT, { max: 500 })
    const carrier = all.findings.find((f) => f.represents !== undefined)
    expect(carrier?.code).toBe("D01")
    expect(carrier?.represents).toBe(50)
    expect(all.findings.reduce((n, f) => n + (f.represents ?? 1), 0)).toBe(all.findingsTotal)
  })

  test("(f) CHAR: under 100 findings per code the lint and FAIL per kode lines are byte-identical to BASE", async () => {
    const doc = fixtureDoc()
    doc.chapters = [{ title: doc.chapters[0].title, sections: [{ ...doc.chapters[0].sections[0], blocks: doc.chapters[0].sections[0].blocks.slice(0, 40) }] }]
    const lint = lintOf(doc)
    const fails = (lint.checks as Rec[]).filter((c) => c.status === "FAIL")
    expect((lint.checks as Rec[]).some((c) => Array.isArray(c.findingsAll))).toBe(false)
    const r = await status(lint)
    // BASE rule (rows = findings when no carrier exists): count FAIL rows per code, most frequent first.
    const m = new Map<string, number>()
    for (const c of fails) m.set(c.checkId, (m.get(c.checkId) ?? 0) + 1)
    const order = [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    expect(r.text).toContain(`  FAIL per kode: ${order.map(([k, n]) => `${k}=${n}`).join(", ")}\n`)
    expect(r.text).toContain(`  lint: FAIL (dijalankan; ${fails.length} temuan, 5 tercantum; detail=true untuk semua; rincian di blok status di bawah)`)
    expect(r.text).toContain(`- (+${fails.length - 5} temuan lain; detail=true)`)
    expect(r.text).not.toMatch(/: total \d+ \(dirinci/)
  })

  test("(g) CHAR: without rev the text names the revision used", async () => {
    const r = await status(LINT)
    expect(r.text).toContain("(rev 7, render penuh boleh)")
  })
})
