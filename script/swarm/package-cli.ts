#!/usr/bin/env bun
/**
 * package-cli.ts — local CLI packaging for Swarm (blueprint row 48).
 *
 * Produces `swarm-darwin-arm64.zip` and its `SHA256SUMS` record WITHOUT ever
 * touching a publish path. This is the local-only replacement for the
 * `Script.release` branch of `packages/opencode/script/build.ts` (which runs
 * `gh release upload`); decision IS-D7 / register I02 require the CLI archive to
 * come from a dedicated local step, never from the release branch.
 *
 * Path is fixed by AD-11 (`masterplan/01a1_register_addendum.md:218`): the refined
 * blueprint places this script at `script/swarm/package-cli.ts`, which wins over the
 * earlier `packages/opencode/script/package-local.*` proposal in 01b section 4.2.
 *
 * Archive content set — the exact IA-8 set (`masterplan/01b_installer_spec.md:301`,
 * `:470`) PLUS the pre-install payload the same row stages (register class 10,
 * PC-PKG-01..05, `masterplan/01c0_preinstall_register.md:213-224`; AD-11
 * `:215`). Eleven files:
 *   swarm, install.sh, LICENSE, NOTICE, THIRD_PARTY_LICENSES.txt, rg,
 *   swarm-setup, tools.lock.json,
 *   compose/searxng.yml, compose/firecrawl.yml, compose/searxng.settings.yml
 * `rg` is present because gate-2 decision 5 resolved IS-ND-1 to "ripgrep bundled"
 * (AD-15 part 1); its build-time source lives outside the repo per AD-15 part 3.
 *
 * Fail-closed rules (this row's Verification column, 02_structured.md:212/:345):
 *   1. Refuse immediately when OPENCODE_RELEASE is set — proves no CI-publish coupling.
 *   2. Refuse when any input is missing or zero-length, listing every one by name.
 *   3. Refuse when the staged/produced set is not exactly the eleven-file manifest.
 *   4. Refuse when any staged path would carry the old brand name (`opencode`).
 *
 * The script builds nothing: `--binary` points at an externally built CLI binary
 * (row 47/115 produce it). Modes follow 01b section 4.2 step 3 (755 executables,
 * 644 text). Deterministic: no clock, no randomness, sorted listings.
 */

import { createHash } from "node:crypto"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"

// ---------------------------------------------------------------------------
// Manifest — the single definition of what ships. One entry per archive file.
// ---------------------------------------------------------------------------

type Mode = 0o755 | 0o644

interface ManifestEntry {
  /** Path inside the archive (POSIX separators, flat root + one `compose/` dir). */
  readonly archivePath: string
  /** File mode applied in staging (01b 4.2 step 3). */
  readonly mode: Mode
  /** Human label naming the input in fail-closed messages and --help. */
  readonly label: string
  /** Register/spec provenance for the reader. */
  readonly source: string
}

const MANIFEST: readonly ManifestEntry[] = [
  { archivePath: "swarm", mode: 0o755, label: "CLI binary", source: "IA-8 / I02 (row 47/115 build)" },
  { archivePath: "install.sh", mode: 0o755, label: "installer", source: "IA-8 / I06 (repo root `install`)" },
  { archivePath: "LICENSE", mode: 0o644, label: "licence", source: "IA-8 / IS-D4 (repo root)" },
  { archivePath: "NOTICE", mode: 0o644, label: "notice", source: "IA-8 / IS-D4 (repo root, row 63)" },
  {
    archivePath: "THIRD_PARTY_LICENSES.txt",
    mode: 0o644,
    label: "third-party licences",
    source: "IA-8 / IS-D4 (repo root, row 65)",
  },
  { archivePath: "rg", mode: 0o755, label: "bundled ripgrep", source: "AD-15 part 4 / decision 5 (outside repo)" },
  { archivePath: "swarm-setup", mode: 0o755, label: "pre-install program", source: "PC-PKG-01 (row 106 build)" },
  { archivePath: "tools.lock.json", mode: 0o644, label: "verification lock", source: "PC-PKG-02 (row 80)" },
  { archivePath: "compose/searxng.yml", mode: 0o644, label: "SearXNG compose", source: "PC-PKG-03 (row 91)" },
  { archivePath: "compose/firecrawl.yml", mode: 0o644, label: "Firecrawl compose", source: "PC-PKG-04 (row 92)" },
  {
    archivePath: "compose/searxng.settings.yml",
    mode: 0o644,
    label: "SearXNG settings template",
    source: "PC-PKG-05 (row 91)",
  },
]

