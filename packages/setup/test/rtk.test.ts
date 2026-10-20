// Row-89 unit tests for the private rtk-oss step (src/steps/rtk/). NO network anywhere:
// the download path is exercised through the row-84 fetchImpl seam delivering a staged FAKE
// .tar.gz built with the real /usr/bin/tar INSIDE the throwaway HOME's tool dir (so removal
// boundary logic sees a realistic layout), and every digest is genuine. The fake binary is
// NEVER executed except in test (j), which runs the REAL spawn plumbing against a
// test-authored shebang script — the same discipline row 87 froze. The REAL Mach-O artifact
// (codesign + Gatekeeper + --version on the genuine rtk-oss binary) is exercised exactly
// once, in the opt-in proof (rtk.proofs.sh P5).
//
// HOME is pointed at a throwaway dir per test (paths.ts honors $HOME), so every write lands
// in the sandbox and the real user home is untouched. No port literal appears anywhere in
// this file or its fixtures (PORT RULE — RTK serves nothing). The shipped lock is staged
// into src/ for the source-run posture exactly as rows 82/83/84/87 do, then removed.
//
// Literal hygiene (row-89 gate: rg for the two lock never_run commands returns 0 matches):
// the forbidden subcommands are NEVER written as literals here. Test (l) derives them at
// runtime from the reviewed lock's own never_run array (01c1_tools_lock.json), which is where
// the strings belong.
//
// Run TARGETED (row 102 owns the full suite on this host):
//   bash packages/setup/test/rtk.proofs.sh
// or: cd packages/setup && bun test test/rtk.test.ts

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
  allowedProbeArgv,
  detectPreexistingRtk,
  readInstallRecord,
  rtkBin,
  rtkToolRoot,
  rtkVersionFromLock,
  type RtkStepOptions,
} from "../src/steps/rtk/index.ts"
import { defaultState, readState, writeState, type StateFile } from "../src/state.ts"
import { loadLock, type LockFile } from "../src/lockfile.ts"
import { computeFileDigest } from "../src/verify.ts"
import { OUTCOME } from "../src/outcomes.ts"
import type { FetchResult } from "../src/fetch.ts"

// ---- source-run lock posture (same harness trick as rows 82/83/84/87) -------------------
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

const FAKE_VERSION = "v9.9.9-fake" // synthetic pin — no ports, no hosts beyond the allow-listed names
const FAKE_SEMVER = "9.9.9-fake"
const TOOL_ROOT = (home: string) => join(home, ".swarm", "tools", "rtk")
const VERSION_DIR = (home: string) => join(TOOL_ROOT(home), FAKE_VERSION)
const BIN_PATH = (home: string) => join(VERSION_DIR(home), "rtk")
const TARBALL_NAME = `rtk-oss-${FAKE_VERSION}-aarch64-apple-darwin.tar.gz`

