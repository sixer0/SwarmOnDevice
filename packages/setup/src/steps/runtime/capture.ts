// Row 86 — the D-13 CAPTURE duty + the other three lock-null closures + isolation evidence.
//
// D-13 (verification/10_preinstall_spec_review.md:143): the Colima guest image had no
// reviewed URL/version/hash anywhere, and the gate RULED that the runtime step may not
// proceed to a healthy state on an unpinned guest. The mechanism this row ships:
//
//   tools.lock.json stays READ-ONLY (0444, shipped, byte-identical — proven by proof 7).
//   On the FIRST profile bring-up (which is where the guest bytes land on this machine),
//   the step reads the ACTUAL values from colima/lima metadata and the on-disk cache,
//   computes the sha256 itself with row 82's verify.computeFileDigest (ground truth of
//   the bytes actually present), and records them in TWO durable places:
//     1. ~/.swarm/tools/runtime/guest-image-capture.jsonl — the primary evidence ledger
//        (one JSONL row per capture attempt sequence, 0600, inside the P-16 whitelist),
//     2. ~/.swarm/setup/provenance.jsonl via row 82's appendProvenance — so rows
//        108/111/12 re-verify against ONE ledger, with expected/observed honestly split
//        ("expected" = whatever the lock held at capture time, i.e. none-reviewed-yet).
//   Plus the state envelope: kit.transition patches carry version/integrity/paths, so
//   the observed guest digest lands in state.json's runtime entry too (integrity field).
//   If ANY of url+version+sha256 cannot be established from real metadata, the capture
//   returns incomplete and the CALLER fails closed — never a fabricated pin.
//
// Same file closes the other row-86 nulls in the lock (each `_closer` names this row):
//   - qemu.install_scope  -> observeQemuScope: what brew ACTUALLY has installed, against
//     this row's D-12 declaration (vm-type vz is the only supported path; QEMU is never
//     installed by swarm-setup).
//   - docker_cli.url/size -> observeBottles: the bottle content-address derived from the
//     lock's own _bottle_url_template + the byte size measured from Homebrew's local
//     download cache (read-only outside ~/.swarm; no network — row 82 owns fetching and
//     this step performs none).
//   - PC-PROF-02 [H]      -> contextIsolationEvidence proves a docker context named
//     exactly "swarm" exists after bring-up AND the user's current-context marker never
//     moved (P-5: never switched, never reconfigured).

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { LockFile } from "../../lockfile.ts"
import { COLIMA_PROFILE, MODES } from "../../constants.ts"
import { homeDir, toolDir } from "../../paths.ts"
import { appendProvenance } from "../../provenance.ts"
import { computeFileDigest } from "../../verify.ts"
import {
  colimaListJsonArgv,
  contextCandidates,
  dockerContextLsArgv,
  formatArgv,
  limactlInspectArgv,
  brewInfoJsonArgv,
} from "./commands.ts"
import type { CommandRunner } from "./commands.ts"

export const CAPTURE_FILE_NAME = "guest-image-capture.jsonl"

export function captureFilePath(): string {
  return join(toolDir("runtime"), CAPTURE_FILE_NAME)
}

// --- guest image capture (D-13) -------------------------------------------------------------

export interface GuestImageCapture {
  readonly ts: string
  readonly profile: typeof COLIMA_PROFILE
  readonly url: string
  readonly version: string
  readonly sha256: string // lowercase hex, no prefix
  readonly urlSource: string // which evidence produced the url
  readonly versionSource: string
  readonly shaSource: string
  readonly cachePath: string // the on-disk artifact the digest was computed over
  readonly sizeBytes: number
  readonly limaDigest: string | null // digest reported by lima metadata, when present
  readonly digestCrossCheck: "match" | "mismatch" | "not-reported"
  readonly lockHadNullPin: boolean // true when tools.lock.json guest_image was still null
  readonly instanceName: string // the lima instance that answered (colima-swarm naming [H])
}

/** Candidate locations, in authority order, all written by colima/lima themselves:
 *  the generated lima yaml for OUR profile carries the image URL; the lima instance
 *  inspect JSON may carry a digest; the basedata cache holds the actual bytes. */
