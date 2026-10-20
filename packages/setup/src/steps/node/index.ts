// Node.js prerequisite step (row 87; PC-CMP-02 / PC-PIN-05). Installs the pinned official
// Node tarball into a PRIVATE directory — `~/.swarm/tools/node/<version>/` — and NOTHING
// else. The decisions this file encodes, each traceable:
//
//   - PRIVATE PINNED NODE, NEVER SYSTEM PATH. The binary is invoked only by absolute path
//     through nodeBin() below (rows 88/89 handoff). This module never prepends/appends
//     PATH, never writes rc files, never installs under a system prefix (P-16 whitelist;
//     01c §12 node bullet; decisions.md). The zero-PATH-mutation guarantee is unit-tested
//     with a full env snapshot diff, not just asserted by reading code.
//   - FETCH THROUGH THE KIT ONLY. kit.fetch() (row 84) enforces consent layer 2 before any
//     socket and propagates --dry-run into row 82's own zero-write posture; row 82 enforces
//     HTTPS + host allow-list (nodejs.org is on the amended P-18 list, PC-HOST-09) + size
//     cap + sha256-before-use. The pin is node.tarball_sha256 (D-09 chose .tar.gz).
//   - ATOMIC EXTRACTION (§6.2). Extract to a same-directory temp under the install root,
//     verify the extracted binary exists, then commit with ONE rename(2) into <version>/.
//     A kill -9 at any instant leaves either no install or the complete one — never a
//     half tree. A pre-existing bad tree is quarantined by rename BEFORE the commit and
//     deleted after it, so the replace is atomic too.
//   - IDEMPOTENCE / RESUME (§6.3). A valid install is detected by hashing the private node
//     BINARY against the digest recorded in the install's own provenance file — never by
//     trusting the directory name or the state entry alone. Match => resumed, ZERO network.
//     Mismatch or missing record => tamper: replace from the verified tarball (the fetch
//     layer re-hashes the tarball itself before any use, so a tampered install can never
//     propagate — spec §6.1; tampered-mock-aborts gate, 02_structured.md:251).
//   - REMOVAL = STATE-LISTED PATHS ONLY (§7, P-14). remove deletes exactly the paths this
//     component recorded in state.json, and only paths inside its own tool dir; anything
//     else that exists is left byte-identical. A component not flagged installedBySwarm is
//     skipped, never deleted.
//   - DRY-RUN ZERO WRITES (PC-FLAG-03). Under --dry-run this step creates no directory, no
//     file, no state commit: kit.transition records in-memory markers, kit.log returns the
//     redacted line, and row 82 takes its own resume-check-only path. Proven by asserting
//     the whole throwaway HOME tree stays empty.
//
// Spawning discipline: NO node:child_process import anywhere here (row 82's gate confines
// that module to verify.ts across all of src/, fetch.proofs.sh 3c). Extraction and the
// health probe use Bun.spawnSync with argv ARRAYS and absolute-path binaries: /usr/bin/tar
// for UNPACKING (unpacking a digest-verified tarball is not executing its payload — the
// bytes written are data until the health gate runs them deliberately), and the private
// node binary for `--version` — which IS the blueprint gate ("node --version from the
// private path equals the pin", 02_structured.md:251). Never a shell, never PATH lookup,
// never curl-pipe (P-3).
//
// npm cache redirect (01d:301-303): the cache lives under ~/.swarm so later npm usage
// (row 88) never writes outside the P-16 whitelist. This step only creates the directory
// and exposes nodeChildEnv(); it does not run npm itself.

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createStepKit, outcomeTokenFor, stepOutcomeFromFetch } from "../../stepkit.ts"
import type { fetchArtifact, FetchOptions, ResolveResult } from "../../fetch.ts"
import type { StepContext, StepModule, StepResult } from "../_template/index.ts"
import { ensureDir, toolDir } from "../../paths.ts"
import { MODES, STATES, type ComponentId, type StateValue } from "../../constants.ts"
import { OUTCOME } from "../../outcomes.ts"
import { computeFileDigest, fileMatchesDigest, parseExpectedDigest } from "../../verify.ts"
import { appendProvenance } from "../../provenance.ts"
import { atomicWriteJson } from "../../atomic.ts"
import { setState, type ComponentState } from "../../state.ts"
import { loadLock, type LockFile } from "../../lockfile.ts"

