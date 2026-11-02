// Row-86 unit tests for the runtime step (src/steps/runtime/). NO real VM is started —
// row 93 runs stacks and row 112 verifies; this suite drives every external command
// through an injected CommandRunner (scripted fixtures), so:
//   - preflight refusals (incl. the fake-old-macOS fixture) are MEASURED on the pure
//     decision core — no machine spoofing, exactly the r82/r83 seam discipline;
//   - dry-run zero-exec is MEASURED with the instrumented spawn counter + an asserted
//     empty HOME tree (zero filesystem writes);
//   - the blueprint's "install, health and remove cycle passes against a mock" runs the
//     FULL installWithDeps happy path against scripted brew/colima/docker/lima answers,
//     with a REAL capture over a fake-HOME lima.yaml + cache file (the digest is computed
//     by the real verify.ts over real bytes — the D-13 mechanism proven, not mocked);
//   - FIX ROUND (r93 live findings): the fake-colima fixtures emit the MEASURED context
//     naming `colima-swarm` (H-R93-1), the real content-addressed-cache layout drives the
//     D-13 RECORDED-UNKNOWN terminal state, and H-R93-7/8 regressions are pinned.
//
// Run TARGETED (row 102 owns the full suite):
//   cd packages/setup && bun test test/runtime.test.ts

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chmodSync, rmSync } from "node:fs" // r272 env-strip block
import { spawnSync as nodeSpawnSync } from "node:child_process" // r272
import { DOCKER_ENV_DENY } from "../src/dockerRunner.real.ts" // r272: the one setup-side deny-list
// Per-run isolation of the source-posture lock (replaces the shared src/tools.lock.json staging).
import { isolateSourceLock } from "./lockPosture.ts"
import { createHash } from "node:crypto"
import { loadLock, type LockFile } from "../src/lockfile.ts"
import { defaultState, readState } from "../src/state.ts"
import { discoverSteps, orderSteps, validateDescriptor } from "../src/steps.ts"
import { OUTCOME, exitCodeFor } from "../src/outcomes.ts"
import { COLIMA_PROFILE, DOCKER_CONTEXT, LABELS, STATES, type ComponentId } from "../src/constants.ts"
import { installWithDeps, removeWithDeps } from "../src/steps/runtime/index.ts"
import {
  evaluatePreflight,
  bottleFloor,
  reviewedCodenames,
  FIRECRAWL_MEM_FLOOR_BYTES,
  parseDarwinMajor,
  preflightProbeArgv,
} from "../src/steps/runtime/preflight.ts"
import type { HostInfo } from "../src/steps/runtime/preflight.ts"
import {
  colimaStartArgv,
  contextCandidates,
  dockerContextLsArgv,
  dockerInfoArgv,
  foreignContainersArgv,
  printOnlyRunner,
  scriptedRunner,
  spawnRunner,
} from "../src/steps/runtime/commands.ts"
import {
  buildContextEvidence,
  currentMarkers,
  observeDockerContext,
  parseImageUrls,
  parseVersionFromUrl,
  parseProfileJson,
  basenameHexCandidate,
  resolveLocalCacheRef,
  observeQemuScope,
  QEMU_DECLARED_SCOPE,
  readCaptures,
  limaLayoutPath,
} from "../src/steps/runtime/capture.ts"

// ---- source-run lock posture: private program dir per run (see test/lockPosture.ts) ----
let releaseLockPosture: (() => void) | undefined
let LOCK: LockFile

beforeAll(() => {
  releaseLockPosture = isolateSourceLock()
  const loaded = loadLock()
  if (!loaded.ok) throw new Error(`loadLock failed in test setup: ${loaded.error}`)
  LOCK = loaded.lock
})
afterAll(() => {
  releaseLockPosture?.()
})

function freshHome(label: string): string {
  const home = mkdtempSync(join(tmpdir(), `swarm-r86-${label}-`))
  process.env.HOME = home
  return home
}

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

/** Consent seam (stepkit's own discipline, forwarded): drives the granted path in tests. */
const granted = (_id: ComponentId): boolean => true

// ---- host fixtures ---------------------------------------------------------------------

const GIB = 1024 ** 3

function host(over: Partial<HostInfo> = {}): HostInfo {
  return {
    productVersion: "27.0.1", // this dev host's shape: golden_gate, inside the reviewed set
    darwinMajor: 27,
    memsizeBytes: 24 * GIB,
    ncpu: 10,
    virtualizationFramework: true,
    brewPrefix: "/opt/homebrew",
    rosettaBrewOnly: false,
    ...over,
  }
}

// ---- (1) descriptor + registration -------------------------------------------------------

describe("descriptor and directory-scan registration", () => {
  it("step.json validates with id === directory name 'runtime' (PC-CMP-01)", () => {
    const raw = JSON.parse(readFileSync(join(import.meta.dir, "..", "src", "steps", "runtime", "step.json"), "utf8"))
    const v = validateDescriptor(raw, "runtime")
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.descriptor.requires).toEqual([])
  })

  it("discoverSteps registers runtime with ZERO scan errors (a bad descriptor would fail every install closed)", () => {
    const scan = discoverSteps()
    expect(scan.errors).toEqual([])
    expect(scan.steps.map((s) => s.id)).toContain("runtime")
  })

  it("orderSteps places a synthetic dependent AFTER runtime", () => {
    const ordered = orderSteps([
      { id: "searxng", order: 60, requires: ["runtime"] },
      { id: "runtime", order: 10, requires: [] },
    ])
    expect(ordered.ok).toBe(true)
    if (ordered.ok) expect(ordered.ordered.map((s) => s.id)).toEqual(["runtime", "searxng"])
  })
})

// ---- (2) preflight floors (pure decision core) --------------------------------------------

