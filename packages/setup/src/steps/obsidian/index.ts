// Obsidian guide-and-detect step (row 90; PC-CMP-05 / PC-PIN-03). L14 (research/03f_legal_addendum.md §3)
// freezes the conservative pattern: Obsidian is proprietary, licensed per-user, never redistributed by
// PT GSP — so this step GUIDES (row 83's consent screen already links the official dmg URL + terms, P-12)
// and DETECTS (a pre-existing /Applications/Obsidian.app is reported and NEVER touched). The controller
// brief turns the blueprint's "install under the user Applications folder if absent" into the
// detect+stage compromise: when nothing is detected, the pinned dmg is fetched on the user's own machine
// (consent-gated), mounted read-only, signature-gated, and the app is STAGED into user space at
// ~/.swarm/tools/obsidian/<version>/Obsidian.app — a full /Applications install stays user-driven.
// The decisions this file encodes, each traceable:
//
//   - DETECT FIRST, READ-ONLY (§L14). detectExistingInstall() stats /Applications/Obsidian.app and runs a
//     NAME-based mdfind query (kMDItemFSName == 'Obsidian.app'; the bundle id is not sourced in the project
//     research, so none is asserted). A found app is reported and left byte-untouched; the component goes
//     `skipped`, never `installedBySwarm` — remove cannot sweep what this step did not create (P-14).
//   - FETCH THROUGH THE KIT ONLY. kit.fetch() enforces consent layer 2 before any socket and propagates
//     --dry-run; row 82 enforces HTTPS + github.com allow-list (amended P-18) + the 233,704,463-byte size
//     cap + dmg_sha256-before-promotion (PC-PIN-03; U-1: the Homebrew cask value, the best independent sum
//     — tools.lock.json records the caveat). A tampered dmg therefore aborts BEFORE any mount (blueprint
//     gate, 02_structured.md:254): mount is only ever reached with digest-verified bytes on disk.
//   - SIGNATURE GATE ON THE MOUNTED APP — THE U-2 CLOSER. verify.ts (row 82) owns codesign/spctl/TeamID;
//     this step CONSUMES macSignatureCheck over the mounted Obsidian.app (a dmg is not a signed bundle, so
//     the gate runs after hdiutil attach, exactly where 02d:122-128 says the closer lives). The lock ships
//     team_id: null (no official publication exists — quoting a value would be fabrication); with a null
//     pin the gate requires codesign+spctl PASS and RECORDS whatever TeamIdentifier prints, honestly, as
//     the first observed value. Once a confirmed team_id exists in a future lock, a mismatch fails closed.
//     The observed value lands in the install record, the provenance ledger, the resolver pointer and
//     setup.log — NOT back into the shipped lock (0444, single writer, row 80).
//   - ALWAYS UNMOUNT (trap-safe). The mount is opened inside try/finally: every exit path — signature
//     refusal, copy failure, commit failure, success — detaches before returning. A detach failure is
//     logged loudly (warn) but never masks the primary outcome.
//   - USER-SPACE STAGING, ATOMIC (§6.2). ditto copies the mounted app into a same-volume temp
//     .stage-<uuid>/ under the tool root; the staged binary's digest must equal the mounted source's
//     (copy-fidelity proof); then ONE rename(2) commits it as <version>/. A pre-existing tampered tree is
//     quarantined first and deleted after the commit. Nothing is ever written to /Applications.
//   - VAULT NEVER CREATED HERE. The Swarm vault (~/.swarm/vault/, PC-PATH-13) is row 95's; this step
//     neither creates, reads, nor references it as a write target (unit-asserted: the vault path stays
//     absent through the full cycle). App data (~/Library/Application Support/obsidian/) is created by
//     Obsidian itself on first launch (D-08) — this step never launches the app.
//   - IDEMPotence / RESUME (§6.3). A prior staged install is validated by hashing the STAGED BINARY
//     (Contents/MacOS/Obsidian) against the digest in its own install record — never by trusting the
//     directory name. Match => resumed, ZERO network, ZERO mounts. Mismatch => replaced from the
//     re-verified dmg.
//   - REMOVAL = STATE-LISTED PATHS ONLY (§7, P-14). Same boundary as row 87: delete exactly the recorded
//     paths inside this component's tool dir; refuse outside-root listings; a detected (user-installed)
//     Obsidian is never removed. Step-owned temporaries (.stage-*/.quarantine-* under the root, .mnt-*
//     mountpoints under ~/.swarm/tmp) are swept by naming — a still-mounted .mnt-* dir is left in place
//     with a warn rather than recursively deleted.
//   - DRY-RUN ZERO WRITES (PC-FLAG-03). Detection is read-only and still runs (it proves facts); staging
//     becomes in-memory markers only: no mkdir, no mount, no copy, no state commit (unit-proved against
//     an empty throwaway HOME tree).
//
// Spawning discipline (r87 precedent, fetch.proofs.sh 3c): NO node:child_process import here — system
// tools run through Bun.spawnSync with argv ARRAYS and absolute-path binaries: /usr/bin/hdiutil (attach
// -nobrowse -readonly -mountpoint / detach) and /usr/bin/ditto (app-bundle copy preserving metadata).
// Inspecting and copying are not executing: the app's own bytes are never run. TEST SEAMS (narrowing
// discipline r82/83/84): detector/mounter/unmounter/copier/signatureRun replace the real probes and
// spawns so units drive the full cycle against a fake-hdiutil shim; none can weaken verification (the
// digest gate ran before mount, the signature gate runs regardless of seam, unmount is unconditional).

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createStepKit, outcomeTokenFor, stepOutcomeFromFetch } from "../../stepkit.ts"
import type { fetchArtifact, FetchOptions, ResolvedArtifact, ResolveResult } from "../../fetch.ts"
import type { StepContext, StepModule, StepResult } from "../_template/index.ts"
import { ensureDir, tmpDir, toolDir } from "../../paths.ts"
import { MODES, STATES, type ComponentId, type StateValue } from "../../constants.ts"
import { OUTCOME } from "../../outcomes.ts"
import {
  computeFileDigest,
  fileMatchesDigest,
  macSignatureCheck,
  parseExpectedDigest,
  type SignatureOutcome,
} from "../../verify.ts"
import { appendProvenance, type ProvenanceRecord } from "../../provenance.ts"
import { atomicWriteJson } from "../../atomic.ts"
import { setState, type ComponentState } from "../../state.ts"
import { loadLock, type LockFile } from "../../lockfile.ts"

