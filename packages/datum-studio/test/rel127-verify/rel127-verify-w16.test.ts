// Swarm 1.2.7 row 45b (N7-114, CHAR-VERIFY): regression test committed from the row 9 host probe
// ($T/test/probes/datum-studio/probe9_host.test.ts "W-16"). Must pass at BASE 04067a9d02 and at HEAD; no code change
// for this item. Synthetic inputs only: filler words written here, no fixture file is read.
// AC-W16 (01_specs §4; C5 keeps 1.2.6 C6 option A): closing a mission returns the decision register and is not
// refused for a missing export (no new refusal path). Behaviour pin through the REAL Studio host; guide pin on the
// studio_mission_set_status description the agent reads. The store-level pin stays
// test/mission-tools/row89-w16-decisions-close.test.ts (1.2.6 row 89).
// Runs through the REAL Studio host (AccSession of test/acceptance/session_115.acc.ts, bridge:false, mission guard on).
// Needs the command sandbox off (loopback listen):
//   cd packages/datum-studio && bun test ./test/rel127-verify/rel127-verify-w16.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { AccSession, errCode, okCall } from "../acceptance/session_115.acc"

const WORK = realpathSync(mkdtempSync(path.join(tmpdir(), "r127v-w16-")))
const s = new AccSession(WORK, { mission: "2026-11-13_r127v-w16" })

beforeAll(async () => {
  await s.start({ bridge: false })
}, 120_000)
afterAll(async () => {
  await s.stop()
  rmSync(WORK, { recursive: true, force: true })
}, 60_000)

describe("rel127 VERIFY W-16: decision register at mission close", () => {
  test("row done without an export, then set_status done returns decisions {count, ids}; nothing exported", async () => {
    const MI = s.mission
    const row = { id: "1", phase: "implementation", kind: "test", title: "Baris uji", agent: "test-expert", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: "test/p.md", verification: "uji", review: "gate" }
    expect(okCall(await s.call("studio_mission_create", { mission: { id: MI, title: "Uji W-16", type: "feature-release", owner: "master-controller", project: { dir: s.project }, rows: [row], decisions: [{ id: "U1", by: "user", date: "2026-11-13", text: "go" }] } }))).toBe(true)
    expect(okCall(await s.call("studio_mission_approve", { mission: MI, decision: "U1" }))).toBe(true)
    expect(okCall(await s.call("studio_mission_set_status", { mission: MI, to: "running" }))).toBe(true)
    expect(okCall(await s.call("studio_mission_record_decision", { mission: MI, decision: { id: "C1", by: "controller", date: "2026-11-13", text: "Keputusan uji" } }))).toBe(true)
    expect(okCall(await s.call("studio_mission_update_row", { mission: MI, rows: [{ id: "1", status: "running" }] }))).toBe(true)
    const r2 = await s.call("studio_mission_update_row", { mission: MI, rows: [{ id: "1", status: "done", note: "selesai tanpa ekspor" }] })
    expect(errCode(r2)).toBe("OK")

    const done = await s.call("studio_mission_set_status", { mission: MI, to: "done" })
    expect(errCode(done)).toBe("OK")
    expect(done.data?.decisions ?? done.decisions).toEqual({ count: 2, ids: ["U1", "C1"] })
    expect(String(done._text)).toContain("decisions 2: U1, C1")
    expect(existsSync(path.join(s.project, "docs", MI))).toBe(false)
  }, 120_000)

  test("guide pin: the studio_mission_set_status description states the register at done and no refusal for a missing export", async () => {
    const tools = await s.client.listTools()
    const desc = String(tools.tools.find((t) => t.name === "studio_mission_set_status")?.description ?? "")
    expect(desc).toContain("done returns the decision register decisions {count, ids}")
    expect(desc).toContain("closing is not refused for a missing export")
  })
})