const EXPECTED_COUNT = MANIFEST.length // 11

// ---------------------------------------------------------------------------
// Input resolution — defaults plus per-file overrides. Nothing is built here.
// ---------------------------------------------------------------------------

interface Options {
  readonly repoRoot: string
  readonly workspaceRoot: string
  readonly binary: string
  readonly install: string
  readonly license: string
  readonly notice: string
  readonly thirdParty: string
  readonly rg: string
  readonly preinstallDir: string
  readonly setup: string | undefined
  readonly toolsLock: string | undefined
  readonly composeDir: string | undefined
  readonly out: string
  readonly stage: string
  readonly keepStage: boolean
}

function usage(): string {
  const rows = MANIFEST.map((e) => `    ${e.archivePath.padEnd(28)} ${e.label}  [${e.source}]`).join("\n")
  return `package-cli.ts — local-only Swarm CLI packager (row 48). Never publishes.

Stages exactly ${EXPECTED_COUNT} files into ${"swarm-darwin-arm64.zip"} and writes SHA256SUMS:
${rows}

Usage:
  bun script/swarm/package-cli.ts [flags]

Flags (each names where one input comes from; all fail closed if absent/empty):
  --binary <path>       built swarm CLI binary   (default <repo>/packages/opencode/dist/swarm-darwin-arm64/bin/swarm)
  --install <path>      installer source         (default <repo>/install, shipped as install.sh)
  --license <path>      LICENSE                  (default <repo>/LICENSE)
  --notice <path>       NOTICE                   (default <repo>/NOTICE)
  --third-party <path>  THIRD_PARTY_LICENSES.txt (default <repo>/THIRD_PARTY_LICENSES.txt)
  --rg <path>           bundled ripgrep          (default <root>/tools/vendor/ripgrep/15.1.0/rg)
  --preinstall <dir>    dir holding the setup payload in archive layout
                        (default <root>/tools/preinstall; expects swarm-setup, tools.lock.json,
                         compose/{searxng.yml,firecrawl.yml,searxng.settings.yml})
  --setup <path>        override for swarm-setup only
  --tools-lock <path>   override for tools.lock.json only
  --compose-dir <path>  override for the compose/ directory only
  --out <path>          archive to write         (default <repo>/packages/opencode/dist/swarm-darwin-arm64.zip)
  --stage <dir>         staging directory        (default a fresh mkdtemp under the OS temp dir)
  --keep-stage          leave the staging dir in place after zipping
  --repo <path>         repo root                (default the swarm/ dir two levels above this script)
  --help                show this text

Refuses (exit 1) when OPENCODE_RELEASE is set, before doing any work.`
}

interface ParsedArgs {
  readonly flags: Map<string, string | true>
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === undefined) continue
    if (!token.startsWith("--")) throw new Error(`unexpected positional argument: ${token}`)
    const key = token.slice(2)
    const next = argv[i + 1]
    if (key === "keep-stage" || key === "help") {
      flags.set(key, true)
      continue
    }
    if (next === undefined || next.startsWith("--")) throw new Error(`flag --${key} needs a value`)
    flags.set(key, next)
    i++
  }
  return { flags }
}

function str(flags: Map<string, string | true>, key: string): string | undefined {
  const v = flags.get(key)
  return typeof v === "string" ? v : undefined
}

