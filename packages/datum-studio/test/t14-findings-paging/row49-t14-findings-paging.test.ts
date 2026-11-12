// Swarm 1.2.6 row 49 (T-14, flow F5): studio_document_status pages the full finding list of one lint check.
// Fixture: test/fixtures/anon126/t14_k1.ts (145 decision-bearing "8,8" prose units over 3 chapters, empty register),
// wrapped here into a SERAH document; the real structure lint (D01 audit) gives the lint report the status tool reads.
// Before (e363918a69): the engine kept 100 D01 findings plus one summary row ("45 temuan lain tidak dirinci
// (plafon 100 per cek)") and studio_document_status had no `findings` parameter (refused by the input schema).
import { beforeAll, describe, expect, test } from "bun:test"
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { connect, reply } from "../ported/mcp/mcp-harness"
import { canonicalTemplate, makeDoc, snapshotOf } from "../ported/engine-core/fixtures"
import { lintStructure, STRUCTURE_CHECKS } from "../../vendor/src/lib/studio/engine/lint/structure"
import { makeCtx } from "../../vendor/src/lib/studio/engine/lint/structure/context"
import { d01Chapters, D01_CHAPTERS, D01_TOTAL } from "../fixtures/anon126/t14_k1"

const DOC = "cmvdoc0000000000000000049"
const PAGE_MAX = 500 // LINT_FINDINGS_PAGE_MAX (register N-035); literal so the red run fails on assertions.

type Rec = Record<string, any>

function d01Doc() {
  const doc = makeDoc({ tier: "SERAH" }) as unknown as Rec
  doc.chapters = d01Chapters().map((c) => ({
    title: { text: c.title },
    sections: [{ title: { text: "Uraian bagian" }, blocks: c.paragraphs.map((p) => ({ type: "paragraph", text: p })) }],
  }))
  return doc
}

let LINT: Rec
let ENGINE: Array<{ pointer?: string; detail: string }>

beforeAll(() => {
  const tpl = canonicalTemplate()
  const snap = snapshotOf(d01Doc() as never)
  // The engine's own D01 finding list (no cap): what paging must return in full.
  const out = STRUCTURE_CHECKS.D01!(makeCtx(snap, tpl, "SERAH"))
  ENGINE = out.kind === "findings" ? out.findings : []
  LINT = { tier: "SERAH", releaseStatus: "FAIL", banner: "x", checks: lintStructure(snap, tpl, "SERAH") }
})

async function status(args: Rec) {
  const body = {
    document: { id: DOC, docNumber: "049/GSP/KT/XI/2026", title: "Dokumen D01 T-14", currentRevisionNo: 2, releaseStatus: "FAIL" },
    revision: { revisionNo: 2 },
    completeness: { status: "COMPLETE" },
    outputs: [],
    lint: LINT,
  }
  const f = async (url: string) =>
    reply(
      new URL(url).pathname.endsWith("/completeness")
        ? { status: 200, body: { documentId: DOC, completeness: { status: "COMPLETE", revisionNo: 2, fullRenderAllowed: true, slots: [], missingRequired: [], nextSteps: [] } } }
        : { status: 200, body },
    )
  const { call } = await connect({ fetch: f as never, env: { STUDIO_AGENT_ID: "cod-049" } })
  return call("studio_document_status", { documentId: DOC, ...args })
}

const key = (f: { pointer?: string | null; detail?: string }) => `${f.pointer ?? ""}|${f.detail ?? ""}`

