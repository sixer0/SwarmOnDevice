// 1.2.8 row 45, N8-363 (AC-PROJb, 01d §3.3, §4, §7.3): `studio_mission_place` (N8-143) and the store method
// `setProjectDir` (N8-142) re-point a mission to a marked group folder only on an answered placement (join/new) or
// tidy (approve, `tidyMission` N8-455) request; anything else is PLACE_DECISION_UNANSWERED (N8-145). The decision
// request schema takes `topic` (N8-146/147), option `group` + `groupKind` (N8-454/149) and a tidy `proposal` of at most
// 200 items (N8-148). opencode hides the tool from agents (PERSON_ONLY_MCP_TOOLS, N8-456).
// Synthetic input only: the row 25b Default Project tree (test/fixtures/syn128/default_project*), copied to a mkdtemp
// `home/Documents/Default Project`. No server, no port: the tools are called through missionTools().
import { afterAll, describe, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SqliteStudioStore } from "../../src/store/index.ts"
import { missionTools } from "../../src/mcp-host/mission/mission-tools.ts"

type S = Record<string, any>
const PKG = path.resolve(import.meta.dir, "..", "..")
const FIXTURES = path.join(PKG, "test", "fixtures", "syn128")
const MANIFEST = (await Bun.file(path.join(FIXTURES, "default_project_missions.json")).json()) as { missions: Array<{ id: string; title: string; expectedGroup: string | null; groupKind?: string }> }
const OC_MCP = path.resolve(PKG, "..", "opencode", "src", "mcp")

const BASE = process.env.REL128_TEST_DIR ?? path.join(tmpdir(), "rel128-tests")
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(BASE, "projb-")))
const R = path.join(WORK, "home", "Documents", "Default Project")
mkdirSync(path.dirname(R), { recursive: true })
cpSync(path.join(FIXTURES, "default_project"), R, { recursive: true })

let tick = 1_800_000_000_000
const store = new SqliteStudioStore()
await store.open(path.join(WORK, "store"), { release: "1.2.8", log: () => {}, agentClock: () => ++tick })
afterAll(async () => {
  await store.close()
})
const tools = missionTools(store, { log: () => {} })
// Row 45b (AC-SEC05, INTENT): placement runs from an attested Mission Control session (AC-PROJb "From an attested
// Mission Control session"); the unattested case is the last test.
const session = { sessionId: "mcp-45", agentId: "swarm", fileRoot: R, attested: true as const }

