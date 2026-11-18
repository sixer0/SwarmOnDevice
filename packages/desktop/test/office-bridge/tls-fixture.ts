// Row 47 (M2-01) test fixture: a throwaway self-signed P-256 leaf for `localhost`, `127.0.0.1` and `::1`, generated in
// memory at test time with pkijs (no committed key, no keychain, nothing written outside the caller's $TMPDIR dir).
// It is not the register §6.1 profile (that is certs.ts, row M3-01); it only has to be a valid TLS server leaf.
import { OctetString, Utf8String } from "asn1js"
import { AltName, AttributeTypeAndValue, Certificate, CryptoEngine, Extension, GeneralName, Time } from "pkijs"
import type { LeafTls } from "../../src/main/office-bridge/protocol"

const ALG = { name: "ECDSA", namedCurve: "P-256" }
const OID_CN = "2.5.4.3"
const OID_SAN = "2.5.29.17"
const DNS = 2
const IP = 7

function pem(label: string, der: ArrayBuffer) {
  const lines = Buffer.from(der).toString("base64").match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`
}

function ip(bytes: number[]) {
  return new GeneralName({ type: IP, value: new OctetString({ valueHex: new Uint8Array(bytes) }) })
}

/** A new key and self-signed certificate on every call; `cn` lets a test tell two leaves apart. */
export async function throwawayLeaf(cn = "localhost"): Promise<LeafTls> {
  const engine = new CryptoEngine({ name: "office-bridge-test", crypto: globalThis.crypto })
  const keys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"])
  const cert = new Certificate()
  const now = Date.now()
  const serial = crypto.getRandomValues(new Uint8Array(12))
  serial[0] = serial[0]! & 0x7f
  cert.version = 2
  cert.serialNumber.valueBlock.valueHexView = serial
  cert.issuer.typesAndValues.push(new AttributeTypeAndValue({ type: OID_CN, value: new Utf8String({ value: cn }) }))
  cert.subject.typesAndValues.push(new AttributeTypeAndValue({ type: OID_CN, value: new Utf8String({ value: cn }) }))
  cert.notBefore = new Time({ type: 0, value: new Date(now - 60_000) })
  cert.notAfter = new Time({ type: 0, value: new Date(now + 2 * 24 * 3600_000) })
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey, engine)
  const san = new AltName({
    altNames: [
      new GeneralName({ type: DNS, value: "localhost" }),
      ip([127, 0, 0, 1]),
      ip([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
    ],
  })
  cert.extensions = [new Extension({ extnID: OID_SAN, critical: false, extnValue: san.toSchema().toBER() })]
  await cert.sign(keys.privateKey, "SHA-256", engine)
  return {
    cert: pem("CERTIFICATE", cert.toSchema(true).toBER()),
    key: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", keys.privateKey)),
  }
}
