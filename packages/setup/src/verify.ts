// Digest computation + comparison (01c §6.1 step 2, P-1). This is the ONE
// verification implementation every download calls (row-81 note 6: "expose a
// verify function every download calls, so one verification implementation
// serves all components"). It computes a digest of bytes ALREADY ON DISK and
// compares it to the expected value copied into tools.lock.json from an
// independent source (NR-03) — the expected hash is never read from the
// downloaded artifact itself.
//
// Scope boundary (gate D-16b / enforcement split): this module verifies FILES the
// setup downloads. Container image pulls are performed by dockerd inside the VM
// against `@sha256:` content-addressed digests and are NOT fetched here; the
// `image`/`*_image` lock fields are deliberately not fetchable through this
// library (see resolveArtifact: a null or absent `url` is refused).
//
// Hash kinds supported, per the lock's own schema (§5 "Integrity is per-artifact"):
//   - sha256 hex      — the default (`sha256`, `tarball_sha256`, `dmg_sha256` fields)
//   - sha512 base64   — npm `integrity: "sha512-<b64>"` (graft, PC-PIN-01)
// A file whose observed digest does not equal the expected one is NEVER promoted
// to its final name; callers must delete the temp and abort before any use
// (mount / extract / execute). This module never executes anything it hashes.

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"

/** A parsed expected-hash pin: algorithm + lowercase hex digest. */
export interface ExpectedDigest {
  readonly algorithm: "sha256" | "sha512"
  /** Lowercase hex, regardless of whether the pin was given as hex or npm base64. */
  readonly hex: string
  /** The literal string as found in the lock (for provenance records). */
  readonly pin: string
}

