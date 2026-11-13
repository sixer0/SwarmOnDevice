// Row 98 (G-04 render/verify/lint/assets/quota parts, W-09, T-14, W-13, T-18; 1.2.6): sections 8.3-8.7 and 10.1
// of vendor/docs/STUDIO-AGENT-GUIDE.md. At e363918a69 the guide had no MCP render procedure (540 s budget, timeout
// follow-up), no FILE_VERIFIED(sha256) / RENDER_VERIFIED(U24) rule, no findings paging, no figure quota, no .bak/
// backups and no studio_asset_put. Every call shape, code, label and number quoted there is read from the HEAD code
// here, so the guide cannot drift from the tools. Modules are imported dynamically: at the base some exports are
// missing.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { useStudioEnv } from "../ported/_env"
useStudioEnv()

const ROOT = path.join(import.meta.dir, "..", "..")
const VENDOR = path.join(ROOT, "vendor")
const GUIDE = readFileSync(path.join(VENDOR, "docs", "STUDIO-AGENT-GUIDE.md"), "utf8")
const cut = (from: string, to: string) => {
  const s = GUIDE.indexOf(from)
  return s < 0 ? "" : GUIDE.slice(s, GUIDE.indexOf(to, s))
}
const RENDER = cut("### 8.3 ", "\n## 9. ")
const ASSETS = cut("### 10.1 ", "\n## 11. ")
const flat = (s: string) => s.replace(/\s+/g, " ")
const R = flat(RENDER)
const A = flat(ASSETS)
const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8")

type Schema = { properties?: Record<string, Schema & Record<string, unknown>>; required?: string[]; enum?: string[]; maximum?: number }
async function tool(name: string): Promise<Schema> {
  const { TOOLS } = await import("../../vendor/scripts/studio/mcp/tools")
  return ((TOOLS.find((t) => t.name === name)?.inputSchema ?? {}) as Schema)
}
const props = (s: Schema) => Object.keys(s.properties ?? {})

describe("row 98: sections exist in order and section 1.1 points to them", () => {
  test("8.3..8.7 sit after 8.2 and before 9; 10.1 sits inside 10", () => {
    const at = ["### 8.2 ", "### 8.3 ", "### 8.4 ", "### 8.5 ", "### 8.6 ", "### 8.7 ", "\n## 9. "].map((h) => GUIDE.indexOf(h))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(GUIDE.indexOf("### 10.1 ")).toBeGreaterThan(GUIDE.indexOf("\n## 10. Aset gambar"))
    expect(flat(GUIDE)).toContain("seksi 8.3 sampai 8.7; aset gambar: seksi 10.1")
  })
})

