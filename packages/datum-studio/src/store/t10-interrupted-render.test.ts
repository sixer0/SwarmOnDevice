/**
 * 1.3.4 T-10: renders a previous host process left QUEUED or RUNNING (crash, force quit) are closed as FAILED /
 * RENDER_INTERRUPTED when a new process opens the store, so they no longer block a new render of the same revision
 * with RENDER_IN_PROGRESS for 10 minutes. Finished jobs are not touched. Temp: T10_TEST_DIR, else the OS temp folder.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteStudioStore } from "./index.ts"

const BASE = process.env.T10_TEST_DIR ?? join(tmpdir(), "t10-interrupted-render-test")
mkdirSync(BASE, { recursive: true })
const RUN = mkdtempSync(join(BASE, "bun-"))
let tick = 1_800_000_000_000
const opened: SqliteStudioStore[] = []
async function openStore(name: string) {
  const s = new SqliteStudioStore()
  await s.open(join(RUN, name), { release: "1.3.4", agentClock: () => ++tick })
  opened.push(s)
  return s
}
afterAll(async () => {
  for (const s of opened) await s.close()
})

const id = (c: string) => "c" + c.repeat(24)

describe("T-10 failInterruptedRenderJobs", () => {
  test("closes QUEUED and RUNNING jobs as FAILED / RENDER_INTERRUPTED and leaves finished jobs alone", async () => {
    const store = await openStore("a")
    await store.transaction(async (tx) => {
      for (const [c, status] of [["1", "RUNNING"], ["2", "QUEUED"], ["3", "SUCCEEDED"], ["4", "FAILED"], ["5", "PARTIAL"]] as const)
        await store.recordRender(tx, { id: id(c), documentId: null, revisionId: null, formats: ["pdf"], status, requestedBy: "agent:swarm" })
    })
    const closed = await store.failInterruptedRenderJobs()
    expect(closed.toSorted()).toEqual([id("1"), id("2")])
    const rows = await store.transaction(async (tx) =>
      tx.all<{ id: string; status: string; error_code: string | null; time_finished: number | null }>(
        "SELECT id, status, error_code, time_finished FROM render_job ORDER BY id",
      ),
    )
    expect(rows.map((r) => [r.id, r.status, r.error_code])).toEqual([
      [id("1"), "FAILED", "RENDER_INTERRUPTED"],
      [id("2"), "FAILED", "RENDER_INTERRUPTED"],
      [id("3"), "SUCCEEDED", null],
      [id("4"), "FAILED", null],
      [id("5"), "PARTIAL", null],
    ])
    expect(rows.filter((r) => r.error_code === "RENDER_INTERRUPTED").every((r) => typeof r.time_finished === "number")).toBe(true)
  })

  test("a second call finds nothing to close", async () => {
    const store = await openStore("b")
    await store.transaction(async (tx) => {
      await store.recordRender(tx, { id: id("6"), documentId: null, revisionId: null, formats: ["pdf"], status: "RUNNING", requestedBy: "agent:swarm" })
    })
    expect(await store.failInterruptedRenderJobs()).toEqual([id("6")])
    expect(await store.failInterruptedRenderJobs()).toEqual([])
  })
})
