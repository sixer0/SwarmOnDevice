// Plan row M3-02: keychain execution (SC-23, U-CE-05 executed half). The runner is a fake: the real keychain is never
// touched.
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { SECURITY_BIN } from "./certs"
import { TRUST_TIMEOUT_MS, assertUserDomainArgv, createKeychain } from "./keychain"
import type { OfficeLogSink } from "./key-custody"
import type { PatchRunOptions, PatchRunResult, PatchRunner } from "../patch-common"

const home = "/Users/tester"
const login = "/Users/tester/Library/Keychains/login.keychain-db"
const caCert = "/data/office-addin/ca/swarm-office-ca.cert.pem"
const leafCert = "/data/office-addin/tls/localhost.cert.pem"
const sha1 = "6C5973083584D15F689CCF932046C50E8B16861B"

type Call = { file: string; args: readonly string[]; options: PatchRunOptions }

function fakeRunner(codes: Record<string, number | null>) {
  const calls: Call[] = []
  const run: PatchRunner = async (file, args, options) => {
    calls.push({ file, args, options })
    const name = args[0] ?? ""
    const code = name in codes ? (codes[name] ?? null) : 0
    const result: PatchRunResult = { code, signal: null, stdout: "", stderr: code === 0 ? "" : `SecTrustSettings failed for ${home}/Library/x.pem` }
    return result
  }
  return { calls, run }
}

function recordingLog() {
  const entries: Parameters<OfficeLogSink>[] = []
  const log: OfficeLogSink = (...entry) => {
    entries.push(entry)
  }
  return { entries, log }
}

function expectUserDomainOnly(calls: Call[]) {
  for (const call of calls) {
    expect(call.file).toBe(SECURITY_BIN)
    expect(call.args).not.toContain("-d")
    expect(call.args.join(" ")).not.toContain("System.keychain")
    expect(call.args.join(" ")).not.toContain("/Library/Keychains/System")
  }
}

describe("trust", () => {
  test("runs add-trusted-cert -r trustRoot -p ssl -k <login keychain> <CA> via /usr/bin/security", async () => {
    const runner = fakeRunner({})
    const keychain = createKeychain({ run: runner.run, log: recordingLog().log, home })
    expect(await keychain.trust(caCert)).toEqual({ ok: true })
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["add-trusted-cert", "-r", "trustRoot", "-p", "ssl", "-k", login, caCert],
    ])
    expect(runner.calls[0]!.options.timeoutMs).toBe(TRUST_TIMEOUT_MS)
    expectUserDomainOnly(runner.calls)
  })

  test("a refused trust (cancelled dialog, exit 1) is CERT_UNTRUSTED and logged as an error", async () => {
    const runner = fakeRunner({ "add-trusted-cert": 1 })
    const { log, entries } = recordingLog()
    const keychain = createKeychain({ run: runner.run, log, home })
    expect(await keychain.trust(caCert)).toEqual({ ok: false, code: "CERT_UNTRUSTED" })
    expect(entries.some((entry) => entry[0] === "error" && entry[1] === "office-addin.keychain")).toBe(true)
  })

  test("the child gets a minimal env: no Swarm server password or API keys", async () => {
    process.env.OPENCODE_SERVER_PASSWORD = "do-not-leak"
    const runner = fakeRunner({})
    await createKeychain({ run: runner.run, log: recordingLog().log, home }).trust(caCert)
    delete process.env.OPENCODE_SERVER_PASSWORD
    expect(runner.calls[0]!.options.env).toEqual({ HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" })
  })
})