describe("row 49 T-14: findings paging in studio_document_status", () => {
  test("fixture: the engine D01 list has exactly 145 findings over 3 chapters; the summary cap stays 100", () => {
    expect(ENGINE).toHaveLength(D01_TOTAL)
    const chapters = new Set(ENGINE.map((f) => /^\/chapters\/(\d+)\//.exec(f.pointer ?? "")?.[1]))
    expect(chapters.size).toBe(D01_CHAPTERS)
    const d01 = (LINT.checks as Rec[]).filter((c) => c.checkId === "D01")
    expect(d01).toHaveLength(101) // 100 itemised + one summary row (E-16 unchanged)
    expect(d01.some((c) => /45 temuan lain tidak dirinci \(plafon 100 per cek\)/.test(c.detail))).toBe(true)
  })

  test("all 145 D01 findings retrievable: page 100 then 45 with nextOffset null; union equals the engine list", async () => {
    const p1 = await status({ findings: { checkId: "D01", offset: 0, limit: 100 } })
    expect(p1.data.ok).not.toBe(false)
    expect(p1.data.findingsPage).toEqual({ checkId: "D01", chapter: null, total: 145, offset: 0, returned: 100, nextOffset: 100 })
    expect(p1.data.findings).toHaveLength(100)
    const p2 = await status({ findings: { checkId: "D01", offset: 100, limit: 100 } })
    expect(p2.data.ok).not.toBe(false)
    expect(p2.data.findingsPage).toEqual({ checkId: "D01", chapter: null, total: 145, offset: 100, returned: 45, nextOffset: null })
    expect(p2.data.findings).toHaveLength(45)
    const all = [...p1.data.findings, ...p2.data.findings] as Rec[]
    expect(new Set(all.map((f) => f.id)).size).toBe(145)
    expect(new Set(all.map(key))).toEqual(new Set(ENGINE.map(key)))
    for (const f of all) {
      expect(f.checkId).toBe("D01")
      expect(f.status).toBe("FAIL")
      expect(f.detail).toContain("8,8")
    }
    // the page also reaches the text (inside the untrusted status block)
    expect(p2.text).toContain("temuan D01 145")
    expect(p2.text).toContain(String((p2.data.findings as Rec[])[44]!.id))
  })

  test("chapter filter: exact chapter key, every returned finding in that chapter, totals sum to 145", async () => {
    let sum = 0
    for (const ch of ["1", "2", "3"]) {
      const r = await status({ findings: { checkId: "D01", chapter: ch, limit: PAGE_MAX } })
      expect(r.data.ok).not.toBe(false)
      const page = r.data.findingsPage as Rec
      expect(page.chapter).toBe(ch)
      expect(page.returned).toBe(page.total)
      expect(page.nextOffset).toBeNull()
      const want = ENGINE.filter((f) => (f.pointer ?? "").startsWith(`/chapters/${Number(ch) - 1}/`))
      expect(page.total).toBe(want.length)
      for (const f of r.data.findings as Rec[]) expect(f.chapter).toBe(ch)
      expect(new Set((r.data.findings as Rec[]).map(key))).toEqual(new Set(want.map(key)))
      sum += page.total
    }
    expect(sum).toBe(145)
    const none = await status({ findings: { checkId: "D01", chapter: "9" } })
    expect(none.data.findingsPage).toEqual({ checkId: "D01", chapter: "9", total: 0, offset: 0, returned: 0, nextOffset: null })
  })

  test("limit 501 is refused; limit 500 is accepted; the default status (no findings) is unchanged", async () => {
    // refusal = recoverable result (ok:false, INVALID_ARGUMENT) naming the limit pointer, no page returned
    const bad = await status({ findings: { checkId: "D01", limit: PAGE_MAX + 1 } })
    expect(bad.data.ok).toBe(false)
    expect(bad.data.code).toBe("INVALID_ARGUMENT")
    expect(JSON.stringify(bad.data.error.details)).toContain("/findings/limit")
    expect(bad.data.findingsPage).toBeUndefined()
    const ok = await status({ findings: { checkId: "D01", limit: PAGE_MAX } })
    expect(ok.data.ok).not.toBe(false)
    expect(ok.data.findingsPage.returned).toBe(145)
    const plain = await status({})
    expect(plain.isError).toBeFalsy()
    expect(plain.data.findingsPage).toBeUndefined()
    expect(plain.data.lint.findings.length).toBeLessThanOrEqual(5)
  })
})
