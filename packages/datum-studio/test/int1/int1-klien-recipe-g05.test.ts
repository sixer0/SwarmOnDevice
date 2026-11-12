// Swarm 1.2.6 integration pass INT-1 item 7 (row 97a follow-up, G-05 remainder): the `studio://resep/dokumen-klien`
// recipe (MCP_DOC_RECIPE) names the dual delivery gate (machine checks AND looking at the page PNG), the standalone
// preview caveat (the inline preview is the figure gate) and the figure-quota exception route (the template owner
// records figure.quota.exceptionReason). Red at e363918a69: none of the three was in the recipe.
import { describe, expect, test } from "bun:test"
import { MCP_DOC_RECIPE } from "../../vendor/scripts/studio/mcp/resources"

const flat = MCP_DOC_RECIPE.replace(/\s+/g, " ")

describe("INT-1 item 7: dokumen-klien recipe G-05 remainder", () => {
  test("dual gate: RENDER_VERIFIED(U24) and FILE_VERIFIED(sha256) AND the page PNG from pages:", () => {
    expect(flat).toMatch(/dua gerbang/)
    expect(flat).toContain("RENDER_VERIFIED(U24)")
    expect(flat).toContain("FILE_VERIFIED(sha256)")
    expect(flat).toMatch(/gerbang mata[^.]*PNG halaman[^.]*`pages:`/)
  })

  test("standalone preview caveat: the inline preview is the figure gate", () => {
    expect(flat).toMatch(/[Pp]ratinjau mandiri[^.]*tidak menggantikan[^.]*pratinjau inline/)
    // FX-10 (C19a): the shared figure-gate sentence (was "gerbang figur tetap pratinjau inline").
    expect(flat).toMatch(/Gerbang figur: gerbang mesin = pratinjau inline \(pratinjau mandiri bukan gerbang\)/)
  })

  test("figure quota: D22, figure.quota.exceptionReason through the template owner", () => {
    expect(flat).toContain("figure.quota.exceptionReason")
    expect(flat).toMatch(/D22/)
    expect(flat).toMatch(/pemilik templat/)
  })
})
