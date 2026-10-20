// Row 108 — tamper-matrix driver: ONE mock release server (Bun.serve, real TLS,
// loopback) with per-component routes and controlled failure injection; each
// invocation runs exactly ONE matrix cell and exits with the program's own
// exit-code convention (outcomes.ts exitCodeFor — gate D-23: 0 = ok/skip,
// 1 = refusal/failure/BLOCKED_BY_NETWORK). Exit 2 = harness assertion failed
// (a broken proof, never a product outcome).
//
// Run through the sanctioned runner (it generates the throwaway CA, probes a
// pool port with lsof and exports NODE_EXTRA_CA_CERTS before launch):
//   bash packages/setup/test/tamper.proofs.sh
// Manual single cell (CA + probed port already known):
//   R108_CA_DIR=<cadir> NODE_EXTRA_CA_CERTS=<cadir>/ca.pem bun test/tamper_matrix.driver.ts \
//     --case hash --component node --home <throwaway-home> --port <probed-port>
//
// Sandbox posture (PORT RULE + collision policy): binds ONLY 127.0.0.1 on the
// port passed via argv (never a literal in this file), writes ONLY under the
// throwaway HOME given via --home (paths.ts resolves $HOME per call, so every
// staging/tool/state/provenance default lands inside it — the shipped PC-PATH
// posture is exercised, not a custom one). Zero public network: every fetchable
// URL of the synthetic lock points at this fixture; the real hosts list is
// carried only so validateLock passes unchanged — no request ever targets them.
// The ONLY read of the real home is the teamid-real probe inspecting the
// already-staged Obsidian.app via /usr/bin/codesign (inspection, not execution).
//
// Honesty notes:
//  - The synthetic lock mirrors the REAL pin field names/algorithms per
//    component (tarball_sha256 / integrity sha512 / sha256 / dmg_sha256 /
//    runtime sub-pins + null guest_image) so each cell exercises its own
//    component's verification shape. Fixture bytes are small; sizes are pinned
//    to the fixture size, so the size-cap path is exercised consistently.
//  - node/graft/rtk/obsidian cells run at STEP level with the REAL row-82
//    downloader (no fetchImpl substitution). Post-download runners are seams
//    ONLY where they would otherwise require real npm/hdiutil/codesign of fake
//    bytes (each row's own proofs cover those surfaces); every refusal happens
//    BEFORE any of them is reached, and the drivers assert their call counts.
//  - runtime has no fetch path in its step (brew channel, s86 §1); its cells
//    run at library level through fetchArtifact — the same ONE implementation
//    every step consumes (s82). guest_image stays NO_URL_PINNED ->
//    SKIPPED_WITH_INSTRUCTIONS per the D-13/s86 RECORDED-UNKNOWN ruling.

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fetchArtifact, outcomeTokenFor, type FetchResult } from "../src/fetch.ts"
import { validateLock, type LockFile } from "../src/lockfile.ts"
import { macSignatureCheck } from "../src/verify.ts"
import { provenanceFile, readProvenanceRecords } from "../src/provenance.ts"
import { exitCodeFor, OUTCOME, type OutcomeToken } from "../src/outcomes.ts"
import { defaultState, readState } from "../src/state.ts"
import nodeStep from "../src/steps/node/index.ts"
import graftStep from "../src/steps/graft/index.ts"
import rtkStep from "../src/steps/rtk/index.ts"
import obsidianStep from "../src/steps/obsidian/index.ts"

// --- args ------------------------------------------------------------------------------