describe("row 98: render (W-09, M-01, M-05, T-15)", () => {
  test("studio_render call shape, enums and key rule come from the tool schema", async () => {
    const s = await tool("studio_render")
    const shape = `studio_render { ${props(s).join(", ")} }`
    expect(R).toContain(shape)
    expect(s.required).toEqual(["documentId"])
    expect(s.properties?.scope?.enum).toEqual(["document", "chapter", "slot"])
    expect(R).toContain("`scope` bernilai `document` (bawaan), `chapter`, atau `slot`")
    expect(R).toContain(`\`formats\` ⊆ ${(s.properties?.formats?.items as Schema).enum!.map((f) => `\`${f}\``).join(", ")}`)
    expect(R).toContain(`\`figures\` ⊆ ${(s.properties?.figures?.items as Schema).enum!.map((f) => `\`${f}\``).join(", ")}`)
  })

  test("540 s render budget and 60 s for other calls are the HEAD constants", async () => {
    const h = await import("../../vendor/scripts/studio/_http-client")
    expect(typeof h.STUDIO_RENDER_CALL_TIMEOUT_MS).toBe("number")
    expect(R).toContain(`sampai ${h.STUDIO_RENDER_CALL_TIMEOUT_MS / 1000} detik (\`STUDIO_RENDER_CALL_TIMEOUT_MS\`)`)
    expect(R).toContain(`tetap ${h.STUDIO_HTTP_TIMEOUT_MS / 1000} detik (\`STUDIO_HTTP_TIMEOUT_MS\`)`)
  })

  test("the timeout message quoted is the one renderTimeoutHint writes; follow-up is document_status then file_verify", async () => {
    const tools = await import("../../vendor/scripts/studio/mcp/tools")
    const { McpToolError } = await import("../../vendor/scripts/studio/mcp/safety")
    expect(typeof tools.renderTimeoutHint).toBe("function")
    const e = tools.renderTimeoutHint(new McpToolError("REMOTE_UNREACHABLE", "x", { timedOut: true } as never), "doc98") as Error
    expect(R).toContain(`\`REMOTE_UNREACHABLE\` dengan pesan \`${e.message.replace("doc98", "<id>")}\``)
    expect(R).toContain("galat MCP `-32001`")
    const steps = ["1. `studio_document_status { documentId }`", "2. Ada berkas baru: `studio_file_verify { fileId }`", "3. Tidak ada berkas baru: ulangi `studio_render` satu kali"].map((s) => R.indexOf(s))
    expect(steps.every((i) => i >= 0)).toBe(true)
    expect([...steps].sort((a, b) => a - b)).toEqual(steps)
    expect(R).toContain("Jangan mengulang `studio_render` secara buta")
    const desc = String((tools.TOOLS.find((t) => t.name === "studio_render") as { description?: string })?.description)
    expect(desc).toContain("studio_document_status lalu studio_file_verify")
  })

  test("file names always carry rev<N> (datumFileName)", async () => {
    const { datumFileName } = await import("../../vendor/src/lib/studio/services/storage/paths")
    expect(datumFileName("Judul Uji", "001/UJI/2026", "B", "pdf", 12)).toMatch(/ RevB rev12\.pdf$/)
    expect(R).toContain("`<Judul> <nomor> Rev<X> rev<N>.<ext>`")
  })

  test("a failing figure gives a placeholder and an unverified output (T-15 codes from the code)", async () => {
    const { FIGURE_PREPARE_FAILED } = await import("../../vendor/src/lib/studio/engine/docx/figures/log")
    expect(R).toContain(`\`${FIGURE_PREPARE_FAILED}\``)
    const cf = src("src/mcp-host/verify/client-findings.ts")
    for (const code of ["FIGURE_PLACEHOLDER", "PLACEHOLDER_IN_OUTPUT"]) {
      expect(cf).toContain(`${code}: {`)
      expect(R).toContain(`\`${code}\``)
    }
    expect(R).toContain("`PARTIAL`")
  })
})