describe("preflight: brew-bottle floor computed mechanically from tools.lock.json", () => {
  it("floor is macOS 15 sequoia on the shipped lock (intersection across all five artifacts)", () => {
    const floor = bottleFloor(LOCK)
    expect(floor).not.toBeNull()
    expect(floor?.codename).toBe("sequoia")
    expect(floor?.major).toBe(15)
    expect(reviewedCodenames(LOCK)).toEqual(["golden_gate", "tahoe", "sequoia"]) // sonoma is colima-ONLY -> excluded
  })

  it("fake-old-macOS fixture (13.6 Ventura) is REFUSED naming the floor (fail-closed, decisions.md brew-floor ruling)", () => {
    const r = evaluatePreflight(host({ productVersion: "13.6.9", darwinMajor: 13 }), LOCK, false)
    expect(r.verdict).toBe("refuse")
    if (r.verdict === "refuse") {
      expect(r.token).toBe(OUTCOME.REFUSED_PLATFORM)
      expect(r.message).toContain("macOS 15")
      expect(r.message).toContain("sequoia")
      expect(r.message).toContain(LOCK.version)
    }
    expect(exitCodeFor(OUTCOME.REFUSED_PLATFORM)).toBe(1)
  })

  it("macOS 14 sonoma is ALSO refused: lima/docker_cli/qemu/compose have no sonoma bottle (intersection rule)", () => {
    const r = evaluatePreflight(host({ productVersion: "14.7.2", darwinMajor: 14 }), LOCK, false)
    expect(r.verdict).toBe("refuse")
  })

  it("unknown future major (28) is refused too — unreviewed hashes are never silently used", () => {
    const r = evaluatePreflight(host({ productVersion: "28.0", darwinMajor: 28 }), LOCK, false)
    expect(r.verdict).toBe("refuse")
    if (r.verdict === "refuse") expect(r.message).toContain("no reviewed brew bottle")
  })

  it("golden_gate 27.0.1 passes (this dev host's shape)", () => {
    const r = evaluatePreflight(host(), LOCK, false)
    expect(r.verdict).toBe("pass")
  })

  it("missing Virtualization.framework refuses naming the vz-only D-12 closure", () => {
    const r = evaluatePreflight(host({ virtualizationFramework: false }), LOCK, false)
    expect(r.verdict).toBe("refuse")
    if (r.verdict === "refuse") expect(r.message).toContain("vm-type vz ONLY")
  })

  it("Rosetta-prefix brew alone refuses citing the startup-break warning", () => {
    const r = evaluatePreflight(host({ brewPrefix: null, rosettaBrewOnly: true }), LOCK, false)
    expect(r.verdict).toBe("refuse")
    if (r.verdict === "refuse") expect(r.message).toContain("x86_64-prefix")
  })

  it("no Homebrew at all -> SKIPPED_WITH_INSTRUCTIONS (P-3), exit-0 family, exact guidance printed", () => {
    const r = evaluatePreflight(host({ brewPrefix: null }), LOCK, false)
    expect(r.verdict).toBe("skip_instructions")
    if (r.verdict === "skip_instructions") {
      expect(r.token).toBe(OUTCOME.SKIPPED_WITH_INSTRUCTIONS)
      expect(exitCodeFor(r.token)).toBe(0)
      expect(r.instructions.join(" ")).toContain("brew.sh")
    }
  })

  it("parseDarwinMajor handles 27.0.1 / bare 15 / garbage", () => {
    expect(parseDarwinMajor("27.0.1")).toBe(27)
    expect(parseDarwinMajor("15")).toBe(15)
    expect(parseDarwinMajor("beta")).toBeNull()
  })

  it("H-R93-7 regression: probes use the REAL macOS sysctl path /usr/sbin", () => {
    const sysctlProbe = preflightProbeArgv().find((a) => a.some((t) => t.includes("sysctl"))) ?? []
    expect(sysctlProbe[0]).toBe("/usr/sbin/sysctl")
  })
})

describe("preflight: memory floor + sizing contract (01e §7.1)", () => {
  it("Firecrawl consented + >=16 GiB -> 8 vCPU / 10 GiB contract line", () => {
    const r = evaluatePreflight(host(), LOCK, true)
    expect(r.verdict === "pass" && r.sizing.cpu).toBe(8)
    expect(r.verdict === "pass" && r.sizing.memoryGiB).toBe(10)
    expect(r.verdict === "pass" && r.firecrawlOffered).toBe(true)
  })

  it("Firecrawl consented but 8 GiB host -> Firecrawl SKIPPED ([H-MEM] decision 12), sizing falls to 2/2", () => {
    const r = evaluatePreflight(host({ memsizeBytes: 8 * GIB }), LOCK, true)
    expect(r.verdict).toBe("pass")
    if (r.verdict === "pass") {
      expect(r.firecrawlOffered).toBe(false)
      expect(r.sizing).toEqual({ cpu: 2, memoryGiB: 2 })
      expect(r.memoryFloor.meetsFloor).toBe(false)
      expect(r.memoryFloor.thresholdBytes).toBe(FIRECRAWL_MEM_FLOOR_BYTES)
      expect(r.notes.some((n) => n.includes("Firecrawl is SKIPPED"))).toBe(true)
    }
  })

  it("floor boundary is exact: 17179869184 B meets, one byte less does not", () => {
    const at = evaluatePreflight(host({ memsizeBytes: FIRECRAWL_MEM_FLOOR_BYTES }), LOCK, true)
    const under = evaluatePreflight(host({ memsizeBytes: FIRECRAWL_MEM_FLOOR_BYTES - 1 }), LOCK, true)
    expect(at.verdict === "pass" && at.memoryFloor.meetsFloor).toBe(true)
    expect(under.verdict === "pass" && under.memoryFloor.meetsFloor).toBe(false)
  })

  it("6-core host with Firecrawl sizes DOWN with a printed note instead of refusing (01e §7.1 row-86 cell)", () => {
    const r = evaluatePreflight(host({ ncpu: 6 }), LOCK, true)
    expect(r.verdict === "pass" && r.cpuFloor.sizedDown).toBe(true)
    expect(r.verdict === "pass" && r.sizing.cpu).toBeLessThan(8)
    expect(r.verdict === "pass" && r.notes.some((n) => n.includes("sizing DOWN"))).toBe(true)
  })

  it("SearXNG-only branch is 2 vCPU / 2 GiB regardless of RAM", () => {
    const r = evaluatePreflight(host({ memsizeBytes: 32 * GIB }), LOCK, false)
    expect(r.verdict === "pass" && r.sizing).toEqual({ cpu: 2, memoryGiB: 2 })
  })
})