const COMPONENT: ComponentId = "node"

/** Absolute-path SYSTEM unpacker. Pinned by path so no PATH lookup can substitute it. */
const TAR_TOOL = "/usr/bin/tar"

/** Install-time artifacts inside the step's own root (removed only via state-listed paths). */
const MANIFEST_NAME = ".swarm-node.json" // inside <version>/ — provenance record of the install
const POINTER_NAME = "current.json" // in the tool root — resolver hint for rows 88/89

const DEFAULT_EXTRACT_TIMEOUT_MS = 180_000 // ~50 MB gz archive
const DEFAULT_HEALTH_TIMEOUT_MS = 15_000 // `--version` prints and exits

// --- public provenance-record shape -----------------------------------------------------

/** What one completed install knows about itself. Written INSIDE the version dir so the
 *  idempotence check travels with the installation; mirrored into state.json via the
 *  paths/version/integrity patch (D-17: recorded paths == created paths). */
export interface NodeInstallRecord {
  readonly component: "node"
  readonly version: string // lock pin, e.g. "v24.22.0"
  readonly codename?: string // informational ("Krypton")
  readonly url: string // pinned artifact URL actually fetched
  readonly tarballSha256: string // lock pin (hex)
  readonly observedTarballSha256: string // == pin, enforced by row 82 before promotion
  readonly nodeBinarySha256: string // digest of <version>/bin/node AT INSTALL — the resume key
  readonly installedAt: string // ISO-8601
  readonly lockVersion: string // tools.lock.json .version
  readonly paths: readonly string[] // what removal may delete (state-listed mirror)
}

// --- seams (TEST SEAM ONLY, r82/r83/r84 narrowing discipline) ----------------------------

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

export interface NodeStepOptions {
  /** Tool root; defaults to ~/.swarm/tools/node (PC-PATH-08 via paths.toolDir). Tests point
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
   *  enforced by row 82 before this is ever called, and the post-extract bin/node check
   *  plus the health gate stay on the real path regardless of the seam. */
  readonly extractor?: (tarballPath: string, destDir: string) => ExtractOutcome
  /** TEST SEAM ONLY: replaces the `--version` spawn. Units assert the EXACT absolute bin
   *  path handed to it (resolver-path proof) instead of executing a fake binary. The real
   *  extraction proof runs the REAL runner — that invocation is the blueprint gate. */
  readonly healthRunner?: (binPath: string) => HealthOutcome
  /** TEST SEAM ONLY, forwarded verbatim to createStepKit (r84 discipline): () => false
   *  proves refusal, () => true drives the granted path. It cannot grant consent
   *  out-of-band — nothing here writes consent.log. */
  readonly consentGate?: (id: ComponentId) => boolean
  /** TEST SEAM ONLY, forwarded verbatim to createStepKit: an instrumented downloader to
   *  count network proxies or stage a fixture artifact. Defaults to the real row-82 fetch. */
  readonly fetchImpl?: typeof fetchArtifact
}

// --- resolver API for rows 88/89 ---------------------------------------------------------

export interface NodeBinResult {
  readonly ok: boolean
  /** Absolute path of the private node binary; present iff ok. */
  readonly path?: string
  /** Why unavailable (not installed / tampered / pin missing) — never a secret. */
  readonly reason?: string
}

/** Version pinned by the reviewed lock (no fallback: an absent pin is an error). */
export function nodeVersionFromLock(lock: LockFile): { ok: true; version: string } | { ok: false; error: string } {
  const pin = lock.components[COMPONENT]
  const version = pin && typeof pin.version === "string" ? pin.version : undefined
  if (!version || version.trim() === "")
    return { ok: false, error: "tools.lock.json carries no components.node.version pin" }
  return { ok: true, version }
}

