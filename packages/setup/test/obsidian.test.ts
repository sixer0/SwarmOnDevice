// Row-90 unit tests for the Obsidian guide-and-detect step (src/steps/obsidian/). NO network anywhere:
// the download path is exercised through the row-84 fetchImpl seam delivering a staged FAKE .dmg whose
// bytes genuinely hash to the fake pin, and the MOUNT is driven by a fake-hdiutil shim that builds a
// realistic mini Obsidian.app tree at the private mountpoint. From there the pipeline is REAL: the
// default copier is the actual /usr/bin/ditto, digests are genuine, and the signature gate is r82's
// macSignatureCheck reached through its sanctioned `run` seam (the only way to script codesign/spctl
// outcomes). The TeamID-recording assertions ARE the U-2 closer proof: whatever the scripted gate
// prints lands verbatim in the install record, the resolver pointer and the provenance ledger — and a
// confirmed lock pin refuses any mismatch. The REAL hdiutil cycle runs exactly once, opt-in, in
// obsidian.proofs.sh (R90_REAL=1).
//
// HOME is pointed at a throwaway dir per test (paths.ts honors $HOME), so every write lands in the
// sandbox and the real user home — including /Applications and ~/.swarm/vault — is untouched. No port
// literal appears anywhere in this file or its fixtures (PORT RULE / PORT BLOCK 902x).
//
// Run TARGETED (row 102 owns the full suite on this host):
//   bash packages/setup/test/obsidian.proofs.sh
// or: cd packages/setup && bun test test/obsidian.test.ts

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
  detectExistingInstall,
  lockedTeamId,
  obsidianToolRoot,
  obsidianVersionFromLock,
  readInstallRecord,
  stagedAppPath,
  type ObsidianStepOptions,
} from "../src/steps/obsidian/index.ts"
import { defaultState, readState, writeState, type StateFile } from "../src/state.ts"
import { loadLock, type LockFile } from "../src/lockfile.ts"
import { computeFileDigest } from "../src/verify.ts"
import { OUTCOME } from "../src/outcomes.ts"
import type { FetchResult } from "../src/fetch.ts"
import type { SignatureOutcome } from "../src/verify.ts"

// ---- source-run lock posture (same harness trick as rows 82/83/84/87) -----------------------
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
const FAKE_TEAM_ID = "FAKEOBSTeamA" // scripted codesign -dvvv output — never a real Team ID claim
const DMG_NAME = `Obsidian-${FAKE_VERSION}.dmg`
const APP_BIN_CONTENT = "FAKE-OBSIDIAN-MACHO-BINARY\n"
const TOOL_ROOT = (home: string) => join(home, ".swarm", "tools", "obsidian")
const VERSION_DIR = (home: string) => join(TOOL_ROOT(home), FAKE_VERSION)
const STAGED_APP = (home: string) => join(VERSION_DIR(home), "Obsidian.app")
const STAGED_BIN = (home: string) => join(STAGED_APP(home), "Contents", "MacOS", "Obsidian")

function freshHome(label: string): string {
  const home = mkdtempSync(join(tmpdir(), `swarm-r90-${label}-`))
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
}

/** Build a REAL small file standing in for the pinned dmg where the real fetch would promote it
 *  (inside the tool root of the CURRENT throwaway HOME) and report its genuine digest. */
function buildFakeDmg(home: string): Fixture {
  mkdirSync(TOOL_ROOT(home), { recursive: true })
  const path = join(TOOL_ROOT(home), DMG_NAME)
  writeFileSync(path, `UDZO-placeholder-dmg ${FAKE_VERSION}\n`.repeat(64), { mode: 0o600 })
  const digest = computeFileDigest(path, "sha256")
  return { path, sha256: digest.hex, bytes: digest.sizeBytes }
}

/** A lock shaped exactly like the shipped obsidian pin but pointing at the fake version. */
function fakeLock(fixture: { sha256: string; bytes: number }, teamId: string | null = null): LockFile {
  return {
    schemaVersion: 1,
    version: "test-lock-r90",
    hosts: ["github.com", "objects.githubusercontent.com"],
    components: {
      obsidian: {
        install_dir: "~/.swarm/tools/obsidian",
        url: `https://github.com/obsidianmd/obsidian-releases/releases/download/${FAKE_VERSION}/${DMG_NAME}`,
        version: FAKE_VERSION,
        size: fixture.bytes,
        dmg_sha256: fixture.sha256,
        team_id: teamId,
        licence: "LicenseRef-Obsidian",
      },
    },
    raw: {},
  }
}