function buildOptions(argv: readonly string[]): Options {
  const { flags } = parseArgs(argv)
  if (flags.has("help")) {
    process.stdout.write(usage() + "\n")
    process.exit(0)
  }
  // import.meta.dir is the directory holding this file: <repo>/script/swarm.
  const scriptDir = import.meta.dir
  const repoRoot = resolve(str(flags, "repo") ?? resolve(scriptDir, "..", ".."))
  const workspaceRoot = resolve(repoRoot, "..")
  const preinstallDir = str(flags, "preinstall") ?? join(workspaceRoot, "tools", "preinstall")
  const stageDefault = join(realpathTemp(), `swarm-cli-stage-${process.pid}`)
  return {
    repoRoot,
    workspaceRoot,
    binary:
      str(flags, "binary") ?? join(repoRoot, "packages", "opencode", "dist", "swarm-darwin-arm64", "bin", "swarm"),
    install: str(flags, "install") ?? join(repoRoot, "install"),
    license: str(flags, "license") ?? join(repoRoot, "LICENSE"),
    notice: str(flags, "notice") ?? join(repoRoot, "NOTICE"),
    thirdParty: str(flags, "third-party") ?? join(repoRoot, "THIRD_PARTY_LICENSES.txt"),
    rg: str(flags, "rg") ?? join(workspaceRoot, "tools", "vendor", "ripgrep", "15.1.0", "rg"),
    preinstallDir,
    setup: str(flags, "setup"),
    toolsLock: str(flags, "tools-lock"),
    composeDir: str(flags, "compose-dir"),
    out: str(flags, "out") ?? join(repoRoot, "packages", "opencode", "dist", "swarm-darwin-arm64.zip"),
    stage: str(flags, "stage") ?? stageDefault,
    keepStage: flags.get("keep-stage") === true,
  }
}

function realpathTemp(): string {
  return tmpdir()
}

/** Resolve the on-disk source path for one manifest entry given the options. */
function sourceFor(entry: ManifestEntry, opts: Options): string {
  switch (entry.archivePath) {
    case "swarm":
      return opts.binary
    case "install.sh":
      return opts.install
    case "LICENSE":
      return opts.license
    case "NOTICE":
      return opts.notice
    case "THIRD_PARTY_LICENSES.txt":
      return opts.thirdParty
    case "rg":
      return opts.rg
    case "swarm-setup":
      return opts.setup ?? join(opts.preinstallDir, "swarm-setup")
    case "tools.lock.json":
      return opts.toolsLock ?? join(opts.preinstallDir, "tools.lock.json")
    case "compose/searxng.yml":
      return join(opts.composeDir ?? join(opts.preinstallDir, "compose"), "searxng.yml")
    case "compose/firecrawl.yml":
      return join(opts.composeDir ?? join(opts.preinstallDir, "compose"), "firecrawl.yml")
    case "compose/searxng.settings.yml":
      return join(opts.composeDir ?? join(opts.preinstallDir, "compose"), "searxng.settings.yml")
    default:
      throw new Error(`no source mapping for ${entry.archivePath}`)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface InputProblem {
  readonly entry: ManifestEntry
  readonly source: string
  readonly reason: "missing" | "empty"
}

function collectInputProblems(opts: Options): InputProblem[] {
  const problems: InputProblem[] = []
  for (const entry of MANIFEST) {
    const source = sourceFor(entry, opts)
    if (!existsSync(source)) {
      problems.push({ entry, source, reason: "missing" })
      continue
    }
    if (statSync(source).size === 0) {
      problems.push({ entry, source, reason: "empty" })
    }
  }
  return problems
}

/** Recursively list every regular file under `root`, POSIX-relative, sorted. */
function listFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name)
      if (statSync(abs).isDirectory()) walk(abs)
      else out.push(relative(root, abs).split(sep).join("/"))
    }
  }
  walk(root)
  return out.sort()
}