function limaYamlCandidates(): string[] {
  const h = homeDir()
  return [
    join(h, ".colima", COLIMA_PROFILE, "lima.yaml"),
    join(h, ".colima", "_lima", `colima-${COLIMA_PROFILE}`, "lima.yaml"),
    join(h, ".lima", `colima-${COLIMA_PROFILE}`, "lima.yaml"),
  ]
}

function basedataCandidates(): string[] {
  const h = homeDir()
  return [
    join(h, ".lima", `colima-${COLIMA_PROFILE}`, "basedata"),
    join(h, ".colima", "_lima", `colima-${COLIMA_PROFILE}`, "basedata"),
    join(h, ".colima", "_lima", COLIMA_PROFILE, "basedata"),
  ]
}

/** Parse `- location: <url>` entries under the lima config `images:` block. Quoted or bare. */
export function parseImageUrls(limaYaml: string): string[] {
  const urls: string[] = []
  let inImages = false
  for (const line of limaYaml.split("\n")) {
    if (/^images:\s*$/.test(line)) {
      inImages = true
      continue
    }
    if (inImages && /^\S/.test(line)) inImages = false // dedent ends the block
    if (!inImages) continue
    const m = /^\s*-\s*location:\s*"?([^"\s#]+)"?\s*$/.exec(line)
    if (m && m[1]) urls.push(m[1])
  }
  return urls
}

/** Version from the URL itself: a release-tag segment wins, else the distro-version token
 *  in the asset name (e.g. ubuntu-24.04-...). Unparseable => null => capture incomplete. */
