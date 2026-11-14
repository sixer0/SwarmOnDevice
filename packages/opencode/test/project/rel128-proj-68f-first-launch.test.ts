// 1.2.8 row 68f (live re-check test/05_live_rc2.md lines 17 and F-3; decision C175).
//
// 68f: on a fresh profile's first launch the sidecar started before onboarding created the Default Project folder, so
// it was never told the root and every move was refused "Groups must be inside the Default Project." (the wrong cause).
// The sidecar is now told this launch's Default Project path whether or not the folder exists yet (desktop
// sidecar-env.ts), and the route looks at the folder when the person acts: a folder created after the server started
// is used without a restart; a missing folder and an unknown root each refuse with their own code.
// 68g: a project folder the server has loaded that is no longer on disk made every move fail with HTTP 500. Now an
// unrelated missing folder is skipped, and a missing folder the move needs (a listed session's folder) is a typed
// refusal naming the folder relatively; the tree, stores and journals stay as they were.
//
// HOME is a fresh temp folder (os.homedir stubbed); the real ~/Documents/Default Project is never touched.
// Run targeted: cd packages/opencode && bun test test/project/rel128-proj-68f-first-launch.test.ts

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
// The server first: its import graph settles the permission modules' load order (as in rel128-proj-i-rehome-refusals).
import { Server } from "../../src/server/server"
import { DesktopNonce } from "../../src/server/desktop-nonce"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"

const NONCE = "r68f-nonce-0123456789abcdefghijklmnopqrst"
const HEADER = "x-swarm-desktop-nonce"
const MISSION = "2026-09-02_lumen-release-checklist"
const GROUP = "Lumen"

const app = () => Server.Default().app
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex")

let home = ""
let homeSpy: ReturnType<typeof spyOn> | undefined
let documents = ""
let R = ""
let rootEnv: string | undefined
let case_ = 0

beforeAll(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rh68f-")))
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
const marker = (name: string) => JSON.stringify({ version: 1, name, kind: "product", created: 1787000000000 }) + "\n"

/** The Default Project as onboarding leaves it: one mission folder and one marked group. */
async function makeDefaultProject() {
  await fs.mkdir(path.join(R, "docs", MISSION, "report"), { recursive: true })
  await fs.writeFile(path.join(R, "docs", MISSION, "report", "report.md"), "# Checklist\n\n- one\n")
  await fs.mkdir(path.join(R, GROUP, ".swarm"), { recursive: true })
  await fs.writeFile(path.join(R, GROUP, ".swarm", "group.json"), marker(GROUP))
  await fs.writeFile(path.join(R, "swarm.json"), JSON.stringify({ formatter: false, lsp: false }))
}

beforeEach(async () => {
  case_ += 1
  documents = path.join(home, `case-${case_}`, "Documents")
  R = path.join(documents, "Default Project")
  await fs.mkdir(documents, { recursive: true })
  await fs.mkdir(memoryDir(), { recursive: true, mode: 0o700 })
  DesktopNonce.set(NONCE)
})
afterEach(async () => {
  DesktopNonce.set(undefined)
  await fs.rm(journalDir(), { recursive: true, force: true })
  await disposeAllInstances()
  await resetDatabase()
})

async function tree(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (folder: string) => {
    const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(folder, entry.name)
      const rel = path.relative(dir, full)
      if (entry.isDirectory()) {
        out.push(`D ${rel}`)
        await walk(full)
      } else out.push(`F ${rel} ${sha(await fs.readFile(full))}`)
    }
  }
  await walk(dir)
  return out
}

