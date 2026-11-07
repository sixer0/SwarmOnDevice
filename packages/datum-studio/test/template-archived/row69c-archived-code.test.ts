// Row 69c (C83): the MCP doc tools surface TEMPLATE_ARCHIVED as the top-level tool code when the R08 / import dry-run
// refuses a NEW document on an archived template (spec masterplan/01_specs_studio_templates.md:160). Before row 69c the
// tool layer wrapped it: studio_chapter_import_markdown -> CHAPTER_INVALID, studio_write -> CONTENT_INVALID, with
// TEMPLATE_ARCHIVED only in the details. Other refused dry-runs keep their codes (archivedIssueCode returns null).
// Harness: ../template-e2e/harness.ts (row 69, imported only). Port: 127.0.0.1:<ephemeral>; run with the sandbox off.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { type Harness, type Rec, startHarness } from "../template-e2e/harness.ts"
import { archivedIssueCode } from "../../vendor/scripts/studio/mcp/tool-kit"

setDefaultTimeout(120_000)
process.env.ROW69_TEST_DIR ??= "/private/tmp/claude-501/row69c/tests"

const SLUG = "user-arsip-69c"
const MISSION = "2026-11-07_row69c"
const evidence: Rec = {}

let h: Harness
let swarm: Client

const call = (name: string, args: Rec) => h.call(swarm, name, args)
const docCount = () => Number(h.q<{ n: number }>("SELECT count(*) AS n FROM document")[0].n)

beforeAll(async () => {
  h = await startHarness("row69c")
  swarm = await h.clientOf("swarm")
})

afterAll(async () => {
  await h?.close()
  console.log(`row69c evidence ${JSON.stringify(evidence)}`)
})

describe("row 69c: archivedIssueCode (pure)", () => {
  test("TEMPLATE_ARCHIVED only when an issue's keyword is TEMPLATE_ARCHIVED; every other issue set stays null", () => {
    expect(archivedIssueCode([{ pointer: "/template", keyword: "TEMPLATE_ARCHIVED", message: "x" }])).toBe("TEMPLATE_ARCHIVED")
    expect(archivedIssueCode([{ keyword: "DATUM-09" }, { keyword: "TEMPLATE_ARCHIVED" }])).toBe("TEMPLATE_ARCHIVED")
    expect(archivedIssueCode([])).toBeNull()
    expect(archivedIssueCode([{ keyword: "SCHEMA_INVALID" }, { keyword: "required", checkId: "DATUM-09" }])).toBeNull()
    expect(archivedIssueCode([{ code: "TEMPLATE_ARCHIVED" }, "TEMPLATE_ARCHIVED", null])).toBeNull()
  })
})

describe("row 69c: the doc tools pass TEMPLATE_ARCHIVED through as the tool code", () => {
  test("setup: user template copied from datum-gsp, then archived", async () => {
    expect(await call("studio_template_create", { slug: SLUG, name: "Arsip 69c", kind: "DOCUMENT", changeNote: "Salinan datum-gsp (row 69c)", from: { slug: "datum-gsp" } })).toMatchObject({ ok: true, versionNo: 1 })
    expect(await call("studio_template_archive", { slug: SLUG, archived: true })).toMatchObject({ ok: true, archived: true })
  })

  test("studio_chapter_import_markdown (new document): code TEMPLATE_ARCHIVED, details kept, nothing written", async () => {
    const before = docCount()
    const r = await call("studio_chapter_import_markdown", { chapterKey: "1", markdown: "# Ringkasan\n\nTidak boleh dibuat.", mission: MISSION, docKey: "baru-69c", template: SLUG, docTitle: "Dokumen baru-69c", submit: true })
    const detailsCarryArchived = JSON.stringify(r.details ?? r).includes("TEMPLATE_ARCHIVED")
    evidence.chapterImport = { ok: r.ok ?? null, code: r.code ?? null, detailsCarryArchived, before, after: docCount() }
    expect(r.ok).not.toBe(true)
    expect(r.code).toBe("TEMPLATE_ARCHIVED")
    expect(detailsCarryArchived).toBe(true)
    expect(docCount()).toBe(before)
  })

  test("studio_write (new mission document): code TEMPLATE_ARCHIVED, nothing written", async () => {
    const before = docCount()
    const r = await call("studio_write", { mission: MISSION, docKey: "tulis-69c", template: SLUG, meta: { title: "Nota tulis 69c", author: "Agen Uji", number: "UJI-69C/2026-1" }, sections: [{ heading: "Isi", blocks: ["Tidak boleh dibuat."] }] })
    evidence.write = { ok: r.ok ?? null, code: r.code ?? null, before, after: docCount() }
    expect(r.ok).not.toBe(true)
    expect(r.code).toBe("TEMPLATE_ARCHIVED")
    expect(docCount()).toBe(before)
  })
})
