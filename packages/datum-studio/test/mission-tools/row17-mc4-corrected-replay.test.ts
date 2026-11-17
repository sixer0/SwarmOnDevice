// 1.3.3 row 17 (MC-4): refused calls go to the REAL tool (missionTools wrapper) in a temp store; when the refusal gives
// `corrected`, that is sent again and must pass. No server, no port.
//
// 1. Synthetic fixture (always runs, CI): fixtures/row17_synthetic_refusals.json, one call per correction kind and per
//    kind that must NOT be corrected. No text of the test day.
// 2. Replay R1 (runs when the file is there): every refused studio_mission_* call of 2026-11-17. The file holds the
//    person's own mission texts, so it is NOT in the repository: the path comes from ROW17_R1_JSONL (default: the task
//    folder beside the Swarm checkout). SCHEMA_INVALID, STATUS_TRANSITION and the state-free KIND_NOT_ALLOWED create
//    are replayed; the other codes depend on the store of the day (documents, renders, attestation) and are counted.
//
// State: each call gets a fresh `document` mission rebuilt from the call: the row of a STATUS_TRANSITION refusal is in
// the recorded `from` (fixture: `seed`); a row the call moves is in a status from which that move is legal; every
// other row 1-26 is done; decisions U1 and C1-C20 exist.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SqliteStudioStore } from "../../src/store/index.ts"
import { missionTools } from "../../src/mcp-host/mission/mission-tools.ts"
import SYNTHETIC from "./fixtures/row17_synthetic_refusals.json"
import { replayPath } from "../replay-dir"

type S = Record<string, any>
// Row 146: SWARM_REPLAY_DIR (ROW17_R1_JSONL still overrides); no fixed path.
const R1 = process.env.ROW17_R1_JSONL ?? replayPath("R1_opencode_calls", "r1_refused_mission_calls.jsonl") ?? ""
const HAVE = existsSync(R1)
if (!HAVE) console.log("[skip] row 17 replay R1: replay input not available; set SWARM_REPLAY_DIR=<1.3.3 patch folder>/research/replay (or ROW17_R1_JSONL) to run")
const BASE = process.env.ROW17_TEST_DIR ?? path.join(tmpdir(), "row17-mc4-replay")
mkdirSync(BASE, { recursive: true })
const RUN = mkdtempSync(path.join(BASE, "bun-"))
let tick = 1_800_000_000_000
const clock = () => ++tick
const stores: SqliteStudioStore[] = []
afterAll(async () => {
  for (const s of stores) await s.close()
})
const session = { sessionId: "mcp-17", agentId: "swarm", fileRoot: "/private/tmp/claude-501/row17" }
const seedRow = (id: string) => ({ id, phase: "draft", kind: "draft", title: `Row ${id}`, agent: "document-writer", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `draft/${id}.md`, verification: "checked" })

interface Call {
  n: number
  tool: string
  args: S
  code: string
  details: S
  /** Fixture only: row id -> status before the call; `mission: "approved"` leaves the mission approved, rows pending. */
  seed?: Record<string, string>
  mission?: string
}
function calls(): Call[] {
  return readFileSync(R1, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l, n) => {
      const d = JSON.parse(l) as S
      const error = String(d.error ?? "")
      const rincian = /\nrincian: (.*)/.exec(error)?.[1]
      let details: S = {}
      try {
        details = rincian ? JSON.parse(rincian) : {}
      } catch {
        details = {}
      }
      return { n, tool: String(d.tool_name).replace(/^.*?(studio_mission_)/, "$1"), args: d.arguments as S, code: /^ditolak ([A-Z_]+)/.exec(error)?.[1] ?? "?", details }
    })
}