describe("row 98: two meanings of verified (M-07, T-13, W-02, W-14)", () => {
  test("FILE_VERIFIED(sha256) line shape is the studio_file_verify text", () => {
    const t = src("vendor/scripts/studio/mcp/tools.ts")
    expect(t).toContain('`berkas ${fileId}: ${verified ? "FILE_VERIFIED(sha256)" : "FILE_UNVERIFIED(sha256)"} ${HEX64.test(sha) ? sha : "-"}`')
    expect(R).toContain("`berkas <id>: FILE_VERIFIED(sha256) <64 heks>`")
    expect(R).toContain("`FILE_VERIFIED(sha256)` / `FILE_UNVERIFIED(sha256)`")
  })

  test("RENDER_VERIFIED(U24) summary, failing line and coverage line match verificationLines", async () => {
    const { verificationLines } = await import("../../src/mcp-host/verify/render-wrapper")
    const { overlapCoverageText, MEASURE_BATCH_PAGES } = await import("../../src/mcp-host/verify/overlap-clip")
    const out = (id: string, checks: unknown[], state: string) => ({ outputId: id, format: "HTML", role: "PRIMARY", figureLabel: null, sha256: "a".repeat(64), state, checks, pages: [] })
    const rep = (outputs: unknown[], overall: string) => ({ $schema: "studio.output-verification/v1", checksVersion: 1, documentId: "d98", revisionNo: 1, renderJobId: null, scope: "DOCUMENT", draft: false, layout: "paged", formatsAdded: [], layoutWitness: true, overall, outputs })
    const ok = verificationLines(rep([out("o1", [{ id: "LINT", status: "PASS" }], "verified")], "verified") as never, { made: 0, reason: "x" })
    expect(ok[0]).toBe("verification: RENDER_VERIFIED(U24) (1/1 outputs verified)")
    expect(R).toContain("`verification: RENDER_VERIFIED(U24) (k/n outputs verified)`")
    expect(ok.some((l) => l.startsWith("  pages: none imaged"))).toBe(true)
    expect(R).toContain("`pages: none imaged`")
    const trunc = { id: "OVERLAP_CLIP", status: "UNKNOWN", reason: "MEASURE_TRUNCATED", coverage: { measuredPages: 40, totalPages: 60 } }
    const bad = verificationLines(rep([out("o2", [trunc], "unverified")], "unverified") as never, { made: 0, reason: "x" })
    expect(bad[0]).toBe("verification: RENDER_UNVERIFIED(U24) (0/1 outputs verified)")
    expect(bad).toContain(`  HTML o2 RENDER_UNVERIFIED(U24) fail=- unknown=OVERLAP_CLIP:MEASURE_TRUNCATED sha256=${"a".repeat(64)}`) // 1.2.7 row 35 (M-03, N7-065)
    expect(R).toContain("`<FMT> <id> RENDER_UNVERIFIED(U24) fail=<cek> unknown=<cek>`")
    expect(bad).toContain("    OVERLAP_CLIP UNKNOWN:MEASURE_TRUNCATED diukur 40/60 halaman")
    expect(overlapCoverageText({ id: "OVERLAP_CLIP", coverage: { measuredPages: 4, totalPages: 6 } })).toBe("diukur 4/6 halaman")
    expect(R).toContain("`OVERLAP_CLIP <STATUS> diukur m/n halaman`")
    expect(R).toContain("`UNKNOWN:MEASURE_TRUNCATED`")
    expect(R).toContain(`per kelompok ${MEASURE_BATCH_PAGES} halaman (\`MEASURE_BATCH_PAGES\`)`)
  })

  test("UNKNOWN is never a pass (outputState)", async () => {
    const { outputState } = await import("../../src/mcp-host/verify/verify-outputs")
    expect(outputState([{ id: "OVERLAP_CLIP", status: "UNKNOWN" }] as never)).toBe("unverified")
    expect(outputState([{ id: "X", status: "NOT_APPLICABLE" }, { id: "Y", status: "PASS" }] as never)).toBe("verified")
    expect(R).toContain("`UNKNOWN` tidak pernah dihitung lulus")
  })

  test("the rule: machine gate (both labels) plus eye gate; no bare 'terverifikasi' in reports", () => {
    expect(R).toContain("lulus dua gerbang")
    expect(R).toContain("Gerbang mesin: `RENDER_VERIFIED(U24)` di hasil render, dan `FILE_VERIFIED(sha256)`")
    expect(R).toContain("Gerbang mata: buka PNG halaman dari baris `pages:`")
    expect(R).toContain("jangan \"terverifikasi\" saja")
    expect(R).toContain("Satu label tidak pernah menggantikan yang lain")
  })

  test("standalone preview caveat: its call shape exists and it is not the gate", async () => {
    const s = await tool("studio_figure_preview")
    for (const k of ["documentId", "pid", "standalone", "downloadDir", "png"]) expect(props(s)).toContain(k)
    expect(R).toContain("`studio_figure_preview { documentId, pid, standalone: true, downloadDir, png: true }`")
    expect(R).toContain("Pratinjau mandiri tidak menggantikan pratinjau inline")
  })
})