/** The step's private tool root: ~/.swarm/tools/node (installRoot seam for tests). */
export function nodeToolRoot(installRoot?: string): string {
  return installRoot ?? toolDir(COMPONENT)
}

/** Where the npm cache must live (01d:301-303 redirect; row 88 passes it as npm_config_cache). */
export const npmCacheDir = (installRoot?: string): string => join(nodeToolRoot(installRoot), "npm-cache")

/**
 * THE resolver rows 88/89 call to invoke the private Node by ABSOLUTE path. Contract:
 *  - resolves the version from the lock (or an explicit override),
 *  - returns the exact path `<root>/<version>/bin/node`,
 *  - verifies presence + exec bit + recorded-digest match (tamper-aware: a binary that
 *    differs from its install record is reported NOT-USABLE, never silently used),
 *  - NEVER consults or mutates PATH — the returned path works with an empty environment.
 */
export function nodeBin(options: { lock?: LockFile; version?: string; installRoot?: string } = {}): NodeBinResult {
  const lockRes = options.lock ? ({ ok: true, lock: options.lock } as const) : loadLock()
  if (!lockRes.ok) return { ok: false, reason: `cannot load tools.lock.json: ${lockRes.error}` }
  const versionRes =
    options.version !== undefined
      ? ({ ok: true, version: options.version } as const)
      : nodeVersionFromLock(lockRes.lock)
  if (!versionRes.ok) return { ok: false, reason: versionRes.error }

  const root = nodeToolRoot(options.installRoot)
  const binPath = join(root, versionRes.version, "bin", "node")
  if (!existsSync(binPath))
    return { ok: false, reason: `private node ${versionRes.version} is not installed at ${binPath}` }
  let st
  try {
    st = statSync(binPath)
  } catch (err) {
    return { ok: false, reason: `cannot stat ${binPath}: ${(err as Error).message}` }
  }
  if (!st.isFile() || (st.mode & 0o111) === 0) return { ok: false, reason: `${binPath} is not an executable file` }

  const manifest = readInstallRecord(join(root, versionRes.version))
  if (!manifest)
    return { ok: false, reason: `no install record beside ${binPath}; refusing to run an unrecorded binary` }
  const expected = parseExpectedDigest(manifest.nodeBinarySha256)
  if (!expected || !fileMatchesDigest(binPath, expected)) {
    return {
      ok: false,
      reason: `${binPath} does not match its install record (tamper?) — not usable until reinstalled`,
    }
  }
  return { ok: true, path: binPath }
}

/**
 * Environment for children spawned with the private Node (rows 88/89): a COPY of the base
 * env with npm_config_cache redirected under ~/.swarm (01d:301-303). PATH is copied
 * verbatim — this function never mutates process.env nor any PATH value (P-16; the
 * zero-PATH-mutation unit asserts both).
 */
export function nodeChildEnv(
  base: Readonly<Record<string, string | undefined>> = process.env,
  installRoot?: string,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value
  env.npm_config_cache = npmCacheDir(installRoot)
  return env
}

// --- the step module ----------------------------------------------------------------------

type Kit = ReturnType<typeof createStepKit>
type Inspection =
  | { kind: "absent" }
  | { kind: "valid"; record: NodeInstallRecord }
  | { kind: "tampered"; reason: string }

/** Read + sanity-check the install record inside a version directory. */
export function readInstallRecord(versionDir: string): NodeInstallRecord | null {
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
  if (o.component !== "node" || typeof o.version !== "string" || typeof o.nodeBinarySha256 !== "string") return null
  if (typeof o.tarballSha256 !== "string" || typeof o.observedTarballSha256 !== "string" || typeof o.url !== "string")
    return null
  if (!Array.isArray(o.paths) || !o.paths.every((p) => typeof p === "string")) return null
  return o as unknown as NodeInstallRecord
}

