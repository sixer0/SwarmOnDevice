// Swarm 1.2.7 row 35 (N7-099; AC-N4, AC-N5 host half, AC-M03): the studio_render text says why an html output was
// added (N-4, N7-064), marks page images as witnesses (N-5, N7-140) and carries the full sha256 of every output plus
// a per-code FAIL count (M-03/M-08, N7-065). Host cases run through the REAL Studio host (AccSession of
// test/acceptance/session_115.acc.ts, bridge:false, mission guard on); unit cases call verificationLines directly.
// Synthetic fixtures only (test/fixtures/syn127, row 20). Needs the command sandbox off (loopback listen):
//   cd packages/datum-studio && bun test ./test/verify-render/rel127-n4-m03-render-text.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { AccSession, errCode, okCall, type S } from "../acceptance/session_115.acc"
import { verificationLines } from "../../src/mcp-host/verify/render-wrapper"
import type { OutputVerificationReport } from "../../src/mcp-host/verify/types"

const FIX = path.join(import.meta.dir, "..", "fixtures", "syn127")
const fixture = (name: string): S => JSON.parse(readFileSync(path.join(FIX, name), "utf8"))
const FORMATS_ADDED_HTML = "  formats added: html (measured source for verification; not a deliverable)"
const FORMATS_ADDED_SVG = "  formats added: svg (measured source for verification; not a deliverable)"
const WITNESS = "  pages are witness images (approximation of the printed page; not a deliverable)"
const SHA_RE = /sha256=[0-9a-f]{64}/g
const flat = (t: string) => String(t ?? "").replace(/\s+/g, " ")

const WORK = realpathSync(mkdtempSync(path.join(tmpdir(), "r127-35-")))
const s = new AccSession(WORK, { mission: "2026-11-13_row35" })

/** Creates the fixture document through the MCP tools (fixture $comment recipe) and returns its id. */
async function docFrom(name: string): Promise<string> {
  const f = fixture(name)
  const cr = await s.call("studio_document_create", { template: f.template, mission: s.mission, docKey: f.docKey, title: f.title, ...(f.meta ? { meta: f.meta } : {}), detail: true })
  if (!okCall(cr)) throw new Error(`document create ${f.docKey}: ${cr._text.slice(0, 400)}`)
  const id = String(cr.document?.id ?? cr.documentId)
  for (const [slot, payload] of Object.entries((f.slots ?? {}) as S)) {
    const r = await s.call("studio_slot_fill", { documentId: id, slot, payload })
    if (!okCall(r)) throw new Error(`slot ${slot}: ${errCode(r)} ${flat(r._text).slice(0, 300)}`)
  }
  for (const ch of f.chapters as S[]) {
    const r = await s.call("studio_chapter_submit", { submission: { ...ch, target: { documentId: id } }, detail: true })
    if (!okCall(r)) throw new Error(`chapter submit: ${errCode(r)} ${flat(r._text).slice(0, 300)}`)
  }
  return id
}

const out = (id: string, format: string, state: string, checks: S[], sha = "b".repeat(64)) => ({ outputId: id, format, role: "PRIMARY", figureLabel: null, sha256: sha, state, checks, pages: [] })
const check = (id: string, status: string, findings = 0, truncated = 0) => ({ id, status, basis: "self", reason: status === "UNKNOWN" ? "BRIDGE_UNAVAILABLE" : null, findings: Array.from({ length: findings }, (_, i) => ({ code: `${id}_SYN`, page: i + 1, address: null, label: null, detail: "synthetic finding" })), truncated, ms: 0 })
const report = (outputs: S[], formatsAdded: string[] = []): OutputVerificationReport =>
  ({
    $schema: "studio.output-verification/v1",
    checksVersion: 1,
    documentId: "syn127doc",
    revisionNo: 1,
    renderJobId: null,
    scope: "DOCUMENT",
    draft: false,
    layout: "paged",
    formatsAdded,
    layoutWitness: true,
    overall: outputs.every((o) => o.state === "verified") ? "verified" : "unverified",
    outputs,
    bridgeJobs: 0,
    ms: 0,
  }) as unknown as OutputVerificationReport

beforeAll(async () => {
  await s.start({ bridge: false })
  await s.openMission(["N4", "M03"])
  const tools = (await s.client.listTools()).tools
  console.log(`[row35] host tools/list (mission extension, default toolsets): ${tools.length} tools, ${Buffer.byteLength(JSON.stringify({ tools }))} B; studio_render description ${String(tools.find((t) => t.name === "studio_render")?.description ?? "").length} chars`)
}, 120_000)
beforeEach(async () => {
  await s.resetLimits()
})
afterAll(async () => {
  await s.stop()
  rmSync(WORK, { recursive: true, force: true })
}, 60_000)