function arg(name: string): string {
  const i = process.argv.indexOf(name)
  const value = i >= 0 ? process.argv[i + 1] : undefined
  if (!value) throw new Error(`missing ${name}`)
  return value
}
function argOpt(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const CASE = arg("--case")
const COMPONENT = arg("--component") as
  | "runtime"
  | "node"
  | "graft"
  | "rtk"
  | "obsidian"
const HOME_THROWAWAY = arg("--home")
const PORT = Number(arg("--port"))
const CA_DIR = process.env.R108_CA_DIR ?? ""
const REAL_APP = argOpt("--app") ?? ""

process.env.HOME = HOME_THROWAWAY // paths.ts resolves $HOME per call — containment switch

if (!Number.isInteger(PORT) || PORT <= 0) bail(`--port must be a positive integer (probed), got ${arg("--port")}`)
if (CASE !== "teamid-real" && CASE !== "guest-image") {
  if (CA_DIR === "" || !existsSync(join(CA_DIR, "server.key")) || !existsSync(join(CA_DIR, "chain.pem")))
    bail("R108_CA_DIR missing or incomplete — run via tamper.proofs.sh (NODE_EXTRA_CA_CERTS must also be exported)")
  if (!process.env.NODE_EXTRA_CA_CERTS) bail("NODE_EXTRA_CA_CERTS not exported — TLS trust would be unseeded")
}

function bail(message: string): never {
  console.log(`HARNESS-ERROR ${message}`)
  process.exit(2)
}

// --- fixtures ---------------------------------------------------------------------------

const FIXTURE_SIZE = 4096

function fixtureBytes(marker: string): Uint8Array {
  const base = `swarm-r108-tamper-fixture ${marker}\n`
  const text = base.repeat(Math.ceil(FIXTURE_SIZE / base.length)).slice(0, FIXTURE_SIZE)
  return new TextEncoder().encode(text)
}
const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")
const sha512Integrity = (bytes: Uint8Array): string =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`

/** Host list copied from the shipped tools.lock.json (hostnames, not ports) so
 *  validateLock's image-ref alias checks pass unchanged; 127.0.0.1 added for the
 *  fixture — the same narrowing discipline r82's fixture uses, widened here only
 *  by keeping the reviewed hosts present-but-unused. */
const REVIEWED_HOSTS = [
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "api.github.com",
  "ghcr.io",
  "registry-1.docker.io",
  "auth.docker.io",
  "registry.npmjs.org",
  "nodejs.org",
  "formulae.brew.sh",
]

interface MockLockOpts {
  readonly mode?: "g" | "w" | "cut" | "redir-http" // which route family the component url points at
  readonly insecure?: boolean // pin the url as http:// (downgrade-at-source case)
  readonly teamId?: string | null // obsidian team_id pin
}

/** Realistic last-segment names so deriveName() lands product-shaped files in staging. */
const GOOD_NAME: Record<string, string> = {
  runtime: "colima-v0.10.3.tgz",
  node: "node-v24.22.0-darwin-arm64.tar.gz",
  graft: "graft-0.18.0.tgz",
  rtk: "rtk-oss-aarch64-apple-darwin.tar.gz",
  obsidian: "Obsidian-1.14.4.dmg",
}
/** npm-shaped path prefix: the graft step's D-10 twin guard requires the pin url to
 *  literally target the reviewed scope "@nanonets/graft" (src/steps/graft/index.ts:504). */
const URL_PREFIX: Record<string, string> = { graft: "@nanonets/graft/-/" }
function routeUrl(scheme: string, port: number, component: string, mode: string): string {
  return `${scheme}://127.0.0.1:${port}/${component}/${mode}/${URL_PREFIX[component] ?? ""}${GOOD_NAME[component] ?? "artifact"}`
}

