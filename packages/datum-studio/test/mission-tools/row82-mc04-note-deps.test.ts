// Row 82 (1.2.6, MC-04, decision U5; red-probe first per 01g §3.4): a note never gets DEP_NOT_DONE from an unrelated
// row. DEP_NOT_DONE gates only a move to running (update_row status, or a non-draft report that starts the row).
// Probes: (1) note-only patch on a row with an open B dependency; (2) batch [note on row a, status running on the
// dep-blocked row b] applies the note and refuses only b with DEP_NOT_DONE in `results` (shares N-061 with MC-07);
// (3) a draft report on a dep-blocked row neither starts it nor is refused with DEP_NOT_DONE.
// No server, no port: the store is opened on a temp folder; tools are called through missionTools().
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { canonicalJson, sha256Hex, SqliteStudioStore, type BuiltinTemplateFile } from "../../src/store/index.ts"
import { missionTools } from "../../src/mcp-host/mission/mission-tools.ts"
import { missionIssues } from "../../src/mcp-host/mission/report-tools.ts"

const BASE = process.env.ROW82_TEST_DIR ?? path.join(tmpdir(), "row82-mc04-test")
mkdirSync(BASE, { recursive: true })
const RUN = mkdtempSync(path.join(BASE, "bun-"))
let tick = 1_800_000_000_000
const clock = () => ++tick

const store = new SqliteStudioStore()
await store.open(path.join(RUN, "store"), { release: "1.2.6", log: () => {}, agentClock: clock })
afterAll(async () => {
  await store.close()
})
const M = store.missions

