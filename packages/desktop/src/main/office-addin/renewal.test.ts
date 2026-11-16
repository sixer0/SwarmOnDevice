// Plan row M3-02: leaf renewal and the 24 h timer (SC-21, SC-22, SC-24, SC-25, C26(c); ST-12 clock tick; TR-4: an
// injected clock, no fake timers). safeStorage and the keychain are fakes.
// Set OFFICE_ADDIN_TEST_ROOT to keep the temp dirs for the "grep BEGIN PRIVATE KEY" check after the run.
import { afterAll, describe, expect, test } from "bun:test"
import { X509Certificate } from "node:crypto"
import { mkdir, mkdtemp, readdir, rename, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  certPaths,
  createCa,
  fingerprint,
  issueLeaf,
  readFingerprint,
  readFingerprintFile,
  writeCa,
  writeLeaf,
  writePreviousCa,
} from "./certs"
import type { CertPaths } from "./certs"
import { createKeyCustody } from "./key-custody"
import type { OfficeLogSink, SafeStorageLike } from "./key-custody"
import type { Keychain } from "./keychain"
import { RENEWAL_INTERVAL_MS, checkLeaf, finishPendingRemoval, startRenewalTimer } from "./renewal"
import type { RenewalClock, RenewalDeps, RenewalResult } from "./renewal"
import type { BridgeTlsUpdateCommand } from "../office-bridge/protocol"

const DAY = 24 * 60 * 60 * 1000
const T0 = new Date("2026-11-16T00:00:00Z")
const at = (days: number) => new Date(T0.getTime() + days * DAY)
const dirs: string[] = []
const keep = Boolean(process.env.OFFICE_ADDIN_TEST_ROOT)

