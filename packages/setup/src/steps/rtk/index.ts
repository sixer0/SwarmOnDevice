// RTK prerequisite step (row 89; PC-CMP-04 / PC-PIN-02). Installs the pinned `rtk-oss`
// release asset into a PRIVATE directory — `~/.swarm/tools/rtk/<version>/` — and NOTHING
// else. The decisions this file encodes, each traceable:
//
//   - APACHE-2.0 EDITION ONLY (B3 / decision 14). The reviewed lock pins the `rtk-oss`
//     arm64 asset (01c1_tools_lock.json components.rtk; 02d §2); the BUSL-edition binary
//     and the BUSL rtk-proxy daemon are out of scope (03f §5 L16). A cheap defense-in-depth
//     guard below refuses an artifact whose lock entry declares `edition: "rtk-oss"` while
//     its url names a different asset — swapping editions must be a lock change, not a
//     silent code path.
//   - PRIVATE PINNED BINARY, NEVER SYSTEM PATH. The binary is invoked only by absolute
//     path through rtkBin() below (rows 97/98 handoff). This module never prepends/appends
//     PATH, never writes rc files, never installs under a system prefix (P-16 whitelist;
//     01c §12 rtk bullet). The zero-PATH-mutation guarantee is unit-tested with a full
//     env snapshot diff, not just asserted by reading code.
//   - NO CONFIG WRITTEN ANYWHERE (controller no-init ruling on this row; blueprint row 89
//     forbids both commands in the lock's never_run array, 02_structured.md:253). The step's CONFIGURED
//     state IS the private placement: there is no settings file to render. RTK's own
//     config/tracking store is created by RTK itself when a HUMAN later runs it, inside the
//     P-16 delegated location `~/Library/Application Support/rtk/` (01c §6.4 D-08) — this
//     step neither pre-creates nor edits it, and its `never_run` commands (lock field;
//     03e P-11) are never spawned here: the ONLY argv this module executes is `--version`,
//     poka-yoke-enforced by allowedProbeArgv() below. Telemetry is opt-in and off by
//     default upstream (02b §2), so "never enable" needs no config to hold.
//   - PRE-EXISTING rtk DETECTED, NEVER TOUCHED (row-89 gate, 02_structured.md:253; red
//     line 8). detectPreexistingRtk() stats the standard Homebrew locations READ-ONLY and
//     logs what it found; the Homebrew edition does not satisfy this pin (lock note) and
//     stays byte-identical. Removal deletes only state-listed paths under our own root.
//   - FETCH THROUGH THE KIT ONLY. kit.fetch() (row 84) enforces consent layer 2 before any
//     socket and propagates --dry-run into row 82's zero-write posture; row 82 enforces
//     HTTPS + host allow-list (github.com + objects.githubusercontent.com are both on the
//     P-18 list; the release download redirects there) + size cap + sha256-before-use.
//     The pin is rtk.sha256, sourced independently from the release checksums.txt (NR-03).
//   - ATOMIC EXTRACTION (§6.2). Extract to a same-directory temp under the install root,
//     locate the single `rtk` file (the archive layout is NOT assumed: flat or one
//     top-level dir both resolve), stage it as <version>/rtk in a second temp, then commit
//     with ONE rename(2). A kill -9 at any instant leaves either no install or the complete
//     one. A pre-existing bad tree is quarantined by rename BEFORE the commit, deleted after.
//   - SIGNATURE VERIFICATION BEFORE EXECUTION (P-1 §6.1 step 3). The staged Mach-O passes
//     `codesign --verify --deep --strict` through verify.ts macSignatureCheck BEFORE it is
//     committed or run; failure aborts fail-closed. `spctl -a -t exec` is RUN and RECORDED
//     but not fatal for a CLI binary: measured on this host, Gatekeeper's exec assessment
//     rejects even perfectly signed command-line tools ("does not seem to be an app", rc=3,
//     against bun and Homebrew rg), so failing closed on it would reject every CLI tool the
//     design pins. Quarantine is NEVER stripped by anything here (P-2; 01b R8): files fetched
//     over HTTPS carry no quarantine attribute at all — asserted by proofs ls -l@ evidence.
//   - IDEMPOTENCE / RESUME (§6.3). A valid install is detected by hashing the private rtk
//     BINARY against the digest recorded in the install's own provenance file — never by
//     trusting the directory name or the state entry alone. Match => resumed, ZERO network.
//     Mismatch or missing record => tamper: replace from the verified tarball (row 82
//     re-hashes the tarball itself before any use, so a tampered install cannot propagate).
//   - REMOVAL = STATE-LISTED PATHS ONLY (§7, P-14). remove deletes exactly the paths this
//     component recorded in state.json, and only paths inside its own tool dir. A component
//     not flagged installedBySwarm is skipped, never deleted.
//   - DRY-RUN ZERO WRITES (PC-FLAG-03). Under --dry-run this step creates no directory, no
//     file, no state commit: kit.transition records in-memory markers, kit.log returns the
//     redacted line, and row 82 takes its own resume-check-only path. Proven by asserting
//     the whole throwaway HOME tree stays empty.
//
// Spawning discipline: NO node:child_process import anywhere here (row 82's gate confines
// that module to verify.ts across all of src/, fetch.proofs.sh 3c). Extraction uses
// /usr/bin/tar and the health probe uses the private binary via Bun.spawnSync with argv
// ARRAYS and absolute paths — unpacking a digest-verified tarball is not executing its
// payload; the `--version` spawn IS the deliberate, blueprint-mandated execution of the
// verified bytes (02_structured.md:253). Never a shell, never PATH lookup, never curl-pipe
// (P-3). Piped output is normalized through TextDecoder (bun 1.3.14 returns Buffer).

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createStepKit, outcomeTokenFor, stepOutcomeFromFetch } from "../../stepkit.ts"
import type { fetchArtifact, FetchOptions, ResolveResult } from "../../fetch.ts"
import type { StepContext, StepModule, StepResult } from "../_template/index.ts"
import { ensureDir, toolDir } from "../../paths.ts"
import { MODES, STATES, type ComponentId, type StateValue } from "../../constants.ts"
import { OUTCOME } from "../../outcomes.ts"
import { computeFileDigest, fileMatchesDigest, macSignatureCheck, parseExpectedDigest } from "../../verify.ts"
import { appendProvenance } from "../../provenance.ts"
import { atomicWriteJson } from "../../atomic.ts"
import { setState, type ComponentState } from "../../state.ts"
import { loadLock, type LockFile } from "../../lockfile.ts"

