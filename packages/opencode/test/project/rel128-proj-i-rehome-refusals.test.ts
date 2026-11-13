// 1.2.8 row 44b, AC-PROJi (N8-365; 01d section 6.1-6.2 and 9; SR8-17, SR8-18 a): `POST /project/rehome` is person-only
// (desktop nonce, PERSON_ONLY_ROUTES) and every refusal leaves the Default Project tree, the memory stores and the
// journal folder exactly as they were. One case per refusal code, one per SR8-17 character class, the unmarked target
// of SR8-18(a); then the wired route moving a mission (project.rehomed published, session re-pointed) and the start-time
// recovery of an interrupted move. Red at BASE e1f9673772: the route is absent and personOnlyRoute(/project/rehome) is
// false.
//
// HOME is a fresh temp folder (os.homedir stubbed); the real ~/Documents/Default Project is never touched.
// Run targeted: cd packages/opencode && bun test test/project/rel128-proj-i-rehome-refusals.test.ts

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
// The server first: its import graph settles the permission modules' load order (as in rel128-sk-d-skill-routes).
import { Server } from "../../src/server/server"
import { DesktopNonce } from "../../src/server/desktop-nonce"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"

const NONCE = "pri-nonce-0123456789abcdefghijklmnopqrstu"
const OTHER = "pri-other-0123456789abcdefghijklmnopqrstu"
const HEADER = "x-swarm-desktop-nonce"
const MISSION = "2026-09-02_lumen-release-checklist"
const GROUP = "Lumen"
const PACKAGE = path.join(import.meta.dir, "../..")

const app = () => Server.Default().app
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex")

let home = ""
let homeSpy: ReturnType<typeof spyOn> | undefined
let R = ""
let elsewhere = ""
let rootEnv: string | undefined
let case_ = 0

beforeAll(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rh44b-")))
  homeSpy = spyOn(os, "homedir").mockReturnValue(home)
  rootEnv = process.env.SWARM_DEFAULT_PROJECT_DIR
})
afterAll(async () => {
  homeSpy?.mockRestore()
  if (rootEnv === undefined) delete process.env.SWARM_DEFAULT_PROJECT_DIR
  else process.env.SWARM_DEFAULT_PROJECT_DIR = rootEnv
  await fs.rm(home, { recursive: true, force: true })
})

const journalDir = () => path.join(Global.Path.data, "rehome")
const memoryDir = () => path.join(Global.Path.data, "memory")
// The store file of a folder outside git (the BASE `file()` formula, pinned equal to Memory.storeKey by N8-364).
const storeOf = (dir: string) => path.join(memoryDir(), `dir-${sha(dir).slice(0, 24)}.json`)

const marker = (name: string, kind = "product") =>
  JSON.stringify({ version: 1, name, kind, created: 1787000000000 }) + "\n"

