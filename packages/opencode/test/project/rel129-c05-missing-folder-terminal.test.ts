// 1.2.9 row 53 (AC-C05, N9-132; spec 01c section 3.5, register N9-009 / N9-069).
//
// A terminal opened from folder X with its cwd inside the mission folder blocks a move (REHOME_SESSION_ACTIVE). In
// 1.2.8 (row 68g) a loaded folder that was no longer on disk was skipped entirely, so removing X let the move run with
// that terminal still inside the mission folder. Now a missing folder's terminals are listed when its services are
// already built (`RcMap.has`), services are never built for a missing folder, and a listing failure fails closed with
// the path-free detail "terminal check unavailable".
//
// Route case: fixture N9-157 (`missingFolderTerminalLayout`, syn129) under a fresh HOME (os.homedir stubbed); the real
// ~/Documents is never touched. Seam cases call `runningTerminalCwds` (N9-069) with a fake scan.
// Run targeted: cd packages/opencode && bun test test/project/rel129-c05-missing-folder-terminal.test.ts

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
// The server first: its import graph settles the permission modules' load order (as in rel128-proj-68f-first-launch).
import { Server } from "../../src/server/server"
import { DesktopNonce } from "../../src/server/desktop-nonce"
import { Rehome } from "../../src/project/rehome"
// Namespace import: at BASE the seam does not exist, and the route case must still run and show the defect.
import * as ProjectHandlers from "../../src/server/routes/instance/httpapi/handlers/project"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"
import { missingFolderTerminalLayout } from "../fixture/syn129-layouts"

const NONCE = "r129c05-nonce-0123456789abcdefghijklmnop"
const HEADER = "x-swarm-desktop-nonce"
const UNAVAILABLE = "terminal check unavailable"

const app = () => Server.Default().app
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex")

// 1.2.9 row 54 (AC-C06 INTENT, 01c AC-C05 "a bound fake decision (section 3.6)"): a real move needs the person's answer
// bound to it; this fake is the attested placement answer of the mission itself into the group `to`.
const bound = (to: string): Rehome.DecisionRead => ({
  status: "answered",
  topic: "project-placement",
  option: "join",
  by: "user",
  attested: true,
  group: path.basename(to),
  proposal: undefined,
})

let home = ""
let homeSpy: ReturnType<typeof spyOn> | undefined
let rootEnv: string | undefined
const pids: number[] = []

beforeAll(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rh129c05-")))
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

beforeEach(async () => {
  await fs.mkdir(memoryDir(), { recursive: true, mode: 0o700 })
  DesktopNonce.set(NONCE)
})
afterEach(async () => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
  DesktopNonce.set(undefined)
  ProjectHandlers.setRehomeDecisionForTests(undefined)
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
      } else if (entry.isSymbolicLink()) out.push(`L ${rel}`)
      else out.push(`F ${rel} ${sha(await fs.readFile(full))}`)
    }
  }
  await walk(dir)
  return out
}