afterAll(async () => {
  if (keep) return
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempPaths() {
  const base = process.env.OFFICE_ADDIN_TEST_ROOT ?? process.env.TMPDIR ?? tmpdir()
  await mkdir(base, { recursive: true })
  const dir = await mkdtemp(join(base, "swarm-renewal-test-"))
  dirs.push(dir)
  return certPaths(dir)
}

function fakeSafeStorage(input: { available: boolean; secret: string }): SafeStorageLike {
  const prefix = Buffer.from(`v10${input.secret}:`)
  const xor = (bytes: Buffer) => Buffer.from(bytes.map((byte, i) => byte ^ input.secret.charCodeAt(i % input.secret.length)))
  return {
    isEncryptionAvailable: () => input.available,
    encryptString: (text) => Buffer.concat([prefix, xor(Buffer.from(text, "utf8"))]),
    decryptString(blob) {
      if (!blob.subarray(0, prefix.length).equals(prefix)) throw new Error("Error while decrypting the ciphertext")
      return xor(blob.subarray(prefix.length)).toString("utf8")
    },
  }
}

function fakeKeychain(input: { trust?: boolean; throws?: boolean; deleted?: boolean; paths?: () => CertPaths } = {}) {
  const calls: { op: string; args: Record<string, string> }[] = []
  const keychain: Keychain = {
    async trust(caCertPath) {
      // Snapshot of the rotation backup at trust time: it must already hold the old CA (F-M3-1 step 1).
      const backup = input.paths ? await readFingerprintFile(input.paths().previousFingerprint) : undefined
      calls.push({ op: "trust", args: { caCertPath, backupSha1: backup?.sha1 ?? "" } })
      // The message carries a local path, as an fs error would; it must never reach the log (F-M3-2).
      if (input.throws) throw Object.assign(new Error("EACCES: open '/Users/secret-user/Library/x.pem'"), { code: "EACCES" })
      return input.trust === false ? { ok: false, code: "CERT_UNTRUSTED" } : { ok: true }
    },
    async verify(leafCertPath) {
      calls.push({ op: "verify", args: { leafCertPath } })
      return true
    },
    async remove(removal) {
      // The old CA copy must exist while `remove-trusted-cert` runs.
      const exists = await Bun.file(removal.caCertPath).exists()
      calls.push({ op: "remove", args: { caCertPath: removal.caCertPath, sha1: removal.sha1, exists: String(exists) } })
      return { trustRemoved: true, deleted: input.deleted !== false }
    },
  }
  return { calls, keychain }
}

/** Manual clock (TR-4): `tick()` fires every registered interval once, as the 24 h interval would. */
function manualClock(start: Date) {
  const state = { now: start, ticks: [] as { ms: number; tick: () => void; cancelled: boolean }[] }
  const clock: RenewalClock = {
    now: () => state.now,
    every(ms, tick) {
      const entry = { ms, tick, cancelled: false }
      state.ticks.push(entry)
      return () => {
        entry.cancelled = true
      }
    },
  }
  return {
    clock,
    state,
    advance(days: number) {
      state.now = new Date(state.now.getTime() + days * DAY)
      state.ticks.filter((entry) => !entry.cancelled).forEach((entry) => entry.tick())
    },
  }
}

async function setup(input: { available: boolean; secret?: string; keychain?: ReturnType<typeof fakeKeychain> }) {
  const paths = await tempPaths()
  const logs: Parameters<OfficeLogSink>[] = []
  const log: OfficeLogSink = (...entry) => {
    logs.push(entry)
  }
  const custody = createKeyCustody({
    safeStorage: fakeSafeStorage({ available: input.available, secret: input.secret ?? "machine-a" }),
    paths,
    log,
  })
  const ca = await createCa(T0)
  const print = await writeCa({ paths, ca, encryptKey: custody.encryptKey() })
  const leaf = await issueLeaf(ca, T0)
  await writeLeaf(paths, leaf)
  const sent: BridgeTlsUpdateCommand[] = []
  const keychain = input.keychain ?? fakeKeychain()
  const deps: RenewalDeps = { paths, custody, keychain: keychain.keychain, send: (command) => sent.push(command), log }
  return { paths, ca, print, leaf, sent, keychain, deps, logs }
}

async function caFilesContainPrivateKey(paths: CertPaths) {
  const names = await readdir(paths.caDir)
  const texts = await Promise.all(names.map((name) => Bun.file(join(paths.caDir, name)).text()))
  return texts.some((text) => text.includes("PRIVATE KEY"))
}

describe("ST-12: retained CA key (SC-21)", () => {
  test("the 24 h tick renews a leaf with 29 days left: new key, tls-update sent, CA untouched, no keychain prompt", async () => {
    const s = await setup({ available: true })
    const manual = manualClock(T0)
    const results: RenewalResult[] = []
    const timer = startRenewalTimer({ deps: s.deps, clock: manual.clock, onResult: (result) => results.push(result) })
    expect(manual.state.ticks.map((entry) => entry.ms)).toEqual([RENEWAL_INTERVAL_MS])

    manual.advance(1)
    await timer.idle()
    expect(results).toEqual([{ action: "none" }])
    expect(s.sent).toEqual([])

    // Leaf valid 397 days from T0: at day 368 fewer than 30 days remain.
    manual.advance(367)
    await timer.idle()
    expect(results[1]).toEqual({ action: "renewed" })
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0]!.type).toBe("tls-update")
    expect(s.sent[0]!.key).not.toBe(s.leaf.key)
    expect(await Bun.file(s.paths.leafCert).text()).toBe(s.sent[0]!.cert)
    expect(await Bun.file(s.paths.leafKey).text()).toBe(s.sent[0]!.key)
    expect(new X509Certificate(s.sent[0]!.cert).checkIssued(new X509Certificate(s.ca.cert))).toBeTruthy()
    expect(await Bun.file(s.paths.caCert).text()).toBe(s.ca.cert)
    expect(await readFingerprint(s.paths)).toEqual(s.print)
    expect(s.keychain.calls).toEqual([])
    expect(await caFilesContainPrivateKey(s.paths)).toBe(false)

    manual.advance(1)
    await timer.idle()
    expect(results[2]).toEqual({ action: "none" })
    timer.stop()
  })

  test("checkLeaf at bridge start renews the same way (start half of SC-25)", async () => {
    const s = await setup({ available: true })
    expect(await checkLeaf(s.deps, at(368))).toEqual({ action: "renewed" })
    expect(s.sent).toHaveLength(1)
  })

  test("the key file missing in the retained mode is CERT_MISSING, no rotation", async () => {
    const s = await setup({ available: true })
    await s.deps.custody.discard()
    expect(await checkLeaf(s.deps, at(368))).toEqual({ action: "failed", code: "CERT_MISSING" })
    expect(s.keychain.calls).toEqual([])
    expect(s.sent).toEqual([])
  })

  test("a missing CA certificate is CERT_MISSING", async () => {
    const s = await setup({ available: true })
    await rm(s.paths.caCert)
    expect(await checkLeaf(s.deps, at(1))).toEqual({ action: "failed", code: "CERT_MISSING" })
  })
})

