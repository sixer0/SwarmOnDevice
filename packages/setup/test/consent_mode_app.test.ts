// Row 221b (G-U14 Q2): `--consent-mode app` makes consent.log record `mode: app` instead of
// `mode: non-interactive`. The flag is a label on a token grant, never an acceptance channel:
//   - parse: valid only on `install --non-interactive` with at least one --terms-token; anything
//     else is refused at parse time (RESULT FAILED, exit 1 — the register's usage refusal);
//   - consent: the token gate is unchanged (missing or wrong token still refuses, nothing recorded);
//   - selection: the flag never changes which components are offered or granted;
//   - --help lists a line starting `  --consent-mode app` (the desktop runner probes for it,
//     packages/desktop/src/main/setup-runner.ts).
// Zero network: fetch is counted, and HOME is a throwaway dir per test.
//
// Run: cd packages/setup && bun test test/consent_mode_app.test.ts

import { describe, it, expect, beforeAll, afterAll, beforeEach, spyOn } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isolateSourceLock } from "./lockPosture.ts"
import { parseArgs } from "../src/cli.ts"
import { evaluateConsent, computeLockSha256, expectedTokenValue } from "../src/consent.ts"
import { loadLock, type LockFile } from "../src/lockfile.ts"
import { main } from "../src/index.ts"

const ORIGINAL_HOME = process.env.HOME
const INDEX = join(import.meta.dir, "..", "src", "index.ts")
let releaseLockPosture: (() => void) | undefined
let fetchCalls = 0
const realFetch = globalThis.fetch

beforeAll(() => {
  releaseLockPosture = isolateSourceLock()
  globalThis.fetch = ((...args: unknown[]) => {
    fetchCalls++
    return (realFetch as (...a: unknown[]) => unknown)(...args) as Promise<Response>
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  releaseLockPosture?.()
  if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME
})

let home = ""
let lock: LockFile
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "swarm-r221b-home-"))
  process.env.HOME = home
  fetchCalls = 0
  const loaded = loadLock()
  if (!loaded.ok) throw new Error(`lock must load in the harness: ${loaded.error}`)
  lock = loaded.lock
})

function consentLines(): Record<string, string>[] {
  const path = join(home, ".swarm/setup/consent.log")
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, string>)
}

const TOKEN = "node=node@000000000000"

describe("parse: --consent-mode app is accepted only with install --non-interactive + tokens", () => {
  it("accepts both spellings and sets appConsent", () => {
    for (const argv of [
      ["install", "node", "--non-interactive", "--terms-token", TOKEN, "--consent-mode", "app"],
      ["--consent-mode=app", "install", "node", "--non-interactive", `--terms-token=${TOKEN}`],
    ]) {
      const r = parseArgs(argv)
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.cmd.appConsent).toBe(true)
        expect(r.cmd.components).toEqual(["node"])
      }
    }
  })

  it("without the flag appConsent is false", () => {
    const r = parseArgs(["install", "node", "--non-interactive", "--terms-token", TOKEN])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.cmd.appConsent).toBe(false)
  })

  it("refuses without --non-interactive, without tokens, or on another verb", () => {
    for (const argv of [
      ["install", "node", "--terms-token", TOKEN, "--consent-mode", "app"],
      ["install", "node", "--non-interactive", "--consent-mode", "app"],
      ["install", "node", "--consent-mode", "app"],
      ["status", "--non-interactive", "--terms-token", TOKEN, "--consent-mode", "app"],
      ["remove", "node", "--non-interactive", "--terms-token", TOKEN, "--consent-mode", "app"],
      ["wire", "--non-interactive", "--terms-token", TOKEN, "--consent-mode", "app"],
    ]) {
      const r = parseArgs(argv)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain("--consent-mode app is valid only with install --non-interactive")
    }
  })

  it("with no verb at all it is refused as a missing verb", () => {
    const r = parseArgs(["--consent-mode", "app"])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toStartWith("missing command verb")
  })

  it("refuses any value other than app, and a missing value", () => {
    for (const argv of [
      ["install", "node", "--non-interactive", "--terms-token", TOKEN, "--consent-mode", "interactive"],
      ["install", "node", "--non-interactive", "--terms-token", TOKEN, "--consent-mode=APP"],
      ["install", "node", "--non-interactive", "--terms-token", TOKEN, "--consent-mode"],
    ]) {
      const r = parseArgs(argv)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe('--consent-mode accepts only "app"')
    }
  })
})

