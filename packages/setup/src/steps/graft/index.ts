// Graft prerequisite step (row 88; PC-CMP-03 / PC-PIN-01). Installs the ONE reviewed pin
// `@nanonets/graft@0.18.0` into a PRIVATE directory — `~/.swarm/tools/graft/<version>/` —
// using the PRIVATE Node from row 87 and its own npm, and NOTHING else. The decisions this
// file encodes, each traceable:
//
//   - INSTALL VIA NPM, BUT THE PIN IS VERIFIED FIRST BY ROW 82. The brief mandates npm as the
//     installer; it does not license bypassing the one verification implementation. So the
//     graft TARBALL is downloaded + sha512-checked against tools.lock.json by kit.fetch()
//     (consent layer 2 + HTTPS + host allow-list + size cap + digest-before-promotion), and
//     only the ALREADY-VERIFIED local tarball is handed to `npm install`. npm then resolves
//     graft's transitive dependencies from registry.npmjs.org (allow-listed) under its own
//     integrity checking. Net effect: the pinned bytes are proven against the lock before any
//     use (P-1), and the install still "goes through npm against the registry".
//   - PRIVATE PREFIX, NEVER SYSTEM PATH. npm runs with cwd = <version>/ over a minimal
//     package.json we create there, so node_modules lands INSIDE the version dir; there is no
//     `-g`, no system prefix, no rc-file write, no PATH mutation anywhere (P-16 whitelist;
//     decisions.md). The private node + its npm-cli.js are invoked by ABSOLUTE path with an
//     argv ARRAY (never a shell, never PATH lookup). The zero-PATH-mutation guarantee is
//     unit-tested with a full env snapshot diff, exactly like row 87.
//   - THE RENAMED TWIN IS STRUCTURALLY EXCLUDED (D-10). swarm installs `@nanonets/graft` and
//     nothing else. The step reads the package name FROM THE LOCK and refuses if it ever names
//     the twin; it installs the lock's own verified tarball (whose URL targets @nanonets/graft);
//     and after install it asserts the twin package is absent from the tree. It never resolves
//     any system graft binary — only its own prefix path. (The twin registers a different
//     command name, not `graft`; installing it would leave the setup calling a missing binary.)
//   - SCRIPTS IGNORED + TELEMETRY OFF (P-10 / decision 14). `--ignore-scripts` stops the
//     package's own install-time hook from running at all, and `DO_NOT_TRACK=1` is exported into
//     both the install env and the recorded runtime env for row 97's MCP wiring. The knob that
//     controls telemetry per research/02b §1 + 02c §1 is the `DO_NOT_TRACK` environment variable
//     (the tool also ships an opt-out command, but that command persists state OUTSIDE ~/.swarm,
//     so this step does NOT run it — it relies on the env knob and records it; no config file is
//     written outside the P-16 whitelist). The health gate additionally runs the read-only
//     telemetry-status subcommand to PROVE the posture reports off after install. This step never
//     runs the initializer nor the deep-analysis mode (both edit files outside the tool dir).
//   - ATOMIC COMMIT (§6.2). Install into a same-directory temp under the tool root, verify the
//     installed CLI entry exists, then commit with ONE rename(2) into <version>/. A pre-existing
//     bad tree is quarantined by rename BEFORE the commit and deleted after it.
//   - IDEMPOTENCE / RESUME (§6.3). A valid install is detected by hashing the installed CLI
//     ENTRY FILE against the digest recorded in the install's own provenance record — never by
//     trusting the directory name or the state entry alone. Match => resumed, ZERO network.
//     Mismatch or missing record => tamper: replace from the re-verified tarball.
//   - REMOVAL = STATE-LISTED PATHS ONLY (§7, P-14). remove deletes exactly the paths this
//     component recorded in state.json, and only paths inside its own tool dir. A component not
//     flagged installedBySwarm is skipped, never deleted.
//   - DRY-RUN ZERO WRITES (PC-FLAG-03). Under --dry-run this step creates no directory, no file,
//     no state commit: kit.transition records in-memory markers, kit.log returns the redacted
//     line, and row 82 takes its own resume-check-only path. Proven by asserting the whole
//     throwaway HOME tree stays empty.
//
// Spawning discipline: NO node:child_process import anywhere here (row 82's gate confines that
// module to verify.ts across all of src/). Every spawn uses Bun.spawnSync with argv ARRAYS and
// absolute-path binaries — the private node running npm-cli.js, and the private node running the
// installed dist/cli.js for `--version` and the telemetry-status probe — and normalizes piped
// output through TextDecoder (bun 1.3.14 returns Buffer regardless of any encoding option; the
// lesson row 87 recorded from its first real run). Never a shell, never PATH lookup, never a
// curl-pipe (P-3).
//
// engines floor (closes r80 finding 4): the reviewed research recorded `engines.node >= 20` on
// the 0.23.0 registry document and left the 0.18.0 floor UNVERIFIED. This step RECORDS the ACTUAL
// `engines.node` string read from the INSTALLED package.json into the install record + provenance,
// so the finding is settled from the pinned artifact itself rather than inferred from a sibling
// version. The private Node 24 satisfies whatever the floor turns out to be.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { createStepKit, outcomeTokenFor } from "../../stepkit.ts"
import type { FetchOptions, ResolveResult } from "../../fetch.ts"
import type { StepContext, StepModule, StepResult } from "../_template/index.ts"
import { ensureDir, toolDir } from "../../paths.ts"
import { MODES, STATES, type ComponentId, type StateValue } from "../../constants.ts"
import { OUTCOME } from "../../outcomes.ts"
import { computeFileDigest, fileMatchesDigest, parseExpectedDigest } from "../../verify.ts"
import { appendProvenance } from "../../provenance.ts"
import { atomicWriteJson } from "../../atomic.ts"
import { setState, type ComponentState } from "../../state.ts"
import { loadLock, type LockFile } from "../../lockfile.ts"
import { nodeBin, nodeChildEnv, type NodeBinResult } from "../node/index.ts"