/** A fresh store with the call's mission in a state rebuilt from the call (see the header). */
async function stateFor(c: Call): Promise<S[]> {
  const store = new SqliteStudioStore()
  stores.push(store)
  await store.open(path.join(RUN, `s${c.n}`), { release: "1.3.3", log: () => {}, agentClock: clock })
  const M = store.missions
  const id = c.tool === "studio_mission_create" ? "2026-11-17_row17-other" : typeof c.args.mission === "string" ? c.args.mission : "2026-11-17_row17-replay"
  let rows: S[] = []
  try {
    rows = typeof c.args.rows === "string" ? JSON.parse(c.args.rows) : Array.isArray(c.args.rows) ? c.args.rows : []
  } catch {
    rows = []
  }
  const added = new Set(rows.map((p) => p?.add?.id ?? (p?.add ? p.id : undefined)).filter(Boolean))
  const want = new Map<string, string>()
  for (const p of rows) {
    const rid = p?.id ?? p?.checkpoint?.id
    if (typeof rid !== "string" || added.has(rid) || want.has(rid)) continue
    want.set(rid, p.status === "running" ? "pending" : p.status === undefined ? "running" : "running")
  }
  // On the day the whole call was refused, so no other patch of it applied: a row moved to the same status was in the
  // same `from`, and a row the call starts waited on the refused row (a build dependency).
  const waits = new Map<string, string>()
  if (c.code === "STATUS_TRANSITION" && typeof c.details.row === "string" && typeof c.details.from === "string") {
    for (const p of rows) {
      if (typeof p?.id !== "string" || p.id === c.details.row || added.has(p.id)) continue
      if (p.status === c.details.to) want.set(p.id, c.details.from)
      else if (p.status === "running") waits.set(p.id, `${c.details.row}:B`)
    }
    want.set(c.details.row, c.details.from)
  }
  for (const [r, st] of Object.entries(c.seed ?? {})) want.set(r, st)
  const ids = Array.from({ length: 26 }, (_x, i) => String(i + 1)).filter((r) => !added.has(r))
  const decisions = [{ id: "U1", by: "user", date: "2026-11-17", text: "approved" }, ...Array.from({ length: 20 }, (_x, i) => ({ id: `C${i + 1}`, by: "controller", date: "2026-11-17", text: `decision ${i + 1}` }))]
  await store.transaction(async (t) => M.create(t, { id, title: "Replay", type: "document", owner: "controller", project: { dir: "/private/tmp/claude-501/row17" }, rows: ids.map((r) => ({ ...seedRow(r), deps: waits.has(r) ? [waits.get(r)] : [] })), decisions } as never, { attested: true }))
  await store.transaction(async (t) => M.approve(t, id, "U1"))
  if (c.mission !== "approved") await store.transaction(async (t) => {
    for (const r of ids) {
      const to = want.get(r) ?? "done"
      if (to === "pending") continue
      M.updateRows(t, id, [{ id: r, status: "running" }])
      if (to === "done") M.updateRows(t, id, [{ id: r, status: "done", note: "seed: checked" }])
      if (to === "blocked") M.updateRows(t, id, [{ id: r, status: "blocked", note: "seed: blocked" }])
    }
  })
  return missionTools(store as never, { log: () => {} }) as S[]
}

interface Outcome {
  n: number
  tool: string
  recorded: string
  first: string
  kind: string
  second?: string
  /** After a corrected call that was accepted with one patch refused: that patch's own `corrected`, sent as a third call. */
  third?: string
  changed?: string
  fields?: string
}
/** ok, or the refusal code; an update_row call that is accepted while a patch inside it is refused is not a pass. */
function verdict(r: S): string {
  const s = r.structuredContent as S
  if (r.isError || s?.ok === false) return String(s?.code ?? "ERROR")
  const refused = Array.isArray(s?.results) ? s.results.filter((x: S) => x.ok === false) : []
  return refused.length > 0 ? `patch:${refused[0].code}` : "ok"
}

/** The refused patches of an accepted update_row call: all carry `corrected` -> send each; the worst verdict, or undefined. */
async function sendPatchFixes(tool: S, r: S): Promise<string | undefined> {
  const refused = ((r.structuredContent as S).results as S[]).filter((x) => x.ok === false)
  if (refused.some((x) => !x.corrected)) return undefined
  let worst = "ok"
  for (const x of refused) {
    const v = verdict((await tool.call(structuredClone(x.corrected.arguments), session)) as S)
    if (v !== "ok") worst = v
  }
  return worst
}

async function replay(c: Call): Promise<Outcome> {
  const tools = await stateFor(c)
  const tool = tools.find((t) => t.name === c.tool)!
  const r1 = (await tool.call(structuredClone(c.args), session)) as S
  const first = verdict(r1)
  const out: Outcome = { n: c.n, tool: c.tool.replace("studio_mission_", ""), recorded: c.code, first, kind: "" }
  if (first === "ok") return { ...out, kind: "ok" }
  if (first.startsWith("patch:")) {
    const second = await sendPatchFixes(tool, r1)
    return second === undefined ? { ...out, kind: "accepted with a refused patch" } : { ...out, kind: "patch-corrected", second }
  }
  // The refusal as the tool wrapper returns it: `corrected` / `fields` are in error and on one text line.
  const e = (r1.structuredContent as S).error as S
  const text = String((r1.content as S[])[0].text)
  if (!e.corrected) return { ...out, kind: e.fields ? "fields" : "none", fields: e.fields ? e.fields.map((f: S) => f.field).join(" ") : undefined }
  expect(text).toContain(`\ncorrected: ${JSON.stringify(e.corrected)}\nnext: `)
  const r2 = (await tool.call(structuredClone(e.corrected.arguments), session)) as S
  const second = verdict(r2)
  const third = second.startsWith("patch:") ? await sendPatchFixes(tool, r2) : undefined
  return { ...out, kind: "corrected", second, changed: e.corrected.changed, ...(third !== undefined ? { third } : {}) }
}