describe("rotation: no retained key (SC-22) and unreadable key (C26(c))", () => {
  test("SC-22: due leaf -> new CA + leaf, trust once, old CA removed by SHA-1, tls-update, still no key file", async () => {
    const s = await setup({ available: false })
    expect(await readdir(s.paths.caDir)).not.toContain("swarm-office-ca.key.enc")

    const result = await checkLeaf(s.deps, at(368))

    expect(result).toEqual({ action: "rotated", reason: "no-retained-key", trusted: true, oldRemoved: true })
    const newCa = await Bun.file(s.paths.caCert).text()
    expect(newCa).not.toBe(s.ca.cert)
    expect(await readFingerprint(s.paths)).toEqual(fingerprint(newCa))
    expect(s.keychain.calls.map((call) => call.op)).toEqual(["trust", "remove"])
    expect(s.keychain.calls[0]!.args.caCertPath).toBe(s.paths.caCert)
    expect(s.keychain.calls[1]!.args.sha1).toBe(s.print.sha1)
    expect(s.keychain.calls[1]!.args.exists).toBe("true")
    expect(await Bun.file(s.keychain.calls[1]!.args.caCertPath!).exists()).toBe(false)
    expect(s.sent).toHaveLength(1)
    expect(new X509Certificate(s.sent[0]!.cert).checkIssued(new X509Certificate(newCa))).toBeTruthy()
    expect(await readdir(s.paths.caDir)).not.toContain("swarm-office-ca.key.enc")
    expect(await caFilesContainPrivateKey(s.paths)).toBe(false)
  })

  test("SC-22: a leaf that is not due causes no rotation and no prompt", async () => {
    const s = await setup({ available: false })
    expect(await checkLeaf(s.deps, at(100))).toEqual({ action: "none" })
    expect(s.keychain.calls).toEqual([])
  })

  test("C26(c): a blob from another safeStorage key regenerates CA + leaf, re-trusts, and stores a readable blob", async () => {
    const s = await setup({ available: true, secret: "before-patch" })
    const after = createKeyCustody({
      safeStorage: fakeSafeStorage({ available: true, secret: "after-patch" }),
      paths: s.paths,
      log: s.deps.log,
    })
    expect(await after.readCaKey()).toEqual({ state: "unreadable" })

    const result = await checkLeaf({ ...s.deps, custody: after }, at(368))

    expect(result).toEqual({ action: "rotated", reason: "key-unreadable", trusted: true, oldRemoved: true })
    const read = await after.readCaKey()
    expect(read.state).toBe("ok")
    expect(s.keychain.calls.map((call) => call.op)).toEqual(["trust", "remove"])
    expect(s.keychain.calls[1]!.args.sha1).toBe(s.print.sha1)
    expect(await caFilesContainPrivateKey(s.paths)).toBe(false)
  })

  test("a refused trust is CERT_UNTRUSTED; the old CA is still removed and the new leaf still sent", async () => {
    const s = await setup({ available: false, keychain: fakeKeychain({ trust: false }) })
    expect(await checkLeaf(s.deps, at(368))).toEqual({ action: "failed", code: "CERT_UNTRUSTED" })
    expect(s.keychain.calls.map((call) => call.op)).toEqual(["trust", "remove"])
    expect(s.sent).toHaveLength(1)
    expect(s.logs.some((entry) => entry[0] === "error" && entry[3]?.code === "CERT_UNTRUSTED")).toBe(true)
  })
})

describe("timer behaviour", () => {
  test("a throwing check is logged, reported as failed, and the timer keeps running; stop cancels", async () => {
    const s = await setup({ available: false, keychain: fakeKeychain({ throws: true }) })
    const manual = manualClock(at(368))
    const results: RenewalResult[] = []
    const timer = startRenewalTimer({ deps: s.deps, clock: manual.clock, onResult: (result) => results.push(result) })
    manual.advance(0)
    await timer.idle()
    expect(results).toEqual([{ action: "failed", code: "CERT_MISSING" }])
    expect(s.logs.some((entry) => entry[0] === "error" && entry[2] === "renewal check threw")).toBe(true)
    const thrown = s.logs.find((entry) => entry[2] === "renewal check threw")!
    expect(thrown[3]).toEqual({ name: "Error", code: "EACCES", reason: "check-threw" })
    expect(JSON.stringify(s.logs)).not.toContain("secret-user")
    expect(JSON.stringify(s.logs)).not.toContain("PRIVATE KEY")
    expect(JSON.stringify(s.logs)).not.toContain(s.paths.root)

    timer.stop()
    manual.advance(1)
    await timer.idle()
    expect(results).toHaveLength(1)
    expect(manual.state.ticks.every((entry) => entry.cancelled)).toBe(true)
  })

  test("overlapping ticks run one check at a time", async () => {
    const s = await setup({ available: true })
    const manual = manualClock(at(368))
    const results: RenewalResult[] = []
    const timer = startRenewalTimer({ deps: s.deps, clock: manual.clock, onResult: (result) => results.push(result) })
    manual.advance(0)
    manual.advance(0)
    await timer.idle()
    expect(results).toEqual([{ action: "renewed" }])
    expect(s.sent).toHaveLength(1)
    timer.stop()
  })
})