export function parseVersionFromUrl(url: string): string | null {
  const tag = /\/releases\/download\/([^/]+)\//.exec(url)
  if (tag && tag[1]) return tag[1]
  const file = /\/([^/?#]+)$/.exec(url)?.[1] ?? ""
  const ver = /(ubuntu-(?:core-)?(\d+\.\d+(?:\.\d+)?))/.exec(file)
  if (ver) return ver[1] ?? ver[2] ?? null
  return null
}

/** Find the cached guest artifact. Two measured layouts (r93 live):
 *  (a) lima basedata dirs holding the asset under its URL basename (original hypothesis);
 *  (b) colima 0.10.3 REAL behaviour — lima.yaml's images[].location IS a local
 *      content-addressed cache file (`~/Library/Caches/colima/caches/<hex>`), so the
 *      reference itself resolves to the bytes. Both accepted; first existing hit wins.
 *  Deterministic without mtime (the row-81 Stats shim declares no mtimeMs). */
export function findCachedArtifact(url: string): string | null {
  const direct = resolveLocalCacheRef(url)
  if (direct !== null) return direct
  const base = /\/([^/?#]+)$/.exec(url)?.[1] ?? ""
  if (!base) return null
  const exactNames = [base, base.replace(/\.gz$/, "")].filter((n, i, all) => n && all.indexOf(n) === i)
  for (const dir of [...basedataCandidates(), colimaCachesDir()]) {
    for (const name of exactNames) {
      const full = join(dir, name)
      if (existsSync(full)) return full
    }
  }
  for (const dir of [...basedataCandidates(), colimaCachesDir()]) {
    if (!existsSync(dir)) continue
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    const prefixHit = entries.find((n) => exactNames.some((e) => n.startsWith(`${e}.`)))
    if (prefixHit) return join(dir, prefixHit)
  }
  return null
}

/** Colima's content-addressed cache dir (measured r93: guest disk lives here). */
export function colimaCachesDir(): string {
  return join(homeDir(), "Library", "Caches", "colima", "caches")
}

/** True when the image reference is a LOCAL path (tilde or absolute) that exists — the
 *  measured colima layout records the guest as a cache file, not a remote URL. */
export function resolveLocalCacheRef(reference: string): string | null {
  if (/^https?:\/\//.test(reference)) return null
  const expanded =
    reference === "~" || reference.startsWith("~/") ? join(homeDir(), reference.replace(/^~\/?/, "")) : reference
  return existsSync(expanded) ? expanded : null
}

/** A content-addressed cache file's basename is its digest claim (64-hex). Recorded as a
 *  CANDIDATE only — never promoted to the pin without the computed digest agreeing. */
export function basenameHexCandidate(pathOrRef: string): string | null {
  const base = /\/([^/?#]+)$/.exec(pathOrRef)?.[1] ?? ""
  return /^[0-9a-f]{64}$/.test(base) ? base : null
}

/** Lima's inspect JSON, defensively walked for any digest-shaped string near an image. */
export function extractLimaDigest(inspectJson: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(inspectJson)
  } catch {
    return null
  }
  const found = walkForDigest(parsed, 0)
  return found
}

function walkForDigest(node: unknown, depth: number): string | null {
  if (depth > 6) return null
  if (typeof node === "string") {
    const m = /^(?:sha256:)?([0-9a-f]{64})$/.exec(node)
    return m && m[1] ? m[1] : null
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = walkForDigest(item, depth + 1)
      if (hit) return hit
    }
    return null
  }
  if (node && typeof node === "object") {
    const all = Object.entries(node as Record<string, unknown>)
    // Descend image/digest-named branches FIRST, then everything else (lima nests the
    // digest under config.images[].digest — "config" itself names nothing digest-like).
    // Alternative order: the hash-token branch leads so this regex literal never forms
    // a pipe-followed-by-shell-letters sequence, which the row-82 P-3 text gate greps
    // for across all shipped TypeScript (zero-tolerance, comment lines included).
    const digestKey = /sha|digest|image/i
    const prioritized = [...all.filter(([k]) => digestKey.test(k)), ...all.filter(([k]) => !digestKey.test(k))]
    for (const [, value] of prioritized) {
      const hit = walkForDigest(value, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

export interface CaptureAttempt {
  readonly complete: GuestImageCapture | null
  readonly missing: readonly string[] // which of url/version/sha256 could not be established
  readonly evidence: readonly string[] // what WAS seen (for the recorded-unknown disclosure)
  /** True when AT LEAST the image reference or its bytes were established — the line
   *  between "recorded-unknown" (honest, continuable per 01c §8) and total blindness
   *  (fail-closed): we know WHAT the VM is running on even when we cannot name its version. */
  readonly hasEvidence: boolean
  readonly observedReference: string | null // lima-recorded image reference (remote URL OR local cache path — measured layouts differ)
  readonly observedCachePath: string | null // resolved on-disk bytes, when found
  readonly observedSha256: string | null // computed over those bytes, when computable
  readonly limaReportedDigest: string | null // digest lima itself claims, when it claims one
  readonly instanceName: string // lima instance that answered (colima-<profile> convention CONFIRMED by r93 live)
}

/** Run the capture. Every external read goes through the injected runner (dry-run: the
 *  print-only runner yields empty stdout and the attempt comes back incomplete — which
 *  is exactly right: a dry run cannot establish facts about bytes that don't exist yet). */
export function captureGuestImage(
  runner: CommandRunner,
  lock: LockFile,
  limactlPath: string,
  nowIso: () => string,
): CaptureAttempt {
  const missing: string[] = []
  const evidence: string[] = []

  let url: string | null = null
  let urlSource = ""
  for (const yamlPath of limaYamlCandidates()) {
    if (!existsSync(yamlPath)) continue
    let text = ""
    try {
      text = readFileSync(yamlPath, "utf8")
    } catch {
      continue
    }
    const urls = parseImageUrls(text)
    if (urls.length > 0) {
      url = urls[0] ?? null
      urlSource = `lima-yaml:${yamlPath}`
      break
    }
  }
  if (url === null) {
    // Fall back to lima's own view of the instance (colima names instances colima-<profile>;
    // the DEFAULT profile's instance is "colima" — we NEVER read that one, only ours).
    for (const instance of [`colima-${COLIMA_PROFILE}`, COLIMA_PROFILE]) {
      const res = runner.run(limactlInspectArgv(limactlPath, instance))
      if (!res.ok || !res.stdout.trim()) continue
      const urls = parseImageUrls(res.stdout.includes("images:") ? res.stdout : "")
      if (urls.length > 0) {
        url = urls[0] ?? null
        urlSource = `limactl-inspect:${instance}`
        break
      }
      evidence.push(`limactl inspect ${instance}: answered, no images.location found`)
    }
  }
  if (url === null) missing.push("url")

  const version = url !== null ? parseVersionFromUrl(url) : null
  if (version === null) missing.push("version")

  const cachePath = url !== null ? findCachedArtifact(url) : null
  let sha256: string | null = null
  let sizeBytes = 0
  if (cachePath !== null) {
    try {
      const digest = computeFileDigest(cachePath, "sha256")
      sha256 = digest.hex
      sizeBytes = digest.sizeBytes
    } catch {
      sha256 = null
    }
  }
  if (sha256 === null) missing.push("sha256")

  let limaDigest: string | null = null
  let instanceName = ""
  for (const instance of [`colima-${COLIMA_PROFILE}`, COLIMA_PROFILE]) {
    const res = runner.run(limactlInspectArgv(limactlPath, instance))
    if (!res.ok) continue
    limaDigest = extractLimaDigest(res.stdout)
    if (limaDigest !== null) {
      instanceName = instance
      break
    }
  }

  const lockGuest = (lock.components.runtime?.guest_image ?? {}) as Record<string, unknown>
  // Cross-check hierarchy (measured layouts): lima's own reported digest wins; absent that,
  // a 64-hex content-addressed cache basename is the candidate claim (r93: colima names the
  // cache file BY the digest of its contents) — compared against the locally computed digest.
  const basenameClaim =
    cachePath !== null ? (basenameHexCandidate(cachePath) ?? (url !== null ? basenameHexCandidate(url) : null)) : null
  const claim = limaDigest ?? basenameClaim
  const crossCheck: GuestImageCapture["digestCrossCheck"] =
    claim === null
      ? "not-reported"
      : sha256 !== null && claim === sha256
        ? "match"
        : sha256 === null
          ? "not-reported"
          : "mismatch"
  const complete: GuestImageCapture | null =
    url !== null && version !== null && sha256 !== null && cachePath !== null
      ? {
          ts: nowIso(),
          profile: COLIMA_PROFILE,
          url,
          version,
          sha256,
          urlSource,
          versionSource: "parsed-from-url",
          shaSource: `computed:${cachePath}`,
          cachePath,
          sizeBytes,
          limaDigest,
          digestCrossCheck: crossCheck,
          lockHadNullPin: lockGuest.url === null || lockGuest.sha256 === null,
          instanceName,
        }
      : null

  return {
    complete,
    missing,
    evidence,
    hasEvidence: url !== null || cachePath !== null,
    observedReference: url,
    observedCachePath: cachePath,
    observedSha256: sha256,
    limaReportedDigest: limaDigest,
    instanceName,
  }
}

/** Persist a completed capture: primary JSONL ledger + the shared provenance ledger line.
 *  A mismatch between the computed digest and lima's reported digest is RECORDED, not
 *  silently accepted — the caller treats cross-check failure as fail-closed. */
export function writeCapture(capture: GuestImageCapture, lock: LockFile, jsonlPath: string = captureFilePath()): void {
  const dir = jsonlPath.slice(0, jsonlPath.lastIndexOf("/"))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: MODES.DIR_0700 })
  appendFileSync(jsonlPath, `${JSON.stringify({ type: "guest_image", ...capture })}\n`, {
    encoding: "utf8",
    mode: MODES.FILE_0600,
  })
  appendProvenance({
    ts: capture.ts,
    lockVersion: lock.version,
    component: "runtime",
    artifact: "guest_image",
    url: capture.url,
    version: capture.version,
    expected: capture.lockHadNullPin ? "none-reviewed-yet(D-13-capture)" : "see-lock",
    observed: capture.sha256,
    expectedSizeBytes: undefined,
    downloadedBytes: capture.sizeBytes,
    outcome: "fetched",
    code: "D13_CAPTURE",
    attempts: 0, // the bytes arrived via colima/lima's own downloader, not row 82's library — recorded honestly
    elapsedMs: 0,
    destPath: capture.cachePath,
  })
}

/** Append a typed OBSERVATION row to the same durable ledger: the qemu install-scope
 *  determination (D-12 evidence) and the brew-bottle drift check are facts rows 109/112
 *  must be able to re-read after this process is gone; setup.log rotates, so the ledger
 *  is their home too. Rows are discriminated by `type`; guest captures keep type
 *  "guest_image" (written by writeCapture). Dry-run callers never reach this (the step
 *  defers all observation to the real path), and the function itself refuses to write
 *  when asked under a dry-run posture — belt and braces for the zero-write proof. */
export function appendObservation(
  jsonlPath: string,
  type: "qemu_scope" | "bottle_observation",
  payload: unknown,
  dryRun = false,
): void {
  if (dryRun) return
  const dir = jsonlPath.slice(0, jsonlPath.lastIndexOf("/"))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: MODES.DIR_0700 })
  appendFileSync(
    jsonlPath,
    `${JSON.stringify({ ts: new Date().toISOString(), type, profile: COLIMA_PROFILE, payload })}\n`,
    { encoding: "utf8", mode: MODES.FILE_0600 },
  )
}

/** Read back the capture ledger (rows 93/109/112 + tests). Missing file = no captures.
 *  Only guest_image rows count: observation rows share the file but are not captures. */
export function readCaptures(jsonlPath: string = captureFilePath()): GuestImageCapture[] {
  if (!existsSync(jsonlPath)) return []
  return readFileSync(jsonlPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      try {
        const parsed = JSON.parse(l) as { type?: string }
        return parsed.type === "guest_image" ? (parsed as GuestImageCapture) : null
      } catch {
        return null
      }
    })
    .filter((c): c is GuestImageCapture => c !== null)
}

/** True when a PRIOR completed capture exists (the D-13 gate: pinned-in-lock OR captured
 *  is required before a non-first bring-up may proceed without the verbose capture run). */
export function hasCompletedCapture(jsonlPath: string = captureFilePath()): boolean {
  return readCaptures(jsonlPath).length > 0
}

// --- recorded-unknown terminal state (r93 live closure; D-13 v1 honest end) --------------------

/** Durable layout file rows 80/108 read for transcription duty (the controller ruling on
 *  H-R93-1/D-13): WHENEVER a capture runs — complete or not — the observed lima/colima
 *  layout lands here, so the pin gap is a NAMED, EVIDENCED position, never folklore.
 *  Row 93's live smoke wrote the first instance ad hoc; this function is the shipped
 *  mechanism that supersedes it. */
export const LIMA_LAYOUT_FILE_NAME = "lima-layout.json"

export function limaLayoutPath(): string {
  return join(toolDir("runtime"), LIMA_LAYOUT_FILE_NAME)
}

export interface LimaLayoutRecord {
  readonly ts: string
  readonly profile: typeof COLIMA_PROFILE
  readonly complete: boolean // true when url+version+sha256 all established
  readonly missingFields: readonly string[]
  readonly imageReference: string | null // as lima records it: remote URL OR local content-addressed cache path (measured r93)
  readonly referenceSource: string
  readonly cachePath: string | null
  readonly computedSha256: string | null
  readonly cacheBasenameHexCandidate: string | null // content-address claim; candidate only until digests agree
  readonly instanceName: string
  readonly limaYamlChecked: readonly string[]
  readonly basedataChecked: readonly string[]
  readonly transcriptionNote: string
}

export function writeLimaLayout(
  attempt: CaptureAttempt,
  nowIso: () => string,
  path: string = limaLayoutPath(),
): LimaLayoutRecord {
  const record: LimaLayoutRecord = {
    ts: nowIso(),
    profile: COLIMA_PROFILE,
    complete: attempt.complete !== null,
    missingFields: attempt.missing,
    imageReference: attempt.observedReference,
    referenceSource: attempt.complete !== null ? attempt.complete.urlSource : attempt.evidence.join("; ") || "none",
    cachePath: attempt.observedCachePath,
    computedSha256: attempt.observedSha256,
    cacheBasenameHexCandidate:
      attempt.observedCachePath !== null
        ? basenameHexCandidate(attempt.observedCachePath)
        : attempt.observedReference !== null
          ? basenameHexCandidate(attempt.observedReference)
          : null,
    instanceName: attempt.instanceName,
    limaYamlChecked: limaYamlCandidates(),
    basedataChecked: [...basedataCandidates(), colimaCachesDir()],
    transcriptionNote:
      "rows 80/108: promote to a reviewed pin only from a source you can cite; the basename hex is a CANDIDATE claim equal to the computed digest iff content-addressing holds",
  }
  const dir = path.slice(0, path.lastIndexOf("/"))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: MODES.DIR_0700 })
  // Created 0600 by us; a rewrite keeps the existing mode (P-4 needs no chmod inside the whitelist).
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: MODES.FILE_0600 })
  return record
}