describe("row 17 synthetic fixture: one refused call per kind, through the real tool", () => {
  ;(SYNTHETIC as S[]).forEach((f, n) => {
    test(`${f.kind}: ${f.expect}`, async () => {
      const o = await replay({ n: 1000 + n, tool: f.tool, args: f.args, code: f.code, details: {}, seed: f.seed, mission: f.mission })
      if (f.expect === "ok") return expect([o.first, o.kind]).toEqual(["ok", "ok"])
      if (f.expect === "patch-corrected") return expect([o.first.split(":")[0], o.kind, o.second]).toEqual(["patch", "patch-corrected", "ok"])
      expect([o.first, o.kind]).toEqual([f.code, f.expect])
      if (f.expect === "corrected") expect(o.second).toBe("ok")
      else expect(o.fields!.length).toBeGreaterThan(0)
    })
  })
})

describe.skipIf(!HAVE)("row 17 replay R1: refused mission calls of 2026-11-17", () => {
  test("the SCHEMA_INVALID and STATUS_TRANSITION calls: corrected, sent again, counted", async () => {
    const all = calls()
    const inScope = all.filter((c) => c.code === "SCHEMA_INVALID" || c.code === "STATUS_TRANSITION")
    // State-free refusal of another code, replayed to see whether 1.3.3 still refuses it (no `corrected` for its code).
    for (const c of all.filter((x) => x.code === "KIND_NOT_ALLOWED" && x.tool === "studio_mission_create")) console.log(`ROW17-REPLAY other ${JSON.stringify(await replay(c))}`)
    const outcomes: Outcome[] = []
    for (const c of inScope) outcomes.push(await replay(c))
    const other = new Map<string, number>()
    for (const c of all) if (!inScope.includes(c)) other.set(c.code, (other.get(c.code) ?? 0) + 1)
    console.log(`ROW17-REPLAY total ${all.length}; in scope ${inScope.length}; other codes ${JSON.stringify(Object.fromEntries(other))}`)
    for (const o of outcomes) console.log(`ROW17-REPLAY ${JSON.stringify(o)}`)
    const pass = outcomes.filter((o) => o.first === "ok" || o.second === "ok" || o.third === "ok")
    const correctedPass = outcomes.filter((o) => o.kind === "corrected" && o.second === "ok")
    const correctedFail = outcomes.filter((o) => o.kind === "corrected" && o.second !== "ok")
    const fields = outcomes.filter((o) => o.kind === "fields")
    const none = outcomes.filter((o) => o.kind === "none")
    console.log(`ROW17-REPLAY pass ${pass.length} of ${inScope.length} in scope (of ${all.length} found): corrected and passed ${correctedPass.length}, accepted at once ${outcomes.filter((o) => o.first === "ok").length}, corrected and passed on a third send ${correctedFail.filter((o) => o.third === "ok").length}, fields only ${fields.length}, nothing ${none.length}`)
    expect(all.length).toBe(51)
    expect(inScope.length).toBe(27)
    // Every call still refused here is refused with the same code as on the day (the rebuilt state is faithful enough).
    for (const o of outcomes) if (o.first !== "ok") expect([o.n, o.first]).toEqual([o.n, o.recorded])
    expect(outcomes.filter((o) => o.kind === "accepted with a refused patch").map((o) => o.n)).toEqual([])
    // A corrected payload passes when it is sent again. One call needs a third send: call 19 moved rows 19 and 20 to
    // done, the refusal names row 19 only, so only row 19 is corrected; the corrected call is accepted, row 19 closes,
    // and row 20 (its status on the day is not known; rebuilt here as pending, like row 19) is refused inside
    // results[] with its own `corrected`, which then passes.
    expect(correctedFail.map((o) => [o.n, o.second, o.third])).toEqual([[19, "patch:STATUS_TRANSITION", "ok"]])
    // Every in-scope refusal names something: corrected or fields.
    expect(none.map((o) => o.n)).toEqual([])
    expect({ pass: pass.length, corrected: correctedPass.length, fields: fields.length }).toEqual(PIN)
  }, 120_000)
})
const PIN = { pass: 19, corrected: 17, fields: 8 }
