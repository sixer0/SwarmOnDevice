// Swarm 1.3.3 row 61 (ST-9 item 2, U20): every agent write path refuses `labels_verified: true`. Real host over a temp
// store (test/diagram-persist/hna-host.ts; binds an ephemeral port, so it needs the command sandbox off).
// Paths: studio_write (new and over an existing document), studio_edit, studio_figure_revise, studio_chapter_submit
// (object and JSON string), studio_chapter_import_markdown (diagram fence). `false` and absent are accepted on the same
// calls. Two tools take no diagram at all and are pinned as such: studio_write on a work report, studio_slot_fill.
// A flag raised by the person path (raiseLabelsVerified, the seam of row 62, called in-process here) is kept when the
// agent edits another field, and dropped only by an agent sending false; a spec edit that keeps true is refused.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { CHANGE, clone, diagramsOf, FIXTURE, META, startHost, type Host, type S } from "../diagram-persist/hna-host"
import { raiseLabelsVerified } from "../../src/mcp-host/local-api/labels-verified-raise.ts"
import { nextCall } from "../../src/mcp-host/mission/next-call.ts"

const MISSION = "2026-11-17_row61"
const CODE = "LABELS_VERIFIED_PERSON_ONLY"
let h: Host
beforeAll(async () => {
  h = await startHost("row61")
}, 120_000)
afterAll(async () => {
  await h?.close()
})

/** The fixture's studio_write block ({diagram: {...}}) with the flag set, cleared or removed. */
const writeBlock = (flag: boolean | undefined): S => {
  const b = clone(FIXTURE.writeBlock)
  if (flag === undefined) delete b.diagram.spec.labels_verified
  else b.diagram.spec.labels_verified = flag
  return b
}
const sections = (...blocks: unknown[]) => [{ heading: "Pendahuluan", blocks: ["Paragraf pembuka sintetis alfa bravo charlie.", ...blocks] }]
const write = (docKey: string, ...blocks: unknown[]) => h.call("studio_write", { mission: MISSION, docKey, template: "datum-nota", meta: META, sections: sections(...blocks) })
const flags = async (doc: string) => diagramsOf(await h.content(doc)).map((d) => d.spec.labels_verified)
function expectRefused(r: S, label: string) {
  const all = JSON.stringify(r)
  console.log(`[row61-host] ${label}: ok=${r.ok} code=${r.code ?? "-"} isError=${r._isError} text=${String(r._text).slice(0, 420).replace(/\n/g, " / ")}`)
  expect(r.ok, `${label}: ${r._text}`).toBe(false)
  expect(all, label).toContain(CODE)
  expect(all, label).toContain("labels_verified is set by the person in Mission Control")
}

let doc = ""
let pid = ""
/** Current revision of a document (the person path writes outside the session, so the agent re-reads its base). */
const revOf = async (id: string): Promise<number> => {
  const g = await h.call("studio_document_get", { documentId: id })
  expect(typeof g.revisionNo, g._text).toBe("number")
  return Number(g.revisionNo)
}