/** §6.3 idempotence probe: hash the BINARY against its record; the directory name proves nothing. */
function inspectInstall(root: string, version: string): Inspection {
  const versionDir = join(root, version)
  if (!existsSync(versionDir)) return { kind: "absent" }
  const record = readInstallRecord(versionDir)
  if (!record) return { kind: "tampered", reason: `install record missing or malformed in ${versionDir}` }
  if (record.version !== version)
    return { kind: "tampered", reason: `install record names version "${record.version}" inside ${version}` }
  const expected = parseExpectedDigest(record.nodeBinarySha256)
  if (!expected) return { kind: "tampered", reason: "recorded binary digest is malformed" }
  const bin = join(versionDir, "bin", "node")
  if (!existsSync(bin)) return { kind: "tampered", reason: `private binary absent at ${bin}` }
  if (!fileMatchesDigest(bin, expected))
    return { kind: "tampered", reason: `binary digest differs from the install record at ${bin}` }
  return { kind: "valid", record }
}

function systemTarExtract(tarballPath: string, destDir: string, timeoutMs: number): ExtractOutcome {
  // argv array, absolute system binary, no shell (P-3). --strip-components removes the
  // archive's single top-level dir (node-vX-darwin-arm64/) so destDir BECOMES <version>/.
  const r = Bun.spawnSync([TAR_TOOL, "-xzf", tarballPath, "-C", destDir, "--strip-components", "1"], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
  })
  if (r.timedOut === true) return { ok: false, detail: `${TAR_TOOL} timed out after ${timeoutMs}ms` }
  if (r.exitCode !== 0)
    return { ok: false, detail: `${TAR_TOOL} exit ${r.exitCode}: ${asText(r.stderr).slice(0, 300)}` }
  return { ok: true, detail: "extracted" }
}

