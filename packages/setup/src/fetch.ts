// Fetch + verify library (01c §6.1, row 82). A LIBRARY consumed by steps — NOT a
// scanned step directory (row-81 note 3): one implementation serves every
// component so one verification standard holds everywhere (P-1).
//
// Guarantees, each enforced below and unit-tested against a local HTTPS fixture:
//  1. HTTPS only; any http: URL or downgrade redirect is refused (§6.1, P-17).
//  2. Host ∈ the tools.lock.json `hosts` allow-list (P-18), re-checked on EVERY
//     redirect hop (GitHub releases 302 to objects.githubusercontent.com, which
//     is why the CDN hosts sit in the list). A host outside it is refused with
//     REFUSED_HOST_DENIED naming the host, BEFORE any request leaves the process.
//  3. Size cap from the lock (`size`) enforced on Content-Length AND on streamed
//     byte count; over-cap bodies are aborted and never promoted (§6.1 P-1).
//  4. sha256 (or npm sha512 integrity) verified against the lock BEFORE usable:
//     bytes land only in ~/.swarm/tmp staging; the final name under the tool dir
//     appears ONLY after the digest matches, via one rename(2) (§6.2 atomic move).
//  5. Resume-friendly: a valid existing final file means ZERO network attempts
//     (§6.3 — re-verify by hashing the file, never trust the filename).
//  6. Timeout + ONE backoff retry on transient errors (network error, timeout,
//     429, 5xx); permanent statuses (404 etc.) are never retried.
//  7. Every attempt sequence appends one provenance JSONL record (url, version,
//     expected/observed digest, sizes, timestamp, outcome) — see provenance.ts.
//
// NEVER executes downloaded content: this module holds no process-spawning import
// or call at all; downloaded bytes are only written to disk and hashed. The one
// signature-tool call site is verify.ts `macSignatureCheck`, which spawns ONLY
// absolute-path SYSTEM binaries (/usr/bin/codesign, /usr/sbin/spctl) with argv
// arrays (never a shell, never the downloaded bytes) to INSPECT a file —
// inspection is not execution, and the grep gate in test/fetch.proofs.sh asserts
// both halves.
//
// TLS verification is never weakened (P-17): plain fetch() with default
// verification; the supported intercepting-network option is the runtime env
// NODE_EXTRA_CA_CERTS documented in 01c §6.1 / F-79-B, which this code
// neither sets nor reads. No bypass flags or trust-disabling variables appear in
// this package's sources — that absence is PROOF 3b's subject, so they are not
// named here either (a gate that greps for tokens cannot have them in comments).

import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { randomUUID } from "node:crypto"
import { MODES, PROGRAM_NAME, type ComponentId } from "./constants.ts"
import { ensureDir, tmpDir, toolDir } from "./paths.ts"
import type { LockFile } from "./lockfile.ts"
import { OUTCOME, type OutcomeToken } from "./outcomes.ts"
import {
  computeFileDigest,
  fileMatchesDigest,
  macSignatureCheck,
  parseExpectedDigest,
  type ExpectedDigest,
  type SignatureSpec,
} from "./verify.ts"
import { appendProvenance, type ProvenanceRecord } from "./provenance.ts"

/** Machine-readable failure codes. Mapping to §8 outcome tokens lives in
 *  `outcomeTokenFor` below; exit stays 0/1 per gate D-23. */
export type FetchCode =
  | "REFUSED_HOST_DENIED" // url/redirect host outside the allow-list (P-18)
  | "REFUSED_INSECURE_PROTOCOL" // non-HTTPS url or redirect downgrade (P-17 / row 108 "HTTP downgrade")
  | "FETCH_FAILED" // permanent status (404/403/...), bad redirect, missing body
  | "TIMEOUT" // AbortSignal deadline exceeded (after the single retry)
  | "NETWORK_ERROR" // transport-level exception (after the single retry)
  | "SIZE_EXCEEDED" // body larger than the lock size cap (early or mid-stream)
  | "HASH_MISMATCH" // observed digest != lock digest; abort before any use (P-1)
  | "SERVER_ERROR" // transient server status (429/5xx) survived the single retry
  | "SIGNATURE_FAILED" // codesign/spctl/TeamID gate refused the artifact (§6.1 step 3)
  | "NO_URL_PINNED" // lock carries no reviewed url for this artifact (e.g. D-13 guest image)

