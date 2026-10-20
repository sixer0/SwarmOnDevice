import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Row 70 fix round. `sign` used to fail open when `<sums>.sig` already existed:
// ssh-keygen's "Overwrite (y/n)?" prompt got an immediate EOF from the wrapper's
// stdin pipe, the write was declined, ssh-keygen still exited 0, and cmdSign
// printed "signature written" anyway — the finding recorded in
// `verification/14_checksum_signing.md` §R7. Every case below pins the
// replacement invariant: EXIT 0 IMPLIES A FRESHLY WRITTEN SIGNATURE over the
// manifest bytes read around the call.
//
// Red lines honoured by this file (driver_rules_s3.md rule 3 + the tool's own
// contract): the private key is a THROWAWAY ed25519 created under os.tmpdir()
// by this harness — the tool itself still never generates keys — and it is
// deleted with the temp dir in afterAll. No shipped artifact is touched, no
// case reaches the network, and nothing is written inside the repo except this
// file itself.

const TOOL = path.join(import.meta.dir, "sign-checksums.ts")
const PRINCIPAL = "release@ptgsp"
const root = mkdtempSync(path.join(os.tmpdir(), "swarm-signfix-"))
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const keyPath = path.join(root, "throwaway_release_key")
const signersPath = path.join(root, "allowed-signers")
{
  const gen = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-C", PRINCIPAL, "-N", "", "-f", keyPath], {
    encoding: "utf8",
  })
  expect(gen.status).toBe(0) // throwaway half-lives die with `root`, never in the repo
  writeFileSync(signersPath, `${PRINCIPAL} ${readFileSync(`${keyPath}.pub`, "utf8").trim()}\n`)
}

const sha256File = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex")

// A manifest line shaped like `shasum -a 256` output (IA-14 format); the digest
// value is a stand-in so each scenario can move the manifest bytes on demand.
const manifestLine = (tag: string): string =>
  `${createHash("sha256").update(tag).digest("hex")}  swarm-darwin-arm64.zip\n`

let wsCount = 0
function workspace(tag: string): string {
  const dir = path.join(root, `ws${wsCount++}`)
  mkdirSync(dir)
  writeFileSync(path.join(dir, "SHA256SUMS"), manifestLine(tag))
  return dir
}

// `envPath` overrides PATH only (used by the shim case); otherwise inherit.
function runSign(dir: string, extraArgs: readonly string[] = [], envPath?: string) {
  return spawnSync(
    process.execPath,
    [TOOL, "sign", "--sums", "SHA256SUMS", "--key", keyPath, ...extraArgs],
    {
      cwd: dir,
      encoding: "utf8",
      env: envPath === undefined ? process.env : { ...process.env, PATH: envPath },
    },
  )
}

function runVerify(sums: string, signature: string) {
  return spawnSync(
    process.execPath,
    [TOOL, "verify", "--sums", sums, "--signature", signature, "--signers", signersPath, "--principal", PRINCIPAL],
    { cwd: root, encoding: "utf8" },
  )
}

describe("sign — positive control: the clean path still works", () => {
  test("no pre-existing .sig: exit 0, bytes written, verify passes", () => {
    const dir = workspace("clean-v1")
    const res = runSign(dir)
    expect(res.status).toBe(0)
    expect(res.stderr).toContain("signature written to")
    expect(statSync(path.join(dir, "SHA256SUMS.sig")).size).toBeGreaterThan(0)
    expect(runVerify(path.join(dir, "SHA256SUMS"), path.join(dir, "SHA256SUMS.sig")).status).toBe(0)
  })
})

