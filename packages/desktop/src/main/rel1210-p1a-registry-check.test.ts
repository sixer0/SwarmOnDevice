import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import * as Registry from "./obsidian-registry"
import {
  fakeObsidianHome,
  lsappinfoOutputs,
  registryChildWithHub,
  registryMalformed,
  registryMissingFile,
  registryParentRegistered,
  registryRegistered,
  registryUnregistered,
  registryVaultsNotObject,
} from "./rel1210-obsidian-registry.fixture"

// 1.2.10 row 42 (AC-P1a, N10-160; 01a §3.1 S1-S3, §3.2 a1-a12; C12, C17 D-3, C29). Before "Open graph in Obsidian"
// launches, desktop main reads Obsidian's vault list and decides by real path whether a listed vault already contains
// the hub note. A containing vault opens as it is: no detection call and no write. A file that cannot be parsed as a
// plain object (or whose `vaults` is not one) is refused as `registry-malformed`, also without a detection call. Every
// other list proceeds past the check, which the single call of the fake detection runner proves (the write itself is
// AC-P1b). Fake home and fake Obsidian data folder only (row 39 builders); nothing is launched.

const reg = Registry as Record<string, any>

type Fixture = ReturnType<typeof fakeObsidianHome>
const made: Fixture[] = []
afterEach(() => {
  while (made.length) made.pop()!.cleanup()
})

function keep<T extends Fixture>(fixture: T): T {
  made.push(fixture)
  return fixture
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

function fileState(fixture: Fixture) {
  const bytes = readFileSync(fixture.registryPath)
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mtimeMs: statSync(fixture.registryPath).mtimeMs,
    entries: readdirSync(fixture.configDir).sort(),
  }
}

async function check(fixture: Fixture) {
  const runner = countingRunner()
  const step = await reg.ensureObsidianVault({
    configDir: fixture.configDir,
    vaultRoot: fixture.vaultRoot,
    hubPath: fixture.hubPath,
    appPresent: true,
    runLsappinfo: runner,
  })
  return { step, calls: runner.calls }
}

function writeList(fixture: Fixture, paths: string[]) {
  const vaults: Record<string, { path: string; ts: number }> = {}
  paths.forEach((p, i) => (vaults[`${i}`.padStart(16, "a")] = { path: p, ts: 1_700_000_000_000 + i }))
  writeFileSync(fixture.registryPath, JSON.stringify({ vaults }), { mode: 0o644 })
}

describe("AC-P1a: Obsidian registry read and containing-vault check (N10-160)", () => {
  test("the module exports ensureObsidianVault (N10-024)", () => {
    expect(typeof reg.ensureObsidianVault).toBe("function")
  })

  const inVault: [string, () => Fixture][] = [
    ["a1 registryRegistered: the vault root is listed", () => registryRegistered()],
    ["a2 registryParentRegistered: an ancestor of the root is listed (C17 D-3)", () => registryParentRegistered()],
    ["a3 registryChildWithHub: <root>/swarm-memory is listed", () => registryChildWithHub()],
  ]
  for (const [name, build] of inVault) {
    test(`${name} -> in-vault, 0 runner calls, file sha256 and mtime equal`, async () => {
      const fixture = keep(build())
      const before = fileState(fixture)
      const { step, calls } = await check(fixture)
      expect(step).toEqual({ result: "in-vault" })
      expect(calls).toBe(0)
      expect(fileState(fixture)).toEqual(before)
    })
  }

  test("a4 registryUnregistered + closed runner, no lock -> not stopped at the check (runner called twice: closed check 1 and 2)", async () => {
    const fixture = keep(registryUnregistered())
    const { step, calls } = await check(fixture)
    expect(calls).toBe(2)
    expect(step.result).not.toBe("in-vault")
    expect(step.reason).not.toBe("registry-malformed")
  })

  test("a5 registryMissingFile + closed runner -> not stopped at the check (runner called twice: closed check 1 and 2)", async () => {
    const fixture = keep(registryMissingFile())
    const { step, calls } = await check(fixture)
    expect(calls).toBe(2)
    expect(step.result).not.toBe("in-vault")
    expect(step.reason).not.toBe("registry-malformed")
  })

  for (const variant of ["json", "array-root", "empty", "bom"] as const) {
    test(`a6-a9 registryMalformed ${variant} -> not-registered / registry-malformed, 0 runner calls, sha256 equal`, async () => {
      const fixture = keep(registryMalformed(variant))
      const before = fileState(fixture)
      const { step, calls } = await check(fixture)
      expect(step).toEqual({ result: "not-registered", reason: "registry-malformed" })
      expect(calls).toBe(0)
      expect(fileState(fixture)).toEqual(before)
    })
  }

  for (const variant of ["array", "string"] as const) {
    test(`a10 registryVaultsNotObject ${variant} -> not-registered / registry-malformed, 0 runner calls`, async () => {
      const fixture = keep(registryVaultsNotObject(variant))
      const before = fileState(fixture)
      const { step, calls } = await check(fixture)
      expect(step).toEqual({ result: "not-registered", reason: "registry-malformed" })
      expect(calls).toBe(0)
      expect(fileState(fixture)).toEqual(before)
    })
  }

  test("a11 an entry stored with a trailing / equal to the root -> in-vault (realpath drops it)", async () => {
    const fixture = keep(fakeObsidianHome())
    writeList(fixture, [fixture.vaultRoot + "/"])
    const before = fileState(fixture)
    const { step, calls } = await check(fixture)
    expect(step).toEqual({ result: "in-vault" })
    expect(calls).toBe(0)
    expect(fileState(fixture)).toEqual(before)
  })

  test("a12 prefix siblings (<root>2, and <root> minus its last letter) are not containing vaults -> proceeds (runner called twice: closed check 1 and 2)", async () => {
    const fixture = keep(fakeObsidianHome())
    const sibling = fixture.vaultRoot + "2"
    // A text prefix of the hub path that is not a folder boundary: a bare startsWith would take it as the vault.
    const shorter = fixture.vaultRoot.slice(0, -1)
    mkdirSync(sibling, { recursive: true })
    mkdirSync(shorter, { recursive: true })
    writeList(fixture, [sibling, shorter])
    expect(fixture.hubPath.startsWith(shorter)).toBe(true)
    const { step, calls } = await check(fixture)
    expect(calls).toBe(2)
    expect(step.result).not.toBe("in-vault")
  })

  test("the step result carries no path: only result and reason keys, values without '/'", async () => {
    const results = [
      await check(keep(registryRegistered())),
      await check(keep(registryUnregistered())),
      await check(keep(registryMalformed("json"))),
    ]
    for (const { step } of results) {
      expect(Object.keys(step).every((k) => k === "result" || k === "reason")).toBe(true)
      expect(Object.values(step).some((v) => String(v).includes("/"))).toBe(false)
    }
  })
})
