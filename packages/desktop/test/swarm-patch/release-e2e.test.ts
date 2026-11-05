// Row 29: release tool and applier end to end with a synthetic key (spec 03 section 6.5, E2E-01, E2E-02, E2E-04,
// plus rollback). The fixtures are the real 1.1.1 app (a copy of the row 64 zip, unzipped under $T), with two
// changes per copy: the bundled allowed_signers holds the synthetic key line, and the outer bundle is re-sealed
// ad-hoc (identifier, entitlements and flags kept). The 1.1.2 variant also has SwarmRelease set to 1.1.2.
// The tool runs from a copy in a throwaway git repo $T/repo (spec 6.1), so its repo anchor U-8 is the synthetic
// line committed at HEAD. The migration sources there are copies of the real files, unchanged between C1 and C2.
// Keys: $T/keys/k from createEnv() only; no user key is referenced. HOME is $T/home for every child process.
// Needs the process list (apply, rollback): run outside the agent sandbox (protocol SB).
// Opt-in, because it unzips a 230 MB app: SWARM_PATCH_E2E=1 (SWARM_PATCH_E2E_ZIP overrides the zip path).
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {
  allowedSigners,
  createEnv,
  type Env,
  exists,
  fileHash,
  invariants,
  journal,
  must,
  NAMESPACE,
  PATCH_FOLDER,
  REPO_APPLIER,
  requireProcessList,
  run,
  snapshot,
  type Snapshot,
  treeHash,
  verifySeal,
} from "./fixture"

setDefaultTimeout(600_000)

const ENABLED = process.env.SWARM_PATCH_E2E === "1"
const ZIP =
  process.env.SWARM_PATCH_E2E_ZIP ??
  "/Users/gsp-budi/Swarm_OnDevice/tools/build/desktop_e23f38c958/swarm-desktop-mac-arm64.zip"
// Register: the applier is byte-identical in the repo and in the 1.1.1 app.
const APPLIER_SHA256 = "6b63c21dd19f6b5cfc48b7cbb1621520126770e03bd1701a8b2e02b9fa320455"
const DESKTOP = path.join(import.meta.dir, "..", "..")
const REPO = path.join(DESKTOP, "..", "..")
const TOOL_SRC = path.join(DESKTOP, "scripts", "swarm-patch-release.ts")
// BN-06..BN-08, relative to the repo root.
const SOURCES = [
  "packages/core/src/database/migration.gen.ts",
  "packages/opencode/src/storage/storage.ts",
  "packages/desktop/src/main/migrate.ts",
  "packages/desktop/src/main/store.ts",
]
const CHILD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"
const KEY_PLACEHOLDER = "YOUR_PRIVATE_KEY_PATH"

// Guard: the account home comes from the account database (zsh `~<login>`, getpwnam), not from $HOME, because
// Bun's os.homedir() and os.userInfo().homedir both return $HOME (finding of row 62).
function accountHome() {
  const user = Bun.spawnSync(["/usr/bin/id", "-un"]).stdout.toString().trim()
  if (!/^[A-Za-z0-9._-]+$/.test(user)) throw new Error(`unexpected login name ${JSON.stringify(user)}`)
  const home = Bun.spawnSync(["/bin/zsh", "-fc", `print -r -- ~${user}`], { env: { PATH: CHILD_PATH } })
    .stdout.toString()
    .trim()
  if (!path.isAbsolute(home) || home === "/") throw new Error(`cannot read the account home (${home})`)
  return home
}
/** Every path this suite writes or hands to the applier as HOME, target or state. */
function guardPaths(paths: string[]) {
  const real = accountHome()
  for (const p of paths) {
    if (p === real || p.startsWith(real + "/") || p === "/Applications" || p.startsWith("/Applications/"))
      throw new Error(`refusing a path in the real home or /Applications: ${p}`)
  }
}

type Ctx = {
  env: Env
  repo: string
  tool: string
  /** pristine from-fixture (release 1.1.1) used by make and seal */
  a1: string
  /** to-fixture (release 1.1.2) */
  a2: string
  /** installed copy of A1, the applier target */
  target: string
  out: string
  pkg: string
  c1: string
  c2: string
  a1Hash: string
}
let ctx: Ctx | undefined
const c = () => {
  if (!ctx) throw new Error("setup did not finish")
  return ctx
}

