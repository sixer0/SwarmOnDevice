// Spike S1 / S1v / S2 (plan row 32, M0-03): certificate and icon generator.
//
// Writes into an output directory under $TMPDIR (or argv[2]):
//   ca.cert.pem / ca.key.pem              name-constrained CA (register 6.1 profile)
//   localhost.cert.pem / localhost.key.pem leaf for localhost, 127.0.0.1, ::1
//   example.cert.pem / example.key.pem    deliberately out-of-constraint leaf (ST-10)
//   fingerprints.json                     SHA-1 and SHA-256 of each certificate
//   icons/icon-32.png, icons/icon-64.png  placeholder icons
//
// This script never runs a process and never touches the keychain. Trust and
// removal are manual steps in README.md, run by rows 35/36/39 with the user.
import { mkdir, writeFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AltName,
  AuthorityKeyIdentifier,
  BasicConstraints,
  Certificate,
  CryptoEngine,
  ExtKeyUsage,
  Extension,
  GeneralName,
  GeneralSubtree,
  NameConstraints,
  AttributeTypeAndValue,
  setEngine,
} from "pkijs"
import { BitString, Integer, OctetString, Utf8String } from "asn1js"
import { solidPng } from "./icons"

const CA_CN = "Swarm Office Add-in Local CA (spike)"
const CA_DAYS = 3650
const LEAF_DAYS = 397
const DAY_MS = 24 * 60 * 60 * 1000

// OIDs (RFC 5280)
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

// GeneralName tags
const DNS = 2
const IP = 7

// keyUsage bits, numbered as in RFC 5280 section 4.2.1.3
const KU = { digitalSignature: 0, keyCertSign: 5, cRLSign: 6 }

const ALG = { name: "ECDSA", namedCurve: "P-256" } as const

setEngine("bun", new CryptoEngine({ name: "bun", crypto: globalThis.crypto }))

const out = process.argv[2] ?? join(process.env.TMPDIR ?? tmpdir(), "swarm-office-spike-s1-s2")
const nameConstraintsCritical = process.env.SPIKE_NC_CRITICAL !== "0"

function ipBytes(address: string) {
  if (address === "127.0.0.1") return new Uint8Array([127, 0, 0, 1])
  if (address === "::1") return new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
  throw new Error(`unsupported address ${address}`)
}

function dnsName(value: string) {
  return new GeneralName({ type: DNS, value })
}

function ipName(bytes: Uint8Array) {
  return new GeneralName({ type: IP, value: new OctetString({ valueHex: bytes }) })
}

function keyUsage(bits: number[]) {
  // DER BIT STRING for keyUsage in one byte: bit 0 is the most significant bit.
  const byte = bits.reduce((acc, bit) => acc | (0x80 >> bit), 0)
  const highest = Math.max(...bits)
  return new BitString({ valueHex: new Uint8Array([byte]), unusedBits: 7 - highest })
}

function extension(extnID: string, critical: boolean, value: { toSchema(): { toBER(): ArrayBuffer } } | BitString) {
  const der = "toSchema" in value ? value.toSchema().toBER() : value.toBER()
  return new Extension({ extnID, critical, extnValue: der })
}

// CN only: pkijs puts every pushed attribute into one multi-valued RDN.
function setName(target: Certificate["subject"], cn: string) {
  target.typesAndValues.push(new AttributeTypeAndValue({ type: OID.cn, value: new Utf8String({ value: cn }) }))
}

function serial() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[0] = bytes[0]! & 0x7f // positive INTEGER
  return new Integer({ valueHex: bytes })
}

async function keyId(cert: Certificate) {
  const spki = new Uint8Array(cert.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView)
  return new Uint8Array(await crypto.subtle.digest("SHA-1", spki))
}

