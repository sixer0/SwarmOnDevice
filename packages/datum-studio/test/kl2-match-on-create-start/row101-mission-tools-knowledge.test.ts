// 1.3.3 row 101 (spec KL-2 item 1; row 66 request on the update_row text): the mission tools match row titles against
// the GSP technical knowledge library's trigger index at studio_mission_create and when a row goes running, store
// `knowledge` on the row and list it in the reply. Rule (row 101 decision): only the row's own title is stored on the
// row; the mission title is matched at create and listed in the reply as information, never copied onto rows.
// No server, no port: a temp store, the tools called through missionTools().
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SqliteStudioStore } from "../../src/store/index.ts"
import { missionTools } from "../../src/mcp-host/mission/mission-tools.ts"

const SCRIPTS = path.resolve(import.meta.dir, "../../../desktop/datum/knowledge-library/scripts")
const BASE = path.join(tmpdir(), "row101-kl2-tools")
mkdirSync(BASE, { recursive: true })
const RUN = mkdtempSync(path.join(BASE, "bun-"))
let tick = 1_800_000_000_000
const store = new SqliteStudioStore()
await store.open(path.join(RUN, "store"), { release: "1.3.3", log: () => {}, agentClock: () => ++tick })
afterAll(async () => {
  store.missions.setKnowledgeMatcher(undefined)
  await store.close()
})
const M = store.missions

