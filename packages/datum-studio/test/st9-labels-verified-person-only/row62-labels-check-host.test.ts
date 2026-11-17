// Swarm 1.3.3 row 62 (ST-9 item 2, U20), host level: the REAL host (binds an ephemeral port: run with the command sandbox
// off), real documents with stored diagrams, the real raise function of row 61 and the real mission store.
// The agent side goes through the host's tools (studio_write, studio_figure_revise, studio_mission_request_decision).
// The person's answer is made the way mission-tools.ts makes it once the hook line lands: `withLabelsCheck` around the
// store's answerDecision with the session of the call (the hook itself is a request to the owner of mission-tools.ts).
import path from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { CHANGE, clone, diagramsOf, FIXTURE, META, startHost, type Host, type S } from "../diagram-persist/hna-host"
import { getStudioStore } from "../../src/store/index.ts"
import type { MissionRowInput, NewMission } from "../../src/store/mission/index.ts"
import { labelsCheckContext, labelsCheckText, withLabelsCheck, type LabelsCheckResult, type LabelsCheckStore } from "../../src/mcp-host/mission/labels-check.ts"

const MISSION = "2026-11-17_row62h"
let h: Host
let store: LabelsCheckStore
const logLines: Array<{ level: string; message: string; context?: Record<string, unknown> }> = []
const log = (level: "info" | "warn" | "error", _s: string, message: string, context?: Record<string, unknown>) => void logLines.push({ level, message, context })

beforeAll(async () => {
  h = await startHost("row62")
  store = getStudioStore() as unknown as LabelsCheckStore
}, 120_000)
afterAll(async () => {
  await h?.close()
})