// ---- (3) dry-run: instrumented zero-execution -----------------------------------------------

describe("dry-run prints every command and executes NOTHING", () => {
  it("install --dry-run: executedCount 0, commands printed, HOME tree stays empty", async () => {
    const home = freshHome("dry1")
    const runner = printOnlyRunner()
    const res = await installWithDeps(
      { lock: LOCK, state: defaultState(LOCK.version), dryRun: true },
      { runner, consentGate: granted, consentFirecrawl: true },
    )
    expect(res.token).toBe(OUTCOME.OK)
    expect(runner.executedCount).toBe(0)
    expect(res.message).toContain("0 executed")
    expect(tree(join(home, ".swarm"))).toEqual([]) // zero filesystem writes (kit dry posture)
  })

  it("printed plan covers probes, brew, colima start (profile+vm-type+activate=false), context ls, OBSERVATION placeholder", async () => {
    freshHome("dry2")
    const runner = printOnlyRunner()
    await installWithDeps(
      { lock: LOCK, state: defaultState(LOCK.version), dryRun: true },
      { runner, consentGate: granted, consentFirecrawl: false },
    )
    const all = runner.printed.join("\n")
    expect(all).toContain("/usr/bin/sw_vers -productVersion")
    expect(all).toContain("/usr/sbin/sysctl -n hw.memsize")
    expect(all).toContain("--profile swarm")
    expect(all).toContain("--vm-type vz")
    expect(all).toContain("--activate=false")
    expect(all).toContain("docker context ls")
    expect(all).toContain("<observed:") // H-R93-1: the plan shows OBSERVATION (candidate set from constants), never an assumption
  })

  it("without consent the step refuses BEFORE touching the runner at all (layer 2, non-fetch channel)", async () => {
    freshHome("dry3")
    const runner = scriptedRunner([])
    const res = await installWithDeps(
      { lock: LOCK, state: defaultState(LOCK.version), dryRun: false },
      { runner, consentFirecrawl: false },
    )
    expect(res.token).toBe(OUTCOME.REFUSED_NO_CONSENT)
    expect(runner.calls).toEqual([]) // not even a probe ran
  })

  it("remove --dry-run prints the stop/delete plan without executing", async () => {
    freshHome("dry4")
    const runner = printOnlyRunner()
    const st = defaultState(LOCK.version)
    st.components.runtime = {
      state: STATES.HEALTHY,
      dockerObjects: [
        { kind: "profile", id: COLIMA_PROFILE, createdBySwarm: true, hasData: true },
        { kind: "context", id: "colima-swarm", createdBySwarm: true, hasData: false },
      ],
    }
    const res = await removeWithDeps({ lock: LOCK, state: st, dryRun: true }, { runner, consentGate: granted })
    expect(res.token).toBe(OUTCOME.OK)
    expect(runner.executedCount).toBe(0)
    expect(runner.printed.join("\n")).toContain("--profile swarm")
    expect(runner.printed.join("\n")).toContain("--context colima-swarm") // observed name flows into the plan
  })
})

// ---- (4) mocked install->health->remove cycle --------------------------------------------------

const GUEST_URL =
  "https://github.com/abiosoft/colima-core/releases/download/v0.10.4/ubuntu-24.04-minimal-cloudimg-arm64-docker.raw.gz"
const GUEST_BYTES = new Uint8Array([1, 2, 3, 4, 5, 7, 11, 13]) // deterministic fake disk image
const GUEST_SHA = createHash("sha256").update(GUEST_BYTES).digest("hex")

/** Stage the colima/lima artefacts a FIRST bring-up would have left behind, inside the
 *  fake HOME, so the capture reads REAL metadata files through the real parsers.
 *  mode "remote": lima.yaml points at a URL, bytes in lima basedata (original hypothesis).
 *  mode "local-cache": r93's MEASURED layout — location IS a content-addressed cache file
 *  whose hex basename claims the digest; version unparseable -> recorded-unknown. */
function stageColimaFootprint(home: string, mode: "remote" | "local-cache" = "remote"): { cacheHex?: string } {
  const profileDir = join(home, ".colima", "_lima", `colima-${COLIMA_PROFILE}`) // measured slot #2 (r93: LIMA_HOME override)
  mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  if (mode === "remote") {
    writeFileSync(
      join(profileDir, "lima.yaml"),
      `images:\n  - location: "${GUEST_URL}"\n    arch: aarch64\nvmType: vz\n`,
      { mode: 0o600 },
    )
    const basedata = join(home, ".lima", `colima-${COLIMA_PROFILE}`, "basedata")
    mkdirSync(basedata, { recursive: true, mode: 0o700 })
    writeFileSync(join(basedata, GUEST_URL.split("/").pop() as string), GUEST_BYTES)
    return {}
  }
  const caches = join(home, "Library", "Caches", "colima", "caches")
  mkdirSync(caches, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(profileDir, "lima.yaml"),
    `images:\n  - location: "${caches}/${GUEST_SHA}"\n    arch: aarch64\nvmType: vz\n`,
    { mode: 0o600 },
  )
  writeFileSync(join(caches, GUEST_SHA), GUEST_BYTES)
  return { cacheHex: GUEST_SHA }
}

interface CycleOpts {
  readonly markerMoved?: boolean
  readonly noSwarmContext?: boolean
  readonly bottleDrift?: boolean
  readonly healthFails?: boolean
}

/** Sequence-aware runner with the MEASURED colima naming (r93 H-R93-1): the context table
 *  gains `colima-swarm`, never plain `swarm`. Context-ls answers BEFORE on call 1 and the
 *  AFTER table later; everything else replays a flat prefix script (prefix ORDER matters:
 *  docker-compose before docker). */