describe("consent: app mode changes the recorded mode only", () => {
  it("a valid token grant records mode=app with the token as evidence", () => {
    const tok = expectedTokenValue("node", computeLockSha256())
    const r = evaluateConsent({ selected: ["node"], nonInteractive: true, appConsent: true, tokens: { node: tok }, lock })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.consented).toEqual(["node"])
    const lines = consentLines()
    expect(lines.map((l) => [l.component, l.mode, l.token])).toEqual([["node", "app", tok]])
    expect(fetchCalls).toBe(0)
  })

  it("without appConsent the same grant still records mode=non-interactive", () => {
    const tok = expectedTokenValue("node", computeLockSha256())
    const r = evaluateConsent({ selected: ["node"], nonInteractive: true, tokens: { node: tok }, lock })
    expect(r.ok).toBe(true)
    expect(consentLines().map((l) => l.mode)).toEqual(["non-interactive"])
  })

  it("the gate is not weakened: wrong or missing tokens refuse and record nothing", () => {
    const wrong = evaluateConsent({
      selected: ["node"],
      nonInteractive: true,
      appConsent: true,
      tokens: { node: "node@000000000000" },
      lock,
    })
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.token).toBe("REFUSED_NON_INTERACTIVE")
    const missing = evaluateConsent({
      selected: ["node", "graft"],
      nonInteractive: true,
      appConsent: true,
      tokens: { node: expectedTokenValue("node", computeLockSha256()) },
      lock,
    })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.token).toBe("REFUSED_NON_INTERACTIVE")
    expect(consentLines()).toEqual([])
    expect(fetchCalls).toBe(0)
  })

  it("selection is unchanged: a token for an unselected component is ignored in app mode too", () => {
    const full = computeLockSha256()
    const r = evaluateConsent({
      selected: ["node"],
      nonInteractive: true,
      appConsent: true,
      tokens: { node: expectedTokenValue("node", full), graft: expectedTokenValue("graft", full) },
      lock,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.consented).toEqual(["node"])
    expect(consentLines().map((l) => l.component)).toEqual(["node"])
  })

  it("appConsent on the interactive path records interactive (it has no effect there)", () => {
    const r = evaluateConsent({ selected: ["rtk"], nonInteractive: false, appConsent: true, tokens: {}, lock, ask: () => "y" })
    expect(r.ok).toBe(true)
    expect(consentLines().map((l) => l.mode)).toEqual(["interactive"])
  })
})

describe("binary surface", () => {
  it("--help lists the flag on a line the desktop runner probe matches", () => {
    const out = Bun.spawnSync([process.execPath, INDEX, "--help"], { env: { ...process.env, HOME: home } })
    expect(out.exitCode).toBe(0)
    const text = out.stdout.toString()
    expect(/^\s+--consent-mode app\b/m.test(text)).toBe(true)
    expect(text).toMatch(/^ {2}--consent-mode app /m)
  })

  it("the flag without --non-interactive is refused before any gate: RESULT FAILED, exit 1, nothing written", () => {
    const out = Bun.spawnSync([process.execPath, INDEX, "install", "node", "--consent-mode", "app"], {
      env: { ...process.env, HOME: home },
      stdin: "ignore",
    })
    expect(out.exitCode).toBe(1)
    expect(out.stdout.toString()).toContain("RESULT FAILED")
    expect(out.stderr.toString()).toContain("--consent-mode app is valid only with install --non-interactive")
    expect(existsSync(join(home, ".swarm"))).toBe(false)
  })
})

// In-process `install` through main(): proves index.ts carries the flag into the consent gate. fetch
// is replaced by a stub that rejects, so the node step fails at its first download attempt and
// nothing leaves the host; the consent line is written before that point by construction.
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

async function installNode(extra: readonly string[]): Promise<{ code: number; downloads: number }> {
  const tok = expectedTokenValue("node", computeLockSha256())
  let downloads = 0
  const saved = globalThis.fetch
  globalThis.fetch = (() => {
    downloads++
    return Promise.reject(new Error("network disabled in row 221b test"))
  }) as unknown as typeof fetch
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  const errSpy = spyOn(console, "error").mockImplementation(() => {})
  const exitSpy = spyOn(process, "exit").mockImplementation(((code: number) => {
    throw new ExitSignal(code)
  }) as never)
  let code = -1
  try {
    await main(["install", "node", "--non-interactive", "--terms-token", `node=${tok}`, ...extra])
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e
    code = e.code
  } finally {
    logSpy.mockRestore()
    errSpy.mockRestore()
    exitSpy.mockRestore()
    globalThis.fetch = saved
  }
  return { code, downloads }
}

describe("install through main(): the flag reaches consent.log, nothing else changes", () => {
  it("with --consent-mode app the line records mode=app", async () => {
    await installNode(["--consent-mode", "app"])
    expect(consentLines().map((l) => [l.component, l.mode])).toEqual([["node", "app"]])
  })

  it("without it the line records mode=non-interactive, and both runs attempt the same work", async () => {
    const plain = await installNode([])
    expect(consentLines().map((l) => [l.component, l.mode])).toEqual([["node", "non-interactive"]])
    home = mkdtempSync(join(tmpdir(), "swarm-r221b-home-"))
    process.env.HOME = home
    const app = await installNode(["--consent-mode", "app"])
    expect(app).toEqual(plain)
  })
})
