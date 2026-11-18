// Swarm 1.3.3 row 62 (ST-9 item 2, U20): `labels_verified` is raised only from a decision recorded by the user.
// Real SqliteStudioStore (missions, decisions, requests, row markers) over a temp folder. The document side is injected:
// a figure source and a raise function that record their calls (the real ones run in row62-labels-check-host.test.ts).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { SqliteStudioStore } from "../../src/store/index.ts"
import type { MissionRowInput, NewMission } from "../../src/store/mission/index.ts"
import {
  LABELS_CHECK_MARK,
  labelsCheckContext,
  labelsCheckOf,
  labelsCheckText,
  labelsRequestIssues,
  withLabelsCheck,
  type LabelsCheckDeps,
  type LabelsFigureSource,
} from "../../src/mcp-host/mission/labels-check.ts"
import { MISSION_TOOL_SCHEMAS } from "../../src/mcp-host/mission/schemas.ts"

const PKG = path.resolve(import.meta.dir, "..", "..")
const RUN = mkdtempSync(path.join(tmpdir(), "row62-unit-"))
const MID = "2026-11-17_row62"
const OTHER = "2026-11-17_row62-other"
const DOC = "docrow62000000000000000"
const FOREIGN = "docforeign0000000000000"
let tick = 1_800_000_000_000
const store = new SqliteStudioStore()
const M = () => store.missions