const COMPONENT: ComponentId = "obsidian"

/** Absolute-path SYSTEM tools, pinned by path so no PATH lookup can substitute them. */
const HDIUTIL_TOOL = "/usr/bin/hdiutil"
const DITTO_TOOL = "/usr/bin/ditto"
const MDFIND_TOOL = "/usr/bin/mdfind"

/** The canonical user-facing install location — READ-ONLY for this step (detect only, never written). */
const APPLICATIONS_DIR = "/Applications"
const APP_NAME = "Obsidian.app"
/** Relative path of the app's main executable inside the bundle (the resume/tamper key). */
const BINARY_REL = ["Contents", "MacOS", "Obsidian"] as const

const MANIFEST_NAME = ".swarm-obsidian.json" // inside <version>/ — provenance record of the staging
const POINTER_NAME = "current.json" // in the tool root — resolver hint for rows 95/97

const DEFAULT_MOUNT_TIMEOUT_MS = 120_000 // UDZO attach of a ~233 MB dmg is seconds; bounded generously
const DEFAULT_COPY_TIMEOUT_MS = 600_000 // ditto of a few-hundred-MB Electron bundle
const DEFAULT_UNMOUNT_TIMEOUT_MS = 60_000
const DETECT_TIMEOUT_MS = 15_000 // mdfind answers fast or Spotlight is off

// --- public record shapes -----------------------------------------------------------------

/** What one completed staging knows about itself. Written INSIDE the version dir so the
 *  idempotence check travels with the installation; mirrored into state.json via the
 *  paths/version/integrity patch (D-17: recorded paths == created paths). */
export interface ObsidianInstallRecord {
  readonly component: "obsidian"
  readonly version: string // lock pin, e.g. "v1.14.4"
  readonly url: string // pinned artifact URL actually fetched
  readonly dmgSha256: string // lock pin (hex)
  readonly observedDmgSha256: string // == pin, enforced by row 82 before promotion
  /** U-2 CLOSER: whatever `codesign -dvvv` printed on the mounted app. null means the command
   *  printed no TeamIdentifier — recorded honestly as absence, never guessed. */
  readonly observedTeamIdentifier: string | null
  readonly signatureDetail: string // the gate's own detail line (audit)
  readonly mountedBinarySha256: string // digest of the binary ON THE MOUNTED volume
  readonly appBinarySha256: string // digest of the STAGED binary — must equal the above
  readonly installedAt: string // ISO-8601
  readonly lockVersion: string // tools.lock.json .version
  readonly placement: "user-space-staged" // L14 compromise; a /Applications install stays user-driven
  readonly applicationsTouched: false // this step never writes /Applications (unit + grep gates)
  readonly paths: readonly string[] // what removal may delete (state-listed mirror)
}

export interface ObsidianDetection {
  readonly found: boolean
  /** Absolute .app paths observed (read-only probes only; nothing here is ever opened for write). */
  readonly paths: readonly string[]
  /** Which probes contributed, e.g. ["stat:/Applications/Obsidian.app", "mdfind:..."]. */
  readonly methods: readonly string[]
}

export interface MountOutcome {
  readonly ok: boolean
  readonly detail: string
}
export interface UnmountOutcome {
  readonly ok: boolean
  readonly detail: string
}
export interface CopyOutcome {
  readonly ok: boolean
  readonly detail: string
}

export interface ObsidianStepOptions {
  /** Tool root; defaults to ~/.swarm/tools/obsidian (PC-PATH-08 via paths.toolDir). Tests point
   *  HOME at a throwaway dir instead — the default then lands inside it. */
  readonly installRoot?: string
  readonly provenancePath?: string
  readonly logPath?: string
  readonly correlationId?: string
  /** Forwarded to row 82's FetchOptions.timeoutMs (whole-operation download budget). The dmg is
   *  ~233 MB — the real-staging proof raises this deliberately; units keep the library default. */
  readonly fetchTimeoutMs?: number
  readonly mountTimeoutMs?: number
  readonly copyTimeoutMs?: number
  readonly unmountTimeoutMs?: number
  /** TEST SEAM ONLY: replaces the read-only host probe (units script present/absent). */
  readonly detector?: () => ObsidianDetection
  /** TEST SEAM ONLY: replaces `hdiutil attach`. The fake builds a realistic mini .app tree at the
   *  mountpoint so the DOWNSTREAM logic (locate app, signature gate, copy, digest compare) runs real. */
  readonly mounter?: (dmgPath: string, mountPoint: string) => MountOutcome
  /** TEST SEAM ONLY: replaces `hdiutil detach`. Units count calls — the unmount-on-failure trap is
   *  proved by asserting the counter reaches 1 on EVERY exit path. */
  readonly unmounter?: (mountPoint: string) => UnmountOutcome
  /** TEST SEAM ONLY: replaces the ditto copy. Default copier is REAL ditto even in units (the fake
   *  mounted tree is real files, so the copy path itself is never mocked away). */
  readonly copier?: (appSrc: string, appDest: string) => CopyOutcome
  /** TEST SEAM ONLY: forwarded verbatim into verify.ts's SignatureSpec.run — the ONE sanctioned way
   *  to script codesign/spctl outcomes (r82 shipped it). It cannot weaken the real gate. */
  readonly signatureRun?: (absPath: string) => SignatureOutcome
  /** TEST SEAM ONLY, forwarded verbatim to createStepKit (r84 discipline). */
  readonly consentGate?: (id: ComponentId) => boolean
  /** TEST SEAM ONLY, forwarded verbatim to createStepKit: instrumented downloader / fixture delivery. */
  readonly fetchImpl?: typeof fetchArtifact
}