const snapshot = async () => ({
  tree: sha((await tree(path.dirname(documents))).join("\n")),
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

async function rehome(payload: Body, directory = documents) {
  const response = await app().request("/project/rehome", {
    method: "POST",
    headers: { "x-opencode-directory": directory, "content-type": "application/json", [HEADER]: NONCE },
    body: JSON.stringify(payload),
  })
  const text = await response.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, json }
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

/** Loads a server instance for `directory` (as the app polling a folder does). */
async function load(directory: string) {
  await app().request("/session", { headers: { "x-opencode-directory": directory } })
}

describe("68f first launch: the Default Project folder appears after the server started", () => {
  test("the folder is missing when the person acts: its own refusal, not 'Groups must be inside'; nothing written", async () => {
    // The sidecar knows this launch's path; onboarding has not made the folder yet.
    process.env.SWARM_DEFAULT_PROJECT_DIR = R
    const before = await snapshot()
    const result = await rehome(body({ dryRun: true }))
    expect(`${result.status} ${result.json?.data?.code} ${result.json?.data?.detail}`).toBe(
      "409 REHOME_FOLDER_MISSING Default Project",
    )
    expect(result.json?.data?.message).not.toContain("Groups must")
    expect(JSON.stringify(result.json)).not.toContain(home)
    expect(await snapshot()).toEqual(before)
    expect(before.journals).toEqual([])
  })

  test("onboarding then creates the folder: the same server moves the mission, no restart", async () => {
    process.env.SWARM_DEFAULT_PROJECT_DIR = R
    const early = await rehome(body({ dryRun: true }))
    expect(early.status).toBe(409)
    await makeDefaultProject()
    const session = await createSession(R)
    const dry = await rehome(body({ sessions: [session.id], dryRun: true }), R)
    expect(`${dry.status} ${JSON.stringify(dry.json)}`).toBe(
      `200 ${JSON.stringify({ planned: { folder: true, notes: 0, sessions: 1, createsGroup: false } })}`,
    )
    const moved = await rehome(body({ sessions: [session.id] }), R)
    expect(`${moved.status} ${JSON.stringify(moved.json?.moved)}`).toBe(
      `200 ${JSON.stringify({ folder: true, notes: 0, sessions: 1 })}`,
    )
    expect(await fs.readdir(path.join(R, GROUP, "docs", MISSION, "report"))).toEqual(["report.md"])
  })

  test("no Default Project known at all: REHOME_ROOT_UNKNOWN with a message saying so; nothing written", async () => {
    delete process.env.SWARM_DEFAULT_PROJECT_DIR
    await makeDefaultProject()
    const before = await snapshot()
    const result = await rehome(body(), R)
    expect(`${result.status} ${result.json?.data?.code}`).toBe("409 REHOME_ROOT_UNKNOWN")
    expect(result.json?.data?.message).toContain("Default Project")
    expect(result.json?.data?.message).not.toContain("Groups must")
    expect(await snapshot()).toEqual(before)
    expect(before.journals).toEqual([])
  })
})

describe("68g a loaded folder that is no longer on disk", () => {
  test("an unrelated loaded folder was removed: the move still works (no HTTP 500)", async () => {
    process.env.SWARM_DEFAULT_PROJECT_DIR = R
    await makeDefaultProject()
    // As in the live run: the app polled R/Kampus before it existed, so the server loaded an instance for it.
    const kampus = path.join(R, "Kampus")
    await load(kampus)
    // And a folder that existed when loaded and was deleted later.
    const gone = path.join(R, "Gone")
    await fs.mkdir(gone)
    await load(gone)
    await fs.rm(gone, { recursive: true })
    const dry = await rehome(body({ dryRun: true }), R)
    expect(`${dry.status} ${JSON.stringify(dry.json)}`).toBe(
      `200 ${JSON.stringify({ planned: { folder: true, notes: 0, sessions: 0, createsGroup: false } })}`,
    )
    const moved = await rehome(body(), R)
    expect(`${moved.status} ${JSON.stringify(moved.json?.moved)}`).toBe(
      `200 ${JSON.stringify({ folder: true, notes: 0, sessions: 0 })}`,
    )
  })

  test("a listed session's folder was removed: REHOME_FOLDER_MISSING naming it relatively; nothing changed", async () => {
    process.env.SWARM_DEFAULT_PROJECT_DIR = R
    await makeDefaultProject()
    const kampus = path.join(R, "Kampus")
    await fs.mkdir(kampus)
    const session = await createSession(kampus)
    await fs.rm(kampus, { recursive: true })
    const before = await snapshot()
    for (const dryRun of [true, false]) {
      const result = await rehome(body({ sessions: [session.id], dryRun }), R)
      expect(`${dryRun} ${result.status} ${result.json?.data?.code} ${result.json?.data?.detail}`).toBe(
        `${dryRun} 409 REHOME_FOLDER_MISSING Kampus`,
      )
      expect(JSON.stringify(result.json)).not.toContain(home)
    }
    expect(await snapshot()).toEqual(before)
    expect(before.journals).toEqual([])
  })
})
