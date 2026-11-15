import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import * as Registry from "./obsidian-registry"
import {
  fakeObsidianHome,
  lsappinfoOutputs,
  registryExtraKeys,
  registryMissingFile,
  registryMissingFolder,
  registryUnregistered,
} from "./rel1210-obsidian-registry.fixture"

// 1.2.10 row 43 (AC-P1b, N10-161; 01a §3.1 S5-S13, §3.3.1 b1-b12; C12, C17 Q1-3 D-1 D-5, C29 S10-05 S10-13). When no
// listed vault contains the hub note and Obsidian is closed, desktop main adds exactly one entry for the vault root to
// Obsidian's vault list: tmp file + rename, the file's mode kept (fchmod, so the umask cannot change it), every other
// key and entry parsed-equal, a one-time backup beside it that is never overwritten and never followed through a link.
// Fake home and fake Obsidian data folder only (row 39 builders); nothing is launched.

const reg = Registry as Record<string, any>
const BACKUP = "obsidian.json.swarm-backup"

type Fixture = ReturnType<typeof fakeObsidianHome>
const made: Fixture[] = []
afterEach(() => {
  while (made.length) {
    const fixture = made.pop()!
    // b11: no `obsidian.json.swarm-*.tmp` is ever left behind.
    if (existsSync(fixture.configDir)) expect(tmpFiles(fixture)).toEqual([])
    fixture.cleanup()
  }
})

function keep<T extends Fixture>(fixture: T): T {
  made.push(fixture)
  return fixture
}

function tmpFiles(fixture: Fixture) {
  return readdirSync(fixture.configDir).filter((name) => name.startsWith("obsidian.json.swarm-") && name.endsWith(".tmp"))
}

function countingRunner() {
  const runner = Object.assign(
    () => {
      runner.calls++
      return lsappinfoOutputs.closed()
    },
    { calls: 0 },
  )
  return runner
}

function sha(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex")
}

function mode(file: string) {
  return statSync(file).mode & 0o777
}

function read(file: string) {
  return JSON.parse(readFileSync(file, "utf8"))
}

async function press(fixture: Fixture, extra: Record<string, unknown> = {}) {
  const runner = countingRunner()
  const step = await reg.ensureObsidianVault({
    configDir: fixture.configDir,
    vaultRoot: fixture.vaultRoot,
    hubPath: fixture.hubPath,
    appPresent: true,
    runLsappinfo: runner,
    now: () => 1_700_000_123_456,
    ...extra,
  })
  return { step, calls: runner.calls }
}

/** The ids added by the call: keys of `vaults` after that were not there before. */
function addedIds(before: Record<string, unknown>, after: Record<string, unknown>) {
  return Object.keys(after).filter((id) => !Object.hasOwn(before, id))
}

async function withUmask<T>(mask: number, body: () => Promise<T>): Promise<T> {
  const old = process.umask(mask)
  try {
    return await body()
  } finally {
    process.umask(old)
  }
}

/** b1 + b3 on a registry of mode 0640: one new entry, rest parsed-equal, mode kept, backup = original bytes and mode. */
async function b1b3(fixture: ReturnType<typeof registryUnregistered>) {
  const original = readFileSync(fixture.registryPath)
  const before = read(fixture.registryPath)
  const { step } = await press(fixture)
  expect(step).toEqual({ result: "registered" })
  const after = read(fixture.registryPath)
  const ids = addedIds(before.vaults, after.vaults)
  expect(ids.length).toBe(1)
  expect(after.vaults[ids[0]]).toEqual({ path: fixture.vaultRoot, ts: 1_700_000_123_456 })
  for (const id of Object.keys(before.vaults)) expect(after.vaults[id]).toEqual(before.vaults[id])
  expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
  expect(Object.keys(after.vaults).length).toBe(Object.keys(before.vaults).length + 1)
  expect(mode(fixture.registryPath)).toBe(0o640)
  // b3: the one-time backup holds the bytes and the mode of the file before the write.
  const backup = join(fixture.configDir, BACKUP)
  expect(sha(readFileSync(backup))).toBe(sha(original))
  expect(mode(backup)).toBe(0o640)
}