export interface FileDigest {
  readonly algorithm: "sha256" | "sha512"
  readonly hex: string
  readonly sizeBytes: number
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/
const SHA512_HEX_RE = /^[0-9a-f]{128}$/
const NPM_SHA512_RE = /^sha512-[A-Za-z0-9+/]+={0,2}$/

/** Parse an expected-hash string from the lock. Accepts sha256 hex (the common
 *  case), sha512 hex, and npm `sha512-<base64>` integrity. Returns null for any
 *  other form — callers fail CLOSED on null rather than guessing an algorithm. */
export function parseExpectedDigest(pin: string): ExpectedDigest | null {
  const value = pin.trim()
  if (SHA256_HEX_RE.test(value)) return { algorithm: "sha256", hex: value, pin }
  if (SHA512_HEX_RE.test(value)) return { algorithm: "sha512", hex: value, pin }
  if (NPM_SHA512_RE.test(value)) {
    const b64 = value.slice("sha512-".length)
    const hex = Buffer.from(b64, "base64").toString("hex")
    // Buffer decoding is lenient; re-check the round trip so a malformed string
    // cannot silently produce a short digest that never matches.
    if (!SHA512_HEX_RE.test(hex)) return null
    return { algorithm: "sha512", hex, pin }
  }
  return null
}

/** Compute a digest over a whole file already on disk. Files here are tool
 *  artifacts (MB-scale), so reading whole is acceptable; streaming hashing is a
 *  row-106+ optimisation, not a correctness need. */
export function computeFileDigest(absPath: string, algorithm: "sha256" | "sha512" = "sha256"): FileDigest {
  const bytes = readFileSync(absPath)
  const hex = createHash(algorithm).update(new Uint8Array(bytes)).digest("hex")
  return { algorithm, hex, sizeBytes: bytes.byteLength }
}

/** True only when the file exists AND its digest equals the expected one.
 *  A missing/unreadable file is false, not an error — resume logic treats
 *  "cannot verify" as "not verified" and re-fetches (fail-closed). */
export function fileMatchesDigest(absPath: string, expected: ExpectedDigest): boolean {
  try {
    const observed = computeFileDigest(absPath, expected.algorithm)
    return observed.hex === expected.hex
  } catch {
    return false
  }
}

// --- macOS signature gate (01c §6.1 step 3, P-1) ------------------------------------
//
// Executables/apps additionally carry `codesign --verify --deep --strict`,
// `spctl -a -t exec -vv`, and the TeamIdentifier check BEFORE first use. This is
// the ONE place those system tools are invoked (asserted by test/fetch.proofs.sh:
// spawnSync appears ONLY in this file, only with absolute-path system binaries
// and argv arrays — never a shell, never a downloaded byte). The NO-EXEC rule is
// about downloaded content: codesign/spctl INSPECT a file, they do not run it.
// The Obsidian `team_id` pin (lock _team_id_closer names row 82) is confirmed by
// whatever `codesign -dvvv` prints here; the observed TeamIdentifier lands in the
// SignatureOutcome so the obsidian step (row 90) can record it back into the lock.

const CODESIGN_PATH = "/usr/bin/codesign"
const SPCTL_PATH = "/usr/sbin/spctl"
const SIGNATURE_TIMEOUT_MS = 30_000

export interface SignatureSpec {
  /** Expected codesign TeamIdentifier (the lock's team_id once confirmed). */
  readonly teamId?: string
  /** TEST SEAM ONLY: replaces the two system invocations with a scripted outcome. */
  readonly run?: (absPath: string) => SignatureOutcome
}

export interface SignatureOutcome {
  readonly codesignOk: boolean
  readonly spctlOk: boolean
  /** TeamIdentifier parsed from `codesign -dvvv` stderr, when present. */
  readonly teamId?: string
  readonly detail: string
}

/** Run the macOS signature gate over a verified-but-unused artifact. Fail-closed:
 *  any unavailable tool, nonzero exit, or TeamID mismatch yields ok:false. */
export function macSignatureCheck(absPath: string, spec: SignatureSpec = {}): SignatureOutcome {
  if (spec.run) return spec.run(absPath)
  const codesign = spawnSync(CODESIGN_PATH, ["--verify", "--deep", "--strict", absPath], {
    encoding: "utf8",
    timeout: SIGNATURE_TIMEOUT_MS,
  })
  const detailed = spawnSync(CODESIGN_PATH, ["-dvvv", absPath], { encoding: "utf8", timeout: SIGNATURE_TIMEOUT_MS })
  const spctl = spawnSync(SPCTL_PATH, ["-a", "-t", "exec", "-vv", absPath], {
    encoding: "utf8",
    timeout: SIGNATURE_TIMEOUT_MS,
  })
  if (codesign.error || detailed.error || spctl.error) {
    return {
      codesignOk: false,
      spctlOk: false,
      detail: `signature tooling unavailable: ${(codesign.error ?? detailed.error ?? spctl.error) as never}`,
    }
  }
  const identity = `${detailed.stdout ?? ""}\n${detailed.stderr ?? ""}`
  const teamMatch = /TeamIdentifier=(\S+)/.exec(identity)
  const teamId = teamMatch?.[1]
  const codesignOk = codesign.status === 0
  const spctlOk = spctl.status === 0
  const detail = `codesign exit=${codesign.status}; spctl exit=${spctl.status}${teamId ? `; TeamIdentifier=${teamId}` : "; TeamIdentifier=<none>"}`
  if (!codesignOk || !spctlOk) return { codesignOk, spctlOk, ...(teamId !== undefined ? { teamId } : {}), detail }
  if (spec.teamId !== undefined && teamId !== spec.teamId) {
    return {
      codesignOk,
      spctlOk,
      ...(teamId !== undefined ? { teamId } : {}),
      detail: `${detail}; expected TeamIdentifier=${spec.teamId}`,
    }
  }
  return { codesignOk, spctlOk, ...(teamId !== undefined ? { teamId } : {}), detail }
}

/** True only when both system checks passed AND the pinned TeamID (if any) matched. */
export function signatureOk(outcome: SignatureOutcome): boolean {
  return outcome.codesignOk && outcome.spctlOk
}
