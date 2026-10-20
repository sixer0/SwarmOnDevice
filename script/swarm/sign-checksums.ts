#!/usr/bin/env bun
/**
 * sign-checksums.ts — release-integrity tooling for the OpenCode -> Swarm rebrand.
 *
 * Row 70 (NR-10, security preread C4-2 / C4-4). One standalone tool with three
 * duties, all offline and all operating on files the CALLER supplies:
 *
 *   sign    Sign a SHA256SUMS manifest with `ssh-keygen -Y sign -n swarm-release`
 *           using a SUPPLIED private key path. Writes `<manifest>.sig`.
 *   verify  Verify a signature over a manifest with `ssh-keygen -Y verify` against
 *           a SUPPLIED allowed-signers file and signer identity. Exit 0 == valid.
 *   cdhash  Record the app CodeDirectory hash (`codesign -dvvv`) for a given .app
 *           bundle, printed to stdout so the handover (row 117) can capture it.
 *
 * Hard rules baked into this file (NR-10 + driver red lines):
 *   - It NEVER generates, stores, or moves keys. It only reads a key path handed
 *     to it for one signing run. There is no `ssh-keygen -t` anywhere here.
 *   - It performs NO network access. Every action is a local subprocess call.
 *   - It FAILS CLOSED: any missing, empty, or non-regular input exits non-zero
 *     before any subprocess runs, so a half-configured invocation can never emit
 *     a misleading "ok".
 *
 * Why ssh-keygen -Y rather than GPG: the host already ships OpenSSH with the `-Y`
 * sign/verify mode (research/03e_security_preread.md:112 records it as [V] on this
 * machine), it needs no Apple certificate, and the allowed-signers file gives a
 * small, reviewable list of trusted release principals. The signed object is the
 * SHA256SUMS manifest itself (the desktop `packages/desktop/dist/SHA256SUMS` and
 * the CLI-archive `dist/SHA256SUMS`, format `shasum -a 256`, IA-14), so origin is
 * bound to the same integrity statement the installer already checks.
 *
 * The manifest filename is an ARGUMENT, not a constant: the packaging step that
 * produces it (row 48) was still in flight when this tool was written, so tying
 * this script to a fixed name could have drifted from row 48's final choice. The
 * caller passes whatever SHA256SUMS path its pipeline wrote.
 */

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"

// Namespace tag baked into every signature. Kept as one constant so sign and
// verify can never disagree about what they are signing/checking.
const DEFAULT_NAMESPACE = "swarm-release"

// ---------------------------------------------------------------------------
// Fail-closed helpers. `fail` always throws so control flow never continues past
// a rejected input; the top-level catch turns it into a single exit(1).
// ---------------------------------------------------------------------------
function fail(message: string): never {
  throw new Error(message)
}

function requireFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name)
  if (value === undefined || value.length === 0) {
    fail(`missing required flag --${name}`)
  }
  return value as string
}

// A usable input file: present, a regular file, and non-empty. Empty manifests or
// empty keys are treated exactly like missing ones — we refuse rather than let the
// underlying tool produce a confusing low-level error.
function requireRegularFile(label: string, filePath: string, opts: { allowEmpty?: boolean } = {}): string {
  if (!existsSync(filePath)) fail(`${label} not found: ${filePath}`)
  const st = statSync(filePath)
  if (!st.isFile()) fail(`${label} is not a regular file: ${filePath}`)
  if (!opts.allowEmpty && st.size === 0) fail(`${label} is empty: ${filePath}`)
  return filePath
}

// Parse `--key value` pairs into a map. Unknown flags are kept (harmless) but a
// flag with no following value fails closed.
function parseFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string
    if (!token.startsWith("--")) continue
    const key = token.slice(2)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith("--")) {
      fail(`flag --${key} requires a value`)
    }
    flags.set(key, value as string)
    i++ // consume the value
  }
  return flags
}

function namespaceOf(flags: Map<string, string>): string {
  return flags.get("namespace") ?? DEFAULT_NAMESPACE
}

// Run a subprocess, streaming its own stdout/stderr through to ours, and return
// its exit code (or fail closed if it could not be spawned at all).
function runTool(cmd: string, args: readonly string[], input?: string | Buffer): number {
  const result = spawnSync(cmd, [...args], {
    encoding: "buffer",
    input,
    stdio: ["pipe", "inherit", "inherit"],
  })
  if (result.error) fail(`${cmd} could not be run: ${result.error.message}`)
  if (typeof result.status !== "number") {
    fail(`${cmd} terminated by signal ${result.signal ?? "unknown"}`)
  }
  return result.status
}

