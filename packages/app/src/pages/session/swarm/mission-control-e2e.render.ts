// Row 134: mission control end to end in the app test harness.
//
//   REAL Studio host (datum-studio/test/mission-control-e2e/row134-fixture-host.ts: real store, 4 fixture missions made
//   with the real mission tools, own bun process)
//     <- REAL desktop bridge: mission-client.ts (allow-list, token in main) behind mission-ipc.ts handlers
//        (registered on a recording ipcMain; the renderer side is a copy of the preload `missions` block, preload/index.ts:74-89)
//     <- REAL app: createMissionControl (row 129) + MissionControl (row 133) with MissionHQ (130), MissionCommand (131),
//        MissionDeliverables (132), rendered in happy-dom with the app's Solid babel preset.
//
// Run by mission-control-e2e.test.ts in its own process:
//   bun test --conditions=browser --preload ./happydom.ts ./src/pages/session/swarm/mission-control-e2e.render.ts
// Binds an ephemeral 127.0.0.1 port (the host): needs the command sandbox off. No Electron, no model call (the host
// fixture traps fetch), no keychain. Env: ROW134_TEST_DIR (work root), R134_MUTATION (passed to the host fixture).
// Cross-package modules are loaded with runtime paths (untyped) so the app typecheck does not pull desktop/datum-studio.
import { plugin } from "bun"
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import { Database } from "bun:sqlite"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { createSignal } from "solid-js"
import { createComponent, render } from "solid-js/web"
import { dict as en } from "@/i18n/en"

const viteSolid = createRequire(createRequire(import.meta.url).resolve("vite-plugin-solid"))
const babel = viteSolid("@babel/core")
const presets = [
  [viteSolid.resolve("babel-preset-solid"), { generate: "dom" }],
  [viteSolid.resolve("@babel/preset-typescript"), { isTSX: true, allExtensions: true }],
]
plugin({
  name: "solid-jsx",
  setup(build) {
    build.onLoad({ filter: /packages\/(ui|session-ui|app)\/src\/.*\.tsx$/ }, async (args) => ({
      contents: babel.transformSync(await Bun.file(args.path).text(), { filename: args.path, presets }).code,
      loader: "js",
    }))
  },
})

const table: Record<string, string> = en
const real = await import("@/context/language")
mock.module("@/context/language", () => ({
  ...real,
  useLanguage: () => ({
    t: (key: string, params?: Record<string, string>) =>
      (table[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_: string, name: string) => String(params?.[name] ?? "")),
    locale: () => "en",
    intl: () => "en-US",
  }),
}))

const here = (p: string) => new URL(p, import.meta.url).pathname
const PACKAGES = here("../../../../../")
const { MissionControl } = await import(here("./mission-control.tsx"))
const { createMissionControl, missionSourceOf } = await import(here("./mission-poll.ts"))
const { missionWriterOf } = await import(here("./mission-command-model.ts"))
const { buildMission } = await import(here("./mission-model.ts"))
const { agentsFilterFallsBack, offersAgentsView } = await import(here("./mission-control-layout.ts"))
const desktopMain = join(PACKAGES, "desktop", "src", "main", "datum-studio-host")
const { createMissionControlClient, MISSION_CONTROL_TOOLS } = await import(join(desktopMain, "mission-client.ts"))
const { registerMissionControlHandlers } = await import(join(desktopMain, "mission-ipc.ts"))
const { MISSION_CONTROL_IPC } = await import(join(PACKAGES, "desktop", "src", "preload", "mission-control-channels.ts"))
const { BUILTIN_MISSION_TYPES } = await import(join(PACKAGES, "datum-studio", "src", "store", "mission", "builtin-types.ts"))

const FIXTURE = join(PACKAGES, "datum-studio", "test", "mission-control-e2e", "row134-fixture-host.ts")
const BASE = process.env.ROW134_TEST_DIR ?? "/private/tmp/claude-501/row134/e2e"
mkdirSync(BASE, { recursive: true })
const WORK = realpathSync(mkdtempSync(join(BASE, "run-")))
const MC_CWD = join(WORK, "state", "swarm", "datum-studio-mission-control")
const RENDERER_URL = "oc://renderer/index.html"
const quote = (label: string, v: unknown) => console.log(`[row134] ${label}: ${JSON.stringify(v)}`)
// INTENT 1.2.7 U-1 (U2): the panel lists only missions linked (client swarm) to the window's sessions. The fixture
// missions are made by agent "claude", so beforeAll links them to this session the way a Swarm agent write would.
const FX_SESSION = "ses_0134f0000001Row134Fixture1"