type S = Record<string, any>
const row = (id: string, deps: string[] = []) => ({ id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps, size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass" })
const U1 = { id: "U1", by: "user", date: "2026-11-12", text: "User approves the blueprint" }

// Row 1 has no deps; row 2 depends on row 1 by build (B), so row 2 is dep-blocked while row 1 is not done.
async function approvedMission(id: string) {
  await store.transaction(async (t) => M.create(t, { id, title: `Mission ${id}`, type: "feature-release", owner: "master-controller", project: { dir: "/private/tmp/claude-501/row82" }, rows: [row("1"), row("2", ["1:B"])], decisions: [U1] } as never))
  await store.transaction(async (t) => M.approve(t, id, "U1"))
}
const rowOf = (mission: string, id: string) => M.get(mission)!.mission.rows!.find((r: S) => r.id === id) as S
const session = { sessionId: "mcp-82", agentId: "swarm", fileRoot: "/private/tmp/claude-501/row82" }
const updateRow = () => missionTools(store, { log: () => {} }).find((t) => t.name === "studio_mission_update_row")!

describe("row 82 MC-04: note writes are never dependency-gated", () => {
  test("probe 1 (store): a note-only patch on a dep-blocked row applies", async () => {
    const MI = "2026-11-12_mc04-p1-store"
    await approvedMission(MI)
    const r = (await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "2", note: "waiting on row 1" }]))) as S
    expect(r.changed).toEqual(["2"])
    expect(rowOf(MI, "2").note).toBe("waiting on row 1")
    expect(rowOf(MI, "2").status).toBe("pending")
  })

  test("probe 1 (tool): CHAR-MC04-note-only, studio_mission_update_row note on a dep-blocked row is ok", async () => {
    const MI = "2026-11-12_mc04-p1-tool"
    await approvedMission(MI)
    const res = await updateRow().call({ mission: MI, rows: [{ id: "2", note: "handoff note" }] }, session)
    const out = res.structuredContent as S
    expect(res.isError).not.toBe(true)
    expect(out.ok).toBe(true)
    expect(JSON.stringify(out)).not.toContain("DEP_NOT_DONE")
    expect(rowOf(MI, "2").note).toBe("handoff note")
  })

  test("probe 2 (store): [note on row 1, running on dep-blocked row 2] applies the note, refuses only row 2", async () => {
    const MI = "2026-11-12_mc04-p2-store"
    await approvedMission(MI)
    const r = (await store.transaction(async (t) => M.updateRows(t, MI, [{ id: "1", note: "row 1 note" }, { id: "2", status: "running" }]))) as S
    console.log(`[row82] store results: ${JSON.stringify(r.results)}`)
    expect(r.results).toEqual([
      { id: "1", ok: true },
      { id: "2", ok: false, code: "DEP_NOT_DONE", message: expect.any(String) },
    ])
    expect(rowOf(MI, "1").note).toBe("row 1 note")
    expect(rowOf(MI, "2").status).toBe("pending")
  })

  test("probe 2 (tool): the same batch through studio_mission_update_row reports DEP_NOT_DONE per row", async () => {
    const MI = "2026-11-12_mc04-p2-tool"
    await approvedMission(MI)
    const res = await updateRow().call({ mission: MI, rows: [{ id: "1", note: "tool note" }, { id: "2", status: "running" }] }, session)
    const out = res.structuredContent as S
    console.log(`[row82] tool ok=${out.ok} results=${JSON.stringify(out.results)}`)
    expect(res.isError).not.toBe(true)
    expect(out.ok).toBe(true)
    expect(out.results).toEqual([
      { id: "1", ok: true },
      { id: "2", ok: false, code: "DEP_NOT_DONE", message: expect.any(String) },
    ])
    expect(rowOf(MI, "1").note).toBe("tool note")
    expect(rowOf(MI, "2").status).toBe("pending")
  })

  test("probe 3 (report check): a draft report on a dep-blocked row raises no DEP_NOT_DONE; a non-draft one does", async () => {
    const MI = "2026-11-12_mc04-p3-check"
    await approvedMission(MI)
    const t = { mission: MI, kind: "row" as const, row: "2", docKey: "row-2" }
    const draft = missionIssues(store as never, t, { taskRef: "2", status: "draft" } as never)
    expect(draft.map((i) => i.code)).not.toContain("DEP_NOT_DONE")
    const complete = missionIssues(store as never, t, { taskRef: "2", status: "complete" } as never)
    expect(complete.map((i) => i.code)).toContain("DEP_NOT_DONE")
  })

  test("probe 3 (store): a draft report on a dep-blocked row is recorded and does not start the row", async () => {
    const MI = "2026-11-12_mc04-p3-store"
    await approvedMission(MI)
    const DEF = { schema: "studio.template/v2", slug: "nota-dinas", slots: [{ slotKey: "isi" }] }
    const file: BuiltinTemplateFile = { slug: "nota-dinas", name: "Nota Dinas", kind: "DOCUMENT", versionNo: 1, definition: DEF, definitionSha256: sha256Hex(canonicalJson(DEF)), file: "nota-dinas.json", fileSha256: "a".repeat(64), release: "1.2.6" } as never
    const tv = await store.transaction((t) => store.pinBuiltinVersion(t, file))
    const doc = await store.transaction((t) =>
      store.createDocument(t, {
        docNumber: "082/GSP/LKA/XI/2026",
        numberSource: "AGENT",
        title: "Laporan 82",
        typeCode: "LKA",
        classification: "TERBATAS",
        tier: "NOTA",
        templateVersionId: tv.id,
        createdBy: "swarm",
        missionFolder: MI,
        missionDocKey: "row-2",
        revision: { snapshot: { n: 82 }, inputSha256: sha256Hex("d82"), docRev: "A", change: { what: "w", why: "y", impact: "i" }, createdBy: "swarm" },
      } as never),
    )
    const out = await store.transaction(async (t) => M.recordReport(t, { documentId: doc.id, revisionNo: 1, mission: MI, kind: "row", row: "2", docKey: "row-2", status: "draft" }))
    expect(out).toEqual({ mission: MI, row: "2", rowStatus: "pending" })
    expect(rowOf(MI, "2").status).toBe("pending")
  })
})