describe("row 61 (host): an agent that sends labels_verified: true is refused on every write path", () => {
  test("studio_write: true refused and nothing stored; false and absent stored", async () => {
    const refused = await write("r61-true", writeBlock(true))
    expectRefused(refused, "studio_write true")
    expect(refused.documentId).toBeUndefined()
    const list = await h.call("studio_search", { query: "sintetis" }).catch(() => ({}) as S)
    expect(JSON.stringify(list)).not.toContain("r61-true")

    const f = await write("r61-doc", writeBlock(false))
    expect(f.ok, f._text).not.toBe(false)
    doc = String(f.documentId)
    expect(await flags(doc)).toEqual([false])
    pid = String(diagramsOf(await h.content(doc))[0].id)

    const a = await write("r61-absent", writeBlock(undefined))
    expect(a.ok, a._text).not.toBe(false)
    expect(await flags(String(a.documentId))).toEqual([undefined])
  }, 180_000)

  test("studio_write on a work report (no template) takes no figure at all, so that path carries no flag", async () => {
    for (const flag of [true, false]) {
      const r = await h.call("studio_write", { mission: MISSION, docKey: `r61-report-${flag}`, sections: [{ heading: "Ringkasan", blocks: ["Ringkasan sintetis.", writeBlock(flag)] }] })
      expect(r.ok).toBe(false)
      expect(r.code).toBe("INVALID_ARGUMENT")
      expect(JSON.stringify(r)).toContain("laporan kerja tidak memuat figur")
    }
  }, 120_000)

  test("studio_write over an existing document: true refused, the stored revision is unchanged", async () => {
    const before = await h.content(doc)
    expectRefused(await write("r61-doc", writeBlock(true)), "studio_write rewrite true")
    expect(await h.content(doc)).toEqual(before)
  }, 120_000)

  test("studio_edit: appending a diagram with true is refused; with false it is stored", async () => {
    const before = await h.content(doc)
    const edit = (flag: boolean) => h.call("studio_edit", { documentId: doc, edits: [{ section: "Pendahuluan", append: [writeBlock(flag)] }], change: CHANGE })
    expectRefused(await edit(true), "studio_edit true")
    expect(await h.content(doc)).toEqual(before)
    const ok = await edit(false)
    expect(ok.ok, ok._text).not.toBe(false)
    expect(await flags(doc)).toEqual([false, false])
  }, 120_000)

  test("studio_figure_revise: patch {spec: {labels_verified: true}} is refused; other patches pass", async () => {
    const revise = (patch: S) => h.call("studio_figure_revise", { documentId: doc, pid, patch, change: CHANGE, preview: false })
    expectRefused(await revise({ spec: { labels_verified: true } }), "studio_figure_revise true")
    expectRefused(await revise({ spec: { labels_verified: true, direction: "LR" } }), "studio_figure_revise true + direction")
    expect(await flags(doc)).toEqual([false, false])
    const ok = await revise({ spec: { direction: "LR" } })
    expect(ok.ok, ok._text).not.toBe(false)
    expect(await flags(doc)).toEqual([false, false])
  }, 120_000)

  test("studio_chapter_submit: true refused as object and as JSON string; false stored", async () => {
    const target = await write("r61-chapter")
    expect(target.ok, target._text).not.toBe(false)
    const id = String(target.documentId)
    const submission = (flag: boolean): S => {
      const s = clone(FIXTURE.chapter)
      for (const d of diagramsOf(s.chapter)) d.spec.labels_verified = flag
      return { $schema: s.$schema, target: { documentId: id }, chapter: s.chapter }
    }
    const before = await h.content(id)
    expectRefused(await h.call("studio_chapter_submit", { submission: submission(true) }), "studio_chapter_submit object true")
    expectRefused(await h.call("studio_chapter_submit", { submission: JSON.stringify(submission(true)) }), "studio_chapter_submit string true")
    expect(await h.content(id)).toEqual(before)
    const ok = await h.call("studio_chapter_submit", { submission: submission(false) })
    expect(ok.ok, ok._text).not.toBe(false)
    expect(await flags(id)).toEqual([false])
  }, 180_000)

  test("studio_chapter_import_markdown: a diagram fence with true is refused; with false it is stored", async () => {
    const target = await write("r61-import")
    expect(target.ok, target._text).not.toBe(false)
    const id = String(target.documentId)
    const md = (flag: boolean) => {
      const block = clone(FIXTURE.block)
      block.spec.labels_verified = flag
      return `# Uraian impor\n\nParagraf sintetis sebelum gambar.\n\n\`\`\`diagram\n${JSON.stringify(block)}\n\`\`\`\n`
    }
    const base = await revOf(id)
    const imp = (flag: boolean, baseRevisionNo: number) => h.call("studio_chapter_import_markdown", { documentId: id, chapterKey: "2", markdown: md(flag), submit: true, baseRevisionNo })
    const before = await h.content(id)
    expectRefused(await imp(true, base), "studio_chapter_import_markdown true")
    expect(await h.content(id)).toEqual(before)
    const ok = await imp(false, base)
    console.log(`[row61-host] import false: ok=${ok.ok} code=${ok.code ?? "-"} base=${base}`)
    expect(ok.ok, ok._text).not.toBe(false)
    expect(await flags(id)).toEqual([false])
  }, 180_000)
})

