// Row 69a (C78): a NEW document on an archived template is refused TEMPLATE_ARCHIVED; EXISTING documents pinned to it
// keep working.
//
// Spec: masterplan/01_specs_studio_templates.md:160 (§4, archive row): "studio_template_update and
// studio_document_create on it are refused (TEMPLATE_ARCHIVED); existing documents still resolve, render and
// re-render on their pinned versions; `from` (copy) still works with an explicit slug. Unarchive restores it."
// Path: MCP streamable-HTTP session -> row 31 host server -> vendored studio_document_create / studio_write ->
// R04 -> services/ingest (pinTemplate, the row 69a check) -> store. The service-level cases call
// services/ingest directly (v2 dry-run, v1 adapter, v1 legacy), in the same process and store as the host.
// Harness (real host, one stand-in: the render-bridge transport): ../template-e2e/harness.ts (row 69, imported only).
// Port: 127.0.0.1:<ephemeral>; run with the command sandbox off.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { StudioCaller } from "../../vendor/src/lib/studio/contract/auth"
import { type Harness, type Rec, startHarness, versionRow } from "../template-e2e/harness.ts"

setDefaultTimeout(120_000)
process.env.ROW69_TEST_DIR ??= "/private/tmp/claude-501/row69a/tests"

const SLUG = "user-arsip-69a"
const MISSION = "2026-11-07_row69a"
const evidence: Rec = {}
const caller: StudioCaller = { kind: "INTERNAL_AGENT", requester: "agent:row69a-test", agentId: "row69a-test", canWriteClassK: false }

let h: Harness
let swarm: Client
let claude: Client
let writtenId = ""
let createdId = ""
let revBeforeEdit = 0
let ingest: typeof import("../../vendor/src/lib/studio/services/ingest")

const call = (c: Client, name: string, args: Rec) => h.call(c, name, args)
const docCount = () => Number(h.q<{ n: number }>("SELECT count(*) AS n FROM document")[0].n)
const currentRev = (id: string) => Number(h.q<{ n: number }>("SELECT current_revision_no AS n FROM document WHERE id = ?", [id])[0].n)
const pinOf = (id: string, rev: number) =>
  String(h.q<{ v: string }>("SELECT template_version_id AS v FROM revision WHERE document_id = ? AND revision_no = ?", [id, rev])[0]?.v ?? "")
const pinnedOfJob = (jobId: string): Rec | undefined => {
  const row = h.q<{ engine: string }>("SELECT engine FROM render_job WHERE id = ?", [jobId])[0]
  const eng = JSON.parse(row.engine) as { log?: Array<{ code?: string; context?: Rec }> }
  return (eng.log ?? []).find((e) => e.code === "TEMPLATE_PINNED")?.context
}
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
    return "ok"
  } catch (e) {
    return String((e as { code?: unknown }).code ?? (e as Error).message)
  }
}
const meta = { typeCode: "KT", tier: "NOTA", classification: "BIASA", language: "ID", author: "Row 69a", issueDate: "2026-11-07", rev: "A" }
const v2Doc = (title: string, folder: string) => ({
  $schema: "studio.doc/v2",
  template: { slug: SLUG },
  meta: { ...meta, title },
  mission: { folder },
  sections: { content: { type: "chapter", chapters: [{ key: "1", title: { text: "Ringkasan" }, sections: [{ title: { text: "Isi" }, blocks: [{ type: "paragraph", text: "Paragraf uji templat terarsip." }] }] }] } },
})
const v1Doc = (title: string) => ({
  $schema: "studio.doc/v1",
  template: { slug: SLUG },
  meta: { ...meta, title },
  chapters: [{ key: "1", title: { text: "Bab uji v1" }, sections: [{ title: { text: "Bagian" }, blocks: [{ type: "paragraph", text: "Paragraf dokumen versi satu pada templat terarsip." }] }] }],
})

beforeAll(async () => {
  h = await startHarness("row69a")
  swarm = await h.clientOf("swarm")
  claude = await h.clientOf("claude")
  ingest = await import("../../vendor/src/lib/studio/services/ingest")
})