const COMPONENT: ComponentId = "graft"

/** The ONLY package swarm may install (D-10). Anything else — notably the renamed twin — is refused. */
const EXPECTED_PACKAGE = "@nanonets/graft"

/** Install-time artifacts inside the step's own root (removed only via state-listed paths). */
const MANIFEST_NAME = ".swarm-graft.json" // inside <version>/ — provenance record of the install
const POINTER_NAME = "current.json" // in the tool root — resolver hint for row 97
const PROJECT_MANIFEST_NAME = "package.json" // minimal local project root so npm installs INTO <version>/

/** Where the installed CLI entry lives once npm has placed the package. */
const PKG_SUBPATH = ["node_modules", "@nanonets", "graft"] as const
const CLI_ENTRY = "dist/cli.js" // bin target declared by @nanonets/graft (registry metadata bin.graft)

/** The telemetry-off environment knob, per research/02b §1 + 02c §1. Recorded + exported, never a
 *  config file written outside the P-16 whitelist. */
const TELEMETRY_KNOB = "DO_NOT_TRACK=1"

const DEFAULT_NPM_TIMEOUT_MS = 900_000 // full dependency closure (~hundreds of MB) on first cold install
const DEFAULT_REBUILD_TIMEOUT_MS = 600_000 // offline node-gyp compile of the grammar addons
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000 // `--version` prints and exits
const DEFAULT_TELEMETRY_TIMEOUT_MS = 30_000 // read-only status subcommand

// --- public provenance-record shape -----------------------------------------------------

/** What one completed install knows about itself. Written INSIDE the version dir so the
 *  idempotence check travels with the installation; mirrored into state.json via the
 *  paths/version/integrity patch (D-17: recorded paths == created paths). */
export interface GraftInstallRecord {
  readonly component: "graft"
  readonly version: string // lock pin, e.g. "0.18.0"
  readonly pkg: string // installed package name — MUST equal EXPECTED_PACKAGE (twin guard)
  readonly url: string // pinned artifact URL actually fetched
  readonly tarballSha512: string // lock pin (hex)
  readonly observedTarballSha512: string // == pin, enforced by row 82 before promotion
  readonly cliSha256: string // digest of <version>/node_modules/@nanonets/graft/dist/cli.js — the resume key
  readonly enginesNode: string // OBSERVED engines.node from the installed package.json (closes r80 finding 4)
  readonly telemetryKnob: string // the off-switch mechanism actually used (DO_NOT_TRACK=1)
  readonly telemetryObserved: string // trimmed output of the read-only telemetry-status probe
  readonly nativeRebuilt: boolean // true when a scoped offline native rebuild was needed + performed
  readonly installedAt: string // ISO-8601
  readonly lockVersion: string // tools.lock.json .version
  readonly paths: readonly string[] // what removal may delete (state-listed mirror)
}

// --- seams (TEST SEAM ONLY, r82/r83/r84/r87 narrowing discipline) ----------------------------

export interface NpmOutcome {
  readonly ok: boolean
  /** Trimmed tail of stderr/stdout when it ran — never contains secrets (P-8 redaction upstream). */
  readonly detail: string
}

export interface HealthOutcome {
  readonly ok: boolean
  /** Trimmed stdout of `<cli> --version`, when it ran. */
  readonly versionOutput?: string
  readonly detail: string
}

export interface TelemetryOutcome {
  readonly ok: boolean
  /** True when the probe reported the off posture (off / disabled / DO_NOT_TRACK honoured). */
  readonly off: boolean
  readonly observed: string
  readonly detail: string
}

export interface GraftStepOptions {
  /** Tool root; defaults to ~/.swarm/tools/graft (PC-PATH-08 via paths.toolDir). Tests point
   *  HOME at a throwaway dir instead — the default then lands inside it. */
  readonly installRoot?: string
  /** Provenance ledger destination forwarded to kit.fetch + the install record. */
  readonly provenancePath?: string
  /** setup.log destination forwarded to the kit's redactor. */
  readonly logPath?: string
  /** Per-run correlation id stamped on log lines (global-rules correlation_id). */
  readonly correlationId?: string
  readonly npmTimeoutMs?: number
  readonly healthTimeoutMs?: number
  readonly telemetryTimeoutMs?: number
  readonly rebuildTimeoutMs?: number
  /** Native-addon build posture. graft's grammar packages (tree-sitter-kotlin et al.) ship NO
   *  darwin-arm64 prebuild and need an install-time node-gyp compile; the mandated `--ignore-scripts`
   *  suppresses that compile, so a freshly installed graft cannot load until its NATIVE addons are
   *  built. "auto" (default) runs a scoped OFFLINE `npm rebuild` — which compiles only third-party
   *  native addons and never graft's OWN telemetry hook (that stays suppressed by --ignore-scripts +
   *  DO_NOT_TRACK) — when the first --version probe fails for a missing-build reason, then re-probes.
   *  "off" keeps the strict single-command posture and lets the health gate fail closed. The choice
   *  is surfaced to security-review (row 113); "off" is the escape hatch if the rebuild is not ratified. */
  readonly nativeBuild?: "off" | "auto"
  /** TEST SEAM ONLY: replaces the row-87 resolver so units drive graft without a real private
   *  Node staged in the sandbox. It cannot weaken anything: the real proof runs the REAL resolver,
   *  and graft never falls back to a system binary regardless of the seam. */
  readonly resolveNode?: (lock: LockFile) => NodeBinResult
  /** TEST SEAM ONLY: replaces the `npm install` spawn so units drive success/failure
   *  deterministically. It cannot weaken verification: the tarball digest was already enforced by
   *  row 82 before this is ever called, and the post-install package-name + twin-absence + health
   *  gates stay on the real path regardless of the seam. */
  readonly npmRunner?: (argv: readonly string[], env: Readonly<Record<string, string>>, cwd: string) => NpmOutcome
  /** TEST SEAM ONLY: replaces the scoped native `npm rebuild` spawn (see nativeBuild). Units drive
   *  the missing-build -> rebuild -> healthy path deterministically. It cannot weaken verification:
   *  it runs only AFTER the tarball was digest-verified and only inside the committed version dir. */
  readonly rebuildRunner?: (argv: readonly string[], env: Readonly<Record<string, string>>, cwd: string) => NpmOutcome
  /** TEST SEAM ONLY: replaces the `--version` spawn. Units assert the EXACT absolute CLI path +
   *  private node path handed to it (resolver-path proof) instead of executing a fake CLI. */
  readonly healthRunner?: (cliPath: string, nodePath: string) => HealthOutcome
  /** TEST SEAM ONLY: replaces the read-only telemetry-status spawn. */
  readonly telemetryRunner?: (
    cliPath: string,
    nodePath: string,
    env: Readonly<Record<string, string>>,
  ) => TelemetryOutcome
  /** TEST SEAM ONLY, forwarded verbatim to createStepKit (r84 discipline): () => false proves
   *  refusal, () => true drives the granted path. It cannot grant consent out-of-band. */
  readonly consentGate?: (id: ComponentId) => boolean
  /** TEST SEAM ONLY, forwarded verbatim to createStepKit: an instrumented downloader. Defaults
   *  to the real row-82 fetch. */
  readonly fetchImpl?: typeof import("../../fetch.ts").fetchArtifact
}

