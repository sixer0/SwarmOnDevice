// Release tool for Swarm system patches (SP-B, register BN-01).
//
//   bun scripts/swarm-patch-release.ts make --from-app <Swarm.app> --to-app <Swarm.app> \
//     --from-commit <rev> --to-commit <rev> --migration none|forward --out <work folder>
//
// `make` writes an unsigned work folder (BN-11): `manifest`, `payload.zip`, `sign_command.txt`.
// It never signs and never touches a private key: the sign command is printed with the placeholder
// BN-14a and the user runs it in a separate Terminal window (G4, P7, D52-4).
//
//   bun scripts/swarm-patch-release.ts seal --from-app <Swarm.app> --work <work folder>
//
// `seal` checks the user's `manifest.sig` against the from-app's `allowed_signers` (which must equal the
// repo anchor at HEAD), re-checks the payload, and assembles exactly one `.swarmpatch` (BN-14) next to the
// inputs. It only ever verifies; it takes no key path.
//
// Self-contained on purpose (U-1): only `node:*` imports, so a copy in a throwaway repo behaves the same.
// Exit codes (R50-1): 0 success, 1 refused or failed, 2 usage. Errors (R50-2): one stderr line
// `swarm-patch-release: <make|seal>: <text>`.
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

// ---------------------------------------------------------------------------------------------
// Constants (register sections 1, 2, 3, 5, 13, 14)

const TOOL = "swarm-patch-release"
const NAMESPACE = "id.co.gsp.swarm.patch.v1"
const BUNDLE_ID = "id.co.gsp.swarm.desktop"
const APP_NAME = "Swarm.app"
const PATCH_FOLDER = "swarm-patch"
const KEY_PLACEHOLDER = "YOUR_PRIVATE_KEY_PATH" // BN-14a
const PARTIAL = ".partial" // R50-3 (folder) and BN-15 (package file)
const MANIFEST_MAX_BYTES = 16384
const SIGNATURE_MAX_BYTES = 4096
const PRINCIPAL = "swarm-patch-gsp"
const PACKAGE_EXT = ".swarmpatch"
const SEAL_CHECK = ".seal_check" // register 14.8 (C21 #8)
const WORK_INPUTS = ["manifest", "manifest.sig", "payload.zip", "sign_command.txt"] as const
const PACKAGE_ENTRIES = ["manifest", "manifest.sig", "payload.zip"] as const
const SEMVER = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/
const MANIFEST_KEYS = [
  "format",
  "bundle_id",
  "release",
  "from_min",
  "payload_sha256",
  "payload_bytes",
  "unpacked_bytes",
  "migration",
  "data_min_release",
] as const

const BIN = {
  ditto: "/usr/bin/ditto",
  shasum: "/usr/bin/shasum",
  du: "/usr/bin/du",
  stat: "/usr/bin/stat",
  plutil: "/usr/bin/plutil",
  codesign: "/usr/bin/codesign",
  git: "/usr/bin/git",
  sshKeygen: "/usr/bin/ssh-keygen", // `-Y verify` only (U-2, U-5)
  zip: "/usr/bin/zip",
  zipinfo: "/usr/bin/zipinfo",
  unzip: "/usr/bin/unzip",
} as const

// Repo root (BN-05) and repo anchor (U-8, used by seal). Derived from the script location only.
const SCRIPT_DIR = import.meta.dir
const REPO_ANCHOR = path.join(SCRIPT_DIR, "..", "resources", PATCH_FOLDER, "allowed_signers")
const REPO_ANCHOR_REL = "packages/desktop/resources/swarm-patch/allowed_signers"

// Migration sources (BN-06..BN-08), relative to the repo root.
const SRC_DB = "packages/core/src/database/migration.gen.ts"
const SRC_STORAGE = "packages/opencode/src/storage/storage.ts"
const SRC_STORE = ["packages/desktop/src/main/migrate.ts", "packages/desktop/src/main/store.ts"] as const

// ---------------------------------------------------------------------------------------------
// Errors and exit codes (R50-1, R50-2)

const EXIT_OK = 0
const EXIT_REFUSED = 1
const EXIT_USAGE = 2

class ToolError extends Error {
  constructor(
    readonly code: typeof EXIT_REFUSED | typeof EXIT_USAGE,
    message: string,
  ) {
    super(message)
  }
}

const refuse = (message: string): never => {
  throw new ToolError(EXIT_REFUSED, message)
}
const usage = (message: string): never => {
  throw new ToolError(EXIT_USAGE, message)
}