describe("AC-P1b: Obsidian registry write (N10-161)", () => {
  test("b1 + b3 registryUnregistered (mode 0640) -> registered, one new entry, rest parsed-equal, mode kept, backup once", async () => {
    await b1b3(keep(registryUnregistered(fakeObsidianHome(), 0o640)))
  })

  test("b1 + b3 again under process.umask(0o077) (S10-05): the original mode 0640 on both files", async () => {
    const fixture = keep(registryUnregistered(fakeObsidianHome(), 0o640))
    await withUmask(0o077, () => b1b3(fixture))
  })

  test("b2 registryExtraKeys -> registered; extra top-level keys and other entries (open: true) parsed-equal", async () => {
    const fixture = keep(registryExtraKeys())
    const before = read(fixture.registryPath)
    const { step } = await press(fixture)
    expect(step).toEqual({ result: "registered" })
    const after = read(fixture.registryPath)
    const ids = addedIds(before.vaults, after.vaults)
    expect(ids.length).toBe(1)
    const { vaults: beforeVaults, ...beforeRest } = before
    const { vaults: afterVaults, ...afterRest } = after
    expect(afterRest).toEqual(beforeRest)
    for (const id of Object.keys(beforeVaults)) expect(afterVaults[id]).toEqual(beforeVaults[id])
    expect(Object.values(beforeVaults).filter((e: any) => e.open === true).length).toBe(2)
  })

  test("b4 second call after b1 -> in-vault, 0 runner calls, file and backup sha256 unchanged", async () => {
    const fixture = keep(registryUnregistered(fakeObsidianHome(), 0o640))
    expect((await press(fixture)).step).toEqual({ result: "registered" })
    const file = sha(readFileSync(fixture.registryPath))
    const backup = sha(readFileSync(join(fixture.configDir, BACKUP)))
    const { step, calls } = await press(fixture)
    expect(step).toEqual({ result: "in-vault" })
    expect(calls).toBe(0)
    expect(sha(readFileSync(fixture.registryPath))).toBe(file)
    expect(sha(readFileSync(join(fixture.configDir, BACKUP)))).toBe(backup)
  })

  test("b5 registryMissingFile -> the file holds only the Swarm entry, mode 0600, no backup", async () => {
    const fixture = keep(registryMissingFile())
    const { step } = await press(fixture, { randomId: () => "0123456789abcdef" })
    expect(step).toEqual({ result: "registered" })
    expect(readFileSync(fixture.registryPath, "utf8")).toBe(
      JSON.stringify({ vaults: { "0123456789abcdef": { path: fixture.vaultRoot, ts: 1_700_000_123_456 } } }),
    )
    expect(mode(fixture.registryPath)).toBe(0o600)
    expect(existsSync(join(fixture.configDir, BACKUP))).toBe(false)
  })

  test("b6 registryMissingFolder + appPresent true -> folder created 0700, file 0600", async () => {
    const fixture = keep(registryMissingFolder())
    expect(existsSync(fixture.configDir)).toBe(false)
    const { step } = await press(fixture)
    expect(step).toEqual({ result: "registered" })
    expect(mode(fixture.configDir)).toBe(0o700)
    expect(mode(fixture.registryPath)).toBe(0o600)
    expect(Object.keys(read(fixture.registryPath).vaults).length).toBe(1)
  })

  test("b7 registryMissingFolder + appPresent false -> not-registered / registry-write, folder still absent", async () => {
    const fixture = keep(registryMissingFolder())
    const { step } = await press(fixture, { appPresent: false })
    expect(step).toEqual({ result: "not-registered", reason: "registry-write" })
    expect(existsSync(fixture.configDir)).toBe(false)
  })

  test("b8 a backup with other content already exists -> registered, the backup is never overwritten", async () => {
    const fixture = keep(registryUnregistered())
    const backup = join(fixture.configDir, BACKUP)
    writeFileSync(backup, "older backup (synthetic)\n", { mode: 0o600 })
    const kept = sha(readFileSync(backup))
    const { step } = await press(fixture)
    expect(step).toEqual({ result: "registered" })
    expect(sha(readFileSync(backup))).toBe(kept)
  })

  test("b9 a dangling symlink at the backup name -> registered, the link target is not created, the link unchanged", async () => {
    const fixture = keep(registryUnregistered())
    const backup = join(fixture.configDir, BACKUP)
    const target = join(fixture.base, "planted-backup-target")
    symlinkSync(target, backup)
    const { step } = await press(fixture)
    expect(step).toEqual({ result: "registered" })
    expect(existsSync(target)).toBe(false)
    expect(lstatSync(backup).isSymbolicLink()).toBe(true)
    expect(readlinkSync(backup)).toBe(target)
  })

  test("b9 a planted name at the tmp file name is never followed or overwritten (flag wx; a fresh name is used)", async () => {
    const fixture = keep(registryUnregistered())
    const target = join(fixture.base, "planted-tmp-target")
    // The tmp name carries 16 random hex characters, so a planted name cannot be guessed; this one stands for any
    // `obsidian.json.swarm-*` neighbour and must be left exactly as it is.
    const planted = join(fixture.configDir, `obsidian.json.swarm-${process.pid}-planted`)
    symlinkSync(target, planted)
    const { step } = await press(fixture)
    expect(step).toEqual({ result: "registered" })
    expect(existsSync(target)).toBe(false)
    expect(readlinkSync(planted)).toBe(target)
  })

  test("b10 two calls started together -> exactly one new entry; one registered, the other in-vault", async () => {
    const fixture = keep(registryUnregistered())
    const before = read(fixture.registryPath)
    const [first, second] = await Promise.all([press(fixture), press(fixture)])
    expect([first.step.result, second.step.result].sort()).toEqual(["in-vault", "registered"])
    const after = read(fixture.registryPath)
    expect(addedIds(before.vaults, after.vaults).length).toBe(1)
  })

  test("b12 own-property build (S10-13): a top-level __proto__ key and relative / numeric paths stay parsed-equal", async () => {
    const fixture = keep(fakeObsidianHome())
    const text =
      '{"__proto__":{"polluted":true},"vaults":{' +
      '"aaaaaaaaaaaaaaaa":{"path":"relative/notes","ts":1},' +
      '"bbbbbbbbbbbbbbbb":{"path":42,"ts":2}},"zoom":0}'
    writeFileSync(fixture.registryPath, text, { mode: 0o644 })
    const before = JSON.parse(text)
    const { step } = await press(fixture)
    // S12 verify passes (it would return registry-verify otherwise).
    expect(step).toEqual({ result: "registered" })
    const after = JSON.parse(readFileSync(fixture.registryPath, "utf8"))
    expect(Object.hasOwn(after, "__proto__")).toBe(true)
    expect(JSON.stringify(after["__proto__"])).toBe(JSON.stringify(before["__proto__"]))
    expect(after.vaults.aaaaaaaaaaaaaaaa).toEqual({ path: "relative/notes", ts: 1 })
    expect(after.vaults.bbbbbbbbbbbbbbbb).toEqual({ path: 42, ts: 2 })
    expect(after.zoom).toBe(0)
    expect(addedIds(before.vaults, after.vaults).length).toBe(1)
    expect(Object.getPrototypeOf(after.vaults)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test("b11 a call refused after its tmp file was written (file edited before the rename) leaves no tmp file", async () => {
    const fixture = keep(registryUnregistered())
    let tmpSeen = 0
    const { step } = await press(fixture, {
      beforeRename: async () => {
        tmpSeen = tmpFiles(fixture).length
        writeFileSync(fixture.registryPath, JSON.stringify({ ...read(fixture.registryPath), edited: true }))
      },
    })
    expect(tmpSeen).toBe(1)
    expect(step.result).not.toBe("registered")
    expect(read(fixture.registryPath).edited).toBe(true)
    expect(tmpFiles(fixture)).toEqual([])
  })
})
