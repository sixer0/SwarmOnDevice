// U-CE-01..U-CE-05 (test strategy §5; plan row M3-01). Every file is written under $TMPDIR and removed afterwards.
// No `security` command is executed: U-CE-05 checks the argv builders only.
import { afterAll, describe, expect, test } from "bun:test"
import { X509Certificate } from "node:crypto"
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Integer, OctetString } from "asn1js"
import { BasicConstraints, Certificate, ExtKeyUsage, AltName, NameConstraints } from "pkijs"
import {
  CA_COMMON_NAME,
  CertDirUnsafeError,
  SECURITY_BIN,
  certPaths,
  ensureCertDirs,
  createCa,
  deleteCertificateArgv,
  fingerprint,
  issueLeaf,
  leafRenewalDue,
  readFingerprint,
  removeTrustArgv,
  renewLeafIfDue,
  trustArgv,
  verifyArgv,
  writeCa,
  writeLeaf,
} from "./certs"

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date("2026-11-16T12:00:00Z")
const openssl = Bun.which("openssl")
const roots: string[] = []

async function tempRoot() {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "swarm-certs-test-"))
  roots.push(dir)
  return dir
}

afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })))
})

function parsed(pem: string) {
  const b64 = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, "")
  return Certificate.fromBER(Buffer.from(b64, "base64"))
}

function ext(cert: Certificate, oid: string) {
  const found = (cert.extensions ?? []).find((item) => item.extnID === oid)
  if (!found) throw new Error(`missing extension ${oid}`)
  return found
}

function cn(names: Certificate["subject"]) {
  return names.typesAndValues.map((item) => `${item.type}=${item.value.valueBlock.value}`)
}

function hex(value: OctetString) {
  return Buffer.from(value.valueBlock.valueHexView).toString("hex")
}

function opensslText(pem: string, args: string[]) {
  const result = Bun.spawnSync([openssl!, "x509", "-noout", ...args], { stdin: Buffer.from(pem) })
  expect(result.exitCode).toBe(0)
  return result.stdout.toString()
}

describe("U-CE-01 CA profile", () => {
  test("P-256/SHA-256, CA:TRUE pathlen 0 critical, keyCertSign+cRLSign, name constraints, 3650 days, CN", async () => {
    const ca = await createCa(NOW)
    const cert = parsed(ca.cert)
    expect(cert.version).toBe(2)
    expect(cn(cert.subject)).toEqual([`2.5.4.3=${CA_COMMON_NAME}`])
    expect(cn(cert.issuer)).toEqual([`2.5.4.3=${CA_COMMON_NAME}`])
    expect(cert.signatureAlgorithm.algorithmId).toBe("1.2.840.10045.4.3.2") // ecdsa-with-SHA256
    expect(cert.subjectPublicKeyInfo.algorithm.algorithmId).toBe("1.2.840.10045.2.1") // id-ecPublicKey
    expect(cert.subjectPublicKeyInfo.algorithm.algorithmParams.valueBlock.toString()).toBe("1.2.840.10045.3.1.7") // P-256
    expect(cert.notAfter.value.getTime() - NOW.getTime()).toBe(3650 * DAY)

    const basic = ext(cert, "2.5.29.19")
    expect(basic.critical).toBe(true)
    const bc = new BasicConstraints({ schema: basic.parsedValue.toSchema() })
    expect(bc.cA).toBe(true)
    expect(bc.pathLenConstraint).toBe(0)

    const usage = ext(cert, "2.5.29.15")
    expect(usage.critical).toBe(true)
    expect(Array.from(new Uint8Array(usage.parsedValue.valueBlock.valueHexView))).toEqual([0x06]) // bits 5,6
    expect(usage.parsedValue.valueBlock.unusedBits).toBe(1)

    const nc = ext(cert, "2.5.29.30")
    expect(nc.critical).toBe(true)
    const constraints = nc.parsedValue as NameConstraints
    expect(constraints.excludedSubtrees).toBeUndefined()
    expect(
      (constraints.permittedSubtrees ?? []).map((item) =>
        item.base.type === 2 ? `DNS:${item.base.value}` : `IP:${hex(item.base.value)}`,
      ),
    ).toEqual(["DNS:localhost", "IP:7f000001ffffffff", `IP:${"00".repeat(15)}01${"ff".repeat(16)}`])

    const x509 = new X509Certificate(ca.cert)
    expect(x509.ca).toBe(true)
    expect(x509.verify(x509.publicKey)).toBe(true)
  })

  test.skipIf(!openssl)("openssl reads the profile the same way", async () => {
    const text = opensslText((await createCa(NOW)).cert, ["-text"])
    expect(text).toContain("ecdsa-with-SHA256")
    expect(text).toContain("prime256v1")
    expect(text).toMatch(/X509v3 Basic Constraints: critical\s+CA:TRUE, pathlen:0/)
    expect(text).toMatch(/X509v3 Key Usage: critical\s+Certificate Sign, CRL Sign/)
    expect(text).toMatch(
      /X509v3 Name Constraints: critical\s+Permitted:\s+DNS:localhost\s+IP:127\.0\.0\.1\/255\.255\.255\.255\s+IP:0:0:0:0:0:0:0:1\/FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF/,
    )
    expect(text).toContain(`Subject: CN=${CA_COMMON_NAME}`)
  })
})

