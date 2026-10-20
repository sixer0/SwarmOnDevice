// Row-87 unit tests for the private pinned Node step (src/steps/node/). NO network anywhere:
// the download path is exercised through the row-84 fetchImpl seam delivering a staged FAKE
// .tar.gz built with the real /usr/bin/tar INSIDE the throwaway HOME's tool dir (so removal
// boundary logic sees a realistic layout), and every digest is genuine. The fake binary is
// NEVER executed: the healthRunner seam records the exact absolute path handed to it (that
// record IS part of the resolver-path proof) and returns the pinned version string. The REAL
// private-binary invocation happens exactly once, in the opt-in proof (node.proofs.sh P5).
//
// HOME is pointed at a throwaway dir per test (paths.ts honors $HOME), so every write lands
// in the sandbox and the real user home is untouched. No port literal appears anywhere in
// this file or its fixtures (PORT RULE / PORT BLOCK 902x — Node serves nothing).
// The shipped lock is staged into src/ for the source-run posture exactly as rows 82/83/84
// do, then removed.
//
// Run TARGETED (row 102 owns the full suite on this host):
//   bash packages/setup/test/node.proofs.sh
// or: cd packages/setup && bun test test/node.test.ts

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import {
  appendFileSync,
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
import step, {
  nodeBin,
  nodeChildEnv,
  nodeVersionFromLock,
  npmCacheDir,
  readInstallRecord,
  type NodeStepOptions,
} from "../src/steps/node/index.ts"
import { defaultState, readState, writeState, type StateFile } from "../src/state.ts"
import { loadLock, type LockFile } from "../src/lockfile.ts"
import { computeFileDigest } from "../src/verify.ts"
import { OUTCOME } from "../src/outcomes.ts"
import type { FetchResult } from "../src/fetch.ts"

// ---- source-run lock posture (same harness trick as rows 82/83/84) -----------------------
const SHIPPED_LOCK = join(import.meta.dir, "..", "tools.lock.json")
const SRC_LOCK = join(import.meta.dir, "..", "src", "tools.lock.json")
let stagedLock = false
let SHIPPED: LockFile

beforeAll(() => {
  if (!existsSync(SRC_LOCK)) {
    copyFileSync(SHIPPED_LOCK, SRC_LOCK)
    stagedLock = true
  }
  const loaded = loadLock()
  if (!loaded.ok) throw new Error(`loadLock failed in test setup: ${loaded.error}`)
  SHIPPED = loaded.lock
})
afterAll(() => {
  if (stagedLock) rmSync(SRC_LOCK, { force: true })
})

const FAKE_VERSION = "v9.9.9-fake" // synthetic pin — no ports, no hosts beyond the allow-listed name
const TOOL_ROOT = (home: string) => join(home, ".swarm", "tools", "node")
const VERSION_DIR = (home: string) => join(TOOL_ROOT(home), FAKE_VERSION)
const BIN_PATH = (home: string) => join(VERSION_DIR(home), "bin", "node")
const TARBALL_NAME = `node-${FAKE_VERSION}-darwin-arm64.tar.gz`

function freshHome(label: string): string {
  const home = mkdtempSync(join(tmpdir(), `swarm-r87-${label}-`))
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

function envSnapshot(): string {
  return JSON.stringify(Object.entries(process.env).sort((a, b) => a[0].localeCompare(b[0])))
}

interface Fixture {
  path: string
  sha256: string
  bytes: number
  binarySha256: string
}

/** Build a REAL .tar.gz mirroring the official Node darwin-arm64 layout (one top-level dir
 *  containing bin/node + a filler) and place it where the real fetch would promote it:
 *  inside the tool root of the CURRENT throwaway HOME. */
function buildFakeTarball(label: string, home: string): Fixture {
  const stage = mkdtempSync(join(tmpdir(), `swarm-r87-stage-${label}-`))
  const top = join(stage, `node-${FAKE_VERSION}-darwin-arm64`)
  mkdirSync(join(top, "bin"), { recursive: true })
  // A stand-in binary: plain text. Units never execute it (healthRunner seam records instead).
  writeFileSync(join(top, "bin", "node"), `#!/bin/sh\necho ${FAKE_VERSION}\n`, { mode: 0o755 })
  writeFileSync(join(top, "LICENSE"), "MIT-style placeholder for the fake archive\n")
  mkdirSync(TOOL_ROOT(home), { recursive: true })
  const tarPath = join(TOOL_ROOT(home), TARBALL_NAME)
  const r = Bun.spawnSync(["/usr/bin/tar", "-czf", tarPath, "-C", stage, `node-${FAKE_VERSION}-darwin-arm64`], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (r.exitCode !== 0) throw new Error(`fixture tar failed: ${r.stderr}`)
  const digest = computeFileDigest(tarPath, "sha256")
  const binarySha = computeFileDigest(join(top, "bin", "node"), "sha256").hex
  return { path: tarPath, sha256: digest.hex, bytes: digest.sizeBytes, binarySha256: binarySha }
}

/** A lock shaped exactly like the shipped node pin but pointing at the fake version. */
function fakeLock(fixture: { sha256: string; bytes: number }): LockFile {
  return {
    schemaVersion: 1,
    version: "test-lock-r87",
    hosts: ["nodejs.org"],
    components: {
      node: {
        install_dir: "~/.swarm/tools/node",
        url: `https://nodejs.org/dist/${FAKE_VERSION}/node-${FAKE_VERSION}-darwin-arm64.tar.gz`,
        version: FAKE_VERSION,
        codename: "Testfake",
        size: fixture.bytes,
        tarball_sha256: fixture.sha256,
      },
    },
    raw: {},
  }
}

interface Spy {
  calls: number
  sawDryRun: boolean
  impl: typeof import("../src/fetch.ts").fetchArtifact
}

/** Instrumented fetchImpl (network-proxy counter + fixture delivery), r84 spy discipline. */
function fetchSpy(destPath: string, status: "fetched" | "resumed" | "dry_run" = "fetched"): Spy {
  const spy: Spy = {
    calls: 0,
    sawDryRun: false,
    impl: (async (_l: LockFile, _id: string, opts?: { dryRun?: boolean }) => {
      spy.calls += 1
      spy.sawDryRun = opts?.dryRun === true
      const artifact = {
        component: "node",
        artifact: "node",
        url: "https://nodejs.org/dist/x/y",
        host: "nodejs.org",
        version: FAKE_VERSION,
        expected: { algorithm: "sha256" as const, hex: "ab".repeat(32), pin: "ab".repeat(32) },
      }
      const res: FetchResult =
        status === "dry_run"
          ? { status: "dry_run", artifact, destPath, wouldDownload: true }
          : status === "resumed"
            ? { status: "resumed", artifact, destPath, bytes: 1, attempts: 0 }
            : { status: "fetched", artifact, destPath, bytes: 1, attempts: 1, elapsedMs: 1 }
      return res
    }) as unknown as typeof import("../src/fetch.ts").fetchArtifact,
  }
  return spy
}

/** Health seam that RECORDS the exact path instead of executing the fake binary. */
function healthSpy(versionOutput: string = FAKE_VERSION): {
  seen: string[]
  runner: NonNullable<NodeStepOptions["healthRunner"]>
} {
  const seen: string[] = []
  return {
    seen,
    runner: (binPath: string) => (
      seen.push(binPath),
      { ok: true, versionOutput, detail: "recorded (fake binary never executed)" }
    ),
  }
}

function ctxOf(lock: LockFile, state?: StateFile, dryRun = false) {
  return { lock, state: state ?? defaultState(lock.version), dryRun }
}

/** Install with the granted-path seams wired (r84 discipline: drives the consented branch
 *  without fabricating consent out-of-band — nothing here writes consent.log). */
async function grantedInstall(
  home: string,
  lock: LockFile,
  destPath: string,
  extra: NodeStepOptions = {},
  dryRun = false,
  status: "fetched" | "resumed" | "dry_run" = "fetched",
) {
  const spy = fetchSpy(destPath, status)
  const health = healthSpy()
  const res = await step.install(ctxOf(lock, undefined, dryRun), {
    provenancePath: join(home, "prov.jsonl"),
    logPath: join(home, "setup.log"),
    consentGate: () => true,
    fetchImpl: spy.impl,
    healthRunner: health.runner,
    ...extra,
  })
  return { res, spy, health }
}

describe("(a) consent gate refuses before fetch AND before any filesystem touch", () => {
  it("REFUSED_NO_CONSENT with zero fetch calls and an untouched HOME tree", async () => {
    const home = freshHome("a1")
    const fixture = buildFakeTarball("a1", home)
    const spy = fetchSpy(fixture.path)
    const res = await step.install(ctxOf(fakeLock(fixture)), {
      provenancePath: join(home, "prov.jsonl"),
      fetchImpl: spy.impl, // the granted path is NOT taken: refusal must precede the downloader
    })
    expect(res.token).toBe(OUTCOME.REFUSED_NO_CONSENT)
    expect(spy.calls).toBe(0)
    // Refusal precedes even the tool dir: only the test-staged tarball remains visible.
    expect(existsSync(join(home, ".swarm", "setup"))).toBe(false)
    expect(tree(join(home, ".swarm", "tools", "node"))).toEqual([`${TARBALL_NAME}:${fixture.bytes}`])
  })
})

describe("(b) fresh install: atomic private extraction, record, pointer, lifecycle", () => {
  it("lands <root>/<version>/bin/node with exec bit + install record + pointer + npm-cache + healthy state", async () => {
    const home = freshHome("b1")
    const envBefore = envSnapshot()
    const fixture = buildFakeTarball("b1", home)
    const lock = fakeLock(fixture)
    const { res, spy, health } = await grantedInstall(home, lock, fixture.path)

    expect(res.token).toBe(OUTCOME.OK)
    expect(spy.calls).toBe(1) // exactly one network-proxy call for a cold install

    const binPath = BIN_PATH(home)
    expect(health.seen).toEqual([binPath]) // the step probed EXACTLY the private absolute path
    expect(existsSync(binPath)).toBe(true)
    expect(statSync(binPath).mode & 0o111).not.toBe(0) // exec bit set inside ~/.swarm

    const record = readInstallRecord(VERSION_DIR(home))
    expect(record).not.toBeNull()
    if (record) {
      expect(record.version).toBe(FAKE_VERSION)
      expect(record.codename).toBe("Testfake")
      expect(record.tarballSha256).toBe(fixture.sha256)
      expect(record.observedTarballSha256).toBe(fixture.sha256)
      expect(record.nodeBinarySha256).toBe(computeFileDigest(binPath, "sha256").hex)
      expect(record.paths).toContain(VERSION_DIR(home))
      expect(record.paths).toContain(fixture.path)
      expect(record.paths).toContain(npmCacheDir())
    }

    expect(existsSync(join(TOOL_ROOT(home), "current.json"))).toBe(true)
    expect(existsSync(npmCacheDir())).toBe(true) // 01d:301-303 redirect target created once

    const onDisk = readState(lock.version)
    expect(onDisk.ok).toBe(true)
    if (onDisk.ok) {
      const n = onDisk.state.components.node
      expect(n.state).toBe("healthy")
      expect(n.installedBySwarm).toBe(true)
      expect(n.version).toBe(FAKE_VERSION)
      expect(n.integrity).toBe(`sha256:${fixture.binarySha256}`)
      expect(n.paths?.length).toBe(5)
    }

    // Provenance ledger received the install row (the fetch row would come from the real
    // library; the spy stands in for it here — the real pair lands in proofs P5).
    const lines = readFileSync(join(home, "prov.jsonl"), "utf8").trim().split("\n")
    expect(lines.length).toBe(1)
    const last = JSON.parse(lines[0] as string) as Record<string, unknown>
    expect(last.component).toBe("node")
    expect(last.destPath).toBe(binPath)

    // PATH-cleanliness layer 1: the WHOLE environment is byte-identical after an install.
    expect(envSnapshot()).toBe(envBefore)
  })
})

describe("(c) idempotence: resume-on-valid performs ZERO network", () => {
  it("second install over a valid tree never reaches the downloader", async () => {
    const home = freshHome("c1")
    const fixture = buildFakeTarball("c1", home)
    const lock = fakeLock(fixture)
    await grantedInstall(home, lock, fixture.path)

    // Fresh seams, state re-read from disk (engine posture); the spy must stay at ZERO.
    const spy = fetchSpy(fixture.path)
    const health = healthSpy()
    const stateOnDisk = readState(lock.version)
    expect(stateOnDisk.ok).toBe(true)
    const res = await step.install(ctxOf(lock, stateOnDisk.ok ? stateOnDisk.state : undefined), {
      provenancePath: join(home, "prov.jsonl"),
      consentGate: () => true,
      fetchImpl: spy.impl,
      healthRunner: health.runner,
    })
    expect(res.token).toBe(OUTCOME.OK)
    expect(res.message ?? "").toContain("resumed")
    expect(spy.calls).toBe(0) // §6.3: valid existing install -> zero network attempts
    expect(health.seen).toEqual([]) // adoption does not re-probe either
    expect(computeFileDigest(BIN_PATH(home), "sha256").hex).toBe(fixture.binarySha256) // untouched
  })
})

describe("(d) tamper-replace: digest-vs-record mismatch forces replacement from the verified tarball", () => {
  it("tampered binary is detected by sha, refused by the resolver, and replaced on re-install", async () => {
    const home = freshHome("d1")
    const fixture = buildFakeTarball("d1", home)
    const lock = fakeLock(fixture)
    await grantedInstall(home, lock, fixture.path)

    appendFileSync(BIN_PATH(home), "\n# TAMPERED BY TEST\n") // simulate post-install corruption

    // The resolver refuses to hand out a tampered binary (tamper-aware proof).
    const refused = nodeBin({ lock })
    expect(refused.ok).toBe(false)
    expect(refused.reason ?? "").toContain("install record")

    const { res, spy } = await grantedInstall(home, lock, fixture.path) // re-install replaces it
    expect(res.token).toBe(OUTCOME.OK)
    expect(spy.calls).toBe(1) // fetch reached again (real lib would resume from the intact tarball)
    expect(computeFileDigest(BIN_PATH(home), "sha256").hex).toBe(fixture.binarySha256) // restored
    expect(nodeBin({ lock }).ok).toBe(true) // usable again

    // Atomic replace left no debris and exactly ONE version dir plus the known siblings.
    const names = readdirSync(TOOL_ROOT(home))
      .filter((n) => !n.startsWith("."))
      .sort()
    expect(names).toEqual([TARBALL_NAME, FAKE_VERSION, "current.json", "npm-cache"].sort())
    expect(
      readdirSync(TOOL_ROOT(home)).filter((n) => n.startsWith(".quarantine-") || n.startsWith(".extract-")),
    ).toEqual([])
  })
})

describe("(e) resolver path proof for rows 88/89", () => {
  it("nodeBin returns the exact absolute private path and works with an EMPTY PATH", async () => {
    const home = freshHome("e1")
    const fixture = buildFakeTarball("e1", home)
    const lock = fakeLock(fixture)
    await grantedInstall(home, lock, fixture.path)

    const expected = join(home, ".swarm", "tools", "node", FAKE_VERSION, "bin", "node")
    const first = nodeBin({ lock })
    expect(first.ok).toBe(true)
    expect(first.path).toBe(expected)
    expect((first.path ?? "").startsWith("/")).toBe(true) // absolute by contract

    // PATH-independence: resolution cannot be a PATH lookup because it survives PATH="".
    const savedPath = process.env.PATH
    process.env.PATH = ""
    const noPath = nodeBin({ lock })
    process.env.PATH = "/nonexistent-dir-for-proof"
    const bogusPath = nodeBin({ lock })
    if (savedPath === undefined) delete process.env.PATH
    else process.env.PATH = savedPath
    expect(noPath.path).toBe(expected)
    expect(bogusPath.path).toBe(expected)

    // Not installed -> honest refusal naming the path, never a system-node fallback.
    const missing = nodeBin({ lock, installRoot: join(home, "nowhere") })
    expect(missing.ok).toBe(false)
    expect(missing.reason ?? "").toContain("not installed")
  })

  it("the shipped lock pins v24.22.0 (Krypton) — the version rows 88/89 will resolve", () => {
    const v = nodeVersionFromLock(SHIPPED)
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.version).toBe("v24.22.0")
  })
})

describe("(f) zero PATH mutation: neither the install nor nodeChildEnv touches any PATH value", () => {
  it("process.env is byte-identical across a full install; child env copies PATH verbatim", async () => {
    const home = freshHome("f1")
    const envBefore = envSnapshot()
    const fixture = buildFakeTarball("f1", home)
    await grantedInstall(home, fakeLock(fixture), fixture.path)
    expect(envSnapshot()).toBe(envBefore) // no PATH prepend/append/export anywhere

    const base = { PATH: "/usr/bin:/bin", HOME: "/tmp/r87-base", ZDOTDIR: "/tmp/keep" }
    const env = nodeChildEnv(base, "/tmp/r87-root")
    expect(env.PATH).toBe("/usr/bin:/bin") // copied VERBATIM — the private node needs no PATH entry
    expect(env.npm_config_cache).toBe(join("/tmp", "r87-root", "npm-cache"))
    expect(base.PATH).toBe("/usr/bin:/bin") // input object not mutated
    expect((base as Record<string, string>).npm_config_cache).toBeUndefined() // nor extended
  })
})

describe("(g) dry-run: zero filesystem writes on both the absent and the valid posture", () => {
  it("absent install under --dry-run leaves the ENTIRE HOME tree empty", async () => {
    const home = freshHome("g1")
    // Nothing is staged at all: the spy merely NAMES where a tarball would land.
    const wouldBe = join(TOOL_ROOT(home), TARBALL_NAME)
    const lock = fakeLock({ sha256: "ab".repeat(32), bytes: 1 })
    const { res, spy } = await grantedInstall(home, lock, wouldBe, {}, true, "dry_run")
    expect(res.token).toBe(OUTCOME.OK)
    expect(spy.sawDryRun).toBe(true) // propagated into row 82's own zero-write posture
    expect(existsSync(join(home, ".swarm"))).toBe(false)
    expect(tree(home)).toEqual([]) // no state.json, no setup.log, no prov ledger, no tool dir
  })

  it("valid install under --dry-run reports resume and changes nothing on disk", async () => {
    const home = freshHome("g2")
    const fixture = buildFakeTarball("g2", home)
    const lock = fakeLock(fixture)
    await grantedInstall(home, lock, fixture.path)
    const before = tree(home)
    const { res } = await grantedInstall(home, lock, fixture.path, {}, true)
    expect(res.token).toBe(OUTCOME.OK)
    expect(res.message ?? "").toContain("already installed")
    expect(tree(home)).toEqual(before) // byte-for-byte identical listing incl. sizes
  })
})

describe("(h) remove: deletes ONLY state-listed paths inside the tool root", () => {
  it("deletes version dir, pointer, tarball and cache; an unlisted sibling survives; second remove skips", async () => {
    const home = freshHome("h1")
    const fixture = buildFakeTarball("h1", home)
    const lock = fakeLock(fixture)
    await grantedInstall(home, lock, fixture.path)
    const keepMe = join(TOOL_ROOT(home), "user-left-behind.txt")
    writeFileSync(keepMe, "not in any state manifest\n")

    const stateOnDisk = readState(lock.version)
    expect(stateOnDisk.ok).toBe(true)
    const res = step.remove(ctxOf(lock, stateOnDisk.ok ? stateOnDisk.state : undefined), {
      provenancePath: join(home, "prov.jsonl"),
    })
    expect(res.token).toBe(OUTCOME.OK)

    expect(existsSync(VERSION_DIR(home))).toBe(false)
    expect(existsSync(join(TOOL_ROOT(home), "current.json"))).toBe(false)
    expect(existsSync(fixture.path)).toBe(false) // the tarball was state-listed too
    expect(existsSync(npmCacheDir())).toBe(false)
    expect(existsSync(keepMe)).toBe(true) // NEVER delete what the state file does not list

    const after = readState(lock.version)
    if (after.ok) {
      expect(after.state.components.node.state).toBe("absent")
      expect(after.state.components.node.installedBySwarm).toBe(false)
      expect(after.state.components.node.paths).toBeUndefined()
    }

    const again = step.remove(ctxOf(lock, after.ok ? after.state : undefined))
    expect(again.token).toBe(OUTCOME.SKIPPED)
    expect(existsSync(keepMe)).toBe(true)
  })

  it("a pre-existing install the setup did not create is SKIPPED, never deleted", async () => {
    const home = freshHome("h2")
    const lock = fakeLock({ sha256: "cd".repeat(32), bytes: 10 })
    const state = defaultState(lock.version)
    state.components.node = { state: "healthy", version: FAKE_VERSION } // installedBySwarm ABSENT
    writeState(state)
    mkdirSync(BIN_PATH(home), { recursive: true }) // someone else's node lives here
    const res = step.remove(ctxOf(lock, state))
    expect(res.token).toBe(OUTCOME.SKIPPED)
    expect(existsSync(BIN_PATH(home))).toBe(true) // byte-untouched
  })

  it("a state-listed path OUTSIDE the tool root is refused and survives (P-14/P-16 boundary)", async () => {
    const home = freshHome("h3")
    const fixture = buildFakeTarball("h3", home)
    const lock = fakeLock(fixture)
    await grantedInstall(home, lock, fixture.path)
    const outside = join(home, "precious.txt")
    writeFileSync(outside, "listed maliciously in a doctored state\n")

    const state = readState(lock.version)
    expect(state.ok).toBe(true)
    if (state.ok) {
      state.state.components.node = {
        ...state.state.components.node,
        paths: [...(state.state.components.node.paths ?? []), outside],
      }
      writeState(state.state) // doctored through the engine's own commit point
    }
    const res = step.remove(ctxOf(lock, state.ok ? state.state : undefined), { logPath: join(home, "setup.log") })
    expect(res.token).toBe(OUTCOME.OK)
    expect(existsSync(outside)).toBe(true) // outside-root entries are refused, not deleted
    expect(existsSync(VERSION_DIR(home))).toBe(false) // listed inside-root paths still go
  })
})

describe("(i) extraction failure: nothing is promoted, lifecycle records failed, no debris", () => {
  it("extractor seam failure leaves no version dir and no temp dirs", async () => {
    const home = freshHome("i1")
    const fixture = buildFakeTarball("i1", home)
    const lock = fakeLock(fixture)
    const { res } = await grantedInstall(home, lock, fixture.path, {
      extractor: () => ({ ok: false, detail: "injected tar failure (unit)" }),
    })
    expect(res.token).toBe(OUTCOME.FAILED)
    expect(existsSync(VERSION_DIR(home))).toBe(false)
    expect(
      readdirSync(TOOL_ROOT(home)).filter((n) => n.startsWith(".extract-") || n.startsWith(".quarantine-")),
    ).toEqual([])
    const st = readState(lock.version)
    if (st.ok) expect(st.state.components.node.state).toBe("failed")
  })
})

describe("(j) real spawn plumbing end-to-end (no seams on extract OR health)", () => {
  it("default extractor AND default health runner work against the shebang fixture binary", async () => {
    // The fixture bin/node is a REAL /bin/sh script with a shebang, so the UNSEAMED health
    // runner genuinely spawns it and reads its stdout. This test exists because bun 1.3.14
    // returns piped stdout as Buffer (not string) and the first real-extraction run caught
    // the missing normalization — units must cover the real spawn path too, not only seams.
    const home = freshHome("j1")
    const fixture = buildFakeTarball("j1", home)
    const lock = fakeLock(fixture)
    const spy = fetchSpy(fixture.path)
    const res = await step.install(ctxOf(lock), {
      provenancePath: join(home, "prov.jsonl"),
      consentGate: () => true,
      fetchImpl: spy.impl,
      // NO extractor seam, NO healthRunner seam: real /usr/bin/tar + real spawn of the
      // test-authored shell fixture. Nothing downloaded, nothing foreign executed.
    })
    expect(res.token).toBe(OUTCOME.OK) // --version output equals the pinned fake version
    expect(res.message ?? "").toContain("installed privately")
    expect(nodeBin({ lock }).ok).toBe(true)
  })
})