async function rehome(payload: Record<string, unknown>, directory: string) {
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

/** Starts a running terminal from `directory` (the folder the app had open) with its cwd at `cwd`. */
async function openTerminal(directory: string, cwd: string) {
  const response = await app().request("/pty", {
    method: "POST",
    headers: { "x-opencode-directory": directory, "content-type": "application/json" },
    body: JSON.stringify({ command: "/bin/sh", args: ["-c", "sleep 30"], cwd, title: "syn129 c05" }),
  })
  expect(response.status).toBe(200)
  const info = (await response.json()) as { id: string; cwd: string; status: string; pid: number }
  pids.push(info.pid)
  expect(`${info.status} ${info.cwd}`).toBe(`running ${cwd}`)
  return info
}

describe("C05 route: a running terminal of a removed loaded folder sits in the mission folder", () => {
  test("the move is refused REHOME_SESSION_ACTIVE (real move and dry run); nothing moved, no journal", async () => {
    await using layout = await missingFolderTerminalLayout({ parent: home, git: true })
    process.env.SWARM_DEFAULT_PROJECT_DIR = layout.defaultProject
    const R = layout.defaultProject
    const to = layout.groupDir
    ProjectHandlers.setRehomeDecisionForTests(async () => bound(to))
    await openTerminal(layout.loaded, layout.ptyCwd)
    await layout.removeLoaded()
    expect(await fs.stat(layout.loaded).then(() => true, () => false)).toBe(false)
    // R loaded first, as the app has it open: loading a git folder records its project id in `.git/swarm`.
    await app().request("/session", { headers: { "x-opencode-directory": R } })

    const before = { R: sha((await tree(R)).join("\n")), to: sha((await tree(to)).join("\n")) }
    const payload = {
      missionId: layout.mission,
      from: R,
      to,
      sessions: [],
      approvalRef: "D-1",
      approvalMission: layout.mission,
    }
    for (const dryRun of [false, true]) {
      const result = await rehome({ ...payload, dryRun }, R)
      expect(`${dryRun} ${result.status} ${result.json?.data?.code} ${result.json?.data?.detail}`).toBe(
        `${dryRun} 409 REHOME_SESSION_ACTIVE terminal inside the mission folder`,
      )
      expect(JSON.stringify(result.json)).not.toContain(home)
    }
    expect({ R: sha((await tree(R)).join("\n")), to: sha((await tree(to)).join("\n")) }).toEqual(before)
    expect(await fs.readdir(path.join(R, "docs", layout.mission, "report"))).toEqual(["report.md"])
    expect(await fs.readdir(journalDir()).catch(() => [] as string[])).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Seam cases on N9-069.

type Info = { status: "running" | "exited"; cwd: string }
type Scan = {
  loaded(): Promise<readonly string[]>
  exists(dir: string): Promise<boolean>
  built(dir: string): Promise<boolean>
  list(dir: string): Promise<readonly Info[] | undefined>
}
const seam = () =>
  (ProjectHandlers as unknown as { runningTerminalCwds: (scan: Scan) => Promise<string[]> }).runningTerminalCwds

function fakeScan(over: Partial<Scan> & { missing?: string[]; builtDirs?: string[] } = {}) {
  const calls = { built: [] as string[], list: [] as string[] }
  const scan: Scan = {
    loaded: over.loaded ?? (async () => ["/syn129/X", "/syn129/Y"]),
    exists: over.exists ?? (async (dir) => !(over.missing ?? []).includes(dir)),
    built: async (dir) => {
      calls.built.push(dir)
      return over.built ? over.built(dir) : (over.builtDirs ?? []).includes(dir)
    },
    list: async (dir) => {
      calls.list.push(dir)
      if (over.list) return over.list(dir)
      return [
        { status: "running", cwd: `${dir}-run` },
        { status: "exited", cwd: `${dir}-done` },
      ]
    },
  }
  return { scan, calls }
}

describe("C05 seam runningTerminalCwds (N9-069)", () => {
  test("missing folder with built services: its running terminals are listed", async () => {
    const { scan, calls } = fakeScan({ missing: ["/syn129/X"], builtDirs: ["/syn129/X"] })
    expect(await seam()(scan)).toEqual(["/syn129/X-run", "/syn129/Y-run"])
    expect(calls.built).toEqual(["/syn129/X"])
    expect(calls.list).toEqual(["/syn129/X", "/syn129/Y"])
  })

  test("missing folder without built services: nothing listed and list is never called for it (no build)", async () => {
    const { scan, calls } = fakeScan({ missing: ["/syn129/X"], builtDirs: [] })
    expect(await seam()(scan)).toEqual(["/syn129/Y-run"])
    expect(calls.built).toEqual(["/syn129/X"])
    expect(calls.list.filter((dir) => dir === "/syn129/X").length).toBe(0)
  })

  test("missing folder with built services, listing throws or fails: fails closed with N9-009", async () => {
    for (const list of [
      async () => {
        throw new Error("evicted between has and get")
      },
      async () => undefined,
    ]) {
      const { scan } = fakeScan({ missing: ["/syn129/X"], builtDirs: ["/syn129/X"], list })
      const error = await seam()(scan).then(
        () => undefined,
        (e: unknown) => e as { code?: string; detail?: string; message?: string },
      )
      expect(`${error?.code} ${error?.detail}`).toBe(`REHOME_SESSION_ACTIVE ${UNAVAILABLE}`)
      expect(error?.message ?? "").not.toContain("/syn129")
    }
  })

  test("existing folders: today's behaviour (built never asked, a failed listing counts as none)", async () => {
    const { scan, calls } = fakeScan({
      list: async (dir) => (dir === "/syn129/X" ? undefined : [{ status: "running", cwd: `${dir}-run` }]),
    })
    expect(await seam()(scan)).toEqual(["/syn129/Y-run"])
    expect(calls.built).toEqual([])
  })

  test("a fail-closed listing reaches the move as a refusal, not an HTTP 500; nothing moved, no journal", async () => {
    await using layout = await missingFolderTerminalLayout({ parent: home })
    const dataDir = path.join(layout.root, "data")
    const ports: Rehome.Ports = {
      root: layout.defaultProject,
      dataDir,
      session: async () => undefined,
      projectId: async () => "syn129-project",
      moveSession: async () => {
        throw new Error("no session moves in this case")
      },
      // 1.2.9 row 54 (AC-C06 INTENT): the person's attested answer bound to this move, so the terminal check is reached.
      decision: async () => bound(layout.groupDir),
      terminals: () =>
        seam()(
          fakeScan({
            loaded: async () => [layout.loaded],
            missing: [layout.loaded],
            builtDirs: [layout.loaded],
            list: async () => {
              throw new Error("listing died")
            },
          }).scan,
        ),
    }
    const before = sha((await tree(layout.root)).join("\n"))
    for (const dryRun of [false, true]) {
      const result = await Rehome.make(ports).run({
        missionId: layout.mission,
        from: layout.defaultProject,
        to: layout.groupDir,
        sessions: [],
        approvalRef: "D-1",
        approvalMission: layout.mission,
        dryRun,
      })
      expect(result).toEqual({ refused: "REHOME_SESSION_ACTIVE", detail: UNAVAILABLE })
    }
    expect(sha((await tree(layout.root)).join("\n"))).toBe(before)
    expect(await fs.readdir(path.join(dataDir, "rehome")).catch(() => [] as string[])).toEqual([])
  })
})
