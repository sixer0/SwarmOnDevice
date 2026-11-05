// Row 63: unit tests for the release tool scripts/swarm-patch-release.ts (BN-01), `make` and `seal`.
// Criteria: spec 03 section 6 (MK-01..MK-20, SL-01..SL-14, ST-K1..ST-K4), register 14.4 (MK-21, MK-22, SL-15,
// SL-16), decisions C20(2) (make stdout), C23 and C24 (stricter refusals accepted for rows 27 and 28).
//
// Setup (spec 6.1): one $T from createEnv() with synthetic keys only; a throwaway git repo $T/repo holding a COPY
// of the tool, the anchor from $T/keys/k.pub and synthetic migration sources (BN-06..BN-08). The tool derives its
// repo root and anchor from its own location, so the copy behaves like the original without any test switch.
// Every refusal asserts exit code, R50-2 prefix, empty stdout and 0 output files (NO-OUT / NO-PKG).
//
// MK-19 runs in the sandbox with a medium payload (SWARM_PATCH_BIG_MB, default 48; set 200 for the spec size).
// The process-list half of MK-19 (ditto really stopped) needs pgrep, so it runs only with SWARM_PATCH_PROC=1,
// outside the agent sandbox (protocol SB); without it that one test is reported as skipped, never as passed.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import {
  allowedSigners,
  buildApp,
  cdhash,
  createEnv,
  type Env,
  exists,
  fileHash,
  must,
  NAMESPACE,
  PATCH_FOLDER,
  REPO_APPLIER,
  type Result,
  run,
  treeHash,
  verifySeal,
} from "./fixture"

setDefaultTimeout(180_000)

const SOURCE_TOOL = path.join(import.meta.dir, "..", "..", "scripts", "swarm-patch-release.ts")
const TOOL_REL = "packages/desktop/scripts/swarm-patch-release.ts"
const ANCHOR_REL = "packages/desktop/resources/swarm-patch/allowed_signers"
const SRC = {
  db: "packages/core/src/database/migration.gen.ts",
  storage: "packages/opencode/src/storage/storage.ts",
  migrate: "packages/desktop/src/main/migrate.ts",
  store: "packages/desktop/src/main/store.ts",
}
// The user's key folder and key file names, assembled so this file itself holds neither literal (E2E-04, K0).
const KEY_FILE = new RegExp(["gsp", "patch"].join("_"))
const KEY_DIR = new RegExp(["swarm", "patch", "key"].join("-"))
const INPUTS = ["manifest", "manifest.sig", "payload.zip", "sign_command.txt"]
const BIG_MB = Number(process.env.SWARM_PATCH_BIG_MB ?? "48")
const PROC = process.env.SWARM_PATCH_PROC === "1"
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex")

let env: Env
let R: string
let C1: string
let C2: string
const V: Record<string, string> = {} // variant commits, each a child of C1
const A: Record<string, string> = {} // apps
let n = 0

// ---------------------------------------------------------------------------------------------
// Synthetic migration sources, shaped like research/06_explore_release_inputs.md 2-4

const dbSource = (ids: string[]) =>
  `export const migrations = (\n  await Promise.all([\n${ids.map((id) => `    import("./migration/${id}"),\n`).join("")}  ])\n).map((m) => m.default)\n`
const storageSource = (steps: number[]) =>
  `const MIGRATIONS = [\n${steps.map((s) => `  Effect.fn("Storage.migration.${s}")(function* () {}),\n`).join("")}]\n`
const IDS = ["20260101000000_a", "20260102000000_b", "20260103000000_c"]

// ---------------------------------------------------------------------------------------------
// Environments: no SSH_AUTH_SOCK, no GIT_*, HOME inside $T (spec 6.1)

