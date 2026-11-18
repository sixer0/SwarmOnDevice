// Swarm 1.3.3 row 75 (ST-10, C-04 / P-07): `baseRevisionNo` is honoured on studio_chapter_import_markdown.
// Real host over a temp store (test/retrieval/scenario.ts startHost; binds an ephemeral port, so it needs the command
// sandbox off). "Another writer" writes through the local API (R12 chapter submission, R16 paragraph PATCH), which
// does not move the MCP session's remembered basis.
//
// Red before the fix (project 1, calls 31/39/46/48 of the R6 extract): the importer's R08 dry run never received the
// base, so an import with baseRevisionNo = the latest revision was still refused (CHAPTER_INVALID wrapping
// SCOPE_CONFLICT / PATCHED_PIDS_OVERWRITTEN with "baseRevisionNo": null), and a conflict found by the dry run was
// reported as CHAPTER_INVALID ("fix the Markdown") instead of the SCOPE_CONFLICT every other base-taking write gives.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { startHost, type Host } from "../retrieval/scenario.ts"

type S = Record<string, any>
const PKG = path.resolve(import.meta.dir, "..", "..")
const MISSION = "2026-11-17_row75"
const CHANGE = (what: string) => ({ what, why: "uji basis impor row 75", impact: "tidak ada" })
const md = (title: string, body: string) => `# ${title}\n\n${body}\n`

let h: Host
beforeAll(async () => {
  const work = realpathSync(mkdtempSync(path.join(tmpdir(), "row75-")))
  mkdirSync(path.join(work, "datum-studio"), { recursive: true })
  h = await startHost({ phase: "row75", pkg: PKG, storeRoot: path.join(work, "datum-studio"), work } as never, () => {})
}, 120_000)
afterAll(async () => {
  await h?.stop()
})

const revOf = (id: string) => Number(h.sql<{ n: number }>("SELECT current_revision_no AS n FROM document WHERE id = ?", [id])[0]!.n)
const call = (name: string, args: S): Promise<S> => h.call(name, args) as Promise<S>
const textOf = async (id: string) => JSON.stringify((await call("studio_document_get", { documentId: id, view: "content" })).content ?? null)
const imp = (id: string, chapterKey: string, markdown: string, extra: S = {}) =>
  call("studio_chapter_import_markdown", { documentId: id, chapterKey, markdown, submit: true, change: CHANGE(`bab ${chapterKey}`), ...extra })
const say = (label: string, r: S) => console.log(`[row75] ${label}: ok=${r.ok} code=${r.code ?? "-"} rev=${r.revisionNo ?? "-"} ${String(r._text).slice(0, 260).replace(/\n/g, " / ")}`)

async function newDoc(docKey: string): Promise<string> {
  const c = await call("studio_document_create", { template: "datum-nota", mission: MISSION, docKey, title: `Nota uji ${docKey}` })
  expect(c.ok, c._text).not.toBe(false)
  const id = String(c.documentId)
  for (const k of ["1", "2"]) {
    const r = await imp(id, k, md(`Bab ${k}`, `Paragraf awal bab ${k} ditulis sesi ini.`), { baseRevisionNo: revOf(id) })
    expect(r.ok === true, r._text).toBe(true)
  }
  return id
}

/** Another writer replaces a whole chapter (R12), on the latest revision. */
async function otherWritesChapter(id: string, chapterKey: string, body: string): Promise<number> {
  const conv = await h.local("POST", "/api/studio/import/markdown", { markdown: md(`Bab ${chapterKey}`, body), chapterKey, agentId: "cod-lain", target: { documentId: id } })
  expect(conv.status, JSON.stringify(conv.body).slice(0, 300)).toBe(200)
  const sub = await h.local("POST", "/api/studio/chapters", { ...conv.body.submission, baseRevisionNo: revOf(id), change: CHANGE("penulis lain") })
  expect([200, 201], JSON.stringify(sub.body).slice(0, 300)).toContain(sub.status)
  return revOf(id)
}

