// Office add-in keychain trust (plan row M3-02; register rev 5 §6.1 rev 3; server-delta spec §7.2, §7.4; SC-23; D3/C22).
//
// Runs `/usr/bin/security` with `execFile` and no shell, in the login keychain only and in the user trust domain:
// no argv ever carries `-d` and none names the System keychain. The argv come from the `certs.ts` builders; this
// module only executes them, checks them once more before each run, and maps exit codes to results.
// Removal is by the recorded SHA-1 (`delete-certificate -Z`), never by name.
//
// The runner is injected (production: `createExecFileRunner()` from `patch-common.ts`, which wraps
// `child_process.execFile` without a shell), so tests never touch the real keychain.
import { homedir } from "node:os"
import { SECURITY_BIN, deleteCertificateArgv, removeTrustArgv, trustArgv, verifyArgv } from "./certs"
import type { OfficeLogSink } from "./key-custody"
import type { PatchRunResult, PatchRunner } from "../patch-common"

/**
 * `add-trusted-cert` and `remove-trusted-cert` may wait on a macOS login-password dialog (U-2); give the user time.
 * F-SG2-3: the removal used the 30 s bound and timed out while the user was still typing the password.
 */
/** @internal test seam */
export const TRUST_TIMEOUT_MS = 180_000
const SECURITY_TIMEOUT_MS = 30_000
const MAX_BUFFER = 64 * 1024
const SOURCE = "office-addin.keychain"

type TrustResult = { ok: true } | { ok: false; code: "CERT_UNTRUSTED" }
type RemovalResult = {
  /** `remove-trusted-cert` exited 0. */
  trustRemoved: boolean
  /** `delete-certificate -Z` exited 0, or reported the item already gone. */
  deleted: boolean
}

export type Keychain = {
  /** `security add-trusted-cert -r trustRoot -p ssl -k <login keychain> <CA cert>`. */
  trust(caCertPath: string): Promise<TrustResult>
  /** `security verify-cert -c <leaf> -p ssl -s localhost`: true only on exit 0. */
  verify(leafCertPath: string): Promise<boolean>
  /** `remove-trusted-cert <CA cert>`, then `delete-certificate -Z <SHA-1> <login keychain>` (always attempted). */
  remove(input: { caCertPath: string; sha1: string }): Promise<RemovalResult>
}

/** Exit code `security delete-certificate` uses for "The specified item could not be found in the keychain." */
const ITEM_NOT_FOUND = 44

/** Refuse anything that could leave the user domain or the login keychain (SC-23), whatever built the argv. */
/** @internal test seam */
export function assertUserDomainArgv(argv: readonly string[]) {
  if (argv.includes("-d")) throw new Error("security argv must not use the admin trust domain (-d)")
  if (argv.some((arg) => arg.startsWith("/Library/Keychains/") || arg.includes("System.keychain"))) {
    throw new Error("security argv must not name the System keychain")
  }
}

export function createKeychain(input: { run: PatchRunner; log: OfficeLogSink; home?: string }): Keychain {
  const home = input.home ?? homedir()
  // Minimal environment: nothing from Swarm's own env (no server password, no API keys) reaches the child.
  const env = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }

  const exec = async (argv: string[], timeoutMs: number): Promise<PatchRunResult> => {
    assertUserDomainArgv(argv)
    const result = await input.run(SECURITY_BIN, argv, { env, timeoutMs, maxBuffer: MAX_BUFFER })
    const context = {
      command: argv[0],
      code: result.code,
      ...(result.failure ? { failure: result.failure } : {}),
      ...(result.startCode ? { startCode: result.startCode } : {}),
    }
    if (result.code === 0) input.log("info", SOURCE, "security command succeeded", context)
    // F-M3-3: `security` stderr is never logged (it can name certificate paths in the home directory); the exit code
    // and a fixed reason carry the diagnosis.
    if (result.code !== 0) input.log("warn", SOURCE, "security command failed", { ...context, reason: "nonzero-exit" })
    return result
  }

  return {
    async trust(caCertPath) {
      const result = await exec(trustArgv(caCertPath, home), TRUST_TIMEOUT_MS)
      if (result.code === 0) return { ok: true }
      input.log("error", SOURCE, "CA trust was not added", { code: result.code, failure: result.failure })
      return { ok: false, code: "CERT_UNTRUSTED" }
    },
    async verify(leafCertPath) {
      const result = await exec(verifyArgv(leafCertPath), SECURITY_TIMEOUT_MS)
      return result.code === 0
    },
    async remove(removal) {
      // Built first: a malformed SHA-1 throws here, before any keychain change.
      const deleteArgv = deleteCertificateArgv(removal.sha1, home)
      const untrust = await exec(removeTrustArgv(removal.caCertPath), TRUST_TIMEOUT_MS)
      const deleted = await exec(deleteArgv, SECURITY_TIMEOUT_MS)
      const result = {
        trustRemoved: untrust.code === 0,
        deleted: deleted.code === 0 || deleted.code === ITEM_NOT_FOUND,
      }
      if (!result.deleted) input.log("error", SOURCE, "CA certificate was not deleted from the login keychain", { code: deleted.code })
      return result
    },
  }
}
