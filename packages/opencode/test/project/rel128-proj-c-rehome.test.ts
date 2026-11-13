// 1.2.8 row 44, AC-PROJc (N8-364) + the group recognition part of AC-PROJe (through preflight, no Rehome.groups export, C104/G2-05): the re-home primitive moves one mission folder
// from the Default Project root R into a group, moves the mission's memory notes to the group's store with their ids
// and refs, re-points its sessions, journals every step and undoes them in reverse on a failure (01d §6, SR8-18).
// Red at BASE e1f9673772: OC/project/rehome.ts (Rehome) and Memory.storeKey do not exist. The storeKey formula case is
// a refactor pin (01d §9: green at BASE by design, byte-identical to the old file() formula).
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Memory } from "../../src/memory/memory"
import { Rehome } from "../../src/project/rehome"

const FIXTURE = path.join(import.meta.dir, "../../../datum-studio/test/fixtures/syn128/default_project")
const MISSION = "2026-09-02_lumen-release-checklist"
const OTHER = "2026-09-08_dinas-contoh-nota-layanan"
const REPORT = `docs/${MISSION}/report/report.md`

// HOME is a fresh temp folder for this file: nothing here may reach the real Default Project or a real memory store.
let home = ""
let homeSpy: ReturnType<typeof spyOn> | undefined
beforeAll(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rh44-")))
  homeSpy = spyOn(os, "homedir").mockReturnValue(home)
})
afterAll(async () => {
  homeSpy?.mockRestore()
  await fs.rm(home, { recursive: true, force: true })
})

type Session = { directory: string; projectID: string; busy: boolean }
let case_ = 0
let R = ""
let data = ""
let sessions = new Map<string, Session>()
let published: unknown[] = []
let mirrored: string[] = []
let terminals: string[] = []

const notes = () => [
  {
    id: "a1b2c3",
    text: "Release checklist lives in the mission report",
    source: "agent",
    deviceOnly: false,
    time: 1787000000000,
    sessionID: "ses_mission",
    refs: [{ path: REPORT, line: 3 }],
  },
  {
    id: "d4e5f6",
    text: `2026-09-02 ${MISSION} | checklist written | triggers: lumen, release | ${REPORT}`,
    source: "agent",
    deviceOnly: true,
    time: 1787000001000,
    refs: [{ path: REPORT }],
    kind: "index",
    missionId: MISSION,
  },
  {
    id: "0a0b0c",
    text: "Old archive notes are in Arsip Lama",
    source: "user",
    deviceOnly: false,
    time: 1787000002000,
    refs: [{ path: "Arsip Lama/README.md" }],
  },
]

const storeOf = (dir: string) => path.join(data, "memory", `${Memory.storeKey("global", dir)}.json`)

async function writeStore(dir: string, items: unknown[]) {
  await fs.mkdir(path.join(data, "memory"), { recursive: true, mode: 0o700 })
  await fs.writeFile(storeOf(dir), JSON.stringify({ version: 2, enabled: true, items }, null, 2) + "\n", { mode: 0o600 })
}

const readItems = async (dir: string) =>
  (JSON.parse(await fs.readFile(storeOf(dir), "utf8")) as { items: Record<string, unknown>[] }).items

/** Every path under `dir` with its kind and content hash (files) or link target. */
async function treeHash(dir: string) {
  const lines: string[] = []
  const walk = async (current: string) => {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).toSorted((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const full = path.join(current, entry.name)
      const rel = path.relative(dir, full)
      if (entry.isSymbolicLink()) lines.push(`L ${rel} ${await fs.readlink(full)}`)
      else if (entry.isDirectory()) {
        lines.push(`D ${rel}`)
        await walk(full)
      } else lines.push(`F ${rel} ${createHash("sha256").update(await fs.readFile(full)).digest("hex")}`)
    }
  }
  await walk(dir)
  return createHash("sha256").update(lines.join("\n")).digest("hex")
}