const COMPONENT: ComponentId = "rtk"

/** Absolute-path SYSTEM unpacker. Pinned by path so no PATH lookup can substitute it. */
const TAR_TOOL = "/usr/bin/tar"

/** Install-time artifacts inside the step's own root (removed only via state-listed paths). */
const MANIFEST_NAME = ".swarm-rtk.json" // inside <version>/ — provenance record of the install
const POINTER_NAME = "current.json" // in the tool root — resolver hint for rows 97/98

/** The ONE argv shape this module ever executes against the downloaded binary. The health
 *  gate is `--version`; anything else (including every lock `never_run` command) is refused
 *  by allowedProbeArgv() before spawnSync is reached. Data-driven deny needs no forbidden
 *  literals in this source: the lock's never_run array carries them (01c1_tools_lock.json). */
const PROBE_ARGV: readonly string[] = ["--version"]

const DEFAULT_EXTRACT_TIMEOUT_MS = 60_000 // ~5 MB gz archive
const DEFAULT_HEALTH_TIMEOUT_MS = 15_000 // `--version` prints and exits

/** Standard Homebrew install locations checked READ-ONLY for a pre-existing rtk (02c §2:
 *  this dev Mac has the other edition at /opt/homebrew/bin/rtk). Read-only stat only —
 *  nothing here ever writes, moves, or removes anything outside ~/.swarm (P-16). */
const PREEXISTING_CANDIDATES = ["/opt/homebrew/bin/rtk", "/usr/local/bin/rtk"] as const

// --- public provenance-record shape -----------------------------------------------------

/** What one completed install knows about itself. Written INSIDE the version dir so the
 *  idempotence check travels with the installation; mirrored into state.json via the
 *  paths/version/integrity patch (D-17: recorded paths == created paths). */
export interface RtkInstallRecord {
  readonly component: "rtk"
  readonly version: string // lock pin, e.g. "v1.0.1"
  readonly edition?: string // lock edition field ("rtk-oss") — B3 provenance
  readonly url: string // pinned artifact URL actually fetched
  readonly tarballSha256: string // lock pin (hex)
  readonly observedTarballSha256: string // == pin, enforced by row 82 before promotion
  readonly rtkBinarySha256: string // digest of <version>/rtk AT INSTALL — the resume key
  readonly codesignDetail?: string // signature-gate evidence recorded at install (P-1)
  readonly spctlDetail?: string // Gatekeeper assessment recorded, not gated (see header)
  readonly installedAt: string // ISO-8601
  readonly lockVersion: string // tools.lock.json .version
  readonly paths: readonly string[] // what removal may delete (state-listed mirror)
}

// --- seams (TEST SEAM ONLY, r82/r83/r84/r87 narrowing discipline) ------------------------

export interface ExtractOutcome {
  readonly ok: boolean
  readonly detail: string
}

export interface HealthOutcome {
  readonly ok: boolean
  /** Trimmed stdout of `<bin> --version`, when it ran. */
  readonly versionOutput?: string
  readonly detail: string
}

export interface SignatureGateOutcome {
  readonly ok: boolean
  readonly detail: string
}

