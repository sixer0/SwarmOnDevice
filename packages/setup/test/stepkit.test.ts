// Row-84 unit tests for the step-engine helpers (stepkit.ts) and the redacting
// setup.log writer (setuplog.ts). NO network anywhere: the fetch path is exercised
// through an instrumented spy (call-counting) so "zero network without consent" and
// "dry-run propagated" are MEASURED, not asserted by reading code. HOME is pointed at
// a throwaway dir per test (paths.ts honors $HOME), so setup.log/state.json land in the
// sandbox and the real user home is untouched. The shipped lock is staged into src/ for
// the source-run posture exactly as rows 82/83 do, then removed.
//
// Run TARGETED (row 102 owns the full suite on this host):
//   bash packages/setup/test/stepkit.proofs.sh
// or: cd packages/setup && bun test test/stepkit.test.ts

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStepKit, stepOutcomeFromFetch, policyMalformedOutcome, outcomeTokenFor } from "../src/stepkit.ts"
import { redact, writeSetupLog, registerSecretValue, clearRegisteredSecrets, keyIsSecret } from "../src/setuplog.ts"
import { defaultState, readState } from "../src/state.ts"
import { loadLock, type LockFile } from "../src/lockfile.ts"
import { OUTCOME } from "../src/outcomes.ts"
import type { ComponentId } from "../src/constants.ts"

// ---- source-run lock posture (same harness trick as rows 82/83) -----------------------
const SHIPPED_LOCK = join(import.meta.dir, "..", "tools.lock.json")
const SRC_LOCK = join(import.meta.dir, "..", "src", "tools.lock.json")
let stagedLock = false
let LOCK: LockFile

beforeAll(() => {
  if (!existsSync(SRC_LOCK)) {
    copyFileSync(SHIPPED_LOCK, SRC_LOCK)
    stagedLock = true
  }
  const loaded = loadLock()
  if (!loaded.ok) throw new Error(`loadLock failed in test setup: ${loaded.error}`)
  LOCK = loaded.lock
})
afterAll(() => {
  if (stagedLock) rmSync(SRC_LOCK, { force: true })
})

function freshHome(label: string): string {
  const home = mkdtempSync(join(tmpdir(), `swarm-r84-${label}-`))
  process.env.HOME = home
  return home
}

/** Recursive relative-path listing of a directory (empty array if it does not exist). */
function tree(dir: string, base: string = dir): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...tree(full, base))
    else out.push(`${full.slice(base.length + 1)}:${st.size}`)
  }
  return out
}

const FAKE_BEARER = "sk_live_FAKEBEARERabc123XYZ-_."
const FAKE_TERM_TOKEN = "node@deadbeefcafe" // <component_id>@<12 hex> shape (01d §6.1)
const FAKE_GENERATED = "GEN_postgres_pw_9f3a7c" // stands in for an openssl-rand secret

describe("(a) consent gate refuses execution without a grant — instrumented", () => {
  it("hasConsent() is false in a fresh process (nothing recorded)", () => {
    freshHome("a1")
    const kit = createStepKit({ componentId: "node", lock: LOCK, state: defaultState(LOCK.version), dryRun: false })
    expect(kit.hasConsent()).toBe(false)
  })

  it("kit.fetch() refuses with REFUSED_NO_CONSENT and opens ZERO network", async () => {
    freshHome("a2")
    let calls = 0
    const spy = (async () => {
      calls += 1
      return {
        status: "fetched" as const,
        artifact: {} as never,
        destPath: "/should/not/happen",
        bytes: 1,
        attempts: 1,
        elapsedMs: 1,
      }
    }) as unknown as typeof import("../src/fetch.ts").fetchArtifact
    const kit = createStepKit({
      componentId: "node",
      lock: LOCK,
      state: defaultState(LOCK.version),
      dryRun: false,
      fetchImpl: spy,
    })
    const res = await kit.fetch()
    expect(res).toEqual({ ok: false, token: OUTCOME.REFUSED_NO_CONSENT })
    expect(calls).toBe(0) // the downloader was NEVER invoked
    expect(stepOutcomeFromFetch(res)).toBe(OUTCOME.REFUSED_NO_CONSENT)
  })

  it("a granted component reaches the downloader exactly once", async () => {
    freshHome("a3")
    let calls = 0
    const spy = (async () => {
      calls += 1
      return { status: "resumed" as const, artifact: {} as never, destPath: "/x", bytes: 1, attempts: 0 }
    }) as unknown as typeof import("../src/fetch.ts").fetchArtifact
    const kit = createStepKit({
      componentId: "node",
      lock: LOCK,
      state: defaultState(LOCK.version),
      dryRun: false,
      consentGate: () => true,
      fetchImpl: spy,
    })
    const res = await kit.fetch()
    expect(calls).toBe(1)
    expect("status" in res && res.status).toBe("resumed")
    expect(stepOutcomeFromFetch(res)).toBe(OUTCOME.OK)
  })
})

