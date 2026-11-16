// Office add-in CA key custody (plan row M3-02; register rev 5 §6.1; SC-21, SC-22; D1/C22, C26(c), C34).
//
// SC-21 (the mode, ST-10 passed): the CA private key is kept only as an Electron `safeStorage` blob in
// `ca/swarm-office-ca.key.enc` (mode 0600). The plaintext PEM lives in memory only, for the length of one issue.
// SC-22 (fallback, only when `safeStorage.isEncryptionAvailable()` is false): no CA key is retained at all; every
// renewal makes a new CA plus leaf and re-trusts it (`renewal.ts`).
// C26(c): a blob that exists but cannot be decrypted (for example after a patch re-signed the bundle and macOS no
// longer hands Swarm its safeStorage key) is the recoverable state "unreadable", not a crash: the caller regenerates
// the CA and leaf and re-trusts.
//
// `safeStorage` is injected, so tests never touch the real Keychain. This module imports no X.509 code.
import { readFile, rm } from "node:fs/promises"
import type { SafeStorage } from "electron"
import type { CertPaths } from "./certs"

export type SafeStorageLike = Pick<SafeStorage, "isEncryptionAvailable" | "encryptString" | "decryptString">

type OfficeLogLevel = "info" | "warn" | "error"
/** Structured, persistent log sink (production: `logging.ts` `write`, an electron-log file). Never pass key material. */
export type OfficeLogSink = (level: OfficeLogLevel, source: string, message: string, context?: Record<string, unknown>) => void

/**
 * - `ok`: the decrypted CA key PEM (keep in memory only).
 * - `absent`: no key file. Normal in the SC-22 mode; in the SC-21 mode the caller reports `CERT_MISSING`.
 * - `unreadable`: a key file exists but cannot be decrypted or is not a key (C26(c): regenerate and re-trust).
 */
type CaKeyRead = { state: "ok"; key: string } | { state: "absent" } | { state: "unreadable" }

export type KeyCustody = {
  /** True in the SC-21 mode (`safeStorage` available): the CA key is retained, encrypted. */
  retained(): boolean
  /** The `writeCa` `encryptKey` callback in the SC-21 mode; undefined in the SC-22 mode (no key file is written). */
  encryptKey(): ((pem: string) => Uint8Array) | undefined
  readCaKey(): Promise<CaKeyRead>
  /** The `renewLeafIfDue` `caKey` callback: the PEM when readable, otherwise undefined. */
  caKey(): Promise<string | undefined>
  /** Delete the key blob (SC-22 rotation, C26(c) recovery before a new CA is written). Idempotent. */
  discard(): Promise<void>
}

const SOURCE = "office-addin.key-custody"
const PEM_KEY = /^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END PRIVATE KEY-----\n?$/

function errorCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : typeof error
}

/**
 * Log-safe fields of a thrown value (F-M3-2): its name and string `code` only. `message` and `stack` are never logged:
 * they are free text that can carry local paths.
 */
export function errorFields(error: unknown) {
  const code = errorCode(error)
  return code ? { name: errorName(error), code } : { name: errorName(error) }
}

export function createKeyCustody(input: { safeStorage: SafeStorageLike; paths: CertPaths; log: OfficeLogSink }): KeyCustody {
  const retained = () => input.safeStorage.isEncryptionAvailable()

  const readCaKey = async (): Promise<CaKeyRead> => {
    const blob = await readFile(input.paths.caKeyEnc).catch((error: unknown) => error)
    if (!(blob instanceof Uint8Array)) {
      if (errorCode(blob) === "ENOENT") return { state: "absent" }
      input.log("error", SOURCE, "CA key blob could not be read", errorFields(blob))
      return { state: "unreadable" }
    }
    if (!retained()) {
      input.log("warn", SOURCE, "CA key blob present but safeStorage is unavailable", { bytes: blob.byteLength })
      return { state: "unreadable" }
    }
    const pem = decrypt(Buffer.from(blob))
    if (pem === undefined) {
      input.log("error", SOURCE, "CA key blob could not be decrypted (recoverable, C26c)", { bytes: blob.byteLength })
      return { state: "unreadable" }
    }
    if (!PEM_KEY.test(pem)) {
      input.log("error", SOURCE, "CA key blob decrypted to something that is not a PKCS#8 PEM (recoverable, C26c)")
      return { state: "unreadable" }
    }
    return { state: "ok", key: pem }
  }

  const decrypt = (blob: Buffer) => {
    // safeStorage.decryptString throws on a foreign or corrupt blob; that is the C26(c) state, not a crash.
    try {
      return input.safeStorage.decryptString(blob)
    } catch {
      return undefined
    }
  }

  return {
    retained,
    encryptKey() {
      if (!retained()) return undefined
      return (pem) => new Uint8Array(input.safeStorage.encryptString(pem))
    },
    readCaKey,
    async caKey() {
      const read = await readCaKey()
      return read.state === "ok" ? read.key : undefined
    },
    async discard() {
      await rm(input.paths.caKeyEnc, { force: true })
      input.log("info", SOURCE, "CA key blob discarded")
    },
  }
}
