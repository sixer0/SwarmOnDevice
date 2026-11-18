// Office add-in certificates (plan row M3-01; register rev 5 §6.1; server-delta spec §7; SC-20, SC-21, SC-22, SC-24).
//
// Main owns this module: it generates the name-constrained local CA and the localhost leaf with the bundled
// `pkijs` + `asn1js`, writes them under `<userData>/office-addin/` with the register's modes, records the CA
// fingerprints for removal by hash, decides leaf renewal against an injected clock, and builds the `security(1)` argv
// for trust, verification and removal. It runs no process: M3-02 (`keychain.ts`) executes the argv with
// `execFile(SECURITY_BIN, argv)` and no shell, and supplies the `safeStorage` seam for the CA key.
//
// Lazy X.509 rule (register §3, IA-5): this module and `pkijs` are loaded only through dynamic `import()` in main.
// It has no top-level side effects: no global `setEngine`, no file access, no timers. The crypto engine is created
// per call and passed to `pkijs` explicitly.
//
// The CA private key is never written as plaintext (SC-21). `writeCa` stores it only through the injected `encryptKey`
// (Electron `safeStorage.encryptString` in production) as `ca/swarm-office-ca.key.enc`; without it (SC-22 fallback,
// `safeStorage.isEncryptionAvailable() === false`) no CA key file is written at all.
import { X509Certificate, createHash } from "node:crypto"
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { BitString, Integer, OctetString, Utf8String } from "asn1js"
import {
  AltName,
  AttributeTypeAndValue,
  AuthorityKeyIdentifier,
  BasicConstraints,
  Certificate,
  CryptoEngine,
  ExtKeyUsage,
  Extension,
  GeneralName,
  GeneralSubtree,
  NameConstraints,
  Time,
} from "pkijs"
import type { LeafTls } from "../office-bridge/protocol"

// ── Register §6.1 values ──

/** @internal test seam */
export const CA_COMMON_NAME = "Swarm Office Add-in Local CA"
const LEAF_COMMON_NAME = "localhost"
const CA_VALIDITY_DAYS = 3650
const LEAF_VALIDITY_DAYS = 397
/** Re-issue the leaf when fewer than this many days remain (SC-25, register §6.1 "Leaf renewal"). */
const LEAF_RENEW_BEFORE_DAYS = 30
export const SECURITY_BIN = "/usr/bin/security"

const DAY_MS = 24 * 60 * 60 * 1000
/** notBefore is backdated by this much to tolerate small clock skew. */
const SKEW_MS = 5 * 60 * 1000
const DIR_MODE = 0o700
const KEY_MODE = 0o600
const PUBLIC_MODE = 0o644
const ALG = { name: "ECDSA", namedCurve: "P-256" } as const

// OIDs (RFC 5280).
const OID = {
  cn: "2.5.4.3",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  subjectAltName: "2.5.29.17",
  nameConstraints: "2.5.29.30",
  subjectKeyId: "2.5.29.14",
  authorityKeyId: "2.5.29.35",
  serverAuth: "1.3.6.1.5.5.7.3.1",
}
// GeneralName CHOICE tags.
const DNS = 2
const IP = 7
// keyUsage bit numbers, RFC 5280 §4.2.1.3.
const KU = { digitalSignature: 0, keyCertSign: 5, cRLSign: 6 }
const IPV4_LOOPBACK = [127, 0, 0, 1]
const IPV6_LOOPBACK = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]

// ── Paths (register §6.1) ──

export type CertPaths = {
  /** `<userData>/office-addin/`, mode 0700. */
  root: string
  /** `ca/`, mode 0700. */
  caDir: string
  /** `tls/`, mode 0700. */
  tlsDir: string
  /** CA certificate PEM, mode 0644. */
  caCert: string
  /** `safeStorage` blob of the CA key PEM, mode 0600 (SC-21). Absent in the SC-22 fallback. */
  caKeyEnc: string
  /** SHA-1 and SHA-256 of the CA, mode 0644. */
  fingerprint: string
  /** Leaf private key PEM, mode 0600. */
  leafKey: string
  /** Leaf certificate PEM, mode 0644. */
  leafCert: string
  /** `ca/previous/`, mode 0700: the old CA kept during a rotation until it is removed from the keychain (F-M3-1). */
  previousDir: string
  /** The old CA certificate PEM, mode 0644 (a certificate only, never a key). */
  previousCert: string
  /** The old CA SHA-1 and SHA-256, mode 0644: what `delete-certificate -Z` removes. */
  previousFingerprint: string
}