describe("F-M3-3 log sanitisation", () => {
  test("security stderr (which can name home-directory paths) is never logged", async () => {
    const { log, entries } = recordingLog()
    const runner = fakeRunner({ "add-trusted-cert": 1, "remove-trusted-cert": 1, "delete-certificate": 1, "verify-cert": 1 })
    const keychain = createKeychain({ run: runner.run, log, home })
    await keychain.trust(caCert)
    await keychain.verify(leafCert)
    await keychain.remove({ caCertPath: caCert, sha1 })
    const text = JSON.stringify(entries)
    expect(entries.length).toBeGreaterThan(0)
    expect(text).not.toContain(home)
    expect(text).not.toContain("SecTrustSettings")
    expect(entries.some((entry) => entry[3]?.reason === "nonzero-exit")).toBe(true)
  })
})

describe("verify", () => {
  test("verify-cert -c <leaf> -p ssl -s localhost: true on exit 0, false otherwise", async () => {
    const ok = fakeRunner({})
    expect(await createKeychain({ run: ok.run, log: recordingLog().log, home }).verify(leafCert)).toBe(true)
    expect(ok.calls[0]!.args).toEqual(["verify-cert", "-c", leafCert, "-p", "ssl", "-s", "localhost"])
    const bad = fakeRunner({ "verify-cert": 1 })
    expect(await createKeychain({ run: bad.run, log: recordingLog().log, home }).verify(leafCert)).toBe(false)
    const killed = fakeRunner({ "verify-cert": null })
    expect(await createKeychain({ run: killed.run, log: recordingLog().log, home }).verify(leafCert)).toBe(false)
  })
})

describe("remove", () => {
  test("remove-trusted-cert <CA> then delete-certificate -Z <SHA-1> <login keychain>, in that order", async () => {
    const runner = fakeRunner({})
    const result = await createKeychain({ run: runner.run, log: recordingLog().log, home }).remove({ caCertPath: caCert, sha1 })
    expect(result).toEqual({ trustRemoved: true, deleted: true })
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["remove-trusted-cert", caCert],
      ["delete-certificate", "-Z", sha1, login],
    ])
    expectUserDomainOnly(runner.calls)
  })

  test("delete is still attempted when untrust fails; 'item not found' (44) counts as deleted", async () => {
    const runner = fakeRunner({ "remove-trusted-cert": 1, "delete-certificate": 44 })
    const result = await createKeychain({ run: runner.run, log: recordingLog().log, home }).remove({ caCertPath: caCert, sha1 })
    expect(result).toEqual({ trustRemoved: false, deleted: true })
    expect(runner.calls).toHaveLength(2)
  })

  test("a failed delete is reported and logged", async () => {
    const runner = fakeRunner({ "delete-certificate": 1 })
    const { log, entries } = recordingLog()
    const result = await createKeychain({ run: runner.run, log, home }).remove({ caCertPath: caCert, sha1 })
    expect(result.deleted).toBe(false)
    expect(entries.some((entry) => entry[0] === "error")).toBe(true)
  })

  test("a malformed SHA-1 or a name throws before any keychain command runs", async () => {
    const runner = fakeRunner({})
    const keychain = createKeychain({ run: runner.run, log: recordingLog().log, home })
    await expect(keychain.remove({ caCertPath: caCert, sha1: "Swarm Office Add-in Local CA" })).rejects.toThrow()
    await expect(keychain.remove({ caCertPath: caCert, sha1: sha1.toLowerCase() })).rejects.toThrow()
    expect(runner.calls).toEqual([])
  })
})

describe("argv guard", () => {
  test("rejects the admin trust domain and the System keychain", () => {
    expect(() => assertUserDomainArgv(["add-trusted-cert", "-d", "-r", "trustRoot", caCert])).toThrow()
    expect(() => assertUserDomainArgv(["delete-certificate", "-Z", sha1, "/Library/Keychains/System.keychain"])).toThrow()
    expect(() => assertUserDomainArgv(["add-trusted-cert", "-k", login, caCert])).not.toThrow()
  })

  test("the module never builds a shell command", async () => {
    const source = await Bun.file(join(import.meta.dir, "keychain.ts")).text()
    expect(source).not.toMatch(/shell\s*:/)
    expect(source).not.toMatch(/execSync|spawnSync|from "node:child_process"/)
  })
})
