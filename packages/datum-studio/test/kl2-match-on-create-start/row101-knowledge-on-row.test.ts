// 1.3.3 row 101 (spec KL-2 item 1): the store side of matching at row start, without the MCP tools.
// - mergeRowKnowledge: a new match keeps the consulted marks of domains that remain; nothing matched = undefined.
// - setKnowledgeMatcher: when a row goes `running` the row title is matched again; `knowledge` is replaced only when
//   the domains (or first files) differ; an unavailable library (reason) leaves the stored field alone.
// - rowKnowledgeMatcher (host helper): the staged index in packages/desktop/datum/knowledge-library/scripts.
// No server, no port: a temp store.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SqliteStudioStore } from "../../src/store/index.ts"
import { mergeRowKnowledge } from "../../src/store/mission/mission-store.ts"
import { rowKnowledgeMatcher } from "../../src/mcp-host/mission/knowledge-on-row.ts"
import { libraryRootOf } from "../../src/mcp-host/mission/knowledge-match.ts"

const SCRIPTS = path.resolve(import.meta.dir, "../../../desktop/datum/knowledge-library/scripts")
const BASE = path.join(tmpdir(), "row101-kl2-store")
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

const row = (id: string, title: string) => ({ id, phase: "implementation", kind: "implementation", title, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass" })
const U1 = { id: "U1", by: "user", date: "2026-11-17", text: "User approves the blueprint" }
async function approved(id: string, rows: ReturnType<typeof row>[]) {
  await store.transaction(async (t) => M.create(t, { id, title: `Mission ${id}`, type: "feature-release", owner: "master-controller", project: { dir: "/private/tmp/claude-501/row101" }, rows, decisions: [U1] } as never, { attested: true }))
  await store.transaction(async (t) => M.approve(t, id, "U1"))
}
const knowledgeOf = (mission: string, id: string) => M.rowContract(mission, id).knowledge

describe("row 101: mergeRowKnowledge", () => {
  test("nothing matched gives undefined (store nothing)", () => {
    expect(mergeRowKnowledge(undefined, [])).toBeUndefined()
  })
  test("consulted marks survive for domains that remain; new domains start empty; a lost domain goes", () => {
    const cur = { domains: [{ domain: "FIBER-OPTIC", firstFile: "a.md", consulted: ["a.md"] }, { domain: "STORAGE", firstFile: "s.md", consulted: ["s.md"] }], reason: "kept" }
    const next = mergeRowKnowledge(cur, [{ domain: "FIBER-OPTIC", firstFile: "a.md" }, { domain: "NETWORKING", firstFile: "n.md" }])
    expect(next).toEqual({ domains: [{ domain: "FIBER-OPTIC", firstFile: "a.md", consulted: ["a.md"] }, { domain: "NETWORKING", firstFile: "n.md", consulted: [] }], reason: "kept" })
  })
  test("at most 25 domains", () => {
    const hits = Array.from({ length: 30 }, (_, i) => ({ domain: `D${i}`, firstFile: `f${i}.md` }))
    expect(mergeRowKnowledge(undefined, hits)!.domains.length).toBe(25)
  })
})

describe("row 101: host matcher helper", () => {
  test("the staged index matches a technical title and not a non-technical one", () => {
    const match = rowKnowledgeMatcher({ libraryRoot: SCRIPTS })
    const tech = match("hitung redaman serat optik ruas 12 km dengan OTDR")
    expect(tech.reason).toBeUndefined()
    expect(tech.domains.map((d) => [d.domain, d.firstFile])).toEqual([["FIBER-OPTIC", "04_KNOWLEDGE-CARDS/FIBER-OPTIC/REF-FO-001.md"]])
    expect(match("rapat koordinasi mingguan tim pemasaran")).toEqual({ domains: [] })
  })
  test("no library root: a reason, no domains, no throw", () => {
    expect(rowKnowledgeMatcher({ libraryRoot: null })("buat diagram topologi")).toEqual({ domains: [], reason: "index path not known" })
    expect(rowKnowledgeMatcher({ libraryRoot: path.join(RUN, "absent") })("buat diagram topologi").reason).toBe("index path not known")
  })
  // row 151 (S8): one libraryRootOf (real path, folder check) in knowledge-match.ts; no environment fallback any more
  test("libraryRootOf: the real folder, else null", () => {
    expect(libraryRootOf(SCRIPTS)).toBe(realpathSync(SCRIPTS))
    expect(libraryRootOf("/absent-row101")).toBeNull()
    expect(libraryRootOf(null)).toBeNull()
  })
})

describe("row 101: store matches again at row start", () => {
  test("start stores the matched domains; non-technical title stores nothing", async () => {
    M.setKnowledgeMatcher(rowKnowledgeMatcher({ libraryRoot: SCRIPTS }))
    const MI = "2026-11-17_row101-start"
    await approved(MI, [row("1", "buat diagram topologi jaringan"), row("2", "rapat koordinasi mingguan")])
    await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "1", status: "running" }, { id: "2", status: "running" }]))
    expect(knowledgeOf(MI, "1")).toEqual({
      domains: [
        { domain: "DIAGRAM-STANDARD", firstFile: "skill:gsp-diagram-standard/references/index.md", consulted: [] },
        { domain: "NETWORKING", firstFile: "04_KNOWLEDGE-CARDS/NETWORKING/REF-NET-001.md", consulted: [] },
      ],
    })
    expect(knowledgeOf(MI, "2")).toBeUndefined()
  })

  test("a changed title is matched again at start; consulted marks of a remaining domain survive", async () => {
    M.setKnowledgeMatcher(rowKnowledgeMatcher({ libraryRoot: SCRIPTS }))
    const MI = "2026-11-17_row101-rematch"
    await approved(MI, [row("1", "hitung redaman serat optik dengan OTDR")])
    await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "1", status: "running" }]))
    await store.transaction(async (t) => M.markKnowledgeConsulted(t, MI, "1", { path: "04_KNOWLEDGE-CARDS/FIBER-OPTIC/REF-FO-001.md" }))
    await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "1", status: "blocked", note: "waiting for the survey" }]))
    await store.transaction(async (t) => M.recordDecision(t, MI, { id: "C1", by: "controller", date: "2026-11-17", text: "Row 1 also covers the switch configuration" } as never))
    await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "1", set: { title: "hitung redaman serat optik dan konfigurasi VLAN switch" }, status: "running", decision: "C1" }]))
    const k = knowledgeOf(MI, "1")!
    expect(k.domains.map((d) => d.domain).sort()).toEqual(["FIBER-OPTIC", "NETWORKING"])
    expect(k.domains.find((d) => d.domain === "FIBER-OPTIC")!.consulted).toEqual(["04_KNOWLEDGE-CARDS/FIBER-OPTIC/REF-FO-001.md"])
  })

  test("same match at start writes nothing (no row-change event)", async () => {
    M.setKnowledgeMatcher(rowKnowledgeMatcher({ libraryRoot: SCRIPTS }))
    const MI = "2026-11-17_row101-same"
    await approved(MI, [row("1", "hitung redaman serat optik dengan OTDR")])
    await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "1", status: "running" }]))
    await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "1", status: "blocked", note: "wait" }]))
    const before = M.listEvents(MI).filter((e: { verb: string }) => e.verb === "row-change").length
    await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "1", status: "running" }]))
    expect(M.listEvents(MI).filter((e: { verb: string }) => e.verb === "row-change").length).toBe(before)
  })

  test("library unavailable at start: the start goes through and the stored field is kept", async () => {
    M.setKnowledgeMatcher(rowKnowledgeMatcher({ libraryRoot: SCRIPTS }))
    const MI = "2026-11-17_row101-unavailable"
    await approved(MI, [row("1", "hitung redaman serat optik dengan OTDR")])
    await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "1", status: "running" }]))
    await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "1", status: "blocked", note: "wait" }]))
    M.setKnowledgeMatcher(rowKnowledgeMatcher({ libraryRoot: null }))
    const r = await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "1", status: "running" }]))
    expect(r.changed).toEqual(["1"])
    expect(knowledgeOf(MI, "1")!.domains.map((d) => d.domain)).toEqual(["FIBER-OPTIC"])
  })

  test("a matcher that throws never breaks the start", async () => {
    M.setKnowledgeMatcher(() => {
      throw new Error("boom")
    })
    const MI = "2026-11-17_row101-throws"
    await approved(MI, [row("1", "hitung redaman serat optik dengan OTDR")])
    const r = await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "1", status: "running" }]))
    expect(r.results).toEqual([{ id: "1", ok: true }])
    expect(knowledgeOf(MI, "1")).toBeUndefined()
  })
})