const row = (id: string): MissionRowInput => ({ id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass" })
const mission = (id: string): NewMission => ({ id, title: "Row 62", type: "feature-release", owner: "master-controller", project: { dir: path.join(RUN, "project") }, rows: [row("1"), row("2")], decisions: [{ id: "U1", by: "user", date: "2026-11-17", text: "ok" }] })

beforeAll(async () => {
  mkdirSync(path.join(RUN, "project"), { recursive: true })
  await store.open(path.join(RUN, "store"), { release: "1.3.3", log: () => {}, agentClock: () => ++tick })
  await store.transaction(async (t) => {
    M().create(t, mission(MID), { attested: true })
    M().create(t, mission(OTHER), { attested: true })
  })
})
afterAll(async () => {
  await store.close()
  rmSync(RUN, { recursive: true, force: true })
})

type Spec = Record<string, unknown>
const spec = (label: string, verified = false): Spec => ({ kind: "flow", nodes: [{ id: "a", label }], labels_verified: verified })

/** A fake document: revision -> pid -> spec; `raise` flips the flag on the current revision and adds a revision. */
function fakeDocs(init: Record<string, { missionFolder: string | null; revisions: Record<number, Record<string, Spec>> }>) {
  const docs = structuredClone(init)
  const raiseCalls: Array<{ documentId: string; pids: string[]; decisionId: string; mission?: string }> = []
  const figures: LabelsFigureSource = {
    async read(documentId, revisionNo) {
      const d = docs[documentId]
      if (!d) return null
      const current = Math.max(...Object.keys(d.revisions).map(Number))
      const m = (r: Record<string, Spec> | undefined) => (r ? new Map(Object.entries(r)) : null)
      return { missionFolder: d.missionFolder, currentRevisionNo: current, named: m(d.revisions[revisionNo]), current: m(d.revisions[current])! }
    },
  }
  const raise: LabelsCheckDeps["raise"] = async (input) => {
    raiseCalls.push({ documentId: input.documentId, pids: [...(input.pids ?? [])], decisionId: input.decisionId, ...(input.mission ? { mission: input.mission } : {}) })
    const d = docs[input.documentId]!
    let current = Math.max(...Object.keys(d.revisions).map(Number))
    const raised: string[] = []
    const alreadyTrue: string[] = []
    for (const pid of input.pids ?? []) {
      const cur = d.revisions[current]!
      if (cur[pid]!.labels_verified === true) {
        alreadyTrue.push(pid)
        continue
      }
      d.revisions[current + 1] = { ...structuredClone(cur), [pid]: { ...cur[pid], labels_verified: true } }
      current += 1
      raised.push(pid)
    }
    return { documentId: input.documentId, raised, alreadyTrue, revisionNo: current }
  }
  return { docs, figures, raise, raiseCalls }
}

const logLines: Array<{ level: string; message: string; context?: Record<string, unknown> }> = []
const log: LabelsCheckDeps["log"] = (level, _source, message, context) => void logLines.push({ level, message, context })
const PERSON = { agentId: "mission-control", attested: true }
const AGENT = { agentId: "swarm" }

let seq = 0
/** Opens a decision request in the real store (as an agent would through studio_mission_request_decision). */
async function openRequest(context: string | undefined, opts: { mission?: string; options?: string[] } = {}): Promise<string> {
  const id = `D-${++seq}`
  const options = (opts.options ?? ["approve", "decline"]).map((o) => ({ id: o, label: `pilihan ${o}`, consequence: `akibat ${o}` }))
  await store.transaction(async (t) => M().requestDecision(t, opts.mission ?? MID, { id, question: "Apakah label gambar sudah diperiksa?", ...(context !== undefined ? { context } : {}), options }))
  return id
}

let useq = 1
/** The call mission-tools.ts makes: the wrapper around the store's answerDecision, with the session of the call. */
function answer(
  fake: ReturnType<typeof fakeDocs>,
  request: string,
  a: { option: string; by: "user" | "controller"; session: { agentId: string; attested?: boolean }; mission?: string; dryRun?: boolean; storeBy?: "user" | "controller" },
) {
  const mission = a.mission ?? MID
  const by = a.storeBy ?? a.by
  const decisionId = by === "user" ? `U${++useq}` : `C${++useq}`
  let called = 0
  const run = withLabelsCheck({ store, log, figures: fake.figures, raise: fake.raise, now: () => 1_800_000_500_000 }, { mission, request, by: a.by, session: a.session, dryRun: a.dryRun === true }, async () => {
    called += 1
    return store.transaction(async (t) => M().answerDecision(t, mission, request, { option: a.option, by, decisionId, via: a.session.agentId, attested: a.session.attested === true }, { attested: a.session.attested === true }))
  })
  return { run, decisionId, called: () => called }
}

const awaiting = (r = "1") => M().rowContract(MID, r).awaitingHumanCheck
async function mark(r = "1") {
  await store.transaction(async (t) => M().setAwaitingHumanCheck(t, MID, r, { checks: ["labels_verified"], since: "2026-11-17T01:00:00Z" }))
}

describe("row 62: which request is the human check of figure labels", () => {
  test("the context line round-trips; an ordinary request is not a labels check", () => {
    const naming = { row: "1", documentId: DOC, revisionNo: 3, figures: ["p-aaa", "p-bbb"] }
    const line = labelsCheckContext(naming)
    expect(line.startsWith(`${LABELS_CHECK_MARK} `)).toBe(true)
    expect(line).toBe(`labels_verified row=1 document=${DOC} revision=3 figures=p-aaa,p-bbb`)
    expect(labelsCheckOf({ context: line })).toEqual({ naming })
    expect(labelsCheckOf({})).toBeNull()
    expect(labelsCheckOf({ context: "Pilih vendor untuk baris 4" })).toBeNull()
    expect(labelsCheckOf({ context: "labels_verified_extra row=1" })).toBeNull()
  })

  test("a marked line that names no figures (or is malformed) is a labels check without naming", () => {
    for (const context of ["labels_verified", "labels_verified row=1", `labels_verified row=1 document=${DOC} revision=3 figures=`, `labels_verified row=1 document=${DOC} revision=0 figures=p-a`, `labels_verified document=${DOC} revision=3 figures=p-a`, `labels_verified row=1 document=${DOC} revision=3 figures=p-a,p-a`]) {
      const got = labelsCheckOf({ context })
      expect(got, context).not.toBeNull()
      expect(got!.naming, context).toBeUndefined()
      expect(typeof got!.malformed, context).toBe("string")
    }
  })

  test("request-time issues: options are exactly approve, decline and the line must name figures", () => {
    const ok = { context: labelsCheckContext({ row: "1", documentId: DOC, revisionNo: 3, figures: ["p-a"] }), options: [{ id: "approve" }, { id: "decline" }] }
    expect(labelsRequestIssues(ok)).toEqual([])
    expect(labelsRequestIssues({ context: "biasa", options: [{ id: "x" }, { id: "y" }] })).toEqual([])
    expect(labelsRequestIssues({ ...ok, options: [{ id: "ya" }, { id: "tidak" }] }).map((i) => i.pointer)).toEqual(["/request/options"])
    expect(labelsRequestIssues({ context: "labels_verified row=1", options: ok.options }).map((i) => i.pointer)).toEqual(["/request/context"])
  })
})

describe("row 62: an answer recorded by the user raises the flag", () => {
  test("user approves: exactly the named figures are raised through the raise function and the row marker is cleared", async () => {
    const fake = fakeDocs({ [DOC]: { missionFolder: MID, revisions: { 3: { "p-aaa": spec("A"), "p-bbb": spec("B") } } } })
    await mark("1")
    const req = await openRequest(labelsCheckContext({ row: "1", documentId: DOC, revisionNo: 3, figures: ["p-aaa", "p-bbb"] }))
    const a = answer(fake, req, { option: "approve", by: "user", session: PERSON })
    const r = await a.run
    expect(a.called()).toBe(1)
    expect(fake.raiseCalls).toEqual([{ documentId: DOC, pids: ["p-aaa", "p-bbb"], decisionId: a.decisionId, mission: MID }])
    expect(r.labelsCheck).toMatchObject({ outcome: "raised", decision: a.decisionId, row: "1", documentId: DOC, revisionNo: 5, raised: ["p-aaa", "p-bbb"], alreadyTrue: [], notRaised: [], remaining: 0, markerCleared: true })
    expect(awaiting("1")).toEqual({ checks: ["labels_verified"], since: "2026-11-17T01:00:00Z", clearedBy: a.decisionId, clearedAt: "2027-01-15T08:08:20.000Z" })
    expect(r.request.status).toBe("answered")
    const text = labelsCheckText(r.labelsCheck)
    console.log(`[row62-unit] reply:${text}`)
    expect(text).toContain("labels_verified")
    expect(text).toContain(a.decisionId)
    expect(text).toContain("p-aaa, p-bbb")
  })

  test("a figure whose spec changed since the named revision is not raised; the reply names it and the marker stays", async () => {
    const fake = fakeDocs({ [DOC]: { missionFolder: MID, revisions: { 3: { "p-aaa": spec("A"), "p-bbb": spec("B") }, 4: { "p-aaa": spec("A"), "p-bbb": spec("B diubah agen") } } } })
    await mark("2")
    const req = await openRequest(labelsCheckContext({ row: "2", documentId: DOC, revisionNo: 3, figures: ["p-aaa", "p-bbb", "p-zzz"] }))
    const a = answer(fake, req, { option: "approve", by: "user", session: PERSON })
    const r = await a.run
    expect(fake.raiseCalls).toEqual([{ documentId: DOC, pids: ["p-aaa"], decisionId: a.decisionId, mission: MID }])
    expect(r.labelsCheck).toMatchObject({ outcome: "raised", raised: ["p-aaa"], markerCleared: false, remaining: 1 })
    expect(r.labelsCheck!.notRaised).toEqual([
      { figure: "p-bbb", cause: "figure-changed-after-check" },
      { figure: "p-zzz", cause: "not-in-named-revision" },
    ])
    expect(awaiting("2")).toEqual({ checks: ["labels_verified"], since: "2026-11-17T01:00:00Z" })
    const text = labelsCheckText(r.labelsCheck)
    console.log(`[row62-unit] reply:${text}`)
    expect(text).toContain("p-bbb (figure-changed-after-check)")
  })

  test("a caption-free comparison: only the spec decides, and the flag itself is not part of the comparison", async () => {
    const fake = fakeDocs({ [DOC]: { missionFolder: MID, revisions: { 3: { "p-aaa": spec("A", false) }, 4: { "p-aaa": spec("A", true) } } } })
    const req = await openRequest(labelsCheckContext({ row: "1", documentId: DOC, revisionNo: 3, figures: ["p-aaa"] }))
    const r = await answer(fake, req, { option: "approve", by: "user", session: PERSON }).run
    expect(r.labelsCheck).toMatchObject({ outcome: "raised", raised: [], alreadyTrue: ["p-aaa"], notRaised: [] })
  })

  test("user declines: nothing is raised and the marker stays", async () => {
    const fake = fakeDocs({ [DOC]: { missionFolder: MID, revisions: { 3: { "p-aaa": spec("A") } } } })
    const req = await openRequest(labelsCheckContext({ row: "2", documentId: DOC, revisionNo: 3, figures: ["p-aaa"] }))
    const r = await answer(fake, req, { option: "decline", by: "user", session: PERSON }).run
    expect(fake.raiseCalls).toEqual([])
    expect(r.labelsCheck).toMatchObject({ outcome: "not-approved", raised: [] })
    expect(awaiting("2")!.clearedBy).toBeUndefined()
  })
})

describe("row 62: everything else raises nothing", () => {
  test("an answer by the controller (an agent) is refused before anything is stored", async () => {
    const fake = fakeDocs({ [DOC]: { missionFolder: MID, revisions: { 3: { "p-aaa": spec("A") } } } })
    const req = await openRequest(labelsCheckContext({ row: "2", documentId: DOC, revisionNo: 3, figures: ["p-aaa"] }))
    for (const session of [AGENT, PERSON]) {
      const a = answer(fake, req, { option: "approve", by: "controller", session })
      const e = await a.run.then(
        () => null,
        (x: unknown) => x as { code?: string; message?: string; details?: Record<string, unknown> },
      )
      expect(e?.code).toBe("LABELS_VERIFIED_PERSON_ONLY")
      expect(e?.details).toMatchObject({ field: "labels_verified", pointer: "/by", mission: MID, request: req })
      expect(a.called()).toBe(0)
    }
    console.log(`[row62-unit] refusal logged: ${JSON.stringify(logLines.filter((l) => l.message === "LABELS_VERIFIED_PERSON_ONLY").at(-1))}`)
    expect(logLines.some((l) => l.level === "warn" && l.message === "LABELS_VERIFIED_PERSON_ONLY")).toBe(true)
    expect(M().getDecisionRequest(MID, req)!.status).toBe("open")
    expect(fake.raiseCalls).toEqual([])
  })

  test("by: user from a session that is not attested is refused before anything is stored", async () => {
    const fake = fakeDocs({ [DOC]: { missionFolder: MID, revisions: { 3: { "p-aaa": spec("A") } } } })
    const req = await openRequest(labelsCheckContext({ row: "2", documentId: DOC, revisionNo: 3, figures: ["p-aaa"] }))
    const a = answer(fake, req, { option: "approve", by: "user", session: AGENT })
    const e = await a.run.then(
      () => null,
      (x: unknown) => x as { code?: string },
    )
    expect(e?.code).toBe("LABELS_VERIFIED_PERSON_ONLY")
    expect(a.called()).toBe(0)
    expect(M().getDecisionRequest(MID, req)!.status).toBe("open")
  })

  test("the stored record decides, not the arguments: a decision stored by: controller raises nothing even when the call says user", async () => {
    const fake = fakeDocs({ [DOC]: { missionFolder: MID, revisions: { 3: { "p-aaa": spec("A") } } } })
    const req = await openRequest(labelsCheckContext({ row: "2", documentId: DOC, revisionNo: 3, figures: ["p-aaa"] }))
    const r = await answer(fake, req, { option: "approve", by: "user", storeBy: "controller", session: PERSON }).run
    expect(r.request.answer?.by).toBe("controller")
    expect(fake.raiseCalls).toEqual([])
    expect(r.labelsCheck).toMatchObject({ outcome: "not-by-user", raised: [] })
  })

  test("an approval of a request of another topic (no mark) raises nothing and the reply has no labels line", async () => {
    const fake = fakeDocs({ [DOC]: { missionFolder: MID, revisions: { 3: { "p-aaa": spec("A") } } } })
    const req = await openRequest(`Periksa label dokumen ${DOC} revision=3 figures=p-aaa`)
    const r = await answer(fake, req, { option: "approve", by: "user", session: PERSON }).run
    expect(r.request.status).toBe("answered")
    expect(r.labelsCheck).toBeUndefined()
    expect(labelsCheckText(r.labelsCheck)).toBe("")
    expect(fake.raiseCalls).toEqual([])
    // an ordinary request may still be answered by the controller
    const req2 = await openRequest(undefined)
    const r2 = await answer(fake, req2, { option: "approve", by: "controller", session: AGENT }).run
    expect(r2.request.answer?.by).toBe("controller")
    expect(r2.labelsCheck).toBeUndefined()
  })

  test("an approval that names no figures raises nothing", async () => {
    const fake = fakeDocs({ [DOC]: { missionFolder: MID, revisions: { 3: { "p-aaa": spec("A") } } } })
    const req = await openRequest("labels_verified row=2")
    const r = await answer(fake, req, { option: "approve", by: "user", session: PERSON }).run
    expect(fake.raiseCalls).toEqual([])
    expect(r.labelsCheck).toMatchObject({ outcome: "no-figures-named", raised: [] })
  })

  test("options other than approve/decline: the option named approve is the only approval", async () => {
    const fake = fakeDocs({ [DOC]: { missionFolder: MID, revisions: { 3: { "p-aaa": spec("A") } } } })
    const req = await openRequest(labelsCheckContext({ row: "2", documentId: DOC, revisionNo: 3, figures: ["p-aaa"] }), { options: ["ya", "tidak"] })
    const r = await answer(fake, req, { option: "ya", by: "user", session: PERSON }).run
    expect(fake.raiseCalls).toEqual([])
    expect(r.labelsCheck).toMatchObject({ outcome: "not-approved" })
  })

  test("a document of another mission, an unknown document and an unknown row raise nothing", async () => {
    const fake = fakeDocs({ [FOREIGN]: { missionFolder: OTHER, revisions: { 1: { "p-aaa": spec("A") } } }, [DOC]: { missionFolder: MID, revisions: { 3: { "p-aaa": spec("A") } } } })
    const cases: Array<[string, string]> = [
      [labelsCheckContext({ row: "2", documentId: FOREIGN, revisionNo: 1, figures: ["p-aaa"] }), "document-not-of-mission"],
      [labelsCheckContext({ row: "2", documentId: "docunknown0000000000000", revisionNo: 1, figures: ["p-aaa"] }), "document-unknown"],
      [labelsCheckContext({ row: "99", documentId: DOC, revisionNo: 3, figures: ["p-aaa"] }), "row-unknown"],
    ]
    for (const [context, outcome] of cases) {
      const req = await openRequest(context)
      const r = await answer(fake, req, { option: "approve", by: "user", session: PERSON }).run
      expect(r.labelsCheck, context).toMatchObject({ outcome, raised: [] })
    }
    expect(fake.raiseCalls).toEqual([])
  })

  test("a dry run raises nothing", async () => {
    const fake = fakeDocs({ [DOC]: { missionFolder: MID, revisions: { 3: { "p-aaa": spec("A") } } } })
    const req = await openRequest(labelsCheckContext({ row: "2", documentId: DOC, revisionNo: 3, figures: ["p-aaa"] }))
    const r = await answer(fake, req, { option: "approve", by: "user", session: PERSON, dryRun: true }).run
    expect(fake.raiseCalls).toEqual([])
    expect(r.labelsCheck).toBeUndefined()
  })

  test("a raise that fails is reported and logged as an error; the stored answer stays", async () => {
    const fake = fakeDocs({ [DOC]: { missionFolder: MID, revisions: { 3: { "p-aaa": spec("A") } } } })
    const req = await openRequest(labelsCheckContext({ row: "2", documentId: DOC, revisionNo: 3, figures: ["p-aaa"] }))
    const mission = MID
    const before = logLines.length
    const r = await withLabelsCheck(
      { store, log, figures: fake.figures, raise: async () => Promise.reject(Object.assign(new Error("boom"), { code: "SCOPE_CONFLICT" })), now: () => 1_800_000_500_000 },
      { mission, request: req, by: "user", session: PERSON, dryRun: false },
      () => store.transaction(async (t) => M().answerDecision(t, mission, req, { option: "approve", by: "user", decisionId: `U${++useq}`, via: "mission-control", attested: true }, { attested: true })),
    )
    expect(r.labelsCheck).toMatchObject({ outcome: "raise-failed", raised: [], code: "SCOPE_CONFLICT" })
    expect(r.request.status).toBe("answered")
    const line = logLines.slice(before).find((l) => l.level === "error")
    expect(line?.context).toMatchObject({ mission: MID, request: req, code: "SCOPE_CONFLICT" })
    expect(typeof line?.context?.stack).toBe("string")
  })
})

describe("row 62: no agent tool input reaches the raise", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => ((p) => (statSync(p).isDirectory() ? walk(p) : /\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : []))(path.join(dir, n)))
  const src = walk(path.join(PKG, "src"))
  const rel = (p: string) => path.relative(PKG, p)
  const importers = (needle: string) => src.filter((p) => readFileSync(p, "utf8").includes(needle)).map(rel).sort()

  test("the mission tool input schemas name neither the raise function, the handler nor the flag", () => {
    const table = JSON.stringify(MISSION_TOOL_SCHEMAS)
    for (const word of ["raiseLabelsVerified", "withLabelsCheck", "labels-check", "labels_verified", "labelsVerified"]) expect(table.includes(word), word).toBe(false)
  })

  test("only the handler imports the raise function; only the answer tool may import the handler", () => {
    expect(importers("labels-verified-raise")).toEqual(["src/mcp-host/mission/labels-check.ts"])
    const users = importers("labels-check.ts").filter((p) => p !== "src/mcp-host/mission/labels-check.ts")
    for (const p of users) expect(p).toBe("src/mcp-host/mission/mission-tools.ts")
  })

  test("the handler is not exported by a barrel and takes the raise decision from the store, not from its arguments", () => {
    for (const barrel of ["src/mcp-host/index.ts", "src/mcp-host/mission/index.ts", "src/store-bridge/index.ts"]) expect(readFileSync(path.join(PKG, barrel), "utf8").includes("labels-check")).toBe(false)
    const body = readFileSync(path.join(PKG, "src/mcp-host/mission/labels-check.ts"), "utf8")
    // one call of the raise function, fed from the stored request (`stored.`), never from the call context
    expect(body.match(/\braise\(\{/g)?.length).toBe(1)
    expect(body).toContain("decisionId: stored.answer.decision")
  })
})
