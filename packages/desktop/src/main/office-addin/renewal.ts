// Office add-in leaf renewal and the 24 h timer (plan row M3-02; server-delta spec §7.3; SC-21, SC-22, SC-24, SC-25;
// C26(c); TR-4).
//
// `checkLeaf` is the one renewal step used at bridge start (M7-04) and by the timer:
// - leaf still good: nothing.
// - due, CA key readable (SC-21): new leaf with a new key, written, then `tls-update` is sent; no prompt.
// - due, no CA key retained (SC-22, safeStorage unavailable) or the blob is unreadable (C26(c), e.g. after a patch):
//   a new CA plus leaf, trusted in the login keychain (one prompt), the old CA removed by its recorded SHA-1, then
//   `tls-update`.
// - CA certificate missing, or the key file missing in the SC-21 mode: `CERT_MISSING` (recovery: Disable, Enable).
//
// The timer takes an injected clock (TR-4: no fake timers); production uses `systemClock`, whose interval is unref'd.
// This module imports `certs.ts` (and so `pkijs`) statically: it must itself be loaded by dynamic `import()` (IA-5).
import { readFile, rm } from "node:fs/promises"
import {
  CertDirUnsafeError,
  createCa,
  fingerprint,
  issueLeaf,
  leafRenewalDue,
  readFingerprint,
  readFingerprintFile,
  renewLeafIfDue,
  writeCa,
  writeLeaf,
  writePreviousCa,
} from "./certs"
import type { CertPaths } from "./certs"
import { errorFields } from "./key-custody"
import type { KeyCustody, OfficeLogSink } from "./key-custody"
import type { Keychain } from "./keychain"
import { buildTlsUpdateCommand } from "../office-bridge/protocol"
import type { BridgeTlsUpdateCommand, LeafTls } from "../office-bridge/protocol"

export const RENEWAL_INTERVAL_MS = 24 * 60 * 60 * 1000
const SOURCE = "office-addin.renewal"

export type RenewalDeps = {
  paths: CertPaths
  custody: KeyCustody
  keychain: Keychain
  /** Delivers `tls-update` to the bridge (SD-RC-6); the leaf key travels only in this in-memory message. */
  send: (command: BridgeTlsUpdateCommand) => void
  log: OfficeLogSink
}

export type RenewalResult =
  | { action: "none" }
  | { action: "renewed" }
  | { action: "rotated"; reason: "no-retained-key" | "key-unreadable"; trusted: boolean; oldRemoved: boolean }
  | { action: "failed"; code: "CERT_MISSING" | "CERT_UNTRUSTED" | "DATA_DIR_UNSAFE" }

/** Outcome of `finishPendingRemoval`. */
export type PendingRemoval = "none" | "dropped" | "removed" | "kept"

async function readText(path: string) {
  return readFile(path, "utf8").catch(() => undefined)
}

/**
 * One renewal check at `now` (bridge start and every 24 h). It first finishes any CA removal a crashed rotation left
 * in `ca/previous/` (F-M3-1). Never throws for an expected state; a symlinked or non-directory certificate path is
 * `DATA_DIR_UNSAFE` (F-M3-4) and nothing is written through it.
 */
export async function checkLeaf(deps: RenewalDeps, now: Date): Promise<RenewalResult> {
  return runCheck(deps, now).catch((error: unknown) => {
    if (!(error instanceof CertDirUnsafeError)) throw error
    deps.log("error", SOURCE, "certificate directory is unsafe", { code: error.code, entry: error.entry })
    return { action: "failed", code: "DATA_DIR_UNSAFE" } as const
  })
}

async function runCheck(deps: RenewalDeps, now: Date): Promise<RenewalResult> {
  await finishPendingRemoval(deps)
  const caPem = await readText(deps.paths.caCert)
  if (!caPem) {
    deps.log("error", SOURCE, "CA certificate missing", { code: "CERT_MISSING" })
    return { action: "failed", code: "CERT_MISSING" }
  }
  if (!leafRenewalDue({ leafPem: await readText(deps.paths.leafCert), now, caPem })) return { action: "none" }

  const key = await deps.custody.readCaKey()
  if (key.state === "ok") return renewWithRetainedKey(deps, now, key.key)
  if (key.state === "unreadable") return rotateCa(deps, now, "key-unreadable", caPem)
  if (!deps.custody.retained()) return rotateCa(deps, now, "no-retained-key", caPem)
  deps.log("error", SOURCE, "CA key missing in the retained-key mode", { code: "CERT_MISSING" })
  return { action: "failed", code: "CERT_MISSING" }
}

async function renewWithRetainedKey(deps: RenewalDeps, now: Date, caKey: string): Promise<RenewalResult> {
  const result = await renewLeafIfDue({ paths: deps.paths, now, caKey: async () => caKey })
  if ("error" in result) return { action: "failed", code: result.error }
  if (!result.renewed) return { action: "none" }
  deps.send(buildTlsUpdateCommand(result.leaf))
  deps.log("info", SOURCE, "leaf renewed with the retained CA key")
  return { action: "renewed" }
}

/**
 * New CA plus leaf (SC-22 renewal, C26(c) recovery). Crash-safe order (F-M3-1):
 * 1. the old CA certificate and its fingerprint go to `ca/previous/` before anything is replaced;
 * 2. the new CA (encrypted key only when safeStorage is available) and leaf are written;
 * 3. the new CA is trusted;
 * 4. the old CA is removed from the login keychain by its SHA-1, then `ca/previous/` is deleted;
 * 5. `tls-update` is sent.
 * A crash anywhere after step 1 leaves `ca/previous/`, and the next `checkLeaf` (bridge start) finishes step 4. The old
 * CA is removed even when the new trust is refused: it no longer signs anything.
 */