describe("F-M3-1 crash-safe rotation", () => {
  test("the old CA and its SHA-1 are in ca/previous/ before the new CA is trusted; the backup is gone afterwards", async () => {
    const holder: { paths?: CertPaths } = {}
    const keychain = fakeKeychain({ paths: () => holder.paths! })
    const s = await setup({ available: false, keychain })
    holder.paths = s.paths
    expect((await checkLeaf(s.deps, at(368))).action).toBe("rotated")
    expect(keychain.calls[0]!.args.backupSha1).toBe(s.print.sha1)
    expect(keychain.calls[1]!.args.caCertPath).toBe(s.paths.previousCert)
    expect(await readdir(s.paths.caDir)).not.toContain("previous")
  })

  test("a crash after the new CA is written: the next start removes the old CA by its SHA-1 and deletes the backup", async () => {
    const s = await setup({ available: false, keychain: fakeKeychain({ throws: true }) })
    // The process "dies" inside the trust step: after writeCa, before the old CA was removed.
    await expect(checkLeaf(s.deps, at(368))).rejects.toThrow()
    const current = await readFingerprint(s.paths)
    expect(current!.sha1).not.toBe(s.print.sha1)
    expect(await readFingerprintFile(s.paths.previousFingerprint)).toEqual(s.print)
    expect(await Bun.file(s.paths.previousCert).text()).toBe(s.ca.cert)

    // Next launch: a working keychain, leaf not due.
    const restart = fakeKeychain()
    const result = await checkLeaf({ ...s.deps, keychain: restart.keychain }, at(369))
    expect(result).toEqual({ action: "none" })
    expect(restart.calls).toEqual([
      { op: "remove", args: { caCertPath: s.paths.previousCert, sha1: s.print.sha1, exists: "true" } },
    ])
    expect(await readdir(s.paths.caDir)).not.toContain("previous")
    expect(await readFingerprint(s.paths)).toEqual(current)
  })

  test("a crash after the backup but before the new CA: the backup is dropped and the live CA is NOT removed", async () => {
    const s = await setup({ available: false })
    await writePreviousCa(s.paths, s.ca.cert, s.print)
    expect(await finishPendingRemoval(s.deps)).toBe("dropped")
    expect(s.keychain.calls).toEqual([])
    expect(await readdir(s.paths.caDir)).not.toContain("previous")
  })

  test("a half-written backup is dropped without a keychain call", async () => {
    const s = await setup({ available: false })
    await writePreviousCa(s.paths, s.ca.cert, s.print)
    await rm(s.paths.previousFingerprint)
    expect(await finishPendingRemoval(s.deps)).toBe("dropped")
    expect(s.keychain.calls).toEqual([])
  })

  test("a failed delete keeps the backup and the next check retries", async () => {
    const failing = fakeKeychain({ deleted: false })
    const s = await setup({ available: false, keychain: failing })
    const result = await checkLeaf(s.deps, at(368))
    expect(result).toEqual({ action: "rotated", reason: "no-retained-key", trusted: true, oldRemoved: false })
    expect(await readFingerprintFile(s.paths.previousFingerprint)).toEqual(s.print)

    const retry = fakeKeychain()
    expect(await checkLeaf({ ...s.deps, keychain: retry.keychain }, at(369))).toEqual({ action: "none" })
    expect(retry.calls.map((call) => [call.op, call.args.sha1])).toEqual([["remove", s.print.sha1]])
    expect(await readdir(s.paths.caDir)).not.toContain("previous")
  })

  test("no backup: no keychain call", async () => {
    const s = await setup({ available: false })
    expect(await finishPendingRemoval(s.deps)).toBe("none")
    expect(s.keychain.calls).toEqual([])
  })
})

describe("F-M3-4 symlinked certificate directories", () => {
  test("a ca/ symlink makes the rotation fail with DATA_DIR_UNSAFE; nothing is written into the link target", async () => {
    const s = await setup({ available: false })
    const target = `${s.paths.caDir}-moved`
    await rename(s.paths.caDir, target)
    await symlink(target, s.paths.caDir)
    const before = (await readdir(target)).sort()

    expect(await checkLeaf(s.deps, at(368))).toEqual({ action: "failed", code: "DATA_DIR_UNSAFE" })
    expect((await readdir(target)).sort()).toEqual(before)
    expect(s.keychain.calls).toEqual([])
    expect(s.sent).toEqual([])
    expect(s.logs.some((entry) => entry[3]?.code === "DATA_DIR_UNSAFE" && entry[3]?.entry === "ca")).toBe(true)
  })

  test("a tls/ symlink makes a retained-key renewal fail with DATA_DIR_UNSAFE", async () => {
    const s = await setup({ available: true })
    const target = `${s.paths.tlsDir}-moved`
    await rename(s.paths.tlsDir, target)
    await symlink(target, s.paths.tlsDir)
    expect(await checkLeaf(s.deps, at(368))).toEqual({ action: "failed", code: "DATA_DIR_UNSAFE" })
    expect(await Bun.file(join(target, "localhost.cert.pem")).text()).toBe(s.leaf.cert)
    expect(s.sent).toEqual([])
  })
})