describe("row 61 (host): studio_slot_fill", () => {
  test("the two slot types that hold blocks (chapter, appendix) are sent to the chapter endpoint: slot_fill carries no diagram", async () => {
    const target = await write("r61-slot")
    expect(target.ok, target._text).not.toBe(false)
    const id = String(target.documentId)
    const before = await h.content(id)
    for (const [slot, type, key] of [["content", "chapter", "1"], ["appendices", "appendix", "A"]] as const) {
      const c = clone(FIXTURE.chapter.chapter)
      c.key = key
      const r = await h.call("studio_slot_fill", { documentId: id, slot, payload: { type, chapters: [c] }, baseRevisionNo: await revOf(id), change: CHANGE })
      expect(r.ok, slot).toBe(false)
      expect(r.code, slot).toBe("SLOT_USE_CHAPTER_ENDPOINT")
    }
    expect(await h.content(id)).toEqual(before)
  }, 120_000)
})

describe("row 61 (host): a flag raised by the person path is kept on other edits and cannot be reached by a tool", () => {
  test("raiseLabelsVerified (in-process, outside any tool call) sets the flag on the stored figure", async () => {
    const r = await raiseLabelsVerified({ documentId: doc, pids: [pid], decisionId: "U7", mission: MISSION })
    console.log(`[row61-host] raise: ${JSON.stringify(r)}`)
    expect(r.raised).toEqual([pid])
    expect(await flags(doc)).toEqual([true, false])
    const again = await raiseLabelsVerified({ documentId: doc, pids: [pid], decisionId: "U7" })
    expect(again).toMatchObject({ raised: [], alreadyTrue: [pid], revisionNo: r.revisionNo })
  }, 120_000)

  test("agent edits of other fields keep the stored true: caption and width of the figure, another block, another figure", async () => {
    const revise = async (p: string, patch: S) => h.call("studio_figure_revise", { documentId: doc, pid: p, patch, change: CHANGE, preview: false, baseRevisionNo: await revOf(doc) })
    for (const patch of [{ caption: "Keterangan baru sesudah pemeriksaan label." }, { width: "full" }]) {
      const r = await revise(pid, patch)
      expect(r.ok, `${JSON.stringify(patch)}: ${r._text}`).not.toBe(false)
      expect(await flags(doc)).toEqual([true, false])
    }
    const e = await h.call("studio_edit", { documentId: doc, edits: [{ section: "Pendahuluan", append: ["Paragraf tambahan sesudah pemeriksaan label."] }], change: CHANGE })
    expect(e.ok, e._text).not.toBe(false)
    const other = String(diagramsOf(await h.content(doc))[1].id)
    const o = await revise(other, { spec: { direction: "TB" } })
    expect(o.ok, o._text).not.toBe(false)
    expect(await flags(doc)).toEqual([true, false])
    expect(diagramsOf(await h.content(doc))[0].width).toBe("full")
  }, 180_000)

  test("a spec edit that keeps true is refused (the check was made on the old labels); with false it passes and drops the flag", async () => {
    const revise = async (patch: S) => h.call("studio_figure_revise", { documentId: doc, pid, patch, change: CHANGE, preview: false, baseRevisionNo: await revOf(doc) })
    const before = await h.content(doc)
    const kept = await revise({ spec: { direction: "TB" } })
    expectRefused(kept, "spec edit keeping a stored true")
    expect(JSON.stringify(kept)).toContain("figure-changed-after-check")
    expect(await h.content(doc)).toEqual(before)
    const dropped = await revise({ spec: { direction: "TB", labels_verified: false } })
    expect(dropped.ok, dropped._text).not.toBe(false)
    expect(await flags(doc)).toEqual([false, false])
    // and the agent cannot put it back
    expectRefused(await revise({ spec: { labels_verified: true } }), "agent restores true")
  }, 180_000)

  test("no tool of the host names the raise function, and no tool input can carry a decision that raises the flag", async () => {
    const tools = await h.call("studio_registry", {}).catch(() => ({}) as S)
    expect(JSON.stringify(tools)).not.toContain("raiseLabelsVerified")
    for (const name of ["raiseLabelsVerified", "studio_labels_verified", "studio_raise_labels_verified"]) {
      const r = await h.call(name, { documentId: doc, pids: [pid], decisionId: "U7" }).catch((e: unknown) => ({ ok: false, _text: String(e), _isError: true }) as S)
      expect(r._isError === true || r.ok === false, name).toBe(true)
    }
    expect(await flags(doc)).toEqual([false, false])
    expect(nextCall(CODE)).not.toMatch(/by: ?user/)
  }, 60_000)
})