export interface ResolvedArtifact {
  readonly component: ComponentId
  /** Lock field/artifact key within the component ("node", "colima", ...). */
  readonly artifact: string
  readonly url: string
  readonly host: string
  readonly version?: string
  readonly expected: ExpectedDigest
  readonly expectedSizeBytes?: number
}

export type ResolveResult = { ok: true; artifact: ResolvedArtifact } | { ok: false; code: FetchCode; message: string }

export type FetchResult =
  | {
      status: "fetched"
      artifact: ResolvedArtifact
      destPath: string
      bytes: number
      attempts: number
      elapsedMs: number
    }
  | { status: "resumed"; artifact: ResolvedArtifact; destPath: string; bytes: number; attempts: 0 }
  | { status: "dry_run"; artifact: ResolvedArtifact; destPath: string; wouldDownload: true }
  | { ok: false; code: FetchCode; message: string; attempts: number }

export interface FetchOptions {
  /** Lock field/artifact key inside the component (required when a component has
   *  several downloadable pins, e.g. runtime.colima / runtime.lima). */
  readonly artifact?: string
  /** Final file name under destDir; defaults to the sanitized last URL segment. */
  readonly destName?: string
  /** Final directory; defaults to ~/.swarm/tools/<component_id> (PC-PATH-08). */
  readonly destDir?: string
  /** Staging root; defaults to ~/.swarm/tmp (PC-PATH-06, 0700, never /tmp). */
  readonly stagingDir?: string
  /** Provenance ledger path; defaults to ~/.swarm/setup/provenance.jsonl. */
  readonly provenancePath?: string
  /** TEST SEAM ONLY: must be a SUBSET of lock.hosts — anything else throws
   *  synchronously, so the seam can never widen what the program may contact.
   *  Tests narrow it to ["127.0.0.1"] to drive a local bun.serve fixture. */
  readonly allowedHosts?: readonly string[]
  /** Whole-operation timeout incl. redirects + retries; default 120 s. */
  readonly timeoutMs?: number
  /** Backoff before the single retry; default 300 ms. */
  readonly retryDelayMs?: number
  /** Cap applied when the pin carries no `size`; default 2 GiB. */
  readonly absoluteCapBytes?: number
  /** macOS signature gate (§6.1 step 3) for executables/apps: runs codesign +
   *  spctl + TeamID check on the verified temp file BEFORE promotion. Omit for
   *  data artifacts (tarballs inspected after extraction by their own step). */
  readonly signature?: SignatureSpec
  /** --dry-run posture (PC-FLAG-03): resume-check only, zero network, zero writes. */
  readonly dryRun?: boolean
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_RETRY_DELAY_MS = 300
const DEFAULT_ABSOLUTE_CAP_BYTES = 2 * 1024 * 1024 * 1024
const MAX_REDIRECT_HOPS = 5
/** Sub-artifact keys of the reviewed lock, in register order; the generic scan
 *  in findPin covers future fields without hard-coding them all. */
const KNOWN_SUB_ARTIFACTS = ["colima", "lima", "docker_cli", "docker_compose", "guest_image", "firecrawl_mcp"] as const
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$/

/** Map a fetch failure onto the §8 outcome taxonomy (gate D-23: exit stays 1 for
 *  all of these; the token carries the specific outcome). */
export function outcomeTokenFor(code: FetchCode): OutcomeToken {
  switch (code) {
    case "TIMEOUT":
    case "NETWORK_ERROR":
      return OUTCOME.BLOCKED_BY_NETWORK // token + PC-ST-09 state, NOT a second exit code
    case "NO_URL_PINNED":
      return OUTCOME.SKIPPED_WITH_INSTRUCTIONS // e.g. D-13: unpinned guest image stops with instructions
    default:
      return OUTCOME.FAILED // refusals + SIZE_EXCEEDED / HASH_MISMATCH / FETCH_FAILED
  }
}

/**
 * THE entry point for step authors (rows 86-92). Contract:
 *   - resolves the pin from the VALIDATED lock (loadLock() output),
 *   - refuses off-list hosts / non-HTTPS before any request,
 *   - returns a resumed result with ZERO network attempts when the destination
 *     file already matches the pinned digest,
 *   - otherwise streams to ~/.swarm/tmp, enforces the size cap, verifies the
 *     digest, fsyncs, and promotes with one rename(2) into the tool dir,
 *   - appends exactly one provenance JSONL record per call (dry-run excluded).
 * Never throws for operational reasons — failures come back as {ok:false, code}.
 * Throws only on programmer error (allowedHosts widening the lock list).
 */
export async function fetchArtifact(
  lock: LockFile,
  componentId: ComponentId,
  opts: FetchOptions = {},
): Promise<FetchResult> {
  const ctx: CallCtx = { lock, componentId, opts, started: Date.now() }
  const allowed = effectiveAllowList(lock, opts)
  const resolved = resolveArtifact(lock, componentId, opts.artifact, allowed)
  if (!resolved.ok) return fail(ctx, resolved.code, resolved.message, 0)

  const artifact = resolved.artifact
  const destPath = join(
    opts.destDir ?? toolDir(componentId),
    opts.destName ?? deriveName(artifact.url, componentId, artifact.artifact),
  )

  // Resume gate (§6.3): hash the existing final file; a match means zero network.
  if (fileMatchesDigest(destPath, artifact.expected)) {
    const bytes = artifact.expectedSizeBytes ?? 0
    appendProvenance(record(ctx, artifact, "resumed", 0, { destPath, downloadedBytes: bytes }), opts.provenancePath)
    return { status: "resumed", artifact, destPath, bytes, attempts: 0 }
  }
  if (opts.dryRun) {
    return { status: "dry_run", artifact, destPath, wouldDownload: true }
  }

  const cap = artifact.expectedSizeBytes ?? opts.absoluteCapBytes ?? DEFAULT_ABSOLUTE_CAP_BYTES
  const deadline = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS

  let current = artifact.url
  let hopsLeft = MAX_REDIRECT_HOPS
  let retriesLeft = 1 // "single backoff retry" — exactly one extra attempt on transient errors
  let attempts = 0
  let lastTransient: { code: FetchCode; message: string } | null = null
  let res: ResponseLike | null = null

  while (true) {
    const guard = guardUrl(current, allowed)
    if (!guard.ok) return fail(ctx, guard.code, guard.message, attempts, artifact)
    try {
      attempts += 1
      res = await fetch(current, { redirect: "manual", signal: deadline })
    } catch (err) {
      const code: FetchCode = err instanceof Error && err.name === "TimeoutError" ? "TIMEOUT" : "NETWORK_ERROR"
      lastTransient = {
        code,
        message: `${code === "TIMEOUT" ? "fetch timed out" : "network error"} for ${current}: ${(err as Error).message}`,
      }
      res = null
    }

    if (res !== null) {
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location")
        if (!location) {
          return fail(
            ctx,
            "FETCH_FAILED",
            `redirect ${res.status} from ${current} carried no Location`,
            attempts,
            artifact,
          )
        }
        let next: string
        try {
          next = resolveRelative(location, current)
        } catch {
          return fail(
            ctx,
            "FETCH_FAILED",
            `redirect from ${current} carried an unparseable Location (${location})`,
            attempts,
            artifact,
          )
        }
        const nextGuard = guardUrl(next, allowed)
        if (!nextGuard.ok) return fail(ctx, nextGuard.code, nextGuard.message, attempts, artifact)
        if (hopsLeft <= 0) {
          return fail(
            ctx,
            "FETCH_FAILED",
            `too many redirects (>${MAX_REDIRECT_HOPS}) following ${artifact.url}`,
            attempts,
            artifact,
          )
        }
        hopsLeft -= 1
        current = next
        continue
      }
      if (res.status === 429 || res.status >= 500) {
        lastTransient = { code: "SERVER_ERROR", message: `server returned ${res.status} for ${current}` }
        res = null
      } else if (!res.ok) {
        return fail(ctx, "FETCH_FAILED", `server returned ${res.status} for ${current}`, attempts, artifact)
      }
    }

    if (res !== null) break // a usable response arrived
    if (retriesLeft > 0) {
      retriesLeft -= 1
      await sleep(retryDelayMs) // spec asks for exactly one retry, so no exponential ladder
      continue
    }
    const t = lastTransient ?? { code: "FETCH_FAILED" as FetchCode, message: `fetch of ${current} failed` }
    return fail(ctx, t.code, t.message, attempts, artifact)
  }