export interface RtkStepOptions {
  /** Tool root; defaults to ~/.swarm/tools/rtk (PC-PATH-08 via paths.toolDir). Tests point
   *  HOME at a throwaway dir instead — the default then lands inside it. */
  readonly installRoot?: string
  /** Provenance ledger destination forwarded to kit.fetch + the install record. */
  readonly provenancePath?: string
  /** setup.log destination forwarded to the kit's redactor. */
  readonly logPath?: string
  /** Per-run correlation id stamped on log lines (global-rules correlation_id). */
  readonly correlationId?: string
  readonly extractTimeoutMs?: number
  readonly healthTimeoutMs?: number
  /** TEST SEAM ONLY: replaces the system-tar extraction so units drive success/failure
   *  deterministically. It cannot weaken verification: the tarball digest was already
   *  enforced by row 82 before this is ever called, and the post-extract locate step plus
   *  the signature and health gates stay on the real path regardless of the seam. */
  readonly extractor?: (tarballPath: string, destDir: string) => ExtractOutcome
  /** TEST SEAM ONLY: replaces the codesign/spctl verification of the staged binary. Units
   *  script it because their fixture is a shell script, not a Mach-O; the real proof runs
   *  the REAL gate against the genuine artifact (that invocation is part of P5). */
  readonly signatureGate?: (binPath: string) => SignatureGateOutcome
  /** TEST SEAM ONLY: replaces the `--version` spawn. Units assert the EXACT absolute bin
   *  path handed to it (resolver-path proof) instead of executing a fake binary. The real
   *  extraction proof runs the REAL runner — that invocation is the blueprint gate. */
  readonly healthRunner?: (binPath: string) => HealthOutcome
  /** TEST SEAM ONLY: overrides the read-only pre-existing-detection candidates so units
   *  stay machine-independent. Default = the two standard Homebrew locations. */
  readonly preexistingCandidates?: readonly string[]
  /** TEST SEAM ONLY, forwarded verbatim to createStepKit (r84 discipline): () => false
   *  proves refusal, () => true drives the granted path. It cannot grant consent
   *  out-of-band — nothing here writes consent.log. */
  readonly consentGate?: (id: ComponentId) => boolean
  /** TEST SEAM ONLY, forwarded verbatim to createStepKit: an instrumented downloader to
   *  count network proxies or stage a fixture artifact. Defaults to the real row-82 fetch. */
  readonly fetchImpl?: typeof fetchArtifact
}

// --- resolver API for rows 97/98 ---------------------------------------------------------

export interface RtkBinResult {
  readonly ok: boolean
  /** Absolute path of the private rtk binary; present iff ok. */
  readonly path?: string
  /** Why unavailable (not installed / tampered / pin missing) — never a secret. */
  readonly reason?: string
}

/** Version pinned by the reviewed lock (no fallback: an absent pin is an error). */
export function rtkVersionFromLock(lock: LockFile): { ok: true; version: string } | { ok: false; error: string } {
  const pin = lock.components[COMPONENT]
  const version = pin && typeof pin.version === "string" ? pin.version : undefined
  if (!version || version.trim() === "")
    return { ok: false, error: "tools.lock.json carries no components.rtk.version pin" }
  return { ok: true, version }
}

/** The step's private tool root: ~/.swarm/tools/rtk (installRoot seam for tests). */
export function rtkToolRoot(installRoot?: string): string {
  return installRoot ?? toolDir(COMPONENT)
}

/**
 * THE resolver rows 97/98 call to invoke the private rtk by ABSOLUTE path. Contract:
 *  - resolves the version from the lock (or an explicit override),
 *  - returns the exact path `<root>/<version>/rtk`,
 *  - verifies presence + exec bit + recorded-digest match (tamper-aware: a binary that
 *    differs from its install record is reported NOT-USABLE, never silently used),
 *  - NEVER consults or mutates PATH — the returned path works with an empty environment.
 */
export function rtkBin(options: { lock?: LockFile; version?: string; installRoot?: string } = {}): RtkBinResult {
  const lockRes = options.lock ? ({ ok: true, lock: options.lock } as const) : loadLock()
  if (!lockRes.ok) return { ok: false, reason: `cannot load tools.lock.json: ${lockRes.error}` }
  const versionRes =
    options.version !== undefined ? ({ ok: true, version: options.version } as const) : rtkVersionFromLock(lockRes.lock)
  if (!versionRes.ok) return { ok: false, reason: versionRes.error }

  const root = rtkToolRoot(options.installRoot)
  const binPath = join(root, versionRes.version, "rtk")
  if (!existsSync(binPath))
    return { ok: false, reason: `private rtk ${versionRes.version} is not installed at ${binPath}` }
  let st
  try {
    st = statSync(binPath)
  } catch (err) {
    return { ok: false, reason: `cannot stat ${binPath}: ${(err as Error).message}` }
  }
  if (!st.isFile() || (st.mode & 0o111) === 0) return { ok: false, reason: `${binPath} is not an executable file` }

  const record = readInstallRecord(join(root, versionRes.version))
  if (!record) return { ok: false, reason: `no install record beside ${binPath}; refusing to run an unrecorded binary` }
  const expected = parseExpectedDigest(record.rtkBinarySha256)
  if (!expected || !fileMatchesDigest(binPath, expected)) {
    return {
      ok: false,
      reason: `${binPath} does not match its install record (tamper?) — not usable until reinstalled`,
    }
  }
  return { ok: true, path: binPath }
}