// --- resolver API for rows 95/97 ------------------------------------------------------------

export interface StagedAppResult {
  readonly ok: boolean
  /** Absolute path of the staged Obsidian.app; present iff ok. */
  readonly path?: string
  readonly reason?: string
}

/** The step's private tool root: ~/.swarm/tools/obsidian (installRoot seam for tests). */
export function obsidianToolRoot(installRoot?: string): string {
  return installRoot ?? toolDir(COMPONENT)
}

/** Version pinned by the reviewed lock (no fallback: an absent pin is an error). */
export function obsidianVersionFromLock(lock: LockFile): { ok: true; version: string } | { ok: false; error: string } {
  const pin = lock.components[COMPONENT]
  const version = pin && typeof pin.version === "string" ? pin.version : undefined
  if (!version || version.trim() === "")
    return { ok: false, error: "tools.lock.json carries no components.obsidian.version pin" }
  return { ok: true, version }
}

/** Confirmed TeamID pin from the lock, or undefined while team_id is null (U-2 open). */
export function lockedTeamId(lock: LockFile): string | undefined {
  const raw = lock.components[COMPONENT]?.team_id
  return typeof raw === "string" && raw.trim() !== "" ? raw : undefined
}

/**
 * THE resolver rows 95/97 call to locate the staged app by ABSOLUTE path. Contract mirrors
 * nodeBin(): presence + install-record match (tamper-aware) — never a /Applications fallback,
 * never a launch. The returned path is data for vault/MCP wiring, nothing executed here.
 */
export function stagedAppPath(
  options: { lock?: LockFile; version?: string; installRoot?: string } = {},
): StagedAppResult {
  const lockRes = options.lock ? ({ ok: true, lock: options.lock } as const) : loadLock()
  if (!lockRes.ok) return { ok: false, reason: `cannot load tools.lock.json: ${lockRes.error}` }
  const versionRes =
    options.version !== undefined
      ? ({ ok: true, version: options.version } as const)
      : obsidianVersionFromLock(lockRes.lock)
  if (!versionRes.ok) return { ok: false, reason: versionRes.error }

  const seen = inspectStaged(obsidianToolRoot(options.installRoot), versionRes.version)
  if (seen.kind === "absent")
    return {
      ok: false,
      reason: `staged obsidian ${versionRes.version} is not present under ${obsidianToolRoot(options.installRoot)}`,
    }
  if (seen.kind === "tampered") return { ok: false, reason: `staged obsidian ${versionRes.version}: ${seen.reason}` }
  return { ok: true, path: join(obsidianToolRoot(options.installRoot), versionRes.version, APP_NAME) }
}

// --- read-only host detection ---------------------------------------------------------------

/**
 * Read-only probe for a user-managed Obsidian anywhere on this Mac. Layer 1: the canonical
 * /Applications/Obsidian.app via stat. Layer 2: a NAME-based Spotlight query (no bundle id is
 * asserted — none is sourced in the project research; a wrong guess there would only ever cause a
 * miss, and stat covers the canonical location anyway). Trash copies are filtered out. An
 * unavailable Spotlight (nonzero exit / timeout) contributes nothing — the probe degrades to
 * layer 1 rather than failing the step. NOTHING here opens a file inside any found bundle.
 */
export function detectExistingInstall(): ObsidianDetection {
  const paths: string[] = []
  const methods: string[] = []
  const canonical = join(APPLICATIONS_DIR, APP_NAME)
  if (existsSync(canonical)) {
    paths.push(canonical)
    methods.push(`stat:${canonical}`)
  }
  const query = "kMDItemFSName == 'Obsidian.app'"
  const r = Bun.spawnSync([MDFIND_TOOL, query], { stdout: "pipe", stderr: "pipe", timeout: DETECT_TIMEOUT_MS })
  if (r.exitCode === 0) {
    const hits = asText(r.stdout)
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line) =>
          line !== "" &&
          line.endsWith(".app") &&
          !line.includes("/.Trash/") &&
          !line.startsWith(join(toolDir(COMPONENT), "/")),
      )
      .filter((line) => !paths.includes(line))
    paths.push(...hits)
    methods.push(`mdfind:${query}`)
  } else {
    methods.push(`mdfind:unavailable(exit ${r.exitCode ?? "spawn-failed"})`)
  }
  return { found: paths.length > 0, paths, methods }
}

// --- the step module --------------------------------------------------------------------------