describe("(b) dry-run propagates through every helper with ZERO filesystem writes", () => {
  it("no helper creates anything under $HOME; only in-memory dry markers appear", async () => {
    const home = freshHome("b1")
    let sawDryRun = false
    const spy = (async (_l: LockFile, _id: ComponentId, opts?: { dryRun?: boolean }) => {
      sawDryRun = opts?.dryRun === true
      return { status: "dry_run" as const, artifact: {} as never, destPath: "/never", wouldDownload: true as const }
    }) as unknown as typeof import("../src/fetch.ts").fetchArtifact

    const kit = createStepKit({
      componentId: "graft",
      lock: LOCK,
      state: defaultState(LOCK.version),
      dryRun: true,
      correlationId: "run-b1",
      consentGate: () => true, // drive the GRANTED path so fetch is reached under dry-run
      fetchImpl: spy,
    })

    // Exercise EVERY helper.
    kit.artifact() // zero-network pin pre-flight
    expect(kit.transition("downloaded").ok).toBe(true)
    expect(kit.transition("verified", { integrity: "sha256:aa" }).ok).toBe(true)
    kit.registerSecret(FAKE_GENERATED)
    kit.log("info", "would download graft")
    kit.log("warn", "would write config", { context: { SEARXNG_SECRET: "leak-me" } })
    kit.log("error", "would health-check")
    await kit.fetch()

    // Dry-run produced ONLY in-memory markers.
    expect(kit.dryTransitions.map((t) => `${t.from}->${t.to}`)).toEqual(["absent->downloaded", "downloaded->verified"])
    expect(kit.dryLogs.length).toBe(3)
    expect(sawDryRun).toBe(true) // dry-run flag reached row 82's library

    // Nothing was written anywhere under $HOME (the whole .swarm tree is absent).
    expect(existsSync(join(home, ".swarm"))).toBe(false)
    expect(tree(home)).toEqual([])
  })

  it("dry-run with the REAL consent gate refuses fetch too, still writing nothing", async () => {
    const home = freshHome("b2")
    let calls = 0
    const spy = (async () => {
      calls += 1
      return { status: "dry_run" as const, artifact: {} as never, destPath: "/never", wouldDownload: true as const }
    }) as unknown as typeof import("../src/fetch.ts").fetchArtifact
    const kit = createStepKit({
      componentId: "rtk",
      lock: LOCK,
      state: defaultState(LOCK.version),
      dryRun: true,
      fetchImpl: spy,
    })
    const res = await kit.fetch()
    expect(res).toEqual({ ok: false, token: OUTCOME.REFUSED_NO_CONSENT })
    expect(calls).toBe(0)
    expect(existsSync(join(home, ".swarm"))).toBe(false)
  })
})