// --- resolver API for row 97 (the config writer) ---------------------------------------

export interface GraftLaunchResult {
  readonly ok: boolean
  /** Absolute path of the private node that must run the CLI. */
  readonly nodePath?: string
  /** Absolute path of the installed dist/cli.js. */
  readonly cliPath?: string
  /** Why unavailable (not installed / tampered / pin missing) — never a secret. */
  readonly reason?: string
}

/** Version pinned by the reviewed lock (no fallback: an absent pin is an error). */
export function graftVersionFromLock(lock: LockFile): { ok: true; version: string } | { ok: false; error: string } {
  const pin = lock.components[COMPONENT]
  const version = pin && typeof pin.version === "string" ? pin.version : undefined
  if (!version || version.trim() === "")
    return { ok: false, error: "tools.lock.json carries no components.graft.version pin" }
  return { ok: true, version }
}

/** The step's private tool root: ~/.swarm/tools/graft (installRoot seam for tests). */
export function graftToolRoot(installRoot?: string): string {
  return installRoot ?? toolDir(COMPONENT)
}

/** Where graft's npm cache must live (under ~/.swarm so npm usage never writes outside P-16). */
export const graftNpmCacheDir = (installRoot?: string): string => join(graftToolRoot(installRoot), "npm-cache")

/** Absolute path of the installed CLI entry for a given version (does NOT prove existence). */
export function graftCliPath(versionDir: string): string {
  return join(versionDir, ...PKG_SUBPATH, CLI_ENTRY)
}

/**
 * THE resolver row 97 calls to invoke the private Graft by ABSOLUTE path. Contract mirrors
 * nodeBin(): resolve the version from the lock (or an override), locate <root>/<version>/…
 * /dist/cli.js, verify presence + recorded-digest match (tamper-aware), and return BOTH the
 * private node path and the CLI path — because the CLI is a JS entry run BY the private node,
 * never through a shebang that would consult PATH. NEVER consults or mutates PATH.
 */
export function graftLaunch(
  options: { lock?: LockFile; version?: string; installRoot?: string; nodeInstallRoot?: string } = {},
): GraftLaunchResult {
  const lockRes = options.lock ? ({ ok: true, lock: options.lock } as const) : loadLock()
  if (!lockRes.ok) return { ok: false, reason: `cannot load tools.lock.json: ${lockRes.error}` }
  const versionRes =
    options.version !== undefined
      ? ({ ok: true, version: options.version } as const)
      : graftVersionFromLock(lockRes.lock)
  if (!versionRes.ok) return { ok: false, reason: versionRes.error }

  // Graft-install integrity is checked FIRST (presence + recorded-digest match) so a tampered or
  // absent CLI is reported as such independently of the Node prerequisite's own state.
  const root = graftToolRoot(options.installRoot)
  const versionDir = join(root, versionRes.version)
  const cliPath = graftCliPath(versionDir)
  if (!existsSync(cliPath))
    return { ok: false, reason: `private graft ${versionRes.version} CLI is not installed at ${cliPath}` }
  let st
  try {
    st = statSync(cliPath)
  } catch (err) {
    return { ok: false, reason: `cannot stat ${cliPath}: ${(err as Error).message}` }
  }
  if (!st.isFile()) return { ok: false, reason: `${cliPath} is not a regular file` }

  const manifest = readInstallRecord(versionDir)
  if (!manifest) return { ok: false, reason: `no install record beside ${cliPath}; refusing to run an unrecorded CLI` }
  const expected = parseExpectedDigest(manifest.cliSha256)
  if (!expected || !fileMatchesDigest(cliPath, expected)) {
    return {
      ok: false,
      reason: `${cliPath} does not match its install record (tamper?) — not usable until reinstalled`,
    }
  }

  // Only once the CLI is proven intact do we resolve the private Node that must run it. A missing
  // Node is a real blocker (prerequisite), never a silent fallback to a system node.
  const node = nodeBin({
    lock: lockRes.lock,
    ...(options.nodeInstallRoot ? { installRoot: options.nodeInstallRoot } : {}),
  })
  if (!node.ok || !node.path)
    return { ok: false, reason: `private node unavailable (prerequisite of graft): ${node.reason ?? "unknown"}` }
  return { ok: true, nodePath: node.path, cliPath }
}