type S = Record<string, any>
type Manifest = {
  url: string
  token: string
  project: string
  store: string
  missions: Array<{ id: string; type: string; title: string; docs: Array<{ documentId: string; docKey: string; verified: boolean; outputs: string[] }> }>
  mutation: string | null
  generatedMs: number
}

// ── Host (fixture generator) process

let child: ChildProcessWithoutNullStreams | undefined
let hostErr = ""
let fx: Manifest

async function startHost(): Promise<Manifest> {
  child = spawn(process.execPath, [FIXTURE], {
    cwd: WORK,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: join(WORK, "home"),
      TMPDIR: process.env.TMPDIR ?? "/private/tmp",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      ALL_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost",
      R134_WORK: WORK,
      ...(process.env.R134_MUTATION ? { R134_MUTATION: process.env.R134_MUTATION } : {}),
    },
  })
  let out = ""
  child.stderr.on("data", (c: Buffer) => (hostErr += c.toString()))
  const line = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture host not ready: ${hostErr.slice(-3000)}`)), 90_000)
    child!.stdout.on("data", (c: Buffer) => {
      out += c.toString()
      const ready = out.split("\n").find((l) => l.startsWith("READY "))
      if (ready) {
        clearTimeout(timer)
        resolve(ready)
      }
    })
    child!.on("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`fixture host exited ${code}: ${hostErr.slice(-3000)}`))
    })
  })
  return JSON.parse(line.slice("READY ".length)) as Manifest
}

async function stopHost() {
  if (!child || child.exitCode !== null) return
  const exited = new Promise((r) => child!.once("exit", r))
  child.kill("SIGTERM")
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))])
  if (child.exitCode === null) child.kill("SIGKILL")
}

// ── Desktop bridge: real mission-ipc handlers + real mission-client, renderer side = preload block copy

type Call = { channel: string; ms: number; ok: boolean }
const calls: Call[] = []
let missions: S
let client: S

function buildBridge() {
  // Bun's own fetch: happy-dom replaces globalThis.fetch in this process (main has the platform fetch in the app).
  // The client's AbortSignal comes from happy-dom's AbortController here, so the timeout signal is dropped for the
  // native call; the 5 s timeout itself is row 127's (mission-client.test.ts).
  const nativeFetch = (u: string, init: S) => Bun.fetch(u, { method: init.method, headers: init.headers, body: init.body, redirect: init.redirect })
  client = createMissionControlClient({ url: fx.url, token: fx.token, callerCwd: MC_CWD, running: () => child?.exitCode === null, fetch: nativeFetch })
  const handlers = new Map<string, (event: unknown, input: unknown) => Promise<S>>()
  const mainFrame = { url: RENDERER_URL }
  const sender = { mainFrame }
  const win = { isDestroyed: () => false, webContents: sender }
  registerMissionControlHandlers({
    ipcMain: { handle: (channel: string, fn: (event: unknown, input: unknown) => Promise<S>) => handlers.set(channel, fn) },
    windowOf: (s: unknown) => (s === sender ? win : null),
    isRendererUrl: (u: string | undefined) => u === RENDERER_URL,
    client: () => client,
    log: (level: string, message: string) => quote(`ipc ${level}`, message),
  })
  const invoke = async (channel: string, input: unknown) => {
    const started = performance.now()
    // structured clone, as ipcRenderer.invoke does
    const result = await handlers.get(channel)!({ sender, senderFrame: mainFrame }, structuredClone(input))
    calls.push({ channel, ms: performance.now() - started, ok: result.ok === true })
    return result
  }
  // preload/index.ts:74-89 (the renderer gets only these four functions)
  missions = {
    list: (input: S) =>
      invoke(MISSION_CONTROL_IPC.list, {
        directory: input?.directory,
        ...(input?.sessions === undefined ? {} : { sessions: Array.isArray(input.sessions) ? [...input.sessions] : input.sessions }),
      }),
    get: (input: S) => invoke(MISSION_CONTROL_IPC.get, { mission: input?.mission }),
    answer: (input: S) => invoke(MISSION_CONTROL_IPC.answer, { mission: input?.mission, request: input?.request, option: input?.option }),
    instruct: (input: S) =>
      invoke(MISSION_CONTROL_IPC.instruct, { mission: input?.mission, text: input?.text, ...(input?.row === undefined ? {} : { row: input.row }) }),
  }
  return handlers
}

/** Test-only reader of the host (agent "claude"): the oracle for round trips, NOT the path under test. */
async function hostGet(mission: string, include: string[]) {
  const headers = {
    authorization: `Bearer ${fx.token}`,
    "x-studio-agent": "claude",
    "x-studio-caller-cwd": encodeURIComponent(fx.project),
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  }
  const post = async (body: S, sid?: string) => {
    const r = await Bun.fetch(fx.url, { method: "POST", headers: { ...headers, ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify(body) })
    const text = await r.text()
    const data = text.includes("data:") ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("") : text
    return { sid: r.headers.get("mcp-session-id") ?? sid, json: data ? (JSON.parse(data) as S) : {} }
  }
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "row134-oracle", version: "0" } } })
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, init.sid)
  const r = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "studio_mission_get", arguments: { mission, include } } }, init.sid)
  return r.json.result?.structuredContent as S
}

/** Test setup (INTENT 1.2.7 U-1): link every fixture mission to FX_SESSION under client swarm, as an agent write does. */
function linkFixtureSession() {
  const db = new Database(join(fx.store, "datum-studio.sqlite"))
  try {
    db.exec("PRAGMA busy_timeout = 5000")
    const insert = db.prepare("INSERT OR IGNORE INTO mission_session (mission_id, client, session_ref, role, time_linked) VALUES (?, 'swarm', ?, NULL, ?)")
    for (const m of fx.missions) insert.run(m.id, FX_SESSION, Date.now())
  } finally {
    db.close()
  }
}

/** Store truth for G4, read straight from the SQLite file (read-only): verified = state verified AND sha matches. */
function storeVerified(outputIds: string[]): Record<string, boolean> {
  const db = new Database(join(fx.store, "datum-studio.sqlite"), { readonly: true })
  try {
    const rows = db
      .query<{ id: string; sha256: string; state: string | null; vsha: string | null }, []>(
        `SELECT f.id, f.sha256, v.state, v.output_sha256 AS vsha FROM output_file f LEFT JOIN output_verification v ON v.output_file_id = f.id WHERE f.id IN (${outputIds.map((id) => `'${id.replace(/[^a-z0-9]/g, "")}'`).join(",")})`,
      )
      .all()
    return Object.fromEntries(rows.map((r) => [r.id, r.state === "verified" && r.vsha === r.sha256]))
  } finally {
    db.close()
  }
}

// ── DOM mount

const [watching, setWatching] = createSignal(true)
const [mapOpen, setMapOpen] = createSignal(true)
let visibility: "visible" | "hidden" = "visible"
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility })
const prompts: string[] = []
let dispose = () => {}
let tickTimes: number[] = []

const q = (sel: string) => document.querySelector<HTMLElement>(sel)
const qa = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel))
const click = (el: Element | null) => el!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
async function until(check: () => boolean, ms = 8000, what = "the DOM") {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  const source = missionSourceOf({ missions })!
  // time each live read the way the poller does it: list, then get when changed (§4.2)
  const timed = {
    list: async (input: S) => {
      const t0 = performance.now()
      const r = await source.list(input as never)
      tickTimes.push(-(performance.now() - t0))
      return r
    },
    get: async (input: S) => {
      const t0 = performance.now()
      const r = await source.get(input as never)
      tickTimes.push(performance.now() - t0)
      return r
    },
  }
  dispose = render(() => {
    const control = createMissionControl({
      source: timed,
      directory: () => fx.project,
      sessions: () => [FX_SESSION],
      lang: () => "en",
      watching,
      mapOpen,
      listFiles: async () => [],
    })
    return createComponent(MissionControl, {
      control,
      writer: missionWriterOf({ missions }),
      prompt: async (text: string) => void prompts.push(text),
      width: 1280,
    })
  }, host)
}

async function show(id: string, title: string) {
  const select = q("[data-mission-select]") as HTMLSelectElement
  if (select.value !== id) {
    select.value = id
    select.dispatchEvent(new Event("change", { bubbles: true }))
  }
  await until(() => q("[data-mission-title]")?.textContent === title && !!q(`[data-hq-room]`), 8000, `mission ${id}`)
}

beforeAll(async () => {
  fx = await startHost()
  linkFixtureSession()
  quote("fixtures generated through the real host", { missions: fx.missions.map((m) => [m.id, m.type]), generatedMs: fx.generatedMs, mutation: fx.mutation })
  buildBridge()
  mount()
  await until(() => qa("[data-mission-select] option").length === 4 && !!q("[data-hq-room]"), 15_000, "first mission")
}, 120_000)

afterAll(async () => {
  dispose()
  await stopHost()
})

// ── Oracles (hand-written from the fixture design + spec §5.1, §5.2, §7.2; phases from the builtin type definitions)

type Expect = {
  id: string
  title: string
  eyebrow: string
  pct: string
  count: string
  rooms: Record<string, string>
  agents: Record<string, string>
  checkpoint: [string, string]
  deliverables: Record<string, { status: string; verified: boolean }>
  final: string
}
const EXPECT: Record<string, Expect> = {
  "feature-release": {
    id: "2026-11-07_m134-feature",
    title: "Mission control release",
    eyebrow: "Feature / release",
    pct: "43%",
    count: "3/7",
    rooms: { identification: "2/2", research: "1/1", implementation: "0/2", verification: "0/1", release: "0/1" },
    agents: { "1": "done", "2": "done", "3": "done", "4": "running", "5": "issue", "6": "blocked", "7": "blocked" },
    checkpoint: ["4", "2/5"],
    deliverables: { "row-2-blueprint": { status: "final", verified: true }, "row-4-design": { status: "draft", verified: false } },
    final: "1/2 final",
  },
  research: {
    id: "2026-11-07_m134-research",
    title: "Vendor landscape study",
    eyebrow: "Research",
    pct: "20%",
    count: "1/5",
    rooms: { identification: "1/1", research: "0/2", synthesis: "0/1", report: "0/1" },
    agents: { "1": "done", "2": "running", "3": "review", "4": "blocked", "5": "waiting" },
    checkpoint: ["2", "1/3"],
    deliverables: { "row-3-sources": { status: "review", verified: true }, "row-5-study": { status: "draft", verified: false } },
    final: "0/2 final",
  },
  debug: {
    id: "2026-11-07_m134-debug",
    title: "Fix the login loop",
    eyebrow: "Debug",
    pct: "50%",
    count: "2/4",
    rooms: { reproduce: "1/1", diagnose: "1/1", fix: "0/1", verify: "0/1" },
    agents: { "1": "done", "2": "done", "3": "running", "4": "blocked" },
    checkpoint: ["3", "3/4"],
    deliverables: { "row-3-fix-note": { status: "draft", verified: false }, lampiran: { status: "review", verified: true } },
    final: "0/2 final",
  },
  document: {
    id: "2026-11-07_m134-document",
    title: "Kajian DATUM",
    eyebrow: "Document",
    pct: "50%",
    count: "2/4",
    rooms: { brief: "1/1", draft: "1/1", review: "0/1", publish: "0/1" },
    agents: { "1": "done", "2": "done", "3": "review", "4": "blocked" },
    checkpoint: ["", ""],
    deliverables: { "row-2-kajian": { status: "final", verified: true }, "row-3-review-memo": { status: "review", verified: false } },
    final: "1/2 final",
  },
}
const typePhases = (type: string) =>
  (BUILTIN_MISSION_TYPES as Array<{ id: string; phases: Array<{ id: string; order: number }> }>)
    .find((t) => t.id === type)!
    .phases.slice()
    .sort((a, b) => a.order - b.order)
    .map((p) => p.id)

describe("row 134: four fixture missions from the real host, through the desktop bridge, in the app components", () => {
  test("the selector lists the four missions of the session (list through the bridge, projectDir filter)", () => {
    const options = qa("[data-mission-select] option").map((o) => (o as HTMLOptionElement).value)
    expect(options.sort()).toEqual(fx.missions.map((m) => m.id).sort())
    quote("selector", options)
  })

  for (const type of ["feature-release", "research", "debug", "document"]) {
    const e = EXPECT[type]
    test(`${type}: shows only its phases; room counts, agent statuses, pct and n/m match the store`, async () => {
      await show(e.id, e.title)
      const rooms = qa("[data-hq-room]").map((r) => r.dataset.hqRoom)
      quote(`${type} rooms`, rooms)
      expect(rooms).toEqual(typePhases(type))
      expect(q("[data-mission-eyebrow]")!.textContent).toBe(e.eyebrow)
      // happy-dom does not lay out: the stage measures 0 px, so the HQ draws its lanes layout (rooms are the same set)
      const mode = q("[data-mission-control] [data-mission-hq]")!.dataset.missionHq
      expect(["radial", "lanes"]).toContain(mode!)
      const roomCounts = Object.fromEntries(qa("[data-hq-room]").map((r) => [r.dataset.hqRoom, r.querySelector("[data-hq-room-count]")!.textContent]))
      expect(roomCounts).toEqual(e.rooms)
      const agents = Object.fromEntries(qa("[data-hq-agent]").map((a) => [a.dataset.hqAgent, a.dataset.status]))
      expect(agents).toEqual(e.agents)
      // each agent sits in its row's phase room
      const truth = await hostGet(e.id, ["rows"])
      for (const r of truth.mission.rows as S[]) {
        if (r.status === "dropped") {
          expect(q(`[data-hq-agent="${r.id}"]`)).toBeNull()
          continue
        }
        expect(q(`[data-hq-room="${r.phase}"] [data-hq-agent="${r.id}"]`)).not.toBeNull()
      }
      const pct = q("[data-hq-pct]")!.textContent
      const count = q("[data-hq-count]")!.textContent
      quote(`${type} ring`, { pct, count, roomCounts, agents })
      expect(pct).toBe(e.pct)
      expect(count).toBe(e.count)
      if (e.checkpoint[0]) {
        // checkpoint n/m: on the agent bar when the stage is radial; in every layout on the selected-agent detail
        const bar = q(`[data-hq-agent="${e.checkpoint[0]}"] [data-hq-checkpoint]`)
        if (bar) expect(bar.dataset.hqCheckpoint).toBe(e.checkpoint[1])
        click(q(`[data-hq-agent="${e.checkpoint[0]}"]`))
        await until(() => !!q("[data-mission-detail]"), 3000, "agent detail")
        const detail = q("[data-mission-detail]")!.textContent
        quote(`${type} agent ${e.checkpoint[0]} detail`, detail)
        expect(detail).toContain(e.checkpoint[1])
      }
      // the open decision of the fixture is on the card
      expect(q("[data-mission-decision]")!.textContent).toContain("D-1")
    })
  }

  test("deliverables: Verified / Unverified equals the store (SQLite), status follows §7.2, n/m final", async () => {
    const seen: S[] = []
    for (const m of fx.missions) {
      const e = EXPECT[m.type]
      await show(m.id, e.title)
      const truth = storeVerified(m.docs.flatMap((d) => d.outputs))
      for (const d of m.docs) {
        const el = q(`[data-mission-deliverable="${d.documentId}"]`)!
        expect(el).not.toBeNull()
        const storeSaysVerified = d.outputs.length > 0 && d.outputs.every((o) => truth[o] === true)
        const shown = el.dataset.verified === "true"
        const label = el.querySelector("[data-mission-deliverable-verified]")!.textContent
        seen.push({ mission: m.type, docKey: d.docKey, store: storeSaysVerified, ui: shown, label, status: el.dataset.status })
        expect(shown).toBe(storeSaysVerified)
        expect(storeSaysVerified).toBe(d.verified) // the generator's intent reached the store
        expect(label).toBe(storeSaysVerified ? "Verified" : "Unverified")
        expect({ status: el.dataset.status, verified: shown }).toEqual(e.deliverables[d.docKey])
      }
      expect(q("[data-mission-deliverables-count]")!.textContent).toBe(e.final)
    }
    quote("deliverables ui vs store", seen)
  })

  test("decision round trip: option click -> host records U2 by user (actor mission-control) -> UI shows answered; held rows released", async () => {
    const e = EXPECT["feature-release"]
    await show(e.id, e.title)
    expect(q('[data-hq-agent="6"]')!.dataset.status).toBe("blocked")
    const before = calls.length
    click(q('[data-mission-option="B"]'))
    await until(() => !!q("[data-mission-answered]"), 8000, "answered state")
    const answered = q("[data-mission-answered]")!.textContent
    quote("answered card", answered)
    expect(answered).toContain("Answered: verifier")
    expect(answered).toContain("Recorded as U2")
    expect(q("[data-mission-decision]")).toBeNull()
    const host = await hostGet(e.id, ["decisions", "requests", "events"])
    const req = (host.requests as S[]).find((r) => r.id === "D-1")!
    quote("host request after answer", { status: req.status, answer: req.answer })
    expect(req).toMatchObject({ status: "answered", answer: { option: "B", by: "user", decision: "U2" } })
    expect((host.mission.decisions as S[]).map((d) => d.id)).toContain("U2")
    expect((host.events as S[]).filter((ev) => ev.actor === "mission-control").length).toBeGreaterThan(0)
    expect(calls.slice(before).map((c) => c.channel)).toContain(MISSION_CONTROL_IPC.answer)
    expect(prompts.at(-1)).toContain("D-1")
    // the answer releases the gate on rows 6 and 7 (pending again -> waiting), read back on the forced refresh
    await until(() => q('[data-hq-agent="6"]')?.dataset.status === "waiting", 8000, "row 6 released")
    expect(q('[data-hq-agent="7"]')!.dataset.status).toBe("waiting")
    // feed shows the synthetic answered line
    expect(q("[data-mission-feed]")!.textContent).toContain("D-1")
  })

  test("owner instruction round trip: input + Send -> host stores owner->controller instruction -> feed shows it", async () => {
    const e = EXPECT.research
    await show(e.id, e.title)
    const text = "Add the two regional vendors to the comparison"
    const input = q("[data-mission-input]") as HTMLInputElement
    input.value = `  ${text}  `
    input.dispatchEvent(new InputEvent("input", { bubbles: true }))
    await until(() => !(q("[data-mission-send]") as HTMLButtonElement).disabled, 3000, "send enabled")
    input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await until(() => (q("[data-mission-feed]")?.textContent ?? "").includes(text), 8000, "feed line")
    const host = await hostGet(e.id, ["messages"])
    const last = (host.messages as S[]).at(-1)!
    quote("host message after instruct", last)
    expect(last).toMatchObject({ from: "owner", to: "controller", kind: "instruction", text })
    expect((q("[data-mission-input]") as HTMLInputElement).value).toBe("")
    expect(prompts.at(-1)).toContain(text)
  })

  test("allow-list: the bridge client knows exactly the four tools; anything else is refused before a request", async () => {
    expect([...MISSION_CONTROL_TOOLS]).toEqual(["studio_mission_list", "studio_mission_get", "studio_mission_answer_decision", "studio_mission_update_row"])
    await expect(client.callTool("studio_mission_set_status", { mission: EXPECT.debug.id, to: "done" })).rejects.toMatchObject({ code: "TOOL_NOT_ALLOWED" })
    const host = await hostGet(EXPECT.debug.id, ["rows"])
    expect(host.mission.status).toBe("running")
    expect(JSON.stringify(document.body.innerHTML)).not.toContain(fx.token)
  })

  test("§4.2 timing: one list + one get through the bridge on the fixtures, and the live poll tick", async () => {
    const lists: number[] = []
    const gets: number[] = []
    const builds: number[] = []
    for (let i = 0; i < 20; i++) {
      for (const m of fx.missions) {
        let t0 = performance.now()
        const l = await missions.list({ directory: fx.project, sessions: [FX_SESSION] })
        lists.push(performance.now() - t0)
        expect(l.ok).toBe(true)
        t0 = performance.now()
        const g = await missions.get({ mission: m.id })
        gets.push(performance.now() - t0)
        expect(g.ok).toBe(true)
        t0 = performance.now()
        buildMission(g.data, "en", new Set())
        builds.push(performance.now() - t0)
      }
    }
    const stat = (xs: number[]) => {
      const s = xs.slice().sort((a, b) => a - b)
      const at = (p: number) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10
      return { n: s.length, min: at(0), median: at(0.5), p95: at(0.95), max: at(1) }
    }
    const pair = lists.map((l, i) => l + gets[i] + builds[i])
    // live ticks the app's poller made so far (list = negative entries, get = positive), from the mount
    const tickList = tickTimes.filter((x) => x < 0).map((x) => -x)
    const tickGet = tickTimes.filter((x) => x > 0)
    const timing = { list: stat(lists), get: stat(gets), buildMission: stat(builds), listPlusGet: stat(pair), pollerList: stat(tickList), pollerGet: stat(tickGet) }
    quote("§4.2 timing ms", timing)
    // §4.2 rule: a tick over 500 ms moves the live interval to 5 s; on these fixtures it must stay at 3 s.
    expect(timing.listPlusGet.p95).toBeLessThan(500)
  }, 60_000)

  test("polling stops while the window is hidden and resumes when visible (3 s live interval)", async () => {
    // visible + Agents view: at least one list within one interval
    let mark = calls.length
    await sleep(3400)
    const visibleLists = calls.slice(mark).filter((c) => c.channel === MISSION_CONTROL_IPC.list).length
    expect(visibleLists).toBeGreaterThanOrEqual(1)
    visibility = "hidden"
    document.dispatchEvent(new Event("visibilitychange"))
    await sleep(200) // let a read in flight finish
    mark = calls.length
    await sleep(7000) // two live intervals
    const hiddenCalls = calls.length - mark
    visibility = "visible"
    document.dispatchEvent(new Event("visibilitychange"))
    const back = calls.length
    await until(() => calls.length > back, 2000, "a read right after becoming visible")
    // map closed: stopped too
    setWatching(false)
    setMapOpen(false)
    await sleep(200)
    mark = calls.length
    await sleep(3400)
    const closedCalls = calls.length - mark
    setMapOpen(true)
    setWatching(true)
    quote("polling", { visibleListsIn3400ms: visibleLists, hiddenCallsIn7000ms: hiddenCalls, mapClosedCallsIn3400ms: closedCalls })
    expect(hiddenCalls).toBe(0)
    expect(closedCalls).toBe(0)
  }, 30_000)

  test("C145 fixed (row 136a): a remembered Agents filter in a one-agent session is kept while missions load", async () => {
    // The fallback effect of session.tsx (asserted below; row 136a waits for the first list), driven by the real createMissionControl on the
    // real host. One agent in the session (swarm.pulse().agents === 1), the map opens with the Agents filter remembered.
    const src = readFileSync(here("../../session.tsx"), "utf8")
    const effect = `sessionMap.view.filter === "agents" &&\n      agentsFilterFallsBack(swarm.pulse().agents, {\n        known: !missionControl.available || missionControl.state.listed,\n        count: missionControl.state.options.length,\n      })\n    )\n      sessionMap.setFilter("all")`
    expect(src).toContain(effect)
    const { createEffect, createRoot } = await import("solid-js")
    const [filter, setFilter] = createSignal<"agents" | "all">("agents")
    const history: Array<{ at: number; filter: string; options: number }> = []
    const t0 = performance.now()
    let control: S
    const stop = createRoot((done) => {
      control = createMissionControl({
        source: missionSourceOf({ missions })!,
        directory: () => fx.project,
        sessions: () => [FX_SESSION],
        lang: () => "en",
        watching: () => filter() === "agents",
        mapOpen: () => true,
      })
      createEffect(() => history.push({ at: Math.round(performance.now() - t0), filter: filter(), options: control.state.options.length }))
      createEffect(() => {
        if (filter() === "agents" && agentsFilterFallsBack(1, { known: control.available === false || control.state.listed, count: control.state.options.length }))
          setFilter("all")
      })
      return done
    })
    await until(() => control!.state.options.length === 4, 20_000, "missions listed in discover mode")
    const offered = offersAgentsView(1, control!.state.options.length)
    quote("C145 one-agent session", { history, filterAfterLoad: filter(), agentsViewOffered: offered })
    stop()
    // Fixed (row 136a): before the first list answered the filter stays on Agents, and it is still Agents once the
    // missions are known (the view is offered).
    expect(history[0]).toMatchObject({ filter: "agents", options: 0 })
    expect(history.find((h) => h.filter === "all")).toBeUndefined()
    expect(filter()).toBe("agents")
    expect(offered).toBe(true)
  }, 30_000)

  test("no outbound fetch by the host (no model call); the token never reached the DOM", () => {
    expect(hostErr).not.toContain("FETCH_CALLED")
    expect(hostErr).not.toContain("MUTATION_NOT_APPLIED")
    expect(document.body.innerHTML).not.toContain(fx.token)
    const errors = hostErr.split("\n").filter((l) => l.startsWith("HOST_ERROR"))
    quote("host error lines", errors.length)
  })
})