afterAll(async () => {
  await h?.close()
  console.log(`row69a evidence ${JSON.stringify(evidence)}`)
})

describe("row 69a: setup on an active template (v1, then v2)", () => {
  test("swarm copies datum-gsp to a user template; two documents are made on v1 (studio_write, studio_document_create)", async () => {
    expect(await call(swarm, "studio_template_create", { slug: SLUG, name: "Arsip 69a", kind: "DOCUMENT", changeNote: "Salinan datum-gsp (row 69a)", from: { slug: "datum-gsp" } })).toMatchObject({ ok: true, versionNo: 1 })
    const w = await call(swarm, "studio_write", {
      mission: MISSION,
      docKey: "nota-ada",
      template: SLUG,
      meta: { title: "Nota yang sudah ada", author: "Agen Uji", number: "UJI-69A/2026-1" },
      sections: [{ heading: "Latar belakang", blocks: ["Dokumen ini dibuat sebelum templat diarsipkan."] }],
    })
    expect(w.ok).toBe(true)
    writtenId = String(w.documentId)
    const c = await call(swarm, "studio_document_create", { template: SLUG, mission: MISSION, docKey: "nota-kerangka", title: "Kerangka yang sudah ada" })
    expect(c.ok).toBe(true)
    createdId = String(c.documentId ?? h.q<{ id: string }>("SELECT id FROM document WHERE mission_doc_key = ?", ["nota-kerangka"])[0]?.id)
    const v1 = String(versionRow(h, SLUG, 1).id)
    expect(pinOf(writtenId, currentRev(writtenId))).toBe(v1)
    expect(pinOf(createdId, currentRev(createdId))).toBe(v1)
    expect(await call(claude, "studio_template_update", { slug: SLUG, baseVersionNo: 1, changeNote: "Versi kedua", changes: { advanced: { "table.header.verticalAlign": "top" } } })).toMatchObject({ ok: true, versionNo: 2 })
  })

  test("archive it (claude); it is hidden from the list", async () => {
    expect(await call(claude, "studio_template_archive", { slug: SLUG, archived: true })).toMatchObject({ ok: true, archived: true })
    expect(JSON.stringify((await call(swarm, "studio_templates_list", {})).templates)).not.toContain(SLUG)
  })
})

describe("row 69a: a NEW document on the archived template is refused TEMPLATE_ARCHIVED, nothing is written", () => {
  test("studio_document_create (new mission + docKey)", async () => {
    const before = docCount()
    const r = await call(swarm, "studio_document_create", { template: SLUG, mission: MISSION, docKey: "nota-baru-a", title: "Nota baru A" })
    evidence.documentCreate = { ok: r.ok ?? null, code: r.code ?? null }
    expect(r.ok).not.toBe(true)
    expect(r.code).toBe("TEMPLATE_ARCHIVED")
    expect(docCount()).toBe(before)
  })

  test("studio_document_create with an explicit templateVersion (v1) is refused too", async () => {
    const before = docCount()
    const r = await call(claude, "studio_document_create", { template: SLUG, templateVersion: 1, mission: MISSION, docKey: "nota-baru-v1", title: "Nota baru v1" })
    expect(r.code).toBe("TEMPLATE_ARCHIVED")
    expect(docCount()).toBe(before)
  })

  test("studio_write (new mission + docKey)", async () => {
    const before = docCount()
    const r = await call(swarm, "studio_write", { mission: MISSION, docKey: "nota-baru-b", template: SLUG, meta: { title: "Nota baru B", author: "Agen Uji", number: "UJI-69A/2026-B" }, sections: [{ heading: "Isi", blocks: ["Tidak boleh dibuat."] }] })
    evidence.write = { ok: r.ok ?? null, code: r.code ?? null }
    expect(r.ok).not.toBe(true)
    expect(r.code).toBe("TEMPLATE_ARCHIVED")
    expect(docCount()).toBe(before)
  })

  test("services/ingest directly: v2 dry-run is invalid with keyword TEMPLATE_ARCHIVED; v2, v1 adapter and v1 legacy throw TEMPLATE_ARCHIVED", async () => {
    const before = docCount()
    const dry = await ingest.ingestDocument(v2Doc("Dry run arsip", "2026-11-07_row69a-dry") as never, caller, { dryRun: true })
    expect(dry.valid).toBe(false)
    expect(JSON.stringify(dry.issues)).toContain("TEMPLATE_ARCHIVED")
    const codes = {
      v2: await codeOf(ingest.ingestDocument(v2Doc("Langsung v2 arsip", "2026-11-07_row69a-v2") as never, caller, { dryRun: false })),
      v1: await codeOf(ingest.ingestDocument({ document: v1Doc("Langsung v1 arsip") } as never, caller, { dryRun: false })),
      v1Legacy: await codeOf(ingest.ingestDocument({ document: v1Doc("Langsung v1 lama arsip") } as never, caller, { dryRun: false, legacyV1: true, trustedHarness: true } as never)),
    }
    evidence.direct = { dryValid: dry.valid, ...codes }
    expect(codes).toEqual({ v2: "TEMPLATE_ARCHIVED", v1: "TEMPLATE_ARCHIVED", v1Legacy: "TEMPLATE_ARCHIVED" })
    expect(docCount()).toBe(before)
  })
})