/**
 * Environment for children spawned to run the private Graft (row 97's MCP wiring): a COPY of the
 * base env with `DO_NOT_TRACK=1` set (telemetry off, P-10) and the npm cache redirected under
 * ~/.swarm. PATH is copied verbatim — this function never mutates process.env nor any PATH value.
 */
export function graftChildEnv(
  base: Readonly<Record<string, string | undefined>> = process.env,
  installRoot?: string,
): Record<string, string> {
  const env = nodeChildEnv(base, installRoot ? join(installRoot, "..", "node") : undefined)
  env.DO_NOT_TRACK = "1"
  return env
}

// --- the step module ----------------------------------------------------------------------

type Kit = ReturnType<typeof createStepKit>
type Inspection =
  | { kind: "absent" }
  | { kind: "valid"; record: GraftInstallRecord }
  | { kind: "tampered"; reason: string }

/** Read + sanity-check the install record inside a version directory. */
export function readInstallRecord(versionDir: string): GraftInstallRecord | null {
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
  if (o.component !== "graft" || typeof o.version !== "string" || typeof o.cliSha256 !== "string") return null
  if (typeof o.pkg !== "string" || typeof o.tarballSha512 !== "string" || typeof o.observedTarballSha512 !== "string")
    return null
  if (typeof o.url !== "string" || typeof o.enginesNode !== "string") return null
  if (!Array.isArray(o.paths) || !o.paths.every((p) => typeof p === "string")) return null
  return o as unknown as GraftInstallRecord
}

/** §6.3 idempotence probe: hash the CLI ENTRY against its record; the directory name proves nothing. */
function inspectInstall(root: string, version: string): Inspection {
  const versionDir = join(root, version)
  if (!existsSync(versionDir)) return { kind: "absent" }
  const record = readInstallRecord(versionDir)
  if (!record) return { kind: "tampered", reason: `install record missing or malformed in ${versionDir}` }
  if (record.version !== version)
    return { kind: "tampered", reason: `install record names version "${record.version}" inside ${version}` }
  if (record.pkg !== EXPECTED_PACKAGE)
    return {
      kind: "tampered",
      reason: `install record names package "${record.pkg}", not the reviewed ${EXPECTED_PACKAGE} (twin excluded)`,
    }
  const expected = parseExpectedDigest(record.cliSha256)
  if (!expected) return { kind: "tampered", reason: "recorded CLI digest is malformed" }
  const cli = graftCliPath(versionDir)
  if (!existsSync(cli)) return { kind: "tampered", reason: `installed CLI absent at ${cli}` }
  if (!fileMatchesDigest(cli, expected))
    return { kind: "tampered", reason: `CLI digest differs from the install record at ${cli}` }
  return { kind: "valid", record }
}

/** Locate the private npm-cli.js relative to the resolved private node binary. Absolute path, so
 *  npm runs without any PATH lookup and without trusting the shebang on the bin symlinks. */