const fileHash = async (file: string) =>
  fs
    .readFile(file)
    .then((b) => createHash("sha256").update(b).digest("hex"))
    .catch(() => "absent")

const ports = (): Rehome.Ports => ({
  root: R,
  dataDir: data,
  session: async (id) => sessions.get(id),
  projectId: async () => "global",
  moveSession: async (id, directory) => {
    const current = sessions.get(id)
    if (!current) throw new Error("no session")
    sessions.set(id, { ...current, directory })
  },
  terminals: async () => terminals,
  publish: async (event) => {
    published.push(event)
  },
  refreshMirror: async (key) => {
    mirrored.push(key)
  },
})

const call = (over: Partial<Rehome.Input> = {}): Rehome.Input => ({
  missionId: MISSION,
  from: R,
  to: path.join(R, "Lumen"),
  sessions: ["ses_mission"],
  approvalRef: "D-1",
  ...over,
})

beforeEach(async () => {
  case_ += 1
  const base = path.join(home, `c${case_}`)
  R = path.join(base, "Documents", "Default Project")
  data = path.join(base, "data")
  await fs.mkdir(path.dirname(R), { recursive: true })
  await fs.cp(FIXTURE, R, { recursive: true })
  await fs.mkdir(data, { recursive: true })
  sessions = new Map([
    ["ses_mission", { directory: R, projectID: "global", busy: false }],
    ["ses_other", { directory: R, projectID: "global", busy: false }],
  ])
  published = []
  mirrored = []
  terminals = []
  await writeStore(R, notes())
})

describe("Memory.storeKey (N8-446, refactor pin)", () => {
  test("equals the BASE file() formula byte for byte; a group's key differs from R's", () => {
    const dir = "/tmp/x/Documents/Default Project"
    expect(Memory.storeKey("global", dir)).toBe("dir-" + createHash("sha256").update(dir).digest("hex").slice(0, 24))
    expect(Memory.storeKey("p_123", dir)).toBe("p_123")
    expect(Memory.storeKey("global", path.join(dir, "Lumen"))).not.toBe(Memory.storeKey("global", dir))
  })
})

describe("group recognition through the move preflight (AC-PROJe, N8-364 groups case)", () => {
  test("only a marked one-level group is joined: not docs, unmarked, symlinked or nested", async () => {
    await fs.symlink(path.join(R, "Lumen"), path.join(R, "Lumen Link"))
    await fs.mkdir(path.join(R, "Arsip Lama", "Inner", ".swarm"), { recursive: true })
    await fs.writeFile(
      path.join(R, "Arsip Lama", "Inner", ".swarm", "group.json"),
      JSON.stringify({ version: 1, name: "Inner", kind: "theme", created: 1 }),
    )
    await fs.mkdir(path.join(R, "docs", ".swarm"), { recursive: true })
    await fs.writeFile(
      path.join(R, "docs", ".swarm", "group.json"),
      JSON.stringify({ version: 1, name: "docs", kind: "theme", created: 1 }),
    )
    const tree = await treeHash(R)
    const rehome = Rehome.make(ports())
    const plan = (to: string) => rehome.run(call({ to, dryRun: true }))
    expect(await plan(path.join(R, "Lumen"))).toEqual({
      planned: { folder: true, notes: 2, sessions: 1, createsGroup: false },
    })
    expect(await plan(path.join(R, "docs"))).toMatchObject({ refused: "REHOME_OUTSIDE_ROOT" })
    expect(await plan(path.join(R, "Arsip Lama"))).toMatchObject({ refused: "REHOME_TARGET_EXISTS" })
    expect(await plan(path.join(R, "Lumen Link"))).toMatchObject({ refused: "REHOME_SYMLINK" })
    expect(await plan(path.join(R, "Arsip Lama", "Inner"))).toMatchObject({ refused: "REHOME_OUTSIDE_ROOT" })
    expect(await treeHash(R)).toBe(tree)
  })

  test("group names refuse format characters, edge spaces and a trailing dot (SR8-17)", () => {
    expect(Rehome.groupNameOk("Lumen")).toBe(true)
    expect(Rehome.groupNameOk("Dinas Contoh")).toBe(true)
    for (const bad of ["docs", "DOCS", ".hidden", "a/b", " Lumen", "Lumen ", "Lumen.", "Lu‮men", "Lu​men", "a b"])
      expect(Rehome.groupNameOk(bad)).toBe(false)
  })
})

