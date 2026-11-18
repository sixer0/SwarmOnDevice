// 1.3.3 row 101 (row 66 request, ruling C25): when an applied patch closes a row with the awaiting-human marker, the
// TEXT line of studio_mission_update_row says so (before, only the structured reply carried the sentence).
// Seeding as row 66's tests (real store with missionGuard, plain SQL, project copy through row 68's copier). No port.
import { afterAll, describe, expect, test } from "bun:test"
import { missionTools } from "../../src/mcp-host/mission/mission-tools.ts"
import { closeStores, mission, openStore, PASS, seedDocument, seedOutput, seedRecord, type Rec } from "../mc5-row-close-gate/_seed.ts"
import { giveProjectCopy } from "../mc8-deliverable-gate/_project-copy.ts"

const store = await openStore("row101-marker")
const MI = "2026-11-17_row101-marker"
await mission(store, MI, ["1", "2"])
afterAll(closeStores)

function lintWithLabels(addresses: string[]): Rec {
  return {
    tier: "TERBIT",
    releaseStatus: "PASS",
    banner: "Lint",
    checks: [
      { checkId: "D01", status: "PASS" },
      ...addresses.flatMap((address) => [
        { checkId: "D09", status: "REPORT", address, detail: `Gambar ${address}: labels_verified bukan true` },
        { checkId: "P1-labels_verified", status: "REPORT", address, detail: `diagram Gambar ${address}: menunggu pemeriksa manusia` },
      ]),
    ],
  }
}

describe("row 101: update_row text names the awaiting-human marker", () => {
  test("a row closed with the marker: the text line carries the store's sentence; a plain close adds none", async () => {
    const made = await store.transaction(async (t) => {
      const d = seedDocument(t, { mission: MI, docKey: "row-1-laporan", lint: lintWithLabels(["2.1.2", "2.2.2"]) })
      for (const format of ["DOCX", "HTML", "PDF"]) seedRecord(t, seedOutput(t, store.rootDir, d, { format }), d, PASS)
      return d
    })
    await giveProjectCopy(store, made.documentId)
    const upd = missionTools(store, { log: () => {}, libraryRoot: null }).find((t) => t.name === "studio_mission_update_row")!
    const session = { sessionId: "mcp-101m", agentId: "swarm", fileRoot: store.rootDir }
    const res = await upd.call({ mission: MI, rows: [{ id: "1", status: "done", note: "checked: outputs rendered and verified" }, { id: "2", status: "done", note: "checked: nothing to render" }] }, session)
    const text = (res.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n")
    console.log(`[row101] update_row text:\n${text}`)
    expect(res.isError).toBeFalsy()
    const results = (res.structuredContent as { results: Rec[] }).results
    expect(results[0]!.awaitingHumanCheck).toBeDefined()
    expect(text).toContain("row 1 is done, awaiting human check: a person has not yet checked the figure labels (labels_verified) of 2 figures; only the person clears this, in Mission Control")
    expect(text.match(/awaiting human check/g)!.length).toBe(1)
  })
})