function sha256File(abs: string): string {
  return createHash("sha256").update(readFileSync(abs)).digest("hex")
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): number {
  // Gate 1 — refuse before any work when the CI publish switch is present.
  // `Script.release` is `!!env.OPENCODE_RELEASE` (packages/script/src/index.ts);
  // its presence means we are inheriting a publishing environment, which Q11/IS-D7
  // forbid for this local step. Checked first so nothing else runs.
  const releaseEnv = process.env["OPENCODE_RELEASE"]
  if (releaseEnv !== undefined && releaseEnv !== "") {
    process.stderr.write(
      `REFUSED: OPENCODE_RELEASE is set ("${releaseEnv}"). This is a local-only packaging step\n` +
        `and must never run in a publish environment (decision IS-D7 / Q11). Unset it and retry.\n`,
    )
    return 1
  }

  let opts: Options
  try {
    opts = buildOptions(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`ERROR: ${(err as Error).message}\n\n${usage()}\n`)
    return 2
  }

  // Gate 2 — every input must exist and be non-empty; report ALL of them at once.
  const problems = collectInputProblems(opts)
  if (problems.length > 0) {
    process.stderr.write(`REFUSED: ${problems.length} required input(s) unavailable.\n`)
    for (const p of problems) {
      process.stderr.write(
        `  - ${p.entry.label} (${p.entry.archivePath}, ${p.entry.source}): ${p.reason} at ${p.source}\n`,
      )
    }
    return 1
  }

  const outAbs = resolve(opts.out)
  const stageAbs = resolve(opts.stage)

  // Fresh staging directory.
  rmSync(stageAbs, { recursive: true, force: true })
  mkdirSync(stageAbs, { recursive: true })

  // Stage each manifest entry with its declared mode.
  for (const entry of MANIFEST) {
    const dest = join(stageAbs, entry.archivePath)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(sourceFor(entry, opts), dest)
    chmodSync(dest, entry.mode)
  }

  // Gate 3 — the staged tree must equal the manifest exactly (no extra, none missing).
  const staged = listFiles(stageAbs)
  const expected = MANIFEST.map((e) => e.archivePath).sort()
  const extra = staged.filter((f) => !expected.includes(f))
  const missing = expected.filter((f) => !staged.includes(f))
  if (extra.length > 0 || missing.length > 0) {
    process.stderr.write(`REFUSED: staged set does not match the ${EXPECTED_COUNT}-file manifest.\n`)
    for (const f of extra) process.stderr.write(`  + unexpected: ${f}\n`)
    for (const f of missing) process.stderr.write(`  - missing:    ${f}\n`)
    if (!opts.keepStage) rmSync(stageAbs, { recursive: true, force: true })
    return 1
  }

  // Gate 4 — no shipped path may carry the old brand name (register AC2).
  const branded = staged.filter((f) => /opencode/i.test(f))
  if (branded.length > 0) {
    process.stderr.write(`REFUSED: shipped path carries the old brand:\n`)
    for (const f of branded) process.stderr.write(`  ! ${f}\n`)
    if (!opts.keepStage) rmSync(stageAbs, { recursive: true, force: true })
    return 1
  }

  // Build the archive flat at the root, mirroring upstream BLD:246 (`zip -r -X ... *`)
  // so the installer finds `swarm` at the archive root (INS expectation, 01b 4.2 step 4).
  mkdirSync(dirname(outAbs), { recursive: true })
  rmSync(outAbs, { force: true }) // zip appends to an existing file; start clean.
  const topLevel = readdirSync(stageAbs)
  execFileSync("zip", ["-r", "-X", outAbs, ...topLevel], { cwd: stageAbs, stdio: ["ignore", "inherit", "inherit"] })

  // Re-verify the produced archive listing equals the manifest (belt-and-braces on zip).
  const listed = unzipFileList(outAbs)
  const lExtra = listed.filter((f) => !expected.includes(f))
  const lMissing = expected.filter((f) => !listed.includes(f))
  if (lExtra.length > 0 || lMissing.length > 0) {
    process.stderr.write(`REFUSED: produced archive does not match the manifest.\n`)
    for (const f of lExtra) process.stderr.write(`  + unexpected: ${f}\n`)
    for (const f of lMissing) process.stderr.write(`  - missing:    ${f}\n`)
    if (!opts.keepStage) rmSync(stageAbs, { recursive: true, force: true })
    return 1
  }

  // Integrity record for the archive (IA-14): SHA256SUMS beside the zip, verifiable
  // with `shasum -a 256 -c SHA256SUMS` from the archive's own directory.
  const sumsPath = join(dirname(outAbs), "SHA256SUMS")
  const line = `${sha256File(outAbs)}  ${outAbs.split("/").pop() ?? "swarm-darwin-arm64.zip"}\n`
  writeFileSync(sumsPath, line, { mode: 0o644 })

  // Print the archive listing (01b 4.2 step 6).
  execFileSync("unzip", ["-l", outAbs], { stdio: ["ignore", "inherit", "inherit"] })
  process.stdout.write(`wrote ${outAbs}\n`)
  process.stdout.write(`wrote ${sumsPath}: ${line.trimEnd()}\n`)

  if (!opts.keepStage) rmSync(stageAbs, { recursive: true, force: true })
  return 0
}

/** Parse `unzip -l` into the set of non-directory entry names, sorted. */
function unzipFileList(zipAbs: string): string[] {
  const raw = execFileSync("unzip", ["-Z", "-1", zipAbs], { encoding: "utf8" })
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.endsWith("/"))
    .sort()
}

process.exit(main())