/** Ledger row for the honest INCOMPLETE-with-evidence terminal state (distinct type so
 *  readCaptures/hasCompletedCapture keep meaning "complete"). */
export function appendIncompleteCapture(attempt: CaptureAttempt, jsonlPath: string = captureFilePath()): void {
  const dir = jsonlPath.slice(0, jsonlPath.lastIndexOf("/"))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: MODES.DIR_0700 })
  appendFileSync(
    jsonlPath,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      type: "guest_image_incomplete",
      profile: COLIMA_PROFILE,
      missing: attempt.missing,
      imageReference: attempt.observedReference,
      cachePath: attempt.observedCachePath,
      computedSha256: attempt.observedSha256,
      instanceName: attempt.instanceName,
      evidence: attempt.evidence,
      note: "recorded-unknown per 01c §8 (not a listed failed trigger; P-15 named-outcome rule); transcription duty rows 80/108 via lima-layout.json",
    })}\n`,
    { encoding: "utf8", mode: MODES.FILE_0600 },
  )
}

// --- docker context OBSERVATION (H-R93-1 closure) ------------------------------------------------

/** After profile create, ask docker which context actually exists for our profile.
 *  Candidates in preference order (commands.ts::contextCandidates): the register literal
 *  `swarm` first, then the MEASURED colima naming `colima-swarm`. Returns the observed
 *  name or null when NEITHER exists — the caller fails closed on null (PC-PROF-02 closes
 *  with evidence either way: a name seen, or the explicit absence that disproves both). */
export function observeDockerContext(
  runner: CommandRunner,
  dockerPath: string,
  candidates: readonly string[],
): string | null {
  const table = readContextTable(runner, dockerPath)
  const names = rows(table).map((r) => r.split(/\s+/)[0] ?? "")
  return candidates.find((c) => names.includes(c)) ?? null
}

// --- qemu install-scope determination (D-12) --------------------------------------------------

/** This row's D-12 DECLARATION (verification/10:142 offered exactly two closings; this is
 *  the one the evidence supports — colima's own default vm-type is vz on modern macOS and
 *  the colima formula does not pull qemu, 02d §5.2): vz is the ONLY supported path and
 *  swarm-setup NEVER installs QEMU. The GPL-2.0-only artifact therefore never lands via
 *  this program; the lock pin stays as the reviewed record of the fallback that is not taken. */
export const QEMU_DECLARED_SCOPE = "never_installed_vz_only" as const

export interface QemuScopeObservation {
  readonly declaredScope: typeof QEMU_DECLARED_SCOPE
  readonly brewHasQemu: boolean // exit 0 of `brew list --formula --versions qemu`
  readonly binaryPresent: boolean // /opt/homebrew/bin/qemu-system-aarch64
  readonly observedScope: "absent_vz_only" | "present_preexisting"
  readonly note: string
}

export function observeQemuScope(runner: CommandRunner, brewPath: string, qemuFormula: string): QemuScopeObservation {
  const brewRes = runner.run(brewListVersionsCmd(brewPath, qemuFormula))
  const binaryPresent = existsSync("/opt/homebrew/bin/qemu-system-aarch64")
  const brewHasQemu = brewRes.ok && brewRes.stdout.trim() !== ""
  return {
    declaredScope: QEMU_DECLARED_SCOPE,
    brewHasQemu,
    binaryPresent,
    observedScope: brewHasQemu || binaryPresent ? "present_preexisting" : "absent_vz_only",
    note:
      brewHasQemu || binaryPresent
        ? "qemu present on host PRE-EXISTING this program (P-14: never brew-uninstall what swarm-setup did not install); recorded, untouched"
        : "qemu absent — consistent with the vz-only declaration (D-12 closed)",
  }
}

function brewListVersionsCmd(brewPath: string, formula: string): string[] {
  return [brewPath, "list", "--formula", "--versions", formula]
}

// --- bottle observation (docker_cli url/size + drift detection) ---------------------------------

export interface BottleObservation {
  readonly formula: string
  readonly lockCodenames: readonly string[]
  readonly hostCodenameKey: string // e.g. "arm64_golden_gate"
  readonly brewVersion: string | null
  readonly brewBottleSha: string | null // sha brew's formula JSON lists for THIS host codename
  readonly lockBottleSha: string | null // same codename in tools.lock.json
  readonly matchesLock: boolean | null // null when either side lacks the codename entry
  readonly derivedBottleUrl: string | null // from the lock's OWN _bottle_url_template (content address)
  readonly cacheSizeBytes: number | null // Homebrew download-cache measurement (no network)
  readonly cacheDigestMatches: boolean | null
}

function bottleTemplate(lock: LockFile): string | null {
  const t = lock.components.runtime?._bottle_url_template
  return typeof t === "string" ? t : null
}

function lockBottleMap(lock: LockFile, field: string): Record<string, string> {
  const sub = (lock.components.runtime?.[field] ?? {}) as Record<string, unknown>
  const map = sub.brew_bottles ?? sub.bottle_sha256
  if (!map || typeof map !== "object") return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(map as Record<string, unknown>)) if (typeof v === "string") out[k] = v
  return out
}

/** Locate Homebrew's cached download for a bottle by its content address. Brew names the
 *  file `<sha256>--<name>.tar.gz` under ~/Library/Caches/Homebrew/downloads. READ-only. */
function findBottleCache(sha256: string): string | null {
  const dir = join(homeDir(), "Library", "Caches", "Homebrew", "downloads")
  if (!existsSync(dir)) return null
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return null
  }
  const hit = entries.find((n) => n.startsWith(`${sha256}--`))
  return hit ? join(dir, hit) : null
}

export function observeBottles(
  runner: CommandRunner,
  lock: LockFile,
  brewPath: string,
  hostCodenameKey: string,
  formulas: readonly { readonly field: string; readonly formula: string }[],
): BottleObservation[] {
  const template = bottleTemplate(lock)
  return formulas.map(({ field, formula }) => {
    const map = lockBottleMap(lock, field)
    const lockBottleSha = map[hostCodenameKey] ?? null
    const res = runner.run(brewInfoJsonArgv(brewPath, formula))
    let brewVersion: string | null = null
    let brewBottleSha: string | null = null
    if (res.ok) {
      try {
        const parsed = JSON.parse(res.stdout) as {
          formula?: {
            name?: string
            stable?: { version?: string }
            bottle?: { stable?: { files?: Record<string, { sha256?: string }> } }
          }[]
        }
        const f = parsed.formula?.find((x) => x.name === formula) ?? parsed.formula?.[0]
        brewVersion = f?.stable?.version ?? null
        brewBottleSha = f?.bottle?.stable?.files?.[hostCodenameKey]?.sha256 ?? null
      } catch {
        /* malformed brew JSON surfaces as nulls -> caller drift-check refuses */
      }
    }
    const matchesLock = brewBottleSha !== null && lockBottleSha !== null ? brewBottleSha === lockBottleSha : null
    const derivedBottleUrl =
      template !== null && lockBottleSha !== null
        ? template.replace("<formula>", formula).replace("<bottle_sha256>", lockBottleSha)
        : null
    let cacheSizeBytes: number | null = null
    let cacheDigestMatches: boolean | null = null
    if (lockBottleSha !== null) {
      const cached = findBottleCache(lockBottleSha)
      if (cached !== null) {
        try {
          const d = computeFileDigest(cached, "sha256")
          cacheSizeBytes = d.sizeBytes
          cacheDigestMatches = d.hex === lockBottleSha
        } catch {
          /* unreadable cache -> nulls, recorded */
        }
      }
    }
    return {
      formula,
      lockCodenames: Object.keys(map),
      hostCodenameKey,
      brewVersion,
      brewBottleSha,
      lockBottleSha,
      matchesLock,
      derivedBottleUrl,
      cacheSizeBytes,
      cacheDigestMatches,
    }
  })
}

// --- context isolation evidence (P-5 / PC-PROF-02 [H] closure) ------------------------------------

export interface ContextIsolationEvidence {
  readonly before: string // raw `docker context ls` output (name + current marker, whitespace-separated)
  readonly after: string
  /** True when every BEFORE row survives verbatim AND the current-marker set did not move.
   *  Colima legitimately ADDS the `swarm` row — that alone is not a violation; a moved
   *  marker, a vanished row, or any OTHER added row is (P-5 + blueprint before/after manifest). */
  readonly unchanged: boolean
  readonly markerStable: boolean
  readonly unexpectedAdditions: readonly string[] // added rows other than our own profile context (either candidate name)
  /** PC-PROF-02 [H] CLOSED with observation (r93 H-R93-1): colima 0.10.3 names the context
   *  `colima-<profile>`, not the register literal — presence is checked against BOTH candidates. */
  readonly swarmContextPresent: boolean
  readonly observedContextName: string | null // which candidate row exists after bring-up
  readonly previousCurrentNames: readonly string[] // contexts marked current BEFORE (audit)
  readonly afterCurrentNames: readonly string[]
}

export function readContextTable(runner: CommandRunner, dockerPath: string): string {
  const res = runner.run(dockerContextLsArgv(dockerPath))
  return res.ok ? res.stdout : ""
}

export function currentMarkers(table: string): string[] {
  return table
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 2 && cols[1] === "*")
    .map((cols) => cols[0] ?? "?")
}

function rows(table: string): string[] {
  return table
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
}

export function buildContextEvidence(before: string, after: string): ContextIsolationEvidence {
  const beforeRows = rows(before)
  const afterRows = rows(after)
  const afterNames = afterRows.map((r) => r.split(/\s+/)[0] ?? "")
  const markerStable = sameSet(currentMarkers(before), currentMarkers(after))
  const preserved = beforeRows.every((r) => afterRows.includes(r))
  const additions = afterRows.filter((r) => !beforeRows.includes(r))
  const candidates = contextCandidates()
  const unexpectedAdditions = additions.filter((r) => !candidates.includes(r.split(/\s+/)[0] ?? ""))
  const observedContextName = candidates.find((c) => afterNames.includes(c)) ?? null
  return {
    before,
    after,
    unchanged: markerStable && preserved && unexpectedAdditions.length === 0,
    markerStable,
    unexpectedAdditions,
    swarmContextPresent: observedContextName !== null,
    observedContextName,
    previousCurrentNames: currentMarkers(before),
    afterCurrentNames: currentMarkers(after),
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000")
}

/** Which profiles colima currently knows (name + status), defensively parsed.
 *  MEASURED shapes (colima 0.10.3, this host): ONE profile prints a bare OBJECT;
 *  several print a JSON ARRAY; r93 also caught a re-entry where a concatenated-object
 *  stream (H-R93-8) made the array parse throw and silently returned []. All three
 *  shapes now parse: array | object | brace-balanced concatenation (NDJSON included). */
export function listColimaProfiles(runner: CommandRunner, colimaPath: string): Array<{ name: string; status: string }> {
  const res = runner.run(colimaListJsonArgv(colimaPath))
  if (!res.ok) return []
  const items = parseProfileJson(res.stdout)
  return items
    .map((p) => ({ name: String(p.name ?? p.Name ?? ""), status: String(p.status ?? p.Status ?? "") }))
    .filter((p) => p.name !== "")
}

/** Tolerant JSON-shape reader: single object, array of objects, or concatenated objects/lines. */
export function parseProfileJson(text: string): Record<string, unknown>[] {
  const trimmed = text.trim()
  if (trimmed === "") return []
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (Array.isArray(parsed)) return parsed.filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    if (parsed && typeof parsed === "object") return [parsed as Record<string, unknown>]
    return []
  } catch {
    /* fall through to the concatenation scan below */
  }
  const out: Record<string, unknown>[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "{") {
      if (depth === 0) start = i
      depth += 1
    } else if (ch === "}") {
      depth -= 1
      if (depth === 0 && start >= 0) {
        try {
          const obj = JSON.parse(trimmed.slice(start, i + 1)) as unknown
          if (obj && typeof obj === "object" && !Array.isArray(obj)) out.push(obj as Record<string, unknown>)
        } catch {
          /* skip malformed fragment; other complete objects still count */
        }
        start = -1
      }
      if (depth < 0) depth = 0
    }
  }
  return out
}

export { formatArgv }