const block = (): S => {
  const b = clone(FIXTURE.writeBlock)
  b.diagram.spec.labels_verified = false
  return b
}
const flags = async (doc: string) => diagramsOf(await h.content(doc)).map((d) => d.spec.labels_verified)
const revOf = async (id: string): Promise<number> => Number((await h.call("studio_document_get", { documentId: id })).revisionNo)
const row = (id: string): MissionRowInput => ({ id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass" })
const PERSON = { agentId: "mission-control", attested: true }
const AGENT = { agentId: "swarm" }

let doc = ""
let p1 = ""
let p2 = ""
let rev = 0
let useq = 1

/** What studio_mission_answer_decision does with the hook line: the wrapper around the store's answerDecision. */
function answer(request: string, a: { option: string; by: "user" | "controller"; session: { agentId: string; attested?: boolean } }) {
  const decisionId = a.by === "user" ? `U${++useq}` : `C${++useq}`
  return withLabelsCheck({ store, log }, { mission: MISSION, request, by: a.by, session: a.session, dryRun: false }, () =>
    store.transaction(async (t) => store.missions.answerDecision(t, MISSION, request, { option: a.option, by: a.by, decisionId, via: a.session.agentId, attested: a.session.attested === true }, { attested: a.session.attested === true })),
  )
}
const requestArgs = (id: string, context: string, extra: S = {}) => ({
  mission: MISSION,
  request: { id, question: "Label pada dua gambar nota ini sudah Anda periksa?", context, options: [{ id: "approve", label: "Sudah diperiksa", consequence: "Gambar ditandai sudah diperiksa manusia" }, { id: "decline", label: "Belum", consequence: "Dokumen tetap draf" }], ...extra },
})

describe("row 62 (host): the person's decision raises labels_verified on stored figures", () => {
  test("setup: a document with two unchecked figures, a mission row that waits, and the agent's request through the tool", async () => {
    const w = await h.call("studio_write", { mission: MISSION, docKey: "r62-doc", template: "datum-nota", meta: META, sections: [{ heading: "Pendahuluan", blocks: ["Paragraf pembuka sintetis alfa bravo charlie.", block()] }, { heading: "Lanjutan", blocks: ["Paragraf kedua sintetis delta echo foxtrot.", block()] }] })
    expect(w.ok, w._text).not.toBe(false)
    doc = String(w.documentId)
    const ds = diagramsOf(await h.content(doc))
    expect(ds).toHaveLength(2)
    p1 = String(ds[0].id)
    p2 = String(ds[1].id)
    rev = await revOf(doc)
    expect(await flags(doc)).toEqual([false, false])

    const mission: NewMission = { id: MISSION, title: "Row 62 host", type: "feature-release", owner: "master-controller", project: { dir: path.join(import.meta.dir, "..", "..") }, rows: [row("1")], decisions: [{ id: "U1", by: "user", date: "2026-11-17", text: "ok" }] }
    await store.transaction(async (t) => {
      store.missions.create(t, mission, { attested: true })
      store.missions.setAwaitingHumanCheck(t, MISSION, "1", { checks: ["labels_verified"], since: "2026-11-17T01:00:00Z" })
    })

    // The agent asks the person: an ordinary request with the labels-check line as its context (no topic value needed).
    const context = labelsCheckContext({ row: "1", documentId: doc, revisionNo: rev, figures: [p1, p2] })
    expect(context.length).toBeLessThanOrEqual(300)
    const r = await h.call("studio_mission_request_decision", requestArgs("D-1", context))
    console.log(`[row62-host] request: ok=${r.ok} ${String(r._text).slice(0, 300).replace(/\n/g, " / ")}`)
    expect(r.ok, r._text).not.toBe(false)
    // A topic value for it is refused by the store today (fixed set, CHECK constraint of migration 0008).
    const t = await h.call("studio_mission_request_decision", requestArgs("D-9", context, { topic: "labels-verified" }))
    console.log(`[row62-host] topic value: ok=${t.ok} ${String(t._text).slice(0, 200).replace(/\n/g, " / ")}`)
    expect(t.ok).toBe(false)
  }, 180_000)

  test("no tool of the host names the handler or the raise function", async () => {
    const tools = await h.call("studio_help", {}).catch(() => ({}) as S)
    expect(JSON.stringify(tools)).not.toContain("withLabelsCheck")
    const bytes = await h.toolsBytes()
    expect(bytes).toBeGreaterThan(1000)
    for (const name of ["withLabelsCheck", "raiseLabelsVerified", "studio_labels_check", "studio_mission_labels_check"]) {
      const r = await h.call(name, { mission: MISSION, request: "D-1" }).catch((e: unknown) => ({ _isError: true, _text: String(e) }) as S)
      expect(r._isError === true || r.ok === false, name).toBe(true)
    }
    expect(await flags(doc)).toEqual([false, false])
  }, 60_000)

  test("an answer by the controller is refused and nothing changes", async () => {
    const e = await answer("D-1", { option: "approve", by: "controller", session: AGENT }).then(
      () => null,
      (x: unknown) => x as { code?: string },
    )
    expect(e?.code).toBe("LABELS_VERIFIED_PERSON_ONLY")
    expect(store.missions.getDecisionRequest(MISSION, "D-1")!.status).toBe("open")
    expect(await flags(doc)).toEqual([false, false])
  }, 60_000)

  let first: LabelsCheckResult | undefined
  test("the agent changes figure 2 while the request is open; the person approves: figure 1 is raised, figure 2 is not", async () => {
    const edit = await h.call("studio_figure_revise", { documentId: doc, pid: p2, patch: { spec: { direction: "TB", labels_verified: false } }, change: CHANGE, preview: false, baseRevisionNo: rev })
    expect(edit.ok, edit._text).not.toBe(false)
    const r = await answer("D-1", { option: "approve", by: "user", session: PERSON })
    first = r.labelsCheck
    console.log(`[row62-host] answer D-1: ${JSON.stringify(first)}${labelsCheckText(first)}`)
    expect(first).toMatchObject({ outcome: "raised", row: "1", documentId: doc, raised: [p1], alreadyTrue: [], notRaised: [{ figure: p2, cause: "figure-changed-after-check" }], remaining: 1, markerCleared: false })
    expect(await flags(doc)).toEqual([true, false])
    expect(store.missions.rowContract(MISSION, "1").awaitingHumanCheck).toEqual({ checks: ["labels_verified"], since: "2026-11-17T01:00:00Z" })
    // What the revision record shows as author: the person's caller of row 61's function, never an agent.
    const revision = await store.transaction(async (t) => t.get<{ created_by: string; change_what: string; change_why: string }>("SELECT created_by, change_what, change_why FROM revision WHERE document_id = ? AND revision_no = ?", [doc, first!.revisionNo!]))
    console.log(`[row62-host] revision ${first!.revisionNo}: ${JSON.stringify(revision)}`)
    expect(revision?.created_by).toBe("user:mission-control")
    expect(revision?.change_what).toContain(r.decision.id)
    expect(r.decision.by).toBe("user")
  }, 180_000)

  test("a second request for the changed figure at its new revision: the person approves, the row no longer waits", async () => {
    const now = await revOf(doc)
    const q = await h.call("studio_mission_request_decision", requestArgs("D-2", labelsCheckContext({ row: "1", documentId: doc, revisionNo: now, figures: [p2] })))
    expect(q.ok, q._text).not.toBe(false)
    const r = await answer("D-2", { option: "approve", by: "user", session: PERSON })
    console.log(`[row62-host] answer D-2: ${JSON.stringify(r.labelsCheck)}${labelsCheckText(r.labelsCheck)}`)
    expect(r.labelsCheck).toMatchObject({ outcome: "raised", raised: [p2], notRaised: [], remaining: 0, markerCleared: true })
    expect(await flags(doc)).toEqual([true, true])
    const marker = store.missions.rowContract(MISSION, "1").awaitingHumanCheck
    expect(marker).toMatchObject({ checks: ["labels_verified"], clearedBy: r.decision.id })
    expect(marker?.clearedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(logLines.filter((l) => l.level === "error")).toEqual([])
  }, 180_000)
})