describe("(c) redaction proof — bearer + term-token + generated secret never reach setup.log", () => {
  beforeEach(() => clearRegisteredSecrets())

  it("redact() scrubs shapes and registered literals (before/after)", () => {
    registerSecretValue(FAKE_GENERATED)
    const before = `GET https://api.example with Authorization: Bearer ${FAKE_BEARER}; token ${FAKE_TERM_TOKEN}; pw=${FAKE_GENERATED}`
    const after = redact(before)
    expect(after).not.toContain(FAKE_BEARER)
    expect(after).not.toContain("deadbeefcafe")
    expect(after).not.toContain(FAKE_GENERATED)
    expect(after).toContain("[REDACTED]")
    // The non-secret scaffolding survives so the log stays useful.
    expect(after.toLowerCase()).toContain("authorization")
    expect(after.toLowerCase()).toContain("bearer")
  })

  it("structural layer redacts secret-named context keys; line stays valid JSON", () => {
    const home = freshHome("c2")
    const path = join(home, ".swarm", "setup", "setup.log")
    registerSecretValue(FAKE_GENERATED)
    writeSetupLog(
      {
        level: "info",
        source: "swarm-setup.searxng.install",
        component: "searxng",
        message: `generated secret stored; bearer ${FAKE_BEARER}; admin token ${FAKE_TERM_TOKEN}`,
        context: { SEARXNG_SECRET: "leakme123", POSTGRES_PASSWORD: "pgsecret", engines: ["wikipedia"], port: 8888 },
        correlationId: "run-c2",
        ts: "2026-10-20T00:00:00.000Z",
      },
      { path },
    )
    const written = readFileSync(path, "utf8").trim()
    for (const secret of [FAKE_BEARER, "deadbeefcafe", FAKE_GENERATED, "leakme123", "pgsecret"]) {
      expect(written).not.toContain(secret)
    }
    const parsed = JSON.parse(written) as Record<string, unknown>
    expect(parsed.level).toBe("info")
    expect((parsed.context as Record<string, unknown>).SEARXNG_SECRET).toBe("[REDACTED]")
    expect((parsed.context as Record<string, unknown>).POSTGRES_PASSWORD).toBe("[REDACTED]")
    // Non-secret context is preserved.
    expect((parsed.context as Record<string, unknown>).port).toBe(8888)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it("keyIsSecret recognises the register inventory and rejects look-alikes", () => {
    for (const k of [
      "SEARXNG_SECRET",
      "POSTGRES_PASSWORD",
      "BULL_AUTH_KEY",
      "FIRECRAWL_API_KEY",
      "PROXY_TOKEN",
      "RABBITMQ_PASSWORD",
    ]) {
      expect(keyIsSecret(k)).toBe(true)
    }
    for (const k of ["USE_DB_AUTHENTICATION", "FIRECRAWL_API_URL", "engines", "port", "AUTHOR", "MONITOR"]) {
      expect(keyIsSecret(k)).toBe(false)
    }
  })
})

describe("(d) state-transition guard rejects illegal moves", () => {
  it("absent -> healthy is refused and commits NOTHING", () => {
    const home = freshHome("d1")
    const state = defaultState(LOCK.version)
    const kit = createStepKit({ componentId: "node", lock: LOCK, state, dryRun: false })
    const bad = kit.transition("healthy")
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain("illegal state transition")
    // Rejection wrote nothing: no state.json exists yet.
    expect(existsSync(join(home, ".swarm", "setup", "state.json"))).toBe(false)
  })

  it("the legal chain commits through state.ts; skips are refused", () => {
    const home = freshHome("d2")
    const state = defaultState(LOCK.version)
    const kit = createStepKit({ componentId: "node", lock: LOCK, state, dryRun: false })
    expect(kit.transition("downloaded").ok).toBe(true)
    // downloaded -> healthy would skip verify+install+configure+health gates.
    expect(kit.transition("healthy").ok).toBe(false)
    expect(kit.transition("verified").ok).toBe(true)
    expect(kit.transition("installed").ok).toBe(true)
    expect(kit.transition("configured").ok).toBe(true)
    expect(kit.transition("healthy").ok).toBe(true)

    const onDisk = readState(LOCK.version)
    expect(onDisk.ok).toBe(true)
    if (onDisk.ok) expect(onDisk.state.components.node.state).toBe("healthy")
    expect(existsSync(join(home, ".swarm", "setup", "state.json"))).toBe(true)
  })

  it("self-transition is idempotent and any state may reset to absent (remove)", () => {
    freshHome("d3")
    const state = defaultState(LOCK.version)
    const kit = createStepKit({ componentId: "rtk", lock: LOCK, state, dryRun: false })
    expect(kit.transition("absent").ok).toBe(true) // self
    expect(kit.transition("downloaded").ok).toBe(true)
    expect(kit.transition("downloaded").ok).toBe(true) // idempotent
    expect(kit.transition("absent").ok).toBe(true) // removal reset from a working state
  })

  it("failure and network-block are reachable from a working state; resume restarts forward", () => {
    freshHome("d4")
    const state = defaultState(LOCK.version)
    const kit = createStepKit({ componentId: "graft", lock: LOCK, state, dryRun: false })
    expect(kit.transition("downloaded").ok).toBe(true)
    expect(kit.transition("failed").ok).toBe(true)
    // §6.3: a failed component restarts at the failed transition with re-verification.
    expect(kit.transition("verified").ok).toBe(true)
    expect(kit.transition("BLOCKED_BY_NETWORK").ok).toBe(true)
    expect(kit.transition("downloaded").ok).toBe(true)
  })
})

describe("outcome-token consolidation (r82 outcomeTokenFor + r83 malformed-policy reuse)", () => {
  it("maps fetch codes through row 82's mapping", () => {
    expect(outcomeTokenFor("TIMEOUT")).toBe(OUTCOME.BLOCKED_BY_NETWORK)
    expect(outcomeTokenFor("NETWORK_ERROR")).toBe(OUTCOME.BLOCKED_BY_NETWORK)
    expect(outcomeTokenFor("NO_URL_PINNED")).toBe(OUTCOME.SKIPPED_WITH_INSTRUCTIONS)
    expect(outcomeTokenFor("HASH_MISMATCH")).toBe(OUTCOME.FAILED)
  })

  it("stepOutcomeFromFetch distinguishes refusal / failure / success", () => {
    expect(stepOutcomeFromFetch({ ok: false, token: OUTCOME.REFUSED_NO_CONSENT })).toBe(OUTCOME.REFUSED_NO_CONSENT)
    expect(stepOutcomeFromFetch({ ok: false, code: "TIMEOUT", message: "t", attempts: 2 })).toBe(
      OUTCOME.BLOCKED_BY_NETWORK,
    )
    expect(
      stepOutcomeFromFetch({
        status: "fetched",
        artifact: {} as never,
        destPath: "/x",
        bytes: 1,
        attempts: 1,
        elapsedMs: 1,
      }),
    ).toBe(OUTCOME.OK)
  })

  it("malformed policy reuses FAILED (row 83 decision; no new token invented)", () => {
    expect(policyMalformedOutcome()).toBe(OUTCOME.FAILED)
  })
})

describe("setup.log size-cap rotation keeps bounded generations at 0600", () => {
  it("rotates once the cap is exceeded and preserves history", () => {
    const home = freshHome("rot")
    const path = join(home, ".swarm", "setup", "setup.log")
    const opts = { path, maxBytes: 200, maxRotations: 2 }
    for (let i = 0; i < 12; i++) {
      writeSetupLog(
        { level: "info", source: "rot", message: `line-${i}-padding-to-grow-the-file`, ts: "2026-10-20T00:00:00.000Z" },
        opts,
      )
    }
    expect(existsSync(path)).toBe(true)
    expect(existsSync(`${path}.1`)).toBe(true)
    expect(existsSync(`${path}.2`)).toBe(true)
    expect(existsSync(`${path}.3`)).toBe(false) // maxRotations=2 caps generations
    expect(statSync(path).size).toBeLessThanOrEqual(200)
    for (const p of [path, `${path}.1`, `${path}.2`]) expect(statSync(p).mode & 0o777).toBe(0o600)
  })
})