type Kit = ReturnType<typeof createStepKit>
type Inspection =
  | { kind: "absent" }
  | { kind: "valid"; record: ObsidianInstallRecord }
  | { kind: "tampered"; reason: string }

/** Read + sanity-check the install record inside a version directory. */
export function readInstallRecord(versionDir: string): ObsidianInstallRecord | null {
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
  if (o.component !== "obsidian" || typeof o.version !== "string" || typeof o.appBinarySha256 !== "string") return null
  if (typeof o.dmgSha256 !== "string" || typeof o.observedDmgSha256 !== "string" || typeof o.url !== "string")
    return null
  if (typeof o.signatureDetail !== "string" || typeof o.mountedBinarySha256 !== "string") return null
  if (o.observedTeamIdentifier !== null && typeof o.observedTeamIdentifier !== "string") return null
  if (!Array.isArray(o.paths) || !o.paths.every((p) => typeof p === "string")) return null
  return o as unknown as ObsidianInstallRecord
}

function stagedBinaryPath(versionDir: string): string {
  return join(versionDir, APP_NAME, ...BINARY_REL)
}

/** §6.3 idempotence probe: hash the STAGED BINARY against its record; the directory name proves nothing. */
function inspectStaged(root: string, version: string): Inspection {
  const versionDir = join(root, version)
  if (!existsSync(versionDir)) return { kind: "absent" }
  const record = readInstallRecord(versionDir)
  if (!record) return { kind: "tampered", reason: `install record missing or malformed in ${versionDir}` }
  if (record.version !== version)
    return { kind: "tampered", reason: `install record names version "${record.version}" inside ${version}` }
  const expected = parseExpectedDigest(record.appBinarySha256)
  if (!expected) return { kind: "tampered", reason: "recorded binary digest is malformed" }
  const bin = stagedBinaryPath(versionDir)
  if (!existsSync(bin)) return { kind: "tampered", reason: `staged binary absent at ${bin}` }
  if (!fileMatchesDigest(bin, expected))
    return { kind: "tampered", reason: `staged binary digest differs from the install record at ${bin}` }
  return { kind: "valid", record }
}

// --- real system-tool implementations (seams above replace these in units) --------------------

function asText(value: string | Uint8Array): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value)
}

function realMount(dmgPath: string, mountPoint: string, timeoutMs: number): MountOutcome {
  // -readonly: the dmg is never mutated; -nobrowse: no Finder/volumes clutter; -mountpoint: a PRIVATE
  // mountpoint under ~/.swarm/tmp so a user's own /Volumes/Obsidian (or another dmg of the same name)
  // can never collide with or shadow what we then copy.
  const r = Bun.spawnSync([HDIUTIL_TOOL, "attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, dmgPath], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
  })
  if (r.timedOut === true) return { ok: false, detail: `${HDIUTIL_TOOL} attach timed out after ${timeoutMs}ms` }
  if (r.exitCode !== 0)
    return {
      ok: false,
      detail: `${HDIUTIL_TOOL} attach exit ${r.exitCode ?? "spawn-failed"}: ${asText(r.stderr).slice(0, 300)}`,
    }
  return { ok: true, detail: "attached" }
}

function realUnmount(mountPoint: string, timeoutMs: number): UnmountOutcome {
  const r = Bun.spawnSync([HDIUTIL_TOOL, "detach", mountPoint], { stdout: "pipe", stderr: "pipe", timeout: timeoutMs })
  if (r.timedOut === true) return { ok: false, detail: `${HDIUTIL_TOOL} detach timed out after ${timeoutMs}ms` }
  if (r.exitCode !== 0)
    return {
      ok: false,
      detail: `${HDIUTIL_TOOL} detach exit ${r.exitCode ?? "spawn-failed"}: ${asText(r.stderr).slice(0, 300)}`,
    }
  return { ok: true, detail: "detached" }
}

function realCopy(appSrc: string, appDest: string, timeoutMs: number): CopyOutcome {
  // ditto is Apple's app-bundle copier: preserves symlinks, modes, metadata (a plain recursive
  // copy would flatten the bundle's structure the code signature depends on).
  const r = Bun.spawnSync([DITTO_TOOL, appSrc, appDest], { stdout: "pipe", stderr: "pipe", timeout: timeoutMs })
  if (r.timedOut === true) return { ok: false, detail: `${DITTO_TOOL} timed out after ${timeoutMs}ms` }
  if (r.exitCode !== 0)
    return {
      ok: false,
      detail: `${DITTO_TOOL} exit ${r.exitCode ?? "spawn-failed"}: ${asText(r.stderr).slice(0, 300)}`,
    }
  return { ok: true, detail: "copied" }
}

// --- provenance extension (append-only; core provenance.ts untouched) -------------------------

/** One lifecycle ledger row. Extends the frozen ProvenanceRecord with the fields THIS component's
 *  audit story needs (U-2 observation + which stage wrote the row); structural typing keeps it a
 *  valid ledger line without editing row 81's module. */
interface ObsidianProvenanceLine extends ProvenanceRecord {
  readonly observedTeamIdentifier?: string | null
  readonly signatureDetail?: string
  readonly stage?: "mount" | "signature" | "copy" | "commit" | "staged"
}