describe("row 98: lint findings paging (T-14)", () => {
  test("findings {checkId, chapter, offset, limit}; limit max and default page from the code", async () => {
    const s = await tool("studio_document_status")
    const f = s.properties?.findings as Schema
    expect(props(f)).toEqual(["checkId", "chapter", "offset", "limit"])
    expect(f.required).toEqual(["checkId"])
    const { LINT_FINDINGS_PAGE_MAX, lintFindingsOf } = await import("../../vendor/scripts/studio/mcp/doc-tools")
    expect((f.properties?.limit as Schema).maximum).toBe(LINT_FINDINGS_PAGE_MAX)
    expect(R).toContain("``` studio_document_status { documentId, findings: { checkId, chapter, offset, limit } } ```")
    expect(R).toContain(`paling banyak ${LINT_FINDINGS_PAGE_MAX} (\`LINT_FINDINGS_PAGE_MAX\`)`)
    expect(R).toContain(`\`limit: ${LINT_FINDINGS_PAGE_MAX + 1}\` ditolak \`INVALID_ARGUMENT\``)
    expect(src("vendor/scripts/studio/mcp/doc-tools.ts")).toContain("const LINT_FINDINGS_PAGE_DEFAULT = 100;")
    expect(R).toContain("`limit` bawaan 100")
    expect(lintFindingsOf({ checks: [{ checkId: "D01", status: "FAIL", detail: "x" }] }, "D01")[0]?.id).toBe("D01#0")
    expect(R).toContain("`id` (`<checkId>#<index>`)")
  })

  test("findingsPage fields and the summary cap are the HEAD names", async () => {
    expect(src("vendor/scripts/studio/mcp/doc-tools.ts")).toMatch(/data\.findingsPage = \{ checkId, chapter, total: [^,]+, offset, returned: [^,]+, nextOffset: next \}/)
    expect(R).toContain("`findingsPage { checkId, chapter, total, offset, returned, nextOffset }`")
    expect(R).toContain("sampai `nextOffset: null`")
    const { MAX_FINDINGS_PER_CHECK } = await import("../../vendor/src/lib/studio/engine/lint/structure/context")
    expect(R).toContain(`paling banyak ${MAX_FINDINGS_PER_CHECK} temuan per cek`)
  })
})