function privateNodeVersion(binPath: string, timeoutMs: number): HealthOutcome {
  // The ONE deliberate execution of downloaded bytes in this row: the digest-verified
  // private binary printing its version (blueprint gate 02_structured.md:251). Absolute
  // path, argv array, no shell, no PATH lookup.
  const r = Bun.spawnSync([binPath, "--version"], { stdout: "pipe", stderr: "pipe", timeout: timeoutMs })
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
 *  encoding option (measured in node.proofs.sh P5's first real run — the defect this fixes). */
function asText(value: string | Uint8Array): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value)
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

async function installNode(ctx: StepContext, opts: NodeStepOptions): Promise<StepResult> {
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
  // extraction is local work but belongs to the same consented install action.
  if (!kit.hasConsent()) {
    return {
      token: OUTCOME.REFUSED_NO_CONSENT,
      message: "node: no consent recorded; nothing fetched, nothing extracted",
    }
  }

  const resolved: ResolveResult = kit.artifact("node")
  if (!resolved.ok) return { token: outcomeTokenFor(resolved.code), message: resolved.message }
  const artifact = resolved.artifact
  const version = artifact.version
  if (!version) return { token: OUTCOME.FAILED, message: "node pin carries no version" }

  const root = nodeToolRoot(opts.installRoot)
  const versionDir = join(root, version)
  const binPath = join(versionDir, "bin", "node")
  const codenameRaw = ctx.lock.components[COMPONENT]?.codename
  const codename = typeof codenameRaw === "string" ? codenameRaw : undefined

  // --- idempotent resume (§6.3): valid install detected by BINARY digest -> zero network.
  const seen = inspectInstall(root, version)
  if (seen.kind === "valid") {
    if (ctx.dryRun) {
      kit.log("info", `would resume: valid node ${version} already installed at ${binPath}`)
      return {
        token: OUTCOME.OK,
        message: `dry-run: node ${version} already installed and digest-matches its record; nothing to do`,
      }
    }
    // Adoption commit: the lifecycle chain has no absent->healthy edge (by design, r84),
    // and this is not a progression — it is re-discovery of a committed install. Commit the
    // resting entry through state.ts setState, the single-writer commit point (A-73-3).
    setState(kit.state, COMPONENT, {
      state: STATES.HEALTHY,
      installedBySwarm: true,
      version,
      integrity: `sha256:${seen.record.nodeBinarySha256}`,
      paths: [...seen.record.paths],
    })
    kit.log("info", `resumed: node ${version} binary matches its install record; zero network`, {
      context: { binPath },
    })
    return { token: OUTCOME.OK, message: `node ${version} already installed (binary digest matches record); resumed` }
  }

  // --- fetch through the kit (consent layer 2 + dry-run propagation live in rows 84/82) ---
  const fetchOpts: FetchOptions = {
    artifact: "node",
    destDir: root,
    ...(opts.provenancePath ? { provenancePath: opts.provenancePath } : {}),
  }
  const out = await kit.fetch(fetchOpts)
  if ("token" in out) return { token: out.token } // REFUSED_NO_CONSENT from the kit (belt-and-braces)
  // Success variants carry `status`, never `ok`; the failure variant carries `ok` — so the
  // `in` guards alone split the union without any cast (r84 cycle-1 lesson applied directly).
  if ("ok" in out) {
    const token = outcomeTokenFor(out.code)
    // Mirror the failure into the lifecycle (§4.1 permits absent -> failed / BLOCKED edges).
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
    kit.log("info", `dry-run: would extract ${tarballPath} atomically into ${versionDir} and health-check ${binPath}`)
    return { token: OUTCOME.OK, message: `dry-run: would install node ${version} into ${versionDir} (nothing written)` }
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
  const stagedBin = join(extractTmp, "bin", "node")
  if (!existsSync(stagedBin) || !statSync(stagedBin).isFile()) {
    rmSync(extractTmp, { recursive: true, force: true })
    kit.transition(STATES.FAILED)
    return {
      token: OUTCOME.FAILED,
      message: `archive did not yield bin/node (expected ${stagedBin}) — nothing promoted`,
    }
  }
  chmodSync(stagedBin, 0o755) // exec bit INSIDE the P-16 whitelist (P-4 permits this scope)
  const binDigest = computeFileDigest(stagedBin, "sha256")

  // Commit point: quarantine-then-rename so a tampered/partial tree is replaced atomically.
  let quarantine: string | null = null
  try {
    if (existsSync(versionDir)) {
      quarantine = join(root, `.quarantine-${randomUUID()}`)
      renameSync(versionDir, quarantine) // the old bad tree stops being reachable under the committed name
    }
    renameSync(extractTmp, versionDir) // single atomic move; after THIS line the install exists
  } catch (err) {
    rmSync(extractTmp, { recursive: true, force: true })
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
  if (quarantine !== null) rmSync(quarantine, { recursive: true, force: true }) // delete AFTER the commit

  // --- provenance record + resolver pointer (both atomic, 0600) ----------------------------
  const npmCache = npmCacheDir(opts.installRoot)
  ensureDir(npmCache, MODES.DIR_0700) // 01d:301-303 redirect target, created once here
  const paths = [versionDir, join(versionDir, MANIFEST_NAME), join(root, POINTER_NAME), tarballPath, npmCache]
  const installedAt = new Date().toISOString()
  const record: NodeInstallRecord = {
    component: "node",
    version,
    ...(codename !== undefined ? { codename } : {}),
    url: artifact.url,
    tarballSha256: artifact.expected.hex,
    observedTarballSha256: artifact.expected.hex, // row 82 refuses promotion on any other value
    nodeBinarySha256: binDigest.hex,
    installedAt,
    lockVersion: ctx.lock.version,
    paths,
  }
  atomicWriteJson(join(versionDir, MANIFEST_NAME), record, MODES.FILE_0600)
  atomicWriteJson(join(root, POINTER_NAME), { version, nodeBinarySha256: binDigest.hex, installedAt }, MODES.FILE_0600)
  appendProvenance(
    {
      ts: installedAt,
      lockVersion: ctx.lock.version,
      component: COMPONENT,
      artifact: "node",
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

  // configured: the Node component's only configuration IS its private placement + the npm
  // cache redirect; there is no settings file to render (01c §12 node bullet).
  moved = kit.transition(STATES.CONFIGURED)
  if (!moved.ok) return { token: OUTCOME.FAILED, message: moved.error }

  // --- health gate: the private binary by ABSOLUTE path prints exactly the pinned version.
  const health = (
    opts.healthRunner ?? ((b: string) => privateNodeVersion(b, opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS))
  )(binPath)
  if (!health.ok || health.versionOutput !== version) {
    kit.transition(STATES.FAILED)
    return {
      token: OUTCOME.HEALTH_FAILED,
      message: `private node --version ${health.ok ? `printed "${health.versionOutput}" instead of ${version}` : `failed: ${health.detail}`} (${binPath})`,
    }
  }
  moved = kit.transition(STATES.HEALTHY)
  if (!moved.ok) return { token: OUTCOME.FAILED, message: moved.error }

  // Lock-bump hygiene: a previous swarm-installed OTHER version is now stale; drop exactly
  // its state-listed paths (same P-14 boundary as remove). Never touches unlisted dirs.
  prunePreviousInstall(kit.state.components[COMPONENT], root, version)

  kit.log("info", `node ${version} healthy at private path`, { context: { binPath, binarySha256: binDigest.hex } })
  return { token: OUTCOME.OK, message: `node ${version} installed privately at ${binPath} (PATH untouched)` }
}

/** Drop the superseded swarm install's recorded paths (lock bump / replace scenario). */
function prunePreviousInstall(entry: ComponentState | undefined, root: string, keepVersion: string): void {
  if (!entry || !entry.installedBySwarm || !entry.version || entry.version === keepVersion) return
  for (const p of entry.paths ?? []) {
    if (p.includes(`/${keepVersion}/`) || p === join(root, keepVersion)) continue
    if (isUnderRoot(p, root)) rmSync(p, { recursive: true, force: true })
  }
}

function removeNode(ctx: StepContext, opts: NodeStepOptions): StepResult {
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
  const root = nodeToolRoot(opts.installRoot)
  const entry = kit.stateOf()

  // P-14: never delete what the setup did not create.
  if (!entry.installedBySwarm) {
    return {
      token: OUTCOME.SKIPPED,
      message: "node: not installed by swarm-setup (or already removed); nothing deleted",
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
  // Leftover step-owned temporaries (.extract-*/ .quarantine-*) are ours by naming; sweep
  // ONLY those prefixes inside our root — nothing else is ever considered.
  if (existsSync(root)) {
    for (const name of readdirSync(root)) {
      if (name.startsWith(".extract-") || name.startsWith(".quarantine-"))
        rmSync(join(root, name), { recursive: true, force: true })
    }
  }
  if (refused.length > 0)
    kit.log("warn", `refused to delete ${refused.length} state-listed path(s) outside ${root} (P-14/P-16)`, {
      context: { refused },
    })

  kit.transition(STATES.ABSENT, { installedBySwarm: false, version: undefined, integrity: undefined, paths: undefined })
  kit.log("info", `node removed: ${deletable.length} state-listed path(s) deleted under ${root}`)
  return {
    token: OUTCOME.OK,
    message: `node removed (${deletable.length} path(s) under ${root}${refused.length > 0 ? `; ${refused.length} outside-root path(s) refused` : ""})`,
  }
}

/** The shape the engine dynamically imports from src/steps/node/index.ts. The exported
 *  object keeps its richer (ctx, opts?) signature; the assignment below PROVES at compile
 *  time it still satisfies the plain StepModule contract the engine dispatches on. */
export const step = {
  id: COMPONENT,
  install(ctx: StepContext, opts: NodeStepOptions = {}): Promise<StepResult> {
    return installNode(ctx, opts)
  },
  remove(ctx: StepContext, opts: NodeStepOptions = {}): StepResult {
    return removeNode(ctx, opts)
  },
}

const _contractCheck: StepModule = step // compile-time proof only; unused by design
void _contractCheck

export default step

/** Convenience re-export so step authors/tests map raw fetch results like the engine does. */
export { stepOutcomeFromFetch }