function cycleRunner(opts: CycleOpts = {}) {
  const calls: string[] = []
  let contextLsCalls = 0
  // r274: the brew mock reports exactly what the shipped lock pins (read from LOCK, never a
  // literal), so a reviewed lock refresh does not need a test edit to keep the mock aligned.
  const infoJson = (name: string, sha: string): string => {
    const version =
      name === "docker"
        ? lockPinVersion("docker_cli")
        : name === "docker-compose"
          ? lockPinVersion("docker_compose")
          : name === "lima"
            ? lockPinVersion("lima")
            : lockPinVersion("colima")
    return JSON.stringify({
      formula: [{ name, stable: { version }, bottle: { stable: { files: { arm64_golden_gate: { sha256: sha } } } } }],
    })
  }
  const script = [
    { match: "/opt/homebrew/bin/brew list --formula --versions colima", stdout: `colima ${lockPinVersion("colima")}\n` },
    { match: "/opt/homebrew/bin/brew list --formula --versions lima", stdout: `lima ${lockPinVersion("lima")}\n` },
    {
      match: "/opt/homebrew/bin/brew list --formula --versions docker-compose",
      stdout: `docker-compose ${lockPinVersion("docker_compose")}\n`,
    },
    { match: "/opt/homebrew/bin/brew list --formula --versions docker", stdout: `docker ${lockPinVersion("docker_cli")}\n` },
    { match: "/opt/homebrew/bin/brew list --formula --versions qemu", result: { exitCode: 1 } },
    {
      match: "/opt/homebrew/bin/brew info --json=v2 colima",
      stdout: infoJson("colima", opts.bottleDrift ? "f".repeat(64) : lockBottle("colima")),
    },
    { match: "/opt/homebrew/bin/brew info --json=v2 lima", stdout: infoJson("lima", lockBottle("lima")) },
    {
      match: "/opt/homebrew/bin/brew info --json=v2 docker-compose",
      stdout: infoJson("docker-compose", lockBottle("docker_compose")),
    },
    { match: "/opt/homebrew/bin/brew info --json=v2 docker", stdout: infoJson("docker", lockBottle("docker_cli")) },
    {
      match: "/opt/homebrew/bin/colima list --json",
      stdout:
        '{"name":"default","status":"Running","arch":"aarch64","cpus":4,"memory":8589934592,"disk":64424509440,"runtime":"docker"}\n',
    }, // measured single-profile shape (bare object)
    { match: "/opt/homebrew/bin/colima start", stdout: "time=... provisioning\n" },
    {
      match: "/opt/homebrew/bin/limactl inspect",
      stdout: JSON.stringify({ config: { images: [{ location: GUEST_URL, digest: `sha256:${GUEST_SHA}` }] } }),
    },
    { match: "/opt/homebrew/bin/docker --context colima-swarm ps", stdout: "" },
    {
      match: "/opt/homebrew/bin/docker --context colima-swarm info",
      result: opts.healthFails
        ? { exitCode: 1, stderr: "Cannot connect to the Docker daemon" }
        : { stdout: "29.9.1\n" },
    },
    { match: "/opt/homebrew/bin/docker context use", stdout: 'Context "default" set as the default*\n' },
  ]
  const inner = scriptedRunner(script)
  return {
    calls,
    run(argv: readonly string[]) {
      calls.push(argv.join(" "))
      if (argv.join(" ").includes("context ls")) {
        contextLsCalls += 1
        if (opts.noSwarmContext) return { ok: true, exitCode: 0, stdout: "default *\n", stderr: "" } // never gains a candidate row
        // call1 = before-manifest; call2 = OBSERVATION read; call3 = restore-check read (still
        // moved if colima activated); call4+ = post-restore re-read (marker back with user).
        const table =
          opts.markerMoved && contextLsCalls >= 2 && contextLsCalls <= 3
            ? "default \ncolima-swarm *\n"
            : contextLsCalls === 1
              ? "default *\n"
              : "default *\ncolima-swarm \n"
        return { ok: true, exitCode: 0, stdout: table, stderr: "" }
      }
      return inner.run(argv)
    },
    get executedCount() {
      return calls.length
    },
    get printed() {
      return calls
    },
  }
}

/** The pinned formula version for one runtime artifact, as brew prints it (no leading v). */
function lockPinVersion(field: string): string {
  const entry = (LOCK.components.runtime?.[field] ?? {}) as Record<string, unknown>
  const v = entry.version
  if (typeof v !== "string" || v.trim() === "") throw new Error(`lock has no runtime.${field}.version`)
  return v.trim().replace(/^v/, "")
}

function lockBottle(field: string): string {
  const entry = (LOCK.components.runtime?.[field] ?? {}) as Record<string, unknown>
  const map = (entry.brew_bottles ?? entry.bottle_sha256 ?? {}) as Record<string, string>
  return map.arm64_golden_gate ?? ""
}

const sigOk = () => ({ codesignOk: true, spctlOk: true, detail: "fixture" })