describe("U-CE-02 leaf profile", () => {
  test("CN, SAN, serverAuth, digitalSignature, P-256, 397 days, issued and signed by the CA", async () => {
    const ca = await createCa(NOW)
    const leaf = await issueLeaf(ca, NOW)
    const cert = parsed(leaf.cert)
    expect(cn(cert.subject)).toEqual(["2.5.4.3=localhost"])
    expect(cn(cert.issuer)).toEqual([`2.5.4.3=${CA_COMMON_NAME}`])
    expect(cert.signatureAlgorithm.algorithmId).toBe("1.2.840.10045.4.3.2")
    expect(cert.subjectPublicKeyInfo.algorithm.algorithmParams.valueBlock.toString()).toBe("1.2.840.10045.3.1.7")
    expect(cert.notAfter.value.getTime() - NOW.getTime()).toBe(397 * DAY)

    const san = ext(cert, "2.5.29.17").parsedValue as AltName
    expect(
      san.altNames.map((item) => (item.type === 2 ? `DNS:${item.value}` : `IP:${hex(item.value)}`)),
    ).toEqual(["DNS:localhost", "IP:7f000001", `IP:${"00".repeat(15)}01`])
    expect((ext(cert, "2.5.29.37").parsedValue as ExtKeyUsage).keyPurposes).toEqual(["1.3.6.1.5.5.7.3.1"])
    const usage = ext(cert, "2.5.29.15")
    expect(usage.critical).toBe(true)
    expect(Array.from(new Uint8Array(usage.parsedValue.valueBlock.valueHexView))).toEqual([0x80])
    const bc = new BasicConstraints({ schema: ext(cert, "2.5.29.19").parsedValue.toSchema() })
    expect(bc.cA).toBe(false)

    const x509 = new X509Certificate(leaf.cert)
    const issuer = new X509Certificate(ca.cert)
    // Node returns a boolean, Bun the issuer certificate: both truthy only when issued by it.
    expect(x509.checkIssued(issuer)).toBeTruthy()
    expect(x509.checkIssued(x509)).toBeFalsy()
    expect(x509.verify(issuer.publicKey)).toBe(true)
    expect(x509.checkHost("localhost")).toBe("localhost")
    expect(x509.checkIP("127.0.0.1")).toBe("127.0.0.1")
    expect(x509.checkIP("::1")).toBe("::1")
    expect(x509.checkHost("example.com")).toBeUndefined()
    expect(x509.subject).toBe("CN=localhost")
  })

  test("serials are positive and distinct", async () => {
    const ca = await createCa(NOW)
    const a = parsed((await issueLeaf(ca, NOW)).cert).serialNumber as Integer
    const b = parsed((await issueLeaf(ca, NOW)).cert).serialNumber as Integer
    expect(new Uint8Array(a.valueBlock.valueHexView)[0]! & 0x80).toBe(0)
    expect(new Uint8Array(a.valueBlock.valueHexView)[0]).not.toBe(0)
    expect(hex(new OctetString({ valueHex: a.valueBlock.valueHexView }))).not.toBe(
      hex(new OctetString({ valueHex: b.valueBlock.valueHexView })),
    )
  })
})