describe("row 98: figure quota D22 (T-18 / W-10)", () => {
  const QUOTA = "figure.quota.maxPerDocument"
  const REASON = "figure.quota.exceptionReason"

  test("the quoted FAIL text is what lint D22 prints; the REPORT path with a reason", async () => {
    const { lintStructureWith } = await import("../../vendor/src/lib/studio/engine/lint/structure")
    const { canonicalTemplate, makeDoc, snapshotOf, withParams } = await import("../ported/engine-core/fixtures")
    const figs = Array.from({ length: 3 }, (_, i) => ({ type: "diagram", spec: { artifactId: `fig-${i + 1}` }, caption: { inline: { text: `Alur uji ${i + 1}.` } } }))
    const run = (p: Record<string, unknown>) =>
      lintStructureWith(snapshotOf(makeDoc({ tier: "TERBIT", blocks: figs as never })), withParams(canonicalTemplate(), p), "TERBIT", { only: ["D22"] }).filter((i) => i.checkId === "D22")
    const fail = run({ [QUOTA]: 2 })
    expect(fail.map((i) => i.status)).toEqual(["FAIL"])
    const shaped = String(fail[0]?.detail).replace(/^.*?(\d+) gambar melebihi kuota (\d+)/, "<n> gambar melebihi kuota <q>")
    expect(R).toContain(`\`${shaped}\``)
    const rep = run({ [QUOTA]: 2, [REASON]: "alasan uji" })
    expect(rep.map((i) => i.status)).toEqual(["REPORT"])
    expect(R).toContain("temuan `D22` menjadi REPORT yang mencetak alasan itu, bukan FAIL")
  })

  test("parameters: default null, counted block types, 500-char reason on the advanced surface", async () => {
    const { PARAMS_BY_KEY } = await import("../../vendor/src/lib/studio/params")
    expect(PARAMS_BY_KEY.get(QUOTA)?.default).toBeNull()
    expect(R).toContain("Bawaannya `null`, artinya tanpa kuota")
    expect(String(PARAMS_BY_KEY.get(REASON)?.pattern)).toContain("{0,500}")
    expect(R).toContain("paling panjang 500 karakter")
    expect(PARAMS_BY_KEY.get(REASON)?.surface).toBe("advanced")
    expect(src("vendor/src/lib/studio/engine/lint/structure/checks-d.ts")).toContain('new Set(["chart", "diagram", "image"])')
    expect(R).toContain("blok `chart`, `diagram`, dan `image`")
    expect(src("vendor/src/lib/studio/services/skeleton/access.ts")).toContain("advanced/internal hanya ADMIN -> 403 PARAM_SURFACE_FORBIDDEN")
    expect(R).toContain("`403 PARAM_SURFACE_FORBIDDEN`")
  })

  test("studio_template_update call shape exists (slug, baseVersionNo, changeNote, changes.advanced)", async () => {
    const { TEMPLATE_TOOL_SCHEMAS } = await import("../../src/mcp-host/templates/schemas")
    const u = TEMPLATE_TOOL_SCHEMAS.studio_template_update as unknown as Schema
    expect(u.required).toEqual(["slug", "baseVersionNo", "changeNote"])
    expect(Object.keys((u.properties?.changes as Schema).properties ?? {})).toContain("advanced")
    expect(R).toContain('`studio_template_update { slug, baseVersionNo, changeNote, changes: { advanced: { "figure.quota.exceptionReason": "<alasan>" } } }`')
  })
})

describe("row 98: downloads and .bak/ backups (T-17)", () => {
  test("names, retention and result fields come from safety.ts / tools.ts", async () => {
    const { BACKUP_DIR_NAME, BACKUP_KEEP } = await import("../../vendor/scripts/studio/mcp/safety")
    expect(R).toContain(`\`<downloadDir>/${BACKUP_DIR_NAME}/<nama>.bak-<YYYYMMDDTHHMMSSZ>\``)
    expect(R).toContain(`paling banyak ${BACKUP_KEEP} cadangan terbaru (\`BACKUP_KEEP\`)`)
    const s = await tool("studio_file_verify")
    for (const k of ["fileId", "downloadDir", "overwrite"]) expect(props(s)).toContain(k)
    expect(R).toContain("`studio_file_verify { fileId, downloadDir, overwrite }`")
    const t = src("vendor/scripts/studio/mcp/tools.ts")
    for (const piece of ["cadangan berkas lama: ", "(backupResidue ", " di .bak/", "; backupRemoved "]) expect(t).toContain(piece)
    expect(R).toContain("`cadangan berkas lama: <path> (backupResidue N di .bak/; backupRemoved M)`")
    for (const k of ["backup", "backupResidue", "backupRemoved"]) expect(R).toContain(`\`${k}\``)
    expect(props(await tool("studio_report_refresh"))).toContain("overwrite")
  })
})

