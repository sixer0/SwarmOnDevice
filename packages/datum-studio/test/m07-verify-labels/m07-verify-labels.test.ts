// @ts-nocheck row77: mcp-harness is a vitest-typed ported helper run under bun:test; checked at run time.
// Swarm 1.2.6 row 77 (M-07, N-037..N-040, U5): every verification line names its check family.
//   studio_file_verify (sha/disk check)   -> `berkas <id>: FILE_VERIFIED(sha256) <64 hex>` (FILE_UNVERIFIED(sha256) otherwise)
//   studio_render verdict (U24 page check) -> `verification: RENDER_VERIFIED(U24) ...`, per output `RENDER_VERIFIED(U24)` /
//                                             `RENDER_UNVERIFIED(U24) fail=... unknown=...`
// and no bare TERVERIFIKASI / VERIFIED / UNVERIFIED appears in those texts.
// Red at BASE e363918a69: the file line says "TERVERIFIKASI (sha256 <16 hex>)" and the render lines say "VERIFIED"/"UNVERIFIED".
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { beforeEach, describe, expect, it } from "bun:test"
import { connect, logs, studioMock, FILE_ID } from "../ported/mcp/mcp-harness"
import { FINAL } from "../ported/draft/r3-stateful-harness"
import { verificationLines } from "../../src/mcp-host/verify/render-wrapper"
import type { OutputVerificationReport, VerifiedOutput, VerifyCheck } from "../../src/mcp-host/verify/types"

const SHA = "0123456789abcdef".repeat(4)
/** A verification word with no family label in front: TERVERIFIKASI, or VERIFIED/UNVERIFIED not inside `<FAMILY>_..(..)`. */
const BARE = /TERVERIFIKASI|terverifikasi|(?<![A-Z_])(UN)?VERIFIED(?!\()/

const pass = (id: string): VerifyCheck => ({ id, status: "PASS" }) as unknown as VerifyCheck
const out = (format: VerifiedOutput["format"], id: string, checks: VerifyCheck[]): VerifiedOutput =>
  ({
    outputId: id,
    format,
    role: "PRIMARY",
    figureLabel: null,
    sha256: "a".repeat(64),
    state: checks.every((c) => c.status === "PASS" || c.status === "NOT_APPLICABLE") ? "verified" : "unverified",
    checks,
    pages: [],
  }) as unknown as VerifiedOutput
const report = (outputs: VerifiedOutput[]): OutputVerificationReport =>
  ({
    $schema: "studio.output-verification/v1",
    checksVersion: 1,
    documentId: "doc77",
    revisionNo: 1,
    renderJobId: null,
    scope: "DOCUMENT",
    draft: false,
    layout: "paged",
    formatsAdded: [],
    layoutWitness: true,
    overall: outputs.every((o) => o.state === "verified") ? "verified" : "unverified",
    outputs,
  }) as unknown as OutputVerificationReport
const lines = (v: VerifiedOutput[]) => verificationLines(report(v), { made: 0, reason: null })

describe("M-07 render verdict labels (MH verify/render-wrapper.ts verificationLines)", () => {
  it("all outputs verified: summary and every output line carry RENDER_VERIFIED(U24)", () => {
    const t = lines([out("HTML", "o-html", [pass("LINT")]), out("PDF", "o-pdf", [pass("LINT")])])
    expect(t[0]).toBe("verification: RENDER_VERIFIED(U24) (2/2 outputs verified)")
    expect(t).toContain("  HTML o-html RENDER_VERIFIED(U24)")
    expect(t).toContain("  PDF o-pdf RENDER_VERIFIED(U24)")
    for (const l of t) expect(l, l).not.toMatch(BARE)
  })

  it("an unverified output: summary and its line carry RENDER_UNVERIFIED(U24), the checks stay on the line", () => {
    const bad = out("DOCX", "o-docx", [{ id: "LINT", status: "FAIL", findings: [] } as unknown as VerifyCheck, { id: "PAGE_COUNT", status: "UNKNOWN", reason: "BRIDGE_UNAVAILABLE" } as unknown as VerifyCheck])
    const t = lines([out("HTML", "o-html", [pass("LINT")]), bad])
    expect(t[0]).toBe("verification: RENDER_UNVERIFIED(U24) (1/2 outputs verified)")
    expect(t).toContain("  HTML o-html RENDER_VERIFIED(U24)")
    expect(t).toContain("  DOCX o-docx RENDER_UNVERIFIED(U24) fail=LINT unknown=PAGE_COUNT:BRIDGE_UNAVAILABLE")
    for (const l of t) expect(l, l).not.toMatch(BARE)
  })
})

describe("M-07 file check label (VS tools.ts studio_file_verify)", () => {
  beforeEach(() => {
    logs.length = 0
  })

  it("prints FILE_VERIFIED(sha256) with the full 64-hex sha and no bare TERVERIFIKASI", async () => {
    const m = studioMock({ ["HEAD /api/studio/files/" + FILE_ID]: () => ({ status: 200, headers: { "x-studio-final-filename": FINAL, "x-studio-sha256-verified": "true", "x-studio-sha256": SHA } }) })
    const { call } = await connect({ fetch: m.f, env: { STUDIO_AGENT_ID: "cod-row77", STUDIO_MCP_TOOLSETS: "write" } })
    const r = await call("studio_file_verify", { fileId: FILE_ID })
    expect(r.isError, r.text).toBeFalsy()
    expect(r.text).toContain(`berkas ${FILE_ID}: FILE_VERIFIED(sha256) ${SHA}`)
    expect(r.text).not.toMatch(BARE)
    expect(r.data.verified).toBe(true)
  }, 10_000)

  it("a sha header that is not 64 hex is never printed: FILE_VERIFIED(sha256) -", async () => {
    const m = studioMock({ ["HEAD /api/studio/files/" + FILE_ID]: () => ({ status: 200, headers: { "x-studio-final-filename": FINAL, "x-studio-sha256-verified": "true", "x-studio-sha256": "zz" } }) })
    const { call } = await connect({ fetch: m.f, env: { STUDIO_AGENT_ID: "cod-row77", STUDIO_MCP_TOOLSETS: "write" } })
    const r = await call("studio_file_verify", { fileId: FILE_ID })
    expect(r.text).toContain(`berkas ${FILE_ID}: FILE_VERIFIED(sha256) -`)
    expect(r.text).not.toMatch(BARE)
  }, 10_000)
})