async function rotateCa(
  deps: RenewalDeps,
  now: Date,
  reason: "no-retained-key" | "key-unreadable",
  oldCaPem: string,
): Promise<RenewalResult> {
  deps.log("warn", SOURCE, "rotating the local CA", { reason })
  await writePreviousCa(deps.paths, oldCaPem, (await readFingerprint(deps.paths)) ?? fingerprint(oldCaPem))
  const ca = await createCa(now)
  const leaf: LeafTls = await issueLeaf(ca, now)
  await deps.custody.discard()
  await writeCa({ paths: deps.paths, ca, encryptKey: deps.custody.encryptKey() })
  await writeLeaf(deps.paths, leaf)

  const trust = await deps.keychain.trust(deps.paths.caCert)
  const oldRemoved = (await finishPendingRemoval(deps)) === "removed"
  deps.send(buildTlsUpdateCommand(leaf))
  if (!trust.ok) {
    deps.log("error", SOURCE, "new CA not trusted after rotation", { code: trust.code, reason })
    return { action: "failed", code: "CERT_UNTRUSTED" }
  }
  deps.log("info", SOURCE, "local CA rotated", { reason, oldRemoved })
  return { action: "rotated", reason, trusted: true, oldRemoved }
}

/**
 * Finish a rotation's old-CA removal from `ca/previous/` (F-M3-1). Also for Disable (M7-03) before it removes the
 * current CA.
 * - no backup: `none`.
 * - incomplete backup, or the backup is still the current CA (the crash came before the new CA was written):
 *   the backup is dropped and nothing is removed from the keychain (`dropped`).
 * - otherwise `remove-trusted-cert` + `delete-certificate -Z <recorded SHA-1>`; the backup is deleted only when the
 *   delete succeeded (`removed`), else kept for the next check (`kept`).
 */
export async function finishPendingRemoval(deps: RenewalDeps): Promise<PendingRemoval> {
  const pending = await readFingerprintFile(deps.paths.previousFingerprint)
  const pendingCert = await readText(deps.paths.previousCert)
  if (!pending || !pendingCert) {
    // An empty or half-written backup means the crash came before the CA was replaced: nothing to remove.
    await rm(deps.paths.previousDir, { recursive: true, force: true })
    if (!pending && !pendingCert) return "none"
    deps.log("warn", SOURCE, "incomplete CA backup dropped", { reason: "backup-incomplete" })
    return "dropped"
  }
  if ((await readFingerprint(deps.paths))?.sha1 === pending.sha1) {
    await rm(deps.paths.previousDir, { recursive: true, force: true })
    deps.log("info", SOURCE, "CA backup dropped: the CA was not replaced", { reason: "rotation-not-applied" })
    return "dropped"
  }
  const removal = await deps.keychain.remove({ caCertPath: deps.paths.previousCert, sha1: pending.sha1 })
  if (!removal.deleted) {
    deps.log("error", SOURCE, "old CA still in the login keychain; kept for retry", { reason: "old-ca-delete-failed" })
    return "kept"
  }
  await rm(deps.paths.previousDir, { recursive: true, force: true })
  deps.log("info", SOURCE, "old CA removed from the login keychain", { trustRemoved: removal.trustRemoved })
  return "removed"
}

// ── 24 h timer (SC-25) ──

export type RenewalClock = {
  now(): Date
  /** Call `tick` every `ms`; returns a cancel function. */
  every(ms: number, tick: () => void): () => void
}

export const systemClock: RenewalClock = {
  now: () => new Date(),
  every(ms, tick) {
    const timer = setInterval(tick, ms)
    timer.unref?.()
    return () => clearInterval(timer)
  },
}

export type RenewalTimer = {
  /** Resolves when an in-flight check (if any) has settled. */
  idle(): Promise<void>
  stop(): void
}

/**
 * Re-check the leaf every 24 h while the bridge runs. Overlapping ticks are skipped; failures are logged and reported
 * through `onResult` (the controller shows `CERT_MISSING` / `CERT_UNTRUSTED` in the menu) and never stop the timer.
 */
export function startRenewalTimer(input: {
  deps: RenewalDeps
  clock: RenewalClock
  intervalMs?: number
  onResult?: (result: RenewalResult) => void
}): RenewalTimer {
  const state: { running: Promise<void> | undefined; stopped: boolean } = { running: undefined, stopped: false }

  const tick = () => {
    if (state.stopped || state.running) return
    state.running = checkLeaf(input.deps, input.clock.now())
      .then((result) => {
        if (!state.stopped) input.onResult?.(result)
      })
      .catch((error: unknown) => {
        // F-M3-2: name and code with a fixed reason only; never message or stack (free text with local paths).
        input.deps.log("error", SOURCE, "renewal check threw", { ...errorFields(error), reason: "check-threw" })
        if (!state.stopped) input.onResult?.({ action: "failed", code: "CERT_MISSING" })
      })
      .finally(() => {
        state.running = undefined
      })
  }

  const cancel = input.clock.every(input.intervalMs ?? RENEWAL_INTERVAL_MS, tick)
  return {
    idle: async () => {
      await state.running
    },
    stop() {
      state.stopped = true
      cancel()
    },
  }
}