  const written = await writeBodyToTemp(res, cap, opts.stagingDir ?? tmpDir(), artifact)
  if (!written.ok) return fail(ctx, written.code, written.message, attempts, artifact, written.observedHex)

  // Signature gate (§6.1 step 3) on the digest-verified temp, still BEFORE use.
  if (opts.signature) {
    const sig = macSignatureCheck(written.tmpPath, opts.signature)
    if (
      !sig.codesignOk ||
      !sig.spctlOk ||
      (opts.signature.teamId !== undefined && sig.teamId !== opts.signature.teamId)
    ) {
      rmSync(written.tmpPath, { force: true })
      return fail(
        ctx,
        "SIGNATURE_FAILED",
        `signature gate refused ${artifact.component}.${artifact.artifact}: ${sig.detail}`,
        attempts,
        artifact,
        written.digest.hex,
      )
    }
  }

  try {
    fsyncPath(written.tmpPath) // durability BEFORE the commit point (§6.2)
    ensureDir(join(destPath, ".."), MODES.DIR_0700)
    rmSync(destPath, { force: true }) // replace a stale/corrupt final atomically; never leave an old bad file behind
    renameSync(written.tmpPath, destPath) // single atomic move; after THIS line the file is usable
  } catch (err) {
    rmSync(written.tmpPath, { force: true })
    return fail(
      ctx,
      "FETCH_FAILED",
      `cannot promote ${written.tmpPath} to ${destPath}: ${(err as Error).message}`,
      attempts,
      artifact,
      written.digest.hex,
    )
  }