/** A throwaway Default Project: one mission folder, one marked group, one unmarked folder, a store with two notes. */
beforeEach(async () => {
  case_ += 1
  R = path.join(home, `case-${case_}`, "Documents", "Default Project")
  elsewhere = path.join(home, `case-${case_}`, "elsewhere")
  await fs.mkdir(path.join(R, "docs", MISSION, "report"), { recursive: true })
  await fs.writeFile(path.join(R, "docs", MISSION, "report", "report.md"), "# Checklist\n\n- one\n")
  await fs.mkdir(path.join(R, GROUP, ".swarm"), { recursive: true })
  await fs.writeFile(path.join(R, GROUP, ".swarm", "group.json"), marker(GROUP))
  await fs.mkdir(path.join(R, "Arsip Lama"), { recursive: true })
  await fs.writeFile(path.join(R, "Arsip Lama", "README.md"), "old\n")
  await fs.writeFile(path.join(R, "swarm.json"), JSON.stringify({ formatter: false, lsp: false }))
  await fs.mkdir(elsewhere, { recursive: true })
  await fs.writeFile(path.join(elsewhere, "outside.md"), "outside\n")
  await fs.mkdir(memoryDir(), { recursive: true, mode: 0o700 })
  await fs.writeFile(
    storeOf(R),
    JSON.stringify(
      {
        version: 2,
        enabled: true,
        items: [
          {
            id: "a1b2c3",
            text: "Release checklist lives in the mission report",
            source: "agent",
            deviceOnly: false,
            time: 1787000000000,
            refs: [{ path: `docs/${MISSION}/report/report.md` }],
          },
          {
            id: "0a0b0c",
            text: "Old archive notes are in Arsip Lama",
            source: "user",
            deviceOnly: false,
            time: 1787000002000,
            refs: [{ path: "Arsip Lama/README.md" }],
          },
        ],
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  )
  process.env.SWARM_DEFAULT_PROJECT_DIR = R
  DesktopNonce.set(NONCE)
})
afterEach(async () => {
  DesktopNonce.set(undefined)
  // A completed move's journal (wiring case) must not count as "a journal written" by the next refusal case.
  await fs.rm(journalDir(), { recursive: true, force: true })
  await disposeAllInstances()
  await resetDatabase()
})

/** Every path under `dir` with its kind and content hash (files) or link target; mode bits of files too. */
async function tree(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (folder: string) => {
    const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(folder, entry.name)
      const rel = path.relative(dir, full)
      if (entry.isSymbolicLink()) out.push(`L ${rel} -> ${await fs.readlink(full)}`)
      else if (entry.isDirectory()) {
        out.push(`D ${rel}`)
        await walk(full)
      } else out.push(`F ${rel} ${sha(await fs.readFile(full))}`)
    }
  }
  await walk(dir)
  return out
}

/** The person's disk as the route could change it: R (with its parent), the memory stores, the journal folder. */
const snapshot = async () => ({
  tree: sha((await tree(path.dirname(path.dirname(R)))).join("\n")),
  stores: sha((await tree(memoryDir())).join("\n")),
  journals: await fs.readdir(journalDir()).catch(() => [] as string[]),
})

type Body = Record<string, unknown>
const body = (over: Body = {}): Body => ({
  missionId: MISSION,
  from: R,
  to: path.join(R, GROUP),
  sessions: [],
  approvalRef: "D-1",
  ...over,
})

async function rehome(payload: Body, options: { nonce?: string | null } = {}) {
  const headers: Record<string, string> = { "x-opencode-directory": R, "content-type": "application/json" }
  if (options.nonce !== null) headers[HEADER] = options.nonce ?? NONCE
  const response = await app().request("/project/rehome", { method: "POST", headers, body: JSON.stringify(payload) })
  const text = await response.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, text, json }
}

/** The call is refused with `code` and the disk is byte-for-byte what it was, with no journal written. */
async function refused(payload: Body, code: string, options: { nonce?: string | null } = {}) {
  const before = await snapshot()
  const result = await rehome(payload, options)
  expect(`${result.status} ${result.json?.data?.code}`).toBe(`409 ${code}`)
  expect(await snapshot()).toEqual(before)
  expect(before.journals).toEqual([])
  return result
}