describe("U-CE-03 renewal with an injected now", () => {
  test("decision: missing, corrupt, foreign CA, 29 days left renew; 31 days left keeps", async () => {
    const ca = await createCa(NOW)
    const leaf = await issueLeaf(ca, NOW)
    const at = (days: number) => new Date(NOW.getTime() + (397 - days) * DAY)
    expect(leafRenewalDue({ leafPem: undefined, now: NOW })).toBe(true)
    expect(leafRenewalDue({ leafPem: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n", now: NOW })).toBe(
      true,
    )
    expect(leafRenewalDue({ leafPem: leaf.cert, now: at(29), caPem: ca.cert })).toBe(true)
    expect(leafRenewalDue({ leafPem: leaf.cert, now: at(31), caPem: ca.cert })).toBe(false)
    expect(leafRenewalDue({ leafPem: leaf.cert, now: NOW, caPem: (await createCa(NOW)).cert })).toBe(true)
  })

  test("29 days left: new leaf with a new key; 31 days left: no change; the CA is unchanged", async () => {
    const paths = certPaths(await tempRoot())
    const ca = await createCa(NOW)
    const print = await writeCa({ paths, ca, encryptKey: (pem) => new TextEncoder().encode(`sealed:${pem.length}`) })
    const first = await issueLeaf(ca, NOW)
    await writeLeaf(paths, first)
    const caBefore = await Bun.file(paths.caCert).text()
    const caKey = async () => ca.key

    const kept = await renewLeafIfDue({ paths, now: new Date(NOW.getTime() + (397 - 31) * DAY), caKey })
    expect(kept).toEqual({ renewed: false })
    expect(await Bun.file(paths.leafCert).text()).toBe(first.cert)
    expect(await Bun.file(paths.leafKey).text()).toBe(first.key)

    const later = new Date(NOW.getTime() + (397 - 29) * DAY)
    const renewed = await renewLeafIfDue({ paths, now: later, caKey })
    if (!("renewed" in renewed) || !renewed.renewed) throw new Error("expected a renewal")
    expect(renewed.leaf.key).not.toBe(first.key)
    expect(new X509Certificate(renewed.leaf.cert).publicKey.export({ format: "der", type: "spki" })).not.toEqual(
      new X509Certificate(first.cert).publicKey.export({ format: "der", type: "spki" }),
    )
    expect(await Bun.file(paths.leafCert).text()).toBe(renewed.leaf.cert)
    expect(await Bun.file(paths.leafKey).text()).toBe(renewed.leaf.key)
    expect(new X509Certificate(renewed.leaf.cert).checkIssued(new X509Certificate(ca.cert))).toBeTruthy()
    expect(new Date(new X509Certificate(renewed.leaf.cert).validTo).getTime()).toBe(
      Math.floor((later.getTime() + 397 * DAY) / 1000) * 1000,
    )
    expect(await Bun.file(paths.caCert).text()).toBe(caBefore)
    expect(await readFingerprint(paths)).toEqual(print)

    const again = await renewLeafIfDue({ paths, now: later, caKey })
    expect(again).toEqual({ renewed: false })
  })

  test("CA certificate or key unavailable gives CERT_MISSING", async () => {
    const paths = certPaths(await tempRoot())
    expect(await renewLeafIfDue({ paths, now: NOW, caKey: async () => "unused" })).toEqual({ error: "CERT_MISSING" })
    await writeCa({ paths, ca: await createCa(NOW) })
    expect(await renewLeafIfDue({ paths, now: NOW, caKey: async () => undefined })).toEqual({ error: "CERT_MISSING" })
  })
})

describe("U-CE-04 paths, modes, fingerprint, no plaintext CA key", () => {
  test("register §6.1 layout and modes (SC-21: encrypted key blob only)", async () => {
    const userData = await tempRoot()
    const paths = certPaths(userData)
    expect(paths.root).toBe(join(userData, "office-addin"))
    expect(paths.caCert).toBe(join(userData, "office-addin", "ca", "swarm-office-ca.cert.pem"))
    expect(paths.caKeyEnc).toBe(join(userData, "office-addin", "ca", "swarm-office-ca.key.enc"))
    expect(paths.fingerprint).toBe(join(userData, "office-addin", "ca", "fingerprint.json"))
    expect(paths.leafKey).toBe(join(userData, "office-addin", "tls", "localhost.key.pem"))
    expect(paths.leafCert).toBe(join(userData, "office-addin", "tls", "localhost.cert.pem"))

    const ca = await createCa(NOW)
    const sealed = new TextEncoder().encode("opaque-safeStorage-blob")
    await writeCa({ paths, ca, encryptKey: () => sealed })
    await writeLeaf(paths, await issueLeaf(ca, NOW))
    const mode = async (path: string) => (await stat(path)).mode & 0o777
    expect(await mode(paths.root)).toBe(0o700)
    expect(await mode(paths.caDir)).toBe(0o700)
    expect(await mode(paths.tlsDir)).toBe(0o700)
    expect(await mode(paths.caCert)).toBe(0o644)
    expect(await mode(paths.caKeyEnc)).toBe(0o600)
    expect(await mode(paths.leafKey)).toBe(0o600)
    expect(await mode(paths.leafCert)).toBe(0o644)
    expect(new Uint8Array(await Bun.file(paths.caKeyEnc).arrayBuffer())).toEqual(sealed)
    expect((await readdir(paths.caDir)).sort()).toEqual([
      "fingerprint.json",
      "swarm-office-ca.cert.pem",
      "swarm-office-ca.key.enc",
    ])
    expect((await readdir(paths.tlsDir)).sort()).toEqual(["localhost.cert.pem", "localhost.key.pem"])
    const caFiles = await Promise.all((await readdir(paths.caDir)).map((file) => Bun.file(join(paths.caDir, file)).text()))
    expect(caFiles.some((text) => text.includes("PRIVATE KEY"))).toBe(false)
  })

  test("SC-22 fallback: no encryptKey means no CA key file at all", async () => {
    const paths = certPaths(await tempRoot())
    await writeCa({ paths, ca: await createCa(NOW) })
    expect((await readdir(paths.caDir)).sort()).toEqual(["fingerprint.json", "swarm-office-ca.cert.pem"])
  })

  test("existing wider directories are tightened to 0700", async () => {
    const paths = certPaths(await tempRoot())
    await mkdir(paths.caDir, { recursive: true })
    await chmod(paths.caDir, 0o755)
    await writeCa({ paths, ca: await createCa(NOW) })
    expect((await stat(paths.caDir)).mode & 0o777).toBe(0o700)
  })

  test("fingerprint.json is SHA-1 and SHA-256 of the CA DER, uppercase hex", async () => {
    const paths = certPaths(await tempRoot())
    const ca = await createCa(NOW)
    const print = await writeCa({ paths, ca })
    const x509 = new X509Certificate(ca.cert)
    expect(print.sha1).toBe(x509.fingerprint.replaceAll(":", ""))
    expect(print.sha256).toBe(x509.fingerprint256.replaceAll(":", ""))
    expect(fingerprint(ca.cert)).toEqual(print)
    expect(await Bun.file(paths.fingerprint).json()).toEqual(print)
    expect(await readFingerprint(paths)).toEqual(print)
  })

  test.skipIf(!openssl)("fingerprint.json equals openssl x509 -fingerprint", async () => {
    const paths = certPaths(await tempRoot())
    const ca = await createCa(NOW)
    const print = await writeCa({ paths, ca })
    const sha1 = opensslText(ca.cert, ["-fingerprint", "-sha1"]).trim().split("=")[1]!.replaceAll(":", "")
    const sha256 = opensslText(ca.cert, ["-fingerprint", "-sha256"]).trim().split("=")[1]!.replaceAll(":", "")
    expect(print).toEqual({ sha1, sha256 })
  })

  test("readFingerprint rejects a missing or malformed file", async () => {
    const paths = certPaths(await tempRoot())
    expect(await readFingerprint(paths)).toBeUndefined()
    await writeCa({ paths, ca: await createCa(NOW) })
    await Bun.write(paths.fingerprint, JSON.stringify({ sha1: "Swarm Office Add-in Local CA", sha256: "x" }))
    expect(await readFingerprint(paths)).toBeUndefined()
  })
})

describe("U-CE-05 security(1) argv builders (not executed)", () => {
  const home = "/Users/tester"
  const keychain = "/Users/tester/Library/Keychains/login.keychain-db"
  const caCert = "/data/office-addin/ca/swarm-office-ca.cert.pem"
  const sha1 = "0123456789ABCDEF0123456789ABCDEF01234567"

  test("exact argv of register §6.1 rev 3", () => {
    expect(SECURITY_BIN).toBe("/usr/bin/security")
    expect(trustArgv(caCert, home)).toEqual([
      "add-trusted-cert",
      "-r",
      "trustRoot",
      "-p",
      "ssl",
      "-k",
      keychain,
      caCert,
    ])
    expect(removeTrustArgv(caCert)).toEqual(["remove-trusted-cert", caCert])
    expect(deleteCertificateArgv(sha1, home)).toEqual(["delete-certificate", "-Z", sha1, keychain])
    expect(verifyArgv("/data/office-addin/tls/localhost.cert.pem")).toEqual([
      "verify-cert",
      "-c",
      "/data/office-addin/tls/localhost.cert.pem",
      "-p",
      "ssl",
      "-s",
      "localhost",
    ])
  })

  test("no argv contains -d (user trust domain, D3) or the System keychain", () => {
    const all = [trustArgv(caCert, home), removeTrustArgv(caCert), deleteCertificateArgv(sha1, home), verifyArgv(caCert)]
    expect(all.flat()).not.toContain("-d")
    expect(all.flat().some((arg) => arg.includes("System.keychain"))).toBe(false)
  })

  test("delete-certificate goes by hash only, never by name", () => {
    expect(() => deleteCertificateArgv(CA_COMMON_NAME, home)).toThrow()
    expect(() => deleteCertificateArgv(sha1.toLowerCase(), home)).toThrow()
    expect(deleteCertificateArgv(sha1, home)).not.toContain("-c")
  })
})

describe("F-M3-4 symlinked or non-directory certificate paths are refused", () => {
  for (const entry of [".", "ca", "tls"]) {
    test(`a symlink at ${entry} throws DATA_DIR_UNSAFE and nothing is written through it`, async () => {
      const userData = await tempRoot()
      const elsewhere = await tempRoot()
      const paths = certPaths(userData)
      if (entry !== ".") await mkdir(paths.root, { mode: 0o700 })
      const at = entry === "." ? paths.root : join(paths.root, entry)
      await symlink(elsewhere, at)

      const error = await ensureCertDirs(paths).catch((thrown: unknown) => thrown)
      expect(error).toBeInstanceOf(CertDirUnsafeError)
      expect(error).toMatchObject({ code: "DATA_DIR_UNSAFE", entry })
      await expect(writeCa({ paths, ca: await createCa(NOW) })).rejects.toBeInstanceOf(CertDirUnsafeError)
      expect(await readdir(elsewhere)).toEqual([])
      expect((await stat(elsewhere)).mode & 0o777).not.toBe(0)
    })
  }

  test("a regular file where a directory belongs is refused", async () => {
    const paths = certPaths(await tempRoot())
    await mkdir(paths.root, { mode: 0o700 })
    await writeFile(paths.caDir, "not a dir")
    await expect(ensureCertDirs(paths)).rejects.toMatchObject({ code: "DATA_DIR_UNSAFE", entry: "ca" })
  })
})

describe("lazy import", () => {
  test("the module source has no top-level setEngine or side effects", async () => {
    const source = await Bun.file(join(import.meta.dir, "certs.ts")).text()
    expect(source).not.toMatch(/setEngine\(/)
    expect(source.split("\n").filter((line) => /^await |^[a-z]\w*\(/.test(line))).toEqual([])
  })
})