describe("Rehome.run (AC-PROJc, N8-364)", () => {
  test("join: folder, the 2 selected notes with their ids and refs, sessions, backup, journal complete", async () => {
    const before = await fs.readFile(storeOf(R))
    const result = await Rehome.make(ports()).run(call())
    if (!("journalId" in result)) throw new Error(JSON.stringify(result))
    expect(result.moved).toEqual({ folder: true, notes: 2, sessions: 1 })

    const to = path.join(R, "Lumen")
    expect((await fs.stat(path.join(to, "docs", MISSION, "report", "report.md"))).isFile()).toBe(true)
    expect(await fs.lstat(path.join(R, "docs", MISSION)).catch(() => undefined)).toBeUndefined()

    const original = notes()
    expect(await readItems(to)).toEqual([original[0], original[1]])
    expect(await readItems(R)).toEqual([original[2]])
    expect(await fs.readFile(`${storeOf(R)}.rehome-${result.journalId}`)).toEqual(before)
    expect((await fs.stat(`${storeOf(R)}.rehome-${result.journalId}`)).mode & 0o777).toBe(0o600)

    expect(sessions.get("ses_mission")?.directory).toBe(to)
    expect(sessions.get("ses_other")?.directory).toBe(R)

    const journalFile = path.join(data, "rehome", `${result.journalId}.json`)
    const journal = JSON.parse(await fs.readFile(journalFile, "utf8")) as Rehome.Journal
    expect(journal.state).toBe("complete")
    expect(journal.approvalRef).toBe("D-1")
    expect(journal.steps.every((s) => s.status === "done")).toBe(true)
    expect((await fs.stat(journalFile)).mode & 0o777).toBe(0o600)
    expect((await fs.stat(path.join(data, "rehome"))).mode & 0o777).toBe(0o700)

    expect(published).toEqual([
      { missionId: MISSION, from: R, to, sessions: ["ses_mission"], journalId: result.journalId },
    ])
    expect(mirrored.toSorted()).toEqual([Memory.storeKey("global", R), Memory.storeKey("global", to)].toSorted())
  })

  test("a second identical call is a replay and changes nothing", async () => {
    const rehome = Rehome.make(ports())
    const first = await rehome.run(call())
    if (!("journalId" in first)) throw new Error(JSON.stringify(first))
    const tree = await treeHash(R)
    const stores = [await fileHash(storeOf(R)), await fileHash(storeOf(path.join(R, "Lumen")))]
    const second = await rehome.run(call())
    expect(second).toEqual({ journalId: first.journalId, moved: first.moved, replayed: true })
    expect(await treeHash(R)).toBe(tree)
    expect([await fileHash(storeOf(R)), await fileHash(storeOf(path.join(R, "Lumen")))]).toEqual(stores)
  })

  test("new group: creates the folder and its marker; the next call can join it", async () => {
    const to = path.join(R, "Dinas Contoh")
    const result = await Rehome.make(ports()).run(
      call({ missionId: OTHER, to, sessions: [], groupKind: "institution" }),
    )
    if (!("journalId" in result)) throw new Error(JSON.stringify(result))
    expect(result.moved).toEqual({ folder: true, notes: 0, sessions: 0 })
    const marker = JSON.parse(await fs.readFile(path.join(to, ".swarm", "group.json"), "utf8"))
    expect(marker).toMatchObject({ version: 1, name: "Dinas Contoh", kind: "institution" })
    expect(await Rehome.make(ports()).run(call({ to, dryRun: true }))).toMatchObject({ planned: { createsGroup: false } })
    expect(await readItems(R)).toEqual(notes())
  })

  test("dryRun plans and writes nothing", async () => {
    const tree = await treeHash(R)
    const store = await fileHash(storeOf(R))
    const result = await Rehome.make(ports()).run(call({ to: path.join(R, "Lumen Baru"), groupKind: "product", dryRun: true }))
    expect(result).toEqual({ planned: { folder: true, notes: 2, sessions: 1, createsGroup: true } })
    expect(await treeHash(R)).toBe(tree)
    expect(await fileHash(storeOf(R))).toBe(store)
    expect(await fs.readdir(path.join(data, "rehome")).catch(() => [])).toEqual([])
  })

  test("refusals change nothing: unmarked target, busy session, terminal inside, no root", async () => {
    const tree = await treeHash(R)
    const rehome = Rehome.make(ports())
    expect(await rehome.run(call({ to: path.join(R, "Arsip Lama") }))).toMatchObject({ refused: "REHOME_TARGET_EXISTS" })
    sessions.set("ses_mission", { directory: R, projectID: "global", busy: true })
    expect(await rehome.run(call())).toMatchObject({ refused: "REHOME_SESSION_ACTIVE" })
    sessions.set("ses_mission", { directory: R, projectID: "global", busy: false })
    terminals = [path.join(R, "docs", MISSION, "report")]
    expect(await rehome.run(call())).toMatchObject({ refused: "REHOME_SESSION_ACTIVE" })
    terminals = []
    expect(await Rehome.make({ ...ports(), root: undefined }).run(call())).toMatchObject({
      refused: "REHOME_OUTSIDE_ROOT",
    })
    expect(await rehome.run(call({ approvalRef: "yes" }))).toMatchObject({ refused: "REHOME_APPROVAL_MISSING" })
    expect(await treeHash(R)).toBe(tree)
    expect(await readItems(R)).toEqual(notes())
    expect(await fs.readdir(path.join(data, "rehome")).catch(() => [])).toEqual([])
  })

  test("faultAt memory (interrupted re-key): REHOME_ROLLED_BACK, tree and both stores equal to before", async () => {
    const to = path.join(R, "Lumen Baru")
    const tree = await treeHash(R)
    const stores = [await fileHash(storeOf(R)), await fileHash(storeOf(to))]
    const result = await Rehome.make(ports(), { faultAt: "memory" }).run(call({ to, groupKind: "product" }))
    expect(result).toMatchObject({ refused: "REHOME_ROLLED_BACK", step: "memory" })
    expect(await treeHash(R)).toBe(tree)
    expect([await fileHash(storeOf(R)), await fileHash(storeOf(to))]).toEqual(stores)
    expect(await readItems(R)).toEqual(notes())
    expect(sessions.get("ses_mission")?.directory).toBe(R)
    const [name] = (await fs.readdir(path.join(data, "rehome"))).filter((n) => n.endsWith(".json"))
    const journal = JSON.parse(await fs.readFile(path.join(data, "rehome", name!), "utf8")) as Rehome.Journal
    expect(journal.state).toBe("rolled_back")
    expect(journal.failedStep).toBe("memory")
    expect(published).toEqual([])
  })

  test("faultAt sessions: the moved notes and folder come back too", async () => {
    const tree = await treeHash(R)
    const store = await fileHash(storeOf(R))
    const result = await Rehome.make(ports(), { faultAt: "sessions" }).run(call())
    expect(result).toMatchObject({ refused: "REHOME_ROLLED_BACK", step: "sessions" })
    expect(await treeHash(R)).toBe(tree)
    expect(await fileHash(storeOf(R))).toBe(store)
    expect(await readItems(path.join(R, "Lumen")).catch(() => "absent")).toBe("absent")
    expect(sessions.get("ses_mission")?.directory).toBe(R)
  })
})