/**
 * Read-only sweep for an rtk that already exists outside our private root (row-89 gate:
 * detected AND left byte-identical). Returns the candidate paths that exist; the caller
 * logs them. Nothing here opens those files for writing, hashes, moves, or deletes them —
 * stat is the entire interaction (red line 8).
 */
export function detectPreexistingRtk(candidates: readonly string[] = PREEXISTING_CANDIDATES): string[] {
  return candidates.filter((p) => existsSync(p))
}

/** Poka-yoke: the ONLY argv this step may execute against the downloaded binary. Rows
 *  97/98 own any future invocation surface; until then anything beyond `--version` — every
 *  lock never_run command included — is structurally unreachable from this module. */
export function allowedProbeArgv(binPath: string, argv: readonly string[]): boolean {
  return argv.length === 2 && argv[0] === binPath && argv[1] === PROBE_ARGV[0]
}

// --- the step module ----------------------------------------------------------------------

type Kit = ReturnType<typeof createStepKit>
type Inspection =
  | { kind: "absent" }
  | { kind: "valid"; record: RtkInstallRecord }
  | { kind: "tampered"; reason: string }

/** Read + sanity-check the install record inside a version directory. */
export function readInstallRecord(versionDir: string): RtkInstallRecord | null {
  const file = join(versionDir, MANIFEST_NAME)
  if (!existsSync(file)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const o = parsed as Record<string, unknown>
  if (o.component !== "rtk" || typeof o.version !== "string" || typeof o.rtkBinarySha256 !== "string") return null
  if (typeof o.tarballSha256 !== "string" || typeof o.observedTarballSha256 !== "string" || typeof o.url !== "string")
    return null
  if (!Array.isArray(o.paths) || !o.paths.every((p) => typeof p === "string")) return null
  return o as unknown as RtkInstallRecord
}

/** §6.3 idempotence probe: hash the BINARY against its record; the directory name proves nothing. */
function inspectInstall(root: string, version: string): Inspection {
  const versionDir = join(root, version)
  if (!existsSync(versionDir)) return { kind: "absent" }
  const record = readInstallRecord(versionDir)
  if (!record) return { kind: "tampered", reason: `install record missing or malformed in ${versionDir}` }
  if (record.version !== version)
    return { kind: "tampered", reason: `install record names version "${record.version}" inside ${version}` }
  const expected = parseExpectedDigest(record.rtkBinarySha256)
  if (!expected) return { kind: "tampered", reason: "recorded binary digest is malformed" }
  const bin = join(versionDir, "rtk")
  if (!existsSync(bin)) return { kind: "tampered", reason: `private binary absent at ${bin}` }
  if (!fileMatchesDigest(bin, expected))
    return { kind: "tampered", reason: `binary digest differs from the install record at ${bin}` }
  return { kind: "valid", record }
}

function systemTarExtract(tarballPath: string, destDir: string, timeoutMs: number): ExtractOutcome {
  // argv array, absolute system binary, no shell (P-3). NO --strip-components: the
  // archive's internal layout is not assumed (UNKNOWN until the real run — see locateRtk,
  // which resolves either a flat rtk or one top-level directory honestly).
  const r = Bun.spawnSync([TAR_TOOL, "-xzf", tarballPath, "-C", destDir], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
  })
  if (r.timedOut === true) return { ok: false, detail: `${TAR_TOOL} timed out after ${timeoutMs}ms` }
  if (r.exitCode !== 0)
    return { ok: false, detail: `${TAR_TOOL} exit ${r.exitCode}: ${asText(r.stderr).slice(0, 300)}` }
  return { ok: true, detail: "extracted" }
}

/** Locate the single `rtk` file inside an extraction tree: flat at the root, or one level
 *  down inside a top-level directory. Depth is capped at 1 deliberately — a deeper hit is
 *  an unexpected archive shape and must fail loudly, not be guessed at. */
function locateRtk(extractDir: string): string | null {
  const flat = join(extractDir, "rtk")
  if (existsSync(flat) && statSync(flat).isFile()) return flat
  for (const name of readdirSync(extractDir).sort()) {
    const sub = join(extractDir, name)
    if (!statSync(sub).isDirectory()) continue
    const nested = join(sub, "rtk")
    if (existsSync(nested) && statSync(nested).isFile()) return nested
  }
  return null
}

/**
 * Real signature gate (P-1 §6.1 step 3): codesign strict verification is FATAL on failure;
 * the Gatekeeper exec assessment is run and recorded but not fatal for a CLI binary —
 * measured on this host, `spctl -a -t exec -vv` rejects even validly signed command-line
 * tools (bun: "the code is valid but does not seem to be an app", rc=3; Homebrew rg: rc=3),
 * so gating on it would refuse every CLI artifact the design pins. Quarantine is never
 * touched here (P-2 / 01b R8): HTTPS-fetched bytes carry none, and stripping one would be
 * a user decision, not a product action.
 */
