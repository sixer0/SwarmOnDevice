// @ts-nocheck row76: mcp-harness is a vitest-typed ported helper run under bun:test; checked at run time.
// Swarm 1.2.6 row 76 (M-06, E-19, E-20, U5): studio_edit accepts `change` {what, why, impact} (the same name and shape as
// studio_figure_revise) and records it in the revision history instead of dropping it with ARG_IGNORED.
//   client document: every write the edit sends (R12 chapter, R13 slot, R14 setMeta, R16 paragraph) carries the agent's change
//   work report:     every R12/R13 block the report update sends carries the agent's change
// The server keeps a sent change as given (effectiveChange -> changeAuto false), so the revision history holds it.
// Red at BASE e363918a69: normalizeEditArgs prunes `change` with ARG_IGNORED and the writes carry the automatic change.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { beforeEach, describe, expect, it } from "bun:test"
import { connect, logs, studioMock } from "../ported/mcp/mcp-harness"
import { DOC } from "../ported/draft/r3-stateful-harness"
import { clientServer, DOCID, env as cenv } from "../ported/mcp/implw3-client-mock"
import { normalizeEditArgs } from "../../vendor/scripts/studio/mcp/write-normalize"
import { effectiveChange } from "../../vendor/src/lib/studio/services/submit/change"

const AGENT = "cod-implw5"
const env = { STUDIO_AGENT_ID: AGENT, STUDIO_MCP_TOOLSETS: "write" }
const CHANGE = { what: "Ganti frasa pembuka bab 1", why: "Permintaan reviewer M-06", impact: "Bab 1 paragraf pembuka" }
const codes = (r: any) => [...(r.data.warnings ?? []), ...(r.warnings ?? [])].map((w: any) => w.code)
const isWrite = (c: any) => {
  const p = new URL(c.url).pathname
  return (c.method === "POST" || c.method === "PATCH") && /\/api\/studio\/(chapters|slots|documents\/[^/]+\/(structure|paragraphs\/[^/]+))$/.test(p)
}

beforeEach(() => {
  logs.length = 0
})

describe("M-06 normalizeEditArgs keeps change", () => {
  it("change is kept as given, no ARG_IGNORED", () => {
    const a: any = { documentId: "x", edits: [{ find: "a b c", replace: "d" }], change: { ...CHANGE } }
    const w = normalizeEditArgs(a)
    expect(a.change).toEqual(CHANGE)
    expect(w.map((x) => x.code)).not.toContain("ARG_IGNORED")
  })
})

describe("M-06 studio_edit records change in the revision history", () => {
  it("client document: the writes carry the agent change; the server keeps it (changeAuto false)", async () => {
    const m = clientServer({ exists: true })
    const { call } = await connect({ fetch: m.f as any, env: cenv })
    const r = await call("studio_edit", { documentId: DOCID, edits: [{ find: "Paragraf pembuka lama.", replace: "Paragraf pembuka baru." }], change: CHANGE })
    expect(r.data.ok, r.text).toBe(true)
    expect(codes(r)).not.toContain("ARG_IGNORED")
    const writes = m.calls.filter(isWrite)
    expect(writes.length).toBeGreaterThan(0)
    for (const c of writes) {
      expect(c.body.change).toEqual(CHANGE)
      expect(effectiveChange(c.body.change, "chapter:1", "chapter:1", AGENT)).toEqual({ change: CHANGE, changeAuto: false })
    }
  })

  it("work report: the update blocks carry the agent change", async () => {
    const m = studioMock({ [`GET /api/studio/documents/${DOC}`]: () => ({ status: 200, body: { document: { id: DOC, docNumber: "040/GSP/LAP/XI/2026", createdBy: `agent:${AGENT}`, currentRevisionNo: 6 }, revision: { revisionNo: 6 } } }) })
    const { call } = await connect({ fetch: m.f, env })
    const r = await call("studio_edit", { documentId: DOC, edits: [{ find: "Ringkasan awal", replace: "Ringkasan sesudah sunting" }], change: CHANGE })
    expect(r.data.ok, r.text).toBe(true)
    expect(codes(r)).not.toContain("ARG_IGNORED")
    const writes = m.calls.filter(isWrite)
    expect(writes.length).toBeGreaterThan(0)
    for (const c of writes) expect(c.body.change).toEqual(CHANGE)
  })

  it("without change the automatic change is unchanged (client document)", async () => {
    const m = clientServer({ exists: true })
    const { call } = await connect({ fetch: m.f as any, env: cenv })
    const r = await call("studio_edit", { documentId: DOCID, edits: [{ find: "Paragraf pembuka lama.", replace: "Paragraf pembuka baru." }] })
    expect(r.data.ok, r.text).toBe(true)
    for (const c of m.calls.filter(isWrite)) expect(c.body.change?.what).toBe("studio_edit: sunting teks/data")
  })

  it("an incomplete change is refused before any write", async () => {
    const m = clientServer({ exists: true })
    const { call } = await connect({ fetch: m.f as any, env: cenv })
    const r = await call("studio_edit", { documentId: DOCID, edits: [{ find: "Paragraf pembuka lama.", replace: "x y z" }], change: { what: "x" } })
    expect(r.data.ok).not.toBe(true)
    expect(m.calls.filter(isWrite)).toEqual([])
  })
})