/** True when absPath is the tool root itself or strictly inside it (removal boundary). */
function isUnderRoot(absPath: string, root: string): boolean {
  if (!absPath.startsWith("/")) return false
  return absPath === root || absPath.startsWith(`${root}/`)
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

function lifecycleLine(
  ctx: StepContext,
  artifact: ResolvedArtifact,
  outcome: ProvenanceRecord["outcome"],
  extra: Partial<ObsidianProvenanceLine>,
): ObsidianProvenanceLine {
  return {
    ts: new Date().toISOString(),
    lockVersion: ctx.lock.version,
    component: COMPONENT,
    artifact: "obsidian",
    url: artifact.url,
    ...(artifact.version !== undefined ? { version: artifact.version } : {}),
    expected: artifact.expected.pin,
    outcome,
    attempts: 0, // lifecycle rows follow a completed fetch; they consume no network attempts themselves
    ...extra,
  }
}

async function installObsidian(ctx: StepContext, opts: ObsidianStepOptions): Promise<StepResult> {
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

  // CONSENT GATE FIRST (§11, P-12/P-13): refuse before ANY action — even the read-only probes are
  // held until consent exists, so an unconsented run touches nothing at all (node-step discipline).
  if (!kit.hasConsent()) {
    return {
      token: OUTCOME.REFUSED_NO_CONSENT,
      message: "obsidian: no consent recorded; no probe, no fetch, no mount, no copy",
    }
  }

  const resolved: ResolveResult = kit.artifact("obsidian")
  if (!resolved.ok) return { token: outcomeTokenFor(resolved.code), message: resolved.message }
  const artifact = resolved.artifact
  const version = artifact.version
  if (!version) return { token: OUTCOME.FAILED, message: "obsidian pin carries no version" }

  const root = obsidianToolRoot(opts.installRoot)
  const versionDir = join(root, version)
  const teamPin = lockedTeamId(ctx.lock)

  // --- idempotent resume (§6.3): valid staged install detected by BINARY digest -> zero network.
  const seen = inspectStaged(root, version)
  if (seen.kind === "valid") {
    if (ctx.dryRun) {
      kit.log("info", `would resume: staged obsidian ${version} already present at ${versionDir}`)
      return {
        token: OUTCOME.OK,
        message: `dry-run: obsidian ${version} already staged and digest-matches its record; nothing to do`,
      }
    }
    setState(kit.state, COMPONENT, {
      state: STATES.HEALTHY,
      installedBySwarm: true,
      version,
      integrity: `sha256:${seen.record.appBinarySha256}`,
      paths: [...seen.record.paths],
    })
    kit.log("info", `resumed: staged obsidian ${version} matches its install record; zero network, zero mounts`, {
      context: { versionDir },
    })
    return { token: OUTCOME.OK, message: `obsidian ${version} already staged (binary digest matches record); resumed` }
  }

  // --- guide-and-detect (L14): a user-managed app anywhere on this Mac stops the staging path.
  const detection = (opts.detector ?? detectExistingInstall)()
  if (detection.found) {
    const moved = kit.transition(STATES.SKIPPED)
    if (!moved.ok) return { token: OUTCOME.FAILED, message: moved.error }
    kit.log(
      "info",
      `obsidian detected (user-managed); swarm-setup never touches it${seen.kind === "tampered" ? ` (own staged tree flagged: ${seen.reason})` : ""}`,
      {
        context: { paths: detection.paths, methods: detection.methods },
      },
    )
    return {
      token: OUTCOME.SKIPPED,
      message: `obsidian detected at ${detection.paths.join(", ")} — left untouched (guide-and-detect, L14); vault wiring is row 95`,
    }
  }

  // --- fetch through the kit (consent layer 2 + dry-run propagation live in rows 84/82) --------
  const fetchOpts: FetchOptions = {
    artifact: "obsidian",
    destDir: root,
    ...(opts.fetchTimeoutMs !== undefined ? { timeoutMs: opts.fetchTimeoutMs } : {}),
    ...(opts.provenancePath ? { provenancePath: opts.provenancePath } : {}),
  }
  const out = await kit.fetch(fetchOpts)
  if ("token" in out) return { token: out.token } // REFUSED_NO_CONSENT from the kit (belt-and-braces)
  if ("ok" in out) {
    // A tampered/truncated dmg dies HERE — row 82 never promoted it, and the mounter below is
    // unreachable: this is the blueprint's "Tampered dmg mock aborts before mount" (02_structured.md:254).
    const token = outcomeTokenFor(out.code)
    kit.transition(token === OUTCOME.BLOCKED_BY_NETWORK ? STATES.BLOCKED_BY_NETWORK : STATES.FAILED)
    return { token, message: out.message }
  }
  const fetched = out // narrowed to fetched | resumed | dry_run
  const dmgPath = fetched.destPath

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
      `dry-run: would mount ${dmgPath} read-only at a private mountpoint, run the codesign/spctl gate (recording the observed TeamIdentifier), ditto ${APP_NAME} into ${versionDir}, always detach; vault is NEVER created here (row 95)`,
    )
    return {
      token: OUTCOME.OK,
      message: `dry-run: would stage obsidian ${version} into ${versionDir} (nothing written)`,
    }
  }

  let moved = kit.transition(STATES.DOWNLOADED)
  if (!moved.ok) return { token: OUTCOME.FAILED, message: moved.error }
  moved = kit.transition(STATES.VERIFIED, { integrity: `sha256:${artifact.expected.hex}` })
  if (!moved.ok) return { token: OUTCOME.FAILED, message: moved.error }
  kit.log("info", "dmg verified against the PC-PIN-03 pin; mounting read-only for the signature gate", {
    context: { dmgPath },
  })

  // --- mount -> signature -> copy, with ALWAYS-unmount ------------------------------------------
  ensureDir(root, MODES.DIR_0700)
  ensureDir(tmpDir(), MODES.DIR_0700)
  const mountPoint = join(tmpDir(), `.mnt-${randomUUID()}`)
  mkdirSync(mountPoint, { mode: MODES.DIR_0700 })
  const mounter =
    opts.mounter ?? ((d: string, m: string) => realMount(d, m, opts.mountTimeoutMs ?? DEFAULT_MOUNT_TIMEOUT_MS))
  const unmounter =
    opts.unmounter ?? ((m: string) => realUnmount(m, opts.unmountTimeoutMs ?? DEFAULT_UNMOUNT_TIMEOUT_MS))
  const copier =
    opts.copier ?? ((s: string, d: string) => realCopy(s, d, opts.copyTimeoutMs ?? DEFAULT_COPY_TIMEOUT_MS))

  const mount = mounter(dmgPath, mountPoint)
  if (!mount.ok) {
    // Nothing was mounted on this path: rmdirSync removes ONLY the empty dir we created ourselves.
    try {
      rmdirSync(mountPoint)
    } catch (err) {
      kit.log(
        "warn",
        `attach failed AND the empty mountpoint ${mountPoint} could not be removed: ${(err as Error).message}`,
      )
    }
    kit.transition(STATES.FAILED)
    appendProvenance(
      lifecycleLine(ctx, artifact, "failed", { stage: "mount", code: "MOUNT_FAILED", destPath: dmgPath }),
      opts.provenancePath,
    )
    return { token: OUTCOME.FAILED, message: `cannot mount ${dmgPath}: ${mount.detail}` }
  }

  const stageDir = join(root, `.stage-${randomUUID()}`)
  let staged: {
    mountedBinarySha256: string
    appBinarySha256: string
    teamId: string | null
    sigDetail: string
  } | null = null
  try {
    const appSrc = join(mountPoint, APP_NAME)
    if (!existsSync(appSrc)) {
      kit.transition(STATES.FAILED)
      appendProvenance(
        lifecycleLine(ctx, artifact, "failed", { stage: "mount", code: "MOUNT_CONTENT", destPath: mountPoint }),
        opts.provenancePath,
      )
      return {
        token: OUTCOME.FAILED,
        message: `mounted volume holds no ${APP_NAME} at ${appSrc} — refusing to guess the bundle name`,
      }
    }

    // THE U-2 CLOSER: r82's gate over the mounted app. With the lock's team_id still null the gate
    // requires codesign+spctl PASS and records whatever TeamIdentifier prints; with a confirmed pin
    // a mismatch fails closed. macSignatureCheck itself is consumed, never reimplemented.
    const sigSpec = {
      ...(teamPin !== undefined ? { teamId: teamPin } : {}),
      ...(opts.signatureRun ? { run: opts.signatureRun } : {}),
    }
    const sig = macSignatureCheck(appSrc, sigSpec)
    const teamMismatch = teamPin !== undefined && sig.teamId !== teamPin
    if (!sig.codesignOk || !sig.spctlOk || teamMismatch) {
      kit.transition(STATES.FAILED)
      appendProvenance(
        lifecycleLine(ctx, artifact, "failed", {
          stage: "signature",
          code: "SIGNATURE_FAILED",
          observedTeamIdentifier: sig.teamId ?? null,
          signatureDetail: sig.detail,
          destPath: appSrc,
        }),
        opts.provenancePath,
      )
      return {
        token: OUTCOME.FAILED,
        message: `signature gate refused the mounted app: ${sig.detail}${teamMismatch ? ` (lock pins TeamIdentifier=${teamPin})` : ""}`,
      }
    }
    const observedTeamId = sig.teamId ?? null
    if (observedTeamId === null) {
      // Honest absence: spctl passed yet no TeamIdentifier printed (e.g. a Gatekeeper exception).
      // Recorded as null; the U-2 pin stays unconfirmed rather than being guessed (red line).
      kit.log(
        "warn",
        "codesign printed no TeamIdentifier — U-2 closer did not fire; pin stays unconfirmed and the value is recorded as null",
        { context: { appSrc } },
      )
    }

    const mountedBin = join(appSrc, ...BINARY_REL)
    if (!existsSync(mountedBin)) {
      kit.transition(STATES.FAILED)
      appendProvenance(
        lifecycleLine(ctx, artifact, "failed", { stage: "mount", code: "MOUNT_CONTENT", destPath: mountedBin }),
        opts.provenancePath,
      )
      return {
        token: OUTCOME.FAILED,
        message: `mounted app has no executable at ${mountedBin} — unexpected bundle layout, refusing to stage`,
      }
    }
    const mountedBinarySha256 = computeFileDigest(mountedBin, "sha256").hex

    mkdirSync(stageDir, { mode: MODES.DIR_0700 })
    const appDest = join(stageDir, APP_NAME)
    const copy = copier(appSrc, appDest)
    if (!copy.ok) {
      kit.transition(STATES.FAILED)
      appendProvenance(
        lifecycleLine(ctx, artifact, "failed", { stage: "copy", code: "COPY_FAILED", destPath: appDest }),
        opts.provenancePath,
      )
      return { token: OUTCOME.FAILED, message: `cannot copy ${appSrc} to ${appDest}: ${copy.detail}` }
    }
    const stagedBin = join(appDest, ...BINARY_REL)
    if (!existsSync(stagedBin)) {
      kit.transition(STATES.FAILED)
      appendProvenance(
        lifecycleLine(ctx, artifact, "failed", { stage: "copy", code: "COPY_CONTENT", destPath: stagedBin }),
        opts.provenancePath,
      )
      return {
        token: OUTCOME.FAILED,
        message: `copied bundle has no executable at ${stagedBin} — copy incomplete, nothing promoted`,
      }
    }
    const appBinarySha256 = computeFileDigest(stagedBin, "sha256").hex
    if (appBinarySha256 !== mountedBinarySha256) {
      kit.transition(STATES.FAILED)
      appendProvenance(
        lifecycleLine(ctx, artifact, "failed", {
          stage: "copy",
          code: "COPY_MISMATCH",
          observed: appBinarySha256,
          destPath: stagedBin,
        }),
        opts.provenancePath,
      )
      return {
        token: OUTCOME.FAILED,
        message: `staged binary ${appBinarySha256} differs from the mounted source ${mountedBinarySha256} — corrupt copy, nothing promoted`,
      }
    }
    staged = { mountedBinarySha256, appBinarySha256, teamId: observedTeamId, sigDetail: sig.detail }
  } finally {
    // TRAP-SAFE UNMOUNT: reached on every path (success, refusal, failure, throw) exactly like a
    // shell trap; the dmg is never left attached behind this step.
    const um = unmounter(mountPoint)
    if (um.ok) {
      // A real detach leaves the mountpoint EMPTY; rmdirSync claims exactly that empty dir and
      // nothing more. Every cleanup here is wrapped: an exception escaping the finally would mask
      // the primary outcome — the opposite of trap-safe.
      try {
        rmdirSync(mountPoint)
      } catch (err) {
        kit.log(
          "warn",
          `detached but the mountpoint ${mountPoint} was not an empty removable dir: ${(err as Error).message}`,
          { context: { detail: um.detail } },
        )
      }
    } else {
      kit.log(
        "warn",
        `unmount FAILED — leaving ${mountPoint} in place for manual 'hdiutil detach' (never recursively deleting a live mount)`,
        { context: { detail: um.detail } },
      )
    }
    // Early returns above skipped everything after this block, so the half-built stage tree is
    // swept HERE, inside the finally: .stage-* lives under our own tool root (never a mountpoint),
    // which makes the recursive sweep safe by location alone.
    if (staged === null && existsSync(stageDir)) {
      rmSync(stageDir, { recursive: true, force: true })
    }
  }
  if (staged === null) {
    // Unreachable when the try-blocks returned their own precise errors; kept as the type-guard
    // exit so `work` below is non-null. Any real failure already produced its provenance row.
    return {
      token: OUTCOME.FAILED,
      message: `obsidian staging did not complete inside the mount window (${mountPoint})`,
    }
  }
  const work = staged

  // --- atomic commit (§6.2): quarantine a tampered old tree, rename the stage in, delete after ---
  let quarantine: string | null = null
  try {
    if (existsSync(versionDir)) {
      quarantine = join(root, `.quarantine-${randomUUID()}`)
      renameSync(versionDir, quarantine)
    }
    renameSync(stageDir, versionDir) // single atomic move; after THIS line the staged app exists
  } catch (err) {
    rmSync(stageDir, { recursive: true, force: true })
    if (quarantine !== null && existsSync(quarantine) && !existsSync(versionDir)) {
      try {
        renameSync(quarantine, versionDir)
      } catch {
        kit.log("error", `could not restore quarantined tree at ${quarantine}`)
      }
    }
    kit.transition(STATES.FAILED)
    appendProvenance(
      lifecycleLine(ctx, artifact, "failed", { stage: "commit", code: "COMMIT_FAILED", destPath: versionDir }),
      opts.provenancePath,
    )
    return { token: OUTCOME.FAILED, message: `cannot commit ${versionDir}: ${(err as Error).message}` }
  }
  if (quarantine !== null) rmSync(quarantine, { recursive: true, force: true })

  // --- record + pointer + provenance (all atomic, 0600) --------------------------------------------
  const paths = [versionDir, join(versionDir, MANIFEST_NAME), join(root, POINTER_NAME), dmgPath]
  const installedAt = new Date().toISOString()
  const record: ObsidianInstallRecord = {
    component: "obsidian",
    version,
    url: artifact.url,
    dmgSha256: artifact.expected.hex,
    observedDmgSha256: artifact.expected.hex, // row 82 refuses promotion on any other value
    observedTeamIdentifier: work.teamId,
    signatureDetail: work.sigDetail,
    mountedBinarySha256: work.mountedBinarySha256,
    appBinarySha256: work.appBinarySha256,
    installedAt,
    lockVersion: ctx.lock.version,
    placement: "user-space-staged",
    applicationsTouched: false,
    paths,
  }
  atomicWriteJson(join(versionDir, MANIFEST_NAME), record, MODES.FILE_0600)
  atomicWriteJson(
    join(root, POINTER_NAME),
    { version, appBinarySha256: work.appBinarySha256, observedTeamIdentifier: work.teamId, installedAt },
    MODES.FILE_0600,
  )
  appendProvenance(
    lifecycleLine(ctx, artifact, fetched.status === "resumed" ? "resumed" : "fetched", {
      stage: "staged",
      observedTeamIdentifier: work.teamId,
      signatureDetail: work.sigDetail,
      observed: work.appBinarySha256,
      destPath: join(versionDir, APP_NAME),
    }),
    opts.provenancePath,
  )

  moved = kit.transition(STATES.INSTALLED, {
    installedBySwarm: true,
    version,
    integrity: `sha256:${work.appBinarySha256}`,
    paths: [...paths],
  })
  if (!moved.ok) return { token: OUTCOME.FAILED, message: moved.error }

  // configured: placement + record ARE the configuration. No settings file, no app-data dir, no vault:
  // those belong to Obsidian itself (D-08) and to row 95 (vault + tool wiring).
  moved = kit.transition(STATES.CONFIGURED)
  if (!moved.ok) return { token: OUTCOME.FAILED, message: moved.error }

  // health gate WITHOUT LAUNCHING: the committed tree re-validates against its own record
  // (record present + binary digest match). Launching Obsidian is never this step's job.
  const committed = inspectStaged(root, version)
  if (committed.kind !== "valid") {
    kit.transition(STATES.FAILED)
    return {
      token: OUTCOME.HEALTH_FAILED,
      message: `staged obsidian failed its post-commit validation (${committed.kind === "tampered" ? committed.reason : "absent?!"})`,
    }
  }
  moved = kit.transition(STATES.HEALTHY)
  if (!moved.ok) return { token: OUTCOME.FAILED, message: moved.error }

  prunePreviousInstall(kit.state.components[COMPONENT], root, version)

  // NR-03 floating-update guard: the cask reports auto_updates true (02d:118-120); the setup cannot
  // configure the app's updater without touching app data (D-08), so the duty is stated, not faked.
  kit.log(
    "warn",
    `obsidian ${version} staged in user space; upstream reports auto-updates — keep the app's built-in updater inside the pin (PT GSP never mirrors or bundles it, L-4/P-12)`,
    {
      context: { versionDir, observedTeamIdentifier: work.teamId },
    },
  )
  return {
    token: OUTCOME.OK,
    message: `obsidian ${version} staged at ${versionDir}/${APP_NAME} (TeamIdentifier observed: ${work.teamId ?? "<none printed>"}, recorded; /Applications untouched; vault is row 95)`,
  }
}