function realSignatureGate(binPath: string): SignatureGateOutcome {
  const res = macSignatureCheck(binPath)
  if (!res.codesignOk) return { ok: false, detail: `codesign --verify --deep --strict failed: ${res.detail}` }
  return { ok: true, detail: res.detail }
}

function privateRtkVersion(binPath: string, timeoutMs: number): HealthOutcome {
  const argv = [binPath, ...PROBE_ARGV]
  if (!allowedProbeArgv(binPath, argv)) return { ok: false, detail: "refused: argv outside the --version allow-list" }
  // The ONE deliberate execution of downloaded bytes in this row: the digest-verified,
  // codesign-verified private binary printing its version (blueprint gate
  // 02_structured.md:253). Absolute path, argv array, no shell, no PATH lookup.
  const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs })
  if (r.timedOut === true) return { ok: false, detail: `--version timed out after ${timeoutMs}ms` }
  if (r.exitCode !== 0) return { ok: false, detail: `--version exit ${r.exitCode}: ${asText(r.stderr).slice(0, 200)}` }
  return { ok: true, versionOutput: asText(r.stdout).trim(), detail: "ran" }
}

/** True when absPath is the tool root itself or strictly inside it (removal boundary). */
function isUnderRoot(absPath: string, root: string): boolean {
  if (!absPath.startsWith("/")) return false
  return absPath === root || absPath.startsWith(`${root}/`)
}

/** Normalize piped spawn output: bun 1.3.14 returns Buffer (Uint8Array) regardless of any
 *  encoding option (measured in node.proofs.sh P5's first real run — r87 lesson applied). */
function asText(value: string | Uint8Array): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value)
}

/** "v1.0.1" -> "1.0.1": the comparison core for the health gate. Upstream `--version`
 *  output format is UNKNOWN until the real run (02b lists install methods, not the string),
 *  so the gate asserts the pinned SEMVER appears in the trimmed output rather than pinning
 *  an unmeasured exact format; the real output is pasted in proofs P5 either way. */
function semverOf(version: string): string {
  return version.startsWith("v") ? version.slice(1) : version
}

/** Legal chain walk (dry markers or real commits — kit decides); returns the first refusal. */
function advance(
  kit: Kit,
  to: readonly StateValue[],
  patch?: Partial<ComponentState>,
): { ok: true } | { ok: false; error: string } {
  for (const state of to) {
    const res = kit.transition(state, patch)
    if (!res.ok) return res
  }
  return { ok: true }
}