  appendProvenance(
    record(ctx, artifact, "fetched", attempts, {
      destPath,
      downloadedBytes: written.digest.sizeBytes,
      observed: written.digest.hex,
    }),
    opts.provenancePath,
  )
  return {
    status: "fetched",
    artifact,
    destPath,
    bytes: written.digest.sizeBytes,
    attempts,
    elapsedMs: Date.now() - ctx.started,
  }
}

/** Resolve a downloadable pin from the validated lock WITHOUT touching the network:
 *  url present + HTTPS + host allow-listed + expected hash parseable. Steps that
 *  pre-flight pins (and row 83's consent screen) may call this directly. */
export function resolveArtifact(
  lock: LockFile,
  componentId: ComponentId,
  artifactId?: string,
  allowedHosts: readonly string[] = lock.hosts,
): ResolveResult {
  const component = lock.components[componentId]
  if (!component) return { ok: false, code: "FETCH_FAILED", message: `component "${componentId}" is not in the lock` }

  const found = findPin(component, componentId, artifactId)
  if (!found.ok) return { ok: false, code: "FETCH_FAILED", message: found.error }
  const { fieldName, pin } = found

  const rawUrl = pin.url
  if (rawUrl === null) {
    return {
      ok: false,
      code: "NO_URL_PINNED",
      message: `${componentId}.${fieldName}.url is null in the reviewed lock: fetching is forbidden until its closer row fills the pin (D-13)`,
    }
  }
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    return { ok: false, code: "NO_URL_PINNED", message: `${componentId}.${fieldName} carries no reviewed url` }
  }

  const guard = guardUrl(rawUrl, allowedHosts)
  if (!guard.ok) return guard

  const version = typeof pin.version === "string" ? pin.version : undefined
  const expected = extractExpectedDigest(pin)
  if (!expected) {
    return {
      ok: false,
      code: "HASH_MISMATCH",
      message: `${componentId}.${fieldName} has no verifiable hash pin (sha256/tarball_sha256/dmg_sha256/integrity missing or malformed) — refusing to fetch an unverifiable artifact (P-1)`,
    }
  }
  const rawSize = pin.size
  const expectedSizeBytes =
    typeof rawSize === "number" && Number.isInteger(rawSize) && rawSize > 0 ? rawSize : undefined

  return {
    ok: true,
    artifact: {
      component: componentId,
      artifact: fieldName,
      url: rawUrl,
      host: guard.host,
      version,
      expected,
      expectedSizeBytes,
    },
  }
}

