// Swarm 1.3.3 row 62 (ST-9 item 2, U20), end to end through the REAL tools of the REAL host (binds an ephemeral port:
// run with the command sandbox off). The agent is an MCP SDK client without the Mission Control key; the person is
// `personCaller` (the key on every request, as the desktop's mission client sends it). Synthetic data only.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { CHANGE, clone, diagramsOf, FIXTURE, META, type S } from "../diagram-persist/hna-host"
import { PERSON_KEY, personCaller } from "../mission-tools/_attested-person.ts"
import type { MissionRowInput, NewMission } from "../../src/store/mission/index.ts"
import { labelsCheckContext } from "../../src/mcp-host/mission/labels-check.ts"

const PKG = path.resolve(import.meta.dir, "..", "..")
const VENDOR = path.join(PKG, "vendor")
const TEMPLATES = path.join(PKG, "templates")
const WORK = realpathSync(mkdtempSync(path.join(tmpdir(), "row62-tools-")))
const STORE = path.join(WORK, "datum-studio")
const HOME = path.join(WORK, "home")
const RES = path.join(WORK, "Swarm.app", "Contents", "Resources")
const PROJECT = path.join(HOME, "project-row62")
for (const d of [HOME, RES, PROJECT]) mkdirSync(d, { recursive: true })
const TOKEN = "f".repeat(16) + "0123456789abcdef".repeat(3)
const MISSION = "2026-11-17_row62t"
const CODE = "LABELS_VERIFIED_PERSON_ONLY"

let mod: S
let store: S
let host: S
let agent: Client
let person: ReturnType<typeof personCaller>
const logs: Array<{ level: string; source: string; message: string; context?: Record<string, unknown> }> = []
const realFetch = globalThis.fetch

