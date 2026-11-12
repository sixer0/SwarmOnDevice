// Swarm 1.2.6 row 78 (M-08): the default (non-detail) studio_document_status text carries the gate fields the
// model needs: status, the full sha256 of every listed output, the FAIL count per check code, and the output file
// list, within DOCUMENT_STATUS_TEXT_MAX_BYTES (8192). Long lint details stay behind detail=true.
// Before (e363918a69): text listed cap(outputs, 5) with file names only, no sha and no per-code FAIL counts.
import { describe, expect, test } from "bun:test"
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { connect, reply } from "../ported/mcp/mcp-harness"

const MAX = 8192 // DOCUMENT_STATUS_TEXT_MAX_BYTES (register N-042); literal so the red run fails on assertions.
const DOC = "cmvdoc0000000000000000078"
const hex = (i: number) => (i.toString(16).padStart(2, "0") + "0123456789abcdef".repeat(4)).slice(0, 64)
const cuid = (i: number) => `cmvout${String(i).padStart(19, "0")}`

function lintReport(detailLen: number) {
  const fail = (checkId: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ checkId, status: "FAIL", address: `${i + 1}.1`, detail: `${checkId} temuan ${i}: ${"x".repeat(detailLen)}` }))
  return {
    tier: "TERBIT",
    releaseStatus: "FAIL",
    checks: [
      ...fail("D16", 3),
      ...fail("DATUM-37", 20),
      ...fail("D18", 1),
      ...fail("DATUM-14", 6),
      { checkId: "DATUM-15", status: "PASS", detail: "ok" },
      { checkId: "D19", status: "NOT_RUN", detail: "off" },
    ],
  }
}

function outputs(n: number, nameLen: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: cuid(i),
    format: i % 2 === 0 ? "PDF" : "DOCX",
    role: "PRIMARY",
    scope: { kind: "DOCUMENT" },
    draft: false,
    lintVerdict: "FAIL",
    finalFileName: `Laporan ${"N".repeat(nameLen)} 0${i}-GSP RevA rev3.${i % 2 === 0 ? "pdf" : "docx"}`,
    sha256: hex(i),
    bytes: 1000 + i,
    relPath: "rahasia/path",
  }))
}

async function status(outs: unknown[], lint: unknown, detail = false) {
  const body = {
    document: { id: DOC, docNumber: "078/GSP/KT/XI/2026", title: "Laporan M-08", currentRevisionNo: 3, releaseStatus: "PENDING" },
    revision: { revisionNo: 3 },
    completeness: { status: "COMPLETE" },
    outputs: outs,
    lint,
  }
  const f = async (url: string) =>
    reply(
      new URL(url).pathname.endsWith("/completeness")
        ? { status: 200, body: { documentId: DOC, completeness: { status: "COMPLETE", revisionNo: 3, fullRenderAllowed: true, slots: [], missingRequired: [], nextSteps: [] } } }
        : { status: 200, body },
    )
  const { call } = await connect({ fetch: f as never, env: { STUDIO_AGENT_ID: "cod-078" } })
  return call("studio_document_status", { documentId: DOC, ...(detail ? { detail: true } : {}) })
}

describe("row 78 M-08: default studio_document_status text", () => {
  test("12 outputs: status, every full sha, FAIL count per code and every file name; within 8192 bytes", async () => {
    const outs = outputs(12, 8)
    const r = await status(outs, lintReport(400))
    const bytes = Buffer.byteLength(r.text, "utf8")
    console.log(`[row78] 12 outputs: ${bytes} bytes`)
    expect(bytes).toBeLessThanOrEqual(MAX)
    // status: document release status and lint verdict
    expect(r.text).toMatch(/status: rilis PENDING; lint FAIL/)
    // FAIL count per check code (whole revision lint)
    expect(r.text).toContain("FAIL per kode: DATUM-37=20, DATUM-14=6, D16=3, D18=1")
    for (const o of outs) {
      expect(r.text).toContain(`${o.id} ${o.format} DOCUMENT lint ${o.lintVerdict} sha256 ${o.sha256}`)
      expect(r.text).toContain(o.finalFileName)
    }
    expect(r.text).not.toContain("rahasia/path")
    // detail keeps everything
    const d = await status(outs, lintReport(400), true)
    expect(d.data.lint.findings).toHaveLength(31) // 30 FAIL + 1 NOT_RUN (detail lists NOT_RUN too)
    expect(d.data.outputs).toHaveLength(12)
  })

  test("50 outputs with long names and long lint details: capped at 8192 bytes, every listed sha is full, marker names detail=true", async () => {
    const outs = outputs(50, 60)
    const r = await status(outs, lintReport(2000))
    const bytes = Buffer.byteLength(r.text, "utf8")
    console.log(`[row78] 50 outputs: ${bytes} bytes`)
    expect(bytes).toBeLessThanOrEqual(MAX)
    expect(r.text).toContain("FAIL per kode: DATUM-37=20, DATUM-14=6, D16=3, D18=1")
    // every sha256 printed is a full 64-hex value, and at least the first outputs are listed
    const shas = [...r.text.matchAll(/sha256 (\S+)/g)].map((m) => m[1])
    expect(shas.length).toBeGreaterThan(5)
    for (const s of shas) expect(s).toMatch(/^[0-9a-f]{64}$/)
    expect(r.text).toContain(outs[0]!.sha256)
    if (shas.length < 50) expect(r.text).toMatch(new RegExp(`\\+${50 - shas.length} berkas lain; detail=true`))
    // long lint details are not in the default text
    expect(r.text).not.toContain("x".repeat(400))
  })

  test("50 short outputs: all 50 listed with full sha and file name", async () => {
    const outs = outputs(50, 0).map((o, i) => ({ ...o, id: `f${i}`, finalFileName: `L ${i}.pdf` }))
    const r = await status(outs, lintReport(100))
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(MAX)
    for (const o of outs) {
      expect(r.text).toContain(`sha256 ${o.sha256}`)
      expect(r.text).toContain(o.finalFileName)
    }
    expect(r.data.outputs).toHaveLength(50)
  })
})
