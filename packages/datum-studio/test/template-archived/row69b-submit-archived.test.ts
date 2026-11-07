// Row 69b (C82): the submit-pipeline create path refuses a NEW document on an archived template (TEMPLATE_ARCHIVED);
// a submission to an EXISTING document pinned to that template still works.
//
// Spec: masterplan/01_specs_studio_templates.md:160 (§4, archive row). Gap filed by row 69a (file_requests.md line 92).
// Path: MCP streamable-HTTP session -> row 31 host server -> studio_chapter_import_markdown (submit:true) -> R12
// -> services/submit/pipeline.ts create branch (archivedTemplateSlug, row 69a helper) -> store.
// Harness: ../template-e2e/harness.ts (row 69, imported only). Port: 127.0.0.1:<ephemeral>; run with the sandbox off.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { type Harness, type Rec, startHarness } from "../template-e2e/harness.ts"

setDefaultTimeout(120_000)
process.env.ROW69_TEST_DIR ??= "/private/tmp/claude-501/row69b/tests"

const SLUG = "user-arsip-69b"
const MISSION = "2026-11-07_row69b"
const evidence: Rec = {}

let h: Harness
let swarm: Client
let existingId = ""

const call = (name: string, args: Rec) => h.call(swarm, name, args)
const docCount = () => Number(h.q<{ n: number }>("SELECT count(*) AS n FROM document")[0].n)
const currentRev = (id: string) => Number(h.q<{ n: number }>("SELECT current_revision_no AS n FROM document WHERE id = ?", [id])[0].n)
const importArgs = (docKey: string, body: string): Rec => ({
  chapterKey: "1",
  markdown: `# Ringkasan\n\n${body}`,
  mission: MISSION,
  docKey,
  template: SLUG,
  docTitle: `Dokumen ${docKey}`,
  submit: true,
})

beforeAll(async () => {
  h = await startHarness("row69b")
  swarm = await h.clientOf("swarm")
})

afterAll(async () => {
  await h?.close()
  console.log(`row69b evidence ${JSON.stringify(evidence)}`)
})

describe("row 69b: submit create path vs an archived template", () => {
  test("setup: active user template, one document created through a chapter submission, then the template is archived", async () => {
    expect(await call("studio_template_create", { slug: SLUG, name: "Arsip 69b", kind: "DOCUMENT", changeNote: "Salinan datum-gsp (row 69b)", from: { slug: "datum-gsp" } })).toMatchObject({ ok: true, versionNo: 1 })
    const r = await call("studio_chapter_import_markdown", importArgs("ada-69b", "Paragraf pertama sebelum diarsipkan."))
    expect(r.ok).toBe(true)
    existingId = String(h.q<{ id: string }>("SELECT id FROM document WHERE mission_doc_key = ?", ["ada-69b"])[0]?.id)
    expect(existingId).not.toBe("")
    expect(await call("studio_template_archive", { slug: SLUG, archived: true })).toMatchObject({ ok: true, archived: true })
  })

  test("a NEW document through studio_chapter_import_markdown is refused TEMPLATE_ARCHIVED; the document count is unchanged", async () => {
    const before = docCount()
    const r = await call("studio_chapter_import_markdown", importArgs("baru-69b", "Tidak boleh dibuat."))
    evidence.newDoc = { ok: r.ok ?? null, code: r.code ?? null, archivedInReply: JSON.stringify(r).includes("TEMPLATE_ARCHIVED"), before, after: docCount() }
    expect(r.ok).not.toBe(true)
    // The tool runs the R08 dry-run first (the same pipeline create branch) and reports a refused dry-run as
    // CHAPTER_INVALID with the pipeline's TEMPLATE_ARCHIVED issue in the details (doc-tools.ts, not row 69b's file).
    expect(r.code === "TEMPLATE_ARCHIVED" || r.code === "CHAPTER_INVALID").toBe(true)
    expect(JSON.stringify(r)).toContain("TEMPLATE_ARCHIVED")
    expect(docCount()).toBe(before)
  })

  test("a submission to the EXISTING document pinned to the archived template still works (new revision)", async () => {
    const rev0 = currentRev(existingId)
    const before = docCount()
    const r = await call("studio_chapter_import_markdown", importArgs("ada-69b", "Paragraf kedua sesudah templat diarsipkan."))
    evidence.existingDoc = { ok: r.ok ?? null, code: r.code ?? null, revBefore: rev0, revAfter: currentRev(existingId) }
    expect(r.ok).toBe(true)
    expect(currentRev(existingId)).toBeGreaterThan(rev0)
    expect(docCount()).toBe(before)
  })

  test("after unarchive the new document can be made", async () => {
    expect(await call("studio_template_archive", { slug: SLUG, archived: false })).toMatchObject({ ok: true, archived: false })
    const before = docCount()
    const r = await call("studio_chapter_import_markdown", importArgs("baru-69b", "Sekarang boleh dibuat."))
    expect(r.ok).toBe(true)
    expect(docCount()).toBe(before + 1)
  })
})
