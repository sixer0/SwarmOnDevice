// TH-02 / SEC-16 (1.2.6 row 91): spec 01c 11.4 item 11, the state file. Red class B at e363918a69 (module is new).
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  readToolHealthState,
  scrubDetail,
  toolHealthDir,
  toolHealthStatePath,
  writeToolHealthState,
  type ToolHealthState,
} from "./state"

const homes: string[] = []
function home() {
  const dir = mkdtempSync(join(tmpdir(), "th-state-"))
  homes.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const sample: ToolHealthState = {
  version: 1,
  updatedAt: 5,
  appVersion: "1.2.6",
  components: {
    searxng: { lastStatus: "revived", reason: "REVIVED", detail: "ok", lastCheckedAt: 5, lastHealthyAt: 5, lastReviveAt: 4, source: "shipped" },
  },
}

describe("TH-02 state.json (01c 3.5, 11.4 item 11)", () => {
  test("written with dir 0700, file 0600, through a temp file and rename; read back equal", () => {
    const h = home()
    writeToolHealthState(h, sample)
    expect(statSync(toolHealthDir(h)).mode & 0o777).toBe(0o700)
    expect(statSync(toolHealthStatePath(h)).mode & 0o777).toBe(0o600)
    expect(readdirSync(toolHealthDir(h))).toEqual(["state.json"]) // no temp file left
    const { state, exists } = readToolHealthState(h)
    expect(exists).toBe(true)
    expect(state.components).toEqual(sample.components)
  })

  test("an existing looser directory is tightened to 0700", () => {
    const h = home()
    mkdirSync(toolHealthDir(h), { recursive: true, mode: 0o755 })
    writeToolHealthState(h, sample)
    expect(statSync(toolHealthDir(h)).mode & 0o777).toBe(0o700)
  })

  test("malformed state reads as empty; bad records are dropped one by one", () => {
    const h = home()
    mkdirSync(toolHealthDir(h), { recursive: true })
    writeFileSync(toolHealthStatePath(h), "{nope")
    expect(readToolHealthState(h).state.components).toEqual({})
    writeFileSync(
      toolHealthStatePath(h),
      JSON.stringify({ components: { a: { lastStatus: "bogus", reason: "OK", lastCheckedAt: 1 }, b: sample.components.searxng } }),
    )
    expect(Object.keys(readToolHealthState(h).state.components)).toEqual(["b"])
  })
})

describe("SEC-16 / SEC-15 scrubDetail", () => {
  test("TOKEN=abc123def456 is masked; named secret redacted; one line; <= 300 chars; no query string", () => {
    const token = "a".repeat(10) + "1234567890XYZ"
    const out = scrubDetail(`exit 1: TOKEN=abc123def456 ${token} GET http://127.0.0.1:7863/health?key=v\nsecond line`, [token])
    expect(out).not.toContain("abc123def456")
    expect(out).not.toContain(token)
    expect(out).not.toContain("?key=")
    expect(out).not.toContain("second line")
    expect(scrubDetail("x".repeat(1000)).length).toBeLessThanOrEqual(300)
  })

  test("a written state never holds the injected token", () => {
    const h = home()
    const token = "0123456789abcdef".repeat(4)
    const s: ToolHealthState = structuredClone(sample)
    s.components.searxng!.detail = scrubDetail(`bridge token ${token}`, [token])
    writeToolHealthState(h, s)
    expect(readFileSync(toolHealthStatePath(h), "utf8")).not.toContain(token)
  })
})