describe("mocked install -> healthy -> remove cycle (blueprint gate: 'passes against a mock')", () => {
  it("happy path reaches healthy on the OBSERVED colima-swarm context; state carries integrity + profile + context; D-13 capture lands in BOTH ledgers + lima-layout.json", async () => {
    const home = freshHome("cycle1")
    stageColimaFootprint(home)
    const runner = cycleRunner()
    const st = defaultState(LOCK.version)
    const res = await installWithDeps(
      { lock: LOCK, state: st, dryRun: false },
      { runner, host: host(), consentGate: granted, consentFirecrawl: true, signatureRun: sigOk },
    )
    expect(res.token).toBe(OUTCOME.OK)
    expect(res.message).toContain("8 vCPU / 10 GiB")
    expect(res.message).toContain("context colima-swarm") // H-R93-1: observed, never assumed

    // state.json evidence (single-writer commits through kit -> setState)
    const back = readState(LOCK.version)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    const rt = back.state.components.runtime
    expect(rt.state).toBe(STATES.HEALTHY)
    expect(rt.integrity).toBe(`sha256:${String((LOCK.components.runtime?.colima as Record<string, unknown>).sha256)}`)
    expect(
      rt.dockerObjects?.some((o) => o.kind === "profile" && o.id === COLIMA_PROFILE && o.createdBySwarm === true),
    ).toBe(true)
    expect(
      rt.dockerObjects?.some((o) => o.kind === "context" && o.id === "colima-swarm" && o.createdBySwarm === true),
    ).toBe(true) // r91 reads THIS

    // D-13 capture ledger: url/version/sha256 established from staged REAL files
    const captures = readCaptures()
    expect(captures.length).toBe(1)
    expect(captures[0]?.url).toBe(GUEST_URL)
    expect(captures[0]?.version).toBe("v0.10.4")
    expect(captures[0]?.sha256).toBe(GUEST_SHA)
    expect(captures[0]?.digestCrossCheck).toBe("match")
    expect(captures[0]?.lockHadNullPin).toBe(true)

    // provenance mirror for rows 108/111/112 re-verification
    const prov = readFileSync(join(home, ".swarm", "setup", "provenance.jsonl"), "utf8")
    expect(prov).toContain("D13_CAPTURE")
    expect(prov).toContain(GUEST_SHA)

    // lima-layout.json durable (transcription read-path for rows 80/108)
    const layout = JSON.parse(readFileSync(limaLayoutPath(), "utf8")) as {
      complete: boolean
      instanceName: string
      computedSha256: string | null
    }
    expect(layout.complete).toBe(true)
    expect(layout.instanceName).toBe("colima-swarm")
    expect(layout.computedSha256).toBe(GUEST_SHA)

    // first bring-up ran verbose (the capture duty), vm-type vz explicit, disk stated, activation suppressed
    const startLine = runner.calls.find((c) => c.includes("colima start")) ?? ""
    expect(startLine).toContain("--very-verbose")
    expect(startLine).toContain("--vm-type vz")
    expect(startLine).toContain("--disk 60")
    expect(startLine).toContain("--activate=false")

    // health + foreign commands carried the OBSERVED context, never the assumed one
    expect(runner.calls.some((c) => c.includes("--context colima-swarm info"))).toBe(true)
    expect(runner.calls.some((c) => c.includes("--context swarm "))).toBe(false)

    // qemu scope + bottle observation recorded durably in the same ledger
    const ledger = readFileSync(join(home, ".swarm", "tools", "runtime", "guest-image-capture.jsonl"), "utf8")
    expect(ledger).toContain('"type":"qemu_scope"')
    expect(ledger).toContain(QEMU_DECLARED_SCOPE)
    expect(ledger).toContain('"type":"bottle_observation"')
  })

  it("r93 MEASURED layout (local content-addressed cache, version unparseable) -> RECORDED-UNKNOWN: install CONTINUES to healthy with honest records", async () => {
    const home = freshHome("cycle9")
    stageColimaFootprint(home, "local-cache")
    const runner = cycleRunner()
    const st = defaultState(LOCK.version)
    const res = await installWithDeps(
      { lock: LOCK, state: st, dryRun: false },
      { runner, host: host(), consentGate: granted, consentFirecrawl: false, signatureRun: sigOk },
    )
    expect(res.token).toBe(OUTCOME.OK) // 01c §8: metadata gap is NOT a listed failed trigger; P-15 named-outcome rule
    expect(res.message).toContain("recorded-unknown")
    expect(res.message).toContain("missing version")

    const rt = readState(LOCK.version)
    if (rt.ok) {
      expect(rt.state.components.runtime.state).toBe(STATES.HEALTHY)
      expect(rt.state.components.runtime.integrity).toBe("D13-capture-incomplete:version") // honest position, like r93 live
    }
    const ledger = readFileSync(join(home, ".swarm", "tools", "runtime", "guest-image-capture.jsonl"), "utf8")
    expect(ledger).toContain('"type":"guest_image_incomplete"')
    expect(ledger).toContain(GUEST_SHA) // sha256 WAS computable over the real bytes (new local-ref resolution)
    const layout = JSON.parse(readFileSync(limaLayoutPath(), "utf8")) as {
      complete: boolean
      missingFields: string[]
      cacheBasenameHexCandidate: string | null
      computedSha256: string | null
      transcriptionNote: string
    }
    expect(layout.complete).toBe(false)
    expect(layout.missingFields).toEqual(["version"])
    expect(layout.cacheBasenameHexCandidate).toBe(GUEST_SHA) // candidate claim recorded, never promoted
    expect(layout.computedSha256).toBe(GUEST_SHA)
    expect(layout.transcriptionNote).toContain("rows 80/108")
    expect(readCaptures().length).toBe(0) // incomplete != completed: a later run RETRIES the capture
  })

  it("colima's context activation is RESTORED to the user's previous current context (P-5 end-state fallback)", async () => {
    const home = freshHome("cycle2")
    stageColimaFootprint(home)
    const runner = cycleRunner({ markerMoved: true })
    const res = await installWithDeps(
      { lock: LOCK, state: defaultState(LOCK.version), dryRun: false },
      { runner, host: host(), consentGate: granted, consentFirecrawl: false, signatureRun: sigOk },
    )
    expect(res.token).toBe(OUTCOME.OK)
    const restore = runner.calls.filter((c) => c.includes("context use"))
    expect(restore.length).toBe(1) // exactly one restore, to the USER's own previous value...
    expect(restore[0]).toContain("default")
    expect(restore[0]).not.toContain("swarm") // ...never to our profile (nor its colima- alias)
  })

  it("no candidate context after bring-up -> FAILED naming PC-PROF-02 (closure requires EVIDENCE of a name, either candidate)", async () => {
    const home = freshHome("cycle3")
    stageColimaFootprint(home)
    const runner = cycleRunner({ noSwarmContext: true })
    const res = await installWithDeps(
      { lock: LOCK, state: defaultState(LOCK.version), dryRun: false },
      { runner, host: host(), consentGate: granted, consentFirecrawl: false, signatureRun: sigOk },
    )
    expect(res.token).toBe(OUTCOME.FAILED)
    expect(res.message).toContain("PC-PROF-02")
    expect(res.message).toContain("colima-swarm") // the disproven candidate set is named
  })

  it("bottle hash drift vs the reviewed lock -> FAILED (unreviewed binaries never run)", async () => {
    const home = freshHome("cycle4")
    stageColimaFootprint(home)
    const runner = cycleRunner({ bottleDrift: true })
    const res = await installWithDeps(
      { lock: LOCK, state: defaultState(LOCK.version), dryRun: false },
      { runner, host: host(), consentGate: granted, consentFirecrawl: false, signatureRun: sigOk },
    )
    expect(res.token).toBe(OUTCOME.FAILED)
    expect(res.message).toContain("drifted")
  })

  it("D-13 capture with NO evidence at all (no footprint) -> FAILED: total blindness is what verification/10:143 forbids", async () => {
    const home = freshHome("cycle5")
    // NOTE: footprint deliberately NOT staged -> reference AND bytes unlocatable
    const runner = cycleRunner()
    const res = await installWithDeps(
      { lock: LOCK, state: defaultState(LOCK.version), dryRun: false },
      { runner, host: host(), consentGate: granted, consentFirecrawl: false, signatureRun: sigOk },
    )
    expect(res.token).toBe(OUTCOME.FAILED)
    expect(res.message).toContain("NO evidence")
    expect(readCaptures().length).toBe(0)
    expect(existsSync(limaLayoutPath())).toBe(true) // even the blind attempt leaves a durable record of what was checked
  })

  it("health gate failure -> HEALTH_FAILED and state failed, no partial healthy credit", async () => {
    const home = freshHome("cycle6")
    stageColimaFootprint(home)
    const runner = cycleRunner({ healthFails: true })
    const res = await installWithDeps(
      { lock: LOCK, state: defaultState(LOCK.version), dryRun: false },
      { runner, host: host(), consentGate: granted, consentFirecrawl: false, signatureRun: sigOk },
    )
    expect(res.token).toBe(OUTCOME.HEALTH_FAILED)
    const back = readState(LOCK.version)
    if (back.ok) expect(back.state.components.runtime.state).toBe(STATES.FAILED)
  })

  it("remove cycle: foreign-container guard protects unlabelled workloads, then stop+delete only OUR profile", async () => {
    const home = freshHome("cycle7")
    const st = defaultState(LOCK.version)
    st.components.runtime = {
      state: STATES.HEALTHY,
      dockerObjects: [
        { kind: "profile", id: COLIMA_PROFILE, createdBySwarm: true, hasData: true },
        { kind: "context", id: "colima-swarm", createdBySwarm: true, hasData: false },
      ],
      paths: [join(home, ".swarm", "tools", "runtime", "guest-image-capture.jsonl")],
    }
    // foreign container present -> refuse, nothing stopped
    const guard = scriptedRunner([
      { match: "/opt/homebrew/bin/docker --context colima-swarm ps", stdout: "cafebabe\n" },
      { match: "/opt/homebrew/bin/colima stop" },
    ])
    const refused = await removeWithDeps(
      { lock: LOCK, state: st, dryRun: false },
      { runner: guard, consentGate: granted },
    )
    expect(refused.token).toBe(OUTCOME.FAILED)
    expect(refused.message).toContain(LABELS.MANAGED_KEY)
    expect(guard.printed.some((p) => p.includes("colima stop"))).toBe(false)

    // clean -> stop + delete run against the OBSERVED context, label filter present
    const okRunner = scriptedRunner([
      { match: "/opt/homebrew/bin/docker --context colima-swarm ps", stdout: "" },
      { match: "/opt/homebrew/bin/colima stop", stdout: "" },
      { match: "/opt/homebrew/bin/colima delete", stdout: "" },
    ])
    const removed = await removeWithDeps(
      { lock: LOCK, state: st, dryRun: false },
      { runner: okRunner, consentGate: granted },
    )
    expect(removed.token).toBe(OUTCOME.OK)
    expect(okRunner.printed.some((p) => p.includes("colima delete"))).toBe(true)
    expect(okRunner.printed.find((p) => p.includes("ps -a"))).toContain(`${LABELS.MANAGED_KEY}=true`)
    expect(okRunner.printed.find((p) => p.includes("ps -a"))).toContain("colima-swarm")
  })

  it("remove refuses to delete a profile the manifest does not credit us with (P-14)", async () => {
    freshHome("cycle8")
    const runner = scriptedRunner([])
    const res = await removeWithDeps(
      { lock: LOCK, state: defaultState(LOCK.version), dryRun: false },
      { runner, consentGate: granted },
    )
    expect(res.token).toBe(OUTCOME.SKIPPED_WITH_INSTRUCTIONS)
    expect(runner.printed.join("\n")).not.toContain("delete")
  })
})

