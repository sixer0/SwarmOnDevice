// Shared test helper for the swarm-patch applier (spec 9.1, 9.2, 10.2).
// Everything it creates lives under one folder from mktemp in $TMPDIR. Keys are synthetic and generated per run;
// no user key is ever referenced. Nothing here touches an installed app.
import { expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export const NAMESPACE = "id.co.gsp.swarm.patch.v1"
export const PRINCIPAL = "swarm-patch-gsp"
export const BUNDLE_ID = "id.co.gsp.swarm.desktop"
export const BUNDLE_VERSION = "1.19.3"
export const STATE_ID = "id.co.gsp.swarm.patch"
export const PATCH_FOLDER = "swarm-patch"
export const PATCH_EXTENSION = ".swarmpatch"
export const CONTAINER_ENTRIES = ["manifest", "manifest.sig", "payload.zip"] as const
/** Register 7 exit codes. */
export const CODE = {
  E_OK: 0,
  E_USAGE: 2,
  E_CONTAINER: 10,
  E_SIGNATURE: 11,
  E_MANIFEST: 12,
  E_HASH: 13,
  E_DOWNGRADE: 14,
  E_SEAL: 15,
  E_RUNNING: 20,
  E_DISK: 21,
  E_VOLUME: 22,
  E_BUSY: 23,
  E_MIGRATION: 24,
  E_CONFIRM: 25,
  E_RESTORED: 30,
  E_RECOVER: 31,
} as const
export type ErrorName = Exclude<keyof typeof CODE, "E_OK">
/** Register S2: the twelve journal keys in their written order. */
export const JOURNAL_KEYS = [
  "state_format",
  "phase",
  "run",
  "target_path",
  "from_release",
  "to_release",
  "data_min_release",
  "started_at",
  "payload_sha256",
  "previous_cdhash",
  "installed_cdhash",
  "last_apply",
] as const

/** The applier as it sits in the repo. Fixtures copy it unless a test passes another file. */
export const REPO_APPLIER = path.join(import.meta.dir, "..", "..", "resources", PATCH_FOLDER, "swarm-patch")
/** Tree hash H (spec 9.1), kept byte-for-byte as specified. */
export const H_SCRIPT = path.join(import.meta.dir, "h.zsh")

export type Result = { code: number; stdout: string; stderr: string }

export class FixtureError extends Error {}

/** Runs an absolute tool path with an argument vector; no shell is involved. */
export async function run(
  cmd: string[],
  options: { cwd?: string; env?: Record<string, string>; stdin?: string } = {},
): Promise<Result> {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    env: options.env ?? (process.env as Record<string, string>),
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

/** `run` that throws on a non-zero exit, for every seeding command whose failure would hide a broken setup (m12). */
export async function must(cmd: string[], options: Parameters<typeof run>[1] = {}) {
  const result = await run(cmd, options)
  if (result.code !== 0) throw new FixtureError(`${cmd.join(" ")} exit ${result.code}: ${result.stderr.trim()}`)
  return result
}

/** lstat-based: a dangling symlink exists. */
export const exists = (p: string) =>
  fs.lstat(p).then(
    () => true,
    () => false,
  )

export type Env = {
  /** `$T` */
  root: string
  /** `$T/home`, passed as HOME to the applier */
  home: string
  /** `<state>` = `$T/home/Library/Application Support/id.co.gsp.swarm.patch` (not created here) */
  state: string
  /** `$T/apps`, holds the installed `Swarm.app` */
  apps: string
  /** `$T/keys/k` and `$T/keys/other`, private key paths; `.pub` beside each */
  keys: { k: string; other: string }
  /** INV-4 data folders, seeded with sample files */
  data: { desktop: string; swarm: string }
  cleanup(): Promise<void>
}

/** Spec 9.1: `T=$(mktemp -d "$TMPDIR/swarm_patch_test.XXXXXX")`, home, two synthetic keys, INV-4 data. */
export async function createEnv(): Promise<Env> {
  const tmp = process.env.TMPDIR ?? os.tmpdir()
  const made = await must(["/usr/bin/mktemp", "-d", path.join(tmp, "swarm_patch_test.XXXXXX")])
  // Resolve symlinks (/var -> /private/var) so paths match what the applier computes with ${0:A}.
  const root = await fs.realpath(made.stdout.trim())
  const home = path.join(root, "home")
  const support = path.join(home, "Library", "Application Support")
  await fs.mkdir(support, { recursive: true })
  await fs.mkdir(path.join(root, "keys"))
  await fs.mkdir(path.join(root, "apps"))
  const keys = { k: path.join(root, "keys", "k"), other: path.join(root, "keys", "other") }
  for (const key of Object.values(keys)) await must(["/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key])
  const data = { desktop: path.join(support, BUNDLE_ID), swarm: path.join(home, ".local", "share", "swarm") }
  for (const dir of Object.values(data)) {
    await fs.mkdir(path.join(dir, "nested"), { recursive: true })
    await fs.writeFile(path.join(dir, "sample.json"), '{"synthetic":true}\n')
    await fs.writeFile(path.join(dir, "nested", "sample.db"), "synthetic data\n")
  }
  return {
    root,
    home,
    state: path.join(support, STATE_ID),
    apps: path.join(root, "apps"),
    keys,
    data,
    // Phase-2 failure cases make folders read-only; give write back before removing.
    cleanup: async () => {
      await run(["/bin/chmod", "-R", "u+w", root])
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

/** A fresh Env per case; INV-4 (both data folders unchanged) is asserted after `fn`. */
export async function withEnv(fn: (env: Env) => Promise<void>) {
  const env = await createEnv()
  try {
    const data = [await treeHash(env.data.desktop), await treeHash(env.data.swarm)]
    await fn(env)
    expect([await treeHash(env.data.desktop), await treeHash(env.data.swarm)]).toEqual(data)
  } finally {
    await env.cleanup()
  }
}

/** SP-TA line for a synthetic public key: comment dropped, exactly one LF-terminated line. */
export async function allowedSigners(publicKey: string) {
  const [type, base64] = (await fs.readFile(publicKey, "utf8")).trim().split(" ")
  if (type !== "ssh-ed25519" || !base64) throw new FixtureError(`not an ed25519 public key: ${publicKey}`)
  return `${PRINCIPAL} namespaces="${NAMESPACE}" ${type} ${base64}\n`
}

function plist(entries: Record<string, string>) {
  const body = Object.entries(entries)
    .map(([key, value]) => `<key>${key}</key><string>${value}</string>`)
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
${body}
</dict></plist>
`
}

async function binaries(env: Env) {
  const dir = path.join(env.root, "build")
  const main = path.join(dir, "main")
  const lib = path.join(dir, "libinner.dylib")
  if (await exists(main)) return { main, lib }
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "m.c"), "int main(void){return 0;}\n")
  await fs.writeFile(path.join(dir, "l.c"), "int inner(void){return 7;}\n")
  await must(["/usr/bin/clang", "-o", main, path.join(dir, "m.c")])
  await must([
    "/usr/bin/clang",
    "-dynamiclib",
    "-install_name",
    "@rpath/Inner.framework/Versions/A/Inner",
    "-o",
    lib,
    path.join(dir, "l.c"),
  ])
  return { main, lib }
}

export type AppOptions = {
  /** `SwarmRelease`; `null` leaves the key out of Info.plist */
  release: string | null
  /** Folder that receives `Swarm.app`; defaults to a fresh folder under `$T/build/apps` */
  into?: string
  /** Applier to copy into `Contents/Resources/swarm-patch/`; defaults to the repo applier */
  applier?: string
  /** Public key for the bundled `allowed_signers`; defaults to `$T/keys/k.pub` */
  signerPub?: string
  /** Info.plist overrides (e.g. a different CFBundleIdentifier); `null` removes a key */
  info?: Record<string, string | null>
  /** Runs on the unsigned bundle, before codesign */
  mutate?: (app: string) => Promise<void>
  /** Skip codesign, for unsealed variants */
  unsigned?: boolean
}

let counter = 0

/**
 * Builds an ad-hoc signed `Swarm.app` with the layout from row 5 (02_probe_bundle.md:18-29): a clang Mach-O,
 * a nested framework with symlinks, and a helper app whose name has a space. Returns the bundle path.
 */
export async function buildApp(env: Env, options: AppOptions) {
  const applier = options.applier ?? REPO_APPLIER
  if (!(await exists(applier))) throw new FixtureError(`applier not found: ${applier}`)
  const into = options.into ?? path.join(env.root, "build", "apps", String(++counter))
  const app = path.join(into, "Swarm.app")
  if (await exists(app)) throw new FixtureError(`refusing to overwrite ${app}`)
  const { main, lib } = await binaries(env)
  const contents = path.join(app, "Contents")
  const framework = path.join(contents, "Frameworks", "Inner.framework")
  const helper = path.join(contents, "Frameworks", "Swarm Helper.app")
  const patch = path.join(contents, "Resources", PATCH_FOLDER)
  for (const dir of [
    path.join(contents, "MacOS"),
    path.join(framework, "Versions", "A", "Resources"),
    path.join(helper, "Contents", "MacOS"),
    patch,
  ])
    await fs.mkdir(dir, { recursive: true })
  await fs.copyFile(main, path.join(contents, "MacOS", "Swarm"))
  await fs.copyFile(main, path.join(helper, "Contents", "MacOS", "Swarm Helper"))
  await fs.copyFile(lib, path.join(framework, "Versions", "A", "Inner"))
  await fs.symlink("A", path.join(framework, "Versions", "Current"))
  await fs.symlink("Versions/Current/Inner", path.join(framework, "Inner"))
  await fs.symlink("Versions/Current/Resources", path.join(framework, "Resources"))

  const info: Record<string, string> = {
    CFBundleExecutable: "Swarm",
    CFBundleIdentifier: BUNDLE_ID,
    CFBundlePackageType: "APPL",
    CFBundleShortVersionString: BUNDLE_VERSION,
    CFBundleVersion: BUNDLE_VERSION,
  }
  if (options.release !== null) info.SwarmRelease = options.release
  for (const [key, value] of Object.entries(options.info ?? {})) {
    if (value === null) delete info[key]
    else info[key] = value
  }
  await fs.writeFile(path.join(contents, "Info.plist"), plist(info))
  await fs.writeFile(
    path.join(helper, "Contents", "Info.plist"),
    plist({
      CFBundleExecutable: "Swarm Helper",
      CFBundleIdentifier: `${BUNDLE_ID}.helper`,
      CFBundlePackageType: "APPL",
      CFBundleShortVersionString: BUNDLE_VERSION,
    }),
  )
  await fs.writeFile(
    path.join(framework, "Versions", "A", "Resources", "Info.plist"),
    plist({ CFBundleExecutable: "Inner", CFBundleIdentifier: `${BUNDLE_ID}.inner`, CFBundlePackageType: "FMWK" }),
  )
  await fs.writeFile(path.join(contents, "Resources", "data.txt"), "synthetic resource\n")
  await fs.copyFile(applier, path.join(patch, "swarm-patch"))
  await fs.chmod(path.join(patch, "swarm-patch"), 0o755)
  await fs.writeFile(
    path.join(patch, "allowed_signers"),
    await allowedSigners(options.signerPub ?? `${env.keys.k}.pub`),
  )

  if (options.mutate) await options.mutate(app)
  if (!options.unsigned) await must(["/usr/bin/codesign", "--force", "--deep", "-s", "-", app])
  return app
}

/** `codesign --verify --deep --strict`, exit code and stderr. */
export const verifySeal = (app: string) => run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app])

/** Builds the installed app at `$T/apps/Swarm.app` (default release 1.1.0). */
export const installApp = (env: Env, options: Partial<AppOptions> = {}) =>
  buildApp(env, { release: "1.1.0", ...options, into: env.apps })

export type PackageOptions = {
  /** Output path; must end in `.swarmpatch` unless a test wants a wrong extension */
  out: string
  fromMin: string
  migration: "none" | "forward" | string
  dataMinRelease: string
  /** Private key used for step 5; defaults to `$T/keys/k` */
  key?: string
  /** allowed_signers for step 6; defaults to the one bundled in `app` */
  signers?: string
  /** Edits the manifest text after step 4 and before signing (negative cases) */
  editManifest?: (text: string) => string
}

export type Package = { path: string; manifest: string; work: string }

/**
 * Spec 10.2 recipe, steps 1-7, run from a new work folder that holds a copy of `app`. Step 6 failing writes no
 * package and throws.
 */
export async function makePackage(env: Env, app: string, options: PackageOptions): Promise<Package> {
  if (await exists(options.out)) throw new FixtureError(`refusing to overwrite ${options.out}`)
  const work = path.join(env.root, "build", "pkg", String(++counter))
  await fs.mkdir(work, { recursive: true })
  await must(["/usr/bin/ditto", app, path.join(work, "Swarm.app")])
  await must(["/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", "Swarm.app", "payload.zip"], {
    cwd: work,
  })
  const release = (
    await must(["/usr/bin/plutil", "-extract", "SwarmRelease", "raw", "Swarm.app/Contents/Info.plist"], { cwd: work })
  ).stdout.trim()
  const sha = (await must(["/usr/bin/shasum", "-a", "256", "payload.zip"], { cwd: work })).stdout.slice(0, 64)
  const bytes = (await must(["/usr/bin/stat", "-f", "%z", "payload.zip"], { cwd: work })).stdout.trim()
  const kb = Number((await must(["/usr/bin/du", "-sk", "Swarm.app"], { cwd: work })).stdout.split(/\s+/)[0])
  const lines = [
    "format=1",
    `bundle_id=${BUNDLE_ID}`,
    `release=${release}`,
    `from_min=${options.fromMin}`,
    `payload_sha256=${sha}`,
    `payload_bytes=${bytes}`,
    `unpacked_bytes=${kb * 1024}`,
    `migration=${options.migration}`,
    `data_min_release=${options.dataMinRelease}`,
  ]
  let manifest = lines.join("\n") + "\n"
  if (options.editManifest) manifest = options.editManifest(manifest)
  await fs.writeFile(path.join(work, "manifest"), manifest)
  await must(["/usr/bin/ssh-keygen", "-Y", "sign", "-f", options.key ?? env.keys.k, "-n", NAMESPACE, "manifest"], {
    cwd: work,
  })
  const signers = options.signers ?? path.join(app, "Contents", "Resources", PATCH_FOLDER, "allowed_signers")
  const check = await run(
    ["/usr/bin/ssh-keygen", "-Y", "verify", "-f", signers, "-I", PRINCIPAL, "-n", NAMESPACE, "-s", "manifest.sig"],
    { cwd: work, stdin: manifest },
  )
  if (check.code !== 0) throw new FixtureError(`step 6 verify failed (exit ${check.code}); no package written`)
  await must(["/usr/bin/zip", "-q", "-X", "-j", "-0", options.out, ...CONTAINER_ENTRIES], { cwd: work })
  return { path: options.out, manifest, work }
}

/** H(dir), spec 9.1: 64 hex characters. */
export async function treeHash(dir: string) {
  const result = await must(["/bin/zsh", "-f", H_SCRIPT, dir])
  const hash = result.stdout.slice(0, 64)
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new FixtureError(`unexpected H output for ${dir}`)
  return hash
}

/** SHA-256 of a file, or null when it does not exist (INV-2). */
export const fileHash = async (file: string) =>
  (await exists(file)) ? (await must(["/usr/bin/shasum", "-a", "256", file])).stdout.slice(0, 64) : null

export type Snapshot = { target: string; journal: string | null; desktop: string; swarm: string }

/** INV-1, INV-2 and INV-4 values before a call. INV-3 needs no "before". */
export async function snapshot(env: Env, target = path.join(env.apps, "Swarm.app")): Promise<Snapshot> {
  return {
    target: await treeHash(target),
    journal: await fileHash(path.join(env.state, "state")),
    desktop: await treeHash(env.data.desktop),
    swarm: await treeHash(env.data.swarm),
  }
}

/**
 * Spec 9.2. Returns the broken invariants as `INV-n: reason`; an empty list means all four hold.
 * INV-3: a missing `staging` folder counts as empty (the state folder may not exist if the call stopped early).
 */
export async function invariants(env: Env, before: Snapshot, target = path.join(env.apps, "Swarm.app")) {
  const broken: string[] = []
  if ((await treeHash(target)) !== before.target) broken.push("INV-1: target changed")
  if ((await fileHash(path.join(env.state, "state"))) !== before.journal) broken.push("INV-2: journal changed")
  const staging = path.join(env.state, "staging")
  if ((await exists(staging)) && (await fs.readdir(staging)).length > 0) broken.push("INV-3: staging not empty")
  if (await exists(path.join(env.state, "lock"))) broken.push("INV-3: lock still present")
  if ((await treeHash(env.data.desktop)) !== before.desktop) broken.push("INV-4: desktop data changed")
  if ((await treeHash(env.data.swarm)) !== before.swarm) broken.push("INV-4: swarm data changed")
  return broken
}

/** Spec 9.1 invocation: `HOME=$T/home /bin/zsh -f <app>/Contents/Resources/swarm-patch/swarm-patch <sub> ...`. */
export function applier(
  env: Env,
  args: string[],
  app = path.join(env.apps, "Swarm.app"),
  options: { cwd?: string; env?: Record<string, string> } = {},
) {
  return run(["/bin/zsh", "-f", path.join(app, "Contents", "Resources", PATCH_FOLDER, "swarm-patch"), ...args], {
    cwd: options.cwd,
    env: options.env ?? { ...(process.env as Record<string, string>), HOME: env.home },
  })
}

/** True when stderr carries the S11 prefix for `name`. */
export const hasError = (result: Result, name: string) => result.stderr.includes(`swarm-patch: ${name}:`)

export type RejectOptions = { app?: string; cwd?: string; env?: Record<string, string>; message?: string }

/**
 * A rejection before any change: register code and S11 line for `name`, empty stdout, and INV-1..4 (spec 9.2).
 * Outside E_RUNNING cases, stderr must not name E_RUNNING, so a sandboxed `pgrep` cannot pass for another refusal.
 */
export async function expectReject(env: Env, args: string[], name: ErrorName, options: RejectOptions = {}) {
  const app = options.app ?? path.join(env.apps, "Swarm.app")
  const before = await snapshot(env, app)
  const r = await applier(env, args, app, options)
  expect({ code: r.code, error: hasError(r, name), stdout: r.stdout, stderr: r.stderr }).toMatchObject({
    code: CODE[name],
    error: true,
    stdout: "",
  })
  if (name !== "E_RUNNING") expect(r.stderr).not.toContain("E_RUNNING")
  if (options.message) expect(r.stderr).toContain(options.message)
  expect(await invariants(env, before, app)).toEqual([])
  return r
}

let packages = 0

/** Spec 10.2 package in a fresh folder; defaults: from_min 1.0.0, migration none, data_min_release 1.0.0. */
export async function pkg(env: Env, app: string, options: Partial<PackageOptions> = {}) {
  const out = options.out ?? path.join(env.root, "pk", String(++packages), "p.swarmpatch")
  await fs.mkdir(path.dirname(out), { recursive: true })
  return makePackage(env, app, { fromMin: "1.0.0", migration: "none", dataMinRelease: "1.0.0", ...options, out })
}

/** CDHash from `codesign -dvvv` (register S26), or undefined. */
export const cdhash = async (app: string) =>
  ((await run(["/usr/bin/codesign", "-dvvv", app])).stderr.match(/^CDHash=([0-9a-f]+)$/m) ?? [])[1]

/** The journal `<state>/state` as key -> value. */
export const journal = async (env: Env) =>
  Object.fromEntries(
    (await fs.readFile(path.join(env.state, "state"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  )

/** `<state>`, `staging` and `previous` as 0700 directories (spec 5.3). */
export async function stateDirs(env: Env) {
  for (const dir of [env.state, path.join(env.state, "staging"), path.join(env.state, "previous")]) {
    await fs.mkdir(dir, { recursive: true })
    await fs.chmod(dir, 0o700)
  }
}

/** Writes all twelve S2 keys in order; missing values are empty. */
export async function writeJournal(env: Env, values: Record<string, string>) {
  await stateDirs(env)
  await fs.writeFile(path.join(env.state, "state"), JOURNAL_KEYS.map((k) => `${k}=${values[k] ?? ""}\n`).join(""))
}

/**
 * A process whose argv carries `p` (RK-09: `; :` keeps zsh alive, so `exec` does not drop the path). Returns only
 * once `pgrep -lf` shows that PID with `p`, because the applier sees processes the same way (spec AP-06).
 */
export async function holder(p: string) {
  const proc = Bun.spawn(["/bin/zsh", "-fc", "sleep 60; :", p], { stdout: "ignore", stderr: "ignore" })
  for (let i = 0; i < 100; i++) {
    const r = await run(["/usr/bin/pgrep", "-lf", "sleep 60; :"])
    if (r.stdout.split("\n").some((line) => line.startsWith(`${proc.pid} `) && line.includes(p))) return proc
    await Bun.sleep(50)
  }
  proc.kill()
  await proc.exited
  throw new FixtureError(`holder not visible in pgrep -lf: ${p}`)
}

export async function withHolder<T>(p: string, fn: (pid: number) => Promise<T>) {
  const h = await holder(p)
  try {
    return await fn(h.pid)
  } finally {
    h.kill()
    await h.exited
  }
}

/** Fails the suite when `pgrep` cannot list processes (protocol SB); nothing is skipped silently. */
export async function requireProcessList(file: string) {
  const p = await run(["/usr/bin/pgrep", "-lf", "."])
  if (p.code >= 2)
    throw new Error(
      `protocol SB: pgrep exit ${p.code} (${p.stderr.trim()}); ${file} needs the process list and must run outside the agent sandbox`,
    )
}