function mockLock(opts: MockLockOpts = {}): LockFile {
  const urlFor = (component: string, mode: string): string =>
    routeUrl(opts.insecure ? "http" : "https", PORT, component, mode)
  const good = fixtureBytes(`${COMPONENT}-good`)
  const mode = opts.mode ?? "g"
  const sha = sha256Hex(good)
  const parsed = {
    schemaVersion: 1,
    version: "swarm-tools-1.19.3-r1+tamper-mock",
    hosts: [...REVIEWED_HOSTS, "127.0.0.1"],
    components: {
      runtime: {
        install_dir: "~/.swarm/tools/runtime",
        channel: "homebrew",
        colima: { url: urlFor("runtime", mode), version: "v0.10.3", size: good.byteLength, sha256: sha },
        lima: { url: urlFor("runtime", "g"), version: "v2.2.1", size: good.byteLength, sha256: sha },
        docker_compose: { url: urlFor("runtime", "g"), version: "v5.6.0", size: good.byteLength, sha256: sha },
        guest_image: { url: null, version: null, sha256: null }, // D-13 posture kept honest
      },
      node: {
        install_dir: "~/.swarm/tools/node",
        url: urlFor("node", mode),
        version: "v24.22.0",
        codename: "Krypton",
        size: good.byteLength,
        tarball_sha256: sha,
      },
      graft: {
        install_dir: "~/.swarm/tools/graft",
        package: "@nanonets/graft",
        url: urlFor("graft", mode),
        version: "0.18.0",
        size: good.byteLength,
        integrity: sha512Integrity(good),
      },
      rtk: {
        install_dir: "~/.swarm/tools/rtk",
        edition: "rtk-oss",
        url: urlFor("rtk", mode),
        version: "v1.0.1",
        size: good.byteLength,
        sha256: sha,
      },
      obsidian: {
        install_dir: "~/.swarm/tools/obsidian",
        url: urlFor("obsidian", mode),
        version: "v1.14.4",
        size: good.byteLength,
        dmg_sha256: sha,
        team_id: opts.teamId === undefined ? null : opts.teamId,
        codesign_required: true,
      },
      searxng: {
        install_dir: "~/.swarm/tools/searxng",
        image: "ghcr.io/searxng/searxng@sha256:338f261054e8edf2a00000000000000000000000000000000000000000000000",
        valkey_image: "docker.io/valkey/valkey@sha256:eb5a657e070199bef00000000000000000000000000000000000000000000000",
      },
      firecrawl: {
        install_dir: "~/.swarm/tools/firecrawl",
        api_image: "ghcr.io/firecrawl/firecrawl@sha256:6bb90229081b94cd800000000000000000000000000000000000000000000000",
        redis_image: "docker.io/library/redis@sha256:41a10b18bd238fa7800000000000000000000000000000000000000000000000",
      },
    },
  }
  const validated = validateLock(parsed)
  if (!validated.ok) {
    // Defense layer 1: the real loader refuses an http-pinned lock outright. For the
    // downgrade-pin cell that refusal is EXPECTED evidence; the cell then hands the
    // doctored object to fetchArtifact directly to prove defense layer 2 (guardUrl)
    // also refuses — the same two-layer reading r82's CASE-A test encodes.
    if (!opts.insecure) bail(`synthetic lock rejected by the real validateLock: ${validated.error}`)
    console.log(`LAYER1_VALIDATELOCK=${validated.error}`)
    const hosts = [...REVIEWED_HOSTS, "127.0.0.1"]
    return {
      schemaVersion: 1,
      version: "swarm-tools-1.19.3-r1+tamper-mock",
      hosts,
      components: parsed.components,
      raw: parsed,
    }
  }
  return validated.lock
}

// --- mock release server (real TLS, per-component routes, fault injection) --------------

const hits: Record<string, number> = {}
let server: { port: number; stop(force?: boolean): void } | null = null

function startServer(): void {
  hits.__total = 0
  server = Bun.serve({
    port: PORT, // probed pool port from argv — never a literal here
    hostname: "127.0.0.1",
    tls: { key: Bun.file(join(CA_DIR, "server.key")), cert: Bun.file(join(CA_DIR, "chain.pem")) },
    fetch(req: Request): Response | Promise<Response> {
      const path = new URL(req.url).pathname
      hits[path] = (hits[path] ?? 0) + 1
      hits.__total = (hits.__total ?? 0) + 1
      const segments = path.split("/").filter((s) => s !== "")
      const component = segments[0] ?? "?"
      const mode = segments[1] ?? ""
      if (mode === "g") return new Response(fixtureBytes(`${component}-good`).slice(), { status: 200 })
      if (mode === "w")
        // same byte length, different content: SIZE passes, HASH must refuse (r82 Proof D mirror)
        return new Response(fixtureBytes(`${component}-WRONG`).slice(), { status: 200 })
      if (mode === "redir-good")
        return new Response(null, { status: 302, headers: { location: routeUrl("https", PORT, component, "g") } })
      if (mode === "redir-http")
        // https->http downgrade attempt (mirrors r82 CASE-A mechanism: fetch.test.ts "/redirect-downgrade")
        return new Response(null, { status: 302, headers: { location: routeUrl("http", PORT, component, "g") } })
      if (mode === "cut") {
        // offline MID-RUN: ship half the body, then the SERVER DIES — stop(true) severs
        // the in-flight socket, which is exactly what a server crashing mid-transfer looks
        // like to any client. (controller.error() cannot emulate this in-process: bun 1.3.14
        // surfaces it as an uncaught throw instead of a wire-level reset.)
        const half = fixtureBytes(`${component}-good`).subarray(0, FIXTURE_SIZE / 2)
        setTimeout(() => {
          try {
            server?.stop(true)
          } catch {
            /* already gone */
          }
        }, 30)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(half.slice())
            },
          }),
        )
      }
      return new Response(null, { status: 404 })
    },
  })
}

