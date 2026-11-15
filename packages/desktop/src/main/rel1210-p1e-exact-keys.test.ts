import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import * as Registry from "./obsidian-registry"
import { fakeObsidianHome, lsappinfoOutputs, registryUnregistered } from "./rel1210-obsidian-registry.fixture"

// 1.2.10 row 43 (AC-P1e, N10-166; 01a §3.3.2 e1-e7; C17 write rules, N10-030, N10-140). The entry Swarm writes into
// Obsidian's vault list has exactly the keys `path` (the native real path of the vault root: on-disk case, links
// resolved) and `ts` (a number from `now()`), under a fresh 16-hex id that never replaces another entry; the file is
// written without indentation. Fake home and fake Obsidian data folder only (row 39 builders); nothing is launched.

const reg = Registry as Record<string, any>
const NOW = 1_700_000_654_321

type Fixture = ReturnType<typeof fakeObsidianHome>
const made: Fixture[] = []
afterEach(() => {
  while (made.length) made.pop()!.cleanup()
})

function keep<T extends Fixture>(fixture: T): T {
  made.push(fixture)
  return fixture
}

function read(fixture: Fixture) {
  return JSON.parse(readFileSync(fixture.registryPath, "utf8"))
}

async function press(fixture: Fixture, extra: Record<string, unknown> = {}) {
  return reg.ensureObsidianVault({
    configDir: fixture.configDir,
    vaultRoot: fixture.vaultRoot,
    hubPath: fixture.hubPath,
    appPresent: true,
    runLsappinfo: lsappinfoOutputs.closed,
    now: () => NOW,
    ...extra,
  })
}

/** Writes once and returns the new id and its entry. */
async function written(fixture: Fixture, extra: Record<string, unknown> = {}) {
  const before = read(fixture).vaults
  const step = await press(fixture, extra)
  expect(step).toEqual({ result: "registered" })
  const after = read(fixture).vaults
  const ids = Object.keys(after).filter((id) => !Object.hasOwn(before, id))
  expect(ids.length).toBe(1)
  return { id: ids[0], entry: after[ids[0]], before, after }
}

describe("AC-P1e: exact written keys (N10-166)", () => {
  test("e1 the entry's keys are exactly path and ts (no open key)", async () => {
    const { entry } = await written(keep(registryUnregistered()))
    expect(Object.keys(entry).sort()).toEqual(["path", "ts"])
    expect(Object.hasOwn(entry, "open")).toBe(false)
  })

  test("e2 ts is a number equal to now()", async () => {
    const { entry } = await written(keep(registryUnregistered()))
    expect(typeof entry.ts).toBe("number")
    expect(entry.ts).toBe(NOW)
  })

  test("e3 a vault root given in another letter case is stored in its on-disk case", async () => {
    const fixture = keep(registryUnregistered())
    const parent = join(fixture.vaultRoot, "..")
    const last = fixture.vaultRoot.slice(fixture.vaultRoot.lastIndexOf("/") + 1)
    const otherCase = join(parent, last.toUpperCase())
    const { entry } = await written(fixture, { vaultRoot: otherCase })
    expect(entry.path).toBe(fixture.vaultRoot)
  })

  test("e4 a vault root given through a symlink is stored as the real target", async () => {
    const fixture = keep(registryUnregistered())
    const link = join(fixture.base, "vault-link")
    symlinkSync(fixture.vaultRoot, link)
    const { entry } = await written(fixture, { vaultRoot: link })
    expect(entry.path).toBe(fixture.vaultRoot)
  })

  test("e5 the id matches /^[0-9a-f]{16}$/ (default id source)", async () => {
    const { id } = await written(keep(registryUnregistered()))
    expect(id).toMatch(/^[0-9a-f]{16}$/)
  })

  test("e6 an id collision is regenerated; the colliding entry stays parsed-equal", async () => {
    const fixture = keep(registryUnregistered())
    const existing = Object.keys(read(fixture).vaults)[0]
    const ids = [existing, "not-hex-at-all!!", "fedcba9876543210"]
    let calls = 0
    const { id, before, after } = await written(fixture, { randomId: () => ids[calls++] })
    expect(id).toBe("fedcba9876543210")
    expect(calls).toBe(3)
    expect(after[existing]).toEqual(before[existing])
  })

  test("e7 the file text equals JSON.stringify(JSON.parse(text)): no indentation, no newline", async () => {
    const fixture = keep(registryUnregistered())
    await written(fixture)
    const text = readFileSync(fixture.registryPath, "utf8")
    expect(text).toBe(JSON.stringify(JSON.parse(text)))
    expect(text.includes("\n")).toBe(false)
  })
})