async function call(name: string, args: S): Promise<S & { text: string }> {
  const r = await tools.find((t) => t.name === name)!.call(args, session)
  return { ...((r.structuredContent ?? {}) as S), text: (r.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n") }
}
const row = (id: string) => ({ id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass" })
const dirOf = (id: string) => store.missions.get(id)!.mission.project.dir as string
const mission = (i: number) => MANIFEST.missions[i]!

async function create(id: string, title: string) {
  const r = await call("studio_mission_create", { mission: { id, title, type: "feature-release", owner: "master-controller", project: { dir: R }, rows: [row("1")] } })
  expect(r.ok).toBe(true)
}
const placement = (id: string, opts: S[]) => call("studio_mission_request_decision", { mission: id, request: { id: "D-1", topic: "project-placement", question: "Where should this mission live?", context: "confidence high: title shares the group name", options: opts, recommended: opts[0]!.id } })
const join = (group = "Lumen") => ({ id: "join", label: `Join ${group}`, consequence: "Moves the mission into the group", group, groupKind: "product" })
const fresh = (group: string, groupKind = "institution") => ({ id: "new", label: `New group ${group}`, consequence: "Creates the folder and moves the mission", group, groupKind })
const root = { id: "root", label: "Keep at the root", consequence: "Nothing moves" }
const answer = (id: string, option: string, request = "D-1", decisionId = "U1") => call("studio_mission_answer_decision", { mission: id, request, option, by: "user", decisionId })
const place = (args: S) => call("studio_mission_place", args)
function mark(group: string, kind: string) {
  mkdirSync(path.join(R, group, ".swarm"), { recursive: true })
  writeFileSync(path.join(R, group, ".swarm", "group.json"), JSON.stringify({ version: 1, name: group, kind, created: 1_787_184_000_000 }))
}

describe("N8-363 PROJ-b: studio_mission_place and setProjectDir", () => {
  test("the tool is listed; PLACE_DECISION_UNANSWERED is a store code with its next step", async () => {
    const { MISSION_TOOL_NAMES, MISSION_TOOL_SCHEMAS } = await import("../../src/mcp-host/mission/schemas.ts")
    const { STORE_ERROR_CODES } = (await import("../../src/store/errors.ts")) as S
    const { nextCall } = await import("../../src/mcp-host/mission/next-call.ts")
    expect(MISSION_TOOL_NAMES).toContain("studio_mission_place")
    expect((MISSION_TOOL_SCHEMAS.studio_mission_place as S).required).toEqual(["mission", "projectDir", "decision"])
    expect(Object.keys((MISSION_TOOL_SCHEMAS.studio_mission_place as S).properties)).toEqual(["mission", "projectDir", "decision", "tidyMission"])
    expect(STORE_ERROR_CODES).toContain("PLACE_DECISION_UNANSWERED")
    expect(nextCall("PLACE_DECISION_UNANSWERED")).toContain('studio_mission_request_decision {topic: "project-placement"')
    expect(tools.map((t) => t.name)).toContain("studio_mission_place")
  })

  test("no request, an open request, or a root answer -> PLACE_DECISION_UNANSWERED; nothing changes", async () => {
    const m = mission(0)
    await create(m.id, m.title)
    const lumen = path.join(R, "Lumen")
    const none = await place({ mission: m.id, projectDir: lumen, decision: "D-1" })
    expect(none.ok).toBe(false)
    expect(none.code).toBe("PLACE_DECISION_UNANSWERED")
    expect(none.text).toContain("only the answer moves a mission")
    expect((await placement(m.id, [join(), fresh("Kemenkeu"), root])).ok).toBe(true)
    const open = await place({ mission: m.id, projectDir: lumen, decision: "D-1" })
    expect(open.code).toBe("PLACE_DECISION_UNANSWERED")
    expect(dirOf(m.id)).toBe(R)
    const m2 = mission(1)
    await create(m2.id, m2.title)
    expect((await placement(m2.id, [join(), fresh("Kemenkeu"), root])).ok).toBe(true)
    expect((await answer(m2.id, "root")).ok).toBe(true)
    expect((await place({ mission: m2.id, projectDir: lumen, decision: "D-1" })).code).toBe("PLACE_DECISION_UNANSWERED")
    expect(dirOf(m2.id)).toBe(R)
  })

  test("join answered + marked group -> project_dir updated, listed under the group and still under the root; repeat is unchanged", async () => {
    const m = mission(0)
    expect((await answer(m.id, "join")).ok).toBe(true)
    const lumen = path.join(R, "Lumen")
    const r = await place({ mission: m.id, projectDir: lumen, decision: "D-1" })
    expect(r.ok).toBe(true)
    expect(r.from).toBe(R)
    expect(r.to).toBe(lumen)
    expect(dirOf(m.id)).toBe(lumen)
    const inGroup = await call("studio_mission_list", { projectDir: lumen })
    expect(inGroup.items.map((x: S) => x.id)).toEqual([m.id])
    const atRoot = await call("studio_mission_list", { projectDir: R })
    expect(atRoot.items.map((x: S) => x.id)).toContain(m.id)
    const again = await place({ mission: m.id, projectDir: lumen, decision: "D-1" })
    expect(again.ok).toBe(true)
    expect(again.unchanged).toBe(true)
    const events = store.missions.listEvents(m.id).filter((e: S) => e.detail?.action === "place")
    expect(events.length).toBe(1)
  })

  test("a two-segment projectDir, another group than the answer, or a missing marker -> refused", async () => {
    const m = mission(2)
    await create(m.id, m.title)
    expect((await placement(m.id, [fresh("Kemenkeu"), root])).ok).toBe(true)
    expect((await answer(m.id, "new")).ok).toBe(true)
    const kemenkeu = path.join(R, "Kemenkeu")
    mkdirSync(path.join(kemenkeu, "Sub"), { recursive: true })
    for (const projectDir of [path.join(kemenkeu, "Sub"), path.join(R, "Lumen"), kemenkeu, `${kemenkeu}/`, `${R}/x/../Kemenkeu`, "Kemenkeu"]) {
      const r = await place({ mission: m.id, projectDir, decision: "D-1" })
      expect(r.ok, projectDir).toBe(false)
      expect(r.code, projectDir).toBe("PLACE_DECISION_UNANSWERED")
    }
    expect(dirOf(m.id)).toBe(R)
    mark("Kemenkeu", "institution")
    const ok = await place({ mission: m.id, projectDir: kemenkeu, decision: "D-1" })
    expect(ok.ok).toBe(true)
    expect(dirOf(m.id)).toBe(kemenkeu)
  })

  test("tidy: an approved proposal places its listed missions via tidyMission; a null item or a mission not listed is refused", async () => {
    const tidy = "2026-11-14_project-tidy"
    await create(tidy, "Tidy the Default Project")
    const [a, b, c] = [mission(3), mission(4), mission(5)]
    for (const m of [a, b, c]) await create(m.id, m.title)
    const proposal = [
      { mission: a.id, group: "Lumen", groupKind: "product" },
      { mission: b.id, group: null },
    ]
    const req = await call("studio_mission_request_decision", { mission: tidy, request: { id: "D-1", topic: "project-tidy", question: "Move these missions into groups?", options: [{ id: "approve", label: "Approve", consequence: "Moves 1 mission" }, { id: "decline", label: "Not now", consequence: "Nothing moves" }], proposal } })
    expect(req.ok).toBe(true)
    const early = await place({ mission: a.id, projectDir: path.join(R, "Lumen"), decision: "D-1", tidyMission: tidy })
    expect(early.code).toBe("PLACE_DECISION_UNANSWERED")
    expect((await answer(tidy, "approve")).ok).toBe(true)
    const okA = await place({ mission: a.id, projectDir: path.join(R, "Lumen"), decision: "D-1", tidyMission: tidy })
    expect(okA.ok).toBe(true)
    expect(dirOf(a.id)).toBe(path.join(R, "Lumen"))
    for (const m of [b, c]) {
      const r = await place({ mission: m.id, projectDir: path.join(R, "Lumen"), decision: "D-1", tidyMission: tidy })
      expect(r.code, m.id).toBe("PLACE_DECISION_UNANSWERED")
      expect(dirOf(m.id)).toBe(R)
    }
    // A tidy request is not a placement answer of the mission itself.
    expect((await place({ mission: tidy, projectDir: path.join(R, "Lumen"), decision: "D-1" })).code).toBe("PLACE_DECISION_UNANSWERED")
  })

  test("decision schema: topic, group option and proposal round-trip; the stored meta is not shown as an option field", async () => {
    const got = await call("studio_mission_get", { mission: "2026-11-14_project-tidy", include: ["requests"] })
    const r = got.requests[0] as S
    expect(r.topic).toBe("project-tidy")
    expect(r.proposal).toEqual([
      { mission: mission(3).id, group: "Lumen", groupKind: "product" },
      { mission: mission(4).id, group: null },
    ])
    expect(r.options.map((o: S) => Object.keys(o).sort())).toEqual([
      ["consequence", "id", "label"],
      ["consequence", "id", "label"],
    ])
    const p = (await call("studio_mission_get", { mission: mission(0).id, include: ["requests"] })).requests[0] as S
    expect(p.topic).toBe("project-placement")
    expect(p.options[0]).toEqual(join())
    expect(p.proposal).toBeUndefined()
  })

  test("decision schema refusals: option order, group names (SR8-17), join/new against the disk, proposal maxItems 200", async () => {
    const m = mission(6)
    await create(m.id, m.title)
    const bad: Array<[string, S]> = [
      ["order", { topic: "project-placement", options: [root, fresh("Kemenkeu2")] }],
      ["group on root", { topic: "project-placement", options: [fresh("Kemenkeu2"), { ...root, group: "X", groupKind: "theme" }] }],
      ["group without topic", { options: [fresh("Kemenkeu2"), root] }],
      ["kind", { topic: "project-placement", options: [fresh("Kemenkeu2", "team"), root] }],
      ["docs", { topic: "project-placement", options: [fresh("Docs"), root] }],
      ["bidi", { topic: "project-placement", options: [fresh("Lu‮men"), root] }],
      ["zero width", { topic: "project-placement", options: [fresh("Lu​men"), root] }],
      ["trailing dot", { topic: "project-placement", options: [fresh("Lumen."), root] }],
      ["edge space", { topic: "project-placement", options: [fresh(" Lumen"), root] }],
      ["slash", { topic: "project-placement", options: [fresh("a/b"), root] }],
      ["dot", { topic: "project-placement", options: [fresh(".hidden"), root] }],
      ["long", { topic: "project-placement", options: [fresh("x".repeat(61)), root] }],
      ["join unmarked", { topic: "project-placement", options: [join("Arsip Lama"), fresh("Kemenkeu2"), root] }],
      ["new exists", { topic: "project-placement", options: [fresh("Arsip Lama"), root] }],
      ["new exists marked", { topic: "project-placement", options: [fresh("Lumen"), root] }],
      ["topic", { topic: "project-sort", options: [fresh("Kemenkeu2"), root] }],
      ["proposal without tidy", { options: [{ ...root, id: "a" }, root], proposal: [{ mission: m.id, group: null }] }],
      ["tidy options", { topic: "project-tidy", options: [{ ...root, id: "yes" }, root], proposal: [{ mission: m.id, group: null }] }],
      ["tidy empty", { topic: "project-tidy", options: [{ ...root, id: "approve" }, { ...root, id: "decline" }], proposal: [] }],
    ]
    let n = 1
    for (const [why, extra] of bad) {
      const r = await call("studio_mission_request_decision", { mission: m.id, request: { id: `D-${n++}`, question: "Where?", ...extra } })
      expect(r.ok, why).toBe(false)
      expect(r.code, why).toBe("SCHEMA_INVALID")
    }
    const tidyOptions = [
      { id: "approve", label: "Approve", consequence: "Moves the listed missions" },
      { id: "decline", label: "Not now", consequence: "Nothing moves" },
    ]
    const items = (k: number) => Array.from({ length: k }, (_, i) => ({ mission: `2026-11-14_m${i}`, group: "Lumen", groupKind: "product" }))
    const over = await call("studio_mission_request_decision", { mission: m.id, request: { id: "D-90", topic: "project-tidy", question: "Tidy?", options: tidyOptions, proposal: items(201) } })
    expect(over.code).toBe("SCHEMA_INVALID")
    expect(JSON.stringify(over)).toContain("maxItems 200")
    const full = await call("studio_mission_request_decision", { mission: m.id, request: { id: "D-91", topic: "project-tidy", question: "Tidy?", options: tidyOptions, proposal: items(200) } })
    expect(full.ok).toBe(true)
    const two = await call("studio_mission_request_decision", { mission: m.id, request: { id: "D-92", topic: "project-placement", question: "Where?", options: [fresh("Pasang Surut", "theme"), root] } })
    expect(two.ok).toBe(true)
  })

  test("OP20-7: no trigger guards mission.project_dir (only the absolute CHECK of 0003)", async () => {
    const triggers = await store.transaction(async (tx) => tx.all<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'mission'"))
    expect(triggers.map((t) => t.name)).toEqual(["mission_type_change"])
    expect(triggers[0]!.sql).toContain("UPDATE OF type_id, type_version")
  })

  test("PERSON_ONLY_MCP_TOOLS (N8-456): opencode never lists studio_mission_place to an agent", async () => {
    const catalog = (await import(path.join(OC_MCP, "catalog.ts"))) as S
    const effect = (await import(Bun.resolveSync("effect", OC_MCP))) as S
    expect(catalog.PERSON_ONLY_MCP_TOOLS).toEqual(["studio_mission_place"])
    const client = { listTools: async () => ({ tools: ["studio_mission_get", "studio_mission_place", "studio_mission_answer_decision"].map((name) => ({ name, inputSchema: { type: "object" } })) }) }
    const listed = (await effect.Effect.runPromise(catalog.defs(client))) as Array<{ name: string }>
    expect(listed.map((t) => t.name)).toEqual(["studio_mission_get", "studio_mission_answer_decision"])
  })

  // Row 45b (C49, N8-C08): the host copies of the group-name rule must not drift from opencode's (OC/project/rehome.ts).
  test("N8-C08 drift: GROUP_NAME_PATTERN, RESERVED_GROUP_NAMES and groupNameOk equal opencode's rule", async () => {
    const host = (await import("../../src/store/mission/validate.ts")) as S
    const oc = (await import(path.resolve(PKG, "..", "opencode", "src", "project", "rehome.ts"))) as S
    expect(host.GROUP_NAME_PATTERN.source).toBe(oc.GROUP_NAME_PATTERN.source)
    expect(host.GROUP_NAME_PATTERN.flags).toBe(oc.GROUP_NAME_PATTERN.flags)
    expect([...host.RESERVED_GROUP_NAMES]).toEqual([...oc.RESERVED_GROUP_NAMES])
    const names = ["Lumen", "Kemenkeu", "Pasang Surut", "Arsip Lama", "docs", "Docs", "DOCS", ".hidden", "a/b", "a\\b", "x".repeat(60), "x".repeat(61), "Lumen.", " Lumen", "Lumen ", "Lu\u202emen", "Lu\u200bmen", "Lu\u2028men", "Lu\u2029men", "Lu\u0007men", "Cafe\u0301", "Caf\u00e9", "", "-", "a.b", "..", "Ünïcödé"]
    for (const n of names) expect(host.groupNameOk(n), JSON.stringify(n)).toBe(oc.groupNameOk(n))
    // Same checks in the same order (the host adds only the non-string guard).
    const body = (src: string) => {
      const start = src.indexOf("function groupNameOk(")
      const lines = src.slice(start, src.indexOf("\n}\n", start)).split("\n").slice(1).map((l) => l.trim())
      return lines.map((l) => l.replace(/^if \(typeof name !== "string" \|\| /, "if (")).join("\n")
    }
    const hostSrc = await Bun.file(path.join(PKG, "src", "store", "mission", "validate.ts")).text()
    const ocSrc = await Bun.file(path.resolve(PKG, "..", "opencode", "src", "project", "rehome.ts")).text()
    expect(body(hostSrc)).toBe(body(ocSrc))
  })

  // AC-SEC05 / SR8-05 (row 45b): the attested Mission Control session check (N8-460).
  test("row 45b: studio_mission_place from a session that is not attested -> SESSION_NOT_ATTESTED (N8-460); nothing moves", async () => {
    const m = mission(7)
    await create(m.id, m.title)
    const before = dirOf(m.id)
    const place = tools.find((t) => t.name === "studio_mission_place")!
    for (const s of [{ sessionId: "mcp-agent", agentId: "swarm", fileRoot: R }, { sessionId: "mcp-claude", agentId: "claude", fileRoot: R }]) {
      const r = await place.call({ mission: m.id, projectDir: path.join(R, "Lumen"), decision: "D-1" }, s)
      const sc = r.structuredContent as S
      expect(sc.ok).toBe(false)
      expect(sc.code).toBe("SESSION_NOT_ATTESTED")
      expect(sc.next).toContain("agents never move a mission")
    }
    expect(dirOf(m.id)).toBe(before)
  })
})