describe("N-4 (AC-N4, N7-064): a docx/pdf-only render keeps the measured html and the text says why", () => {
  test("host: studio_render {formats:['docx']} names the added html in the text and in formatsAdded", async () => {
    const id = await docFrom("n4_pdf_only_doc.json")
    const rr = await s.call("studio_render", { documentId: id, formats: ["docx"] })
    console.log(`[row35] N-4 render ${errCode(rr)} text: ${flat(rr._text).slice(0, 900)}`)
    expect(okCall(rr)).toBe(true)
    expect(rr._text.split("\n")).toContain(FORMATS_ADDED_HTML)
    expect(rr.verification?.formatsAdded).toEqual(["html"])
    // The html stays a real output of the render (C3: kept, not hidden).
    expect(((rr.outputs ?? []) as S[]).map((o) => o.format).sort()).toEqual(["DOCX", "HTML"])
    const lines: string[] = String(rr._text).split("\n")
    expect(lines.indexOf(FORMATS_ADDED_HTML)).toBe(lines.findIndex((l) => l.startsWith("verification: ")) + 1)
  }, 300_000)

  test("unit: the pdf path (no bridge needed) prints the line right after the verification line", () => {
    const lines = verificationLines(report([out("o-pdf", "PDF", "verified", [check("LINT", "PASS")]), out("o-html", "HTML", "verified", [check("LINT", "PASS")])], ["html"]), { made: 0, reason: null }, ["html"])
    expect(lines[0].startsWith("verification: ")).toBe(true)
    expect(lines[1]).toBe(FORMATS_ADDED_HTML)
    const svg = verificationLines(report([out("o-png", "PNG", "verified", [check("LINT", "PASS")])], ["svg"]), { made: 0, reason: null })
    expect(svg).toContain(FORMATS_ADDED_SVG)
  })

  test("CHAR: nothing added, no formats-added line", () => {
    const lines = verificationLines(report([out("o-html", "HTML", "verified", [check("LINT", "PASS")])]), { made: 0, reason: null })
    expect(lines.some((l) => l.includes("formats added"))).toBe(false)
  })
})

describe("N-5 (AC-N5 host half, N7-140): page images are named as witnesses in the text", () => {
  test("fixture report with 2 page images: the witness line follows the pages line", () => {
    const rep = fixture("n5_page_witness_report.json").report as OutputVerificationReport
    const lines = verificationLines(rep, { made: 2, reason: null })
    const i = lines.findIndex((l) => l.startsWith("  pages: "))
    expect(i).toBeGreaterThan(0)
    expect(lines[i + 1]).toBe(WITNESS)
  })

  test("CHAR: no page image, no witness line", () => {
    const lines = verificationLines(report([out("o-html", "HTML", "verified", [check("LINT", "PASS")])]), { made: 0, reason: "not made" })
    expect(lines).not.toContain(WITNESS)
  })
})

describe("M-03/M-08 (AC-M03, N7-065): full sha256 per output and a per-code FAIL count in the text", () => {
  test("host: an unverified html (EMPTY_SLOTS) prints sha256=<64 hex> per output and fail per code", async () => {
    const f = fixture("m03_render_fail_doc.json")
    const id = await docFrom("m03_render_fail_doc.json")
    const rr = await s.call("studio_render", { documentId: id, formats: ["html"] })
    console.log(`[row35] M-03 render ${errCode(rr)} text: ${flat(rr._text).slice(0, 1200)}`)
    expect(okCall(rr)).toBe(true)
    const outputs = (rr.outputs ?? []) as S[]
    expect(outputs.length).toBe(f.expected.outputs)
    const shas = rr._text.match(SHA_RE) ?? []
    console.log(`[row35] M-03 full sha in text ${shas.length}, outputs ${outputs.length}`)
    expect(shas.length).toBe(outputs.length)
    // The text sha is the verified output's sha (structuredContent.verification unchanged in shape).
    for (const v of (rr.verification?.outputs ?? []) as S[]) expect(rr._text).toContain(`sha256=${v.sha256}`)
    const m = /^ {2}fail per code \(summed over outputs\): (.+)$/m.exec(rr._text) // INTENT row 48b (M2-05): labelled
    expect(m).not.toBeNull()
    const n = Number(new RegExp(`(?:^|, )${f.expected.failCode}=(\\d+)`).exec(m![1])?.[1] ?? 0)
    expect(n).toBeGreaterThanOrEqual(1)
  }, 300_000)

  test("unit: counts sum findings + truncated per FAIL check, minimum 1, sorted by n desc then id; '-' when nothing fails", () => {
    const rep = report([
      out("o1", "HTML", "unverified", [check("EMPTY_SLOTS", "FAIL", 2, 1), check("FIGURE_FIT", "FAIL", 0, 0), check("LINT", "PASS")]),
      out("o2", "PDF", "unverified", [check("FIGURE_FIT", "FAIL", 1, 0), check("OVERLAP_CLIP", "UNKNOWN")], "not-a-sha"),
    ])
    const lines = verificationLines(rep, { made: 0, reason: null })
    expect(lines).toContain("  fail per code (summed over outputs): EMPTY_SLOTS=3, FIGURE_FIT=2") // INTENT row 48b (M2-05)
    expect(lines.filter((l) => /sha256=/.test(l))).toHaveLength(1)
    expect(lines).toContain(`  HTML o1 RENDER_UNVERIFIED(U24) fail=EMPTY_SLOTS,FIGURE_FIT unknown=- sha256=${"b".repeat(64)}`)
    const ok = verificationLines(report([out("o3", "HTML", "verified", [check("LINT", "PASS")])]), { made: 0, reason: null })
    expect(ok).toContain(`  HTML o3 RENDER_VERIFIED(U24) sha256=${"b".repeat(64)}`)
    expect(ok).toContain("  fail per code (summed over outputs): -") // INTENT row 48b (M2-05)
  })

  // Swarm 1.2.7 row 48b (M2-05, AC-M03): the count is summed over outputs, and the line says so. One empty slot
  // rendered as HTML and PDF prints EMPTY_SLOTS=2. Red at HEAD before row 48b: the line read "fail per code: ...".
  test("M2-05: the per-code line is labelled as summed over outputs", () => {
    const rep = report([
      out("o1", "HTML", "unverified", [check("EMPTY_SLOTS", "FAIL", 1, 0)]),
      out("o2", "PDF", "unverified", [check("EMPTY_SLOTS", "FAIL", 1, 0)]),
    ])
    const lines = verificationLines(rep, { made: 0, reason: null })
    expect(lines).toContain("  fail per code (summed over outputs): EMPTY_SLOTS=2")
    expect(lines.some((l) => /^ {2}fail per code: /.test(l))).toBe(false)
  })
})