export function npmCliFromNode(nodePath: string): { ok: true; path: string } | { ok: false; error: string } {
  const candidate = join(dirname(nodePath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")
  if (!existsSync(candidate))
    return { ok: false, error: `npm-cli.js not found beside the private node at ${candidate}` }
  return { ok: true, path: candidate }
}

function runNpm(
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
  cwd: string,
  timeoutMs: number,
): NpmOutcome {
  // argv array, absolute binaries (node + npm-cli.js), no shell (P-3). cwd anchors the install
  // inside <version>/ so node_modules never escapes the private prefix.
  const r = Bun.spawnSync([...argv], { cwd, env: { ...env }, stdout: "pipe", stderr: "pipe", timeout: timeoutMs })
  if (r.timedOut === true) return { ok: false, detail: `npm timed out after ${timeoutMs}ms` }
  if (r.exitCode !== 0) return { ok: false, detail: `npm exit ${r.exitCode}: ${asText(r.stderr).slice(-400)}` }
  return { ok: true, detail: asText(r.stdout).slice(-400) }
}

/** Child env for the native rebuild ONLY: like buildNpmEnv but with the private node's bin dir
 *  PREPENDED to the child PATH copy, because node-gyp / grammar install scripts invoke `node` by
 *  name via sh. This mutates a COPY handed to one subprocess; process.env and the user's PATH are
 *  never touched (the real proof asserts the parent shell environment is byte-identical). */
function buildRebuildEnv(nodePath: string, npmCache: string): Record<string, string> {
  const env = buildNpmEnv(nodePath, npmCache)
  env.PATH = `${dirname(nodePath)}:${env.PATH ?? ""}`
  return env
}

/** True when a failed --version looks like a missing native addon (node-gyp-build could not find a
 *  build for this platform) rather than a wrong version or an unrelated crash. Only this specific
 *  failure triggers the scoped rebuild; anything else is reported honestly without compiling. */
function isMissingNativeBuild(detail: string): boolean {
  return /No native build was found/i.test(detail) || /node-gyp-build/i.test(detail)
}

function runCliVersion(cliPath: string, nodePath: string, timeoutMs: number): HealthOutcome {
  // The deliberate execution of installed bytes for the blueprint gate: the digest-verified CLI
  // printing its version. Absolute paths, argv array, no shell, no PATH lookup.
  const r = Bun.spawnSync([nodePath, cliPath, "--version"], { stdout: "pipe", stderr: "pipe", timeout: timeoutMs })
  if (r.timedOut === true) return { ok: false, detail: `--version timed out after ${timeoutMs}ms` }
  if (r.exitCode !== 0) return { ok: false, detail: `--version exit ${r.exitCode}: ${asText(r.stderr).slice(0, 400)}` }
  return { ok: true, versionOutput: asText(r.stdout).trim(), detail: "ran" }
}

function runCliTelemetry(
  cliPath: string,
  nodePath: string,
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
): TelemetryOutcome {
  // Read-only status subcommand (reports the current telemetry posture; writes nothing). Run with
  // DO_NOT_TRACK present so the observed state reflects the off posture this step establishes.
  const r = Bun.spawnSync([nodePath, cliPath, "telemetry"], {
    env: { ...env },
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
  })
  const text = `${asText(r.stdout)}\n${asText(r.stderr)}`.trim()
  if (r.timedOut === true)
    return { ok: false, off: false, observed: "", detail: `telemetry probe timed out after ${timeoutMs}ms` }
  if (r.exitCode !== 0)
    return { ok: false, off: false, observed: text.slice(0, 200), detail: `telemetry probe exit ${r.exitCode}` }
  const off = /\b(off|disabled|false)\b/i.test(text) || /do_not_track/i.test(text)
  return { ok: true, off, observed: text.slice(0, 200), detail: "ran" }
}

/** True when absPath is the tool root itself or strictly inside it (removal boundary). */
function isUnderRoot(absPath: string, root: string): boolean {
  if (!absPath.startsWith("/")) return false
  return absPath === root || absPath.startsWith(`${root}/`)
}

/** Normalize piped spawn output: bun 1.3.14 returns Buffer (Uint8Array) regardless of encoding. */
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

async function installGraft(ctx: StepContext, opts: GraftStepOptions): Promise<StepResult> {
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

  // CONSENT GATE FIRST (§11): refuse before fetch AND before any filesystem touch — npm install
  // is local work but belongs to the same consented install action.
  if (!kit.hasConsent()) {
    return {
      token: OUTCOME.REFUSED_NO_CONSENT,
      message: "graft: no consent recorded; nothing fetched, nothing installed",
    }
  }

  // RENAMED-TWIN GUARD (D-10): the package name is taken FROM THE LOCK, and only the reviewed
  // package may ever be installed. A lock that names the twin (or anything else) is refused here,
  // before any fetch, so a doctored lock can never route the install to the twin.
  const lockPkgRaw = ctx.lock.components[COMPONENT]?.package
  const lockPkg = typeof lockPkgRaw === "string" ? lockPkgRaw : ""
  if (lockPkg !== EXPECTED_PACKAGE) {
    kit.log("error", "graft: lock package name is not the reviewed package; refusing (renamed twin excluded)", {
      context: { found: lockPkg },
    })
    return {
      token: OUTCOME.FAILED,
      message: `graft: tools.lock.json components.graft.package is "${lockPkg}", expected "${EXPECTED_PACKAGE}" — refusing to install any other package (D-10)`,
    }
  }

  // PREREQUISITE: the private Node from row 87, resolved by absolute path (never a system node).
  const resolveNode = opts.resolveNode ?? ((lock: LockFile) => nodeBin({ lock }))
  const node = resolveNode(ctx.lock)
  if (!node.ok || !node.path) {
    return {
      token: OUTCOME.FAILED,
      message: `graft: prerequisite private Node is unavailable (${node.reason ?? "unknown"}) — run the node step (row 87) first`,
    }
  }
  const nodePath = node.path // narrowed to string; reused in closures below
  const npmCli = npmCliFromNode(nodePath)
  if (!npmCli.ok) return { token: OUTCOME.FAILED, message: `graft: ${npmCli.error}` }

  const resolved: ResolveResult = kit.artifact("graft")
  if (!resolved.ok) return { token: outcomeTokenFor(resolved.code), message: resolved.message }
  const artifact = resolved.artifact
  const version = artifact.version
  if (!version) return { token: OUTCOME.FAILED, message: "graft pin carries no version" }
  // Belt-and-braces twin guard on the URL too: the reviewed tarball must target the reviewed scope.
  if (!artifact.url.includes(EXPECTED_PACKAGE)) {
    return {
      token: OUTCOME.FAILED,
      message: `graft: pin url does not target ${EXPECTED_PACKAGE} (${artifact.url}) — refusing (D-10)`,
    }
  }

  const root = graftToolRoot(opts.installRoot)
  const versionDir = join(root, version)
  const cliPath = graftCliPath(versionDir)

  // --- idempotent resume (§6.3): valid install detected by CLI-ENTRY digest -> zero network.
  const seen = inspectInstall(root, version)
  if (seen.kind === "valid") {
    if (ctx.dryRun) {
      kit.log("info", `would resume: valid graft ${version} already installed at ${cliPath}`)
      return {
        token: OUTCOME.OK,
        message: `dry-run: graft ${version} already installed and digest-matches its record; nothing to do`,
      }
    }
    setState(kit.state, COMPONENT, {
      state: STATES.HEALTHY,
      installedBySwarm: true,
      version,
      integrity: `sha512:${seen.record.tarballSha512}`,
      paths: [...seen.record.paths],
    })
    kit.log("info", `resumed: graft ${version} CLI matches its install record; zero network`, { context: { cliPath } })
    return { token: OUTCOME.OK, message: `graft ${version} already installed (CLI digest matches record); resumed` }
  }

  // --- fetch the PINNED TARBALL through the kit (consent layer 2 + dry-run propagation live in
  // rows 84/82). This is where the sha512-vs-lock verification happens — BEFORE npm ever sees it.
  const fetchOpts: FetchOptions = {
    artifact: "graft",
    destDir: root,
    ...(opts.provenancePath ? { provenancePath: opts.provenancePath } : {}),
  }
  const out = await kit.fetch(fetchOpts)
  if ("token" in out) return { token: out.token } // REFUSED_NO_CONSENT from the kit (belt-and-braces)
  if ("ok" in out) {
    const token = outcomeTokenFor(out.code)
    kit.transition(token === OUTCOME.BLOCKED_BY_NETWORK ? STATES.BLOCKED_BY_NETWORK : STATES.FAILED)
    return { token, message: out.message }
  }
  const fetched = out // narrowed to fetched | resumed | dry_run
  const verifiedTarball = fetched.destPath

  if (ctx.dryRun) {
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
      `dry-run: would run private npm install of ${verifiedTarball} into ${versionDir} (--ignore-scripts, DO_NOT_TRACK=1), then health-check ${cliPath}`,
    )
    return {
      token: OUTCOME.OK,
      message: `dry-run: would install graft ${version} into ${versionDir} via private npm (nothing written)`,
    }
  }

  // The download/verify succeeded (fetched|resumed): the tarball on disk equals the lock pin.
  let moved = kit.transition(STATES.DOWNLOADED)
  if (!moved.ok) return { token: OUTCOME.FAILED, message: moved.error }
  moved = kit.transition(STATES.VERIFIED, { integrity: `sha512:${artifact.expected.hex}` })
  if (!moved.ok) return { token: OUTCOME.FAILED, message: moved.error }
  kit.log("info", "graft tarball verified against pin; installing privately with the pinned Node's npm", {
    context: { verifiedTarball, versionDir },
  })

  // --- ATOMIC install (§6.2): build into a same-dir temp, verify, commit with one rename. ------
  ensureDir(root, MODES.DIR_0700)
  const installTmp = join(root, `.install-${randomUUID()}`)
  mkdirSync(installTmp, { mode: MODES.DIR_0700 })
  // Minimal local project root so npm installs node_modules INSIDE the temp, never up-tree.
  const projectManifest = join(installTmp, PROJECT_MANIFEST_NAME)
  atomicWriteJson(projectManifest, { name: "swarm-graft-install", version: "0.0.0", private: true }, MODES.FILE_0600)

  const npmCache = graftNpmCacheDir(opts.installRoot)
  ensureDir(npmCache, MODES.DIR_0700)
  const npmEnv = buildNpmEnv(nodePath, npmCache)
  const npmArgv = [
    nodePath,
    npmCli.path,
    "install",
    verifiedTarball,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--omit=dev",
  ]
  const npm = (
    opts.npmRunner ??
    ((a: readonly string[], e: Readonly<Record<string, string>>, c: string) =>
      runNpm(a, e, c, opts.npmTimeoutMs ?? DEFAULT_NPM_TIMEOUT_MS))
  )(npmArgv, npmEnv, installTmp)
  if (!npm.ok) {
    rmSync(installTmp, { recursive: true, force: true })
    kit.transition(STATES.FAILED)
    return { token: OUTCOME.FAILED, message: `private npm install failed: ${npm.detail}` }
  }

  // Post-install verification: the installed package IS the reviewed one at the pinned version,
  // the CLI entry exists, and the renamed twin is ABSENT from the tree (twin-never-resolved proof).
  const stagedPkgDir = join(installTmp, ...PKG_SUBPATH)
  const stagedCli = graftCliPath(installTmp)
  const installedMeta = readInstalledPackageMeta(stagedPkgDir)
  if (!installedMeta) {
    rmSync(installTmp, { recursive: true, force: true })
    kit.transition(STATES.FAILED)
    return {
      token: OUTCOME.FAILED,
      message: `npm did not yield an inspectable ${EXPECTED_PACKAGE}/package.json under ${stagedPkgDir} — nothing promoted`,
    }
  }
  if (installedMeta.name !== EXPECTED_PACKAGE || installedMeta.version !== version) {
    rmSync(installTmp, { recursive: true, force: true })
    kit.transition(STATES.FAILED)
    return {
      token: OUTCOME.FAILED,
      message: `installed package was ${installedMeta.name}@${installedMeta.version}, not ${EXPECTED_PACKAGE}@${version} — refusing to promote`,
    }
  }
  if (twinPresent(installTmp)) {
    rmSync(installTmp, { recursive: true, force: true })
    kit.transition(STATES.FAILED)
    return {
      token: OUTCOME.FAILED,
      message: `the renamed twin appeared in the install tree — refusing to promote (D-10)`,
    }
  }
  if (!existsSync(stagedCli) || !statSync(stagedCli).isFile()) {
    rmSync(installTmp, { recursive: true, force: true })
    kit.transition(STATES.FAILED)
    return {
      token: OUTCOME.FAILED,
      message: `install did not yield ${CLI_ENTRY} (expected ${stagedCli}) — nothing promoted`,
    }
  }
  const cliDigest = computeFileDigest(stagedCli, "sha256")

  // Commit point: quarantine-then-rename so a tampered/partial tree is replaced atomically.
  let quarantine: string | null = null
  try {
    if (existsSync(versionDir)) {
      quarantine = join(root, `.quarantine-${randomUUID()}`)
      renameSync(versionDir, quarantine) // the old bad tree stops being reachable under the committed name
    }
    renameSync(installTmp, versionDir) // single atomic move; after THIS line the install exists
  } catch (err) {
    rmSync(installTmp, { recursive: true, force: true })
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
  const committedCli = graftCliPath(versionDir)
  const paths = [versionDir, join(versionDir, MANIFEST_NAME), join(root, POINTER_NAME), verifiedTarball, npmCache]
  const installedAt = new Date().toISOString()
  const record: GraftInstallRecord = {
    component: "graft",
    version,
    pkg: installedMeta.name,
    url: artifact.url,
    tarballSha512: artifact.expected.hex,
    observedTarballSha512: artifact.expected.hex, // row 82 refuses promotion on any other value
    cliSha256: cliDigest.hex,
    enginesNode: installedMeta.enginesNode, // OBSERVED from the installed package.json (closes r80 finding 4)
    telemetryKnob: TELEMETRY_KNOB,
    telemetryObserved: "", // filled by the telemetry gate below
    nativeRebuilt: false, // flipped true below only if a native rebuild was needed + succeeded
    installedAt,
    lockVersion: ctx.lock.version,
    paths,
  }
  atomicWriteJson(join(versionDir, MANIFEST_NAME), record, MODES.FILE_0600)
  atomicWriteJson(
    join(root, POINTER_NAME),
    { version, cliSha256: cliDigest.hex, enginesNode: installedMeta.enginesNode, installedAt },
    MODES.FILE_0600,
  )
  appendProvenance(
    {
      ts: installedAt,
      lockVersion: ctx.lock.version,
      component: COMPONENT,
      artifact: "graft",
      url: artifact.url,
      version,
      expected: artifact.expected.pin,
      observed: cliDigest.hex,
      outcome: fetched.status === "resumed" ? "resumed" : "fetched",
      attempts: fetched.status === "fetched" ? fetched.attempts : 0,
      destPath: committedCli,
    },
    opts.provenancePath,
  )

  moved = kit.transition(STATES.INSTALLED, {
    installedBySwarm: true,
    version,
    integrity: `sha512:${artifact.expected.hex}`,
    paths: [...paths],
  })
  if (!moved.ok) return { token: OUTCOME.FAILED, message: moved.error }

  // configured: graft's configuration IS its private placement + the telemetry-off posture carried
  // as an ENVIRONMENT knob (DO_NOT_TRACK=1) recorded above; no settings file is written outside the
  // P-16 whitelist (the tool's own opt-out command persists state elsewhere, so it is deliberately
  // NOT run here — see the header). There is nothing else to render for the install itself.
  moved = kit.transition(STATES.CONFIGURED)
  if (!moved.ok) return { token: OUTCOME.FAILED, message: moved.error }

  // --- health gate, with an opt-outable native rebuild-if-needed: ------------------------------
  // graft's grammar packages (tree-sitter-kotlin et al.) ship no darwin-arm64 prebuild and need an
  // install-time node-gyp compile that the mandated --ignore-scripts suppresses. Probe --version; if
  // it fails for a MISSING-BUILD reason and nativeBuild is "auto", run a scoped OFFLINE `npm rebuild`
  // — which compiles only third-party native addons and never graft's own telemetry hook (that stays
  // suppressed by --ignore-scripts + DO_NOT_TRACK) — then re-probe. Any other failure is reported
  // honestly without compiling. "off" skips the rebuild and lets the gate fail closed.
  const probeHealth = (): HealthOutcome =>
    (
      opts.healthRunner ??
      ((c: string, n: string) => runCliVersion(c, n, opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS))
    )(committedCli, nodePath)
  let health = probeHealth()
  let nativeRebuilt = false
  if (
    (!health.ok || health.versionOutput !== version) &&
    (opts.nativeBuild ?? "auto") === "auto" &&
    isMissingNativeBuild(health.detail)
  ) {
    kit.log(
      "warn",
      "graft: native addon build missing under --ignore-scripts; running a scoped offline npm rebuild (graft's own scripts stay ignored)",
      { context: { reason: health.detail.slice(0, 200) } },
    )
    const rebuildArgv = [nodePath, npmCli.path, "rebuild"]
    const rebuild = (
      opts.rebuildRunner ??
      ((a: readonly string[], e: Readonly<Record<string, string>>, c: string) =>
        runNpm(a, e, c, opts.rebuildTimeoutMs ?? DEFAULT_REBUILD_TIMEOUT_MS))
    )(rebuildArgv, buildRebuildEnv(nodePath, npmCache), versionDir)
    if (!rebuild.ok) {
      kit.transition(STATES.FAILED)
      return {
        token: OUTCOME.HEALTH_FAILED,
        message: `graft native rebuild failed (third-party addons could not compile): ${rebuild.detail}`,
      }
    }
    nativeRebuilt = true
    health = probeHealth() // re-probe now that the third-party addons are built
  }
  if (!health.ok || health.versionOutput !== version) {
    kit.transition(STATES.FAILED)
    return {
      token: OUTCOME.HEALTH_FAILED,
      message: `graft --version ${health.ok ? `printed "${health.versionOutput}" instead of ${version}` : `failed: ${health.detail}`} (${committedCli})${nativeRebuilt ? " [after native rebuild]" : ""}`,
    }
  }

  // --- telemetry-off gate (blueprint check "telemetry check reports off after install"): --------
  // read-only status probe run with DO_NOT_TRACK present; records what it reported into the record.
  const telemetryEnv = { ...npmEnv, DO_NOT_TRACK: "1" }
  const telemetry = (
    opts.telemetryRunner ??
    ((c: string, n: string, e: Readonly<Record<string, string>>) =>
      runCliTelemetry(c, n, e, opts.telemetryTimeoutMs ?? DEFAULT_TELEMETRY_TIMEOUT_MS))
  )(committedCli, nodePath, telemetryEnv)
  finalizeRecord(join(versionDir, MANIFEST_NAME), record, { telemetryObserved: telemetry.observed, nativeRebuilt })
  if (!telemetry.off) {
    kit.transition(STATES.FAILED)
    return {
      token: OUTCOME.HEALTH_FAILED,
      message: `graft telemetry did not report the off posture after install (observed: "${telemetry.observed}") — refusing to mark healthy (P-10)`,
    }
  }

  moved = kit.transition(STATES.HEALTHY)
  if (!moved.ok) return { token: OUTCOME.FAILED, message: moved.error }

  prunePreviousInstall(kit.state.components[COMPONENT], root, version)

  kit.log(
    "info",
    `graft ${version} healthy at private path; telemetry off (${TELEMETRY_KNOB})${nativeRebuilt ? "; third-party native addons rebuilt" : ""}`,
    {
      context: {
        cliPath: committedCli,
        cliSha256: cliDigest.hex,
        enginesNode: installedMeta.enginesNode,
        nativeRebuilt,
      },
    },
  )
  return {
    token: OUTCOME.OK,
    message: `graft ${version} installed privately at ${committedCli} via npm (PATH untouched; engines.node=${installedMeta.enginesNode}; telemetry off${nativeRebuilt ? "; native addons rebuilt offline" : ""})`,
  }
}

/** Build the npm child env: private-node cache redirect + graft-scoped cache + telemetry off.
 *  PATH is copied verbatim (never mutated); every writable target lands under ~/.swarm. */
function buildNpmEnv(nodePath: string, npmCache: string): Record<string, string> {
  void nodePath // documented for the reader: npm is invoked BY this node, so its cache/prefix follow it
  const env = nodeChildEnv(process.env)
  env.npm_config_cache = npmCache // graft-scoped cache, inside the P-16 whitelist
  env.npm_config_audit = "false"
  env.npm_config_fund = "false"
  env.npm_config_update_notifier = "false"
  env.DO_NOT_TRACK = "1" // telemetry off during install (also blocks the ignored postinstall anyway)
  return env
}

/** Read {name, version, engines.node} from an installed package directory. Null if unreadable. */
function readInstalledPackageMeta(pkgDir: string): { name: string; version: string; enginesNode: string } | null {
  const file = join(pkgDir, "package.json")
  if (!existsSync(file)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const o = parsed as Record<string, unknown>
  const name = typeof o.name === "string" ? o.name : ""
  const version = typeof o.version === "string" ? o.version : ""
  const engines =
    o.engines && typeof o.engines === "object" && !Array.isArray(o.engines)
      ? (o.engines as Record<string, unknown>)
      : {}
  const enginesNode = typeof engines.node === "string" ? engines.node : "(none)"
  return { name, version, enginesNode }
}

/** True when the renamed twin package appears anywhere in the install tree's top-level scopes. */
function twinPresent(installRoot: string): boolean {
  // The twin lives under a different npm scope (@trailhq/trail-code). Check that scope explicitly;
  // a well-behaved install of @nanonets/graft never pulls it (it is a separate product, not a dep).
  const trailScope = join(installRoot, "node_modules", "@trailhq")
  if (existsSync(join(trailScope, "trail-code"))) return true
  return false
}

/** Persist the post-gate facts (telemetry observation + whether a native rebuild ran) back into the
 *  committed record (best-effort, atomic). The record already exists from the commit point; this only
 *  fills the two fields that are only known after the health + telemetry gates have run. */
function finalizeRecord(
  manifestPath: string,
  record: GraftInstallRecord,
  patch: { telemetryObserved: string; nativeRebuilt: boolean },
): void {
  try {
    atomicWriteJson(manifestPath, { ...record, ...patch }, MODES.FILE_0600)
  } catch {
    // Non-fatal: the record already exists without these two fields; the ledger still carries the
    // install fact. Surfaced via the returned message on any later failure path.
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

function removeGraft(ctx: StepContext, opts: GraftStepOptions): StepResult {
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
  const root = graftToolRoot(opts.installRoot)
  const entry = kit.stateOf()

  // P-14: never delete what the setup did not create.
  if (!entry.installedBySwarm) {
    return {
      token: OUTCOME.SKIPPED,
      message: "graft: not installed by swarm-setup (or already removed); nothing deleted",
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

  for (const p of [...deletable].sort((a, b) => b.length - a.length)) {
    rmSync(p, { recursive: true, force: true })
  }
  // Leftover step-owned temporaries (.install-*/ .quarantine-*) are ours by naming; sweep ONLY
  // those prefixes inside our root — nothing else is ever considered.
  if (existsSync(root)) {
    for (const name of readdirSync(root)) {
      if (name.startsWith(".install-") || name.startsWith(".quarantine-"))
        rmSync(join(root, name), { recursive: true, force: true })
    }
  }
  if (refused.length > 0)
    kit.log("warn", `refused to delete ${refused.length} state-listed path(s) outside ${root} (P-14/P-16)`, {
      context: { refused },
    })

  kit.transition(STATES.ABSENT, { installedBySwarm: false, version: undefined, integrity: undefined, paths: undefined })
  kit.log("info", `graft removed: ${deletable.length} state-listed path(s) deleted under ${root}`)
  return {
    token: OUTCOME.OK,
    message: `graft removed (${deletable.length} path(s) under ${root}${refused.length > 0 ? `; ${refused.length} outside-root path(s) refused` : ""})`,
  }
}

/** The shape the engine dynamically imports from src/steps/graft/index.ts. The exported object
 *  keeps its richer (ctx, opts?) signature; the assignment below PROVES at compile time it still
 *  satisfies the plain StepModule contract the engine dispatches on. */
export const step = {
  id: COMPONENT,
  install(ctx: StepContext, opts: GraftStepOptions = {}): Promise<StepResult> {
    return installGraft(ctx, opts)
  },
  remove(ctx: StepContext, opts: GraftStepOptions = {}): StepResult {
    return removeGraft(ctx, opts)
  },
}

const _contractCheck: StepModule = step // compile-time proof only; unused by design
void _contractCheck

export default step
