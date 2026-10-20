// Row-88 unit tests for the private-Graft step (src/steps/graft/). NO network anywhere: the
// download path is exercised through the row-84 fetchImpl seam delivering a staged FAKE tarball,
// and the npm install / health / telemetry spawns are driven by TEST SEAMS that materialize a
// realistic installed-package tree and RECORD the exact absolute paths handed to them (that record
// IS part of the resolver-path + renamed-twin proofs). The REAL private-npm invocation happens
// exactly once, in the opt-in proof (graft.proofs.sh P5).
//
// A fake PRIVATE Node is staged per test (a plain-text bin/node + a valid .swarm-node.json + an
// npm-cli.js beside it) so the step's DEFAULT nodeBin() resolution — including its digest check —
// is genuinely exercised, not stubbed away. HOME points at a throwaway dir (paths.ts honors $HOME),
// so every write lands in the sandbox and the real user home is untouched. No port literal appears
// anywhere (PORT RULE: graft serves nothing). The shipped lock is staged into src/ for the source-run
// posture exactly as rows 82/83/84/87 do, then removed.
//
// Run TARGETED (row 102 owns the full suite on this host):
//   bash packages/setup/test/graft.proofs.sh
// or: cd packages/setup && bun test test/graft.test.ts

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import {
  chmodSync,
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
// Per-run isolation of the source-posture lock (replaces the shared src/tools.lock.json staging).
import { isolateSourceLock } from "./lockPosture.ts"
import step, {
  graftLaunch,
  graftChildEnv,
  graftVersionFromLock,
  graftToolRoot,
  graftNpmCacheDir,
  graftCliPath,
  npmCliFromNode,
  readInstallRecord,
  type GraftStepOptions,
} from "../src/steps/graft/index.ts"
import { nodeBin } from "../src/steps/node/index.ts"
import { defaultState, readState, writeState, type StateFile } from "../src/state.ts"
import { loadLock, type LockFile } from "../src/lockfile.ts"
import { computeFileDigest, parseExpectedDigest } from "../src/verify.ts"
import { OUTCOME } from "../src/outcomes.ts"
import type { FetchResult } from "../src/fetch.ts"

// ---- source-run lock posture: private program dir per run (see test/lockPosture.ts) ----
let releaseLockPosture: (() => void) | undefined
let SHIPPED: LockFile

beforeAll(() => {
  releaseLockPosture = isolateSourceLock()
  const loaded = loadLock()
  if (!loaded.ok) throw new Error(`loadLock failed in test setup: ${loaded.error}`)
  SHIPPED = loaded.lock
})
afterAll(() => {
  releaseLockPosture?.()
})

const NODE_VER = "vTest-fake" // synthetic private-node pin the graft step resolves
const GRAFT_VER = "0.18.0" // matches the reviewed pin so the shipped-lock check is meaningful
const GRAFT_INTEGRITY =
  "sha512-sNshNND1Q/qSXiuSh9nW8NniWyaD+m55oJZ6oCGJsLzxot52WSJrdThsQ3NZVTNT+lqivlYkkqN8b/nf22S/Xw=="
const GRAFT_SHA512_HEX = parseExpectedDigest(GRAFT_INTEGRITY)?.hex ?? ""
const TARBALL_NAME = "graft-0.18.0.tgz"
const ENGINES_FLOOR = ">=20" // what the fake installed package.json declares (mirrors the real 0.18.0)

const GRAFT_ROOT = (home: string) => join(home, ".swarm", "tools", "graft")
const VERSION_DIR = (home: string) => join(GRAFT_ROOT(home), GRAFT_VER)
const CLI_PATH = (home: string) => graftCliPath(VERSION_DIR(home))
const PKG_DIR = (dir: string) => join(dir, "node_modules", "@nanonets", "graft")

function freshHome(label: string): string {
  const home = mkdtempSync(join(tmpdir(), `swarm-r88-${label}-`))
  process.env.HOME = home
  return home
}

/** Recursive relative-path listing (empty array if the dir does not exist). */
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

/** Pre-stage the verified tarball where row 82 WOULD promote it (the fetch is seamed in units), so
 *  the post-install path listing sees a realistic layout. Ensures the tool root exists first. */
function stageTarball(home: string): string {
  mkdirSync(GRAFT_ROOT(home), { recursive: true })
  const p = join(GRAFT_ROOT(home), TARBALL_NAME)
  writeFileSync(p, "fake graft tarball bytes", { mode: 0o600 })
  return p
}

/** Stage a fake PRIVATE Node at `nodeRoot` (default: inside the throwaway HOME's tool dir) so the
 *  step's real nodeBin() resolution — presence + exec bit + recorded-digest match — is exercised.
 *  Returns the resolved binary path plus a resolveNode seam pinned to this nodeRoot. */
function stageFakeNode(
  home: string,
  nodeRoot?: string,
): { nodeRoot: string; nodePath: string; resolveNode: NonNullable<GraftStepOptions["resolveNode"]> } {
  const root = nodeRoot ?? join(home, ".swarm", "tools", "node")
  const versionDir = join(root, NODE_VER)
  const binPath = join(versionDir, "bin", "node")
  mkdirSync(join(versionDir, "bin"), { recursive: true })
  writeFileSync(binPath, "#!/bin/sh\necho fake-node\n", { mode: 0o755 })
  chmodSync(binPath, 0o755)
  const npmCli = join(versionDir, "lib", "node_modules", "npm", "bin", "npm-cli.js")
  mkdirSync(join(npmCli, ".."), { recursive: true })
  writeFileSync(npmCli, "// fake npm cli\n")
  const binarySha = computeFileDigest(binPath, "sha256").hex
  writeFileSync(
    join(versionDir, ".swarm-node.json"),
    JSON.stringify({
      component: "node",
      version: NODE_VER,
      url: "https://nodejs.org/x",
      tarballSha256: "ab".repeat(32),
      observedTarballSha256: "ab".repeat(32),
      nodeBinarySha256: binarySha,
      installedAt: new Date().toISOString(),
      lockVersion: "test-lock-r88",
      paths: [versionDir],
    }),
    { mode: 0o600 },
  )
  return { nodeRoot: root, nodePath: binPath, resolveNode: (lock: LockFile) => nodeBin({ lock, installRoot: root }) }
}

/** A lock shaped like the shipped graft pin but pointing at the synthetic node version. */
function fakeLock(graftPkg = "@nanonets/graft"): LockFile {
  return {
    schemaVersion: 1,
    version: "test-lock-r88",
    hosts: ["registry.npmjs.org", "nodejs.org"],
    components: {
      node: {
        install_dir: "~/.swarm/tools/node",
        url: `https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-darwin-arm64.tar.gz`,
        version: NODE_VER,
        size: 1,
        tarball_sha256: "ab".repeat(32),
      },
      graft: {
        _pc_cmp: "PC-CMP-03",
        package: graftPkg,
        install_dir: "~/.swarm/tools/graft",
        url: `https://registry.npmjs.org/@nanonets/graft/-/graft-${GRAFT_VER}.tgz`,
        version: GRAFT_VER,
        integrity: GRAFT_INTEGRITY,
        size: 728291,
        prerequisite: ["node"],
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

function fetchSpy(destPath: string, status: "fetched" | "resumed" | "dry_run" = "fetched"): Spy {
  const spy: Spy = {
    calls: 0,
    sawDryRun: false,
    impl: (async (_l: LockFile, _id: string, opts?: { dryRun?: boolean }) => {
      spy.calls += 1
      spy.sawDryRun = opts?.dryRun === true
      const artifact = {
        component: "graft",
        artifact: "graft",
        url: `https://registry.npmjs.org/@nanonets/graft/-/graft-${GRAFT_VER}.tgz`,
        host: "registry.npmjs.org",
        version: GRAFT_VER,
        expected: { algorithm: "sha512" as const, hex: GRAFT_SHA512_HEX, pin: GRAFT_INTEGRITY },
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

interface NpmSim {
  seenArgv: readonly string[][]
  seenEnv: Record<string, string>[]
  seenCwd: string[]
  runner: NonNullable<GraftStepOptions["npmRunner"]>
}

/** npm-runner seam: records argv/env/cwd, then MATERIALIZES an installed-package tree in cwd so
 *  the post-install verification + atomic commit see a realistic layout. `mode` drives failure cases. */
function npmSim(mode: "good" | "fail" | "twin-name" | "twin-present" | "no-cli" = "good"): NpmSim {
  const sim: NpmSim = {
    seenArgv: [],
    seenEnv: [],
    seenCwd: [],
    runner: (argv, env, cwd) => {
      sim.seenArgv.push([...argv])
      sim.seenEnv.push({ ...env })
      sim.seenCwd.push(cwd)
      if (mode === "fail") return { ok: false, detail: "injected npm failure (unit)" }
      const pkgName = mode === "twin-name" ? "@trailhq/trail-code" : "@nanonets/graft"
      const pkgDir = PKG_DIR(cwd)
      mkdirSync(join(pkgDir, "dist"), { recursive: true })
      writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({
          name: pkgName,
          version: GRAFT_VER,
          engines: { node: ENGINES_FLOOR },
          bin: { graft: "dist/cli.js" },
        }),
      )
      if (mode !== "no-cli")
        writeFileSync(join(pkgDir, "dist", "cli.js"), "// graft cli stub\nconsole.log('" + GRAFT_VER + "')\n")
      if (mode === "twin-present") {
        const twin = join(cwd, "node_modules", "@trailhq", "trail-code")
        mkdirSync(twin, { recursive: true })
        writeFileSync(join(twin, "package.json"), JSON.stringify({ name: "@trailhq/trail-code", version: "0.23.0" }))
      }
      return { ok: true, detail: "added 1 package (simulated)" }
    },
  }
  return sim
}

function healthSim(versionOutput: string = GRAFT_VER): {
  seen: [string, string][]
  runner: NonNullable<GraftStepOptions["healthRunner"]>
} {
  const seen: [string, string][] = []
  return {
    seen,
    runner: (cliPath, nodePath) => (
      seen.push([cliPath, nodePath]),
      { ok: true, versionOutput, detail: "recorded (fake CLI never executed)" }
    ),
  }
}

function telemetrySim(off: boolean): {
  seen: { env: Record<string, string>; cli: string }[]
  runner: NonNullable<GraftStepOptions["telemetryRunner"]>
} {
  const seen: { env: Record<string, string>; cli: string }[] = []
  return {
    seen,
    runner: (cliPath, _n, env) => (
      seen.push({ env: { ...env }, cli: cliPath }),
      { ok: true, off, observed: off ? "telemetry: off (DO_NOT_TRACK honoured)" : "telemetry: on", detail: "recorded" }
    ),
  }
}

/** Health seam returning a SCRIPTED SEQUENCE of outcomes (one per call), so the missing-build ->
 *  rebuild -> re-probe flow is driven deterministically. Falls back to the last entry if called more. */
function healthSeq(outputs: import("../src/steps/graft/index.ts").HealthOutcome[]): {
  calls: number
  seen: [string, string][]
  runner: NonNullable<GraftStepOptions["healthRunner"]>
} {
  const seen: [string, string][] = []
  let i = 0
  return {
    get calls() {
      return i
    },
    seen,
    runner: (cliPath, nodePath) => {
      const out = outputs[Math.min(i, outputs.length - 1)]!
      i += 1
      seen.push([cliPath, nodePath])
      return out
    },
  }
}

const MISSING_BUILD_DETAIL =
  "--version exit 1: Error: No native build was found for platform=darwin arch=arm64 runtime=node loaded from: .../tree-sitter-kotlin"

function rebuildSim(mode: "good" | "fail" = "good"): {
  seenArgv: readonly string[][]
  seenEnv: Record<string, string>[]
  seenCwd: string[]
  runner: NonNullable<GraftStepOptions["rebuildRunner"]>
} {
  const s = {
    seenArgv: [] as readonly string[][],
    seenEnv: [] as Record<string, string>[],
    seenCwd: [] as string[],
    runner: ((argv, env, cwd) => {
      s.seenArgv.push([...argv])
      s.seenEnv.push({ ...env })
      s.seenCwd.push(cwd)
      if (mode === "fail") return { ok: false, detail: "injected rebuild failure (unit)" }
      // Materialize a compiled binding inside the committed version dir (under the listed root).
      const rel = join("node_modules", "@nanonets", "graft", "node_modules", "tree-sitter-kotlin", "build", "Release")
      mkdirSync(join(cwd, rel), { recursive: true })
      writeFileSync(join(cwd, rel, "tree_sitter_kotlin_binding.node"), "compiled-binding-stub")
      return { ok: true, detail: "rebuilt dependencies successfully" }
    }) as NonNullable<GraftStepOptions["rebuildRunner"]>,
  }
  return s
}

function ctxOf(lock: LockFile, state?: StateFile, dryRun = false) {
  return { lock, state: state ?? defaultState(lock.version), dryRun }
}

interface Granted {
  res: Awaited<ReturnType<typeof step.install>>
  spy: Spy
  npm: NpmSim
  health: ReturnType<typeof healthSim>
  telemetry: ReturnType<typeof telemetrySim>
}

async function grantedInstall(
  home: string,
  lock: LockFile,
  node: { resolveNode: NonNullable<GraftStepOptions["resolveNode"]> },
  destPath: string,
  extra: Partial<GraftStepOptions> = {},
  dryRun = false,
  status: "fetched" | "resumed" | "dry_run" = "fetched",
): Promise<Granted> {
  const spy = fetchSpy(destPath, status)
  const npm = npmSim(((extra as { npmMode?: string }).npmMode as "good" | undefined) ?? "good")
  const health = healthSim()
  const telemetry = telemetrySim(true)
  const res = await step.install(ctxOf(lock, undefined, dryRun), {
    provenancePath: join(home, "prov.jsonl"),
    logPath: join(home, "setup.log"),
    consentGate: () => true,
    fetchImpl: spy.impl,
    resolveNode: node.resolveNode,
    npmRunner: npm.runner,
    healthRunner: health.runner,
    telemetryRunner: telemetry.runner,
    ...extra,
  })
  return { res, spy, npm, health, telemetry }
}

describe("(a) consent gate refuses before fetch AND before any filesystem touch", () => {
  it("REFUSED_NO_CONSENT with zero fetch calls and no graft tool dir", async () => {
    const home = freshHome("a1")
    const node = stageFakeNode(home)
    const spy = fetchSpy(join(GRAFT_ROOT(home), TARBALL_NAME))
    const res = await step.install(ctxOf(fakeLock()), {
      provenancePath: join(home, "prov.jsonl"),
      resolveNode: node.resolveNode,
      fetchImpl: spy.impl, // refusal must precede the downloader
    })
    expect(res.token).toBe(OUTCOME.REFUSED_NO_CONSENT)
    expect(spy.calls).toBe(0)
    expect(existsSync(join(home, ".swarm", "setup"))).toBe(false)
    expect(existsSync(GRAFT_ROOT(home))).toBe(false)
  })
})

describe("(b) fresh install: private npm placement, record, pointer, lifecycle, engines recorded", () => {
  it("lands <root>/<version>/node_modules/@nanonets/graft/dist/cli.js + record + pointer + cache + healthy", async () => {
    const home = freshHome("b1")
    const envBefore = envSnapshot()
    const node = stageFakeNode(home)
    const lock = fakeLock()
    const destPath = stageTarball(home)
    const { res, spy, npm, health, telemetry } = await grantedInstall(home, lock, node, destPath)

    expect(res.token).toBe(OUTCOME.OK)
    expect(spy.calls).toBe(1) // exactly one network-proxy call for a cold install

    // npm was invoked by ABSOLUTE path with the mandated flags, in a scoped cwd, with the off env.
    expect(npm.seenArgv.length).toBe(1)
    const argv = npm.seenArgv[0]!
    expect(argv[0]).toBe(node.nodePath) // private node runs npm
    expect(argv[1]).toBe(
      npmCliFromNode(node.nodePath).ok
        ? join(node.nodePath, "..", "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")
        : "",
    )
    expect(argv).toContain("--ignore-scripts")
    expect(argv).toContain("--no-audit")
    expect(argv).toContain("--no-fund")
    expect(argv).toContain(destPath) // installs the VERIFIED local tarball, not a registry re-pull of graft
    expect(npm.seenCwd[0]!.startsWith(GRAFT_ROOT(home))).toBe(true)
    expect(npm.seenCwd[0]!).toContain(".install-") // built into a same-dir temp, committed by rename
    expect(npm.seenEnv[0]!.DO_NOT_TRACK).toBe("1") // telemetry off during install
    expect(npm.seenEnv[0]!.npm_config_cache).toBe(graftNpmCacheDir()) // cache redirected under ~/.swarm

    // The CLI probe ran against EXACTLY the committed absolute CLI path + private node path.
    expect(health.seen).toEqual([[CLI_PATH(home), node.nodePath]])
    expect(telemetry.seen.length).toBe(1)
    expect(telemetry.seen[0]!.env.DO_NOT_TRACK).toBe("1")

    expect(existsSync(CLI_PATH(home))).toBe(true)
    const record = readInstallRecord(VERSION_DIR(home))
    expect(record).not.toBeNull()
    if (record) {
      expect(record.version).toBe(GRAFT_VER)
      expect(record.pkg).toBe("@nanonets/graft")
      expect(record.tarballSha512).toBe(GRAFT_SHA512_HEX)
      expect(record.observedTarballSha512).toBe(GRAFT_SHA512_HEX)
      expect(record.cliSha256).toBe(computeFileDigest(CLI_PATH(home), "sha256").hex)
      expect(record.enginesNode).toBe(ENGINES_FLOOR) // OBSERVED floor recorded (closes r80 finding 4)
      expect(record.telemetryKnob).toBe("DO_NOT_TRACK=1")
      expect(record.telemetryObserved).toContain("off")
      expect(record.paths).toContain(VERSION_DIR(home))
      expect(record.paths).toContain(destPath)
      expect(record.paths).toContain(graftNpmCacheDir())
    }

    expect(existsSync(join(GRAFT_ROOT(home), "current.json"))).toBe(true)
    expect(existsSync(graftNpmCacheDir())).toBe(true)

    const onDisk = readState(lock.version)
    expect(onDisk.ok).toBe(true)
    if (onDisk.ok) {
      const g = onDisk.state.components.graft
      expect(g.state).toBe("healthy")
      expect(g.installedBySwarm).toBe(true)
      expect(g.version).toBe(GRAFT_VER)
      expect(g.integrity).toBe(`sha512:${GRAFT_SHA512_HEX}`)
      expect(g.paths?.length).toBe(5)
    }

    const lines = readFileSync(join(home, "prov.jsonl"), "utf8").trim().split("\n")
    const last = JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>
    expect(last.component).toBe("graft")
    expect(last.destPath).toBe(CLI_PATH(home))

    expect(envSnapshot()).toBe(envBefore) // PATH-cleanliness layer 1
  })
})

describe("(c) idempotence: resume-on-valid performs ZERO network and re-probes nothing", () => {
  it("second install over a valid tree never reaches the downloader nor the health/telemetry probes", async () => {
    const home = freshHome("c1")
    const node = stageFakeNode(home)
    const lock = fakeLock()
    const destPath = stageTarball(home)
    await grantedInstall(home, lock, node, destPath)

    const spy = fetchSpy(destPath)
    const npm = npmSim()
    const health = healthSim()
    const telemetry = telemetrySim(true)
    const stateOnDisk = readState(lock.version)
    expect(stateOnDisk.ok).toBe(true)
    const res = await step.install(ctxOf(lock, stateOnDisk.ok ? stateOnDisk.state : undefined), {
      provenancePath: join(home, "prov.jsonl"),
      consentGate: () => true,
      fetchImpl: spy.impl,
      resolveNode: node.resolveNode,
      npmRunner: npm.runner,
      healthRunner: health.runner,
      telemetryRunner: telemetry.runner,
    })
    expect(res.token).toBe(OUTCOME.OK)
    expect(res.message ?? "").toContain("resumed")
    expect(spy.calls).toBe(0) // §6.3: valid existing install -> zero network attempts
    expect(npm.seenArgv.length).toBe(0) // no npm either
    expect(health.seen).toEqual([]) // adoption does not re-probe
    expect(computeFileDigest(CLI_PATH(home), "sha256").hex).toBe(readInstallRecord(VERSION_DIR(home))?.cliSha256) // untouched
  })
})

describe("(d) tamper-replace: CLI digest-vs-record mismatch forces replacement from the verified tarball", () => {
  it("tampered CLI is detected by sha, refused by the resolver, and replaced on re-install", async () => {
    const home = freshHome("d1")
    const node = stageFakeNode(home)
    const lock = fakeLock()
    const destPath = stageTarball(home)
    await grantedInstall(home, lock, node, destPath)
    const originalCliSha = readInstallRecord(VERSION_DIR(home))!.cliSha256

    writeFileSync(CLI_PATH(home), "// TAMPERED BY TEST\nconsole.log('evil')\n") // simulate post-install corruption

    const refused = graftLaunch({ lock, installRoot: GRAFT_ROOT(home), nodeInstallRoot: node.nodeRoot })
    expect(refused.ok).toBe(false)
    expect(refused.reason ?? "").toContain("install record")

    const { res, spy } = await grantedInstall(home, lock, node, destPath) // re-install replaces it
    expect(res.token).toBe(OUTCOME.OK)
    expect(spy.calls).toBe(1) // fetch reached again (real lib would resume from the intact tarball)
    expect(computeFileDigest(CLI_PATH(home), "sha256").hex).toBe(originalCliSha) // restored
    expect(graftLaunch({ lock, installRoot: GRAFT_ROOT(home), nodeInstallRoot: node.nodeRoot }).ok).toBe(true) // usable again

    const names = readdirSync(GRAFT_ROOT(home))
      .filter((n) => !n.startsWith("."))
      .sort()
    expect(names).toEqual([TARBALL_NAME, GRAFT_VER, "current.json", "npm-cache"].sort())
    expect(
      readdirSync(GRAFT_ROOT(home)).filter((n) => n.startsWith(".quarantine-") || n.startsWith(".install-")),
    ).toEqual([])
  })
})

describe("(e) resolver path proof for row 97 (config writer)", () => {
  it("graftLaunch returns the exact absolute CLI + node paths and works with an EMPTY PATH", async () => {
    const home = freshHome("e1")
    const node = stageFakeNode(home)
    const lock = fakeLock()
    const destPath = stageTarball(home)
    await grantedInstall(home, lock, node, destPath)

    const expectedCli = join(
      home,
      ".swarm",
      "tools",
      "graft",
      GRAFT_VER,
      "node_modules",
      "@nanonets",
      "graft",
      "dist",
      "cli.js",
    )
    const first = graftLaunch({ lock, installRoot: GRAFT_ROOT(home), nodeInstallRoot: node.nodeRoot })
    expect(first.ok).toBe(true)
    expect(first.cliPath).toBe(expectedCli)
    expect(first.nodePath).toBe(node.nodePath)
    expect((first.cliPath ?? "").startsWith("/")).toBe(true)

    const savedPath = process.env.PATH
    process.env.PATH = ""
    const noPath = graftLaunch({ lock, installRoot: GRAFT_ROOT(home), nodeInstallRoot: node.nodeRoot })
    process.env.PATH = "/nonexistent-dir-for-proof"
    const bogusPath = graftLaunch({ lock, installRoot: GRAFT_ROOT(home), nodeInstallRoot: node.nodeRoot })
    if (savedPath === undefined) delete process.env.PATH
    else process.env.PATH = savedPath
    expect(noPath.cliPath).toBe(expectedCli)
    expect(bogusPath.cliPath).toBe(expectedCli)

    const missing = graftLaunch({ lock, installRoot: join(home, "nowhere"), nodeInstallRoot: node.nodeRoot })
    expect(missing.ok).toBe(false)
    expect(missing.reason ?? "").toContain("not installed")
  })

  it("the shipped lock pins @nanonets/graft 0.18.0 — the version row 97 will resolve", () => {
    const v = graftVersionFromLock(SHIPPED)
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.version).toBe("0.18.0")
    expect(SHIPPED.components.graft?.package).toBe("@nanonets/graft")
  })
})

describe("(f) zero PATH mutation: neither the install nor graftChildEnv touches any PATH value", () => {
  it("process.env is byte-identical across a full install; child env copies PATH verbatim + DO_NOT_TRACK", async () => {
    const home = freshHome("f1")
    const envBefore = envSnapshot()
    const node = stageFakeNode(home)
    const lock = fakeLock()
    const destPath = stageTarball(home)
    await grantedInstall(home, lock, node, destPath)
    expect(envSnapshot()).toBe(envBefore) // no PATH prepend/append/export anywhere

    const base = { PATH: "/usr/bin:/bin", HOME: "/tmp/r88-base", ZDOTDIR: "/tmp/keep" }
    const env = graftChildEnv(base, GRAFT_ROOT(home))
    expect(env.PATH).toBe("/usr/bin:/bin") // copied VERBATIM — the private CLI needs no PATH entry
    expect(env.DO_NOT_TRACK).toBe("1") // telemetry-off posture carried to the runtime (row 97)
    expect(base.PATH).toBe("/usr/bin:/bin") // input object not mutated
    expect((base as Record<string, string>).DO_NOT_TRACK).toBeUndefined() // nor extended
  })
})

describe("(g) dry-run: zero filesystem writes on both the absent and the valid posture", () => {
  it("absent install under --dry-run leaves the ENTIRE ~/.swarm tree empty", async () => {
    const home = freshHome("g1")
    const node = stageFakeNode(home, join(home, "_extnode")) // node staged OUTSIDE .swarm so the dry-run proves .swarm untouched
    const lock = fakeLock()
    const wouldBe = join(GRAFT_ROOT(home), TARBALL_NAME)
    const { res, spy } = await grantedInstall(home, lock, node, wouldBe, {}, true, "dry_run")
    expect(res.token).toBe(OUTCOME.OK)
    expect(spy.sawDryRun).toBe(true) // propagated into row 82's own zero-write posture
    expect(existsSync(join(home, ".swarm"))).toBe(false) // no state.json, no setup.log, no prov ledger, no tool dir
  })

  it("valid install under --dry-run reports resume and changes nothing on disk", async () => {
    const home = freshHome("g2")
    const node = stageFakeNode(home)
    const lock = fakeLock()
    const destPath = stageTarball(home)
    await grantedInstall(home, lock, node, destPath)
    const before = tree(GRAFT_ROOT(home))
    const { res } = await grantedInstall(home, lock, node, destPath, {}, true)
    expect(res.token).toBe(OUTCOME.OK)
    expect(res.message ?? "").toContain("already installed")
    expect(tree(GRAFT_ROOT(home))).toEqual(before) // byte-for-byte identical listing incl. sizes
  })
})

describe("(h) remove: deletes ONLY state-listed paths inside the tool root", () => {
  it("deletes version dir, pointer, tarball and cache; an unlisted sibling survives; second remove skips", async () => {
    const home = freshHome("h1")
    const node = stageFakeNode(home)
    const lock = fakeLock()
    const destPath = stageTarball(home)
    await grantedInstall(home, lock, node, destPath)
    const keepMe = join(GRAFT_ROOT(home), "user-left-behind.txt")
    writeFileSync(keepMe, "not in any state manifest\n")

    const stateOnDisk = readState(lock.version)
    expect(stateOnDisk.ok).toBe(true)
    const res = step.remove(ctxOf(lock, stateOnDisk.ok ? stateOnDisk.state : undefined), {
      provenancePath: join(home, "prov.jsonl"),
    })
    expect(res.token).toBe(OUTCOME.OK)

    expect(existsSync(VERSION_DIR(home))).toBe(false)
    expect(existsSync(join(GRAFT_ROOT(home), "current.json"))).toBe(false)
    expect(existsSync(destPath)).toBe(false) // the tarball was state-listed too
    expect(existsSync(graftNpmCacheDir())).toBe(false)
    expect(existsSync(keepMe)).toBe(true) // NEVER delete what the state file does not list

    const after = readState(lock.version)
    if (after.ok) {
      expect(after.state.components.graft.state).toBe("absent")
      expect(after.state.components.graft.installedBySwarm).toBe(false)
      expect(after.state.components.graft.paths).toBeUndefined()
    }
    const again = step.remove(ctxOf(lock, after.ok ? after.state : undefined))
    expect(again.token).toBe(OUTCOME.SKIPPED)
    expect(existsSync(keepMe)).toBe(true)
  })

  it("a pre-existing install the setup did not create is SKIPPED, never deleted", async () => {
    const home = freshHome("h2")
    const lock = fakeLock()
    const state = defaultState(lock.version)
    state.components.graft = { state: "healthy", version: GRAFT_VER } // installedBySwarm ABSENT
    writeState(state)
    mkdirSync(CLI_PATH(home), { recursive: true }) // someone else's graft lives here
    const res = step.remove(ctxOf(lock, state))
    expect(res.token).toBe(OUTCOME.SKIPPED)
    expect(existsSync(PKG_DIR(VERSION_DIR(home)))).toBe(true) // byte-untouched
  })

  it("a state-listed path OUTSIDE the tool root is refused and survives (P-14/P-16 boundary)", async () => {
    const home = freshHome("h3")
    const node = stageFakeNode(home)
    const lock = fakeLock()
    const destPath = stageTarball(home)
    await grantedInstall(home, lock, node, destPath)
    const outside = join(home, "precious.txt")
    writeFileSync(outside, "listed maliciously in a doctored state\n")

    const state = readState(lock.version)
    expect(state.ok).toBe(true)
    if (state.ok) {
      state.state.components.graft = {
        ...state.state.components.graft,
        paths: [...(state.state.components.graft.paths ?? []), outside],
      }
      writeState(state.state) // doctored through the engine's own commit point
    }
    const res = step.remove(ctxOf(lock, state.ok ? state.state : undefined), { logPath: join(home, "setup.log") })
    expect(res.token).toBe(OUTCOME.OK)
    expect(existsSync(outside)).toBe(true) // outside-root entries are refused, not deleted
    expect(existsSync(VERSION_DIR(home))).toBe(false) // listed inside-root paths still go
  })
})

describe("(i) renamed-twin exclusion (D-10): the twin is never resolved, installed, or promoted", () => {
  it("a lock naming the twin as the package is REFUSED before any fetch", async () => {
    const home = freshHome("i1")
    const node = stageFakeNode(home)
    const spy = fetchSpy(join(GRAFT_ROOT(home), TARBALL_NAME))
    const res = await step.install(ctxOf(fakeLock("@trailhq/trail-code")), {
      provenancePath: join(home, "prov.jsonl"),
      consentGate: () => true,
      fetchImpl: spy.impl,
      resolveNode: node.resolveNode,
    })
    expect(res.token).toBe(OUTCOME.FAILED)
    expect(res.message ?? "").toContain("D-10")
    expect(spy.calls).toBe(0) // refused before the downloader
    expect(existsSync(GRAFT_ROOT(home))).toBe(false)
  })

  it("an npm result whose installed package is the twin is refused promotion (nothing lands)", async () => {
    const home = freshHome("i2")
    const node = stageFakeNode(home)
    const lock = fakeLock()
    const destPath = stageTarball(home)
    const { res } = await grantedInstall(home, lock, node, destPath, { npmMode: "twin-name" })
    expect(res.token).toBe(OUTCOME.FAILED)
    expect(res.message ?? "").toContain("not @nanonets/graft@0.18.0")
    expect(existsSync(VERSION_DIR(home))).toBe(false) // refusing to promote
    expect(
      readdirSync(GRAFT_ROOT(home)).filter((n) => n.startsWith(".install-") || n.startsWith(".quarantine-")),
    ).toEqual([])
  })

  it("a twin package appearing in the install tree aborts promotion", async () => {
    const home = freshHome("i3")
    const node = stageFakeNode(home)
    const lock = fakeLock()
    const destPath = stageTarball(home)
    const { res } = await grantedInstall(home, lock, node, destPath, { npmMode: "twin-present" })
    expect(res.token).toBe(OUTCOME.FAILED)
    expect(res.message ?? "").toContain("twin")
    expect(existsSync(VERSION_DIR(home))).toBe(false)
  })
})

describe("(j) prerequisite: a missing private Node is reported honestly, never a system fallback", () => {
  it("FAILED naming the unavailable prerequisite when nodeBin cannot resolve", async () => {
    const home = freshHome("j1")
    const lock = fakeLock()
    const spy = fetchSpy(join(GRAFT_ROOT(home), TARBALL_NAME))
    const res = await step.install(ctxOf(lock), {
      provenancePath: join(home, "prov.jsonl"),
      consentGate: () => true,
      fetchImpl: spy.impl,
      resolveNode: () => ({ ok: false, reason: "private node vTest-fake is not installed" }),
    })
    expect(res.token).toBe(OUTCOME.FAILED)
    expect(res.message ?? "").toContain("prerequisite private Node")
    expect(spy.calls).toBe(0) // never downloads without its runtime
  })
})

describe("(k) telemetry-off gate: a not-off report refuses to mark the component healthy", () => {
  it("HEALTH_FAILED when the telemetry probe does not report off", async () => {
    const home = freshHome("k1")
    const node = stageFakeNode(home)
    const lock = fakeLock()
    const destPath = stageTarball(home)
    const spy = fetchSpy(destPath)
    const npm = npmSim()
    const health = healthSim()
    const telemetry = telemetrySim(false) // reports ON
    const res = await step.install(ctxOf(lock), {
      provenancePath: join(home, "prov.jsonl"),
      consentGate: () => true,
      fetchImpl: spy.impl,
      resolveNode: node.resolveNode,
      npmRunner: npm.runner,
      healthRunner: health.runner,
      telemetryRunner: telemetry.runner,
    })
    expect(res.token).toBe(OUTCOME.HEALTH_FAILED)
    expect(res.message ?? "").toContain("telemetry")
    const st = readState(lock.version)
    if (st.ok) expect(st.state.components.graft.state).toBe("failed") // never rests at healthy
  })
})

describe("(l) install failure: nothing is promoted, lifecycle records failed, no debris", () => {
  it("npm-runner failure leaves no version dir and no temp dirs", async () => {
    const home = freshHome("l1")
    const node = stageFakeNode(home)
    const lock = fakeLock()
    const destPath = stageTarball(home)
    const { res } = await grantedInstall(home, lock, node, destPath, { npmMode: "fail" })
    expect(res.token).toBe(OUTCOME.FAILED)
    expect(existsSync(VERSION_DIR(home))).toBe(false)
    expect(
      readdirSync(GRAFT_ROOT(home)).filter((n) => n.startsWith(".install-") || n.startsWith(".quarantine-")),
    ).toEqual([])
    const st = readState(lock.version)
    if (st.ok) expect(st.state.components.graft.state).toBe("failed")
  })

  it("an install that yields no CLI entry is refused promotion", async () => {
    const home = freshHome("l2")
    const node = stageFakeNode(home)
    const lock = fakeLock()
    const destPath = stageTarball(home)
    const { res } = await grantedInstall(home, lock, node, destPath, { npmMode: "no-cli" })
    expect(res.token).toBe(OUTCOME.FAILED)
    expect(existsSync(VERSION_DIR(home))).toBe(false)
  })
})

describe("(m) nativeBuild=auto: a missing-build --version triggers a scoped offline rebuild, then healthy", () => {
  it("rebuilds third-party addons once and records nativeRebuilt=true", async () => {
    const home = freshHome("m1")
    const node = stageFakeNode(home)
    const lock = fakeLock()
    const destPath = stageTarball(home)
    const spy = fetchSpy(destPath)
    const npm = npmSim()
    const health = healthSeq([
      { ok: false, detail: MISSING_BUILD_DETAIL },
      { ok: true, versionOutput: GRAFT_VER, detail: "ran" },
    ])
    const rb = rebuildSim("good")
    const telemetry = telemetrySim(true)
    const res = await step.install(ctxOf(lock), {
      provenancePath: join(home, "prov.jsonl"),
      consentGate: () => true,
      fetchImpl: spy.impl,
      resolveNode: node.resolveNode,
      npmRunner: npm.runner,
      healthRunner: health.runner,
      rebuildRunner: rb.runner,
      telemetryRunner: telemetry.runner,
    })
    expect(res.token).toBe(OUTCOME.OK)
    expect(res.message ?? "").toContain("native addons rebuilt")
    expect(rb.seenArgv.length).toBe(1) // exactly one rebuild
    expect(rb.seenArgv[0]).toContain("rebuild")
    expect(rb.seenCwd[0]).toBe(VERSION_DIR(home)) // rebuild runs INSIDE the committed version dir
    expect(rb.seenEnv[0]!.PATH!.startsWith(join(node.nodePath, "..") + ":")).toBe(true) // private node bin prepended to the CHILD PATH copy only
    expect(rb.seenEnv[0]!.DO_NOT_TRACK).toBe("1")
    expect(health.calls).toBe(2) // probed, rebuilt, re-probed
    expect(readInstallRecord(VERSION_DIR(home))?.nativeRebuilt).toBe(true)
    // The compiled binding lives under the listed version dir (removal will take it).
    expect(
      existsSync(
        join(
          VERSION_DIR(home),
          "node_modules",
          "@nanonets",
          "graft",
          "node_modules",
          "tree-sitter-kotlin",
          "build",
          "Release",
          "tree_sitter_kotlin_binding.node",
        ),
      ),
    ).toBe(true)
  })
})

describe("(n) nativeBuild=off: a missing-build --version is NOT rebuilt and fails closed", () => {
  it("HEALTH_FAILED with zero rebuild calls when the posture is strict", async () => {
    const home = freshHome("n1")
    const node = stageFakeNode(home)
    const lock = fakeLock()
    const destPath = stageTarball(home)
    const spy = fetchSpy(destPath)
    const npm = npmSim()
    const health = healthSeq([{ ok: false, detail: MISSING_BUILD_DETAIL }])
    const rb = rebuildSim("good")
    const telemetry = telemetrySim(true)
    const res = await step.install(ctxOf(lock), {
      provenancePath: join(home, "prov.jsonl"),
      consentGate: () => true,
      fetchImpl: spy.impl,
      resolveNode: node.resolveNode,
      npmRunner: npm.runner,
      healthRunner: health.runner,
      rebuildRunner: rb.runner,
      telemetryRunner: telemetry.runner,
      nativeBuild: "off",
    })
    expect(res.token).toBe(OUTCOME.HEALTH_FAILED)
    expect(rb.seenArgv.length).toBe(0) // strict posture never compiles
    const st = readState(lock.version)
    if (st.ok) expect(st.state.components.graft.state).toBe("failed")
  })
})

describe("(o) nativeBuild=auto but the rebuild fails: honest HEALTH_FAILED, no false healthy", () => {
  it("reports the rebuild failure and leaves the component failed", async () => {
    const home = freshHome("o1")
    const node = stageFakeNode(home)
    const lock = fakeLock()
    const destPath = stageTarball(home)
    const spy = fetchSpy(destPath)
    const npm = npmSim()
    const health = healthSeq([{ ok: false, detail: MISSING_BUILD_DETAIL }])
    const rb = rebuildSim("fail")
    const telemetry = telemetrySim(true)
    const res = await step.install(ctxOf(lock), {
      provenancePath: join(home, "prov.jsonl"),
      consentGate: () => true,
      fetchImpl: spy.impl,
      resolveNode: node.resolveNode,
      npmRunner: npm.runner,
      healthRunner: health.runner,
      rebuildRunner: rb.runner,
      telemetryRunner: telemetry.runner,
    })
    expect(res.token).toBe(OUTCOME.HEALTH_FAILED)
    expect(res.message ?? "").toContain("native rebuild failed")
    expect(health.calls).toBe(1) // did not re-probe after a failed build
    const st = readState(lock.version)
    if (st.ok) expect(st.state.components.graft.state).toBe("failed")
  })
})
