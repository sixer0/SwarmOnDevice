// 1.2.6 row FX-7 item d (M2 S6; follow-up of row 49 / T-14): the full finding list a lint check stores on its summary
// row (`findingsAll`) is bounded: at most 2000 entries, each detail at most 300 characters, with a truncation marker
// (`findingsTotal`, `findingsNotStored`) when the check found more. studio_document_status `findings` still pages
// what is stored and states the real total; `detail=true` lintReport no longer echoes the stored list (count only).
// The 145-finding T-14 acceptance (row49 test file) is unchanged.
import { beforeAll, describe, expect, test } from "bun:test"
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { connect, reply } from "../ported/mcp/mcp-harness"
import { canonicalTemplate, makeDoc, snapshotOf } from "../ported/engine-core/fixtures"
import { findings, makeCtx, toIssues } from "../../vendor/src/lib/studio/engine/lint/structure/context"

const DOC = "cmvdoc0000000000000000fx7"
const STORED_MAX = 2000 // literal: the red run at HEAD must fail on assertions, not on a missing export
const DETAIL_MAX = 300
const N = 6000

type Rec = Record<string, any>
let LINT: Rec
let summary: Rec

beforeAll(() => {
  const snap = snapshotOf(makeDoc({ tier: "SERAH" }) as never)
  const ctx = makeCtx(snap, canonicalTemplate(), "SERAH")
  const list = Array.from({ length: N }, (_, i) => ({ detail: `temuan ${i} ${"x".repeat(1000)}` }))
  const issues = toIssues(ctx, "D01", findings(list, "ok")) as Rec[]
  summary = issues.find((r) => Array.isArray(r.findingsAll))!
  LINT = { tier: "SERAH", releaseStatus: "FAIL", banner: "x", checks: issues }
})

async function status(args: Rec) {
  const body = {
    document: { id: DOC, docNumber: "fx7/GSP/KT/XI/2026", title: "Dokumen FX-7", currentRevisionNo: 2, releaseStatus: "FAIL" },
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
  const { call } = await connect({ fetch: f as never, env: { STUDIO_AGENT_ID: "cod-fx7" } })
  return call("studio_document_status", { documentId: DOC, ...args })
}

describe("FX-7 d (M2 S6): stored findingsAll is bounded", () => {
  test("6000 findings: summary row stores 2000 entries, details cut to 300 chars, total and not-stored count kept", () => {
    expect(summary.findingsAll.length).toBe(STORED_MAX)
    expect(summary.findingsTotal).toBe(N)
    expect(summary.findingsNotStored).toBe(N - STORED_MAX)
    expect(Math.max(...summary.findingsAll.map((f: Rec) => String(f.detail).length))).toBeLessThanOrEqual(DETAIL_MAX)
    expect(summary.findingsAll[STORED_MAX - 1].detail.startsWith(`temuan ${STORED_MAX - 1} `)).toBe(true)
    expect(JSON.stringify(summary.findingsAll).length).toBeLessThan(STORED_MAX * (DETAIL_MAX + 120))
  })

  test("status findings: pages the stored entries and states the real total and the not-stored count", async () => {
    const last = await status({ findings: { checkId: "D01", offset: STORED_MAX - 10, limit: 100 } })
    expect(last.data.findingsPage).toMatchObject({ checkId: "D01", total: STORED_MAX, returned: 10, nextOffset: null, truncated: { total: N, notStored: N - STORED_MAX } })
    expect(last.text).toContain(`${N - STORED_MAX} tidak disimpan`)
  })

  test("detail=true lintReport carries a count, not the stored list", async () => {
    const r = await status({ detail: true })
    const rows = (r.data.lintReport?.checks ?? []) as Rec[]
    expect(rows.some((x) => Array.isArray(x.findingsAll))).toBe(false)
    expect(rows.find((x) => x.findingsAllCount !== undefined)?.findingsAllCount).toBe(STORED_MAX)
  })
})