async function createSession(directory: string) {
  const response = await app().request("/session", {
    method: "POST",
    headers: { "x-opencode-directory": directory, "content-type": "application/json" },
    body: JSON.stringify({}),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as { id: string; directory: string }
}

describe("AC-PROJi person proof", () => {
  test("no nonce, a wrong nonce, and a server holding none: 403, disk unchanged, no journal", async () => {
    const before = await snapshot()
    for (const nonce of [null, OTHER] as const) {
      const result = await rehome(body(), { nonce })
      expect(`${nonce} ${result.status} ${result.json?.name}`).toBe(`${nonce} 403 RehomeForbiddenError`)
    }
    DesktopNonce.set(undefined)
    const unheld = await rehome(body(), { nonce: NONCE })
    expect(`${unheld.status} ${unheld.json?.name}`).toBe("403 RehomeForbiddenError")
    expect(await snapshot()).toEqual(before)
    expect(before.journals).toEqual([])
  })

  test("the route is in PERSON_ONLY_ROUTES for any method (an agent's call is refused before the server)", () => {
    for (const method of ["POST", "GET", "PUT", "PATCH", "DELETE"])
      expect(`${method} ${AutonomyTable.personOnlyRoute({ method, path: "/project/rehome" })}`).toBe(`${method} true`)
  })
})

describe("AC-PROJi refusals: one per code, tree + store hash unchanged, no journal", () => {
  test("REHOME_OUTSIDE_ROOT: no Default Project root set", async () => {
    delete process.env.SWARM_DEFAULT_PROJECT_DIR
    await refused(body(), "REHOME_OUTSIDE_ROOT")
  })

  test("REHOME_OUTSIDE_ROOT: to = R/../x, R/a/b, R itself, R/Docs", async () => {
    await refused(body({ to: `${R}/../x` }), "REHOME_OUTSIDE_ROOT")
    await refused(body({ to: path.join(R, "a", "b"), groupKind: "product" }), "REHOME_OUTSIDE_ROOT")
    await refused(body({ to: R }), "REHOME_OUTSIDE_ROOT")
    await refused(body({ to: path.join(R, "Docs"), groupKind: "product" }), "REHOME_OUTSIDE_ROOT")
  })

  test("REHOME_OUTSIDE_ROOT: from is not R (another folder; a group, i.e. group-to-group, not in 1.2.8)", async () => {
    await refused(body({ from: elsewhere }), "REHOME_OUTSIDE_ROOT")
    await fs.mkdir(path.join(R, "Other", ".swarm"), { recursive: true })
    await fs.writeFile(path.join(R, "Other", ".swarm", "group.json"), marker("Other"))
    await refused(body({ from: path.join(R, GROUP), to: path.join(R, "Other") }), "REHOME_OUTSIDE_ROOT")
  })

  test("SR8-17: one refused group name per class (bidi, isolate, zero width, line and paragraph separator, edges, dot)", async () => {
    for (const name of [
      "Lu‮men",
      "Lu⁦men",
      "Lu​men",
      "Lu men",
      "Lu men",
      " Lumen2",
      "Lumen2 ",
      "Lumen2.",
    ])
      await refused(body({ to: path.join(R, name), groupKind: "product" }), "REHOME_OUTSIDE_ROOT")
  })

  test("REHOME_SYMLINK: a symlinked `to`, and a link inside the mission folder pointing out", async () => {
    await fs.symlink(elsewhere, path.join(R, "Linked"))
    await refused(body({ to: path.join(R, "Linked") }), "REHOME_SYMLINK")
    await fs.symlink(path.join(elsewhere, "outside.md"), path.join(R, "docs", MISSION, "out.md"))
    await refused(body(), "REHOME_SYMLINK")
  })

  test("REHOME_TARGET_EXISTS: the mission is already in the group; SR8-18(a) an existing unmarked `to`", async () => {
    await refused(body({ to: path.join(R, "Arsip Lama") }), "REHOME_TARGET_EXISTS")
    await fs.mkdir(path.join(R, GROUP, "docs", MISSION), { recursive: true })
    await refused(body(), "REHOME_TARGET_EXISTS")
  })

  test("REHOME_SOURCE_MISSING: `from` is gone", async () => {
    const gone = path.join(path.dirname(R), "Gone Project")
    await refused(body({ from: gone }), "REHOME_SOURCE_MISSING")
  })

  test("REHOME_APPROVAL_MISSING: no approvalRef, a malformed one, a bad mission id, a new group without its kind", async () => {
    const { approvalRef: _drop, ...without } = body()
    await refused(without, "REHOME_APPROVAL_MISSING")
    await refused(body({ approvalRef: "D-x" }), "REHOME_APPROVAL_MISSING")
    await refused(body({ missionId: "../escape" }), "REHOME_APPROVAL_MISSING")
    await refused(body({ to: path.join(R, "Fresh") }), "REHOME_APPROVAL_MISSING")
    await refused(body({ to: path.join(R, "Fresh"), groupKind: "anything" }), "REHOME_APPROVAL_MISSING")
  })

  test("REHOME_BUSY: another move holds the lock", async () => {
    const lease = await Flock.acquire("rehome")
    try {
      await refused(body(), "REHOME_BUSY")
    } finally {
      await lease.release()
    }
  })

  test("REHOME_SESSION_ACTIVE: an unknown session, a session of another folder", async () => {
    await refused(body({ sessions: ["ses_missing0000000000000000"] }), "REHOME_SESSION_ACTIVE")
    const other = await createSession(elsewhere)
    await refused(body({ sessions: [other.id] }), "REHOME_SESSION_ACTIVE")
  })
})

describe("AC-PROJi wiring: the route moves through the real services", () => {
  test("dryRun answers the plan and writes nothing", async () => {
    const before = await snapshot()
    const result = await rehome(body({ dryRun: true }))
    expect(result.status).toBe(200)
    expect(result.json).toEqual({ planned: { folder: true, notes: 1, sessions: 0, createsGroup: false } })
    expect(await snapshot()).toEqual(before)
  })

  test("a move: folder, note and session follow; project.rehomed published; the same call again is a replay", async () => {
    const session = await createSession(R)
    const events: GlobalEvent[] = []
    const listen = (event: GlobalEvent) => {
      if (event.payload?.type === "project.rehomed") events.push(event)
    }
    GlobalBus.on("event", listen)
    try {
      const result = await rehome(body({ sessions: [session.id] }))
      expect(result.status).toBe(200)
      expect(result.json.moved).toEqual({ folder: true, notes: 1, sessions: 1 })
      const journalId = result.json.journalId as string
      expect(journalId).toMatch(/^rh-\d+-[0-9a-f]{8}$/)
      expect(await fs.readdir(path.join(R, GROUP, "docs", MISSION, "report"))).toEqual(["report.md"])
      expect(await fs.lstat(path.join(R, "docs", MISSION)).catch(() => undefined)).toBeUndefined()
      const journal = JSON.parse(await fs.readFile(path.join(journalDir(), `${journalId}.json`), "utf8"))
      expect(journal.state).toBe("complete")
      const moved = (await (
        await app().request(`/session/${session.id}`, { headers: { "x-opencode-directory": R } })
      ).json()) as { directory: string }
      expect(moved.directory).toBe(path.join(R, GROUP))
      expect(events.map((event) => event.payload.properties)).toEqual([
        { missionId: MISSION, from: R, to: path.join(R, GROUP), sessions: [session.id], journalId },
      ])
      const again = await rehome(body({ sessions: [session.id] }))
      expect(again.json).toEqual({ journalId, moved: { folder: true, notes: 1, sessions: 1 }, replayed: true })
    } finally {
      GlobalBus.off("event", listen)
    }
  })

  test("server start rolls back a move a crash left running (Rehome.recover in the server layer)", async () => {
    // A fresh server process with its own data folder: the layer runs once per process.
    const data = path.join(home, `case-${case_}`, "xdg")
    const share = path.join(data, "share")
    const swarmData = path.join(share, "swarm")
    const created = path.join(R, "Fresh")
    await fs.mkdir(created)
    const journalId = "rh-1787000000000-0a1b2c3d"
    const journal = {
      version: 1,
      journalId,
      missionId: MISSION,
      from: R,
      to: created,
      approvalRef: "D-1",
      state: "running",
      steps: [{ name: "group", status: "done", data: { created } }],
      root: R,
      stores: { from: "a", to: "b" },
      sessions: [],
    }
    await fs.mkdir(path.join(swarmData, "rehome"), { recursive: true, mode: 0o700 })
    await fs.writeFile(path.join(swarmData, "rehome", `${journalId}.json`), JSON.stringify(journal), { mode: 0o600 })
    const script = [
      `const { Server } = await import(${JSON.stringify(path.join(PACKAGE, "src/server/server.ts"))})`,
      `await Server.Default().app.request("/global/health")`,
      `const file = ${JSON.stringify(path.join(swarmData, "rehome", `${journalId}.json`))}`,
      `for (let i = 0; i < 100; i++) {`,
      `  const state = JSON.parse(await Bun.file(file).text()).state`,
      `  if (state !== "running") { console.log("STATE=" + state); process.exit(0) }`,
      `  await Bun.sleep(100)`,
      `}`,
      `console.log("STATE=running"); process.exit(0)`,
    ].join("\n")
    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd: PACKAGE,
      env: {
        ...process.env,
        HOME: home,
        XDG_DATA_HOME: share,
        XDG_CACHE_HOME: path.join(data, "cache"),
        XDG_CONFIG_HOME: path.join(data, "config"),
        XDG_STATE_HOME: path.join(data, "state"),
        SWARM_DEFAULT_PROJECT_DIR: R,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    expect(out).toContain("STATE=rolled_back")
    expect(await fs.lstat(created).catch(() => undefined)).toBeUndefined()
  }, 60000)
})