// --- internals ---------------------------------------------------------------------

/** The allow-list this call may use: lock.hosts unless a test seam NARROWS it.
 *  Widening past the lock is impossible by construction — synchronous throw. */
function effectiveAllowList(lock: LockFile, opts: FetchOptions): readonly string[] {
  if (!opts.allowedHosts) return lock.hosts
  const lockSet = new Set(lock.hosts.map(normalizeHost))
  for (const h of opts.allowedHosts) {
    if (!lockSet.has(normalizeHost(h))) {
      throw new Error(
        `${PROGRAM_NAME}: allowedHosts may only NARROW the lock allow-list; "${h}" is not in tools.lock.json hosts (P-18)`,
      )
    }
  }
  return opts.allowedHosts
}

/** Parse + enforce HTTPS + allow-list for one URL (P-17 + P-18). */
function guardUrl(
  rawUrl: string,
  allowedHosts: readonly string[],
): { ok: true; host: string } | { ok: false; code: FetchCode; message: string } {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, code: "FETCH_FAILED", message: `not a parseable URL: ${rawUrl}` }
  }
  if (url.protocol !== "https:") {
    return {
      ok: false,
      code: "REFUSED_INSECURE_PROTOCOL",
      message: `refused non-HTTPS url (${url.protocol}) ${rawUrl} — HTTP downgrade is never followed (P-17)`,
    }
  }
  const host = normalizeHost(url.hostname)
  if (!allowedHosts.some((h) => normalizeHost(h) === host)) {
    return {
      ok: false,
      code: "REFUSED_HOST_DENIED",
      message: `refused: host "${host}" is outside the tools.lock.json allow-list (P-18) for url ${rawUrl}`,
    }
  }
  return { ok: true, host }
}

/** Pick the pin object for an artifact within a component entry. With an explicit
 *  id, that field must exist and look like a pin. Without one, exactly ONE
 *  downloadable pin may exist or the call fails closed on ambiguity. Underscore
 *  keys are annotations (the lock's own field_convention) and never pins. */
function findPin(
  component: Record<string, unknown>,
  componentId: string,
  artifactId: string | undefined,
): { ok: true; fieldName: string; pin: Record<string, unknown> } | { ok: false; error: string } {
  if (artifactId !== undefined) {
    if (artifactId === componentId) {
      // explicit self-pin request: the component entry itself is the pin
      return { ok: true, fieldName: artifactId, pin: component }
    }
    const value = component[artifactId]
    if (isPinObject(value)) return { ok: true, fieldName: artifactId, pin: value }
    return { ok: false, error: `no downloadable pin at component field "${artifactId}" (missing or not an object)` }
  }
  const candidates: Array<{ fieldName: string; pin: Record<string, unknown> }> = []
  for (const key of [...KNOWN_SUB_ARTIFACTS, ...Object.keys(component)]) {
    if (key.startsWith("_")) continue
    const value = component[key]
    if (isPinObject(value) && typeof value.url === "string" && value.url.trim() !== "") {
      if (!candidates.some((c) => c.fieldName === key)) candidates.push({ fieldName: key, pin: value })
    }
  }
  // No sub-artifact pins: single-artifact components (node/rtk/obsidian/graft) keep
  // their pin ON the component entry itself — treat that as the one candidate.
  if (candidates.length === 0 && typeof component.url === "string" && component.url.trim() !== "") {
    return { ok: true, fieldName: componentId, pin: component }
  }
  const only = candidates[0]
  if (candidates.length === 1 && only) return { ok: true, ...only }
  if (candidates.length === 0) return { ok: false, error: "component carries no downloadable url pin" }
  return {
    ok: false,
    error: `component has ${candidates.length} downloadable pins (${candidates.map((c) => c.fieldName).join(", ")}); pass the artifact id explicitly`,
  }
}

function isPinObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** First verifiable hash pin found on the artifact object, in the lock's own
 *  field order (spec §5 "Integrity is per-artifact"). Null => unverifiable. */
function extractExpectedDigest(pin: Record<string, unknown>): ExpectedDigest | null {
  for (const field of ["sha256", "tarball_sha256", "dmg_sha256", "integrity"] as const) {
    const value = pin[field]
    if (typeof value !== "string") continue
    const parsed = parseExpectedDigest(value)
    if (parsed) return parsed
  }
  return null
}

/** Stream the body to the staging dir under the size cap, then verify the digest.
 *  The temp file is deleted on EVERY failure path; the final name is never
 *  touched here, so nothing unverified ever becomes usable (P-1). */
async function writeBodyToTemp(
  res: ResponseLike,
  cap: number,
  staging: string,
  artifact: ResolvedArtifact,
): Promise<
  | { ok: true; tmpPath: string; digest: { hex: string; sizeBytes: number } }
  | { ok: false; code: FetchCode; message: string; observedHex?: string }
> {
  const declared = Number(res.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > cap) {
    return {
      ok: false,
      code: "SIZE_EXCEEDED",
      message: `Content-Length ${declared} exceeds the pinned size cap ${cap} for ${artifact.component}.${artifact.artifact} — body not consumed`,
    }
  }
  if (res.body === null) {
    return { ok: false, code: "FETCH_FAILED", message: `response for ${artifact.url} carried no body` }
  }

  ensureDir(staging, MODES.DIR_0700)
  const tmpPath = join(staging, `.dl-${randomUUID()}`)
  const fd = openSync(tmpPath, "w", 0o600) // payload unreadable until committed (0600 inside the 0700 staging dir)
  let total = 0
  try {
    const reader = readChunks(res.body)
    while (true) {
      const next = await reader.next()
      if (next.done === true) break
      const chunk = toBytes(next.value)
      if (total + chunk.byteLength > cap) {
        // fd closes via the finally below; the partial temp goes with the early return here.
        rmSync(tmpPath, { force: true })
        return {
          ok: false,
          code: "SIZE_EXCEEDED",
          message: `streamed past the pinned cap ${cap} for ${artifact.component}.${artifact.artifact} (at ${total + chunk.byteLength} bytes) — download aborted mid-stream`,
        }
      }
      total += chunk.byteLength
      writeAll(fd, chunk)
    }
  } catch (err) {
    rmSync(tmpPath, { force: true }) // a torn stream leaves no partial artifact behind
    const timedOut = err instanceof Error && err.name === "TimeoutError"
    return {
      ok: false,
      code: timedOut ? "TIMEOUT" : "NETWORK_ERROR",
      message: `${timedOut ? "timeout" : "stream error"} while downloading ${artifact.url}: ${(err as Error).message}`,
    }
  } finally {
    closeQuietly(fd)
  }

  if (total === 0) {
    rmSync(tmpPath, { force: true })
    return {
      ok: false,
      code: "FETCH_FAILED",
      message: `downloaded zero bytes for ${artifact.component}.${artifact.artifact}`,
    }
  }
  if (artifact.expectedSizeBytes !== undefined && total !== artifact.expectedSizeBytes) {
    const observed = computeFileDigest(tmpPath, artifact.expected.algorithm)
    rmSync(tmpPath, { force: true })
    return {
      ok: false,
      code: "SIZE_EXCEEDED",
      message: `downloaded ${total} bytes but the lock pins ${artifact.expectedSizeBytes} for ${artifact.component}.${artifact.artifact}`,
      observedHex: observed.hex,
    }
  }

  const digest = computeFileDigest(tmpPath, artifact.expected.algorithm)
  if (digest.hex !== artifact.expected.hex) {
    rmSync(tmpPath, { force: true }) // tampered/truncated artifact destroyed BEFORE any use (P-1)
    return {
      ok: false,
      code: "HASH_MISMATCH",
      message: `observed ${artifact.expected.algorithm} ${digest.hex} does not match the lock pin ${artifact.expected.pin} for ${artifact.component}.${artifact.artifact} — aborting before use`,
      observedHex: digest.hex,
    }
  }
  return { ok: true, tmpPath, digest }
}

