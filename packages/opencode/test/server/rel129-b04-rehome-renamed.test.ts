// 1.2.9 row 43, AC-B04 (N9-120, N9-065; 01b AT-B04): the re-home primitive reports `moved.renamed` (old note id ->
// new id when the target store already used the id, rehome.ts journal.moved), but the route's success schema
// `ProjectRehomeMoved` declared only folder/notes/sessions. (a) The wired route answers the same `moved` the journal
// holds, `renamed` included. (b) The committed openapi.json declares `moved.renamed` as an optional string-to-string
// object. (c) The generated SDK type carries it as optional. (d) The `swarm/*` branch count is unchanged (C131).
// Red at BASE d4282fcfd8: (b) and (c) fail; (a) fails when the encoder drops the undeclared key (H-B04).
//
// HOME is a fresh temp folder (os.homedir stubbed); the fixture is synthetic (syn129); the real Default Project and
// memory stores are never touched. Run: cd packages/opencode && bun test test/server/rel129-b04-rehome-renamed.test.ts

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
// The server first: its import graph settles the permission modules' load order (as in rel128-proj-i-rehome-refusals).
import { Server } from "../../src/server/server"
import { DesktopNonce } from "../../src/server/desktop-nonce"
import { setRehomeDecisionForTests } from "../../src/server/routes/instance/httpapi/handlers/project"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"

const NONCE = "syn129-nonce-0123456789abcdefghijklmnopqr"
const HEADER = "x-swarm-desktop-nonce"
const MISSION = "2026-09-02_syn129-lumen-checklist"
const GROUP = "Lumen"
const COLLIDING = "a1b2c3"
const REPO = path.join(import.meta.dir, "../../../..")
const SPEC = path.join(REPO, "packages/sdk/openapi.json")
const TYPES = path.join(REPO, "packages/sdk/js/src/v2/gen/types.gen.ts")

const app = () => Server.Default().app
const sha = (data: string) => createHash("sha256").update(data).digest("hex")
const branchCount = () =>
  spawnSync("git", ["branch", "--list", "swarm/*"], { cwd: REPO, encoding: "utf8" })
    .stdout.split("\n")
    .filter((line) => line.trim()).length

let home = ""
let homeSpy: ReturnType<typeof spyOn> | undefined
let rootEnv: string | undefined
let R = ""
let case_ = 0
let branchesBefore = -1

beforeAll(async () => {
  branchesBefore = branchCount()
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rh129b04-")))
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
// The store file of a folder outside git (Memory.storeKey for a non-git folder, as rel128-proj-i-rehome-refusals).
const storeOf = (dir: string) => path.join(memoryDir(), `dir-${sha(dir).slice(0, 24)}.json`)
const writeStore = (dir: string, items: unknown[]) =>
  fs.writeFile(storeOf(dir), JSON.stringify({ version: 2, enabled: true, items }, null, 2) + "\n", { mode: 0o600 })

/** A throwaway Default Project: one mission, one marked group whose store already holds the mission note's id. */
beforeEach(async () => {
  case_ += 1
  R = path.join(home, `case-${case_}`, "Documents", "Default Project")
  await fs.mkdir(path.join(R, "docs", MISSION, "report"), { recursive: true })
  await fs.writeFile(path.join(R, "docs", MISSION, "report", "report.md"), "# Checklist\n\n- one\n")
  await fs.mkdir(path.join(R, GROUP, ".swarm"), { recursive: true })
  await fs.writeFile(
    path.join(R, GROUP, ".swarm", "group.json"),
    JSON.stringify({ version: 1, name: GROUP, kind: "product", created: 1787000000000 }) + "\n",
  )
  await fs.writeFile(path.join(R, "swarm.json"), JSON.stringify({ formatter: false, lsp: false }))
  await fs.mkdir(memoryDir(), { recursive: true, mode: 0o700 })
  await writeStore(R, [
    {
      id: COLLIDING,
      text: "syn129 checklist lives in the mission report",
      source: "agent",
      deviceOnly: false,
      time: 1787000000000,
      refs: [{ path: `docs/${MISSION}/report/report.md` }],
    },
  ])
  await writeStore(path.join(R, GROUP), [
    { id: COLLIDING, text: "syn129 a note the group already had", source: "user", deviceOnly: false, time: 1 },
  ])
  process.env.SWARM_DEFAULT_PROJECT_DIR = R
  DesktopNonce.set(NONCE)
  // 1.2.9 row 54 (AC-C06 INTENT, C13): the person's attested placement answer of MISSION into GROUP, through the route's
  // test seam, so the real move below gets past the decision check.
  setRehomeDecisionForTests(async () => ({
    status: "answered",
    topic: "project-placement",
    option: "join",
    by: "user",
    attested: true,
    group: GROUP,
    proposal: undefined,
  }))
})
afterEach(async () => {
  DesktopNonce.set(undefined)
  setRehomeDecisionForTests(undefined)
  await fs.rm(journalDir(), { recursive: true, force: true })
  await disposeAllInstances()
  await resetDatabase()
})

describe("AC-B04 moved.renamed on the rehome route, openapi and SDK", () => {
  test("(a) the route answers the journal's moved, renamed included", async () => {
    const response = await app().request("/project/rehome", {
      method: "POST",
      headers: { "x-opencode-directory": R, "content-type": "application/json", [HEADER]: NONCE },
      body: JSON.stringify({
        missionId: MISSION,
        from: R,
        to: path.join(R, GROUP),
        sessions: [],
        approvalRef: "D-1",
        approvalMission: MISSION,
      }),
    })
    const json = (await response.json()) as { journalId: string; moved: Record<string, unknown> }
    expect(response.status).toBe(200)
    const journal = JSON.parse(await fs.readFile(path.join(journalDir(), `${json.journalId}.json`), "utf8")) as {
      moved: { renamed?: Record<string, string> }
    }
    // Anti-vacuity: the primitive did produce a rename for the colliding id.
    expect(Object.keys(journal.moved.renamed ?? {})).toEqual([COLLIDING])
    const fresh = journal.moved.renamed![COLLIDING]!
    expect(fresh).toMatch(/^[0-9a-f]{6}$/)
    expect(fresh).not.toBe(COLLIDING)
    expect(json.moved).toEqual(journal.moved)
    expect(json.moved.renamed).toEqual({ [COLLIDING]: fresh })
  })

  test("(b) openapi.json: ProjectRehomeMoved.moved.renamed is an optional string-to-string object", () => {
    const spec = JSON.parse(readFileSync(SPEC, "utf8"))
    const moved = spec.components.schemas.ProjectRehomeMoved.properties.moved
    const renamed = moved.properties.renamed
    expect(renamed?.type).toBe("object")
    expect(renamed?.additionalProperties).toMatchObject({ type: "string" })
    expect(moved.required).not.toContain("renamed")
    expect(moved.required).toEqual(expect.arrayContaining(["folder", "notes", "sessions"]))
  })

  test("(c) types.gen.ts: ProjectRehomeMoved.moved has an optional renamed of string to string", () => {
    const source = readFileSync(TYPES, "utf8")
    const start = source.indexOf("export type ProjectRehomeMoved = {")
    expect(start).toBeGreaterThan(-1)
    const block = source.slice(start, source.indexOf("\n}\n", start))
    expect(block).toMatch(/\n {4}renamed\?: \{\n {6}\[key: string\]: string\n {4}\}\n/)
  })

  test("(d) the swarm/* branch count is unchanged (C131)", () => {
    expect(branchesBefore).toBeGreaterThan(0)
    expect(branchCount()).toBe(branchesBefore)
  })
})