const baseEnv = (home = env.home) => ({
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LC_ALL: "C",
  HOME: home,
  TMPDIR: process.env.TMPDIR ?? "/tmp",
})
const gitEnv = () => ({ ...baseEnv(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" })
const git = (args: string[], repo = R) =>
  must(
    ["/usr/bin/git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", repo, ...args],
    {
      env: gitEnv(),
    },
  )

const toolArgv = (args: string[], repo = R) => [process.execPath, path.join(repo, TOOL_REL), ...args]
const tool = (args: string[], o: { repo?: string; home?: string } = {}) =>
  run(toolArgv(args, o.repo), { cwd: env.root, env: baseEnv(o.home) })

type MakeOptions = {
  from?: string
  to?: string
  fromCommit?: string
  toCommit?: string
  migration?: string
  out: string
}
const makeArgs = (o: MakeOptions) => [
  "make",
  "--from-app",
  o.from ?? A.a1,
  "--to-app",
  o.to ?? A.a2,
  "--from-commit",
  o.fromCommit ?? C1,
  "--to-commit",
  o.toCommit ?? C2,
  "--migration",
  o.migration ?? "none",
  "--out",
  o.out,
]
const make = (o: MakeOptions, x: { repo?: string; home?: string } = {}) => tool(makeArgs(o), x)
const seal = (work: string, from = A.a1) => tool(["seal", "--from-app", from, "--work", work])

/** A fresh, empty case folder `$T/out/<n>` and the default OUT inside it. */
async function caseDir(name = "patch_1.1.1_to_1.1.2") {
  const dir = path.join(env.root, "out", String(++n))
  await fs.mkdir(dir, { recursive: true })
  return { dir, out: path.join(dir, name), pkg: path.join(dir, name, "swarm-1.1.1-to-1.1.2.swarmpatch") }
}

/** Entry name -> hash for every entry of `dir` (tree hash for folders, sha256 for files, link target for links). */
async function listing(dir: string) {
  const out: Record<string, string | null> = {}
  for (const entry of (await fs.readdir(dir)).sort()) {
    const p = path.join(dir, entry)
    const st = await fs.lstat(p)
    out[entry] = st.isSymbolicLink()
      ? `l ${await fs.readlink(p)}`
      : st.isDirectory()
        ? await treeHash(p)
        : await fileHash(p)
  }
  return out
}

/** TOLAK (exit 1) or PAKAI (exit 2): R50-2 prefix on one stderr line, nothing on stdout. */
function expectRefused(r: Result, sub: "make" | "seal", code: 1 | 2, message?: string | RegExp) {
  expect({ code: r.code, stdout: r.stdout }).toEqual({ code, stdout: "" })
  expect(r.stderr.startsWith(`swarm-patch-release: ${sub}: `)).toBe(true)
  expect(r.stderr.trimEnd().split("\n")).toHaveLength(1)
  if (message instanceof RegExp) expect(r.stderr).toMatch(message)
  else if (message) expect(r.stderr).toContain(message)
}

/** make refusal + NO-OUT: the case folder holds exactly what it held before, byte for byte. */
async function expectMakeRefused(o: MakeOptions, code: 1 | 2, message?: string | RegExp, dir = path.dirname(o.out)) {
  const before = await listing(dir)
  const apps = [await treeHash(o.from ?? A.a1)]
  const r = await make(o)
  expectRefused(r, "make", code, message)
  expect(await listing(dir)).toEqual(before)
  expect([await treeHash(o.from ?? A.a1)]).toEqual(apps)
  return r
}

const sign = async (out: string, key = env.keys.k, namespace = NAMESPACE) => {
  await fs.rm(path.join(out, "manifest.sig"), { force: true })
  await must(["/usr/bin/ssh-keygen", "-q", "-Y", "sign", "-f", key, "-n", namespace, path.join(out, "manifest")], {
    env: baseEnv(),
  })
}

/** A signed work folder from the valid make (spec 6.3: "every case starts from MAKE then SIGN"). */
async function signedWork(key = env.keys.k, namespace = NAMESPACE) {
  const c = await caseDir()
  const r = await make({ out: c.out })
  if (r.code !== 0) throw new Error(`setup make failed: ${r.stderr}`)
  await sign(c.out, key, namespace)
  return c
}

/** seal refusal + NO-PKG: `ls -A $OUT` and every byte of it unchanged, so no package, .partial or .seal_check. */
async function expectSealRefused(work: string, code: 1 | 2, message?: string | RegExp, from = A.a1, args?: string[]) {
  const before = await listing(work)
  const r = args ? await tool(args) : await seal(work, from)
  expectRefused(r, "seal", code, message)
  // Same entries with the same bytes: no new package, .partial or .seal_check, and a planted one is untouched.
  expect(await listing(work)).toEqual(before)
  return r
}

const manifestOf = async (out: string) =>
  Object.fromEntries(
    (await fs.readFile(path.join(out, "manifest"), "utf8"))
      .trimEnd()
      .split("\n")
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  )

/** Replaces payload.zip with `ditto -c -k --keepParent <app>` and rewrites the manifest's hash and size, then re-signs. */
async function swapPayload(out: string, app: string) {
  const zip = path.join(out, "payload.zip")
  await fs.rm(zip)
  await must(["/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", app, zip], { env: baseEnv() })
  const sha = (await fileHash(zip))!
  const bytes = (await fs.stat(zip)).size
  const text = (await fs.readFile(path.join(out, "manifest"), "utf8"))
    .replace(/^payload_sha256=.*$/m, `payload_sha256=${sha}`)
    .replace(/^payload_bytes=.*$/m, `payload_bytes=${bytes}`)
  await fs.writeFile(path.join(out, "manifest"), text)
  await sign(out)
}

/** A copy of `app` under `$T/src/<name>/<basename>`; `edit` runs on the copy (after codesign, so the seal breaks). */
async function copyApp(app: string, name: string, basename = "Swarm.app", edit?: (copy: string) => Promise<void>) {
  const copy = path.join(env.root, "src", name, basename)
  await must(["/usr/bin/ditto", app, copy], { env: baseEnv() })
  if (edit) await edit(copy)
  return copy
}

/** A variant commit on top of C1 (spec 6.1: "varian per kasus menambah commit"). */
async function variant(name: string, edit: () => Promise<void>) {
  await git(["checkout", "-q", "--detach", C1])
  await edit()
  await git(["add", "-A"])
  await git(["commit", "-q", "-m", name])
  V[name] = (await git(["rev-parse", "HEAD"])).stdout.trim()
  await git(["branch", `v_${name}`]) // a branch, so a clone (MK-22) carries the commit
}
const write = (rel: string, text: string) => fs.writeFile(path.join(R, rel), text)

// ---------------------------------------------------------------------------------------------

beforeAll(async () => {
  env = await createEnv()
  const src = (name: string) => path.join(env.root, "src", name)
  A.a1 = await buildApp(env, { release: "1.1.1", into: src("a1") })
  A.a2 = await buildApp(env, { release: "1.1.2", into: src("a2") })
  A.a0 = await buildApp(env, { release: "1.1.0", into: src("a0") })
  A.a1other = await buildApp(env, { release: "1.1.1", into: src("a1other"), signerPub: `${env.keys.other}.pub` })
  A.a2other = await buildApp(env, { release: "1.1.2", into: src("a2other"), signerPub: `${env.keys.other}.pub` })
  A.a2id = await buildApp(env, {
    release: "1.1.2",
    into: src("a2id"),
    info: { CFBundleIdentifier: "com.example.other" },
  })
  A.a2norel = await buildApp(env, { release: null, into: src("a2norel") })
  A.a2noapplier = await buildApp(env, {
    release: "1.1.2",
    into: src("a2noapplier"),
    mutate: (app) => fs.rm(path.join(app, "Contents", "Resources", PATCH_FOLDER, "swarm-patch")),
  })
  A.a2mut = await copyApp(A.a2, "a2mut", "Swarm.app", (app) =>
    fs.appendFile(path.join(app, "Contents", "Resources", "data.txt"), "x"),
  )
  A.a1mut = await copyApp(A.a1, "a1mut", "Swarm.app", (app) =>
    fs.appendFile(path.join(app, "Contents", "Resources", "data.txt"), "x"),
  )
  A.other = await copyApp(A.a2, "otherName", "Other.app")
  A.link = path.join(src("link"), "Swarm.app")
  await fs.mkdir(path.dirname(A.link), { recursive: true })
  await fs.symlink(A.a2, A.link)

  // Repo: tool copy, anchor from k.pub, BN-06..BN-08 sources; C1, then C2 = child touching README only.
  R = path.join(env.root, "repo")
  await fs.mkdir(R)
  await git(["init", "-q", "-b", "main"])
  for (const rel of [TOOL_REL, ANCHOR_REL, ...Object.values(SRC)])
    await fs.mkdir(path.join(R, path.dirname(rel)), { recursive: true })
  await fs.copyFile(SOURCE_TOOL, path.join(R, TOOL_REL))
  await write(ANCHOR_REL, await allowedSigners(`${env.keys.k}.pub`))
  await write(SRC.db, dbSource(IDS))
  await write(SRC.storage, storageSource([1, 2]))
  await write(SRC.migrate, "export const migrate = 1\n")
  await write(SRC.store, "export const store = 1\n")
  await write("README", "one\n")
  await git(["add", "-A"])
  await git(["commit", "-q", "-m", "C1"])
  C1 = (await git(["rev-parse", "HEAD"])).stdout.trim()
  await write("README", "two\n")
  await git(["commit", "-q", "-am", "C2"])
  C2 = (await git(["rev-parse", "HEAD"])).stdout.trim()

  await variant("dbAdd", () => write(SRC.db, dbSource([...IDS, "20260104000000_d"])))
  await variant("dbRemove", () => write(SRC.db, dbSource(IDS.slice(0, 2))))
  await variant("dbEmpty", () => write(SRC.db, "export const migrations = []\n"))
  await variant("dbDelete", () => fs.rm(path.join(R, SRC.db)))
  await variant("storageAdd", () => write(SRC.storage, storageSource([1, 2, 3])))
  await variant("storageDown", () => write(SRC.storage, storageSource([1])))
  await variant("storageGap", () => write(SRC.storage, storageSource([1, 3])))
  await variant("storageDelete", () => fs.rm(path.join(R, SRC.storage)))
  await variant("store", () => write(SRC.store, "export const store = 2\n"))
  await variant("migrate", () => write(SRC.migrate, "export const migrate = 2\n"))
  await variant("storeDelete", () => fs.rm(path.join(R, SRC.store)))
  await git(["checkout", "-q", "main"])
  expect((await git(["status", "--porcelain"])).stdout).toBe("")
  expect((await git(["rev-parse", "HEAD"])).stdout.trim()).toBe(C2)
})

afterAll(async () => {
  if (env) await env.cleanup()
})

// ---------------------------------------------------------------------------------------------

describe("static (spec 6.4)", () => {
  test("ST-K1..ST-K4: no key path, no -Y sign argv, no check-novalidate, no relative import", async () => {
    const text = await fs.readFile(SOURCE_TOOL, "utf8")
    const count = (re: RegExp) => (text.match(new RegExp(re.source, "g")) ?? []).length
    expect({
      k1: count(KEY_FILE),
      k2: count(KEY_DIR),
      k3: count(/"-Y", *"sign"/),
      k3b: count(/check-novalidate/),
      k4: count(/from ['"]\.\.?\//),
    }).toEqual({ k1: 0, k2: 0, k3: 0, k3b: 0, k4: 0 })
  })

  test("the copy under test is byte-identical to the repo tool", async () => {
    expect(await fileHash(path.join(R, TOOL_REL))).toBe((await fileHash(SOURCE_TOOL))!)
  })
})

describe("make (spec 6.2, register 14.4)", () => {
  test("MK-01..MK-05, MK-20, MK-21: valid path, values, payload, syntax, printed output, inputs unchanged", async () => {
    const c = await caseDir()
    const before = { a1: await treeHash(A.a1), a2: await treeHash(A.a2) }
    const r = await make({ out: c.out })
    expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" })

    // MK-01
    expect((await fs.readdir(c.dir)).sort()).toEqual(["patch_1.1.1_to_1.1.2"])
    expect((await fs.readdir(c.out)).sort()).toEqual(["manifest", "payload.zip", "sign_command.txt"])
    const m = await manifestOf(c.out)
    expect(m).toMatchObject({
      format: "1",
      bundle_id: "id.co.gsp.swarm.desktop",
      release: "1.1.2",
      from_min: "1.1.1",
      migration: "none",
      data_min_release: "1.1.1",
    })

    // MK-02
    const zip = path.join(c.out, "payload.zip")
    const du = (await must(["/usr/bin/du", "-sk", A.a2])).stdout
    expect(m.payload_sha256).toBe((await must(["/usr/bin/shasum", "-a", "256", zip])).stdout.slice(0, 64))
    expect(m.payload_bytes).toBe((await must(["/usr/bin/stat", "-f", "%z", zip])).stdout.trim())
    expect(m.unpacked_bytes).toBe(String(Number(du.split(/\s+/)[0]) * 1024))

    // MK-03
    const x = path.join(c.dir, "..", `x${n}`)
    await must(["/usr/bin/ditto", "-x", "-k", "--noqtn", zip, x], { env: baseEnv() })
    expect(await fs.readdir(x)).toEqual(["Swarm.app"])
    expect(await treeHash(path.join(x, "Swarm.app"))).toBe(before.a2)
    expect((await verifySeal(path.join(x, "Swarm.app"))).code).toBe(0)

    // MK-04
    const bytes = await fs.readFile(path.join(c.out, "manifest"))
    expect([...bytes].filter((b) => b !== 0x0a && (b < 0x20 || b > 0x7e))).toEqual([])
    expect(bytes.filter((b) => b === 0x0a).length).toBe(9)
    expect(bytes.at(-1)).toBe(0x0a)
    expect(bytes.toString().includes("\n\n")).toBe(false)
    expect(Object.keys(m)).toEqual([
      "format",
      "bundle_id",
      "release",
      "from_min",
      "payload_sha256",
      "payload_bytes",
      "unpacked_bytes",
      "migration",
      "data_min_release",
    ])

    // MK-05 (C20(2), N-2) and MK-21: stdout = the nine manifest lines, their sha256 in shasum's format
    // (`<hex>  <OUT>/manifest`) taken from the bytes make wrote, then the sign command, identical to
    // sign_command.txt (BN-13 with '$OUT/manifest' and YOUR_PRIVATE_KEY_PATH).
    const command = await fs.readFile(path.join(c.out, "sign_command.txt"), "utf8")
    expect(command).toBe(
      `/usr/bin/ssh-keygen -Y sign -f YOUR_PRIVATE_KEY_PATH -n id.co.gsp.swarm.patch.v1 '${c.out}/manifest'\n`,
    )
    const digest = `${sha256(bytes)}  ${c.out}/manifest\n`
    expect(r.stdout).toBe(bytes.toString() + digest + command)
    // The same line as shasum prints it for the file on disk (no swap happened in this run).
    expect(digest).toBe((await must(["/usr/bin/shasum", "-a", "256", path.join(c.out, "manifest")])).stdout)
    expect(r.stdout.trimEnd().split("\n").at(-1) + "\n").toBe(command)
    expect([KEY_FILE.test(command + r.stdout), KEY_DIR.test(command + r.stdout)]).toEqual([false, false])

    // MK-20
    expect({ a1: await treeHash(A.a1), a2: await treeHash(A.a2) }).toEqual(before)
    expect((await git(["status", "--porcelain"])).stdout).toBe("")
  })

  test("N-2: the printed digest is the sha256 of the printed manifest lines, for none and forward", async () => {
    for (const o of [{}, { migration: "forward", toCommit: V.dbAdd }]) {
      const c = await caseDir()
      const r = await make({ ...o, out: c.out })
      expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" })
      const lines = r.stdout.split("\n")
      const printed = lines.slice(0, 9).join("\n") + "\n"
      expect(lines[9]).toBe(`${sha256(printed)}  ${c.out}/manifest`)
      expect(printed).toBe(await fs.readFile(path.join(c.out, "manifest"), "utf8"))
    }
    // The digest comes from memory: make starts no shasum on the manifest after the rename (C27 M6 rule:
    // a source check, because the swap window between rename and a re-read cannot be timed in a test).
    const tool = await fs.readFile(SOURCE_TOOL, "utf8")
    expect(tool).not.toMatch(/BIN\.shasum, "-a", "256", path\.join\(out, "manifest"\)/)
  })

  test("MK-06: the printed command run as is fails on the placeholder and writes nothing", async () => {
    const c = await caseDir()
    expect((await make({ out: c.out })).code).toBe(0)
    const empty = path.join(c.dir, "..", `empty${n}`)
    await fs.mkdir(empty)
    const command = await fs.readFile(path.join(c.out, "sign_command.txt"), "utf8")
    const r = await run(["/bin/zsh", "-f", "-c", command], { cwd: empty, env: baseEnv() })
    expect(r.code).not.toBe(0)
    expect(await fs.readdir(empty)).toEqual([])
    expect(await exists(path.join(c.out, "manifest.sig"))).toBe(false)
  })

  test("MK-07: release not greater (1.1.1, 1.1.0)", async () => {
    const c = await caseDir("patch_1.1.1_to_1.1.1")
    await expectMakeRefused({ to: A.a1, out: c.out }, 1, "release 1.1.1 of --to-app is not greater than 1.1.1")
    const d = await caseDir("patch_1.1.1_to_1.1.0")
    await expectMakeRefused({ to: A.a0, out: d.out }, 1, "release 1.1.0 of --to-app is not greater than 1.1.1")
  })

  test("MK-08: DB id added with none names migration.gen.ts", async () => {
    const c = await caseDir()
    await expectMakeRefused(
      { toCommit: V.dbAdd, out: c.out },
      1,
      /migration=none refused: .*migration\.gen\.ts ids differ/,
    )
  })

  test("MK-09: storage step added with none names storage.ts", async () => {
    const c = await caseDir()
    await expectMakeRefused(
      { toCommit: V.storageAdd, out: c.out },
      1,
      /migration=none refused: .*storage\.ts steps differ/,
    )
  })

  test("MK-10: store.ts or migrate.ts changed with none", async () => {
    for (const v of [V.store, V.migrate]) {
      const c = await caseDir()
      await expectMakeRefused({ toCommit: v, out: c.out }, 1, /migration=none refused: .*store\.ts changed/)
    }
  })

  test("MK-11: forward accepted for the DB change, and for a store-only change", async () => {
    for (const v of [V.dbAdd, V.store]) {
      const c = await caseDir()
      const r = await make({ toCommit: v, migration: "forward", out: c.out })
      expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" })
      expect(await manifestOf(c.out)).toMatchObject({ migration: "forward", data_min_release: "1.1.2" })
      expect((await fs.readdir(c.out)).sort()).toEqual(["manifest", "payload.zip", "sign_command.txt"])
    }
  })

  test("MK-11b: forward without any source change is accepted with a stderr warning (spec M7)", async () => {
    const c = await caseDir()
    const r = await make({ migration: "forward", out: c.out })
    expect(r.code).toBe(0)
    expect(r.stderr).toBe(
      "swarm-patch-release: make: warning: migration=forward declared but no migration source changed\n",
    )
    expect(await manifestOf(c.out)).toMatchObject({ migration: "forward", data_min_release: "1.1.2" })
  })

  test("MK-12: forward not monotonic (DB id removed, storage steps down)", async () => {
    const c = await caseDir()
    await expectMakeRefused({ toCommit: V.dbRemove, migration: "forward", out: c.out }, 1, "are not a prefix")
    const d = await caseDir()
    await expectMakeRefused({ toCommit: V.storageDown, migration: "forward", out: d.out }, 1, "steps go down (2 -> 1)")
  })

  test("MK-13: source not provable (deleted, no ids, gap, store file missing), for none and forward", async () => {
    const cases: [string, string | RegExp][] = [
      [V.storageDelete, /storage\.ts cannot be read/],
      [V.dbDelete, /migration\.gen\.ts cannot be read/],
      [V.dbEmpty, "no migration ids found"],
      [V.storageGap, "steps are not numbered 1..2"],
      [V.storeDelete, /store\.ts cannot be read/],
    ]
    for (const [v, message] of cases)
      for (const migration of ["none", "forward"]) {
        const c = await caseDir()
        await expectMakeRefused({ toCommit: v, migration, out: c.out }, 1, message)
      }
  })

  test("MK-14: wrong commits (unknown rev, not an ancestor, C23 dash and control character)", async () => {
    const cases: [Partial<MakeOptions>, string][] = [
      [{ toCommit: "deadbeef" }, "--to-commit: not a commit: deadbeef"],
      [{ fromCommit: "0000000000000000000000000000000000000000" }, "--from-commit: not a commit"],
      [{ fromCommit: C2, toCommit: C1 }, "--from-commit is not an ancestor of --to-commit"],
      [{ fromCommit: V.dbAdd, toCommit: C2 }, "--from-commit is not an ancestor of --to-commit"],
      [{ toCommit: "-HEAD" }, "--to-commit: not a revision"],
      [{ toCommit: "HEAD\u0007" }, "--to-commit: not a revision"],
    ]
    for (const [o, message] of cases) {
      const c = await caseDir()
      await expectMakeRefused({ ...o, out: c.out }, 1, message)
    }
  })

  test("MK-15: OUT or OUT.partial already exists; old content unchanged", async () => {
    const c = await caseDir()
    await fs.mkdir(c.out)
    await fs.writeFile(path.join(c.out, "keep"), "old\n")
    await expectMakeRefused({ out: c.out }, 1, "--out already exists")
    expect(await fs.readFile(path.join(c.out, "keep"), "utf8")).toBe("old\n")

    const d = await caseDir()
    await fs.mkdir(`${d.out}.partial`)
    await fs.writeFile(path.join(`${d.out}.partial`, "keep"), "old\n")
    await expectMakeRefused({ out: d.out }, 1, "already exists")
    expect(await fs.readFile(path.join(`${d.out}.partial`, "keep"), "utf8")).toBe("old\n")
  })

  test("MK-16: wrong basename is usage; a quote in the path, a missing parent, OUT inside an app are refused (C23)", async () => {
    const c = await caseDir("patch_1.1.1_to_1.1.3")
    await expectMakeRefused({ out: c.out }, 2, "--out basename must be patch_1.1.1_to_1.1.2")

    const d = await caseDir()
    const quoted = path.join(d.dir, "it's")
    await fs.mkdir(quoted)
    await expectMakeRefused({ out: path.join(quoted, "patch_1.1.1_to_1.1.2") }, 1, "path contains a quote", quoted)
    expect(await fs.readdir(d.dir)).toEqual(["it's"])

    const e = await caseDir()
    await expectMakeRefused(
      { out: path.join(e.dir, "missing", "patch_1.1.1_to_1.1.2") },
      1,
      "--out parent is not an existing directory",
      e.dir,
    )

    const inside = await copyApp(A.a2, "insideOut")
    const before = await treeHash(inside)
    await expectMakeRefused(
      { to: inside, out: path.join(inside, "Contents", "patch_1.1.1_to_1.1.2") },
      1,
      "--out is inside an app",
      path.join(inside, "Contents"),
    )
    expect(await treeHash(inside)).toBe(before)
  })

  test("MK-17: wrong options are usage errors (each missing, unknown, positional, duplicate, --migration maybe)", async () => {
    const c = await caseDir()
    const full = makeArgs({ out: c.out })
    const variants: [string[], string][] = []
    for (let i = 1; i < full.length; i += 2)
      variants.push([[...full.slice(0, i), ...full.slice(i + 2)], `missing option: ${full[i]}`])
    variants.push([[...full, "--key", env.keys.k], "unknown option: --key"])
    variants.push([[...full, "extra"], "unexpected argument: extra"])
    variants.push([[...full, "--out", c.out], "duplicate option: --out"])
    variants.push([makeArgs({ out: c.out, migration: "maybe" }), "--migration must be none or forward"])
    variants.push([[...full.slice(0, -1)], "missing value for --out"])
    expect(variants).toHaveLength(11)
    for (const [args, message] of variants) {
      const before = await listing(c.dir)
      const r = await tool(args)
      expectRefused(r, "make", 2, message)
      expect(await listing(c.dir)).toEqual(before)
    }
    expect(await fs.readdir(c.dir)).toEqual([])
    const none = await tool([])
    expect({ code: none.code, stdout: none.stdout }).toEqual({ code: 2, stdout: "" })
    expect(none.stderr).toStartWith("swarm-patch-release: usage: ")
    const other = await tool(["sign", "--out", c.out])
    expect(other.code).toBe(2)
    expect(await fs.readdir(c.dir)).toEqual([])
  })

  test("MK-18: invalid apps are refused", async () => {
    const cases: [Partial<MakeOptions>, string][] = [
      [{ to: A.other }, "--to-app: basename is not Swarm.app"],
      [{ to: A.a2id }, "--to-app: CFBundleIdentifier is not id.co.gsp.swarm.desktop"],
      [{ to: A.a2norel }, "--to-app: Info.plist has no SwarmRelease"],
      [{ to: A.a2mut }, "--to-app: code signature is not valid"],
      [{ from: A.a1mut }, "--from-app: code signature is not valid"],
      [{ to: A.a2other }, "allowed_signers of --to-app differs from --from-app"],
      [{ to: A.a2noapplier }, "--to-app: applier is not a non-empty regular file"],
      [{ to: A.link }, "--to-app: not a directory"],
      [{ to: path.join(env.root, "src", "nothing", "Swarm.app") }, "--to-app: not a directory"],
    ]
    for (const [o, message] of cases) {
      const c = await caseDir()
      await expectMakeRefused({ ...o, out: c.out }, 1, message)
    }
  })

  test("MK-22: repo and global git config (textconv, external diff, fsmonitor) is not run during M6", async () => {
    const clone = path.join(env.root, "repo22")
    await must(["/usr/bin/git", "clone", "-q", R, clone], { env: gitEnv() })
    const home = path.join(env.root, "home22")
    await fs.mkdir(home)
    const marker = (name: string) => path.join(env.root, `marker22_${name}`)
    const script = async (name: string, body: string) => {
      const file = path.join(env.root, `hook22_${name}.sh`)
      await fs.writeFile(file, `#!/bin/sh\n/usr/bin/touch '${marker(name)}'\n${body}`, { mode: 0o755 })
      return file
    }
    const textconv = await script("textconv", 'cat "$1"\n')
    const command = await script("command", "exit 0\n")
    const fsmonitor = await script("fsmonitor", "exit 0\n")
    const planted = `[diff "x"]\n\ttextconv = ${textconv}\n\tcommand = ${command}\n[core]\n\tfsmonitor = ${fsmonitor}\n`
    await fs.appendFile(path.join(clone, ".git", "config"), planted)
    await fs.writeFile(path.join(home, ".gitconfig"), planted)
    await fs.mkdir(path.join(clone, ".git", "info"), { recursive: true })
    await fs.writeFile(path.join(clone, ".git", "info", "attributes"), "*.ts diff=x\n")
    const plain = { ...baseEnv(home) }
    const markers = async () => ({
      textconv: await exists(marker("textconv")),
      command: await exists(marker("command")),
      fsmonitor: await exists(marker("fsmonitor")),
    })

    // The tool first: nothing planted may run, and the store change is still seen under `none`.
    const c = await caseDir()
    const before = await listing(c.dir)
    const r = await make({ toCommit: V.store, out: c.out }, { repo: clone, home })
    expectRefused(r, "make", 1, /migration=none refused: .*store\.ts changed/)
    expect(await listing(c.dir)).toEqual(before)
    const d = await caseDir()
    expect((await make({ toCommit: V.store, migration: "forward", out: d.out }, { repo: clone, home })).code).toBe(0)
    expect(await markers()).toEqual({ textconv: false, command: false, fsmonitor: false })

    // Controls: the same config does run under plain git, so the absence above is the tool's hardening.
    await run(["/usr/bin/git", "-C", clone, "diff", C1, V.store, "--", SRC.store], { env: plain })
    await run(["/usr/bin/git", "-C", clone, "diff", "--no-ext-diff", C1, V.store, "--", SRC.store], { env: plain })
    await run(["/usr/bin/git", "-C", clone, "status", "--porcelain"], { env: plain })
    expect(await markers()).toEqual({ textconv: true, command: true, fsmonitor: true })

    // On git 2.54 the tool's own command set (diff --quiet between commits, show <rev>:<path>) does not call these
    // hooks even without hardening (row 63 mutation run), so the D52-5 flags are also pinned in the source.
    const source = await fs.readFile(SOURCE_TOOL, "utf8")
    for (const flag of [
      'GIT_CONFIG_NOSYSTEM: "1"',
      'GIT_CONFIG_GLOBAL: "/dev/null"',
      '"-c", "core.fsmonitor=false"',
      '"diff", "--no-ext-diff", "--no-textconv", "--quiet"',
      '"show", "--no-textconv"',
    ])
      expect(source).toContain(flag)
    expect(source.match(/\[BIN\.git,/g)).toHaveLength(1) // every git call goes through the hardened helper
  })

  test(`MK-19: SIGTERM while ditto writes payload.zip (${BIG_MB} MB) leaves no output`, async () => {
    const big = await bigApp()
    const c = await caseDir()
    const r = await interrupt(toolArgv(makeArgs({ to: big, out: c.out })), path.join(`${c.out}.partial`, "payload.zip"))
    expect(r.code).not.toBe(0)
    expect(r.stderr).toBe("swarm-patch-release: make: interrupted by SIGTERM; nothing was written\n")
    expect(await fs.readdir(c.dir)).toEqual([])
    await Bun.sleep(1000)
    expect(await fs.readdir(c.dir)).toEqual([])
  })

  test.if(PROC)("MK-19 (process list, protocol SB): ditto is gone once make has exited", async () => {
    const probe = await run(["/usr/bin/pgrep", "-lf", "."])
    if (probe.code >= 2) throw new Error(`pgrep exit ${probe.code}: run this test outside the agent sandbox`)
    const big = await bigApp()
    const c = await caseDir()
    const payload = path.join(`${c.out}.partial`, "payload.zip")
    let pids: number[] = []
    const r = await interrupt(toolArgv(makeArgs({ to: big, out: c.out })), payload, async () => {
      const p = await run(["/usr/bin/pgrep", "-f", `^/usr/bin/ditto .*${payload}`])
      pids = p.stdout.split("\n").filter(Boolean).map(Number)
    })
    expect(r.code).toBe(1)
    expect(pids.length).toBe(1)
    const after = await run(["/usr/bin/pgrep", "-f", `^/usr/bin/ditto .*${payload}`])
    expect({ code: after.code, stdout: after.stdout }).toEqual({ code: 1, stdout: "" })
    expect(() => process.kill(pids[0], 0)).toThrow()
    expect(await fs.readdir(c.dir)).toEqual([])
    console.log(`MK-19 process list: ditto pid ${pids[0]} seen before SIGTERM, gone after make exited`)
  })
})

let big: string | undefined
/** A2 plus one incompressible file (spec MK-19 `mutate`), built once. */
async function bigApp() {
  big ??= await buildApp(env, {
    release: "1.1.2",
    into: path.join(env.root, "src", "a2big"),
    mutate: (app) => fs.writeFile(path.join(app, "Contents", "Resources", "big.bin"), randomBytes(BIG_MB << 20)),
  })
  return big
}

/**
 * Starts argv, sends SIGTERM once `watch` exists, and returns the result. `during` runs just before the signal.
 * With `kill: false` the run is left to finish after `during`.
 */
async function interrupt(argv: string[], watch: string, during?: () => Promise<void>, kill = true) {
  const proc = Bun.spawn(argv, { cwd: env.root, env: baseEnv(), stdout: "pipe", stderr: "pipe" })
  const stdout = new Response(proc.stdout).text()
  const stderr = new Response(proc.stderr).text()
  let done = false
  proc.exited.then(() => (done = true))
  while (!done && !(await exists(watch))) await Bun.sleep(2)
  if (done) throw new Error(`the run ended before ${watch} appeared; raise SWARM_PATCH_BIG_MB`)
  if (during) await during()
  if (kill) proc.kill("SIGTERM")
  const code = await proc.exited
  return { code, stdout: await stdout, stderr: await stderr }
}

describe("seal (spec 6.3, register 14.4)", () => {
  test("SL-01..SL-03, SL-16: valid path, container layout, entries equal the inputs, printed output", async () => {
    const c = await signedWork()
    const inputs = await listing(c.out)
    const r = await seal(c.out)
    expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" })

    // SL-01
    expect((await fs.readdir(c.out)).sort()).toEqual([...INPUTS, "swarm-1.1.1-to-1.1.2.swarmpatch"].sort())
    const after = await listing(c.out)
    delete after["swarm-1.1.1-to-1.1.2.swarmpatch"]
    expect(after).toEqual(inputs)
    const lines = r.stdout.trimEnd().split("\n")
    expect(lines[0]).toStartWith(
      'Good "id.co.gsp.swarm.patch.v1" signature for swarm-patch-gsp with ED25519 key SHA256:',
    )
    expect(lines.at(-1)).toBe(c.pkg)
    expect(r.stdout.endsWith("\n")).toBe(true)

    // SL-02
    expect((await must(["/usr/bin/zipinfo", "-1", c.pkg])).stdout).toBe("manifest\nmanifest.sig\npayload.zip\n")
    const entries = (await must(["/usr/bin/zipinfo", c.pkg])).stdout
      .split("\n")
      .filter((l) => /\s(manifest|manifest\.sig|payload\.zip)$/.test(l))
    expect(entries).toHaveLength(3)
    for (const line of entries) {
      expect(line).toStartWith("-")
      expect(line).toMatch(/ stor /)
    }

    // SL-03
    for (const entry of ["manifest", "manifest.sig", "payload.zip"]) {
      const piped = await must(["/bin/zsh", "-f", "-c", 'unzip -p "$1" "$2" | shasum -a 256', "z", c.pkg, entry], {
        env: baseEnv(),
      })
      expect(piped.stdout.slice(0, 64)).toBe((await fileHash(path.join(c.out, entry)))!)
    }

    // SL-16 (C24 format) and N-7: verify line, nine manifest lines, manifest sha256, payload release and
    // CDHash, the payload applier's sha256 (here the repo applier, which the fixture copies), package last
    const manifest = await fs.readFile(path.join(c.out, "manifest"), "utf8")
    const digest = (await must(["/usr/bin/shasum", "-a", "256", path.join(c.out, "manifest")])).stdout
    const appCdhash = await cdhash(A.a2)
    expect(appCdhash).toMatch(/^[0-9a-f]{40,64}$/)
    const applier = (await fileHash(REPO_APPLIER))!
    expect(r.stdout).toBe(
      `${lines[0]}\n${manifest}${digest}payload_app_release=1.1.2\npayload_app_cdhash=${appCdhash}\n` +
        `payload_applier_sha256=${applier}\n${c.pkg}\n`,
    )
  })

  test("SL-04: signed with another key", async () => {
    const c = await signedWork(env.keys.other)
    await expectSealRefused(c.out, 1, "signature does not verify")
  })

  test("SL-05: another namespace", async () => {
    const c = await signedWork(env.keys.k, "other@gsp")
    await expectSealRefused(c.out, 1, "signature does not verify")
  })

  test("SL-06: manifest changed after signing", async () => {
    const c = await signedWork()
    const file = path.join(c.out, "manifest")
    const text = await fs.readFile(file, "utf8")
    await fs.writeFile(
      file,
      text.replace(/^(payload_bytes=\d*)(\d)$/m, (_, a, d) => `${a}${(Number(d) + 1) % 10}`),
    )
    expect(await fs.readFile(file, "utf8")).not.toBe(text)
    await expectSealRefused(c.out, 1, "signature does not verify")
  })

  test("SL-07: payload changed after make (one byte appended; one byte flipped, same size)", async () => {
    const c = await signedWork()
    await fs.appendFile(path.join(c.out, "payload.zip"), "x")
    await expectSealRefused(c.out, 1, /payload\.zip is \d+ bytes, manifest says \d+/)

    const d = await signedWork()
    const zip = path.join(d.out, "payload.zip")
    const buf = await fs.readFile(zip)
    buf[100] ^= 1
    await fs.writeFile(zip, buf)
    await expectSealRefused(d.out, 1, "payload.zip sha256 differs from the manifest")
  })

  test("SL-08: manifest.sig missing, empty, 4097 bytes", async () => {
    const c = await signedWork()
    await fs.rm(path.join(c.out, "manifest.sig"))
    await expectSealRefused(c.out, 1, "--work must hold exactly")
    const d = await signedWork()
    await fs.writeFile(path.join(d.out, "manifest.sig"), "")
    await expectSealRefused(d.out, 1, "manifest.sig is not a non-empty regular file")
    const e = await signedWork()
    await fs.writeFile(path.join(e.out, "manifest.sig"), Buffer.alloc(4097))
    await expectSealRefused(e.out, 1, "manifest.sig is not 1..4096 bytes")
  })

  test("SL-09: from-app anchor differs from the repo anchor, although ssh-keygen would accept it", async () => {
    const c = await signedWork(env.keys.other)
    const control = await run(
      [
        "/usr/bin/ssh-keygen",
        "-Y",
        "verify",
        "-f",
        path.join(A.a1other, "Contents", "Resources", PATCH_FOLDER, "allowed_signers"),
        "-I",
        "swarm-patch-gsp",
        "-n",
        NAMESPACE,
        "-s",
        path.join(c.out, "manifest.sig"),
      ],
      { env: baseEnv(), stdin: await fs.readFile(path.join(c.out, "manifest"), "utf8") },
    )
    expect(control.code).toBe(0)
    await expectSealRefused(c.out, 1, "allowed_signers of --from-app differs from the repo anchor", A.a1other)
  })

  test("SL-10: repo anchor changed in the working tree without commit", async () => {
    const anchor = path.join(R, ANCHOR_REL)
    const original = await fs.readFile(anchor)
    const c = await signedWork()
    const d = await signedWork(env.keys.other)
    try {
      await fs.writeFile(anchor, await allowedSigners(`${env.keys.other}.pub`))
      await expectSealRefused(c.out, 1, "allowed_signers of --from-app differs from the repo anchor")
      await expectSealRefused(d.out, 1, "differs from HEAD (not committed)", A.a1other)
    } finally {
      await fs.writeFile(anchor, original)
    }
    expect((await git(["status", "--porcelain"])).stdout).toBe("")
  })

  test("SL-11: from-app does not match (SwarmRelease 1.1.0, byte changed after codesign)", async () => {
    const c = await signedWork()
    await expectSealRefused(c.out, 1, "--from-app SwarmRelease 1.1.0 is not from_min 1.1.1", A.a0)
    await expectSealRefused(c.out, 1, "--from-app: code signature is not valid", A.a1mut)
  })

  test("SL-12: wrong work folder (extra file, package, .partial, .seal_check, symlinked manifest, basename)", async () => {
    const plant: [string, (out: string, pkg: string) => Promise<unknown>][] = [
      ["extra", (out) => fs.writeFile(path.join(out, "extra"), "x\n")],
      ["package", (_, pkg) => fs.writeFile(pkg, "old\n")],
      ["partial", (_, pkg) => fs.writeFile(`${pkg}.partial`, "old\n")],
      ["seal_check", (out) => fs.mkdir(path.join(out, ".seal_check"))],
    ]
    for (const [, fn] of plant) {
      const c = await signedWork()
      await fn(c.out, c.pkg)
      await expectSealRefused(c.out, 1, "--work must hold exactly")
    }

    const s = await signedWork()
    const real = path.join(s.dir, "manifest.real")
    await fs.rename(path.join(s.out, "manifest"), real)
    await fs.symlink(real, path.join(s.out, "manifest"))
    await expectSealRefused(s.out, 1, "manifest is not a non-empty regular file")

    // Basename 1.1.3: first with make's sign command (stale path), then with BN-13 rewritten for the new folder.
    const b = await signedWork()
    const renamed = path.join(b.dir, "patch_1.1.1_to_1.1.3")
    await fs.rename(b.out, renamed)
    await expectSealRefused(renamed, 1, "sign_command.txt is not the sign command make printed for this folder")
    await fs.writeFile(
      path.join(renamed, "sign_command.txt"),
      `/usr/bin/ssh-keygen -Y sign -f YOUR_PRIVATE_KEY_PATH -n ${NAMESPACE} '${renamed}/manifest'\n`,
    )
    await expectSealRefused(renamed, 1, "do not match patch_1.1.1_to_1.1.3")

    const w = await caseDir()
    expectRefused(await seal(path.join(w.dir, "missing")), "seal", 1, "--work: not a directory")
    expect(await fs.readdir(w.dir)).toEqual([])
    const wrong = path.join(w.dir, "work")
    await fs.mkdir(wrong)
    await expectSealRefused(wrong, 1, "--work: basename is not patch_<release>_to_<release>")
  })

  test("SL-13: manifest breaks spec 3.2 and is re-signed (unknown key, duplicate key, CR)", async () => {
    const edits: [(t: string) => string, string][] = [
      [(t) => `${t}extra=1\n`, "manifest has unknown key: extra"],
      [(t) => `${t}format=1\n`, "manifest has duplicate key: format"],
      [(t) => t.replace("format=1\n", "format=1\r\n"), "manifest has a byte outside printable ASCII and LF"],
    ]
    for (const [edit, message] of edits) {
      const c = await signedWork()
      const file = path.join(c.out, "manifest")
      await fs.writeFile(file, edit(await fs.readFile(file, "utf8")))
      await sign(c.out)
      await expectSealRefused(c.out, 1, message)
    }
  })

  test("SL-14: wrong options are usage errors", async () => {
    const c = await signedWork()
    const cases: [string[], string][] = [
      [["seal", "--work", c.out], "missing option: --from-app"],
      [["seal", "--from-app", A.a1], "missing option: --work"],
      [["seal", "--from-app", A.a1, "--work", c.out, "--key", env.keys.k], "unknown option: --key"],
      [["seal", "--from-app", A.a1, "--work", c.out, "extra"], "unexpected argument: extra"],
      [["seal", "--from-app", A.a1, "--work", c.out, "--work", c.out], "duplicate option: --work"],
    ]
    for (const [args, message] of cases) await expectSealRefused(c.out, 2, message, A.a1, args)
  })

  test("SL-15: sign_command.txt not byte-equal to BN-13 for this folder", async () => {
    const variants = [
      (out: string) => `/usr/bin/ssh-keygen -Y sign -f /x -n ${NAMESPACE} '${out}/manifest'\n`,
      (out: string) => `/usr/bin/ssh-keygen -Y sign -f YOUR_PRIVATE_KEY_PATH -n ${NAMESPACE} '${out}/manifest'`,
      (out: string) => `/usr/bin/ssh-keygen -Y sign -f YOUR_PRIVATE_KEY_PATH -n ${NAMESPACE} '${out}/manifest'; :\n`,
    ]
    for (const v of variants) {
      const c = await signedWork()
      await fs.writeFile(path.join(c.out, "sign_command.txt"), v(c.out))
      await expectSealRefused(c.out, 1, "sign_command.txt is not the sign command make printed for this folder")
    }
  })

  test("C24: payload app checks (release, anchor, not exactly Swarm.app, invalid seal), each re-signed", async () => {
    const cases: [string, string][] = [
      [A.a0, "payload SwarmRelease 1.1.0 is not release 1.1.2"],
      [A.a2other, "allowed_signers of the payload app differs from --from-app"],
      [A.other, "payload.zip does not hold exactly Swarm.app"],
      [A.a2mut, "payload: code signature is not valid"],
      [A.a2noapplier, "payload: applier is not a non-empty regular file"],
    ]
    for (const [app, message] of cases) {
      const c = await signedWork()
      await swapPayload(c.out, app)
      await expectSealRefused(c.out, 1, message)
    }
  })

  test("N-7: seal prints the sha256 of the applier inside the payload, not of the repo applier", async () => {
    const changed = path.join(env.root, "src", "applier-changed")
    await fs.writeFile(changed, Buffer.concat([await fs.readFile(REPO_APPLIER), Buffer.from("# changed\n")]))
    const to = await buildApp(env, {
      release: "1.1.2",
      into: path.join(env.root, "src", "a2applier"),
      applier: changed,
    })
    const c = await caseDir()
    expect((await make({ to, out: c.out })).code).toBe(0)
    await sign(c.out)
    const r = await seal(c.out)
    expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" })
    const lines = r.stdout.trimEnd().split("\n")
    const shipped = (await fileHash(path.join(to, "Contents", "Resources", PATCH_FOLDER, "swarm-patch")))!
    expect(shipped).toBe((await fileHash(changed))!)
    expect(shipped).not.toBe((await fileHash(REPO_APPLIER))!)
    expect(lines.slice(-2)).toEqual([`payload_applier_sha256=${shipped}`, c.pkg])
  })

  test("C24: --work spelled differently from make's --out is refused", async () => {
    const c = await signedWork()
    const alias = path.join(env.root, "alias")
    await fs.symlink(c.dir, alias)
    await expectSealRefused(
      path.join(alias, "patch_1.1.1_to_1.1.2"),
      1,
      "sign_command.txt is not the sign command make printed for this folder",
    )
    expect((await fs.readdir(c.out)).sort()).toEqual(INPUTS)
  })

  test(`U-6: SIGTERM once .seal_check appears (${BIG_MB} MB) leaves only the four inputs`, async () => {
    const big = await bigApp()
    const c = await caseDir()
    expect((await make({ to: big, out: c.out })).code).toBe(0)
    await sign(c.out)
    const before = await listing(c.out)
    const r = await interrupt(toolArgv(["seal", "--from-app", A.a1, "--work", c.out]), path.join(c.out, ".seal_check"))
    expect(r.code).toBe(1)
    expect(r.stderr).toBe("swarm-patch-release: seal: interrupted by SIGTERM; nothing was written\n")
    expect(await listing(c.out)).toEqual(before)
    // Control: the same folder seals when not interrupted.
    const ok = await seal(c.out)
    expect(ok.code).toBe(0)
    expect(ok.stdout.trimEnd().split("\n").at(-1)).toBe(c.pkg)
  })

  test(`L6: a file or symlink that appears at the package name during the run (${BIG_MB} MB) is not replaced`, async () => {
    const big = await bigApp()
    const plants: [string, (pkg: string) => Promise<void>][] = [
      ["file", (pkg) => fs.writeFile(pkg, "planted\n")],
      ["dangling symlink", (pkg) => fs.symlink(path.join(env.root, "nowhere"), pkg)],
    ]
    for (const [what, plant] of plants) {
      const c = await caseDir()
      expect((await make({ to: big, out: c.out })).code).toBe(0)
      await sign(c.out)
      const before = await listing(c.out)
      // The .partial exists only after the SEAL-7 pre-check, so the plant lands inside the run's window.
      const r = await interrupt(
        toolArgv(["seal", "--from-app", A.a1, "--work", c.out]),
        `${c.pkg}.partial`,
        () => plant(c.pkg),
        false,
      )
      expect({ what, code: r.code, stdout: r.stdout }).toEqual({ what, code: 1, stdout: "" })
      expect(r.stderr).toBe(`swarm-patch-release: seal: package appeared during the run: ${c.pkg}\n`)
      const after = await listing(c.out)
      expect(after[path.basename(c.pkg)]).toBe(
        what === "file" ? sha256("planted\n") : `l ${path.join(env.root, "nowhere")}`,
      )
      delete after[path.basename(c.pkg)]
      expect(after).toEqual(before) // the inputs only: no .partial, no .seal_check
    }
  })
})