async function installRtk(ctx: StepContext, opts: RtkStepOptions): Promise<StepResult> {
  const kit = createStepKit({
    componentId: COMPONENT,
    lock: ctx.lock,
    state: ctx.state,
    dryRun: ctx.dryRun,
    ...(opts.correlationId ? { correlationId: opts.correlationId } : {}),
    ...(opts.logPath ? { log: { path: opts.logPath } } : {}),
    ...(opts.consentGate ? { consentGate: opts.consentGate } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  })

  // CONSENT GATE FIRST (§11): refuse before fetch AND before any filesystem touch —
  // detection and extraction are local work but belong to the same consented install action.
  if (!kit.hasConsent()) {
    return {
      token: OUTCOME.REFUSED_NO_CONSENT,
      message: "rtk: no consent recorded; nothing fetched, nothing extracted",
    }
  }

  const resolved: ResolveResult = kit.artifact("rtk")
  if (!resolved.ok) return { token: outcomeTokenFor(resolved.code), message: resolved.message }
  const artifact = resolved.artifact
  const version = artifact.version
  if (!version) return { token: OUTCOME.FAILED, message: "rtk pin carries no version" }

  // EDITION GUARD (B3): when the lock declares the Apache-2.0 edition, the pinned url must
  // name the matching asset. An edition swap is a reviewed lock change, never a code path.
  const lockPin = ctx.lock.components[COMPONENT] ?? {}
  const editionRaw = lockPin.edition
  const edition = typeof editionRaw === "string" ? editionRaw : undefined
  if (edition === "rtk-oss" && !artifact.url.includes("rtk-oss")) {
    return {
      token: OUTCOME.FAILED,
      message: `edition guard: lock declares edition "rtk-oss" but url is ${artifact.url} — refusing the BUSL-edition artifact (B3 / decision 14)`,
    }
  }

  const root = rtkToolRoot(opts.installRoot)
  const versionDir = join(root, version)
  const binPath = join(versionDir, "rtk")

  // Read-only awareness (never an action): report what already exists OUTSIDE our root.
  const preexisting = detectPreexistingRtk(opts.preexistingCandidates)
  if (preexisting.length > 0) {
    kit.log(
      "warn",
      `pre-existing rtk detected at ${preexisting.join(", ")} — left byte-identical; it does NOT satisfy this pin (other edition)`,
      { context: { preexisting } },
    )
  }

  // --- idempotent resume (§6.3): valid install detected by BINARY digest -> zero network.
  const seen = inspectInstall(root, version)
  if (seen.kind === "valid") {
    if (ctx.dryRun) {
      kit.log("info", `would resume: valid rtk ${version} already installed at ${binPath}`)
      return {
        token: OUTCOME.OK,
        message: `dry-run: rtk ${version} already installed and digest-matches its record; nothing to do`,
      }
    }
    // Adoption commit: the lifecycle chain has no absent->healthy edge (by design, r84),
    // and this is re-discovery of a committed install, not a progression. Commit through
    // state.ts setState, the single-writer commit point (A-73-3).
    setState(kit.state, COMPONENT, {
      state: STATES.HEALTHY,
      installedBySwarm: true,
      version,
      integrity: `sha256:${seen.record.rtkBinarySha256}`,
      paths: [...seen.record.paths],
    })
    kit.log("info", `resumed: rtk ${version} binary matches its install record; zero network`, { context: { binPath } })
    return { token: OUTCOME.OK, message: `rtk ${version} already installed (binary digest matches record); resumed` }
  }

  // --- fetch through the kit (consent layer 2 + dry-run propagation live in rows 84/82) ---
  const fetchOpts: FetchOptions = {
    artifact: "rtk",
    destDir: root,
    ...(opts.provenancePath ? { provenancePath: opts.provenancePath } : {}),
  }
  const out = await kit.fetch(fetchOpts)
  if ("token" in out) return { token: out.token } // REFUSED_NO_CONSENT from the kit (belt-and-braces)
  // Success variants carry `status`, never `ok`; the failure variant carries `ok` — the
  // `in` guards split the union without any cast (r84 cycle-1 lesson applied directly).
  if ("ok" in out) {
    const token = outcomeTokenFor(out.code)
    kit.transition(token === OUTCOME.BLOCKED_BY_NETWORK ? STATES.BLOCKED_BY_NETWORK : STATES.FAILED)
    return { token, message: out.message }
  }
  const fetched = out // narrowed to fetched | resumed | dry_run
  const tarballPath = fetched.destPath

  if (ctx.dryRun) {
    // Row 82 returned dry_run/resumed WITHOUT touching disk; record the intended chain as
    // in-memory markers only. Zero filesystem writes is asserted by the unit suite.
    const chain = advance(kit, [
      STATES.DOWNLOADED,
      STATES.VERIFIED,
      STATES.INSTALLED,
      STATES.CONFIGURED,
      STATES.HEALTHY,
    ])
    if (!chain.ok) return { token: OUTCOME.FAILED, message: chain.error }
    kit.log(
      "info",
      `dry-run: would extract ${tarballPath} atomically into ${versionDir} and health-check ${binPath}; no config is written by this step`,
    )
    return { token: OUTCOME.OK, message: `dry-run: would install rtk ${version} into ${versionDir} (nothing written)` }
  }

  // The download/verify succeeded (fetched|resumed): the tarball on disk equals the pin.
  let moved = kit.transition(STATES.DOWNLOADED)
  if (!moved.ok) return { token: OUTCOME.FAILED, message: moved.error }
  moved = kit.transition(STATES.VERIFIED, { integrity: `sha256:${artifact.expected.hex}` })
  if (!moved.ok) return { token: OUTCOME.FAILED, message: moved.error }
  kit.log("info", "tarball verified against pin; extracting privately", { context: { tarballPath, versionDir } })

  // --- ATOMIC extraction (§6.2) -----------------------------------------------------------
  ensureDir(root, MODES.DIR_0700)
  const extractTmp = join(root, `.extract-${randomUUID()}`)
  const stageTmp = join(root, `.stage-${randomUUID()}`)
  mkdirSync(extractTmp, { mode: MODES.DIR_0700 })
  const extract = (
    opts.extractor ??
    ((t: string, d: string) => systemTarExtract(t, d, opts.extractTimeoutMs ?? DEFAULT_EXTRACT_TIMEOUT_MS))
  )(tarballPath, extractTmp)
  if (!extract.ok) {
    rmSync(extractTmp, { recursive: true, force: true })
    kit.transition(STATES.FAILED)
    return { token: OUTCOME.FAILED, message: `extraction failed: ${extract.detail}` }
  }
  const foundBin = locateRtk(extractTmp)
  if (!foundBin) {
    rmSync(extractTmp, { recursive: true, force: true })
    kit.transition(STATES.FAILED)
    return {
      token: OUTCOME.FAILED,
      message: `archive did not yield an rtk binary (looked for rtk/ and <dir>/rtk under ${extractTmp}) — nothing promoted`,
    }
  }

  // Flatten into the commit staging dir: <stage>/rtk is what <version>/rtk becomes.
  mkdirSync(stageTmp, { mode: MODES.DIR_0700 })
  const stagedBin = join(stageTmp, "rtk")
  try {
    renameSync(foundBin, stagedBin) // same filesystem (both temps live under root): atomic
    chmodSync(stagedBin, 0o755) // exec bit INSIDE the P-16 whitelist (P-4 permits this scope)
  } catch (err) {
    rmSync(extractTmp, { recursive: true, force: true })
    rmSync(stageTmp, { recursive: true, force: true })
    kit.transition(STATES.FAILED)
    return { token: OUTCOME.FAILED, message: `cannot stage ${foundBin}: ${(err as Error).message}` }
  }

  // --- signature verification BEFORE promotion or execution (P-1 §6.1 step 3) --------------
  const sig = (opts.signatureGate ?? realSignatureGate)(stagedBin)
  if (!sig.ok) {
    rmSync(extractTmp, { recursive: true, force: true })
    rmSync(stageTmp, { recursive: true, force: true })
    kit.transition(STATES.FAILED)
    return { token: OUTCOME.FAILED, message: `signature verification refused the artifact: ${sig.detail}` }
  }
  const binDigest = computeFileDigest(stagedBin, "sha256")

  // Commit point: quarantine-then-rename so a tampered/partial tree is replaced atomically.
  let quarantine: string | null = null
  try {
    if (existsSync(versionDir)) {
      quarantine = join(root, `.quarantine-${randomUUID()}`)
      renameSync(versionDir, quarantine) // the old bad tree stops being reachable under the committed name
    }
    renameSync(stageTmp, versionDir) // single atomic move; after THIS line the install exists
  } catch (err) {
    rmSync(extractTmp, { recursive: true, force: true })
    rmSync(stageTmp, { recursive: true, force: true })
    // Best-effort restore of a quarantined tree ONLY if the commit itself (not the
    // quarantine move) failed — otherwise the old name still holds the original content.
    if (quarantine !== null && existsSync(quarantine) && !existsSync(versionDir)) {
      try {
        renameSync(quarantine, versionDir)
      } catch {
        kit.log("error", `could not restore quarantined tree at ${quarantine}`)
      }
    }
    kit.transition(STATES.FAILED)
    return { token: OUTCOME.FAILED, message: `cannot commit ${versionDir}: ${(err as Error).message}` }
  }
  rmSync(extractTmp, { recursive: true, force: true }) // scratch is spent once the commit landed
  if (quarantine !== null) rmSync(quarantine, { recursive: true, force: true }) // delete AFTER the commit

  // --- provenance record + resolver pointer (both atomic, 0600) ----------------------------
  const paths = [versionDir, join(versionDir, MANIFEST_NAME), join(root, POINTER_NAME), tarballPath]
  const installedAt = new Date().toISOString()
  const record: RtkInstallRecord = {
    component: "rtk",
    version,
    ...(edition !== undefined ? { edition } : {}),
    url: artifact.url,
    tarballSha256: artifact.expected.hex,
    observedTarballSha256: artifact.expected.hex, // row 82 refuses promotion on any other value
    rtkBinarySha256: binDigest.hex,
    codesignDetail: sig.detail,
    installedAt,
    lockVersion: ctx.lock.version,
    paths,
  }
  atomicWriteJson(join(versionDir, MANIFEST_NAME), record, MODES.FILE_0600)
  atomicWriteJson(join(root, POINTER_NAME), { version, rtkBinarySha256: binDigest.hex, installedAt }, MODES.FILE_0600)
  appendProvenance(
    {
      ts: installedAt,
      lockVersion: ctx.lock.version,
      component: COMPONENT,
      artifact: "rtk",
      url: artifact.url,
      version,
      expected: artifact.expected.pin,
      observed: binDigest.hex,
      outcome: fetched.status === "resumed" ? "resumed" : "fetched",
      attempts: fetched.status === "fetched" ? fetched.attempts : 0,
      destPath: binPath,
    },
    opts.provenancePath,
  )

  // installedBySwarm + version + paths per D-17; integrity is OVERWRITTEN with the digest of
  // the thing that now exists on disk (the private binary), so the fresh-install and the
  // resume/adoption commits converge on one identical resting entry (§6.3 idempotence).
  moved = kit.transition(STATES.INSTALLED, {
    installedBySwarm: true,
    version,
    integrity: `sha256:${binDigest.hex}`,
    paths: [...paths],
  })
  if (!moved.ok) return { token: OUTCOME.FAILED, message: moved.error }

  // configured: per the controller no-init ruling, this step writes NO configuration. The
  // component's configuration IS its private placement (same posture as node's §12 bullet);
  // hook/skill/env wiring belongs to rows 97/98 under ~/.config/swarm (01f §8), and RTK's
  // own config store is created by RTK itself only when a human runs it (01c §6.4 D-08).
  moved = kit.transition(STATES.CONFIGURED)
  if (!moved.ok) return { token: OUTCOME.FAILED, message: moved.error }

  // --- health gate: the private binary by ABSOLUTE path prints the pinned semver ----------
  const health = (
    opts.healthRunner ?? ((b: string) => privateRtkVersion(b, opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS))
  )(binPath)
  if (!health.ok || !(health.versionOutput ?? "").includes(semverOf(version))) {
    kit.transition(STATES.FAILED)
    return {
      token: OUTCOME.HEALTH_FAILED,
      message: `private rtk --version ${health.ok ? `printed "${health.versionOutput}" without the pinned version ${version}` : `failed: ${health.detail}`} (${binPath})`,
    }
  }
  moved = kit.transition(STATES.HEALTHY)
  if (!moved.ok) return { token: OUTCOME.FAILED, message: moved.error }

  // Lock-bump hygiene: a previous swarm-installed OTHER version is now stale; drop exactly
  // its state-listed paths (same P-14 boundary as remove). Never touches unlisted dirs.
  prunePreviousInstall(kit.state.components[COMPONENT], root, version)

  kit.log("info", `rtk ${version} healthy at private path`, { context: { binPath, binarySha256: binDigest.hex } })
  return {
    token: OUTCOME.OK,
    message: `rtk ${version} installed privately at ${binPath} (PATH untouched; no config written)`,
  }
}

/** Drop the superseded swarm install's recorded paths (lock bump / replace scenario). */
function prunePreviousInstall(entry: ComponentState | undefined, root: string, keepVersion: string): void {
  if (!entry || !entry.installedBySwarm || !entry.version || entry.version === keepVersion) return
  for (const p of entry.paths ?? []) {
    if (p.includes(`/${keepVersion}/`) || p === join(root, keepVersion)) continue
    if (isUnderRoot(p, root)) rmSync(p, { recursive: true, force: true })
  }
}

function removeRtk(ctx: StepContext, opts: RtkStepOptions): StepResult {
  const kit = createStepKit({
    componentId: COMPONENT,
    lock: ctx.lock,
    state: ctx.state,
    dryRun: ctx.dryRun,
    ...(opts.correlationId ? { correlationId: opts.correlationId } : {}),
    ...(opts.logPath ? { log: { path: opts.logPath } } : {}),
    ...(opts.consentGate ? { consentGate: opts.consentGate } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  })
  const root = rtkToolRoot(opts.installRoot)
  const entry = kit.stateOf()

  // P-14: never delete what the setup did not create — including a pre-existing Homebrew
  // rtk, which lives outside this root anyway and was only ever stat'ed.
  if (!entry.installedBySwarm) {
    return {
      token: OUTCOME.SKIPPED,
      message: "rtk: not installed by swarm-setup (or already removed); nothing deleted",
    }
  }

  const listed = entry.paths ?? []
  const deletable = listed.filter((p) => isUnderRoot(p, root))
  const refused = listed.filter((p) => !isUnderRoot(p, root))

  if (ctx.dryRun) {
    kit.log("info", `dry-run remove: would delete ${deletable.length} state-listed path(s) under ${root}`, {
      context: { deletable },
    })
    return {
      token: OUTCOME.OK,
      message: `dry-run: would delete ${deletable.length} path(s) under ${root}; deleting nothing`,
    }
  }

  // Deepest paths first so directory entries do not fight their children; force:true makes
  // an already-gone path a no-op (partial removals from a crashed run converge on re-run).
  for (const p of [...deletable].sort((a, b) => b.length - a.length)) {
    rmSync(p, { recursive: true, force: true })
  }
  // Leftover step-owned temporaries (.extract-*/ .stage-*/ .quarantine-*) are ours by
  // naming; sweep ONLY those prefixes inside our root — nothing else is ever considered.
  if (existsSync(root)) {
    for (const name of readdirSync(root)) {
      if (name.startsWith(".extract-") || name.startsWith(".stage-") || name.startsWith(".quarantine-"))
        rmSync(join(root, name), { recursive: true, force: true })
    }
  }
  if (refused.length > 0)
    kit.log("warn", `refused to delete ${refused.length} state-listed path(s) outside ${root} (P-14/P-16)`, {
      context: { refused },
    })

  kit.transition(STATES.ABSENT, { installedBySwarm: false, version: undefined, integrity: undefined, paths: undefined })
  kit.log("info", `rtk removed: ${deletable.length} state-listed path(s) deleted under ${root}`)
  return {
    token: OUTCOME.OK,
    message: `rtk removed (${deletable.length} path(s) under ${root}${refused.length > 0 ? `; ${refused.length} outside-root path(s) refused` : ""})`,
  }
}

/** The shape the engine dynamically imports from src/steps/rtk/index.ts. The exported
 *  object keeps its richer (ctx, opts?) signature; the assignment below PROVES at compile
 *  time it still satisfies the plain StepModule contract the engine dispatches on. */
export const step = {
  id: COMPONENT,
  install(ctx: StepContext, opts: RtkStepOptions = {}): Promise<StepResult> {
    return installRtk(ctx, opts)
  },
  remove(ctx: StepContext, opts: RtkStepOptions = {}): StepResult {
    return removeRtk(ctx, opts)
  },
}

const _contractCheck: StepModule = step // compile-time proof only; unused by design
void _contractCheck

export default step

/** Convenience re-export so step authors/tests map raw fetch results like the engine does. */
export { stepOutcomeFromFetch }