/** @internal test seam */
export function certPaths(userDataDir: string): CertPaths {
  const root = join(userDataDir, "office-addin")
  const caDir = join(root, "ca")
  const tlsDir = join(root, "tls")
  return {
    root,
    caDir,
    tlsDir,
    caCert: join(caDir, "swarm-office-ca.cert.pem"),
    caKeyEnc: join(caDir, "swarm-office-ca.key.enc"),
    fingerprint: join(caDir, "fingerprint.json"),
    leafKey: join(tlsDir, "localhost.key.pem"),
    leafCert: join(tlsDir, "localhost.cert.pem"),
    previousDir: join(caDir, "previous"),
    previousCert: join(caDir, "previous", "swarm-office-ca.cert.pem"),
    previousFingerprint: join(caDir, "previous", "fingerprint.json"),
  }
}

// ── Generation ──

/** A freshly generated CA. `key` is the PKCS#8 PEM; keep it in memory only (SC-21). */
type CaMaterial = {
  cert: string
  key: string
}

type CaFingerprint = {
  /** Uppercase hex, no separators; the form `security delete-certificate -Z` takes. */
  sha1: string
  sha256: string
}

function engine() {
  return new CryptoEngine({ name: "swarm-office-certs", crypto: globalThis.crypto })
}

function time(value: Date) {
  // RFC 5280 §4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050.
  return new Time({ type: value.getUTCFullYear() < 2050 ? 0 : 1, value })
}

function name(cn: string) {
  // CN only: pkijs would put several pushed attributes into one multi-valued RDN.
  return new AttributeTypeAndValue({ type: OID.cn, value: new Utf8String({ value: cn }) })
}

function serial() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  // DER INTEGER: positive (top bit clear) and minimal (first byte never 0x00, else a following byte < 0x80 would be
  // a non-minimal encoding that OpenSSL rejects as INVALID_INTEGER; the S1 spike had this 1-in-256 flaw).
  bytes[0] = (bytes[0]! & 0x7f) | 0x40
  return new Integer({ valueHex: bytes })
}

function keyUsage(bits: number[]) {
  // DER BIT STRING in one byte: bit 0 is the most significant bit.
  return new BitString({
    valueHex: new Uint8Array([bits.reduce((acc, bit) => acc | (0x80 >> bit), 0)]),
    unusedBits: 7 - Math.max(...bits),
  })
}

function extension(extnID: string, critical: boolean, value: { toSchema(): { toBER(): ArrayBuffer } }) {
  return new Extension({ extnID, critical, extnValue: value.toSchema().toBER() })
}

function ipName(bytes: number[]) {
  return new GeneralName({ type: IP, value: new OctetString({ valueHex: new Uint8Array(bytes) }) })
}

function subjectKeyId(cert: Certificate) {
  return createHash("sha1").update(cert.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView).digest()
}