// --- evidence helpers --------------------------------------------------------------------

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(p))
    else out.push(p)
  }
  return out
}

let assertions = 0
function assertEvid(label: string, cond: boolean, detail = ""): void {
  assertions += 1
  console.log(`ASSERT ${cond ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`)
  if (!cond) process.exitCode = 2
}

function ledgerSnapshot(): number {
  return readProvenanceRecords().length
}
function ledgerDelta(from: number): Array<Record<string, unknown>> {
  return readProvenanceRecords().slice(from) as Array<Record<string, unknown>>
}

// --- step-level execution with instrumented seams -----------------------------------------

interface SeamCounts {
  extractor: number
  health: number
  npm: number
  resolveNode: number
  signatureGate: number
  detector: number
  mount: number
  unmount: number
  signatureRun: number
}
const counts: SeamCounts = {
  extractor: 0,
  health: 0,
  npm: 0,
  resolveNode: 0,
  signatureGate: 0,
  detector: 0,
  mount: 0,
  unmount: 0,
  signatureRun: 0,
}

function ctxOf(lock: LockFile): { lock: LockFile; state: ReturnType<typeof defaultState>; dryRun: boolean } {
  const loaded = readState(lock.version)
  return { lock, state: loaded.ok ? loaded.state : defaultState(lock.version), dryRun: false }
}

const OBSIDIAN_TEAM_OBSERVED = "6JSW4SJWN9" // r90 U-2 closer fact (recorded, lock still null-pinned)