function freshHome(label: string): string {
  const home = mkdtempSync(join(tmpdir(), `swarm-r89-${label}-`))
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

/** Build a REAL .tar.gz holding a single `rtk` stand-in (a /bin/sh script printing the
 *  pinned semver) and place it where the real fetch would promote it: inside the tool root
 *  of the CURRENT throwaway HOME. `nested` mirrors the other plausible upstream layout
 *  (one top-level directory) so locateRtk()'s depth-1 walk is exercised by the REAL tar. */
function buildFakeTarball(label: string, home: string, nested = false): Fixture {
  const stage = mkdtempSync(join(tmpdir(), `swarm-r89-stage-${label}-`))
  const top = nested ? join(stage, `rtk-oss-${FAKE_VERSION}-aarch64-apple-darwin`) : stage
  mkdirSync(top, { recursive: true })
  // A stand-in binary: plain text with a shebang. Units never execute it except (j), where
  // the REAL spawn plumbing runs THIS test-authored script — nothing foreign is executed.
  writeFileSync(join(top, "rtk"), `#!/bin/sh\necho "rtk-oss ${FAKE_SEMVER}"\n`, { mode: 0o755 })
  if (nested) writeFileSync(join(top, "README.md"), "placeholder beside the nested binary\n")
  mkdirSync(TOOL_ROOT(home), { recursive: true })
  const tarPath = join(TOOL_ROOT(home), TARBALL_NAME)
  const args = nested
    ? ["-czf", tarPath, "-C", stage, `rtk-oss-${FAKE_VERSION}-aarch64-apple-darwin`]
    : ["-czf", tarPath, "-C", stage, "rtk"]
  const r = Bun.spawnSync(["/usr/bin/tar", ...args], { stdout: "pipe", stderr: "pipe" })
  if (r.exitCode !== 0) throw new Error(`fixture tar failed: ${r.stderr}`)
  const digest = computeFileDigest(tarPath, "sha256")
  const binarySha = computeFileDigest(join(top, "rtk"), "sha256").hex
  return { path: tarPath, sha256: digest.hex, bytes: digest.sizeBytes, binarySha256: binarySha }
}

/** A lock shaped exactly like the shipped rtk pin but pointing at the fake version. */
function fakeLock(fixture: { sha256: string; bytes: number }): LockFile {
  return {
    schemaVersion: 1,
    version: "test-lock-r89",
    hosts: ["github.com", "objects.githubusercontent.com"],
    components: {
      rtk: {
        install_dir: "~/.swarm/tools/rtk",
        edition: "rtk-oss",
        url: `https://github.com/rtk-ai/rtk/releases/download/${FAKE_VERSION}/rtk-oss-${FAKE_VERSION}-aarch64-apple-darwin.tar.gz`,
        version: FAKE_VERSION,
        size: fixture.bytes,
        sha256: fixture.sha256,
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
        component: "rtk",
        artifact: "rtk",
        url: "https://github.com/rtk-ai/rtk/releases/download/x/y",
        host: "github.com",
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
function healthSpy(versionOutput: string = `rtk-oss ${FAKE_SEMVER}`): {
  seen: string[]
  runner: NonNullable<RtkStepOptions["healthRunner"]>
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

/** Signature seam: units carry a shell-script fixture, not a Mach-O, so the real codesign
 *  call cannot run against it; the seam records the path and passes. The genuine Mach-O
 *  gate runs unseamed in proofs P5. It cannot weaken verification on the real path because
 *  proofs never set this seam. */
function signatureSpy(): { seen: string[]; gate: NonNullable<RtkStepOptions["signatureGate"]> } {
  const seen: string[] = []
  return {
    seen,
    gate: (binPath: string) => (
      seen.push(binPath),
      { ok: true, detail: "recorded (unit fixture is a shell script, not Mach-O)" }
    ),
  }
}

function ctxOf(lock: LockFile, state?: StateFile, dryRun = false) {
  return { lock, state: state ?? defaultState(lock.version), dryRun }
}

/** Install with the granted-path seams wired (r84/r87 discipline: drives the consented
 *  branch without fabricating consent out-of-band — nothing here writes consent.log). */
async function grantedInstall(
  home: string,
  lock: LockFile,
  destPath: string,
  extra: RtkStepOptions = {},
  dryRun = false,
  status: "fetched" | "resumed" | "dry_run" = "fetched",
) {
  const spy = fetchSpy(destPath, status)
  const health = healthSpy()
  const sig = signatureSpy()
  const res = await step.install(ctxOf(lock, undefined, dryRun), {
    provenancePath: join(home, "prov.jsonl"),
    logPath: join(home, "setup.log"),
    consentGate: () => true,
    fetchImpl: spy.impl,
    healthRunner: health.runner,
    signatureGate: sig.gate,
    preexistingCandidates: [], // machine-independent: detection is unit-tested explicitly below
    ...extra,
  })
  return { res, spy, health, sig }
}

describe("(a) consent gate refuses before fetch AND before any filesystem touch", () => {
  it("REFUSED_NO_CONSENT with zero fetch calls and an untouched tool dir", async () => {
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
    expect(tree(join(home, ".swarm", "tools", "rtk"))).toEqual([`${TARBALL_NAME}:${fixture.bytes}`])
  })
})

describe("(b) fresh install: atomic private placement, record, pointer, lifecycle", () => {
  it("lands <root>/<version>/rtk with exec bit + install record + pointer + healthy state", async () => {
    const home = freshHome("b1")
    const envBefore = envSnapshot()
    const fixture = buildFakeTarball("b1", home)
    const lock = fakeLock(fixture)
    const { res, spy, health, sig } = await grantedInstall(home, lock, fixture.path)

    expect(res.token).toBe(OUTCOME.OK)
    expect(spy.calls).toBe(1) // exactly one network-proxy call for a cold install

    const binPath = BIN_PATH(home)
    // The staged path verified before commit lives under a .stage- temp inside the tool
    // root (it is renamed into <version>/ by the commit, so it cannot be re-listed here).
    expect(sig.seen.length).toBe(1)
    expect(sig.seen[0] ?? "").toContain(".stage-")
    expect(sig.seen[0] ?? "").toEndWith("/rtk")
    expect(health.seen).toEqual([binPath]) // the step probed EXACTLY the private absolute path
    expect(existsSync(binPath)).toBe(true)
    expect(statSync(binPath).mode & 0o111).not.toBe(0) // exec bit set inside ~/.swarm
    // The brief's exact placement: <version>/rtk directly — no bin/ level, no extras.
    expect(readdirSync(VERSION_DIR(home)).sort()).toEqual([".swarm-rtk.json", "rtk"])

    const record = readInstallRecord(VERSION_DIR(home))
    expect(record).not.toBeNull()
    if (record) {
      expect(record.version).toBe(FAKE_VERSION)
      expect(record.edition).toBe("rtk-oss")
      expect(record.tarballSha256).toBe(fixture.sha256)
      expect(record.observedTarballSha256).toBe(fixture.sha256)
      expect(record.rtkBinarySha256).toBe(computeFileDigest(binPath, "sha256").hex)
      expect(record.paths).toContain(VERSION_DIR(home))
      expect(record.paths).toContain(fixture.path)
    }

    expect(existsSync(join(TOOL_ROOT(home), "current.json"))).toBe(true)

    const onDisk = readState(lock.version)
    expect(onDisk.ok).toBe(true)
    if (onDisk.ok) {
      const r = onDisk.state.components.rtk
      expect(r.state).toBe("healthy")
      expect(r.installedBySwarm).toBe(true)
      expect(r.version).toBe(FAKE_VERSION)
      expect(r.integrity).toBe(`sha256:${fixture.binarySha256}`)
      expect(r.paths?.length).toBe(4)
    }

    // Provenance ledger received the install row (the fetch row would come from the real
    // library; the spy stands in for it here — the real pair lands in proofs P5).
    const lines = readFileSync(join(home, "prov.jsonl"), "utf8").trim().split("\n")
    expect(lines.length).toBe(1)
    const last = JSON.parse(lines[0] as string) as Record<string, unknown>
    expect(last.component).toBe("rtk")
    expect(last.destPath).toBe(binPath)

    // PATH-cleanliness layer 1: the WHOLE environment is byte-identical after an install.
    expect(envSnapshot()).toBe(envBefore)
  })

  it("NO config is written anywhere: ~/.config/swarm and ~/Library never appear", async () => {
    const home = freshHome("b2")
    const fixture = buildFakeTarball("b2", home)
    await grantedInstall(home, fakeLock(fixture), fixture.path)
    expect(existsSync(join(home, ".config"))).toBe(false) // rows 97/98 own ~/.config/swarm later
    expect(existsSync(join(home, "Library"))).toBe(false) // RTK's own store is RTK's to create, never this step's
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
      signatureGate: signatureSpy().gate,
      preexistingCandidates: [],
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
    const refused = rtkBin({ lock })
    expect(refused.ok).toBe(false)
    expect(refused.reason ?? "").toContain("install record")

    const { res, spy } = await grantedInstall(home, lock, fixture.path) // re-install replaces it
    expect(res.token).toBe(OUTCOME.OK)
    expect(spy.calls).toBe(1) // fetch reached again (real lib would resume from the intact tarball)
    expect(computeFileDigest(BIN_PATH(home), "sha256").hex).toBe(fixture.binarySha256) // restored
    expect(rtkBin({ lock }).ok).toBe(true) // usable again

    // Atomic replace left no debris and exactly ONE version dir plus the known siblings.
    const names = readdirSync(TOOL_ROOT(home))
      .filter((n) => !n.startsWith("."))
      .sort()
    expect(names).toEqual([TARBALL_NAME, FAKE_VERSION, "current.json"].sort())
    expect(
      readdirSync(TOOL_ROOT(home)).filter(
        (n) => n.startsWith(".quarantine-") || n.startsWith(".extract-") || n.startsWith(".stage-"),
      ),
    ).toEqual([])
  })
})

describe("(e) resolver path proof for rows 97/98", () => {
  it("rtkBin returns the exact absolute private path and works with an EMPTY PATH", async () => {
    const home = freshHome("e1")
    const fixture = buildFakeTarball("e1", home)
    const lock = fakeLock(fixture)
    await grantedInstall(home, lock, fixture.path)

    const expected = join(home, ".swarm", "tools", "rtk", FAKE_VERSION, "rtk")
    const first = rtkBin({ lock })
    expect(first.ok).toBe(true)
    expect(first.path).toBe(expected)
    expect((first.path ?? "").startsWith("/")).toBe(true) // absolute by contract

    // PATH-independence: resolution cannot be a PATH lookup because it survives PATH="".
    const savedPath = process.env.PATH
    process.env.PATH = ""
    const noPath = rtkBin({ lock })
    process.env.PATH = "/nonexistent-dir-for-proof"
    const bogusPath = rtkBin({ lock })
    if (savedPath === undefined) delete process.env.PATH
    else process.env.PATH = savedPath
    expect(noPath.path).toBe(expected)
    expect(bogusPath.path).toBe(expected)

    // Not installed -> honest refusal naming the path, never a system-rtk fallback.
    const missing = rtkBin({ lock, installRoot: join(home, "nowhere") })
    expect(missing.ok).toBe(false)
    expect(missing.reason ?? "").toContain("not installed")
  })

  it("the shipped lock pins v1.0.1 rtk-oss (Apache-2.0 edition) — the artifact rows 97/98 resolve", () => {
    const v = rtkVersionFromLock(SHIPPED)
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.version).toBe("v1.0.1")
    const pin = SHIPPED.components.rtk
    expect(pin?.edition).toBe("rtk-oss")
    expect(String(pin?.url ?? "")).toContain("rtk-oss-aarch64-apple-darwin.tar.gz")
    expect(String(pin?.sha256 ?? "")).toBe("4a4d9d09656ff29423336aa506e680afc3f7b6dafe84f0194a1c9a523a3c80e1")
  })
})

describe("(f) zero PATH mutation: neither the install nor the resolver touches any PATH value", () => {
  it("process.env is byte-identical across a full install", async () => {
    const home = freshHome("f1")
    const envBefore = envSnapshot()
    const fixture = buildFakeTarball("f1", home)
    await grantedInstall(home, fakeLock(fixture), fixture.path)
    expect(envSnapshot()).toBe(envBefore) // no PATH prepend/append/export anywhere
    expect(rtkToolRoot()).toBe(join(home, ".swarm", "tools", "rtk")) // default resolves under sandbox HOME
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
  it("deletes version dir, pointer and tarball; an unlisted sibling survives; second remove skips", async () => {
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
    expect(existsSync(keepMe)).toBe(true) // NEVER delete what the state file does not list

    const after = readState(lock.version)
    if (after.ok) {
      expect(after.state.components.rtk.state).toBe("absent")
      expect(after.state.components.rtk.installedBySwarm).toBe(false)
      expect(after.state.components.rtk.paths).toBeUndefined()
    }

    const again = step.remove(ctxOf(lock, after.ok ? after.state : undefined))
    expect(again.token).toBe(OUTCOME.SKIPPED)
    expect(existsSync(keepMe)).toBe(true)
  })

  it("a pre-existing install the setup did not create is SKIPPED, never deleted", async () => {
    const home = freshHome("h2")
    const lock = fakeLock({ sha256: "cd".repeat(32), bytes: 10 })
    const state = defaultState(lock.version)
    state.components.rtk = { state: "healthy", version: FAKE_VERSION } // installedBySwarm ABSENT
    writeState(state)
    mkdirSync(BIN_PATH(home), { recursive: true }) // someone else's rtk lives here
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
      state.state.components.rtk = {
        ...state.state.components.rtk,
        paths: [...(state.state.components.rtk.paths ?? []), outside],
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
      readdirSync(TOOL_ROOT(home)).filter(
        (n) => n.startsWith(".extract-") || n.startsWith(".stage-") || n.startsWith(".quarantine-"),
      ),
    ).toEqual([])
    const st = readState(lock.version)
    if (st.ok) expect(st.state.components.rtk.state).toBe("failed")
  })

  it("an archive without any rtk file (unexpected shape) promotes nothing", async () => {
    const home = freshHome("i2")
    const stage = mkdtempSync(join(tmpdir(), `swarm-r89-shape-i2-`))
    writeFileSync(join(stage, "not-the-binary"), "wrong archive contents\n")
    mkdirSync(TOOL_ROOT(home), { recursive: true })
    const tarPath = join(TOOL_ROOT(home), TARBALL_NAME)
    const r = Bun.spawnSync(["/usr/bin/tar", "-czf", tarPath, "-C", stage, "not-the-binary"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    if (r.exitCode !== 0) throw new Error(`fixture tar failed: ${r.stderr}`)
    const digest = computeFileDigest(tarPath, "sha256")
    const { res } = await grantedInstall(home, fakeLock({ sha256: digest.hex, bytes: digest.sizeBytes }), tarPath, {
      signatureGate: signatureSpy().gate,
    })
    expect(res.token).toBe(OUTCOME.FAILED)
    expect(res.message ?? "").toContain("did not yield an rtk binary")
    expect(existsSync(VERSION_DIR(home))).toBe(false)
    rmSync(stage, { recursive: true, force: true })
  })
})

describe("(j) real spawn plumbing end-to-end (no seams on extract OR health)", () => {
  it("default extractor AND default health runner work against the shebang fixture binary (flat layout)", async () => {
    // The fixture rtk is a REAL /bin/sh script with a shebang, so the UNSEAMED health runner
    // genuinely spawns it and reads its stdout — covering the TextDecoder normalization r87
    // caught on its first real run. The signature seam stays scripted: the fixture is not a
    // Mach-O (see signatureSpy); the real gate runs in proofs P5.
    const home = freshHome("j1")
    const fixture = buildFakeTarball("j1", home)
    const lock = fakeLock(fixture)
    const spy = fetchSpy(fixture.path)
    const res = await step.install(ctxOf(lock), {
      provenancePath: join(home, "prov.jsonl"),
      consentGate: () => true,
      fetchImpl: spy.impl,
      signatureGate: signatureSpy().gate,
      preexistingCandidates: [],
      // NO extractor seam, NO healthRunner seam: real /usr/bin/tar + real spawn of the
      // test-authored shell fixture. Nothing downloaded, nothing foreign executed.
    })
    expect(res.token).toBe(OUTCOME.OK) // --version output contains the pinned semver
    expect(res.message ?? "").toContain("installed privately")
    expect(rtkBin({ lock }).ok).toBe(true)
  })

  it("nested top-level-dir layout also resolves (locateRtk depth-1 walk, real tar)", async () => {
    const home = freshHome("j2")
    const fixture = buildFakeTarball("j2", home, true)
    const lock = fakeLock(fixture)
    const spy = fetchSpy(fixture.path)
    const res = await step.install(ctxOf(lock), {
      provenancePath: join(home, "prov.jsonl"),
      consentGate: () => true,
      fetchImpl: spy.impl,
      signatureGate: signatureSpy().gate,
      preexistingCandidates: [],
    })
    expect(res.token).toBe(OUTCOME.OK)
    expect(readdirSync(VERSION_DIR(home)).sort()).toEqual([".swarm-rtk.json", "rtk"]) // flattened: no stray README rode along
    expect(rtkBin({ lock }).ok).toBe(true)
  })

  it("a fixture printing the WRONG version fails the health gate", async () => {
    const home = freshHome("j3")
    const fixture = buildFakeTarball("j3", home)
    const lock = fakeLock(fixture)
    const spy = fetchSpy(fixture.path)
    const res = await step.install(ctxOf(lock), {
      provenancePath: join(home, "prov.jsonl"),
      consentGate: () => true,
      fetchImpl: spy.impl,
      signatureGate: signatureSpy().gate,
      preexistingCandidates: [],
      healthRunner: (b: string) => ({
        ok: true,
        versionOutput: "something-else 0.0.1",
        detail: `injected wrong-version for ${b}`,
      }),
    })
    expect(res.token).toBe(OUTCOME.HEALTH_FAILED)
    expect(rtkBin({ lock }).ok).toBe(true) // the binary exists; the lifecycle simply never reached healthy
    const st = readState(lock.version)
    if (st.ok) expect(st.state.components.rtk.state).toBe("failed")
  })
})

describe("(k) edition guard (B3 / decision 14)", () => {
  it("refuses a lock whose declared edition does not match the pinned asset url, BEFORE fetch", async () => {
    const home = freshHome("k1")
    const fixture = buildFakeTarball("k1", home)
    const lock = fakeLock(fixture)
    // Doctor the lock the way a careless edit would: edition still declares rtk-oss, url
    // now names the other edition's asset. The guard must refuse before any socket.
    lock.components.rtk = {
      ...lock.components.rtk,
      url: `https://github.com/rtk-ai/rtk/releases/download/${FAKE_VERSION}/other-edition-${FAKE_VERSION}-aarch64-apple-darwin.tar.gz`,
    }
    const spy = fetchSpy(fixture.path)
    const res = await step.install(ctxOf(lock), {
      provenancePath: join(home, "prov.jsonl"),
      consentGate: () => true,
      fetchImpl: spy.impl,
      signatureGate: signatureSpy().gate,
      preexistingCandidates: [],
    })
    expect(res.token).toBe(OUTCOME.FAILED)
    expect(res.message ?? "").toContain("edition guard")
    expect(spy.calls).toBe(0) // refused before the downloader was reached
    expect(existsSync(VERSION_DIR(home))).toBe(false)
  })
})

describe("(l) pre-existing detection + argv poka-yoke (read-only guarantees)", () => {
  it("detectPreexistingRtk reports existing candidates and creates nothing", () => {
    const home = freshHome("l1")
    const existing = join(home, "fake-cellar-rtk")
    writeFileSync(existing, "someone else's binary\n")
    const before = tree(home)
    const found = detectPreexistingRtk([existing, join(home, "does-not-exist")])
    expect(found).toEqual([existing])
    expect(tree(home)).toEqual(before) // stat-only interaction: listing unchanged
  })

  it("the default candidates are the standard Homebrew locations, checked read-only", () => {
    // Machine-independent assertion of the DEFAULT list behavior: calling it must not throw
    // and must return a subset of the two standard locations that exist on this host.
    const found = detectPreexistingRtk()
    for (const p of found) expect(["/opt/homebrew/bin/rtk", "/usr/local/bin/rtk"]).toContain(p)
  })

  it("allowedProbeArgv admits ONLY <bin> --version; every lock never_run command is refused", () => {
    const bin = "/tmp/r89-proof-bin/rtk"
    expect(allowedProbeArgv(bin, [bin, "--version"])).toBe(true)
    expect(allowedProbeArgv(bin, [bin])).toBe(false)
    expect(allowedProbeArgv(bin, [bin, "--version", "--extra"])).toBe(false)
    expect(allowedProbeArgv("/other/rtk", [bin, "--version"])).toBe(false)
    // Derive the forbidden subcommands FROM the reviewed lock's never_run array — no
    // forbidden literals appear in this source (row-89 rg gate stays green by construction).
    const neverRun = SHIPPED.components.rtk?.never_run
    expect(Array.isArray(neverRun)).toBe(true)
    const firstArgs = (neverRun as string[]).map((cmd) => cmd.split(" ")[1]).filter((s) => s !== undefined)
    expect(firstArgs.length).toBeGreaterThan(0)
    for (const sub of firstArgs) {
      expect(allowedProbeArgv(bin, [bin, sub])).toBe(false)
    }
  })
})
