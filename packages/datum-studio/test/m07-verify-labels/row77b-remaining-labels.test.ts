// @ts-nocheck row77b: mcp-harness is a vitest-typed ported helper run under bun:test; checked at run time.
// Swarm 1.2.6 row 77b (M-07 remainder of row 77, U5): the three remaining verification lines name their check family.
//   studio_write (work report) render line   VS write-tools.ts resultOutput   -> FILE_VERIFIED(sha256) / FILE_UNVERIFIED(sha256)
//   client-document render line              VS write-client-run.ts clientOutput -> FILE_VERIFIED(sha256) / FILE_UNVERIFIED(sha256)
//     (both report the R10 HEAD `x-studio-sha256-verified` sha check, not a page verdict)
//   OUTPUT_UNVERIFIED done-gate refusal header MH mission/tool-result.ts refusal -> RENDER_UNVERIFIED(U24) (U24 page verdict)
// and no bare terverifikasi / TERVERIFIKASI / VERIFIED / UNVERIFIED appears in those lines.
// Red at BASE e363918a69: the lines say "terverifikasi" / "terverifikasi server" / "BELUM terverifikasi" /
// "per keluaran belum terverifikasi".
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { beforeEach, describe, expect, it } from "bun:test"
import { connect, logs, studioMock } from "../ported/mcp/mcp-harness"
import { FILE, FINAL } from "../ported/draft/r3-stateful-harness"
import { clientOutput } from "../../vendor/scripts/studio/mcp/write-client-run"
import { refusal } from "../../src/mcp-host/mission/tool-result"

const SHA = "0123456789abcdef".repeat(4)
/** A verification word with no family label in front: (TER)VERIFIKASI in any case, or VERIFIED/UNVERIFIED not inside `<FAMILY>_..(..)`. */
const BARE = /terverifikasi|(?<![A-Z_])(UN)?VERIFIED(?!\()/i
const textOf = (r: { content: { type: string; text: string }[] }) => r.content.map((c) => c.text).join("\n")

const SECTIONS = [
  { heading: "Summary", blocks: ["Semua tugas 77b selesai."] },
  { heading: "Rincian Pekerjaan", blocks: [[["Judul", "Status", "Bukti"], ["Label M-07", "selesai", "uji 77b"]]] },
  { heading: "Bukti", blocks: [{ list: ["bun test lulus"] }] },
  { heading: "Risks", blocks: ["Tidak ada."] },
  { heading: "Langkah berikut", blocks: ["Tidak ada."] },
]
const env = { STUDIO_AGENT_ID: "cod-row77b", STUDIO_MCP_TOOLSETS: "write" }

describe("M-07 studio_write work-report render line (VS write-tools.ts)", () => {
  beforeEach(() => {
    logs.length = 0
  })

  // Only the passed branch is reachable end to end: a failed R10 sha check makes the submit path refuse with
  // VERIFY_FAILED before resultOutput runs; the FILE_UNVERIFIED(sha256) branch of that line is the same ternary.
  for (const verified of [true]) {
    it(`sha check passed -> berkas line carries FILE_VERIFIED(sha256)`, async () => {
      const m = studioMock({ ["HEAD /api/studio/files/" + FILE]: () => ({ status: 200, headers: { "x-studio-final-filename": FINAL, "x-studio-sha256-verified": String(verified), "x-studio-sha256": SHA } }) })
      const { call } = await connect({ fetch: m.f, env, config: { now: undefined } })
      const r = await call("studio_write", { mission: "2026-11-12_row77b", docKey: "lap-row77b", sections: SECTIONS, detail: true })
      expect(r.isError, r.text).toBeFalsy()
      const line = r.text.split("\n").find((l: string) => l.startsWith("berkas: "))
      expect(line, r.text).toBeDefined()
      expect(line).toContain(verified ? "FILE_VERIFIED(sha256)" : "FILE_UNVERIFIED(sha256)")
      expect(line).not.toMatch(BARE)
    }, 15_000)
  }
})

describe("M-07 client-document render line (VS write-client-run.ts clientOutput)", () => {
  const fin = (verified: boolean) => ({ completeness: { status: "COMPLETE", missingRequired: 0 }, render: { fileId: "file-77b", format: "DOCX", sha256: SHA, verified, bytes: 10 }, renderError: null })
  for (const verified of [true, false]) {
    it(`sha check ${verified ? "passed" : "failed"} -> ${verified ? "FILE_VERIFIED" : "FILE_UNVERIFIED"}(sha256)`, () => {
      const o = clientOutput("studio_write", "doc-77b", "N-1", 1, "dibuat", fin(verified), [], {}, null, true)
      const line = o.text.split("\n").find((l: string) => l.startsWith("berkas: "))
      expect(line, o.text).toBe(`berkas: file-77b DOCX sha256 ${SHA.slice(0, 16)} ${verified ? "FILE_VERIFIED(sha256)" : "FILE_UNVERIFIED(sha256)"}`)
      expect(line).not.toMatch(BARE)
    })
  }
})

describe("M-07 done-gate refusal header (MH mission/tool-result.ts refusal OUTPUT_UNVERIFIED)", () => {
  it("names the per-output section RENDER_UNVERIFIED(U24)", () => {
    const details = {
      deliverables: [
        {
          documentId: "doc-77b",
          docKey: "row-77b-laporan",
          outputs: [{ outputId: "o-pdf", format: "PDF", state: "unverified", checks: [{ id: "PAGE_COUNT", status: "UNKNOWN", reason: "BRIDGE_UNAVAILABLE" }] }],
        },
      ],
    }
    const r = refusal("studio_mission_update_row", "OUTPUT_UNVERIFIED", "keluaran belum lolos verifikasi halaman", details)
    const t = textOf(r)
    const header = t.split("\n").find((l: string) => l.startsWith("periksa ("))
    expect(header, t).toBe("periksa (per keluaran RENDER_UNVERIFIED(U24)):")
    expect(header).not.toMatch(BARE)
  })
})
