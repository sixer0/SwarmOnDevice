// 1.3.4 T-12, owner decision U4 (2026-11-18): the autonomous-mode consent is carried once over a restart the person
// started themselves (menu Restart, memory Reopen). One file, 0600, read once and deleted at once, two minutes at most,
// never from a live process, only session:/directory: scopes. Everything else still asks the person again (MC-7).
import { Global } from "@opencode-ai/core/global"
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { ConsentCarry } from "../../src/permission/consent-carry"

const file = () => path.join(Global.Path.state, "autonomy", "consent-carry.json")
const dead = () => false
const NOW = 1_800_000_000_000

function put(body: unknown) {
  mkdirSync(path.dirname(file()), { recursive: true })
  writeFileSync(file(), JSON.stringify(body))
}

afterEach(() => {
  rmSync(file(), { force: true })
  ConsentCarry.clearForTests()
})

describe("ConsentCarry", () => {
  test("nothing consented: nothing written", () => {
    ConsentCarry.clearForTests()
    expect(ConsentCarry.write(NOW)).toBe(0)
    expect(existsSync(file())).toBe(false)
  })

  test("the mirror records set and delete, and write puts the live scopes in a 0600 file", () => {
    ConsentCarry.clearForTests()
    const map = new ConsentCarry.MirroredConsentMap<{ at: number; language: "en" | "id" }>()
    map.set("directory:/proj", { at: 1, language: "id" })
    map.set("session:ses_a", { at: 1, language: "en" })
    map.delete("session:ses_a")
    expect(ConsentCarry.write(NOW)).toBe(1)
    expect(statSync(file()).mode & 0o777).toBe(0o600)
    const carry = JSON.parse(readFileSync(file(), "utf8"))
    expect(carry).toEqual({ v: 1, pid: process.pid, at: NOW, scopes: [{ key: "directory:/proj", language: "id" }] })
    // the writing process never takes its own carry
    expect(ConsentCarry.take(NOW + 1_000, dead)).toEqual([])
    map.clear()
  })

  test("take reads once and always deletes the file", () => {
    put({ v: 1, pid: 999_999, at: NOW, scopes: [{ key: "directory:/p", language: "en" }] })
    expect(ConsentCarry.take(NOW + 10, dead)).toHaveLength(1)
    expect(existsSync(file())).toBe(false)
    expect(ConsentCarry.take(NOW + 20, dead)).toEqual([])
  })

  test("stale after two minutes, and a time from the future is refused", () => {
    put({ v: 1, pid: 999_999, at: NOW, scopes: [{ key: "directory:/p", language: "en" }] })
    expect(ConsentCarry.take(NOW + ConsentCarry.CARRY_MAX_AGE_MS + 1, dead)).toEqual([])
    expect(existsSync(file())).toBe(false)
    put({ v: 1, pid: 999_999, at: NOW + 60_000, scopes: [{ key: "directory:/p", language: "en" }] })
    expect(ConsentCarry.take(NOW, dead)).toEqual([])
  })

  test("a carry from a live process or from this process is ignored", () => {
    put({ v: 1, pid: 999_999, at: NOW, scopes: [{ key: "directory:/p", language: "en" }] })
    expect(ConsentCarry.take(NOW, () => true)).toEqual([])
    put({ v: 1, pid: process.pid, at: NOW, scopes: [{ key: "directory:/p", language: "en" }] })
    expect(ConsentCarry.take(NOW, dead)).toEqual([])
  })

  test("only well-formed session: and directory: scopes survive; a broken file gives nothing", () => {
    put({
      v: 1,
      pid: 999_999,
      at: NOW,
      scopes: [
        { key: "directory:/p", language: "id" },
        { key: "trust:/p", language: "en" },
        { key: "session:ses_b", language: "fr" },
        "session:ses_c",
      ],
    })
    expect(ConsentCarry.take(NOW, dead)).toEqual([{ key: "directory:/p", language: "id" }])
    put("not json at all")
    writeFileSync(file(), "{")
    expect(ConsentCarry.take(NOW, dead)).toEqual([])
    put({ v: 2, pid: 999_999, at: NOW, scopes: [] })
    expect(ConsentCarry.take(NOW, dead)).toEqual([])
  })
})