// ---------------------------------------------------------------------------
// Subcommand: sign
// ---------------------------------------------------------------------------
function cmdSign(flags: Map<string, string>): number {
  const sums = requireRegularFile("manifest", requireFlag(flags, "sums"))
  // The private key is SUPPLIED by the caller and used for this one run only.
  // We read it solely to hand the path to ssh-keygen; we never copy, persist, or
  // generate it. allowEmpty:false means a zero-byte key fails closed.
  const key = requireRegularFile("private key", requireFlag(flags, "key"))
  const namespace = namespaceOf(flags)

  process.stderr.write(`sign-checksums: signing ${sums} as "${namespace}"\n`)
  // ssh-keygen -Y sign always writes "<file>.sig" next to the input; there is no
  // output-path flag, so we surface the resulting name ourselves.
  const status = runTool("ssh-keygen", ["-Y", "sign", "-n", namespace, "-f", key, sums])
  if (status !== 0) {
    fail(`ssh-keygen -Y sign exited ${status}; no trustworthy signature produced`)
  }
  const sigPath = `${sums}.sig`
  process.stderr.write(`sign-checksums: signature written to ${sigPath}\n`)
  return 0
}

// ---------------------------------------------------------------------------
// Subcommand: verify
// ---------------------------------------------------------------------------
function cmdVerify(flags: Map<string, string>): number {
  const sums = requireRegularFile("manifest", requireFlag(flags, "sums"))
  const signature = requireRegularFile("signature", requireFlag(flags, "signature"))
  const signers = requireRegularFile("allowed-signers", requireFlag(flags, "signers"))
  const principal = requireFlag(flags, "principal")
  const namespace = namespaceOf(flags)

  // `ssh-keygen -Y verify` reads the SIGNED PAYLOAD from stdin (the signature
  // comes from -s), unlike `sign` which takes the file positionally. Feed the
  // exact bytes of the manifest so a one-byte edit cannot slip through.
  const payload = readFileSync(sums)
  const status = runTool(
    "ssh-keygen",
    ["-Y", "verify", "-f", signers, "-I", principal, "-n", namespace, "-s", signature],
    payload,
  )
  if (status !== 0) {
    process.stderr.write(`sign-checksums: VERIFY FAILED for ${sums} (exit ${status})\n`)
    return status
  }
  process.stderr.write(`sign-checksums: verified OK for ${sums} (principal ${principal})\n`)
  return 0
}

// ---------------------------------------------------------------------------
// Subcommand: cdhash
// ---------------------------------------------------------------------------
function cmdCdhash(flags: Map<string, string>): number {
  const app = requireFlag(flags, "app")
  if (!existsSync(app)) fail(`app bundle not found: ${app}`)
  const st = statSync(app)
  if (!st.isDirectory()) fail(`app is not a bundle directory: ${app}`)

  // codesign prints its descriptor dump to stderr, so merge 2>&1 by capturing
  // both streams ourselves rather than relying on a shell redirect.
  const result = spawnSync("codesign", ["-dvvv", app], { encoding: "utf8" })
  if (result.error) fail(`codesign could not be run: ${result.error.message}`)
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
  const cdhashLines = combined
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => /cdhash/i.test(line))

  if (cdhashLines.length === 0) {
    fail(`no CDHash reported by codesign for ${app} (is it a signed bundle?)`)
  }
  // Print every cdhash-bearing line (CandidateCDHash, ...Full, and the canonical
  // CDHash=) so nothing is lost, then a single unambiguous token for the handover.
  for (const line of cdhashLines) process.stdout.write(`${line}\n`)
  const canonical = cdhashLines.find((line) => /^CDHash=/i.test(line))
  if (canonical) {
    const value = canonical.slice(canonical.indexOf("=") + 1).trim()
    process.stdout.write(`BASELINE_CDHASH=${value}\n`)
  }
  return 0
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
function usage(): string {
  return [
    "usage:",
    "  bun script/swarm/sign-checksums.ts sign   --sums <SHA256SUMS> --key <privkey> [--namespace swarm-release]",
    "  bun script/swarm/sign-checksums.ts verify --sums <SHA256SUMS> --signature <SHA256SUMS.sig> \\",
    "                                              --signers <allowed-signers> --principal <id> [--namespace swarm-release]",
    "  bun script/swarm/sign-checksums.ts cdhash --app <path/to/App.app>",
    "",
    "keys are always supplied by the caller; this tool never generates or stores them.",
  ].join("\n")
}

function main(argv: readonly string[]): number {
  const sub = argv[0]
  if (sub === undefined || sub === "-h" || sub === "--help" || sub === "help") {
    process.stdout.write(`${usage()}\n`)
    return sub === undefined ? 1 : 0
  }
  const flags = parseFlags(argv.slice(1))
  switch (sub) {
    case "sign":
      return cmdSign(flags)
    case "verify":
      return cmdVerify(flags)
    case "cdhash":
      return cmdCdhash(flags)
    default:
      fail(`unknown subcommand "${sub}"\n${usage()}`)
  }
}

try {
  process.exit(main(process.argv.slice(2)))
} catch (error) {
  process.stderr.write(`sign-checksums: error: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