function pem(label: string, der: ArrayBuffer) {
  const b64 = Buffer.from(der).toString("base64")
  const lines = b64.match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`
}

async function fingerprint(alg: "SHA-1" | "SHA-256", der: ArrayBuffer) {
  const hex = Buffer.from(await crypto.subtle.digest(alg, der)).toString("hex").toUpperCase()
  return hex
}

function validity(cert: Certificate, days: number) {
  const now = Date.now()
  cert.notBefore.value = new Date(now - 5 * 60 * 1000) // 5 min clock skew
  cert.notAfter.value = new Date(now + days * DAY_MS)
}

async function makeCa() {
  const keys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"])
  const cert = new Certificate()
  cert.version = 2
  cert.serialNumber = serial()
  setName(cert.issuer, CA_CN)
  setName(cert.subject, CA_CN)
  validity(cert, CA_DAYS)
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey)
  const ski = await keyId(cert)
  const constraints = new NameConstraints({
    permittedSubtrees: [
      new GeneralSubtree({ base: dnsName("localhost") }),
      new GeneralSubtree({ base: ipName(new Uint8Array([...ipBytes("127.0.0.1"), 255, 255, 255, 255])) }),
      new GeneralSubtree({ base: ipName(new Uint8Array([...ipBytes("::1"), ...new Array(16).fill(0xff)])) }),
    ],
  })
  cert.extensions = [
    extension(OID.basicConstraints, true, new BasicConstraints({ cA: true, pathLenConstraint: 0 })),
    extension(OID.keyUsage, true, keyUsage([KU.keyCertSign, KU.cRLSign])),
    extension(OID.nameConstraints, nameConstraintsCritical, constraints),
    new Extension({ extnID: OID.subjectKeyId, critical: false, extnValue: new OctetString({ valueHex: ski }).toBER() }),
  ]
  await cert.sign(keys.privateKey, "SHA-256")
  return { cert, keys, ski }
}

async function makeLeaf(ca: Awaited<ReturnType<typeof makeCa>>, cn: string, names: GeneralName[]) {
  const keys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"])
  const cert = new Certificate()
  cert.version = 2
  cert.serialNumber = serial()
  setName(cert.issuer, CA_CN)
  setName(cert.subject, cn)
  validity(cert, LEAF_DAYS)
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey)
  const ski = await keyId(cert)
  cert.extensions = [
    extension(OID.basicConstraints, true, new BasicConstraints({ cA: false })),
    extension(OID.keyUsage, true, keyUsage([KU.digitalSignature])),
    extension(OID.extKeyUsage, false, new ExtKeyUsage({ keyPurposes: [OID.serverAuth] })),
    extension(OID.subjectAltName, false, new AltName({ altNames: names })),
    new Extension({ extnID: OID.subjectKeyId, critical: false, extnValue: new OctetString({ valueHex: ski }).toBER() }),
    extension(
      OID.authorityKeyId,
      false,
      new AuthorityKeyIdentifier({ keyIdentifier: new OctetString({ valueHex: ca.ski }) }),
    ),
  ]
  await cert.sign(ca.keys.privateKey, "SHA-256")
  return { cert, keys }
}

async function write(name: string, cert: Certificate, privateKey: CryptoKey) {
  const der = cert.toSchema(true).toBER()
  const key = await crypto.subtle.exportKey("pkcs8", privateKey)
  await writeFile(join(out, `${name}.cert.pem`), pem("CERTIFICATE", der), { mode: 0o644 })
  await writeFile(join(out, `${name}.key.pem`), pem("PRIVATE KEY", key), { mode: 0o600 })
  await chmod(join(out, `${name}.key.pem`), 0o600)
  return {
    file: join(out, `${name}.cert.pem`),
    sha1: await fingerprint("SHA-1", der),
    sha256: await fingerprint("SHA-256", der),
  }
}

await mkdir(join(out, "icons"), { recursive: true, mode: 0o700 })
await chmod(out, 0o700)

const ca = await makeCa()
const localhost = await makeLeaf(ca, "localhost", [
  dnsName("localhost"),
  ipName(ipBytes("127.0.0.1")),
  ipName(ipBytes("::1")),
])
const example = await makeLeaf(ca, "example.com", [dnsName("example.com")])

const prints = {
  generatedAt: new Date().toISOString(),
  nameConstraintsCritical,
  ca: await write("ca", ca.cert, ca.keys.privateKey),
  localhost: await write("localhost", localhost.cert, localhost.keys.privateKey),
  example: await write("example", example.cert, example.keys.privateKey),
}
await writeFile(join(out, "fingerprints.json"), JSON.stringify(prints, null, 2) + "\n")

// Placeholder icons: Swarm-ish dark teal square.
await writeFile(join(out, "icons", "icon-32.png"), solidPng(32, [0x1f, 0x6f, 0x78, 0xff]))
await writeFile(join(out, "icons", "icon-64.png"), solidPng(64, [0x1f, 0x6f, 0x78, 0xff]))

console.log(`out: ${out}`)
console.log(`nameConstraints critical: ${nameConstraintsCritical}`)
for (const [name, info] of Object.entries(prints)) {
  if (typeof info !== "object") continue
  console.log(`${name.padEnd(9)} SHA-1 ${info.sha1}  SHA-256 ${info.sha256}`)
}