/** One printable line: control characters (LF, CR, tab, ESC...) become spaces, length is capped. */
const oneLine = (text: string, max = 600) => {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}...` : flat
}

let currentSub = "" // the subcommand name used in the R50-2 prefix

const printError = (message: string) =>
  process.stderr.write(`${TOOL}: ${currentSub ? `${currentSub}: ` : ""}${oneLine(message)}\n`)

const warn = (message: string) => printError(`warning: ${message}`)

// ---------------------------------------------------------------------------------------------
// Owned scratch paths (U-6): created by this run, removed on any failure or signal

const owned = new Set<string>()
const children = new Set<ReturnType<typeof Bun.spawn>>()
let aborting = false

/** Registers a path this run has just created. Paths that existed before the run are never registered. */
const own = (p: string) => owned.add(p)
/** Hands an owned path over to the user (after the final rename): it is no longer removed. */
const disown = (p: string) => owned.delete(p)

function cleanup() {
  for (const p of owned) {
    try {
      rmSync(p, { recursive: true, force: true })
    } catch (error) {
      process.stderr.write(`${TOOL}: ${currentSub}: could not remove ${oneLine(p)}: ${oneLine(String(error))}\n`)
    }
  }
  owned.clear()
}

async function onSignal(signal: NodeJS.Signals) {
  if (aborting) return
  aborting = true
  // Stop running tools first, so nothing writes into an owned path after it is removed.
  for (const child of children) child.kill("SIGTERM")
  await Promise.allSettled([...children].map((child) => child.exited))
  cleanup()
  printError(`interrupted by ${signal}; nothing was written`)
  process.exit(EXIT_REFUSED)
}

// ---------------------------------------------------------------------------------------------
// Child processes (U-2, U-3, D52-5): argv array, absolute tool path, fixed environment, no shell

type Result = { code: number; stdout: Uint8Array; stderr: string }

const BASE_ENV = () => ({
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LC_ALL: "C",
  HOME: process.env.HOME ?? homedir(),
})

async function spawn(
  argv: string[],
  options: { stdin?: Uint8Array; env?: Record<string, string>; onChunk?: (chunk: Uint8Array) => void } = {},
) {
  if (aborting) return new Promise<never>(() => {})
  const child = Bun.spawn(argv, {
    cwd: "/",
    env: options.env ?? BASE_ENV(),
    stdin: options.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  children.add(child)
  try {
    // With onChunk, stdout is streamed to the caller (large payloads) and not kept.
    const onChunk = options.onChunk
    const [stdout, stderr, code] = await Promise.all([
      onChunk
        ? (async () => {
            for await (const chunk of child.stdout) onChunk(chunk)
            return new ArrayBuffer(0)
          })()
        : new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (aborting) return new Promise<never>(() => {}) // the signal handler finishes the run
    return { code, stdout: new Uint8Array(stdout), stderr } satisfies Result
  } finally {
    children.delete(child)
  }
}

const text = (result: Result) => new TextDecoder().decode(result.stdout)
const firstLine = (result: Result) => oneLine(result.stderr.split("\n").find((l) => l.trim()) ?? `exit ${result.code}`)

/** Runs a tool that must succeed; otherwise refuses with `what` and the tool's first stderr line. */
async function must(argv: string[], what: string, options: Parameters<typeof spawn>[1] = {}) {
  const result = await spawn(argv, options)
  if (result.code !== 0) refuse(`${what}: ${firstLine(result)}`)
  return result
}

// git with D52-5 hardening: no system or global config, no fsmonitor; diff without ext-diff or textconv.
const GIT_ENV = () => ({ ...BASE_ENV(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" })
const git = (root: string, args: string[]) =>
  spawn([BIN.git, "-c", "core.fsmonitor=false", "-C", root, ...args], { env: GIT_ENV() })

// ---------------------------------------------------------------------------------------------
// Paths (U-4, BN-13)

/** Absolute path; refuses `'`, control characters and LF, which BN-13 cannot quote. */
function absolute(name: string, value: string) {
  const resolved = path.resolve(value)
  if (/['\u0000-\u001f\u007f]/.test(resolved)) refuse(`${name}: path contains a quote or control character`)
  return resolved
}

const lstat = (p: string) => {
  try {
    return lstatSync(p)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

const isInside = (child: string, parent: string) => {
  const rel = path.relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

/** BN-13, the printed sign command, for a work folder (final path, not `.partial`). */
export const signCommand = (work: string) =>
  `/usr/bin/ssh-keygen -Y sign -f ${KEY_PLACEHOLDER} -n ${NAMESPACE} '${work}/manifest'`

// ---------------------------------------------------------------------------------------------
// Options (M1, S1)

function parseOptions<const K extends string>(args: string[], names: readonly K[]): Record<K, string> {
  const values = new Map<string, string>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith("--")) usage(`unexpected argument: ${arg}`)
    const name = arg.slice(2)
    if (!(names as readonly string[]).includes(name)) usage(`unknown option: ${arg}`)
    if (values.has(name)) usage(`duplicate option: ${arg}`)
    const value = args[i + 1]
    if (value === undefined || value === "" || value.startsWith("--")) usage(`missing value for ${arg}`)
    values.set(name, value)
    i++
  }
  for (const name of names) if (!values.has(name)) usage(`missing option: --${name}`)
  return Object.fromEntries(values) as Record<K, string>
}

// ---------------------------------------------------------------------------------------------
// Semver (register section 2) and manifest (spec 3.2, U-9; shared by make and seal)

const isSemver = (v: string) => SEMVER.test(v)
const compareSemver = (a: string, b: string) => {
  const x = a.split(".").map(Number)
  const y = b.split(".").map(Number)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return 0
}

type Manifest = Record<(typeof MANIFEST_KEYS)[number], string>

/** Syntax and value rules of spec 3.2. Rules relative to an installed app do not apply here (U-9). */
function parseManifest(bytes: Uint8Array): Manifest {
  if (bytes.length > MANIFEST_MAX_BYTES) refuse(`manifest larger than ${MANIFEST_MAX_BYTES} bytes`)
  for (const b of bytes)
    if (b !== 0x0a && (b < 0x20 || b > 0x7e)) refuse("manifest has a byte outside printable ASCII and LF")
  const body = new TextDecoder().decode(bytes)
  if (!body.endsWith("\n")) refuse("manifest does not end with LF")
  const lines = body.slice(0, -1).split("\n")
  const seen = new Map<string, string>()
  for (const line of lines) {
    if (line === "") refuse("manifest has an empty line")
    const eq = line.indexOf("=")
    const key = eq < 0 ? line : line.slice(0, eq)
    if (eq < 0 || !/^[a-z][a-z0-9_]*$/.test(key)) refuse(`manifest line is not key=value: ${line}`)
    if (!(MANIFEST_KEYS as readonly string[]).includes(key)) refuse(`manifest has unknown key: ${key}`)
    if (seen.has(key)) refuse(`manifest has duplicate key: ${key}`)
    seen.set(key, line.slice(eq + 1))
  }
  for (const key of MANIFEST_KEYS) if (!seen.has(key)) refuse(`manifest misses key: ${key}`)
  const m = Object.fromEntries(seen) as Manifest
  if (m.format !== "1") refuse("manifest format is not 1")
  if (m.bundle_id !== BUNDLE_ID) refuse(`manifest bundle_id is not ${BUNDLE_ID}`)
  for (const key of ["release", "from_min", "data_min_release"] as const)
    if (!isSemver(m[key])) refuse(`manifest ${key} is not a release number`)
  if (compareSemver(m.from_min, m.release) >= 0) refuse("manifest from_min is not lower than release")
  if (!/^[0-9a-f]{64}$/.test(m.payload_sha256)) refuse("manifest payload_sha256 is not 64 hex characters")
  for (const key of ["payload_bytes", "unpacked_bytes"] as const)
    if (!/^[1-9][0-9]{0,12}$/.test(m[key])) refuse(`manifest ${key} is not a positive integer`)
  if (m.migration === "none") {
    if (compareSemver(m.data_min_release, m.from_min) > 0) refuse("manifest data_min_release is above from_min")
  } else if (m.migration === "forward") {
    if (m.data_min_release !== m.release) refuse("manifest data_min_release is not release for forward")
  } else refuse("manifest migration is not none or forward")
  return m
}

const manifestText = (m: Manifest) => MANIFEST_KEYS.map((key) => `${key}=${m[key]}\n`).join("")

const sha256 = (data: string | Buffer) => new Bun.CryptoHasher("sha256").update(data).digest("hex")

// ---------------------------------------------------------------------------------------------
// App checks (M2, S4)

type App = { path: string; release: string; anchor: Buffer }

const plistValue = async (app: string, key: string) => {
  const result = await spawn([BIN.plutil, "-extract", key, "raw", path.join(app, "Contents", "Info.plist")])
  return result.code === 0 ? text(result).replace(/\n$/, "") : undefined
}

/** A regular, non-empty file (lstat, so a symlink is refused). */
function regularFile(p: string, what: string) {
  const st = lstat(p)
  if (!st || !st.isFile() || st.size === 0) refuse(`${what} is not a non-empty regular file: ${p}`)
}

async function checkApp(name: string, app: string, options: { requireApplier: boolean }): Promise<App> {
  const st = lstat(app)
  if (!st || !st.isDirectory() || st.isSymbolicLink()) refuse(`${name}: not a directory: ${app}`)
  await must([BIN.codesign, "--verify", "--deep", "--strict", app], `${name}: code signature is not valid`)
  const id = await plistValue(app, "CFBundleIdentifier")
  if (id !== BUNDLE_ID) refuse(`${name}: CFBundleIdentifier is not ${BUNDLE_ID}`)
  const release = await plistValue(app, "SwarmRelease")
  if (release === undefined) refuse(`${name}: Info.plist has no SwarmRelease`)
  if (!isSemver(release!)) refuse(`${name}: SwarmRelease is not a release number: ${release}`)
  const folder = path.join(app, "Contents", "Resources", PATCH_FOLDER)
  if (options.requireApplier) regularFile(path.join(folder, "swarm-patch"), `${name}: applier`)
  const anchorPath = path.join(folder, "allowed_signers")
  regularFile(anchorPath, `${name}: allowed_signers`)
  return { path: app, release: release!, anchor: readFileSync(anchorPath) }
}

// ---------------------------------------------------------------------------------------------
// Commits and migration sources (M5, M6)

async function repoRoot() {
  const result = await git(SCRIPT_DIR, ["rev-parse", "--show-toplevel"])
  if (result.code !== 0) refuse(`repo root not found from ${SCRIPT_DIR}: ${firstLine(result)}`)
  return text(result).replace(/\n$/, "")
}

async function resolveCommit(root: string, name: string, rev: string) {
  if (rev.startsWith("-") || /[\u0000-\u001f\u007f]/.test(rev)) refuse(`${name}: not a revision: ${rev}`)
  const result = await git(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])
  const sha = text(result).trim()
  if (result.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) refuse(`${name}: not a commit: ${rev}`)
  return sha
}

async function show(root: string, sha: string, file: string) {
  const result = await git(root, ["show", "--no-textconv", `${sha}:${file}`])
  if (result.code !== 0) refuse(`${file} cannot be read at ${sha.slice(0, 10)}: ${firstLine(result)}`)
  return text(result)
}

type Sources = { db: string[]; storage: number }

async function readSources(root: string, sha: string): Promise<Sources> {
  const short = sha.slice(0, 10)
  const db = [...(await show(root, sha, SRC_DB)).matchAll(/import\("\.\/migration\/([^"]+)"\)/g)].map((m) => m[1])
  if (db.length === 0) refuse(`${SRC_DB} at ${short}: no migration ids found`)
  const steps = [...(await show(root, sha, SRC_STORAGE)).matchAll(/"Storage\.migration\.([0-9]+)"/g)].map((m) =>
    Number(m[1]),
  )
  if (steps.length === 0) refuse(`${SRC_STORAGE} at ${short}: no Storage.migration steps found`)
  if (steps.some((n, i) => n !== i + 1)) refuse(`${SRC_STORAGE} at ${short}: steps are not numbered 1..${steps.length}`)
  for (const file of SRC_STORE) await show(root, sha, file) // must exist at both commits
  return { db, storage: steps.length }
}

async function storeChanged(root: string, from: string, to: string) {
  const result = await git(root, ["diff", "--no-ext-diff", "--no-textconv", "--quiet", from, to, "--", ...SRC_STORE])
  if (result.code === 0) return false
  if (result.code === 1) return true
  return refuse(`git diff of ${SRC_STORE.join(", ")} failed: ${firstLine(result)}`)
}

// ---------------------------------------------------------------------------------------------
// make (spec 03 section 3, M1..M13)

const MAKE_OPTIONS = ["from-app", "to-app", "from-commit", "to-commit", "migration", "out"] as const

async function make(args: string[]) {
  // M1
  const opt = parseOptions(args, MAKE_OPTIONS)
  if (opt.migration !== "none" && opt.migration !== "forward") usage(`--migration must be none or forward`)
  const migration = opt.migration as "none" | "forward"
  const fromAppPath = absolute("--from-app", opt["from-app"])
  const toAppPath = absolute("--to-app", opt["to-app"])
  const out = absolute("--out", opt.out)

  // M2
  if (path.basename(toAppPath) !== APP_NAME) refuse(`--to-app: basename is not ${APP_NAME}`)
  const fromApp = await checkApp("--from-app", fromAppPath, { requireApplier: false })
  const toApp = await checkApp("--to-app", toAppPath, { requireApplier: true })
  if (!fromApp.anchor.equals(toApp.anchor))
    refuse("allowed_signers of --to-app differs from --from-app; key change is not supported by this tool")

  // M3
  const fromMin = fromApp.release
  const release = toApp.release
  if (compareSemver(release, fromMin) <= 0) refuse(`release ${release} of --to-app is not greater than ${fromMin}`)

  // M4
  const expected = `patch_${fromMin}_to_${release}`
  if (path.basename(out) !== expected) usage(`--out basename must be ${expected}`)
  const parent = path.dirname(out)
  const parentStat = lstat(parent)
  if (!parentStat || !statSync(parent).isDirectory()) refuse(`--out parent is not an existing directory: ${parent}`)
  if (isInside(out, fromAppPath) || isInside(out, toAppPath)) refuse("--out is inside an app")
  const partial = out + PARTIAL
  if (lstat(out)) refuse(`--out already exists: ${out}`)
  if (lstat(partial)) refuse(`already exists: ${partial}`)

  // M5
  const root = await repoRoot()
  const fromSha = await resolveCommit(root, "--from-commit", opt["from-commit"])
  const toSha = await resolveCommit(root, "--to-commit", opt["to-commit"])
  const ancestor = await git(root, ["merge-base", "--is-ancestor", fromSha, toSha])
  if (ancestor.code === 1) refuse("--from-commit is not an ancestor of --to-commit")
  if (ancestor.code !== 0) refuse(`git merge-base failed: ${firstLine(ancestor)}`)

  // M6
  const a = await readSources(root, fromSha)
  const b = await readSources(root, toSha)
  const store = await storeChanged(root, fromSha, toSha)
  const dbSame = a.db.length === b.db.length && a.db.every((id, i) => id === b.db[i])
  const storageSame = a.storage === b.storage

  // M7
  if (migration === "none") {
    const differs: string[] = []
    if (!dbSame) differs.push(`${SRC_DB} ids differ (${a.db.length} -> ${b.db.length})`)
    if (!storageSame) differs.push(`${SRC_STORAGE} steps differ (${a.storage} -> ${b.storage})`)
    if (store) differs.push(`${SRC_STORE.join(" or ")} changed`)
    if (differs.length) refuse(`migration=none refused: ${differs.join("; ")}`)
  } else {
    const prefix = a.db.length <= b.db.length && a.db.every((id, i) => id === b.db[i])
    if (!prefix) refuse(`migration=forward refused: ${SRC_DB} ids of --from-commit are not a prefix of --to-commit`)
    if (b.storage < a.storage)
      refuse(`migration=forward refused: ${SRC_STORAGE} steps go down (${a.storage} -> ${b.storage})`)
    if (dbSame && storageSame && !store) warn("migration=forward declared but no migration source changed")
  }
  const dataMinRelease = migration === "none" ? fromMin : release

  // M8: from here on every failure removes the partial folder (U-6)
  try {
    mkdirSync(partial)
  } catch (error) {
    refuse(`cannot create ${partial}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`)
  }
  own(partial)

  // M9
  // ditto needs a writable temp folder for --sequesterRsrc; without TMPDIR it falls back to the per-user
  // temp folder, which a sandboxed caller cannot write. It gets one inside the partial folder, never an
  // inherited value, and the folder is gone before the rename (U-3 plus TMPDIR for ditto only).
  const payload = path.join(partial, "payload.zip")
  const tmp = path.join(partial, ".tmp")
  mkdirSync(tmp)
  await must([BIN.ditto, "-c", "-k", "--sequesterRsrc", "--keepParent", toAppPath, payload], "ditto failed", {
    env: { ...BASE_ENV(), TMPDIR: `${tmp}/` },
  })
  rmSync(tmp, { recursive: true, force: true })

  // M10
  const sha = text(await must([BIN.shasum, "-a", "256", payload], "shasum failed")).slice(0, 64)
  const bytes = text(await must([BIN.stat, "-f", "%z", payload], "stat failed")).trim()
  const du = /^([0-9]+)\t/.exec(text(await must([BIN.du, "-sk", toAppPath], "du failed")))
  if (!du) refuse("du output not understood")
  const unpacked = String(BigInt(du![1]) * 1024n)

  // M11
  const manifest: Manifest = {
    format: "1",
    bundle_id: BUNDLE_ID,
    release,
    from_min: fromMin,
    payload_sha256: sha,
    payload_bytes: bytes,
    unpacked_bytes: unpacked,
    migration,
    data_min_release: dataMinRelease,
  }
  const manifestPath = path.join(partial, "manifest")
  writeFileSync(manifestPath, manifestText(manifest), { flag: "wx", mode: 0o644 })
  const reread = parseManifest(readFileSync(manifestPath))
  if (manifestText(reread) !== manifestText(manifest)) refuse("manifest read back differs from what was written")

  // M12
  const command = signCommand(out)
  writeFileSync(path.join(partial, "sign_command.txt"), `${command}\n`, { flag: "wx", mode: 0o644 })

  // M13
  const entries = readdirSync(partial).sort().join(",")
  if (entries !== "manifest,payload.zip,sign_command.txt") refuse(`unexpected entries in ${partial}: ${entries}`)
  if (lstat(out)) refuse(`--out appeared during the run: ${out}`)
  renameSync(partial, out)
  disown(partial)
  // D52-4 and C20(2): the manifest lines and their sha256 in shasum's own format, then the sign command last.
  // N-2: the digest is taken from the bytes this run wrote, not re-read from disk after the rename, so it
  // always describes the printed lines.
  const manifestLines = manifestText(manifest)
  process.stdout.write(`${manifestLines}${sha256(manifestLines)}  ${path.join(out, "manifest")}\n${command}\n`)
}

// ---------------------------------------------------------------------------------------------
// seal (spec 03 section 4, read as SEAL-1..SEAL-9 per C21 #9)

const SEAL_OPTIONS = ["from-app", "work"] as const
const WORK_NAME =
  /^patch_((?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5}))_to_((?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5}))$/

async function seal(args: string[]) {
  // SEAL-1
  const opt = parseOptions(args, SEAL_OPTIONS)
  const fromAppPath = absolute("--from-app", opt["from-app"])
  const work = absolute("--work", opt.work)

  // SEAL-2: exactly the four inputs, all regular files; sign_command.txt still BN-13 for this folder (D52-4)
  const workStat = lstat(work)
  if (!workStat || !workStat.isDirectory()) refuse(`--work: not a directory: ${work}`)
  const name = WORK_NAME.exec(path.basename(work))
  if (!name) refuse(`--work: basename is not patch_<release>_to_<release>: ${path.basename(work)}`)
  const entries = readdirSync(work).sort()
  if (entries.join(",") !== [...WORK_INPUTS].sort().join(","))
    refuse(`--work must hold exactly ${WORK_INPUTS.join(", ")}; found: ${entries.join(", ") || "nothing"}`)
  for (const entry of WORK_INPUTS) regularFile(path.join(work, entry), entry)
  if (!readFileSync(path.join(work, "sign_command.txt")).equals(Buffer.from(`${signCommand(work)}\n`)))
    refuse("sign_command.txt is not the sign command make printed for this folder")

  // SEAL-3: manifest and signature into memory; every later check compares against these bytes
  const manifestPath = path.join(work, "manifest")
  const sigPath = path.join(work, "manifest.sig")
  if (lstat(manifestPath)!.size > MANIFEST_MAX_BYTES) refuse(`manifest larger than ${MANIFEST_MAX_BYTES} bytes`)
  const sigSize = lstat(sigPath)!.size
  if (sigSize < 1 || sigSize > SIGNATURE_MAX_BYTES) refuse(`manifest.sig is not 1..${SIGNATURE_MAX_BYTES} bytes`)
  const manifestBytes = readFileSync(manifestPath)
  const sigBytes = readFileSync(sigPath)
  const manifest = parseManifest(manifestBytes)
  if (manifest.from_min !== name![1] || manifest.release !== name![2])
    refuse(`manifest from_min ${manifest.from_min} / release ${manifest.release} do not match ${path.basename(work)}`)

  // SEAL-4: anchor. The from-app is sealed, its allowed_signers equals the repo anchor, which equals HEAD.
  const fromApp = await checkApp("--from-app", fromAppPath, { requireApplier: false })
  if (fromApp.release !== manifest.from_min)
    refuse(`--from-app SwarmRelease ${fromApp.release} is not from_min ${manifest.from_min}`)
  regularFile(REPO_ANCHOR, "repo allowed_signers")
  if (!fromApp.anchor.equals(readFileSync(REPO_ANCHOR)))
    refuse(`allowed_signers of --from-app differs from the repo anchor ${REPO_ANCHOR}`)
  const head = await git(await repoRoot(), ["show", "--no-textconv", `HEAD:${REPO_ANCHOR_REL}`])
  if (head.code !== 0) refuse(`${REPO_ANCHOR_REL} cannot be read at HEAD: ${firstLine(head)}`)
  if (!fromApp.anchor.equals(head.stdout)) refuse(`repo anchor ${REPO_ANCHOR_REL} differs from HEAD (not committed)`)

  // SEAL-5: register section 1 verify, message on stdin from memory
  const verify = await spawn(
    [
      BIN.sshKeygen,
      "-Y",
      "verify",
      "-f",
      path.join(fromAppPath, "Contents", "Resources", PATCH_FOLDER, "allowed_signers"),
      "-I",
      PRINCIPAL,
      "-n",
      NAMESPACE,
      "-s",
      sigPath,
    ],
    { stdin: manifestBytes },
  )
  // ssh-keygen writes some refusals to stdout only ("Could not verify signature."), so fall back to it.
  if (verify.code !== 0)
    refuse(
      `signature does not verify: ${verify.stderr.trim() ? firstLine(verify) : oneLine(text(verify)) || `exit ${verify.code}`}`,
    )
  if (!readFileSync(sigPath).equals(sigBytes)) refuse("manifest.sig changed during verify")
  if (!readFileSync(manifestPath).equals(manifestBytes)) refuse("manifest changed during verify")

  // SEAL-6: payload against the signed manifest
  const payload = path.join(work, "payload.zip")
  const size = text(await must([BIN.stat, "-f", "%z", payload], "stat failed")).trim()
  if (size !== manifest.payload_bytes) refuse(`payload.zip is ${size} bytes, manifest says ${manifest.payload_bytes}`)
  const payloadSha = text(await must([BIN.shasum, "-a", "256", payload], "shasum failed")).slice(0, 64)
  if (payloadSha !== manifest.payload_sha256) refuse("payload.zip sha256 differs from the manifest")

  // C21 #8 / SL-16: extract the payload into <work>/.seal_check/ (owned, removed on every exit) and read
  // the release and CDHash of the app it holds, so the user can compare them with the app build.
  const check = path.join(work, SEAL_CHECK)
  try {
    mkdirSync(check)
  } catch (error) {
    refuse(`cannot create ${check}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`)
  }
  own(check)
  const tmp = path.join(check, "tmp")
  const extracted = path.join(check, "app")
  mkdirSync(tmp)
  // U-3 holds exactly here: ditto -x, zip and unzip ran without TMPDIR under the agent sandbox (C23 allows
  // one only if needed). zip writes its own temp file into the owned check folder (-b), so a killed zip
  // leaves nothing in the work folder.
  await must([BIN.ditto, "-x", "-k", "--noqtn", payload, extracted], "ditto could not extract payload.zip")
  if (readdirSync(extracted).join(",") !== APP_NAME) refuse(`payload.zip does not hold exactly ${APP_NAME}`)
  const payloadApp = await checkApp("payload", path.join(extracted, APP_NAME), { requireApplier: true })
  if (payloadApp.release !== manifest.release)
    refuse(`payload SwarmRelease ${payloadApp.release} is not release ${manifest.release}`)
  if (!payloadApp.anchor.equals(fromApp.anchor)) refuse("allowed_signers of the payload app differs from --from-app")
  const details = await must([BIN.codesign, "-d", "-vvv", payloadApp.path], "codesign could not describe the payload")
  const cdhash = /^CDHash=([0-9a-f]{40,64})$/m.exec(details.stderr)
  if (!cdhash) refuse("payload CDHash not found in codesign output")
  // N-7: the applier this package ships, so the user (row 70) can compare it with the locked applier.
  const applierSha = sha256(
    readFileSync(path.join(payloadApp.path, "Contents", "Resources", PATCH_FOLDER, "swarm-patch")),
  )

  // SEAL-7: nothing at the package name or its .partial; zip into the .partial (owned from here, U-6)
  const pkg = path.join(work, `swarm-${manifest.from_min}-to-${manifest.release}${PACKAGE_EXT}`)
  const partial = pkg + PARTIAL
  if (lstat(pkg)) refuse(`package already exists: ${pkg}`)
  if (lstat(partial)) refuse(`already exists: ${partial}`)
  own(partial)
  await must(
    [BIN.zip, "-q", "-X", "-j", "-0", "-b", tmp, partial, ...PACKAGE_ENTRIES.map((e) => path.join(work, e))],
    "zip failed",
  )

  // SEAL-8: the container is exactly the three stored entries, with the verified bytes
  const names = text(await must([BIN.zipinfo, "-1", partial], "zipinfo failed"))
    .split("\n")
    .filter(Boolean)
  if (names.join(",") !== PACKAGE_ENTRIES.join(","))
    refuse(`package entries are not ${PACKAGE_ENTRIES.join(", ")}: ${names.join(", ")}`)
  const listing = text(await must([BIN.zipinfo, "-s", partial], "zipinfo failed")).split("\n")
  for (const entry of PACKAGE_ENTRIES) {
    const line = listing.find((l) => l.endsWith(` ${entry}`))
    if (!line || !line.startsWith("-") || !/ stor /.test(line))
      refuse(`package entry ${entry} is not a stored regular file: ${line ?? "missing"}`)
  }
  const entryBytes = async (entry: string) =>
    (await must([BIN.unzip, "-p", partial, entry], `unzip -p ${entry} failed`)).stdout
  if (!Buffer.from(await entryBytes("manifest")).equals(manifestBytes)) refuse("package manifest differs")
  if (!Buffer.from(await entryBytes("manifest.sig")).equals(sigBytes)) refuse("package manifest.sig differs")
  const hasher = new Bun.CryptoHasher("sha256")
  let streamed = 0
  await must([BIN.unzip, "-p", partial, "payload.zip"], "unzip -p payload.zip failed", {
    onChunk: (chunk) => {
      streamed += chunk.length
      hasher.update(chunk)
    },
  })
  if (String(streamed) !== manifest.payload_bytes || hasher.digest("hex") !== manifest.payload_sha256)
    refuse("package payload.zip differs from the manifest")

  // SEAL-9: the check folder goes first, then the placement, so the work folder ends as inputs + package
  rmSync(check, { recursive: true, force: true })
  if (lstat(check)) refuse(`could not remove ${check}`)
  disown(check)
  // L6 (U-6): link then unlink, never rename. link(2) fails with EEXIST when anything (file, folder, symlink)
  // sits at the package name, so a file that appeared during the run is refused and left as it is, where
  // rename(2) would replace it silently. The pair runs synchronously, so no signal handler runs in between.
  try {
    linkSync(partial, pkg)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    refuse(
      code === "EEXIST" ? `package appeared during the run: ${pkg}` : `cannot place ${pkg}: ${code ?? String(error)}`,
    )
  }
  own(pkg)
  unlinkSync(partial)
  disown(partial)
  disown(pkg)
  // R50-4 and D52-4: verify output as is, the manifest lines and their sha256, the payload app's
  // SwarmRelease and CDHash, the payload applier's sha256 (N-7), then the package path as the last line.
  process.stdout.write(
    `${text(verify)}${verify.stdout.length && !text(verify).endsWith("\n") ? "\n" : ""}` +
      `${manifestText(manifest)}${sha256(manifestBytes)}  ${manifestPath}\n` +
      `payload_app_release=${payloadApp.release}\npayload_app_cdhash=${cdhash![1]}\n` +
      `payload_applier_sha256=${applierSha}\n${pkg}\n`,
  )
}

// ---------------------------------------------------------------------------------------------
// Entry

const SUBCOMMANDS: Record<string, (args: string[]) => Promise<void>> = { make, seal }

async function main(argv: string[]) {
  const [sub, ...args] = argv
  if (!sub || !Object.hasOwn(SUBCOMMANDS, sub)) {
    process.stderr.write(`${TOOL}: usage: ${TOOL} <${Object.keys(SUBCOMMANDS).join("|")}> [options]\n`)
    return EXIT_USAGE
  }
  currentSub = sub
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
  try {
    await SUBCOMMANDS[sub](args)
    return EXIT_OK
  } catch (error) {
    if (aborting) return new Promise<number>(() => {}) // the signal handler exits
    cleanup()
    if (error instanceof ToolError) {
      printError(error.message)
      return error.code
    }
    printError(`unexpected failure: ${error instanceof Error ? error.message : String(error)}`)
    return EXIT_REFUSED
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