/** Drop the superseded swarm-staged OTHER version's recorded paths (lock bump / replace scenario). */
function prunePreviousInstall(entry: ComponentState | undefined, root: string, keepVersion: string): void {
  if (!entry || !entry.installedBySwarm || !entry.version || entry.version === keepVersion) return
  for (const p of entry.paths ?? []) {
    if (p.includes(`/${keepVersion}/`) || p === join(root, keepVersion)) continue
    if (isUnderRoot(p, root)) rmSync(p, { recursive: true, force: true })
  }
}

function removeObsidian(ctx: StepContext, opts: ObsidianStepOptions): StepResult {
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
  const root = obsidianToolRoot(opts.installRoot)
  const entry = kit.stateOf()

  // P-14: never delete what the setup did not create — a DETECTED (user-installed) Obsidian always
  // lands here with installedBySwarm unset and is left byte-identical, /Applications included.
  if (!entry.installedBySwarm) {
    return {
      token: OUTCOME.SKIPPED,
      message: "obsidian: not staged by swarm-setup (or already removed); nothing deleted",
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
  // Leftover step-owned temporaries (.stage-*/.quarantine-*) are ours by naming; sweep ONLY those
  // prefixes inside our root. Mountpoints (.mnt-*) live under ~/.swarm/tmp and are removed ONLY when
  // empty (a clean detach leaves an empty dir): rmSync without recursive fails on a live mount, which
  // is caught and warned — never recursively delete something still mounted.
  if (existsSync(root)) {
    for (const name of readdirSync(root)) {
      if (name.startsWith(".stage-") || name.startsWith(".quarantine-"))
        rmSync(join(root, name), { recursive: true, force: true })
    }
  }
  const tmp = tmpDir()
  if (existsSync(tmp)) {
    for (const name of readdirSync(tmp)) {
      if (!name.startsWith(".mnt-")) continue
      try {
        rmdirSync(join(tmp, name)) // succeeds only on an emptied (detached) mountpoint
      } catch {
        kit.log(
          "warn",
          `left ${join(tmp, name)} in place — still mounted or non-empty; detach manually (hdiutil detach) then retry`,
        )
      }
    }
  }
  if (refused.length > 0)
    kit.log("warn", `refused to delete ${refused.length} state-listed path(s) outside ${root} (P-14/P-16)`, {
      context: { refused },
    })

  kit.transition(STATES.ABSENT, { installedBySwarm: false, version: undefined, integrity: undefined, paths: undefined })
  kit.log("info", `obsidian removed: ${deletable.length} state-listed path(s) deleted under ${root}`)
  return {
    token: OUTCOME.OK,
    message: `obsidian removed (${deletable.length} path(s) under ${root}${refused.length > 0 ? `; ${refused.length} outside-root path(s) refused` : ""})`,
  }
}

/** The shape the engine dynamically imports from src/steps/obsidian/index.ts. The exported
 *  object keeps its richer (ctx, opts?) signature; the assignment below PROVES at compile
 *  time it still satisfies the plain StepModule contract the engine dispatches on. */
export const step = {
  id: COMPONENT,
  install(ctx: StepContext, opts: ObsidianStepOptions = {}): Promise<StepResult> {
    return installObsidian(ctx, opts)
  },
  remove(ctx: StepContext, opts: ObsidianStepOptions = {}): StepResult {
    return removeObsidian(ctx, opts)
  },
}

const _contractCheck: StepModule = step // compile-time proof only; unused by design
void _contractCheck

export default step

/** Convenience re-export so step authors/tests map raw fetch results like the engine does. */
export { stepOutcomeFromFetch }
