// Row 97a (G-05, W-01, W-09; 1.2.6): the `studio://resep/dokumen-klien` recipe (MCP_DOC_RECIPE).
// At e363918a69 the diagram-block sentence (row 174) was spliced into the middle of the
// `studio_figure_revise { documentId, pid, patch, ... }` sentence, so the call shape read
// "patch, Blok diagram: { ... } ... baseRevisionNo, change }". The recipe also had no caption rule
// (T-01: Studio prints GAMBAR n.m; CAPTION_TOKEN_DUPLICATE), no studio_asset_put (W-13) and no
// render-timeout follow-up (M-01: 540 s; W-09: studio_document_status before any new render).
import { describe, expect, test } from "bun:test"
import { MCP_DOC_RECIPE } from "../../vendor/scripts/studio/mcp/resources"

/** The recipe as one line per paragraph (Markdown soft breaks joined), tables and lists left out. */
function proseParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .filter((p) => !p.trimStart().startsWith("|") && !p.trimStart().startsWith("-") && !p.trimStart().startsWith("#"))
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
}

/** Sentences of a paragraph: a period followed by a space and a capital letter ends a sentence. */
const sentences = (p: string): string[] => p.split(/(?<=\.)\s+(?=[A-Z])/)

const balance = (s: string): number => [...s].reduce((n, c) => n + (c === "{" ? 1 : c === "}" ? -1 : 0), 0)

const flat = MCP_DOC_RECIPE.replace(/\s+/g, " ")

describe("row 97a G-05: dokumen-klien recipe parses into whole sentences", () => {
  test("the studio_figure_revise call shape is intact", () => {
    expect(flat).toContain("studio_figure_revise { documentId, pid, patch, baseRevisionNo, change }")
  })

  test("every prose sentence closes the braces it opens", () => {
    const broken = proseParagraphs(MCP_DOC_RECIPE)
      .flatMap(sentences)
      .filter((s) => balance(s) !== 0)
    expect(broken).toEqual([])
  })

  test("the diagram block shape is its own sentence, after the figure_revise sentence", () => {
    const revise = flat.indexOf("studio_figure_revise { documentId")
    const block = flat.indexOf("Blok diagram:")
    expect(revise).toBeGreaterThan(-1)
    expect(block).toBeGreaterThan(revise)
    expect(flat.slice(0, block).trimEnd()).toMatch(/[.)]$/)
    // row 174 pins stay true
    expect(MCP_DOC_RECIPE).toContain('type: "diagram"')
    expect(MCP_DOC_RECIPE).toMatch(/spec.*ATAU.*artifactId/)
  })
})

describe("row 97a W-01: caption rule", () => {
  test("Studio prints the label, the caption never starts with it, at most 100 characters", () => {
    expect(flat).toContain("Studio mencetak label GAMBAR n.m sendiri")
    expect(flat).toContain("caption tidak pernah diawali token itu")
    expect(flat).toContain("CAPTION_TOKEN_DUPLICATE")
    expect(flat).toMatch(/maksimal 100 karakter \(CAPTION_GUIDE_MAX_CHARS\)/)
    expect(flat).toMatch(/vonis yang menyebut pelaku dan angka/)
  })

  test("no example caption in the recipe still opens with a label token", () => {
    const captions = [...flat.matchAll(/caption:\s*\{\s*text:\s*"([^"]*)"/g)].map((m) => m[1])
    for (const c of captions) expect(c).not.toMatch(/^\s*(gambar|figure|fig\.|grafik|bagan|diagram)\s*[A-Z]?\d/i)
    expect(flat).not.toMatch(/caption[^.]*"Gambar \d/)
  })
})

describe("row 97a W-13: external images go through studio_asset_put", () => {
  test("names the tool, the sha256 reference and both block and Markdown forms", () => {
    expect(flat).toContain("studio_asset_put")
    expect(flat).toContain("sha256:<hex>")
    expect(flat).toContain('{ type: "image", asset: "sha256:<hex>"')
    expect(flat).toContain('![caption](sha256:<hex> "Sumber: ...")')
    expect(flat).toMatch(/SVG ditolak/)
  })
})

describe("row 97a W-09: render timeout follow-up", () => {
  const render = proseParagraphs(MCP_DOC_RECIPE).find((p) => p.startsWith("Render:")) ?? ""

  test("render waits 540 s; on a timeout the next call is studio_document_status, then studio_file_verify", () => {
    expect(render).toContain("540 detik (STUDIO_RENDER_CALL_TIMEOUT_MS)")
    const status = render.indexOf("studio_document_status")
    expect(status).toBeGreaterThan(render.indexOf("540 detik"))
    expect(render.indexOf("studio_file_verify", status)).toBeGreaterThan(status)
    expect(render).toMatch(/jangan mengulang studio_render secara buta/i)
  })

  test("no wait-and-poll workaround", () => {
    expect(flat).not.toMatch(/poll|tunggu lalu|sleep/i)
  })
})