type S = Record<string, any>
const logged: Array<{ level: string; source: string; message: string; context?: Record<string, unknown> }> = []
const log = (level: string, source: string, message: string, context?: Record<string, unknown>) => void logged.push({ level, source, message, context })
const session = { sessionId: "mcp-101", agentId: "swarm", fileRoot: "/private/tmp/claude-501/row101", attested: true as const }
const row = (id: string, title: string) => ({ id, phase: "implementation", kind: "implementation", title, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass" })
const U1 = { id: "U1", by: "user", date: "2026-11-17", text: "User approves the blueprint" }
const textOf = (res: { content: unknown }) => (res.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n")
function tools(libraryRoot: string | null) {
  const list = missionTools(store, { log: log as never, libraryRoot })
  return (name: string) => list.find((t) => t.name === name)!
}
async function create(libraryRoot: string | null, id: string, title: string, rows: ReturnType<typeof row>[], dryRun = false) {
  return tools(libraryRoot)("studio_mission_create").call({ mission: { id, title, type: "feature-release", project: { dir: session.fileRoot }, rows, decisions: [U1] }, ...(dryRun ? { dryRun: true } : {}) }, session)
}

describe("row 101: studio_mission_create matches row titles", () => {
  test("a technical title stores the domain and first file; the reply lists them", async () => {
    const MI = "2026-11-17_row101-create"
    const res = await create(SCRIPTS, MI, "Kajian pusat kendali", [row("1", "hitung redaman serat optik ruas 12 km dengan OTDR"), row("2", "buat diagram topologi")])
    const text = textOf(res)
    console.log(`[row101] create reply:\n${text}`)
    expect(res.isError).toBeFalsy()
    expect(M.rowContract(MI, "1").knowledge).toEqual({ domains: [{ domain: "FIBER-OPTIC", firstFile: "04_KNOWLEDGE-CARDS/FIBER-OPTIC/REF-FO-001.md", consulted: [] }] })
    expect(M.rowContract(MI, "2").knowledge).toEqual({ domains: [{ domain: "DIAGRAM-STANDARD", firstFile: "skill:gsp-diagram-standard/references/index.md", consulted: [] }] })
    // row 151 (S2): each line carries the exact recorded call, the path verbatim (a skill: path included)
    expect(text).toContain(`row 1: FIBER-OPTIC -> call the tool datum-studio_studio_library_read with path "04_KNOWLEDGE-CARDS/FIBER-OPTIC/REF-FO-001.md", mission "${MI}", row "1"`)
    expect(text).toContain(`row 2: DIAGRAM-STANDARD -> call the tool datum-studio_studio_library_read with path "skill:gsp-diagram-standard/references/index.md", mission "${MI}", row "2"`)
    expect(text).not.toMatch(/[a-z_]+ \{"/)
    expect(text).not.toMatch(/\bKL\b/)
    const data = res.structuredContent as S
    expect(data.knowledge.rows).toEqual([
      { row: "1", domains: [{ domain: "FIBER-OPTIC", firstFile: "04_KNOWLEDGE-CARDS/FIBER-OPTIC/REF-FO-001.md", words: ["optik", "otdr", "redaman", "serat"] }] },
      { row: "2", domains: [{ domain: "DIAGRAM-STANDARD", firstFile: "skill:gsp-diagram-standard/references/index.md", words: ["diagram", "topologi"] }] },
    ])
  })

  test("a non-technical title stores nothing and the reply carries no knowledge line", async () => {
    const MI = "2026-11-17_row101-plain"
    const res = await create(SCRIPTS, MI, "Rapat koordinasi mingguan", [row("1", "notulen rapat dan surat undangan")])
    expect(res.isError).toBeFalsy()
    expect(M.rowContract(MI, "1").knowledge).toBeUndefined()
    expect(textOf(res)).not.toContain("knowledge")
    expect((res.structuredContent as S).knowledge).toEqual({ rows: [], mission: [] })
  })

  test("mission title is listed, not copied onto rows whose own title matches nothing", async () => {
    const MI = "2026-11-17_row101-mission-title"
    const res = await create(SCRIPTS, MI, "Kajian kebutuhan bandwidth CCTV dan retensi rekaman", [row("1", "susun ringkasan untuk pimpinan")])
    expect(M.rowContract(MI, "1").knowledge).toBeUndefined()
    const text = textOf(res)
    expect(text).toContain("mission title (not stored on rows): VIDEO-SURVEILLANCE -> call the tool datum-studio_studio_library_read with path \"")
    expect((res.structuredContent as S).knowledge.mission[0].domain).toBe("VIDEO-SURVEILLANCE")
  })

  test("missing index: create goes through, the reply says the library is unavailable, the reason is logged", async () => {
    const MI = "2026-11-17_row101-nolib"
    logged.length = 0
    const res = await create(null, MI, "Kajian", [row("1", "hitung redaman serat optik dengan OTDR")])
    expect(res.isError).toBeFalsy()
    expect(M.get(MI)!.mission.status).toBe("draft")
    expect(M.rowContract(MI, "1").knowledge).toBeUndefined()
    expect(textOf(res)).toContain("GSP technical knowledge library is unavailable (index path not known)")
    expect((res.structuredContent as S).knowledge.unavailable).toBe("index path not known")
    expect(logged.some((l) => l.level === "warn" && l.message.includes("library unavailable") && l.context?.reason === "index path not known")).toBe(true)
  })

  test("dryRun: the reply lists the match, nothing is stored", async () => {
    const MI = "2026-11-17_row101-dry"
    const res = await create(SCRIPTS, MI, "Kajian", [row("1", "hitung redaman serat optik dengan OTDR")], true)
    expect(textOf(res)).toContain("row 1: FIBER-OPTIC")
    expect(M.get(MI)).toBeNull()
  })
})

describe("row 101: studio_mission_update_row matches again at start", () => {
  async function approved(MI: string, rows: ReturnType<typeof row>[]) {
    await create(SCRIPTS, MI, "Kajian", rows)
    await store.transaction(async (t) => M.approve(t, MI, "U1"))
  }

  test("start re-matches a changed title, keeps consulted marks, and the reply lists the row's knowledge", async () => {
    const MI = "2026-11-17_row101-start"
    await approved(MI, [row("1", "hitung redaman serat optik dengan OTDR")])
    const upd = tools(SCRIPTS)("studio_mission_update_row")
    await upd.call({ mission: MI, rows: [{ id: "1", status: "running" }] }, session)
    await store.transaction(async (t) => M.markKnowledgeConsulted(t, MI, "1", { path: "04_KNOWLEDGE-CARDS/FIBER-OPTIC/REF-FO-001.md" }))
    await upd.call({ mission: MI, rows: [{ id: "1", status: "blocked", note: "waiting for the survey" }] }, session)
    await store.transaction(async (t) => M.recordDecision(t, MI, { id: "C1", by: "controller", date: "2026-11-17", text: "Row 1 also covers the switch configuration" } as never))
    const res = await upd.call({ mission: MI, rows: [{ id: "1", set: { title: "hitung redaman serat optik dan konfigurasi VLAN switch" }, status: "running", decision: "C1" }] }, session)
    const text = textOf(res)
    console.log(`[row101] start reply:\n${text}`)
    expect(res.isError).toBeFalsy()
    const k = M.rowContract(MI, "1").knowledge!
    expect(k.domains.map((d) => d.domain).sort()).toEqual(["FIBER-OPTIC", "NETWORKING"])
    expect(k.domains.find((d) => d.domain === "FIBER-OPTIC")!.consulted).toEqual(["04_KNOWLEDGE-CARDS/FIBER-OPTIC/REF-FO-001.md"])
    expect(text).toContain("row 1: ")
    expect(text).toContain(`NETWORKING -> call the tool datum-studio_studio_library_read with path "04_KNOWLEDGE-CARDS/NETWORKING/REF-NET-001.md", mission "${MI}", row "1"`)
    expect((res.structuredContent as S).knowledge.rows[0].row).toBe("1")
  })

  test("a non-technical row start adds no knowledge line", async () => {
    const MI = "2026-11-17_row101-start-plain"
    await approved(MI, [row("1", "notulen rapat dan surat undangan")])
    const res = await tools(SCRIPTS)("studio_mission_update_row").call({ mission: MI, rows: [{ id: "1", status: "running" }] }, session)
    expect(res.isError).toBeFalsy()
    expect(textOf(res)).not.toContain("knowledge")
    expect(M.rowContract(MI, "1").knowledge).toBeUndefined()
  })

  test("missing index at start: the start goes through and the reply says the library is unavailable", async () => {
    const MI = "2026-11-17_row101-start-nolib"
    await approved(MI, [row("1", "hitung redaman serat optik dengan OTDR")])
    const res = await tools(null)("studio_mission_update_row").call({ mission: MI, rows: [{ id: "1", status: "running" }] }, session)
    expect(res.isError).toBeFalsy()
    expect(M.get(MI)!.mission.rows!.find((r) => r.id === "1")!.status).toBe("running")
    expect(textOf(res)).toContain("GSP technical knowledge library is unavailable")
    // The create-time match stays (the store keeps the field when the library cannot be read).
    expect(M.rowContract(MI, "1").knowledge!.domains[0].domain).toBe("FIBER-OPTIC")
  })

  test("a patch without a status move adds no knowledge line", async () => {
    const MI = "2026-11-17_row101-note-only"
    await approved(MI, [row("1", "hitung redaman serat optik dengan OTDR")])
    const res = await tools(null)("studio_mission_update_row").call({ mission: MI, rows: [{ id: "1", note: "plan" }] }, session)
    expect(textOf(res)).not.toContain("knowledge")
    expect((res.structuredContent as S).knowledge).toBeUndefined()
  })
})
