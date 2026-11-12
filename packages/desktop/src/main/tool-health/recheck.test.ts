// SEC-05 (1.2.6 row 91): recheck.json rules (N-152) and the agent/person split for consent "manual".
// Red class B at e363918a69 (modules are new).
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { takeRecheckRequest } from "./recheck"
import { createToolHealth } from "./startup"
import { readToolHealthState, toolHealthDir, toolHealthRecheckPath } from "./state"
import type { ProbeResult } from "./probe"
import type { ResolvedToolHealthComponent } from "./types"

const homes: string[] = []
function home() {
  const dir = mkdtempSync(join(tmpdir(), "th-recheck-"))
  homes.push(dir)
  mkdirSync(toolHealthDir(dir), { recursive: true, mode: 0o700 })
  return dir
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const KNOWN = new Set(["searxng", "flux3", "manual-tool"])

describe("SEC-05 recheck.json validation", () => {
  test("a valid request is read and the file removed", () => {
    const h = home()
    writeFileSync(toolHealthRecheckPath(h), JSON.stringify({ ids: ["searxng"], requestedAt: 1 }))
    expect(takeRecheckRequest(h, KNOWN)).toEqual({ kind: "request", request: { ids: ["searxng"] } })
    expect(existsSync(toolHealthRecheckPath(h))).toBe(false)
    writeFileSync(toolHealthRecheckPath(h), JSON.stringify({ requestedAt: 1 }))
    expect(takeRecheckRequest(h, KNOWN)).toEqual({ kind: "request", request: {} })
  })

  test("symlinked, oversized, malformed, unknown-id, bad-id and foreign-owner files are ignored ENTRY_INVALID", () => {
    const h = home()
    const target = join(h, "elsewhere.json")
    writeFileSync(target, JSON.stringify({ ids: ["searxng"] }))
    symlinkSync(target, toolHealthRecheckPath(h))
    const link = takeRecheckRequest(h, KNOWN)
    expect(link).toMatchObject({ kind: "invalid", reason: "ENTRY_INVALID" })
    expect(existsSync(target)).toBe(true) // the link target is never touched

    const cases: string[] = [
      JSON.stringify({ ids: ["searxng"], pad: "x".repeat(5000) }),
      "{not json",
      JSON.stringify({ ids: ["nope-unknown"] }),
      JSON.stringify({ ids: ["Bad Id"] }),
      JSON.stringify({ ids: "searxng" }),
      JSON.stringify({ ids: ["searxng"], extra: 1 }),
      JSON.stringify([1]),
    ]
    for (const body of cases) {
      writeFileSync(toolHealthRecheckPath(h), body)
      expect(takeRecheckRequest(h, KNOWN)).toMatchObject({ kind: "invalid", reason: "ENTRY_INVALID" })
      expect(existsSync(toolHealthRecheckPath(h))).toBe(false)
    }
    writeFileSync(toolHealthRecheckPath(h), JSON.stringify({ ids: ["searxng"] }))
    expect(takeRecheckRequest(h, KNOWN, { getuid: () => 4242 })).toMatchObject({ kind: "invalid", reason: "ENTRY_INVALID" })
  })
})

describe("SEC-05 consent manual: agent re-check probes, person trigger revives", () => {
  test("recheck.json naming a dead manual component leaves it dead CONSENT_MANUAL; the menu trigger revives it", async () => {
    const h = home()
    writeFileSync(
      join(toolHealthDir(h), "state.json"),
      JSON.stringify({
        version: 1,
        updatedAt: 1,
        appVersion: "1.2.6",
        components: { "manual-tool": { lastStatus: "healthy", reason: "OK", detail: "", lastCheckedAt: 1, lastHealthyAt: 1, source: "user" } },
      }),
    )
    let up = false
    const revives: string[] = []
    const component: ResolvedToolHealthComponent = {
      id: "manual-tool",
      label: "Manual tool",
      probe: { kind: "file", path: "/nowhere" },
      revive: { argv: ["/bin/sh"] },
      startup: "probe",
      consent: "manual",
      source: "user",
      reviveTimeoutMs: 4000,
    }
    const th = createToolHealth({
      home: h,
      platform: "darwin",
      isPackaged: true,
      appPath: "/tmp/app",
      log: () => undefined,
      defer: async () => undefined,
      watch: () => ({ close: () => undefined, on: () => undefined as never }),
      resolveRegistry: () => [component],
      probe: async (): Promise<ProbeResult> => (up ? { healthy: true, reason: "OK", detail: "ok" } : { healthy: false, reason: "FILE_MISSING", detail: "gone" }),
      spawn: ((cmd: string) => {
        revives.push(cmd)
        up = true
        const { EventEmitter } = require("node:events")
        const child = new EventEmitter()
        setTimeout(() => child.emit("close", 0), 0)
        return child
      }) as never,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 1))),
    })
    await th.runStartup()
    expect(readToolHealthState(h).state.components["manual-tool"]!.reason).toBe("CONSENT_MANUAL")

    writeFileSync(toolHealthRecheckPath(h), JSON.stringify({ ids: ["manual-tool"] }))
    await th.takeRequestFile()
    const afterAgent = readToolHealthState(h).state.components["manual-tool"]!
    expect(afterAgent.lastStatus).toBe("dead")
    expect(afterAgent.reason).toBe("CONSENT_MANUAL")
    expect(revives).toEqual([])

    await th.recheck(["manual-tool"])
    const afterPerson = readToolHealthState(h).state.components["manual-tool"]!
    expect(afterPerson.lastStatus).toBe("revived")
    expect(revives).toEqual(["/bin/sh"])
    th.stop()
  })
})