describe("row 69a: EXISTING documents pinned to the archived template keep working", () => {
  test("studio_document_create on an existing mission + docKey still answers (idempotent, unchanged)", async () => {
    const before = docCount()
    const r = await call(swarm, "studio_document_create", { template: SLUG, mission: MISSION, docKey: "nota-kerangka", title: "Kerangka yang sudah ada" })
    expect(r.ok).toBe(true)
    expect(docCount()).toBe(before)
  })

  test("studio_write rewrites the existing document: a new revision, still pinned to v1", async () => {
    const rev0 = currentRev(writtenId)
    revBeforeEdit = rev0
    const r = await call(swarm, "studio_write", {
      mission: MISSION,
      docKey: "nota-ada",
      template: SLUG,
      meta: { title: "Nota yang sudah ada", author: "Agen Uji", number: "UJI-69A/2026-1" },
      sections: [{ heading: "Latar belakang", blocks: ["Dokumen ini diubah sesudah templat diarsipkan."] }],
    })
    evidence.editExisting = { ok: r.ok ?? null, code: r.code ?? null, revBefore: rev0, revAfter: currentRev(writtenId) }
    expect(r.ok).toBe(true)
    expect(currentRev(writtenId)).toBeGreaterThan(rev0)
    expect(pinOf(writtenId, currentRev(writtenId))).toBe(String(versionRow(h, SLUG, 1).id))
  })

  test("studio_render of the current revision and re-render of the revision before the edit both run on v1 (the pin)", async () => {
    const v1 = String(versionRow(h, SLUG, 1).id)
    const cur = await call(swarm, "studio_render", { documentId: writtenId, formats: ["html"] })
    expect(cur.ok).toBe(true)
    expect(pinnedOfJob((cur.job as { id: string }).id)).toMatchObject({ versionNo: 1, versionId: v1 })
    const old = await call(claude, "studio_render", { documentId: writtenId, formats: ["html"], revisionNo: revBeforeEdit })
    evidence.renderExisting = { current: cur.ok ?? cur.code ?? null, before: old.ok ?? old.code ?? null, revisionNo: revBeforeEdit }
    expect(old.ok).toBe(true)
    expect(pinnedOfJob((old.job as { id: string }).id)).toMatchObject({ versionNo: 1, versionId: v1 })
  })
})

describe("row 69a: unarchive restores new documents", () => {
  test("after unarchive, studio_document_create makes the new document", async () => {
    expect(await call(swarm, "studio_template_archive", { slug: SLUG, archived: false })).toMatchObject({ ok: true, archived: false })
    const before = docCount()
    const r = await call(swarm, "studio_document_create", { template: SLUG, mission: MISSION, docKey: "nota-baru-a", title: "Nota baru A" })
    expect(r.ok).toBe(true)
    expect(docCount()).toBe(before + 1)
  })
})