describe("sign — negative control: a stale .sig cannot survive silently (§R7)", () => {
  test("existing .sig without --overwrite: refused before any subprocess, old bytes intact", () => {
    const dir = workspace("stale-v1")
    expect(runSign(dir).status).toBe(0) // first sign legitimately creates the .sig
    const stale = sha256File(path.join(dir, "SHA256SUMS.sig"))
    writeFileSync(path.join(dir, "SHA256SUMS"), manifestLine("rebuilt-v2")) // a rebuild moves the covered bytes on
    const res = runSign(dir)
    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain("--overwrite")
    // the exact success-line prefix, not a loose substring: failure lines may
    // legitimately contain the words "signature written" (e.g. "no fresh
    // signature written") without claiming success
    expect(res.stderr).not.toContain("sign-checksums: signature written to")
    expect(res.stderr).not.toContain("Signing file") // ssh-keygen never even ran: refusal precedes the subprocess
    expect(sha256File(path.join(dir, "SHA256SUMS.sig"))).toBe(stale) // nothing destroyed, nothing lied about
    // and the surviving pairing is honestly reported as invalid, not as a success:
    expect(runVerify(path.join(dir, "SHA256SUMS"), path.join(dir, "SHA256SUMS.sig")).status).not.toBe(0)
  })

  test("--overwrite replaces the stale signature and the fresh one verifies", () => {
    const dir = workspace("replace-v1")
    expect(runSign(dir).status).toBe(0)
    const stale = sha256File(path.join(dir, "SHA256SUMS.sig"))
    writeFileSync(path.join(dir, "SHA256SUMS"), manifestLine("rebuilt-v2"))
    const res = runSign(dir, ["--overwrite"])
    expect(res.status).toBe(0)
    expect(res.stderr).toContain("signature written to")
    expect(sha256File(path.join(dir, "SHA256SUMS.sig"))).not.toBe(stale)
    expect(runVerify(path.join(dir, "SHA256SUMS"), path.join(dir, "SHA256SUMS.sig")).status).toBe(0)
  })

  test("--overwrite over an UNCHANGED manifest also succeeds: freshness may not be content-based", () => {
    // Ed25519 signing is deterministic on this host (measured during the fix
    // round: same key + same manifest + same path reproduced the identical .sig
    // body), so demanding a content change would falsely reject legitimate
    // idempotent re-signs. The gate is therefore write-confirmation, not diff.
    const dir = workspace("deterministic")
    expect(runSign(dir).status).toBe(0)
    const res = runSign(dir, ["--overwrite"])
    expect(res.status).toBe(0)
    expect(res.stderr).toContain("signature written to")
    expect(runVerify(path.join(dir, "SHA256SUMS"), path.join(dir, "SHA256SUMS.sig")).status).toBe(0)
  })

  test("an ssh-keygen that exits 0 WITHOUT writing is caught by the post-write check", () => {
    // Emulates the exact §R7 defect shape — prompt answered, nothing written,
    // exit 0 — behind a PATH shim, the same stub idiom as the curl/wget spies in
    // script/install.test.ts. Without the post-write confirmation this call
    // would print "signature written" and exit 0, which is the lie being fixed.
    const bin = path.join(root, "shim-bin")
    mkdirSync(bin)
    const shim = path.join(bin, "ssh-keygen")
    writeFileSync(
      shim,
      "#!/bin/sh\nfor last; do true; done\nprintf '%s.sig already exists.\\nOverwrite (y/n)? ' \"$last\" >&2\nIFS= read -r answer\nexit 0\n",
    )
    chmodSync(shim, 0o755)
    const dir = workspace("shim-v1")
    expect(runSign(dir).status).toBe(0) // real ssh-keygen makes the first .sig
    const stale = sha256File(path.join(dir, "SHA256SUMS.sig"))
    const res = runSign(dir, ["--overwrite"], `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`)
    expect(res.status).not.toBe(0)
    expect(res.stderr).not.toContain("sign-checksums: signature written to")
    expect(res.stderr).toContain("no fresh signature written") // the post-write check is what caught it
    expect(sha256File(path.join(dir, "SHA256SUMS.sig"))).toBe(stale)
  })
})

describe("verify — path unaffected by the fix", () => {
  test("good pair verifies at exit 0; a one-byte manifest edit does not", () => {
    const dir = workspace("verify-pair")
    expect(runSign(dir).status).toBe(0)
    const sums = path.join(dir, "SHA256SUMS")
    const sig = path.join(dir, "SHA256SUMS.sig")
    expect(runVerify(sums, sig).status).toBe(0)
    const tampered = path.join(dir, "SHA256SUMS.tampered")
    const bytes = Buffer.from(readFileSync(sums))
    // substitution inside the filename field with the size held, mirroring §R6 Control A
    bytes[bytes.length - 2] = bytes[bytes.length - 2] === 0x61 ? 0x62 : 0x61
    writeFileSync(tampered, bytes)
    expect(runVerify(tampered, sig).status).not.toBe(0)
  })
})