beforeAll(async () => {
  process.env.STUDIO_WORKSPACE_ROOT = STORE
  process.env.STUDIO_ASSETS_ROOT = path.join(VENDOR, "src", "lib", "studio", "assets")
  process.env.STUDIO_VENDOR_ROOT = VENDOR
  process.env.STUDIO_RENDER_RATE_LIMIT = "1000"
  delete process.env.STUDIO_MCP_FILE_ROOTS
  delete process.env.INTERNAL_API_SECRET
  const { resetStudioEnvCache } = await import("../../vendor/src/lib/studio/contract/env")
  resetStudioEnvCache()
  mod = await import("../../src/mcp-host/index.ts")
  store = await mod.openHostStore(STORE, { release: "1.3.3", logFile: path.join(WORK, "logs", "store.jsonl") })
  mod.configureTemplateSource({ templatesDir: TEMPLATES, assetRepoRoot: VENDOR, release: "1.3.3" })
  const log = (level: string, source: string, message: string, context?: Record<string, unknown>) => void logs.push({ level, source, message, context })
  const facts = { home: HOME, resourcesPath: RES, execPath: path.join(WORK, "Swarm.app", "Contents", "MacOS", "Swarm") }
  host = await mod.startStudioHostServer({ store, token: TOKEN, missionControlKey: PERSON_KEY, hostname: "127.0.0.1", port: 0, log, facts } as never)
  agent = new Client({ name: "row62-agent", version: "0" })
  await agent.connect(new StreamableHTTPClientTransport(new URL(host.url), { fetch: realFetch as never, requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-studio-agent": "swarm", "x-studio-caller-cwd": encodeURIComponent(PROJECT) } } }))
  person = personCaller({ url: host.url, token: TOKEN, cwd: PROJECT, agent: "mission-control", fetchImpl: realFetch })
}, 120_000)
afterAll(async () => {
  await agent?.close().catch(() => undefined)
  await host?.close()
  mod?.configureTemplateSource(null)
  if (store) await mod.closeHostStore(store)
  rmSync(WORK, { recursive: true, force: true })
})

const call = async (name: string, args: unknown): Promise<S> => {
  const r = await agent.callTool({ name, arguments: args as Record<string, unknown> })
  const text = ((r.content ?? []) as Array<{ type: string; text?: string }>).map((x) => x.text ?? "").join("\n")
  return { ...((r.structuredContent ?? {}) as S), _isError: r.isError === true, _text: text }
}
const content = async (id: string): Promise<S> => (await call("studio_document_get", { documentId: id, view: "content" })).content as S
const flags = async (id: string) => diagramsOf(await content(id)).map((d) => d.spec.labels_verified)
const revOf = async (id: string) => Number((await call("studio_document_get", { documentId: id })).revisionNo)
const block = (): S => {
  const b = clone(FIXTURE.writeBlock)
  b.diagram.spec.labels_verified = false
  return b
}
const row = (id: string): MissionRowInput => ({ id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass" })
const ask = (id: string, context: string, options = [{ id: "approve", label: "Sudah diperiksa", consequence: "Gambar ditandai sudah diperiksa manusia" }, { id: "decline", label: "Belum", consequence: "Dokumen tetap draf" }]) =>
  call("studio_mission_request_decision", { mission: MISSION, request: { id, question: "Label gambar nota ini sudah Anda periksa?", context, options } })
const brief = (r: S) => String(r._text ?? JSON.stringify(r)).slice(0, 360).replace(/\n/g, " / ")

let doc = ""
let p1 = ""
let p2 = ""
let rev = 0

describe("row 62 (real tools): the person's answer raises labels_verified; an agent's answer is refused", () => {
  test("setup: an agent writes a document with two unchecked figures; the row waits for the label check", async () => {
    const w = await call("studio_write", { mission: MISSION, docKey: "r62t-doc", template: "datum-nota", meta: META, sections: [{ heading: "Pendahuluan", blocks: ["Paragraf pembuka sintetis alfa bravo charlie.", block()] }, { heading: "Lanjutan", blocks: ["Paragraf kedua sintetis delta echo foxtrot.", block()] }] })
    expect(w.ok, w._text).not.toBe(false)
    doc = String(w.documentId)
    const ds = diagramsOf(await content(doc))
    expect(ds).toHaveLength(2)
    p1 = String(ds[0].id)
    p2 = String(ds[1].id)
    rev = await revOf(doc)
    const mission: NewMission = { id: MISSION, title: "Row 62 tools", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: [row("1")], decisions: [{ id: "U1", by: "user", date: "2026-11-17", text: "ok" }] }
    await store.transaction(async (t: S) => {
      store.missions.create(t, mission, { attested: true })
      store.missions.setAwaitingHumanCheck(t, MISSION, "1", { checks: ["labels_verified"], since: "2026-11-17T01:00:00Z" })
    })
    expect(await flags(doc)).toEqual([false, false])
  }, 180_000)

  test("request time: unanswerable label checks are refused before the person is asked", async () => {
    const cases: Array<[string, string, S[] | undefined, string]> = [
      ["D-90", "labels_verified row=1", undefined, "the line must be"],
      ["D-91", `labels_verified row=1 document=${doc} revision=${rev} figures=`, undefined, "the line must be"],
      ["D-92", `labels_verified  row=1 document=${doc} revision=${rev} figures=${p1}`, undefined, "the line must be"],
      ["D-93", labelsCheckContext({ row: "1", documentId: doc, revisionNo: rev, figures: ["p-doesnotexist"] }), undefined, "is not a diagram of revision"],
      ["D-94", labelsCheckContext({ row: "7", documentId: doc, revisionNo: rev, figures: [p1] }), undefined, "is not a row of this mission"],
      ["D-95", labelsCheckContext({ row: "1", documentId: "docunknown0000000000000", revisionNo: 1, figures: [p1] }), undefined, "is not in the store"],
      ["D-96", labelsCheckContext({ row: "1", documentId: doc, revisionNo: 99, figures: [p1] }), undefined, "has no revision 99"],
      ["D-97", labelsCheckContext({ row: "1", documentId: doc, revisionNo: rev, figures: [p1] }), [{ id: "ya", label: "Ya", consequence: "a" }, { id: "tidak", label: "Tidak", consequence: "b" }], "exactly the options approve, decline"],
    ]
    for (const [id, context, options, words] of cases) {
      const r = await ask(id, context, options as never)
      console.log(`[row62-tools] ${id}: ok=${r.ok} ${brief(r)}`)
      expect(r.ok, `${id}: ${r._text}`).toBe(false)
      expect(JSON.stringify(r), id).toContain("SCHEMA_INVALID")
      expect(JSON.stringify(r), id).toContain(words)
    }
  }, 120_000)

  test("the agent asks for figure 1 only: accepted, and the reply says another figure is unchecked and to send several requests", async () => {
    const r = await ask("D-1", labelsCheckContext({ row: "1", documentId: doc, revisionNo: rev, figures: [p1] }))
    console.log(`[row62-tools] D-1: ok=${r.ok} ${brief(r)}`)
    expect(r.ok, r._text).not.toBe(false)
    expect(r._text).toContain("1 other figure(s)")
    expect(r._text).toContain("send several requests")
  }, 60_000)

  test("the agent answers its own label check: refused (approve and decline), nothing stored, flags unchanged", async () => {
    for (const option of ["approve", "decline"]) {
      const r = await call("studio_mission_answer_decision", { mission: MISSION, request: "D-1", option, by: "controller", decisionId: option === "approve" ? "C5" : "C6" })
      console.log(`[row62-tools] agent ${option}: ok=${r.ok} ${brief(r)}`)
      expect(r.ok === false, String(r._text)).toBe(true)
      expect(JSON.stringify(r)).toContain(CODE)
    }
    const u = await call("studio_mission_answer_decision", { mission: MISSION, request: "D-1", option: "approve", by: "user", decisionId: "U5" })
    console.log(`[row62-tools] agent as user: ok=${u.ok} ${brief(u)}`)
    expect(u.ok).toBe(false)
    expect(JSON.stringify(u)).toContain("SESSION_NOT_ATTESTED")
    expect(store.missions.getDecisionRequest(MISSION, "D-1").status).toBe("open")
    expect(await flags(doc)).toEqual([false, false])
    expect(logs.some((l) => l.level === "warn" && l.message === CODE)).toBe(true)
  }, 60_000)

  test("the person approves D-1 in Mission Control: figure 1 raised, the row still waits for figure 2", async () => {
    const r = await person("studio_mission_answer_decision", { mission: MISSION, request: "D-1", option: "approve", by: "user", decisionId: "U2" })
    console.log(`[row62-tools] person D-1: ${JSON.stringify(r.labelsCheck)}`)
    expect(r.ok, JSON.stringify(r)).not.toBe(false)
    expect(r.labelsCheck).toMatchObject({ outcome: "raised", decision: "U2", raised: [p1], notRaised: [], remaining: 1, markerCleared: false })
    expect(await flags(doc)).toEqual([true, false])
    expect(store.missions.rowContract(MISSION, "1").awaitingHumanCheck.clearedBy).toBeUndefined()
  }, 120_000)

  test("figure 2 changed after the request: not raised; a new request at the new revision raises it and clears the marker", async () => {
    const now0 = await revOf(doc)
    expect((await ask("D-2", labelsCheckContext({ row: "1", documentId: doc, revisionNo: now0, figures: [p2] }))).ok).not.toBe(false)
    const edit = await call("studio_figure_revise", { documentId: doc, pid: p2, patch: { spec: { direction: "TB", labels_verified: false } }, change: CHANGE, preview: false, baseRevisionNo: now0 })
    expect(edit.ok, edit._text).not.toBe(false)
    const stale = await person("studio_mission_answer_decision", { mission: MISSION, request: "D-2", option: "approve", by: "user", decisionId: "U3" })
    console.log(`[row62-tools] person D-2: ${JSON.stringify(stale.labelsCheck)}`)
    expect(stale.labelsCheck).toMatchObject({ outcome: "raised", raised: [], notRaised: [{ figure: p2, cause: "figure-changed-after-check" }], markerCleared: false })
    expect(await flags(doc)).toEqual([true, false])

    const now1 = await revOf(doc)
    expect((await ask("D-3", labelsCheckContext({ row: "1", documentId: doc, revisionNo: now1, figures: [p2] }))).ok).not.toBe(false)
    const r = await person("studio_mission_answer_decision", { mission: MISSION, request: "D-3", option: "approve", by: "user", decisionId: "U4" })
    console.log(`[row62-tools] person D-3: ${JSON.stringify(r.labelsCheck)}`)
    expect(r.labelsCheck).toMatchObject({ outcome: "raised", decision: "U4", raised: [p2], notRaised: [], remaining: 0, markerCleared: true })
    expect(await flags(doc)).toEqual([true, true])
    const marker = store.missions.rowContract(MISSION, "1").awaitingHumanCheck
    expect(marker).toMatchObject({ checks: ["labels_verified"], clearedBy: "U4" })
    const by = await store.transaction(async (t: S) => t.get("SELECT created_by FROM revision WHERE document_id = ? AND revision_no = ?", [doc, r.labelsCheck.revisionNo]))
    expect(by.created_by).toBe("user:mission-control")
    expect(logs.filter((l) => l.level === "error" && String(l.source).includes("labels-check"))).toEqual([])
  }, 180_000)
})