interface ChunkReader {
  next(): Promise<{ done?: boolean; value?: unknown }>
}

/** Normalize the two stream-reader protocols: WHATWG getReader().read() (Bun's
 *  fetch body) and the async-iterator protocol (Node web streams). */
function readChunks(body: ReadableStreamLike): ChunkReader {
  const withReader = body as { getReader?: () => { read(): Promise<{ done?: boolean; value?: unknown }> } }
  if (withReader.getReader) {
    const reader = withReader.getReader()
    return { next: () => reader.read() }
  }
  const iterable = body as { [Symbol.asyncIterator]?: () => ChunkReader }
  const it = iterable[Symbol.asyncIterator]
  if (it) return it.call(body)
  throw new Error(`${PROGRAM_NAME}: response body is not a readable stream`)
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  throw new Error(`${PROGRAM_NAME}: expected Uint8Array stream chunks, got ${typeof value}`)
}

function writeAll(fd: number, data: Uint8Array): void {
  let offset = 0
  while (offset < data.byteLength) {
    offset += writeSync(fd, data.subarray(offset)) // writeSync may write partially; loop until the chunk is fully on disk
  }
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd)
  } catch {
    // fd already gone; nothing to close.
  }
}

function fsyncPath(absPath: string): void {
  const fd = openSync(absPath, "r+")
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "") // strip the root-DNS trailing dot if present
}

/** Resolve a redirect Location (absolute or relative) against the current URL.
 *  The cast covers only the types shim: env.d.ts declares the one-argument URL
 *  constructor and this row must not edit it; Bun's runtime supports (input, base). */
function resolveRelative(location: string, base: string): string {
  const Ctor = URL as unknown as { new (input: string, base: string): { href: string } }
  return new Ctor(location, base).href
}

/** Last URL path segment, percent-decoded, restricted to a safe file-name charset;
 *  falls back to "<component>-<artifact>" for anything else (never traversal). */
function deriveName(url: string, component: ComponentId, artifact: string): string {
  const fallback = `${component}-${artifact}`
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return fallback
  }
  const segments = pathname.split("/").filter((s) => s !== "")
  const last = segments[segments.length - 1]
  if (!last) return fallback
  let decoded: string
  try {
    decoded = decodeURIComponent(last)
  } catch {
    return fallback
  }
  return SAFE_NAME_RE.test(decoded) ? decoded : fallback
}

interface CallCtx {
  readonly lock: LockFile
  readonly componentId: ComponentId
  readonly opts: FetchOptions
  readonly started: number
}

function record(
  ctx: CallCtx,
  artifact: ResolvedArtifact,
  outcome: ProvenanceRecord["outcome"],
  attempts: number,
  extra: Partial<ProvenanceRecord>,
): ProvenanceRecord {
  return {
    ts: new Date().toISOString(),
    lockVersion: ctx.lock.version,
    component: artifact.component,
    artifact: artifact.artifact,
    url: artifact.url,
    ...(artifact.version !== undefined ? { version: artifact.version } : {}),
    expected: artifact.expected.pin,
    ...(artifact.expectedSizeBytes !== undefined ? { expectedSizeBytes: artifact.expectedSizeBytes } : {}),
    outcome,
    attempts,
    elapsedMs: Date.now() - ctx.started,
    ...extra,
  }
}

/** Build the failure result AND append its provenance row when a pin had already
 *  resolved (pre-resolution refusals have no url/hash to record). */
function fail(
  ctx: CallCtx,
  code: FetchCode,
  message: string,
  attempts: number,
  artifact?: ResolvedArtifact,
  observedHex?: string,
): { ok: false; code: FetchCode; message: string; attempts: number } {
  if (artifact) {
    const outcome = code === "REFUSED_HOST_DENIED" || code === "REFUSED_INSECURE_PROTOCOL" ? "refused" : "failed"
    appendProvenance(
      record(ctx, artifact, outcome, attempts, {
        code,
        ...(observedHex !== undefined ? { observed: observedHex } : {}),
      }),
      ctx.opts.provenancePath,
    )
  }
  return { ok: false, code, message, attempts }
}
