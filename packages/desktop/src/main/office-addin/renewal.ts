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
import { readFile, rm, writeFile } from "node:fs/promises"
import {
  createCa,
  fingerprint,
  issueLeaf,
  leafRenewalDue,
  readFingerprint,
  renewLeafIfDue,
  writeCa,
  writeLeaf,
} from "./certs"
import type { CertPaths } from "./certs"
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
  | { action: "failed"; code: "CERT_MISSING" | "CERT_UNTRUSTED" }

async function readText(path: string) {
  return readFile(path, "utf8").catch(() => undefined)
}

/** One renewal check at `now` (bridge start and every 24 h). Never throws for an expected state. */
export async function checkLeaf(deps: RenewalDeps, now: Date): Promise<RenewalResult> {
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
 * New CA plus leaf (SC-22 renewal, C26(c) recovery). Order: generate in memory, keep the old CA certificate aside,
 * write the new CA (encrypted key only when safeStorage is available) and leaf, trust the new CA, remove the old CA by
 * hash, send `tls-update`. The old CA is removed even when the new trust is refused: it no longer signs anything and
 * would otherwise stay trusted with no record of its hash.
 */
async function rotateCa(
  deps: RenewalDeps,
  now: Date,
  reason: "no-retained-key" | "key-unreadable",
  oldCaPem: string,
): Promise<RenewalResult> {
  deps.log("warn", SOURCE, "rotating the local CA", { reason })
  const oldPrint = (await readFingerprint(deps.paths)) ?? fingerprint(oldCaPem)
  const ca = await createCa(now)
  const leaf: LeafTls = await issueLeaf(ca, now)
  await deps.custody.discard()
  const newPrint = await writeCa({ paths: deps.paths, ca, encryptKey: deps.custody.encryptKey() })
  await writeLeaf(deps.paths, leaf)

  const trust = await deps.keychain.trust(deps.paths.caCert)
  const oldRemoved = newPrint.sha1 === oldPrint.sha1 ? true : await removeOldCa(deps, oldCaPem, oldPrint.sha1)
  deps.send(buildTlsUpdateCommand(leaf))
  if (!trust.ok) {
    deps.log("error", SOURCE, "new CA not trusted after rotation", { code: trust.code, reason })
    return { action: "failed", code: "CERT_UNTRUSTED" }
  }
  deps.log("info", SOURCE, "local CA rotated", { reason, oldRemoved })
  return { action: "rotated", reason, trusted: true, oldRemoved }
}

async function removeOldCa(deps: RenewalDeps, oldCaPem: string, sha1: string) {
  // `remove-trusted-cert` takes a certificate file; the old one was replaced on disk, so a public copy is written
  // next to it for the call and deleted afterwards (a certificate, never a key).
  const path = `${deps.paths.caCert}.old-${crypto.randomUUID()}.pem`
  await writeFile(path, oldCaPem, { mode: 0o644 })
  const removal = await deps.keychain.remove({ caCertPath: path, sha1 }).finally(() => rm(path, { force: true }))
  return removal.deleted
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
        input.deps.log("error", SOURCE, "renewal check threw", {
          name: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        })
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