// ---- (5) pure helpers ------------------------------------------------------------------------

describe("capture + isolation helpers", () => {
  it("parseImageUrls reads the lima yaml images block only", () => {
    const urls = parseImageUrls(
      'images:\n  - location: "https://example.invalid/a.raw.gz"\n    arch: aarch64\nvmType: vz\nnetworks:\n  - location: nope\n',
    )
    expect(urls).toEqual(["https://example.invalid/a.raw.gz"])
  })

  it("version parses from release tag, else from the ubuntu filename token", () => {
    expect(parseVersionFromUrl(GUEST_URL)).toBe("v0.10.4")
    expect(parseVersionFromUrl("https://example.invalid/ubuntu-24.04-minimal-cloudimg-arm64-docker.raw.gz")).toBe(
      "ubuntu-24.04",
    )
    expect(parseVersionFromUrl("https://example.invalid/disk.bin")).toBeNull()
  })

  it("contextCandidates = de-duplicated [register literal, measured convention], derived not hardcoded", () => {
    // PC-PROF-02 was amended r72-fix3 to the measured `colima-swarm`, so today the set is
    // one entry; the test derives from constants.ts bytes (r43 discipline) and stays true
    // whichever way the register moves next.
    const expected = [...new Set([DOCKER_CONTEXT, `colima-${COLIMA_PROFILE}`])]
    expect(contextCandidates()).toEqual(expected)
    expect(contextCandidates()).toContain("colima-swarm") // the measured truth is always a candidate
    expect(contextCandidates().length).toBeGreaterThanOrEqual(1)
  })

  it("observeDockerContext prefers candidates in order, null when none exist", () => {
    const both = scriptedRunner([
      { match: "/opt/homebrew/bin/docker context ls", stdout: "default *\nswarm \ncolima-swarm \n" },
    ])
    expect(observeDockerContext(both, "/opt/homebrew/bin/docker", contextCandidates())).toBe(contextCandidates()[0])
    const onlyFallback = scriptedRunner([
      { match: "/opt/homebrew/bin/docker context ls", stdout: "default *\ncolima-swarm \n" },
    ])
    expect(observeDockerContext(onlyFallback, "/opt/homebrew/bin/docker", ["swarm", "colima-swarm"])).toBe(
      "colima-swarm",
    ) // explicit two-candidate list exercises the fallback slot
    const none = scriptedRunner([{ match: "/opt/homebrew/bin/docker context ls", stdout: "default *\n" }])
    expect(observeDockerContext(none, "/opt/homebrew/bin/docker", contextCandidates())).toBeNull()
  })

  it("currentMarkers reads the star column; buildContextEvidence tolerates EITHER candidate addition only", () => {
    expect(currentMarkers("default *\ncolima-swarm \n")).toEqual(["default"])
    const ev = buildContextEvidence("default *\n", "default *\ncolima-swarm \n")
    expect(ev.unchanged).toBe(true) // marker stable even though a row was ADDED
    expect(ev.swarmContextPresent).toBe(true)
    expect(ev.observedContextName).toBe("colima-swarm") // PC-PROF-02 closure carries WHICH name
    expect(ev.unexpectedAdditions).toEqual([])
    const moved = buildContextEvidence("default *\n", "default \ncolima-swarm *")
    expect(moved.unchanged).toBe(false)
    expect(moved.afterCurrentNames).toEqual(["colima-swarm"])
    const vanished = buildContextEvidence("default *\nother \n", "default *\ncolima-swarm \n")
    expect(vanished.unchanged).toBe(false) // a lost pre-existing row is a violation
    const stranger = buildContextEvidence("default *\n", "default *\ncolima-swarm \nmine \n")
    expect(stranger.unexpectedAdditions).toEqual(["mine"])
  })

  it("H-R93-8 regression: parseProfileJson accepts array, bare object, AND concatenated objects", () => {
    const arr = parseProfileJson('[{"name":"default","status":"Running"},{"name":"swarm","status":"Stopped"}]')
    expect(arr.map((p) => p.name)).toEqual(["default", "swarm"])
    const single = parseProfileJson('{"name":"default","status":"Running"}')
    expect(single.length).toBe(1)
    const concat = parseProfileJson('{"name":"default","status":"Running"}\n{"name":"swarm","status":"Stopped"}') // two objects, one stream
    expect(concat.map((p) => p.name).sort()).toEqual(["default", "swarm"])
    const nestedStrings = parseProfileJson('{"name":"swarm","status":"msg {\\"weird\\"}"}')
    expect(nestedStrings[0]?.name).toBe("swarm") // brace-in-string counting does not split inside strings
  })

  it("resolveLocalCacheRef + basenameHexCandidate model r93's content-addressed layout", () => {
    expect(resolveLocalCacheRef("https://example.invalid/x.raw.gz")).toBeNull() // remote refs never resolve locally
    const home = freshHome("cachehelper")
    const f = join(home, "plainfile")
    writeFileSync(f, "x")
    expect(resolveLocalCacheRef(f)).toBe(f)
    expect(basenameHexCandidate(`${home}/Library/Caches/colima/caches/${"a".repeat(64)}`)).toBe("a".repeat(64))
    expect(basenameHexCandidate(`${home}/Library/Caches/colima/cleases/ubuntu-24.04.raw.gz`)).toBeNull()
  })

  it("qemu scope determination records absent_vz_only against the D-12 declaration", () => {
    const runner = scriptedRunner([
      { match: "/opt/homebrew/bin/brew list --formula --versions qemu", result: { exitCode: 1 } },
    ])
    const obs = observeQemuScope(runner, "/opt/homebrew/bin/brew", "qemu")
    expect(obs.declaredScope).toBe(QEMU_DECLARED_SCOPE)
    expect(obs.observedScope).toBe("absent_vz_only")
  })

  it("H-R93-7 regression: spawnRunner maps a missing binary to exitCode 127, never throws", () => {
    const runner = spawnRunner(2000)
    const res = runner.run(["/nonexistent-swarm-r86-binary", "--version"])
    expect(res.ok).toBe(false)
    expect(res.exitCode).toBe(127)
  })

  it("argv builders keep the structural pins: profile name, observed-context parameter, label filter, measured colima 0.10.3 spellings", () => {
    expect(colimaStartArgv("/opt/homebrew/bin/colima", 8, 10, false)).toEqual([
      "/opt/homebrew/bin/colima",
      "start",
      "--profile",
      "swarm",
      "--cpus",
      "8",
      "--memory",
      "10",
      "--disk",
      "60",
      "--vm-type",
      "vz",
      "--activate=false",
    ])
    expect(dockerInfoArgv("/opt/homebrew/bin/docker", "colima-swarm").slice(0, 3)).toEqual([
      "/opt/homebrew/bin/docker",
      "--context",
      "colima-swarm",
    ])
    expect(foreignContainersArgv("/opt/homebrew/bin/docker", "swarm").join(" ")).toContain(
      "label!=io.gsp.swarm.managed=true",
    )
    expect(dockerContextLsArgv("/opt/homebrew/bin/docker").join(" ")).toContain("{{.Name}} {{.Current}}")
  })
})