describe("row 98: studio_asset_put (W-13, SEC-10, SEC-11, SEC-12)", () => {
  test("call shapes and result fields match the host tool", async () => {
    const { assetHostExtension, ASSET_TOOL_NAME } = await import("../../src/mcp-host/asset-tool")
    const ext = assetHostExtension() as unknown as { inputSchema: Schema; description: string }
    expect(props(ext.inputSchema).sort()).toEqual(["dataBase64", "documentId", "path"])
    expect(A).toContain(`\`\`\` ${ASSET_TOOL_NAME} { path } ${ASSET_TOOL_NAME} { dataBase64 } \`\`\``)
    const t = src("src/mcp-host/asset-tool.ts")
    expect(t).toContain("structuredContent: { ok: true, tool: ASSET_TOOL_NAME, sha256: s.sha256, ref, mime: s.mime, widthPx: s.widthPx, heightPx: s.heightPx, bytes: s.bytes, created: stored.created, metadata")
    expect(A).toContain("`{ sha256, ref, mime, widthPx, heightPx, bytes, created, metadata: { gps, exifTags, pngTextKeys } }`")
    expect(ext.description).toContain("~6 MiB use `path`")
    expect(ext.description).toContain("capped at 8 MiB")
    expect(A).toContain("di atas sekitar 6 MiB wajib lewat `path`")
    expect(A).toContain("paling besar 8 MiB")
  })

  test("limits are the decoder constants; SVG refused by type", async () => {
    const d = await import("../../vendor/src/lib/studio/services/images/decode")
    const { STUDIO_MAX_ASSET_BYTES } = await import("../../vendor/src/lib/studio/contract/env")
    const id = (n: number) => n.toLocaleString("de-DE")
    expect(A).toContain(`Batasnya ${STUDIO_MAX_ASSET_BYTES / 1024 / 1024} MiB, ${id(d.IMAGE_MAX_SIDE_PX)} px per sisi, dan ${d.IMAGE_MAX_PIXELS / 1e6} MP`)
    expect(A).toContain("`ASSET_TOO_LARGE`")
    expect(A).toContain("SVG, GIF, dan jenis lain ditolak `ASSET_TYPE_UNSUPPORTED`")
  })

  test("metadata warning: strip commands quoted are those in assetMetadataWarning", async () => {
    const { assetMetadataWarning } = await import("../../src/mcp-host/local-api/routes/r18-asset-path")
    const w = String(assetMetadataWarning({ gps: true, exifTags: [], pngTextKeys: [] } as never))
    expect(assetMetadataWarning({ gps: false, exifTags: [], pngTextKeys: [] } as never)).toBeNull()
    for (const cmd of ["sips --deleteProperty all <file>", "exiftool -all= <file>"]) {
      expect(w).toContain(cmd)
      expect(A).toContain(`\`${cmd.replace("<file>", "<berkas>")}\``)
    }
    expect(A).toContain("Studio tidak membuang metadata itu")
  })

  test("reference forms and the DOCX media name", () => {
    expect(A).toContain('`{ "type": "image", "asset": "sha256:<heks>", "caption": { "text": "..." }, "source": { "text": "Sumber: ..." } }`')
    expect(A).toContain('`![caption](sha256:<heks> "Sumber: ...")`')
    expect(A).toContain("`word/media/fig-<32 heks pertama>.png`")
  })
})

describe("row 98: no workaround text, no project text, 4.1.2 untouched", () => {
  test("no wait-and-poll workaround", () => {
    for (const s of [R, A]) expect(s).not.toMatch(/\bpoll|sleep|tunggu lalu|tunggu sampai/i)
  })

  test("no project or corpus text in the new sections", () => {
    for (const s of [R, A]) expect(s).not.toMatch(/Cikupa|Gardu|\bGSP\b|\bPLN\b|\b14\.1\b|\brev ?2\d\d\b/i)
  })

  test("section 4.1.2 still ends right before 4.2 and keeps its render step", () => {
    const s = GUIDE.indexOf("#### 4.1.2 ")
    const sec = GUIDE.slice(s, GUIDE.indexOf("\n### 4.2 ", s))
    expect(s).toBeGreaterThan(0)
    expect(flat(sec)).toContain("4. **Render.** `studio_render { documentId, scope: \"chapter\", key, figures: [\"png\"] }`")
  })
})