async function installAtStepLevel(lock: LockFile): Promise<{ token: OutcomeToken; message?: string }> {
  const consent = () => true // sanctioned r84 seam: drives the granted path, writes no consent.log
  if (COMPONENT === "node") {
    return nodeStep.install(ctxOf(lock), {
      consentGate: consent,
      extractor: (_tarball: string, destDir: string) => {
        counts.extractor += 1
        mkdirSync(join(destDir, "bin"), { recursive: true, mode: 0o700 })
        // test-authored shebang stub (r87 unit-(j) precedent): the REAL health runner spawns it
        writeFileSync(join(destDir, "bin", "node"), "#!/bin/sh\necho v24.22.0\n", { mode: 0o644 })
        return { ok: true, detail: "driver: staged fake node tree" }
      },
    })
  }
  if (COMPONENT === "rtk") {
    return rtkStep.install(ctxOf(lock), {
      consentGate: consent,
      extractor: (_tarball: string, destDir: string) => {
        counts.extractor += 1
        writeFileSync(join(destDir, "rtk"), "#!/bin/sh\necho 'rtk 1.0.1'\n", { mode: 0o644 })
        return { ok: true, detail: "driver: staged flat rtk layout" }
      },
      // scripted because an ad-hoc shebang stub cannot carry a real TeamID; the REAL codesign
      // path is exercised by the teamid-real probe below and by r89's own proofs.
      signatureGate: (binPath: string) => {
        counts.signatureGate += 1
        return { ok: existsSync(binPath), detail: "driver: scripted signature pass over staged bin" }
      },
    })
  }
  if (COMPONENT === "graft") {
    const fakeNodeRoot = join(HOME_THROWAWAY, "mock-private-node")
    const fakeNodeBin = join(fakeNodeRoot, "bin", "node")
    const fakeNpmCli = join(fakeNodeRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js")
    mkdirSync(dirname(fakeNodeBin), { recursive: true, mode: 0o700 })
    mkdirSync(dirname(fakeNpmCli), { recursive: true, mode: 0o700 })
    if (!existsSync(fakeNodeBin)) writeFileSync(fakeNodeBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    if (!existsSync(fakeNpmCli)) writeFileSync(fakeNpmCli, "// driver placeholder\n", { mode: 0o644 })
    return graftStep.install(ctxOf(lock), {
      consentGate: consent,
      resolveNode: () => {
        counts.resolveNode += 1
        return { ok: true, path: fakeNodeBin }
      },
      npmRunner: (_argv, _env, cwd) => {
        counts.npm += 1
        const pkgDir = join(cwd, "node_modules", "@nanonets", "graft", "dist")
        mkdirSync(pkgDir, { recursive: true, mode: 0o700 })
        writeFileSync(
          join(pkgDir, "..", "package.json"),
          JSON.stringify({ name: "@nanonets/graft", version: "0.18.0", engines: { node: ">=20" } }),
          { mode: 0o600 },
        )
        writeFileSync(join(pkgDir, "cli.js"), "// driver fake CLI entry\n", { mode: 0o644 })
        return { ok: true, detail: "driver: staged graft tree (no real npm)" }
      },
      healthRunner: () => {
        counts.health += 1
        return { ok: true, versionOutput: "0.18.0", detail: "driver: scripted health" }
      },
      telemetryRunner: () => {
        return { ok: true, off: true, observed: "telemetry: off (driver)", detail: "driver: scripted" }
      },
    })
  }
  // obsidian
  return obsidianStep.install(ctxOf(lock), {
    consentGate: consent,
    detector: () => {
      counts.detector += 1
      return { found: false, paths: [], methods: ["driver:scripted-absent"] }
    },
    mounter: (_dmg, mountPoint) => {
      counts.mount += 1
      const app = join(mountPoint, "Obsidian.app", "Contents", "MacOS")
      mkdirSync(app, { recursive: true, mode: 0o700 })
      writeFileSync(join(app, "Obsidian"), "driver-fake-app-binary\n", { mode: 0o644 })
      return { ok: true, detail: "driver: fake read-only mount" }
    },
    unmounter: (mountPoint) => {
      counts.unmount += 1
      rmSync(mountPoint, { recursive: true, force: true }) // emulates detach removing the volume
      return { ok: true, detail: "driver: fake detach" }
    },
    // Scripted ONLY for the refusal-path cells' determinism; the real codesign/spctl gate
    // runs for real in the teamid-real probe against the actually staged Obsidian.app.
    signatureRun: () => {
      counts.signatureRun += 1
      return {
        codesignOk: true,
        spctlOk: true,
        teamId: OBSIDIAN_TEAM_OBSERVED,
        detail: "driver: scripted codesign exit=0; spctl exit=0; TeamIdentifier=" + OBSIDIAN_TEAM_OBSERVED,
      }
    },
  })
}

// --- expected outcomes per case (self-checking cells) --------------------------------------

interface Expectation {
  readonly token: OutcomeToken
  readonly code?: string // provenance-line code (step level) or FetchCode (library level)
  readonly attempts?: number
  readonly provenanceLines: number // NEW ledger lines this cell must produce
}

const EXPECT: Record<string, Expectation> = {
  hash: { token: OUTCOME.FAILED, code: "HASH_MISMATCH", attempts: 1, provenanceLines: 1 },
  "downgrade-pin": { token: OUTCOME.FAILED, code: "REFUSED_INSECURE_PROTOCOL", attempts: 0, provenanceLines: 0 },
  "downgrade-redirect": { token: OUTCOME.FAILED, code: "REFUSED_INSECURE_PROTOCOL", attempts: 1, provenanceLines: 1 },
  midstream: { token: OUTCOME.BLOCKED_BY_NETWORK, code: "NETWORK_ERROR", attempts: 1, provenanceLines: 1 },
  offline: { token: OUTCOME.BLOCKED_BY_NETWORK, code: "NETWORK_ERROR", attempts: 2, provenanceLines: 1 },
  fetch: { token: OUTCOME.OK, provenanceLines: 1 },
  resumed: { token: OUTCOME.OK, provenanceLines: 1 },
  teamid: { token: OUTCOME.FAILED, code: "SIGNATURE_FAILED", provenanceLines: 2 }, // fetched-dmg line + refusal line
  "guest-image": { token: OUTCOME.SKIPPED_WITH_INSTRUCTIONS, code: "NO_URL_PINNED", provenanceLines: 0 },
}

// --- main ---------------------------------------------------------------------------------

async function main(): Promise<number> {
  console.log(`CELL ${COMPONENT}/${CASE}`)

  if (CASE === "teamid-real") return teamIdRealProbe()
  if (CASE === "audit") return auditLedger()

  const expectation = EXPECT[CASE]
  if (!expectation) bail(`unknown case ${CASE}`)

  const teamId = CASE === "teamid" ? "WRONGTEAM0000" : undefined
  const routeMode =
    CASE === "hash" ? "w" : CASE === "downgrade-redirect" ? "redir-http" : CASE === "midstream" ? "cut" : "g"
  const lock = mockLock({
    mode: routeMode === "g" || routeMode === "w" || routeMode === "cut" ? routeMode : "redir-http",
    insecure: CASE === "downgrade-pin",
    teamId,
  })

  if (CASE !== "offline") startServer()
  const before = ledgerSnapshot()

  let token: OutcomeToken
  let code: string | undefined
  let attempts: number | undefined
  let resultLine = ""

  if (COMPONENT === "runtime") {
    const artifactId = CASE === "guest-image" ? "guest_image" : "colima"
    const out: FetchResult = await fetchArtifact(lock, "runtime", {
      artifact: artifactId,
      timeoutMs: 8_000,
      retryDelayMs: 200,
    })
    if ("ok" in out && out.ok === false) {
      token = outcomeTokenFor(out.code)
      code = out.code
      attempts = out.attempts
      resultLine = out.message
    } else if ("status" in out) {
      token = OUTCOME.OK
      attempts = out.attempts
      resultLine = `status=${out.status}`
    } else {
      token = OUTCOME.OK
      resultLine = "dry_run"
    }
  } else {
    const res = await installAtStepLevel(lock)
    token = res.token
    resultLine = res.message ?? ""
  }

  const lines = ledgerDelta(before)
  const tmpFiles = filesUnder(join(HOME_THROWAWAY, ".swarm/tmp"))
  const toolFiles = filesUnder(join(HOME_THROWAWAY, ".swarm/tools", COMPONENT))
  const totalHits = hits.__total ?? 0

  console.log(`TOKEN=${token}`)
  console.log(`MESSAGE=${resultLine.split("\n")[0]}`)
  console.log(`SERVER_HITS=${JSON.stringify(hits)}`)
  console.log(`LEDGER_NEW=${lines.length}`)
  for (const l of lines) console.log(`PROVENANCE ${JSON.stringify(l)}`)
  console.log(`STAGING_TMP=${JSON.stringify(tmpFiles.map((f) => f.replace(HOME_THROWAWAY, "~")))}`)
  console.log(`TOOLROOT_FILES=${JSON.stringify(toolFiles.map((f) => f.replace(HOME_THROWAWAY, "~")))}`)
  console.log(`SEAM_COUNTS=${JSON.stringify(counts)}`)

  // product-outcome assertions (the cell's claim)
  assertEvid(`token=${expectation.token}`, token === expectation.token, `got ${token}`)
  if (expectation.code && COMPONENT === "runtime") assertEvid(`code=${expectation.code}`, code === expectation.code, `got ${code}`)
  if (expectation.attempts !== undefined && COMPONENT === "runtime")
    assertEvid(`attempts=${expectation.attempts}`, attempts === expectation.attempts, `got ${attempts}`)
  const exactLineCount = !(CASE === "fetch" || CASE === "resumed")
  if (CASE === "fetch")
    assertEvid(`at least ${expectation.provenanceLines} new ledger line(s)`, lines.length >= expectation.provenanceLines, `got ${lines.length}`)
  else if (exactLineCount)
    assertEvid(
      `new-ledger-lines=${expectation.provenanceLines}`,
      lines.length === expectation.provenanceLines,
      `got ${lines.length}`,
    )
  if (expectation.code && COMPONENT !== "runtime" && expectation.provenanceLines > 0) {
    const withCode = lines.filter((l) => l.code === expectation.code)
    assertEvid(`ledger carries code=${expectation.code}`, withCode.length >= 1)
    if (expectation.attempts !== undefined)
      assertEvid(`ledger attempts=${expectation.attempts}`, lines.some((l) => l.attempts === expectation.attempts))
  }

  // tamper refusals must leave NOTHING behind in staging or the tool root
  const refusal = CASE === "hash" || CASE.startsWith("downgrade") || CASE === "midstream" || CASE === "offline"
  if (refusal) {
    assertEvid("staging tmp empty after refusal", tmpFiles.length === 0)
    assertEvid("tool root has zero files after refusal", toolFiles.length === 0)
    // Pre-download probes (obsidian detector, graft resolveNode) legitimately run BEFORE
    // the fetch; every POST-download seam must be untouched when the chain refuses.
    const postDownloadSeams = [counts.extractor, counts.health, counts.npm, counts.signatureGate, counts.mount, counts.unmount, counts.signatureRun]
    assertEvid("no post-download seam ran", postDownloadSeams.every((n) => n === 0), JSON.stringify(counts))
  }
  if (CASE === "downgrade-pin") assertEvid("zero server hits for http-pinned url", totalHits === 0)
  if (CASE === "downgrade-redirect") {
    assertEvid("downgraded target never served", (hits[`/${COMPONENT}/g/${URL_PREFIX[COMPONENT] ?? ""}${GOOD_NAME[COMPONENT]}`] ?? 0) === 0)
    assertEvid("redirect route hit once", (hits[`/${COMPONENT}/redir-http/${URL_PREFIX[COMPONENT] ?? ""}${GOOD_NAME[COMPONENT]}`] ?? 0) === 1)
  }
  if (CASE === "hash") {
    // graft pins npm sha512 integrity; every other fixture pin is sha256 hex.
    const wrongBytes = fixtureBytes(`${COMPONENT}-WRONG`)
    const wrongHex =
      COMPONENT === "graft" ? createHash("sha512").update(wrongBytes).digest("hex") : sha256Hex(wrongBytes)
    const goodPin = COMPONENT === "graft" ? sha512Integrity(fixtureBytes(`${COMPONENT}-good`)) : sha256Hex(fixtureBytes(`${COMPONENT}-good`))
    assertEvid(
      "provenance observed==digest(tampered bytes)",
      lines.some((l) => l.observed === wrongHex),
      wrongHex,
    )
    assertEvid(
      "provenance expected==pin",
      lines.some((l) => l.expected === goodPin),
      goodPin,
    )
  }
  if (CASE === "fetch") {
    const expectedName = GOOD_NAME[COMPONENT] ?? "artifact"
    assertEvid(
      `promoted artifact present under tool root (${expectedName})`,
      toolFiles.some((f) => f.endsWith(expectedName)),
      JSON.stringify(toolFiles.map((f) => f.replace(HOME_THROWAWAY, "~"))),
    )
    if (COMPONENT === "runtime")
      assertEvid("library root holds exactly the promoted file", toolFiles.length === 1, JSON.stringify(toolFiles))
    assertEvid("staging tmp empty after success", tmpFiles.length === 0)
    assertEvid(
      "fetched line records destPath",
      lines.some((l) => l.outcome === "fetched" && typeof l.destPath === "string"),
    )
  }
  if (CASE === "resumed") {
    assertEvid("resume opened ZERO sockets", totalHits === 0, `hits=${totalHits}`)
    if (COMPONENT === "runtime")
      assertEvid("resumed line attempts=0", lines.some((l) => l.attempts === 0 && l.outcome === "resumed"))
    else
      console.log(
        `NOTE step-level resume short-circuits inside the step (inspectInstall digest-vs-record) BEFORE kit.fetch — zero ledger lines is the designed posture (s87/s88/s89/s90 resume rows)`,
      )
  }
  if (CASE === "teamid") {
    assertEvid("mounted once, detached once", counts.mount === 1 && counts.unmount === 1)
    assertEvid("no .stage-* debris under tool root", !toolFiles.some((f) => f.includes(".stage-")))
    assertEvid("staging tmp empty (mountpoint removed by detach)", tmpFiles.length === 0)
    assertEvid(
      "refusal line names stage=signature SIGNATURE_FAILED",
      lines.some((l) => l.code === "SIGNATURE_FAILED" && l.stage === "signature"),
    )
    assertEvid(
      "dmg itself remains (it PASSED its digest gate; state-listed artifact, not staging debris)",
      toolFiles.some((f) => f.endsWith("Obsidian-v1.14.4.dmg") || f.includes(".dmg")),
      JSON.stringify(toolFiles.map((f) => f.replace(HOME_THROWAWAY, "~"))),
    )
  }
  if (CASE === "guest-image") {
    assertEvid("guest_image refused fetching with instructions", token === OUTCOME.SKIPPED_WITH_INSTRUCTIONS)
    assertEvid("zero server hits", totalHits === 0)
  }

  server?.stop(true)
  const exit = exitCodeFor(token)
  console.log(`EXITCODE=${process.exitCode === 2 ? 2 : exit}`)
  return process.exitCode === 2 ? 2 : exit
}

// Real-data verify-gate probe: the ACTUAL /usr/bin/codesign + /usr/sbin/spctl over the
// Obsidian.app staged by the sanctioned r90 real run. Wrong pin must be DETECTED as a
// mismatch; the confirmed pin must match. Read-only inspection; writes nothing.
function teamIdRealProbe(): number {
  console.log("CELL obsidian/teamid-real (real codesign+spctl over the staged app)")
  if (!REAL_APP || !existsSync(REAL_APP)) bail(`--app path missing: ${REAL_APP}`)
  const wrong = macSignatureCheck(REAL_APP, { teamId: "WRONGTEAM0000" })
  const wrongMismatch = wrong.codesignOk && wrong.spctlOk && wrong.teamId !== "WRONGTEAM0000"
  console.log(`WRONG_PIN_OUTCOME=${JSON.stringify(wrong)}`)
  console.log(`WRONG_PIN_DETECTED_AS_MISMATCH=${wrongMismatch}`)
  const right = macSignatureCheck(REAL_APP, { teamId: OBSIDIAN_TEAM_OBSERVED })
  const rightMatch = right.codesignOk && right.spctlOk && right.teamId === OBSIDIAN_TEAM_OBSERVED
  console.log(`CONFIRMED_PIN_OUTCOME=${JSON.stringify(right)}`)
  console.log(`CONFIRMED_PIN_MATCHES=${rightMatch}`)
  assertEvid("wrong TeamID detected as mismatch by the real gate", wrongMismatch)
  assertEvid(`confirmed TeamID ${OBSIDIAN_TEAM_OBSERVED} matches (control)`, rightMatch)
  const exit = process.exitCode === 2 ? 2 : 0
  console.log(`EXITCODE=${exit}`)
  return exit
}

// Ledger integrity across everything written into this HOME so far.
function auditLedger(): number {
  console.log(`CELL ${COMPONENT}/audit`)
  const path = provenanceFile()
  if (!existsSync(path)) bail(`ledger missing at ${path}`)
  const raw = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "")
  const records = readProvenanceRecords()
  assertEvid("every ledger line parses as JSON", records.every((r) => r !== null), `${raw.length} lines`)
  assertEvid(
    "every record carries ts/lockVersion/component/artifact/url/expected/outcome/attempts",
    records.every(
      (r) =>
        r !== null &&
        typeof r.ts === "string" &&
        typeof r.lockVersion === "string" &&
        typeof r.component === "string" &&
        typeof r.artifact === "string" &&
        typeof r.url === "string" &&
        typeof r.expected === "string" &&
        typeof r.outcome === "string" &&
        typeof r.attempts === "number",
    ),
  )
  assertEvid(
    "all records under the mock lockVersion",
    records.every((r) => r !== null && r.lockVersion === "swarm-tools-1.19.3-r1+tamper-mock"),
  )
  assertEvid(
    "all records point at the loopback fixture only",
    records.every((r) => r !== null && r.url.includes("127.0.0.1")),
  )
  assertEvid(
    "failed/refused rows name their code",
    records.every(
      (r) => r === null || (r.outcome !== "failed" && r.outcome !== "refused") || typeof r.code === "string",
    ),
  )
  const mode = (statSync(path).mode & 0o777).toString(8)
  assertEvid("ledger file mode 600", mode === "600", `got ${mode}`)
  const dirMode = (statSync(dirname(path)).mode & 0o777).toString(8)
  assertEvid("ledger parent dir mode 700", dirMode === "700", `got ${dirMode}`)
  console.log(`AUDIT_LINES=${raw.length}`)
  for (const l of raw) console.log(`PROVENANCE ${l}`)
  const exit = process.exitCode === 2 ? 2 : 0
  console.log(`EXITCODE=${exit}`)
  return exit
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.log(`HARNESS-ERROR ${(err as Error).stack ?? String(err)}`)
    process.exit(2)
  })
