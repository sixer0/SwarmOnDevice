// Plan row M3-02: CA key custody (SC-21, SC-22, C26(c); ST-11 unit half). `safeStorage` is a fake: no Keychain access.
// Set OFFICE_ADDIN_TEST_ROOT to keep the temp dirs for the "grep BEGIN PRIVATE KEY" check after the run.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { certPaths, createCa, writeCa } from "./certs"
import { createKeyCustody } from "./key-custody"
import type { OfficeLogSink, SafeStorageLike } from "./key-custody"

const dirs: string[] = []
const keep = Boolean(process.env.OFFICE_ADDIN_TEST_ROOT)

async function tempDir() {
  const base = process.env.OFFICE_ADDIN_TEST_ROOT ?? process.env.TMPDIR ?? tmpdir()
  await mkdir(base, { recursive: true })
  const dir = await mkdtemp(join(base, "swarm-key-custody-test-"))
  dirs.push(dir)
  return dir
}

afterAll(async () => {
  if (keep) return
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** Stand-in for Electron safeStorage: reversible, keyed, and never leaves the PEM armour readable in the blob. */
function fakeSafeStorage(input: { available: boolean; secret: string }): SafeStorageLike & { calls: string[] } {
  const calls: string[] = []
  const xor = (bytes: Buffer) => Buffer.from(bytes.map((byte, i) => byte ^ input.secret.charCodeAt(i % input.secret.length)))
  return {
    calls,
    isEncryptionAvailable: () => input.available,
    encryptString(text) {
      calls.push("encrypt")
      if (!input.available) throw new Error("Encryption is not available.")
      return Buffer.concat([Buffer.from(`v10${input.secret}:`), xor(Buffer.from(text, "utf8"))])
    },
    decryptString(blob) {
      calls.push("decrypt")
      const prefix = Buffer.from(`v10${input.secret}:`)
      if (!blob.subarray(0, prefix.length).equals(prefix)) throw new Error("Error while decrypting the ciphertext")
      return xor(blob.subarray(prefix.length)).toString("utf8")
    },
  }
}

function recordingLog() {
  const entries: Parameters<OfficeLogSink>[] = []
  const log: OfficeLogSink = (...entry) => {
    entries.push(entry)
  }
  return { entries, log }
}

async function caFilesContainPrivateKey(caDir: string) {
  const names = await readdir(caDir)
  const texts = await Promise.all(names.map((name) => Bun.file(join(caDir, name)).text()))
  return texts.some((text) => text.includes("PRIVATE KEY"))
}

describe("SC-21: safeStorage available", () => {
  test("the CA key is stored only as the safeStorage blob (0600) and reads back exactly", async () => {
    const paths = certPaths(await tempDir())
    const { log, entries } = recordingLog()
    const storage = fakeSafeStorage({ available: true, secret: "machine-a" })
    const custody = createKeyCustody({ safeStorage: storage, paths, log })
    const ca = await createCa(new Date())

    expect(custody.retained()).toBe(true)
    await writeCa({ paths, ca, encryptKey: custody.encryptKey() })

    expect((await stat(paths.caKeyEnc)).mode & 0o777).toBe(0o600)
    expect(await caFilesContainPrivateKey(paths.caDir)).toBe(false)
    expect(await readdir(paths.caDir)).toEqual(
      expect.arrayContaining(["swarm-office-ca.cert.pem", "swarm-office-ca.key.enc", "fingerprint.json"]),
    )
    expect(await custody.readCaKey()).toEqual({ state: "ok", key: ca.key })
    expect(await custody.caKey()).toBe(ca.key)
    expect(JSON.stringify(entries)).not.toContain("PRIVATE KEY")
  })
})

describe("SC-22: safeStorage unavailable", () => {
  test("no encryptKey, no key file, the key reads as absent", async () => {
    const paths = certPaths(await tempDir())
    const storage = fakeSafeStorage({ available: false, secret: "none" })
    const custody = createKeyCustody({ safeStorage: storage, paths, log: recordingLog().log })

    expect(custody.retained()).toBe(false)
    expect(custody.encryptKey()).toBeUndefined()
    await writeCa({ paths, ca: await createCa(new Date()), encryptKey: custody.encryptKey() })

    expect(await readdir(paths.caDir)).not.toContain("swarm-office-ca.key.enc")
    expect(await caFilesContainPrivateKey(paths.caDir)).toBe(false)
    expect(await custody.readCaKey()).toEqual({ state: "absent" })
    expect(await custody.caKey()).toBeUndefined()
    expect(storage.calls).toEqual([])
  })
})

describe("C26(c): an unreadable blob is a recoverable state", () => {
  test("a blob from another safeStorage key (e.g. after a re-signed patch) reads as unreadable, not a throw", async () => {
    const paths = certPaths(await tempDir())
    const before = createKeyCustody({
      safeStorage: fakeSafeStorage({ available: true, secret: "before-patch" }),
      paths,
      log: recordingLog().log,
    })
    await writeCa({ paths, ca: await createCa(new Date()), encryptKey: before.encryptKey() })
    const { log, entries } = recordingLog()
    const after = createKeyCustody({ safeStorage: fakeSafeStorage({ available: true, secret: "after-patch" }), paths, log })

    expect(await after.readCaKey()).toEqual({ state: "unreadable" })
    expect(await after.caKey()).toBeUndefined()
    expect(entries.some((entry) => entry[0] === "error" && entry[2].includes("C26c"))).toBe(true)
  })

  test("a blob that decrypts to something other than a PKCS#8 PEM is unreadable", async () => {
    const paths = certPaths(await tempDir())
    const storage = fakeSafeStorage({ available: true, secret: "machine-a" })
    await mkdir(paths.caDir, { recursive: true })
    await writeFile(paths.caKeyEnc, storage.encryptString("not a key"))
    const custody = createKeyCustody({ safeStorage: storage, paths, log: recordingLog().log })
    expect(await custody.readCaKey()).toEqual({ state: "unreadable" })
  })

  test("a blob present while safeStorage has become unavailable is unreadable", async () => {
    const paths = certPaths(await tempDir())
    const writer = createKeyCustody({
      safeStorage: fakeSafeStorage({ available: true, secret: "machine-a" }),
      paths,
      log: recordingLog().log,
    })
    await writeCa({ paths, ca: await createCa(new Date()), encryptKey: writer.encryptKey() })
    const storage = fakeSafeStorage({ available: false, secret: "machine-a" })
    const reader = createKeyCustody({ safeStorage: storage, paths, log: recordingLog().log })
    expect(await reader.readCaKey()).toEqual({ state: "unreadable" })
    expect(storage.calls).toEqual([])
  })

  test("discard removes the blob and is idempotent", async () => {
    const paths = certPaths(await tempDir())
    const custody = createKeyCustody({
      safeStorage: fakeSafeStorage({ available: true, secret: "machine-a" }),
      paths,
      log: recordingLog().log,
    })
    await writeCa({ paths, ca: await createCa(new Date()), encryptKey: custody.encryptKey() })
    await custody.discard()
    await custody.discard()
    expect(await custody.readCaKey()).toEqual({ state: "absent" })
  })
})