interface FetchSpy {
  calls: number
  sawDryRun: boolean
  impl: typeof import("../src/fetch.ts").fetchArtifact
}

/** Instrumented fetchImpl (network-proxy counter + fixture delivery), r84 spy discipline. */
function fetchSpy(destPath: string, status: "fetched" | "resumed" | "dry_run" = "fetched"): FetchSpy {
  const spy: FetchSpy = {
    calls: 0,
    sawDryRun: false,
    impl: (async (_l: LockFile, _id: string, opts?: { dryRun?: boolean }) => {
      spy.calls += 1
      spy.sawDryRun = opts?.dryRun === true
      const artifact = {
        component: "obsidian",
        artifact: "obsidian",
        url: "https://github.com/o/r/releases/download/x/y.dmg",
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

/** A fetchImpl scripted to FAIL like row 82's tamper path (digest mismatch before promotion). */
function failingFetch(code: "HASH_MISMATCH" | "SIZE_EXCEEDED" = "HASH_MISMATCH"): FetchSpy {
  const spy: FetchSpy = {
    calls: 0,
    sawDryRun: false,
    impl: (async () => {
      spy.calls += 1
      return {
        ok: false,
        code,
        message: `${code}: observed digest differs from the pin (injected by unit)`,
        attempts: 1,
      }
    }) as unknown as typeof import("../src/fetch.ts").fetchArtifact,
  }
  return spy
}

interface MountSpy {
  attachCalls: Array<{ dmg: string; mountPoint: string }>
  detachCalls: string[]
  mounter: NonNullable<ObsidianStepOptions["mounter"]>
  unmounter: NonNullable<ObsidianStepOptions["unmounter"]>
}

/** THE FAKE HDIUTIL SHIM. attach() builds a realistic mini Obsidian.app bundle at the mountpoint
 *  (Contents/Info.plist + Contents/MacOS/Obsidian) so every downstream stage — locate, signature
 *  gate, ditto copy, digest compare, commit — runs against real files. detach() just counts. */
function mountSpy(opts: { failAttach?: boolean; buildApp?: boolean } = {}): MountSpy {
  const spy: MountSpy = {
    attachCalls: [],
    detachCalls: [],
    mounter: (dmgPath: string, mountPoint: string) => {
      spy.attachCalls.push({ dmg: dmgPath, mountPoint })
      if (opts.failAttach === true) return { ok: false, detail: "injected hdiutil attach failure (unit)" }
      if (opts.buildApp !== false) {
        const binDir = join(mountPoint, "Obsidian.app", "Contents", "MacOS")
        mkdirSync(binDir, { recursive: true })
        writeFileSync(join(mountPoint, "Obsidian.app", "Contents", "Info.plist"), "<plist>fake</plist>\n")
        writeFileSync(join(binDir, "Obsidian"), APP_BIN_CONTENT, { mode: 0o755 })
      }
      return { ok: true, detail: "attached (fake hdiutil shim)" }
    },
    unmounter: (mountPoint: string) => {
      spy.detachCalls.push(mountPoint)
      // Emulate the OBSERVABLE effect of a successful `hdiutil detach`: the volume disappears and
      // the mountpoint DIRECTORY is left EMPTY (exactly what the real tool does). The step's own
      // rmdirSync cleanup then claims the empty dir.
      rmSync(join(mountPoint, "Obsidian.app"), { recursive: true, force: true })
      return { ok: true, detail: "detached (fake hdiutil shim)" }
    },
  }
  return spy
}

/** Scripted signature outcomes through r82's sanctioned SignatureSpec.run seam. */
function sigScript(outcome: Partial<SignatureOutcome> & { detail?: string }): {
  seen: string[]
  run: NonNullable<ObsidianStepOptions["signatureRun"]>
} {
  const seen: string[] = []
  return {
    seen,
    run: (absPath: string) => {
      seen.push(absPath)
      return {
        codesignOk: outcome.codesignOk ?? true,
        spctlOk: outcome.spctlOk ?? true,
        ...(outcome.teamId !== undefined ? { teamId: outcome.teamId } : {}),
        detail: outcome.detail ?? "scripted (unit)",
      }
    },
  }
}

function ctxOf(lock: LockFile, state?: StateFile, dryRun = false) {
  return { lock, state: state ?? defaultState(lock.version), dryRun }
}

/** Install with the granted-path seams wired (r84 discipline: drives the consented branch without
 *  fabricating consent out-of-band — nothing here writes consent.log). Copier stays UNSEAMED (real
 *  ditto) unless extra overrides it. */
async function grantedInstall(
  home: string,
  lock: LockFile,
  destPath: string,
  extra: ObsidianStepOptions = {},
  dryRun = false,
  status: "fetched" | "resumed" | "dry_run" = "fetched",
) {
  const spy = fetchSpy(destPath, status)
  const mounts = mountSpy()
  const sig = sigScript({ teamId: FAKE_TEAM_ID })
  const res = await step.install(ctxOf(lock, undefined, dryRun), {
    provenancePath: join(home, "prov.jsonl"),
    logPath: join(home, "setup.log"),
    consentGate: () => true,
    fetchImpl: spy.impl,
    mounter: mounts.mounter,
    unmounter: mounts.unmounter,
    signatureRun: sig.run,
    // Determinism guard: units must never depend on whether THIS host happens to run Obsidian.
    detector: () => ({ found: false, paths: [], methods: ["unit-default"] }),
    ...extra,
  })
  return { res, spy, mounts, sig }
}

function provLines(home: string): Array<Record<string, unknown>> {
  const file = join(home, "prov.jsonl")
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

describe("(a) consent gate refuses before EVERY action — probe, fetch, mount, copy", () => {
  it("REFUSED_NO_CONSENT with zero fetch AND zero detector calls, untouched HOME", async () => {
    const home = freshHome("a1")
    const fixture = buildFakeDmg(home)
    const spy = fetchSpy(fixture.path)
    let detectorCalls = 0
    const mounts = mountSpy()
    const res = await step.install(ctxOf(fakeLock(fixture)), {
      provenancePath: join(home, "prov.jsonl"),
      fetchImpl: spy.impl,
      detector: () => ((detectorCalls += 1), { found: false, paths: [], methods: [] }),
      mounter: mounts.mounter,
      unmounter: mounts.unmounter,
    })
    expect(res.token).toBe(OUTCOME.REFUSED_NO_CONSENT)
    expect(spy.calls).toBe(0)
    expect(detectorCalls).toBe(0) // even the READ-ONLY host probe waits behind consent
    expect(mounts.attachCalls.length).toBe(0)
    expect(existsSync(join(home, ".swarm", "setup"))).toBe(false)
    expect(tree(join(home, ".swarm", "tools", "obsidian"))).toEqual([`${DMG_NAME}:${fixture.bytes}`])
  })
})

describe("(b) fresh staging full cycle: fake-hdiutil mount -> gate -> REAL ditto -> atomic commit", () => {
  it("lands <root>/<version>/Obsidian.app with record + pointer + provenance + healthy state; always detaches; vault never created", async () => {
    const home = freshHome("b1")
    const envBefore = envSnapshot()
    const fixture = buildFakeDmg(home)
    const lock = fakeLock(fixture)
    const { res, spy, mounts, sig } = await grantedInstall(home, lock, fixture.path)

    expect(res.token).toBe(OUTCOME.OK)
    expect(spy.calls).toBe(1) // exactly one network-proxy call for a cold stage
    expect(res.message ?? "").toContain(FAKE_TEAM_ID) // the observed TeamID surfaces in the human line

    // Mount discipline: ONE attach of the verified dmg at a PRIVATE mountpoint under ~/.swarm/tmp,
    // and exactly ONE detach — the trap-safe finally ran on the success path too.
    expect(mounts.attachCalls.length).toBe(1)
    expect(mounts.attachCalls[0]?.dmg).toBe(fixture.path)
    expect(mounts.attachCalls[0]?.mountPoint.startsWith(join(home, ".swarm", "tmp", ".mnt-"))).toBe(true)
    expect(mounts.detachCalls).toEqual([mounts.attachCalls[0]?.mountPoint])

    // The signature gate saw EXACTLY the mounted app path (not the dmg, not the staged copy).
    expect(sig.seen.length).toBe(1)
    expect(sig.seen[0]?.endsWith("/Obsidian.app")).toBe(true)
    expect(sig.seen[0]?.startsWith(mounts.attachCalls[0]?.mountPoint ?? "\u0000")).toBe(true)

    // Staged tree exists in USER SPACE with the copied content intact (real ditto did this copy).
    expect(existsSync(STAGED_APP(home))).toBe(true)
    expect(readFileSync(STAGED_BIN(home), "utf8")).toBe(APP_BIN_CONTENT)
    expect(existsSync(join(STAGED_APP(home), "Contents", "Info.plist"))).toBe(true)

    const record = readInstallRecord(VERSION_DIR(home))
    expect(record).not.toBeNull()
    if (record) {
      expect(record.version).toBe(FAKE_VERSION)
      expect(record.dmgSha256).toBe(fixture.sha256)
      expect(record.observedDmgSha256).toBe(fixture.sha256)
      expect(record.observedTeamIdentifier).toBe(FAKE_TEAM_ID)
      expect(record.appBinarySha256).toBe(computeFileDigest(STAGED_BIN(home), "sha256").hex)
      expect(record.mountedBinarySha256).toBe(record.appBinarySha256) // copy-fidelity invariant
      expect(record.placement).toBe("user-space-staged")
      expect(record.applicationsTouched).toBe(false)
      expect(record.paths).toContain(VERSION_DIR(home))
      expect(record.paths).toContain(fixture.path)
    }

    expect(existsSync(join(TOOL_ROOT(home), "current.json"))).toBe(true)

    const onDisk = readState(lock.version)
    expect(onDisk.ok).toBe(true)
    if (onDisk.ok) {
      const o = onDisk.state.components.obsidian
      expect(o.state).toBe("healthy")
      expect(o.installedBySwarm).toBe(true)
      expect(o.version).toBe(FAKE_VERSION)
      expect(o.integrity).toBe(`sha256:${record?.appBinarySha256}`)
      expect(o.paths?.length).toBe(4)
    }

    // Provenance ledger received the staging row carrying the U-2 observation.
    const lines = provLines(home)
    expect(lines.length).toBe(1)
    expect(lines[0]?.component).toBe("obsidian")
    expect(lines[0]?.stage).toBe("staged")
    expect(lines[0]?.observedTeamIdentifier).toBe(FAKE_TEAM_ID)

    // VAULT GUARD: row 95 owns ~/.swarm/vault — this step must not have created it.
    expect(existsSync(join(home, ".swarm", "vault"))).toBe(false)
    // No debris: temporaries (.stage-*/.quarantine-*/.mnt-*) are all gone post-commit.
    expect(readdirSync(TOOL_ROOT(home)).filter((n) => n.startsWith(".stage-") || n.startsWith(".quarantine-"))).toEqual(
      [],
    )
    const tmpRoot = join(home, ".swarm", "tmp")
    expect(existsSync(tmpRoot) ? readdirSync(tmpRoot).filter((n) => n.startsWith(".mnt-")) : []).toEqual([])

    expect(envSnapshot()).toBe(envBefore) // the whole environment is byte-identical after a stage
  })
})

describe("(c) idempotence: resume-on-valid performs ZERO network and ZERO mounts", () => {
  it("second install over a valid staged tree never reaches the downloader or hdiutil", async () => {
    const home = freshHome("c1")
    const fixture = buildFakeDmg(home)
    const lock = fakeLock(fixture)
    await grantedInstall(home, lock, fixture.path)

    const spy = fetchSpy(fixture.path)
    const mounts = mountSpy()
    const stateOnDisk = readState(lock.version)
    expect(stateOnDisk.ok).toBe(true)
    const res = await step.install(ctxOf(lock, stateOnDisk.ok ? stateOnDisk.state : undefined), {
      provenancePath: join(home, "prov.jsonl"),
      consentGate: () => true,
      fetchImpl: spy.impl,
      mounter: mounts.mounter,
      unmounter: mounts.unmounter,
      signatureRun: sigScript({ teamId: FAKE_TEAM_ID }).run,
    })
    expect(res.token).toBe(OUTCOME.OK)
    expect(res.message ?? "").toContain("resumed")
    expect(spy.calls).toBe(0) // §6.3: valid existing stage -> zero network attempts
    expect(mounts.attachCalls.length).toBe(0) // and zero mounts
    expect(readFileSync(STAGED_BIN(home), "utf8")).toBe(APP_BIN_CONTENT) // untouched
  })
})

describe("(d) tamper-replace: staged-binary digest drift forces re-stage from the verified dmg", () => {
  it("tampered staged binary is detected by sha and replaced; the resolver refuses it meanwhile", async () => {
    const home = freshHome("d1")
    const fixture = buildFakeDmg(home)
    const lock = fakeLock(fixture)
    await grantedInstall(home, lock, fixture.path)

    appendFileSync(STAGED_BIN(home), "# TAMPERED BY TEST\n")
    const refused = stagedAppPath({ lock })
    expect(refused.ok).toBe(false)
    expect(refused.reason ?? "").toContain("install record")

    const { res } = await grantedInstall(home, lock, fixture.path)
    expect(res.token).toBe(OUTCOME.OK)
    expect(readFileSync(STAGED_BIN(home), "utf8")).toBe(APP_BIN_CONTENT) // restored
    expect(stagedAppPath({ lock }).ok).toBe(true) // usable again

    const names = readdirSync(TOOL_ROOT(home))
      .filter((n) => !n.startsWith("."))
      .sort()
    expect(names).toEqual([DMG_NAME, FAKE_VERSION, "current.json"].sort())
    expect(readdirSync(TOOL_ROOT(home)).filter((n) => n.startsWith(".stage-") || n.startsWith(".quarantine-"))).toEqual(
      [],
    )
  })
})

describe("(e) tampered dmg mock aborts BEFORE mount (blueprint gate 02_structured.md:254)", () => {
  it("HASH_MISMATCH from the fetch layer leaves the mounter untouched and records failed", async () => {
    const home = freshHome("e1")
    const fixture = buildFakeDmg(home)
    const lock = fakeLock(fixture)
    const bad = failingFetch("HASH_MISMATCH")
    const mounts = mountSpy()
    const res = await step.install(ctxOf(lock), {
      provenancePath: join(home, "prov.jsonl"),
      consentGate: () => true,
      fetchImpl: bad.impl,
      mounter: mounts.mounter,
      unmounter: mounts.unmounter,
      detector: () => ({ found: false, paths: [], methods: ["unit-default"] }),
    })
    expect(res.token).toBe(OUTCOME.FAILED)
    expect(bad.calls).toBe(1)
    expect(mounts.attachCalls.length).toBe(0) // NEVER mount bytes that failed the digest gate
    expect(mounts.detachCalls.length).toBe(0)
    expect(existsSync(VERSION_DIR(home))).toBe(false)
    const st = readState(lock.version)
    if (st.ok) expect(st.state.components.obsidian.state).toBe("failed")
  })
})

describe("(f) trap-safe unmount: EVERY post-mount failure path detaches exactly once", () => {
  it("copier failure: detached, nothing promoted, no stage debris, provenance COPY_FAILED", async () => {
    const home = freshHome("f1")
    const fixture = buildFakeDmg(home)
    const lock = fakeLock(fixture)
    const mounts = mountSpy()
    const { res } = await grantedInstall(home, lock, fixture.path, {
      mounter: mounts.mounter,
      unmounter: mounts.unmounter,
      copier: () => ({ ok: false, detail: "injected ditto failure (unit)" }),
    })
    expect(res.token).toBe(OUTCOME.FAILED)
    expect(mounts.detachCalls.length).toBe(1) // the finally ran despite the mid-cycle failure
    expect(existsSync(VERSION_DIR(home))).toBe(false)
    expect(readdirSync(TOOL_ROOT(home)).filter((n) => n.startsWith(".stage-"))).toEqual([])
    const lines = provLines(home)
    expect(lines.some((l) => l.stage === "copy" && l.code === "COPY_FAILED")).toBe(true)
  })

  it("signature refusal: detached, nothing staged, provenance carries the observed TeamID anyway", async () => {
    const home = freshHome("f2")
    const fixture = buildFakeDmg(home)
    const lock = fakeLock(fixture)
    const mounts = mountSpy()
    const { res } = await grantedInstall(home, lock, fixture.path, {
      mounter: mounts.mounter,
      unmounter: mounts.unmounter,
      signatureRun: sigScript({ codesignOk: false, teamId: FAKE_TEAM_ID, detail: "codesign exit=1 (scripted)" }).run,
    })
    expect(res.token).toBe(OUTCOME.FAILED)
    expect(mounts.detachCalls.length).toBe(1)
    expect(existsSync(VERSION_DIR(home))).toBe(false)
    const lines = provLines(home)
    const sigLine = lines.find((l) => l.stage === "signature")
    expect(sigLine?.code).toBe("SIGNATURE_FAILED")
    expect(sigLine?.observedTeamIdentifier).toBe(FAKE_TEAM_ID) // recorded even on refusal (audit)
  })

  it("attach failure: NOTHING was mounted, so detach is NOT called; mountpoint dir cleaned", async () => {
    const home = freshHome("f3")
    const fixture = buildFakeDmg(home)
    const lock = fakeLock(fixture)
    const mounts = mountSpy({ failAttach: true })
    const { res } = await grantedInstall(home, lock, fixture.path, {
      mounter: mounts.mounter,
      unmounter: mounts.unmounter,
    })
    expect(res.token).toBe(OUTCOME.FAILED)
    expect(mounts.attachCalls.length).toBe(1)
    expect(mounts.detachCalls.length).toBe(0) // honest: you cannot detach what never attached
    expect(existsSync(mounts.attachCalls[0]?.mountPoint ?? "\u0000")).toBe(false)
    const lines = provLines(home)
    expect(lines.some((l) => l.stage === "mount" && l.code === "MOUNT_FAILED")).toBe(true)
  })

  it("mounted volume without Obsidian.app: MOUNT_CONTENT refusal, still detached", async () => {
    const home = freshHome("f4")
    const fixture = buildFakeDmg(home)
    const lock = fakeLock(fixture)
    const mounts = mountSpy({ buildApp: false })
    const { res } = await grantedInstall(home, lock, fixture.path, {
      mounter: mounts.mounter,
      unmounter: mounts.unmounter,
    })
    expect(res.token).toBe(OUTCOME.FAILED)
    expect(res.message ?? "").toContain("Obsidian.app")
    expect(mounts.detachCalls.length).toBe(1)
    expect(existsSync(VERSION_DIR(home))).toBe(false)
  })

  it("detach FAILURE is surfaced as a warn and the live mountpoint is left in place (never force-deleted)", async () => {
    const home = freshHome("f5")
    const fixture = buildFakeDmg(home)
    const lock = fakeLock(fixture)
    const mounts = mountSpy()
    const { res } = await grantedInstall(home, lock, fixture.path, {
      mounter: mounts.mounter,
      unmounter: (mp: string) => {
        mounts.detachCalls.push(mp)
        return { ok: false, detail: "injected busy-volume detach failure (unit)" }
      },
      logPath: join(home, "setup.log"),
    })
    expect(res.token).toBe(OUTCOME.OK) // the primary outcome stands; the leak is loud, not hidden
    const leaked = mounts.attachCalls[0]?.mountPoint ?? "\u0000"
    expect(existsSync(leaked)).toBe(true) // NOT recursively swept while possibly still mounted
    const logText = readFileSync(join(home, "setup.log"), "utf8")
    expect(logText).toContain("unmount FAILED")
  })
})

describe("(g) U-2 TeamID closer mechanism (record-first / refuse-on-mismatch / honest-absence)", () => {
  it("null lock pin: the FIRST OBSERVED value is recorded verbatim in record + pointer + ledger", async () => {
    const home = freshHome("g1")
    const fixture = buildFakeDmg(home)
    const lock = fakeLock(fixture, null)
    expect(lockedTeamId(lock)).toBeUndefined() // null in the lock means UNCONFIRMED, not ""
    const { res } = await grantedInstall(home, lock, fixture.path)
    expect(res.token).toBe(OUTCOME.OK)
    expect(readInstallRecord(VERSION_DIR(home))?.observedTeamIdentifier).toBe(FAKE_TEAM_ID)
    const pointer = JSON.parse(readFileSync(join(TOOL_ROOT(home), "current.json"), "utf8")) as Record<string, unknown>
    expect(pointer.observedTeamIdentifier).toBe(FAKE_TEAM_ID)
    expect(provLines(home).at(-1)?.observedTeamIdentifier).toBe(FAKE_TEAM_ID)
  })

  it("confirmed lock pin + different observation: FAILS CLOSED, detaches, stages nothing", async () => {
    const home = freshHome("g2")
    const fixture = buildFakeDmg(home)
    const lock = fakeLock(fixture, "EXPECTEDID")
    const mounts = mountSpy()
    const { res } = await grantedInstall(home, lock, fixture.path, {
      mounter: mounts.mounter,
      unmounter: mounts.unmounter,
      signatureRun: sigScript({ teamId: "OTHERID" }).run,
    })
    expect(res.token).toBe(OUTCOME.FAILED)
    expect(res.message ?? "").toContain("TeamIdentifier=EXPECTEDID")
    expect(mounts.detachCalls.length).toBe(1)
    expect(existsSync(VERSION_DIR(home))).toBe(false)
  })

  it("no TeamIdentifier printed: honest null recorded + warn that the closer did not fire", async () => {
    const home = freshHome("g3")
    const fixture = buildFakeDmg(home)
    const lock = fakeLock(fixture, null)
    const { res } = await grantedInstall(home, lock, fixture.path, {
      signatureRun: sigScript({ detail: "codesign exit=0; spctl exit=0; TeamIdentifier=<none>" }).run,
    })
    expect(res.token).toBe(OUTCOME.OK) // codesign+spctl passed; absence is recorded, not guessed
    expect(readInstallRecord(VERSION_DIR(home))?.observedTeamIdentifier).toBeNull()
    expect(readFileSync(join(home, "setup.log"), "utf8")).toContain("U-2 closer did not fire")
  })
})

describe("(h) dry-run: zero filesystem writes; mount/copy NEVER reached", () => {
  it("absent posture leaves the ENTIRE HOME tree empty", async () => {
    const home = freshHome("h1")
    const wouldBe = join(TOOL_ROOT(home), DMG_NAME)
    const lock = fakeLock({ sha256: "ab".repeat(32), bytes: 1 })
    const mounts = mountSpy()
    const { res, spy } = await grantedInstall(
      home,
      lock,
      wouldBe,
      { mounter: mounts.mounter, unmounter: mounts.unmounter },
      true,
      "dry_run",
    )
    expect(res.token).toBe(OUTCOME.OK)
    expect(spy.sawDryRun).toBe(true) // propagated into row 82's own zero-write posture
    expect(mounts.attachCalls.length).toBe(0)
    expect(existsSync(join(home, ".swarm"))).toBe(false)
    expect(tree(home)).toEqual([]) // no state.json, no setup.log, no prov ledger, no tool dir, no vault
  })

  it("valid staged install under --dry-run reports resume and changes nothing on disk", async () => {
    const home = freshHome("h2")
    const fixture = buildFakeDmg(home)
    const lock = fakeLock(fixture)
    await grantedInstall(home, lock, fixture.path)
    const before = tree(home)
    const { res } = await grantedInstall(home, lock, fixture.path, {}, true)
    expect(res.token).toBe(OUTCOME.OK)
    expect(res.message ?? "").toContain("already staged")
    expect(tree(home)).toEqual(before) // byte-for-byte identical listing incl. sizes
  })
})

describe("(i) remove: deletes ONLY state-listed paths inside the tool root", () => {
  it("deletes version dir, pointer and dmg; an unlisted sibling survives; second remove skips", async () => {
    const home = freshHome("i1")
    const fixture = buildFakeDmg(home)
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
    expect(existsSync(fixture.path)).toBe(false) // the dmg was state-listed too
    expect(existsSync(keepMe)).toBe(true) // NEVER delete what the state file does not list

    const after = readState(lock.version)
    if (after.ok) {
      expect(after.state.components.obsidian.state).toBe("absent")
      expect(after.state.components.obsidian.installedBySwarm).toBe(false)
      expect(after.state.components.obsidian.paths).toBeUndefined()
    }
    const again = step.remove(ctxOf(lock, after.ok ? after.state : undefined))
    expect(again.token).toBe(OUTCOME.SKIPPED)
    expect(existsSync(keepMe)).toBe(true)
  })

  it("a DETECTED (user-installed) Obsidian is SKIPPED by remove, never deleted (L14/P-14)", async () => {
    const home = freshHome("i2")
    const lock = fakeLock({ sha256: "cd".repeat(32), bytes: 10 })
    const state = defaultState(lock.version)
    state.components.obsidian = { state: "skipped", version: FAKE_VERSION } // installedBySwarm ABSENT — detected posture
    writeState(state)
    mkdirSync(STAGED_APP(home), { recursive: true }) // something else's tree sits in the tool dir
    const res = step.remove(ctxOf(lock, state))
    expect(res.token).toBe(OUTCOME.SKIPPED)
    expect(existsSync(STAGED_APP(home))).toBe(true) // byte-untouched
  })

  it("a state-listed path OUTSIDE the tool root is refused and survives (P-14/P-16 boundary)", async () => {
    const home = freshHome("i3")
    const fixture = buildFakeDmg(home)
    const lock = fakeLock(fixture)
    await grantedInstall(home, lock, fixture.path)
    const outside = join(home, "precious.txt")
    writeFileSync(outside, "listed maliciously in a doctored state\n")

    const state = readState(lock.version)
    expect(state.ok).toBe(true)
    if (state.ok) {
      state.state.components.obsidian = {
        ...state.state.components.obsidian,
        paths: [...(state.state.components.obsidian.paths ?? []), outside],
      }
      writeState(state.state) // doctored through the engine's own commit point
    }
    const res = step.remove(ctxOf(lock, state.ok ? state.state : undefined), { logPath: join(home, "setup.log") })
    expect(res.token).toBe(OUTCOME.OK)
    expect(existsSync(outside)).toBe(true) // outside-root entries are refused, not deleted
    expect(existsSync(VERSION_DIR(home))).toBe(false) // listed inside-root paths still go
  })
})

describe("(j) guide-and-detect: a pre-existing install stops the staging path", () => {
  it("detector found -> SKIPPED with zero fetch/mount calls; state skipped; NOT installedBySwarm", async () => {
    const home = freshHome("j1")
    const fixture = buildFakeDmg(home)
    const lock = fakeLock(fixture)
    const spy = fetchSpy(fixture.path)
    const mounts = mountSpy()
    const res = await step.install(ctxOf(lock), {
      provenancePath: join(home, "prov.jsonl"),
      logPath: join(home, "setup.log"),
      consentGate: () => true,
      fetchImpl: spy.impl,
      mounter: mounts.mounter,
      unmounter: mounts.unmounter,
      detector: () => ({
        found: true,
        paths: ["/Applications/Obsidian.app"],
        methods: ["stat:/Applications/Obsidian.app"],
      }),
    })
    expect(res.token).toBe(OUTCOME.SKIPPED)
    expect(res.message ?? "").toContain("/Applications/Obsidian.app")
    expect(spy.calls).toBe(0) // detected -> nothing fetched
    expect(mounts.attachCalls.length).toBe(0)
    const st = readState(lock.version)
    if (st.ok) {
      expect(st.state.components.obsidian.state).toBe("skipped")
      expect(st.state.components.obsidian.installedBySwarm).not.toBe(true)
    }
  })

  it("own valid staged install takes PRECEDENCE over a later-detected system copy", async () => {
    const home = freshHome("j2")
    const fixture = buildFakeDmg(home)
    const lock = fakeLock(fixture)
    await grantedInstall(home, lock, fixture.path)

    const spy = fetchSpy(fixture.path)
    const res = await step.install(
      ctxOf(
        lock,
        readState(lock.version).ok ? (readState(lock.version) as { ok: true; state: StateFile }).state : undefined,
      ),
      {
        provenancePath: join(home, "prov.jsonl"),
        consentGate: () => true,
        fetchImpl: spy.impl,
        mounter: mountSpy().mounter,
        unmounter: mountSpy().unmounter,
        detector: () => ({ found: true, paths: ["/Applications/Obsidian.app"], methods: ["stat"] }),
      },
    )
    expect(res.token).toBe(OUTCOME.OK)
    expect(res.message ?? "").toContain("resumed") // our managed install is reported, not masked
    expect(spy.calls).toBe(0)
  })
})

describe("(k) the REAL read-only detector runs on this host without writing anything", () => {
  it("detectExistingInstall() returns a well-formed result and leaves the HOME tree unchanged", () => {
    const home = freshHome("k1")
    const before = tree(home)
    const det = detectExistingInstall() // real stat + real mdfind — READ-ONLY by construction
    expect(typeof det.found).toBe("boolean")
    expect(Array.isArray(det.paths)).toBe(true)
    expect(det.methods.length).toBeGreaterThanOrEqual(1)
    for (const p of det.paths) expect(p.endsWith(".app")).toBe(true)
    expect(tree(home)).toEqual(before) // detection provably writes nothing
  })
})