describe("Rehome.recover (crash recovery, SR8-18 c)", () => {
  async function crashedMove(to: string) {
    const result = await Rehome.make(ports()).run(call({ to, groupKind: "theme" }))
    if (!("journalId" in result)) throw new Error(JSON.stringify(result))
    // A crash before the journal said complete: recovery must treat the move as unfinished.
    const file = path.join(data, "rehome", `${result.journalId}.json`)
    const journal = JSON.parse(await fs.readFile(file, "utf8")) as Rehome.Journal
    await fs.writeFile(file, JSON.stringify({ ...journal, state: "running" }))
    return { journalId: result.journalId, file }
  }

  test("a running journal is rolled back: folder, group, marker, both stores and sessions as before", async () => {
    const to = path.join(R, "Pasang Surut")
    const tree = await treeHash(R)
    const stores = [await fileHash(storeOf(R)), await fileHash(storeOf(to))]
    const { journalId } = await crashedMove(to)
    expect(await Rehome.make(ports()).recover()).toEqual([{ journalId, state: "rolled_back" }])
    expect(await treeHash(R)).toBe(tree)
    expect([await fileHash(storeOf(R)), await fileHash(storeOf(to))]).toEqual(stores)
    expect(await readItems(R)).toEqual(notes())
    expect(sessions.get("ses_mission")?.directory).toBe(R)
  })

  test("an undo that would overwrite refuses: rollback_failed, nothing overwritten, later moves refused", async () => {
    const to = path.join(R, "Pasang Surut")
    const { journalId, file } = await crashedMove(to)
    // Something now sits where the folder would be renamed back to.
    await fs.mkdir(path.join(R, "docs", MISSION))
    await fs.writeFile(path.join(R, "docs", MISSION, "new.md"), "person's file\n")
    expect(await Rehome.make(ports()).recover()).toEqual([{ journalId, state: "rollback_failed" }])
    expect(await fs.readFile(path.join(R, "docs", MISSION, "new.md"), "utf8")).toBe("person's file\n")
    expect((await fs.stat(path.join(to, "docs", MISSION, "report", "report.md"))).isFile()).toBe(true)
    const again = await Rehome.make(ports()).run(call({ to: path.join(R, "Lumen") }))
    expect(again).toEqual({ refused: "REHOME_ROLLBACK_FAILED", journal: file })
  })
})