// Row 272 (F-264b-1): the runtime step's spawn door (`spawnRunner`) runs colima AND docker — `docker info`,
// the foreign-container `ps`, `docker context ls` and the state-writing `docker context use` — so it must not
// inherit the daemon-selection names. Measured on this host (row 272 §1): with an inherited hostile
// DOCKER_CONFIG the health check addressed the hostile config's socket, and DOCKER_CONTEXT re-marks the
// "current" column the isolation evidence and the restore target read.
//
// WHY A CHILD BUN: Bun's spawn without `env` passes the process's ORIGINAL environ, not later writes to
// `process.env` (measured, row 272 §1 M1 — the row 268 VOID lesson). Setting canaries in-process would leave
// the door's children canary-free on HEAD bytes too, i.e. a vacuous green. So the canaries are put into the
// OS environment of a child bun that hosts the runner, and that child proves it holds them (`self`) and that
// a control spawn of its own DOES pass them on (`control`) before the door's children are judged.
// E21: the stub only prints; HOME is a fresh sandbox; nothing here can write under the real home.
describe("r272 runtime door strips daemon-selection env (F-264b-1)", () => {
  it("r272: every spawnRunner child loses DOCKER_HOST/DOCKER_CONTEXT/DOCKER_CONFIG, keeps HOME and PATH", () => {
    const box = mkdtempSync(join(tmpdir(), "swarm-r272-runtime-"))
    try {
      const home = join(box, "home")
      mkdirSync(home)
      const stub = join(box, "envdump")
      writeFileSync(
        stub,
        [
          "#!/bin/sh",
          ...[...DOCKER_ENV_DENY, "HOME"].map((n) => `echo "${n}=\${${n}-<unset>}"`),
          'echo "PATH_SET=${PATH:+yes}"',
          "",
        ].join("\n"),
      )
      chmodSync(stub, 0o755)
      const driver = join(box, "driver.ts")
      writeFileSync(
        driver,
        `import { spawnRunner, colimaStartArgv, dockerInfoArgv, dockerContextUseArgv } from ${JSON.stringify(join(import.meta.dir, "../src/steps/runtime/commands.ts"))}
const stub = process.env.R272_STUB as string
const parse = (s: string) => Object.fromEntries(s.trim().split("\\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]))
const r = spawnRunner(20000)
// production argv shapes with the stub standing in for the binary (argv[0]): the door does not branch on argv
const docker = r.run([stub, ...dockerInfoArgv("/x/docker", "colima-swarm").slice(1)])
const use = r.run([stub, ...dockerContextUseArgv("/x/docker", "default").slice(1)])
const colima = r.run([stub, ...colimaStartArgv("/x/colima", 2, 2, false).slice(1)])
const control = Bun.spawnSync([stub], { stdout: "pipe" })
console.log(JSON.stringify({
  self: { DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT, DOCKER_CONFIG: process.env.DOCKER_CONFIG },
  control: parse(new TextDecoder().decode(control.stdout)),
  children: [docker, use, colima].map((c) => ({ ok: c.ok, ...parse(c.stdout) })),
  executed: r.executedCount,
}))
`,
      )
      const canary = {
        DOCKER_HOST: "tcp://r272-canary-host.invalid:2375",
        DOCKER_CONTEXT: "r272-canary-context",
        DOCKER_CONFIG: join(box, "r272-canary-config"),
      }
      // node:child_process, not Bun.spawnSync: injection_harness.test.ts spies Bun.spawn/spawnSync at module load and
      // its disarmed pass-through drops the options object (env included); under any `-t` filter its afterAll
      // never runs, so the spy outlives the file (row 272 §5). This parent spawn must not depend on that.
      const out = nodeSpawnSync(process.execPath, ["run", driver], {
        cwd: box,
        encoding: "utf8",
        env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", no_proxy: "*", R272_STUB: stub, ...canary },
      })
      const stderr = out.stderr
      expect({ exit: out.status, stderr }).toEqual({ exit: 0, stderr: "" })
      const got = JSON.parse(out.stdout.trim()) as {
        self: Record<string, string>
        control: Record<string, string>
        children: Record<string, string | boolean>[]
        executed: number
      }
      // anti-vacuity: the host process holds the canaries, and a plain spawn from it passes them on
      expect(got.self).toEqual(canary)
      for (const n of DOCKER_ENV_DENY) expect(got.control[n]).toBe(canary[n])
      // the door: three children (docker-, context-use- and colima-shaped), all stripped, HOME/PATH intact
      expect(got.executed).toBe(3)
      expect(got.children.length).toBe(3)
      for (const child of got.children) {
        expect(child.ok).toBe(true)
        for (const n of DOCKER_ENV_DENY) expect({ [n]: child[n] }).toEqual({ [n]: "<unset>" })
        expect(child.HOME).toBe(home)
        expect(child.PATH_SET).toBe("yes")
      }
    } finally {
      rmSync(box, { recursive: true, force: true })
    }
  })

  it("r272: the runtime door consumes the setup-side deny-list rather than a copy of its own", () => {
    expect([...DOCKER_ENV_DENY]).toEqual(["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"])
    const src = readFileSync(join(import.meta.dir, "../src/steps/runtime/commands.ts"), "utf8")
    expect({ importsDockerSpawnEnv: /import \{[^}]*\bdockerSpawnEnv\b[^}]*\} from "\.\.\/\.\.\/dockerRunner\.real\.ts"/.test(src) }).toEqual({ importsDockerSpawnEnv: true })
    expect({ ownDenyLiterals: src.match(/["']DOCKER_(HOST|CONTEXT|CONFIG)["']/g) ?? [] }).toEqual({ ownDenyLiterals: [] })
  })
})
