// Swarm 1.2.7 row 39 (N-9, N7-105; 01c N-9 and T-11 text, AC-N9): the studio_figure_preview description says that
// png needs standalone: true and downloadDir (N7-070), the studio_figure_revise description names the flow-direction
// route (N7-072), and the default tools/list (reports, documents, query) stays under both pins: < 30 000 B
// (row99-g06-descriptions.test.ts) and < 30 500 B (mcp-doc-tools.test.ts). Text was shortened, no pin moved (C12 O-2).
// Red at 04067a9d02: the preview description ends `png: +PNG.`; the revise description has no `Arah alur`.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { describe, expect, test } from "bun:test"
import { TOOLS } from "../../vendor/scripts/studio/mcp/tools"
import { connect } from "../ported/mcp/mcp-harness"

const d = (name: string): string => TOOLS.find((t) => t.name === name)!.description

describe("N-9 / T-11 tool descriptions (row 39)", () => {
  test("studio_figure_preview: png only together with standalone: true and downloadDir (N7-070)", () => {
    expect(d("studio_figure_preview")).toContain("png: +PNG, hanya bersama standalone: true dan downloadDir")
  })

  test("studio_figure_revise: flow direction through patch.spec; top-level direction refused (N7-072)", () => {
    expect(d("studio_figure_revise")).toContain('Arah alur: patch {spec:{direction:"LR"}} (TB/LR); kunci direction di tingkat atas ditolak.')
  })

  test("both descriptions stay <= 450 characters", () => {
    for (const n of ["studio_figure_preview", "studio_figure_revise"]) expect(d(n).length).toBeLessThanOrEqual(450)
  })

  test("default tools/list (reports,documents,query) < 30 000 B and < 30 500 B; documents alone < 19 000 B", async () => {
    const all = await connect({ env: { STUDIO_MCP_TOOLSETS: "reports,documents,query" } })
    const bytes = Buffer.byteLength(JSON.stringify(await all.client.listTools()))
    expect(bytes).toBeLessThan(30_000)
    expect(bytes).toBeLessThan(30_500)
    const docs = await connect({ env: { STUDIO_MCP_TOOLSETS: "documents" } })
    expect(Buffer.byteLength(JSON.stringify(await docs.client.listTools()))).toBeLessThan(19_000)
  })
})