// 1.2.8 row 51c (LP-4, N8-364 shared-session case): a tidy list (one approval) of two missions that share one session.
// Red at the pre-fix HEAD: the second move refused REHOME_SESSION_ACTIVE because the first had moved the session.
describe("Rehome.run: a session shared by two missions of one tidy list (row 51c, LP-4)", () => {
  const lumen = () => path.join(R, "Lumen")
  const dinas = () => path.join(R, "Dinas Contoh")
  const first = () => call({ sessions: ["ses_mission"], approvalRef: "D-2" })
  const second = (over: Partial<Rehome.Input> = {}) =>
    call({ missionId: OTHER, to: dinas(), sessions: ["ses_mission"], approvalRef: "D-2", groupKind: "institution", ...over })
  const journalFiles = async () => (await fs.readdir(path.join(data, "rehome")).catch(() => [])).filter((n) => n.endsWith(".json"))

  test("idle shared session: both dry runs pass, both moves succeed, the session moves once (with the first)", async () => {
    const rehome = Rehome.make(ports())
    // The desktop tidy loop dry-runs every item before any move (C99): both must pass and both moves must then succeed.
    expect(await rehome.run({ ...first(), dryRun: true })).toMatchObject({ planned: { folder: true } })
    expect(await rehome.run({ ...second(), dryRun: true })).toMatchObject({ planned: { folder: true, createsGroup: true } })
    const a = await rehome.run(first())
    if (!("journalId" in a)) throw new Error(JSON.stringify(a))
    expect(a.moved.sessions).toBe(1)
    expect(sessions.get("ses_mission")?.directory).toBe(lumen())
    // After the first move the dry run of the second still predicts success, and the move succeeds.
    expect(await rehome.run({ ...second(), dryRun: true })).toEqual({
      planned: { folder: true, notes: 0, sessions: 0, createsGroup: true },
    })
    const b = await rehome.run(second())
    expect(`${"journalId" in b} ${JSON.stringify("moved" in b ? b.moved : b)}`).toBe(
      `true ${JSON.stringify({ folder: true, notes: 0, sessions: 0 })}`,
    )
    expect(sessions.get("ses_mission")?.directory).toBe(lumen())
    expect((await fs.stat(path.join(lumen(), "docs", MISSION))).isDirectory()).toBe(true)
    expect((await fs.stat(path.join(dinas(), "docs", OTHER))).isDirectory()).toBe(true)
    expect(published.map((e) => (e as { sessions: string[] }).sessions)).toEqual([["ses_mission"], []])
    // A compensation of the second move (its place failed) leaves the shared session where the first move put it.
    if (!("journalId" in b)) throw new Error("no journal")
    const back = await rehome.run({ missionId: OTHER, from: dinas(), to: R, sessions: ["ses_mission"], approvalRef: "D-2", compensates: b.journalId })
    expect("journalId" in back).toBe(true)
    expect(sessions.get("ses_mission")?.directory).toBe(lumen())
    expect((await fs.stat(path.join(R, "docs", OTHER))).isDirectory()).toBe(true)
  })

  test("a busy shared session still refuses before anything moves: tree, store and journals unchanged", async () => {
    const rehome = Rehome.make(ports())
    sessions.set("ses_mission", { directory: R, projectID: "global", busy: true })
    const tree = await treeHash(R)
    const store = await fileHash(storeOf(R))
    expect(await rehome.run({ ...first(), dryRun: true })).toMatchObject({ refused: "REHOME_SESSION_ACTIVE" })
    expect(await rehome.run({ ...second(), dryRun: true })).toMatchObject({ refused: "REHOME_SESSION_ACTIVE" })
    expect(await rehome.run(first())).toMatchObject({ refused: "REHOME_SESSION_ACTIVE", detail: "session ses_mission busy" })
    expect(await treeHash(R)).toBe(tree)
    expect(await fileHash(storeOf(R))).toBe(store)
    expect(await journalFiles()).toEqual([])

    // Idle for the first move, busy again (in its new folder) before the second: the second refuses, changes nothing.
    sessions.set("ses_mission", { directory: R, projectID: "global", busy: false })
    if (!("journalId" in (await rehome.run(first())))) throw new Error("first move failed")
    sessions.set("ses_mission", { directory: lumen(), projectID: "global", busy: true })
    const after = [await treeHash(R), await fileHash(storeOf(R)), await fileHash(storeOf(lumen())), (await journalFiles()).length]
    expect(await rehome.run(second())).toMatchObject({ refused: "REHOME_SESSION_ACTIVE", detail: "session ses_mission busy" })
    expect([await treeHash(R), await fileHash(storeOf(R)), await fileHash(storeOf(lumen())), (await journalFiles()).length]).toEqual(after)
    expect(sessions.get("ses_mission")?.directory).toBe(lumen())
  })

  test("a session another approval moved away still refuses (its own text), nothing changes", async () => {
    const rehome = Rehome.make(ports())
    if (!("journalId" in (await rehome.run(call({ approvalRef: "D-9" }))))) throw new Error("first move failed")
    const tree = await treeHash(R)
    const store = await fileHash(storeOf(R))
    expect(await rehome.run(second())).toEqual({
      refused: "REHOME_SESSION_ACTIVE",
      detail: "session ses_mission lives in another folder",
    })
    expect(await treeHash(R)).toBe(tree)
    expect(await fileHash(storeOf(R))).toBe(store)
  })
})