/** Another writer edits one paragraph of a chapter by PATCH (R16): a `pid:` revision. */
async function otherPatchesParagraph(id: string, find: string, replace: string): Promise<number> {
  const content = (await call("studio_document_get", { documentId: id, view: "content" })).content
  let para: S | null = null
  const walk = (x: unknown) => {
    if (para !== null) return
    if (Array.isArray(x)) x.forEach(walk)
    else if (x !== null && typeof x === "object") {
      const o = x as S
      if (o.type === "paragraph" && typeof o.id === "string" && JSON.stringify(o).includes(find)) para = o
      else Object.values(o).forEach(walk)
    }
  }
  walk(content)
  expect(para, `paragraph with "${find}"`).not.toBeNull()
  const { id: pid, ...block } = para as unknown as S
  const replaced = JSON.parse(JSON.stringify(block).replace(find, replace)) as S
  const p = await h.local("PATCH", `/api/studio/documents/${id}/paragraphs/${pid}`, { op: "replace", baseRevisionNo: revOf(id), block: replaced, change: CHANGE("sunting PATCH"), agentId: "cod-lain" })
  expect(p.status, JSON.stringify(p.body).slice(0, 300)).toBe(200)
  return revOf(id)
}

describe("row 75: baseRevisionNo on studio_chapter_import_markdown", () => {
  test("matching base: an import with baseRevisionNo = the latest revision is accepted although the chapter was edited by PATCH since its last submission", async () => {
    const id = await newDoc("r75-match")
    const n = await otherPatchesParagraph(id, "Paragraf awal bab 1", "Paragraf bab 1 disunting PATCH")
    const r = await imp(id, "1", md("Bab 1", "Isi bab 1 ditulis ulang sesudah membaca revisi terkini."), { baseRevisionNo: n })
    say("matching base after PATCH", r)
    expect(r.ok === true, r._text).toBe(true)
    expect(r.revisionNo).toBe(n + 1)
    expect(revOf(id)).toBe(n + 1)
    expect(await textOf(id)).toContain("ditulis ulang sesudah membaca revisi terkini")
    expect(r.warnings ?? []).toEqual([])
  }, 120_000)

  test("check only (submit=false) with a matching base reports SAH and writes nothing", async () => {
    const id = await newDoc("r75-check")
    const n = await otherPatchesParagraph(id, "Paragraf awal bab 1", "Paragraf bab 1 disunting PATCH")
    const r = await call("studio_chapter_import_markdown", { documentId: id, chapterKey: "1", markdown: md("Bab 1", "Isi periksa saja."), baseRevisionNo: n })
    say("check only", r)
    expect(r.importSummary?.valid === true, r._text).toBe(true)
    expect(r.submitted).toBe(false)
    expect(revOf(id)).toBe(n)
  }, 120_000)

  test("stale base, the same chapter rewritten by another writer since: SCOPE_CONFLICT, the stored revision and content do not change", async () => {
    const id = await newDoc("r75-stale-chapter")
    const base = revOf(id)
    const n = await otherWritesChapter(id, "1", "Bab 1 ditulis penulis lain sesudah basis.")
    expect(n).toBe(base + 1)
    const before = await textOf(id)
    const r = await imp(id, "1", md("Bab 1", "Kiriman basi yang tidak boleh menimpa."), { baseRevisionNo: base })
    say("stale base, chapter rewritten", r)
    expect(r.ok).toBe(false)
    expect(r.code).toBe("SCOPE_CONFLICT")
    expect(r.untrusted).toBe(true)
    expect(String(r._text)).toContain("0 tulis")
    expect(String(r._text)).toContain("baseRevisionNo terbaru")
    expect(revOf(id)).toBe(n)
    expect(await textOf(id)).toBe(before)
    expect(before).toContain("ditulis penulis lain sesudah basis")
  }, 120_000)

  test("stale base, a paragraph of the chapter edited by PATCH since: SCOPE_CONFLICT naming the pid, nothing stored", async () => {
    const id = await newDoc("r75-stale-patch")
    const base = revOf(id)
    const n = await otherPatchesParagraph(id, "Paragraf awal bab 1", "Paragraf bab 1 disunting PATCH sesudah basis")
    const before = await textOf(id)
    const r = await imp(id, "1", md("Bab 1", "Kiriman basi yang tidak boleh menimpa suntingan."), { baseRevisionNo: base })
    say("stale base, PATCH since", r)
    expect(r.ok).toBe(false)
    expect(r.code).toBe("SCOPE_CONFLICT")
    expect(JSON.stringify(r.error?.details ?? {})).toContain(`"baseRevisionNo":${base}`)
    expect(revOf(id)).toBe(n)
    expect(await textOf(id)).toBe(before)
    // The refusal is repeatable and resolved by the base the message names (the latest revision).
    const ok = await imp(id, "1", md("Bab 1", "Kiriman sesudah membaca revisi terkini."), { baseRevisionNo: n })
    expect(ok.ok === true, ok._text).toBe(true)
    expect(revOf(id)).toBe(n + 1)
  }, 120_000)

  test("stale base, only ANOTHER chapter changed since: saved on top (rebased) with BASIS_REBASED, like studio_chapter_submit and studio_slot_fill", async () => {
    const id = await newDoc("r75-rebased")
    const base = revOf(id)
    const n = await otherWritesChapter(id, "2", "Bab 2 ditulis penulis lain sesudah basis.")
    const r = await imp(id, "1", md("Bab 1", "Bab 1 baru di atas basis lama."), { baseRevisionNo: base })
    say("stale base, other chapter", r)
    expect(r.ok === true, r._text).toBe(true)
    expect(r.revisionNo).toBe(n + 1)
    expect(r.rebased).toBe(true)
    expect((r.warnings ?? []).map((w: S) => w.code)).toContain("BASIS_REBASED")
    const now = await textOf(id)
    expect(now).toContain("Bab 1 baru di atas basis lama")
    expect(now).toContain("Bab 2 ditulis penulis lain sesudah basis")
    // Absent base once the session basis was forgotten: BASIS_MISSING, nothing sent (the tool's contract).
    const missing = await imp(id, "1", md("Bab 1", "Tanpa basis."))
    say("absent base, basis forgotten", missing)
    expect(missing.ok).toBe(false)
    expect(missing.code).toBe("BASIS_MISSING")
    expect(revOf(id)).toBe(n + 1)
  }, 120_000)

  test("absent base with a session basis: the basis is sent to R12; a PATCH since the chapter's last submission still refuses, as SCOPE_CONFLICT", async () => {
    const id = await newDoc("r75-session")
    const base = revOf(id)
    const first = await imp(id, "1", md("Bab 1", "Bab 1 versi kedua dengan basis sesi."))
    say("absent base, session basis", first)
    expect(first.ok === true, first._text).toBe(true)
    expect(first.basisFromSession).toBe(base)
    expect(first.revisionNo).toBe(base + 1)
    const n = await otherPatchesParagraph(id, "Bab 1 versi kedua", "Bab 1 versi kedua disunting PATCH")
    const before = await textOf(id)
    const r = await imp(id, "1", md("Bab 1", "Bab 1 versi ketiga tanpa basis eksplisit."))
    say("absent base, PATCH since", r)
    expect(r.ok).toBe(false)
    expect(r.code).toBe("SCOPE_CONFLICT")
    expect(JSON.stringify(r.error?.details ?? {})).toContain("PATCHED_PIDS_OVERWRITTEN")
    expect(revOf(id)).toBe(n)
    expect(await textOf(id)).toBe(before)
  }, 120_000)
})