function pem(label: string, der: ArrayBuffer) {
  const lines = Buffer.from(der).toString("base64").match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`
}

function der(text: string) {
  return Buffer.from(text.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, ""), "base64")
}

async function newCertificate(input: { cn: string; issuer: string; now: Date; days: number; publicKey: CryptoKey }) {
  const cert = new Certificate()
  cert.version = 2
  cert.serialNumber = serial()
  cert.issuer.typesAndValues.push(name(input.issuer))
  cert.subject.typesAndValues.push(name(input.cn))
  cert.notBefore = time(new Date(input.now.getTime() - SKEW_MS))
  cert.notAfter = time(new Date(input.now.getTime() + input.days * DAY_MS))
  await cert.subjectPublicKeyInfo.importKey(input.publicKey, engine())
  return cert
}

/** Register §6.1 CA profile: P-256/SHA-256, CA:TRUE pathlen 0, keyCertSign + cRLSign, name constraints (SC-20). */
export async function createCa(now: Date): Promise<CaMaterial> {
  const keys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"])
  const cert = await newCertificate({
    cn: CA_COMMON_NAME,
    issuer: CA_COMMON_NAME,
    now,
    days: CA_VALIDITY_DAYS,
    publicKey: keys.publicKey,
  })
  const constraints = new NameConstraints({
    permittedSubtrees: [
      new GeneralSubtree({ base: new GeneralName({ type: DNS, value: "localhost" }) }),
      new GeneralSubtree({ base: ipName([...IPV4_LOOPBACK, 255, 255, 255, 255]) }),
      new GeneralSubtree({ base: ipName([...IPV6_LOOPBACK, ...new Array<number>(16).fill(0xff)]) }),
    ],
  })
  cert.extensions = [
    extension(OID.basicConstraints, true, new BasicConstraints({ cA: true, pathLenConstraint: 0 })),
    new Extension({ extnID: OID.keyUsage, critical: true, extnValue: keyUsage([KU.keyCertSign, KU.cRLSign]).toBER() }),
    extension(OID.nameConstraints, true, constraints),
    new Extension({
      extnID: OID.subjectKeyId,
      critical: false,
      extnValue: new OctetString({ valueHex: subjectKeyId(cert) }).toBER(),
    }),
  ]
  await cert.sign(keys.privateKey, "SHA-256", engine())
  return {
    cert: pem("CERTIFICATE", cert.toSchema(true).toBER()),
    key: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", keys.privateKey)),
  }
}

/** Register §6.1 leaf profile, signed by `ca`. Every call generates a new leaf key (SC-24). */
export async function issueLeaf(ca: CaMaterial, now: Date): Promise<LeafTls> {
  const caCert = Certificate.fromBER(der(ca.cert))
  const caKey = await crypto.subtle.importKey("pkcs8", der(ca.key), ALG, false, ["sign"])
  const keys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"])
  const cert = await newCertificate({
    cn: LEAF_COMMON_NAME,
    issuer: CA_COMMON_NAME,
    now,
    days: LEAF_VALIDITY_DAYS,
    publicKey: keys.publicKey,
  })
  cert.extensions = [
    extension(OID.basicConstraints, true, new BasicConstraints({ cA: false })),
    new Extension({ extnID: OID.keyUsage, critical: true, extnValue: keyUsage([KU.digitalSignature]).toBER() }),
    extension(OID.extKeyUsage, false, new ExtKeyUsage({ keyPurposes: [OID.serverAuth] })),
    extension(
      OID.subjectAltName,
      false,
      new AltName({
        altNames: [new GeneralName({ type: DNS, value: "localhost" }), ipName(IPV4_LOOPBACK), ipName(IPV6_LOOPBACK)],
      }),
    ),
    new Extension({
      extnID: OID.subjectKeyId,
      critical: false,
      extnValue: new OctetString({ valueHex: subjectKeyId(cert) }).toBER(),
    }),
    extension(
      OID.authorityKeyId,
      false,
      new AuthorityKeyIdentifier({ keyIdentifier: new OctetString({ valueHex: subjectKeyId(caCert) }) }),
    ),
  ]
  await cert.sign(caKey, "SHA-256", engine())
  return {
    cert: pem("CERTIFICATE", cert.toSchema(true).toBER()),
    key: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", keys.privateKey)),
  }
}

export function fingerprint(certPem: string): CaFingerprint {
  const bytes = der(certPem)
  return {
    sha1: createHash("sha1").update(bytes).digest("hex").toUpperCase(),
    sha256: createHash("sha256").update(bytes).digest("hex").toUpperCase(),
  }
}

// ── Renewal decision (SC-24, SC-25) ──

/**
 * True when the leaf must be re-issued at `now`: it is missing, unreadable, not issued by `caPem` (when given), or
 * fewer than LEAF_RENEW_BEFORE_DAYS remain. The clock is injected so tests and the 24 h timer share one rule.
 */
export function leafRenewalDue(input: { leafPem: string | undefined; now: Date; caPem?: string }) {
  if (!input.leafPem) return true
  const leaf = parse(input.leafPem)
  if (!leaf) return true
  if (input.caPem) {
    const ca = parse(input.caPem)
    if (!ca) return true
    if (!leaf.checkIssued(ca) || !leaf.verify(ca.publicKey)) return true
  }
  return new Date(leaf.validTo).getTime() - input.now.getTime() < LEAF_RENEW_BEFORE_DAYS * DAY_MS
}

function parse(text: string) {
  // A corrupt PEM means "renew", not a crash; X509Certificate has no non-throwing parser.
  try {
    return new X509Certificate(text)
  } catch {
    return undefined
  }
}

// ── Files (register §6.1 paths and modes; temp-then-rename, S-22) ──

async function writeAtomic(path: string, data: string | Uint8Array, mode: number) {
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temp, data, { mode })
  await chmod(temp, mode) // writeFile's mode is masked by umask
  await rename(temp, path)
}

/**
 * Thrown when a certificate directory exists but is a symlink or not a directory (F-M3-4; same rule as the bridge's
 * `prepareBridgeDataDir`, register §7.6 DATA_DIR_UNSAFE). Main never writes through such a path.
 */
export class CertDirUnsafeError extends Error {
  readonly code = "DATA_DIR_UNSAFE"
  constructor(readonly entry: string) {
    super("certificate directory is a symlink or not a directory")
    this.name = "CertDirUnsafeError"
  }
}

async function ensureDir(dir: string, entry: string) {
  // lstat, not stat: a pre-placed symlink must be refused, not followed by mkdir/chmod.
  const existing = await lstat(dir).catch(() => undefined)
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) throw new CertDirUnsafeError(entry)
  if (!existing) await mkdir(dir, { recursive: true, mode: DIR_MODE })
  await chmod(dir, DIR_MODE)
}

/**
 * Create `office-addin/`, `ca/` and `tls/` with mode 0700, tightening any that already exist. Each level is checked
 * with `lstat` first and a symlink or non-directory throws `CertDirUnsafeError` before anything is created or written.
  * @internal test seam
 */
export async function ensureCertDirs(paths: CertPaths) {
  await ensureDir(paths.root, ".")
  await ensureDir(paths.caDir, "ca")
  await ensureDir(paths.tlsDir, "tls")
}

/** Write the old CA certificate and its fingerprint to `ca/previous/` (rotation step 1, F-M3-1). */
export async function writePreviousCa(paths: CertPaths, caPem: string, print: CaFingerprint) {
  await ensureCertDirs(paths)
  await ensureDir(paths.previousDir, "ca/previous")
  await writeAtomic(paths.previousCert, caPem, PUBLIC_MODE)
  await writeAtomic(paths.previousFingerprint, JSON.stringify(print, null, 2) + "\n", PUBLIC_MODE)
}

/**
 * Write the CA certificate (0644) and `fingerprint.json`; returns the fingerprint. The CA key is stored only as
 * `encryptKey(pem)` in `caKeyEnc` (0600, SC-21). With no `encryptKey` (SC-22 fallback) no key file is written.
 */
export async function writeCa(input: {
  paths: CertPaths
  ca: CaMaterial
  encryptKey?: (pem: string) => Uint8Array
}): Promise<CaFingerprint> {
  await ensureCertDirs(input.paths)
  const print = fingerprint(input.ca.cert)
  await writeAtomic(input.paths.caCert, input.ca.cert, PUBLIC_MODE)
  await writeAtomic(input.paths.fingerprint, JSON.stringify(print, null, 2) + "\n", PUBLIC_MODE)
  if (input.encryptKey) await writeAtomic(input.paths.caKeyEnc, input.encryptKey(input.ca.key), KEY_MODE)
  return print
}

/** Write the leaf key (0600) and certificate (0644). Key first, so a cert on disk never points to a stale key. */
export async function writeLeaf(paths: CertPaths, leaf: LeafTls) {
  await ensureCertDirs(paths)
  await writeAtomic(paths.leafKey, leaf.key, KEY_MODE)
  await writeAtomic(paths.leafCert, leaf.cert, PUBLIC_MODE)
}

export async function readFingerprint(paths: CertPaths): Promise<CaFingerprint | undefined> {
  return readFingerprintFile(paths.fingerprint)
}

/** Read and validate a `fingerprint.json` (the current one or `ca/previous/`). */
export async function readFingerprintFile(path: string): Promise<CaFingerprint | undefined> {
  const value: unknown = await readFile(path, "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => undefined)
  if (typeof value !== "object" || value === null) return undefined
  if (!("sha1" in value) || !("sha256" in value)) return undefined
  if (typeof value.sha1 !== "string" || !/^[0-9A-F]{40}$/.test(value.sha1)) return undefined
  if (typeof value.sha256 !== "string" || !/^[0-9A-F]{64}$/.test(value.sha256)) return undefined
  return { sha1: value.sha1, sha256: value.sha256 }
}

async function readText(path: string) {
  return readFile(path, "utf8").catch(() => undefined)
}

/**
 * Renewal step for a retained CA (SC-21 mode): if the leaf is due at `now`, issue a new leaf (new key) with the CA
 * key PEM that `caKey()` returns (decrypted by M3-02, in memory only) and write it. The CA files are never touched.
 * Returns the leaf to send in `tls-update` when renewed. `CERT_MISSING` when the CA certificate or key is unavailable.
 */
export async function renewLeafIfDue(input: {
  paths: CertPaths
  now: Date
  caKey: () => Promise<string | undefined>
}): Promise<{ renewed: true; leaf: LeafTls } | { renewed: false } | { error: "CERT_MISSING" }> {
  const caPem = await readText(input.paths.caCert)
  if (!caPem) return { error: "CERT_MISSING" }
  if (!leafRenewalDue({ leafPem: await readText(input.paths.leafCert), now: input.now, caPem })) {
    return { renewed: false }
  }
  const key = await input.caKey()
  if (!key) return { error: "CERT_MISSING" }
  const leaf = await issueLeaf({ cert: caPem, key }, input.now)
  await writeLeaf(input.paths, leaf)
  return { renewed: true, leaf }
}

// ── security(1) argv builders (register §6.1 rev 3; D3, C22; SC-23). Built only; executed by M3-02. ──
// Login keychain only, user trust domain: no argv here ever contains `-d`.

function loginKeychain(home = homedir()) {
  return join(home, "Library", "Keychains", "login.keychain-db")
}

/** `security add-trusted-cert -r trustRoot -p ssl -k <login keychain> <CA cert path>`. */
export function trustArgv(caCertPath: string, home = homedir()) {
  return ["add-trusted-cert", "-r", "trustRoot", "-p", "ssl", "-k", loginKeychain(home), caCertPath]
}

/** `security verify-cert -c <leaf cert> -p ssl -s localhost` (server-delta spec §7.2): exit 0 when trusted. */
export function verifyArgv(leafCertPath: string) {
  return ["verify-cert", "-c", leafCertPath, "-p", "ssl", "-s", LEAF_COMMON_NAME]
}

/** `security remove-trusted-cert <CA cert path>` (user domain). */
export function removeTrustArgv(caCertPath: string) {
  return ["remove-trusted-cert", caCertPath]
}

/** `security delete-certificate -Z <SHA-1> <login keychain>`: removal by recorded hash, never by name. */
export function deleteCertificateArgv(sha1: string, home = homedir()) {
  if (!/^[0-9A-F]{40}$/.test(sha1)) throw new Error("delete-certificate needs a 40-digit uppercase SHA-1")
  return ["delete-certificate", "-Z", sha1, loginKeychain(home)]
}