/** Child environment: only PATH, LC_ALL and HOME=$T/home (no SSH_AUTH_SOCK, no real HOME). */
const childEnv = (env: Env) => ({ PATH: CHILD_PATH, LC_ALL: "C", HOME: env.home })
const plistValue = async (app: string, key: string) =>
  (await must(["/usr/bin/plutil", "-extract", key, "raw", "-o", "-", path.join(app, "Contents", "Info.plist")])).stdout.trim()
const applierAt = (app: string) => path.join(app, "Contents", "Resources", PATCH_FOLDER, "swarm-patch")
const runApplier = (args: string[]) =>
  run(["/bin/zsh", "-f", applierAt(c().target), ...args], { env: childEnv(c().env), cwd: c().env.root })
const runTool = (args: string[]) =>
  run([process.execPath, c().tool, ...args], { env: childEnv(c().env), cwd: c().env.root })
const git = (repo: string, args: string[]) =>
  must(["/usr/bin/git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", repo, ...args], {
    env: { ...childEnv(c().env), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  })

/**
 * The only changes made to a copy of the real app: synthetic allowed_signers, optional SwarmRelease, then an
 * ad-hoc re-seal of the outer bundle. Nested code is untouched, so its signatures stay as built.
 */
async function prepare(env: Env, app: string, release?: string) {
  await fs.writeFile(path.join(app, "Contents", "Resources", PATCH_FOLDER, "allowed_signers"), await allowedSigners(`${env.keys.k}.pub`))
  if (release) await must(["/usr/bin/plutil", "-replace", "SwarmRelease", "-string", release, path.join(app, "Contents", "Info.plist")])
  await must(["/usr/bin/codesign", "--force", "--preserve-metadata=identifier,entitlements,flags", "-s", "-", app])
  expect((await verifySeal(app)).code).toBe(0)
}

beforeAll(async () => {
  if (!ENABLED) return
  await requireProcessList("release-e2e.test.ts")
  expect(await fileHash(REPO_APPLIER)).toBe(APPLIER_SHA256)
  const env = await createEnv()
  try {
    const root = env.root
    guardPaths([root, env.home, env.state, env.apps, path.join(env.apps, "Swarm.app")])
    // Fixture source: a copy of the zip, unzipped under $T.
    const src = path.join(root, "src")
    await fs.mkdir(src)
    await fs.copyFile(ZIP, path.join(src, "app.zip"))
    await must(["/usr/bin/ditto", "-x", "-k", "--noqtn", path.join(src, "app.zip"), path.join(src, "x")])
    const real = path.join(src, "x", "Swarm.app")
    expect(await fs.readdir(path.join(src, "x"))).toEqual(["Swarm.app"])
    expect(await plistValue(real, "SwarmRelease")).toBe("1.1.1")
    expect(await fileHash(applierAt(real))).toBe(APPLIER_SHA256)
    expect((await verifySeal(real)).code).toBe(0)

    const a1 = path.join(root, "fixture", "from", "Swarm.app")
    const a2 = path.join(root, "fixture", "to", "Swarm.app")
    await fs.mkdir(path.dirname(a1), { recursive: true })
    await fs.mkdir(path.dirname(a2), { recursive: true })
    await must(["/usr/bin/ditto", real, a1])
    await fs.rename(real, a2)
    await fs.rm(src, { recursive: true, force: true })
    await prepare(env, a1)
    await prepare(env, a2, "1.1.2")
    const target = path.join(env.apps, "Swarm.app")
    await must(["/usr/bin/ditto", a1, target])
    expect((await verifySeal(target)).code).toBe(0)

    // Throwaway repo: tool copy, synthetic anchor, the four real migration sources (C1), one unrelated change (C2).
    const repo = path.join(root, "repo")
    const tool = path.join(repo, "packages", "desktop", "scripts", "swarm-patch-release.ts")
    ctx = { env, repo, tool, a1, a2, target, out: "", pkg: "", c1: "", c2: "", a1Hash: await treeHash(a1) }
    await fs.mkdir(path.dirname(tool), { recursive: true })
    await fs.copyFile(TOOL_SRC, tool)
    const anchor = path.join(repo, "packages", "desktop", "resources", PATCH_FOLDER, "allowed_signers")
    await fs.mkdir(path.dirname(anchor), { recursive: true })
    await fs.writeFile(anchor, await allowedSigners(`${env.keys.k}.pub`))
    for (const file of SOURCES) {
      await fs.mkdir(path.dirname(path.join(repo, file)), { recursive: true })
      await fs.copyFile(path.join(REPO, file), path.join(repo, file))
    }
    await fs.writeFile(path.join(repo, "README"), "c1\n")
    await must(["/usr/bin/git", "init", "-q", repo], { env: childEnv(env) })
    await git(repo, ["add", "-A"])
    await git(repo, ["commit", "-q", "-m", "c1"])
    ctx.c1 = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim()
    await fs.writeFile(path.join(repo, "README"), "c2\n")
    await git(repo, ["commit", "-q", "-am", "c2"])
    ctx.c2 = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim()
    await fs.mkdir(path.join(root, "out"))
    ctx.out = path.join(root, "out", "patch_1.1.1_to_1.1.2")
    ctx.pkg = path.join(ctx.out, "swarm-1.1.1-to-1.1.2.swarmpatch")
  } catch (error) {
    await env.cleanup()
    ctx = undefined
    throw error
  }
})

afterAll(async () => {
  if (!ctx) return
  const root = ctx.env.root
  await ctx.env.cleanup()
  // E2E-04: $T is gone.
  expect(await exists(root)).toBe(false)
})

test.skipIf(!ENABLED)("E2E-01a make: work folder with the 1.1.1 -> 1.1.2 manifest and the BN-13 sign command", async () => {
  const { a1, a2, c1, c2, out } = c()
  const r = await runTool(["make", "--from-app", a1, "--to-app", a2, "--from-commit", c1, "--to-commit", c2, "--migration", "none", "--out", out])
  expect({ code: r.code, err: r.stderr }).toEqual({ code: 0, err: "" })
  expect((await fs.readdir(out)).sort()).toEqual(["manifest", "payload.zip", "sign_command.txt"])
  const manifest = await fs.readFile(path.join(out, "manifest"), "utf8")
  const lines = manifest.trimEnd().split("\n")
  expect(lines).toHaveLength(9)
  expect(lines.filter((l) => !/^(payload_sha256|payload_bytes|unpacked_bytes)=/.test(l))).toEqual([
    "format=1",
    "bundle_id=id.co.gsp.swarm.desktop",
    "release=1.1.2",
    "from_min=1.1.1",
    "migration=none",
    "data_min_release=1.1.1",
  ])
  expect(manifest).toContain(`payload_sha256=${await fileHash(path.join(out, "payload.zip"))}\n`)
  const command = await fs.readFile(path.join(out, "sign_command.txt"), "utf8")
  expect(command).toBe(`/usr/bin/ssh-keygen -Y sign -f ${KEY_PLACEHOLDER} -n ${NAMESPACE} '${out}/manifest'\n`)
  expect(r.stdout.trimEnd().split("\n").at(-1)).toBe(command.trimEnd())
  // MK-05: no reference to the user's key folder or key name (spelled in parts so this file greps clean, E2E-04).
  for (const word of [["swarm", "patch", "key"].join("-"), ["gsp", "patch"].join("_")]) expect(command).not.toContain(word)
})

test.skipIf(!ENABLED)("E2E-01b sign: the printed command with the placeholder set to $T/keys/k", async () => {
  const { env, out } = c()
  const command = (await fs.readFile(path.join(out, "sign_command.txt"), "utf8")).trimEnd()
  expect(command.split(KEY_PLACEHOLDER)).toHaveLength(2)
  const r = await run(["/bin/zsh", "-f", "-c", command.replace(KEY_PLACEHOLDER, `'${env.keys.k}'`)], {
    env: childEnv(env),
    cwd: env.root,
  })
  expect(r.code).toBe(0)
  expect((await fs.readdir(out)).sort()).toEqual(["manifest", "manifest.sig", "payload.zip", "sign_command.txt"])
})

test.skipIf(!ENABLED)("E2E-01c seal: verified against the from-app anchor, package path last", async () => {
  const { a1, out, pkg } = c()
  const r = await runTool(["seal", "--from-app", a1, "--work", out])
  expect({ code: r.code, err: r.stderr }).toEqual({ code: 0, err: "" })
  expect(r.stdout).toContain(`Good "${NAMESPACE}" signature for swarm-patch-gsp`)
  expect(r.stdout).toContain("payload_app_release=1.1.2\n")
  expect(r.stdout.trimEnd().split("\n").at(-1)).toBe(pkg)
  expect((await fs.readdir(out)).sort()).toEqual([
    "manifest",
    "manifest.sig",
    "payload.zip",
    "sign_command.txt",
    "swarm-1.1.1-to-1.1.2.swarmpatch",
  ])
  console.log(`[row29] seal stdout:\n${r.stdout}`)
})

let beforeApply: Snapshot | undefined

test.skipIf(!ENABLED)("E2E-01d verify by the bundled 1.1.1 applier: result=verified, 1.1.2 from 1.1.1; INV-1..4", async () => {
  const { env, target, pkg } = c()
  const before = await snapshot(env, target)
  const r = await runApplier(["verify", pkg])
  console.log(`[row29] verify exit ${r.code} stdout:\n${r.stdout}`)
  expect({ code: r.code, err: r.stderr }).toEqual({ code: 0, err: "" })
  expect(r.stdout.trimEnd().split("\n")).toEqual([
    "result=verified",
    "release=1.1.2",
    "from_release=1.1.1",
    "migration=none",
    "new_key=no",
  ])
  expect(await invariants(env, before, target)).toEqual([])
  beforeApply = before
})

test.skipIf(!ENABLED)("E2E-02 apply (protocol SB): target SwarmRelease 1.1.2, sealed, previous/ = A1", async () => {
  const { env, target, pkg, a1Hash } = c()
  if (!beforeApply) throw new Error("verify did not pass")
  expect(beforeApply.target).toBe(a1Hash)
  const r = await runApplier(["apply", pkg])
  console.log(`[row29] apply exit ${r.code} stdout:\n${r.stdout}`)
  expect({ code: r.code, err: r.stderr }).toEqual({ code: 0, err: "" })
  expect(r.stdout.trimEnd().split("\n").slice(1)).toEqual([
    "result=applied",
    "release=1.1.2",
    "from_release=1.1.1",
    "migration=none",
    "new_key=no",
  ])
  expect(await plistValue(target, "SwarmRelease")).toBe("1.1.2")
  expect((await verifySeal(target)).code).toBe(0)
  expect(await treeHash(path.join(env.state, "previous", "Swarm.app"))).toBe(a1Hash)
  expect(await treeHash(target)).toBe(await treeHash(c().a2))
  expect(await journal(env)).toMatchObject({ phase: "idle", last_apply: "1.1.2", from_release: "1.1.1", to_release: "1.1.2", target_path: target })
  // INV-4: data folders untouched.
  expect([await treeHash(env.data.desktop), await treeHash(env.data.swarm)]).toEqual([beforeApply.desktop, beforeApply.swarm])
})

test.skipIf(!ENABLED)("rollback: the 1.1.1 app is back at the target, byte for byte", async () => {
  const { env, target, a1Hash } = c()
  if (!beforeApply) throw new Error("apply did not pass")
  const r = await runApplier(["rollback"])
  console.log(`[row29] rollback exit ${r.code} stdout:\n${r.stdout}`)
  expect({ code: r.code, err: r.stderr }).toEqual({ code: 0, err: "" })
  expect(r.stdout.trimEnd().split("\n")).toEqual(["result=rolled_back", "release=1.1.1"])
  expect(await plistValue(target, "SwarmRelease")).toBe("1.1.1")
  expect((await verifySeal(target)).code).toBe(0)
  expect(await treeHash(target)).toBe(a1Hash)
  expect(await exists(path.join(env.state, "previous", "Swarm.app"))).toBe(false)
  expect([await treeHash(env.data.desktop), await treeHash(env.data.swarm)]).toEqual([beforeApply.desktop, beforeApply.swarm])
  expect(await fileHash(REPO_APPLIER)).toBe(APPLIER_SHA256)
})
